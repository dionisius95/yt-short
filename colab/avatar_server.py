#!/usr/bin/env python3
"""
Talking Avatar server for Google Colab (T4-friendly).

Exposes ONE new route `/avatar` on the SAME host you already use for the VoxCPM/
XTTS voice clone. The desktop app posts the user's photo + cloned-voice audio and
gets back an mp4.

Engines (hybrid, natural, not "AI-looking"):
  - mode == 'talk'  -> SadTalker (lip-sync + head motion + blinks) for Segment A/C
  - mode == 'idle'  -> LivePortrait retargeting of a subtle driving clip for
                       Segment B (silent but blinking/expressive). Falls back to
                       a still SadTalker render if LivePortrait/idle driving is
                       unavailable.

Contract
--------
POST /avatar   (JSON)
  {
    "image_b64": "<base64 jpg/png>",   # required
    "audio_b64": "<base64 wav>|null",  # required for talk, null for idle
    "mode": "talk" | "idle",
    "duration": <float seconds>,          # used for idle
    "fps": <int, default 25>
  }
  -> 200 video/mp4 (raw bytes, starts with an mp4 'ftyp' box)
  -> 4xx/5xx application/json { "error": "..." }

GET /avatar/health -> { "status": "ok", "talk": bool, "idle": bool, "device": str }

Usage in Colab
--------------
  from avatar_server import register_avatar_routes
  from flask import Flask
  app = Flask(__name__)
  register_avatar_routes(app)      # or pass your existing VoxCPM app
  app.run(port=7860)

Env vars
--------
  SADTALKER_DIR      path to SadTalker repo (default ./SadTalker)
  LIVEPORTRAIT_DIR   path to LivePortrait repo (default ./LivePortrait)
  IDLE_DRIVING       path to a short neutral driving video for idle (optional)
  AVATAR_MAX_SIDE    max image side, default 512 (keep small on T4)
  AVATAR_FP16        '1' to prefer fp16 (default '1')
  AVATAR_FPS         default fps, default 25
  AVATAR_WORKDIR     scratch dir, default /content/avatar_work
  AVATAR_PORT        default 5000
"""
import base64
import os
import subprocess
import sys
import tempfile
import time
import traceback
from pathlib import Path

from flask import Flask, jsonify, request, send_file

try:
    import torch
    _HAS_CUDA = torch.cuda.is_available()
    _DEVICE = 'cuda' if _HAS_CUDA else 'cpu'
except Exception:  # pragma: no cover
    torch = None
    _HAS_CUDA = False
    _DEVICE = 'cpu'

from PIL import Image

SADTALKER_DIR = Path(os.environ.get('SADTALKER_DIR', './SadTalker')).expanduser()
LIVEPORTRAIT_DIR = Path(os.environ.get('LIVEPORTRAIT_DIR', './LivePortrait')).expanduser()
IDLE_DRIVING = os.environ.get('IDLE_DRIVING', '').strip()
MAX_SIDE = int(os.environ.get('AVATAR_MAX_SIDE', '512'))
FP16 = os.environ.get('AVATAR_FP16', '1') == '1'
DEFAULT_FPS = int(os.environ.get('AVATAR_FPS', '25'))
WORKDIR = Path(os.environ.get('AVATAR_WORKDIR', '/content/avatar_work'))
PORT = int(os.environ.get('AVATAR_PORT', '5000'))

WORKDIR.mkdir(parents=True, exist_ok=True)


def _log(*a):
    print('[avatar]', *a, flush=True)


def _free_cuda():
    """Lepas VRAM cache (mis. cache VoxCPM yang menganggur) sebelum render.
    Bobot model yang resident tetap dipertahankan; hanya blok cache dilepas."""
    try:
        if torch is not None and torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
    except Exception:
        pass


def _prep_image(raw: bytes, dst: Path) -> Path:
    """Decode, EXIF-normalize, downscale to MAX_SIDE, save as PNG."""
    tmp = dst.with_suffix('.in')
    tmp.write_bytes(raw)
    img = Image.open(tmp).convert('RGB')
    try:
        from PIL import ImageOps
        img = ImageOps.exif_transpose(img)
    except Exception:
        pass
    w, h = img.size
    scale = min(1.0, float(MAX_SIDE) / float(max(w, h)))
    if scale < 1.0:
        img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
    img.save(dst, 'PNG')
    try:
        tmp.unlink()
    except Exception:
        pass
    return dst


def _run(cmd, cwd=None, timeout=600, env=None):
    _log('run:', ' '.join(str(c) for c in cmd))
    run_env = dict(os.environ)
    # Kurangi fragmentasi VRAM saat VoxCPM + SadTalker berbagi satu T4.
    run_env.setdefault('PYTORCH_CUDA_ALLOC_CONF', 'expandable_segments:True')
    if env:
        run_env.update(env)
    proc = subprocess.run(
        [str(c) for c in cmd],
        cwd=str(cwd) if cwd else None,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=timeout,
        env=run_env,
    )
    out = proc.stdout.decode('utf-8', 'ignore') if proc.stdout else ''
    if proc.returncode != 0:
        raise RuntimeError('command failed (' + str(proc.returncode) + '): ' + out[-4000:])
    return out


def _newest_mp4(root: Path):
    vids = sorted(root.rglob('*.mp4'), key=lambda p: p.stat().st_mtime, reverse=True)
    return vids[0] if vids else None


def _sadtalker_available() -> bool:
    return SADTALKER_DIR.exists() and (SADTALKER_DIR / 'inference.py').exists()


def _liveportrait_available() -> bool:
    return LIVEPORTRAIT_DIR.exists() and (LIVEPORTRAIT_DIR / 'inference.py').exists()


def _make_silent_wav(dst: Path, seconds: float, fps: int):
    """SadTalker needs an audio track; synthesize silence for idle fallback."""
    seconds = max(0.5, float(seconds))
    _run([
        'ffmpeg', '-y', '-f', 'lavfi', '-i',
        'anullsrc=r=16000:cl=mono', '-t', f'{seconds:.2f}',
        '-q:a', '9', '-acodec', 'pcm_s16le', str(dst),
    ])


def _is_oom(msg: str) -> bool:
    m = (msg or '').lower()
    return 'out of memory' in m or 'outofmemoryerror' in m or 'cuda oom' in m


def _render_sadtalker(image: Path, audio: Path, out_dir: Path, fps: int) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    # Lepas VRAM cache dulu agar subprocess SadTalker dapat ruang di T4.
    _free_cuda()
    # Coba size utama; kalau kena CUDA OOM (VRAM dibagi VoxCPM), turun ke 256.
    primary = min(512, MAX_SIDE)
    sizes = [primary] + ([256] if primary != 256 else [])
    last_err = None
    for idx, size in enumerate(sizes):
        cmd = [
            sys.executable, 'inference.py',
            '--source_image', str(image),
            '--driven_audio', str(audio),
            '--result_dir', str(out_dir),
            '--still', '--preprocess', 'full',
            '--size', str(size),
        ]
        try:
            _run(cmd, cwd=SADTALKER_DIR, timeout=900)
            vid = _newest_mp4(out_dir)
            if not vid:
                raise RuntimeError('SadTalker produced no mp4')
            return vid
        except RuntimeError as e:
            last_err = e
            if _is_oom(str(e)) and idx < len(sizes) - 1:
                _log('CUDA OOM di size ' + str(size) + '; bebaskan VRAM & coba size ' + str(sizes[idx + 1]) + ' ...')
                _free_cuda()
                continue
            raise
    if last_err:
        raise last_err
    raise RuntimeError('SadTalker gagal render')


def _render_liveportrait_idle(image: Path, out_dir: Path, seconds: float, fps: int) -> Path:
    if not IDLE_DRIVING or not Path(IDLE_DRIVING).exists():
        raise RuntimeError('no IDLE_DRIVING clip configured')
    out_dir.mkdir(parents=True, exist_ok=True)
    cmd = [
        sys.executable, 'inference.py',
        '-s', str(image),
        '-d', str(IDLE_DRIVING),
        '-o', str(out_dir),
    ]
    _run(cmd, cwd=LIVEPORTRAIT_DIR, timeout=600)
    vid = _newest_mp4(out_dir)
    if not vid:
        raise RuntimeError('LivePortrait produced no mp4')
    return vid


def _handle_avatar():
    t0 = time.time()
    try:
        data = request.get_json(force=True, silent=True) or {}
        image_b64 = data.get('image_b64')
        audio_b64 = data.get('audio_b64')
        mode = (data.get('mode') or 'talk').lower()
        duration = float(data.get('duration') or 4.0)
        fps = int(data.get('fps') or DEFAULT_FPS)

        if not image_b64:
            return jsonify({'error': 'image_b64 is required'}), 400
        if mode == 'talk' and not audio_b64:
            return jsonify({'error': 'audio_b64 is required for mode talk'}), 400
        if not _sadtalker_available():
            return jsonify({'error': 'SadTalker not installed on this host'}), 503

        job = Path(tempfile.mkdtemp(prefix='job_', dir=str(WORKDIR)))
        img_path = _prep_image(base64.b64decode(image_b64), job / 'src.png')
        out_dir = job / 'out'

        if mode == 'idle':
            # Prefer LivePortrait for natural idle; fall back to still SadTalker.
            try:
                if _liveportrait_available():
                    vid = _render_liveportrait_idle(img_path, out_dir, duration, fps)
                else:
                    raise RuntimeError('LivePortrait unavailable')
            except Exception as e:
                _log('idle fallback to SadTalker still:', e)
                sil = job / 'silence.wav'
                _make_silent_wav(sil, duration, fps)
                vid = _render_sadtalker(img_path, sil, out_dir, fps)
        else:
            aud_path = job / 'drive.wav'
            aud_path.write_bytes(base64.b64decode(audio_b64))
            vid = _render_sadtalker(img_path, aud_path, out_dir, fps)

        # Normalize container/fps so the desktop app always gets a clean mp4.
        final = job / 'avatar.mp4'
        _run([
            'ffmpeg', '-y', '-i', str(vid),
            '-r', str(fps), '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart', '-c:v', 'libx264', '-crf', '20',
            str(final),
        ])
        _log(f'{mode} done in {time.time() - t0:.1f}s -> {final}')
        return send_file(str(final), mimetype='video/mp4')
    except subprocess.TimeoutExpired:
        return jsonify({'error': 'render timeout'}), 504
    except Exception as e:  # pragma: no cover
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


def _handle_health():
    return jsonify({
        'status': 'ok',
        'talk': _sadtalker_available(),
        'idle': _liveportrait_available() or _sadtalker_available(),
        'device': _DEVICE,
        'max_side': MAX_SIDE,
    })


def register_avatar_routes(app):
    """Attach the /avatar routes to an existing Flask app (e.g. the VoxCPM app)."""
    app.add_url_rule('/avatar', 'avatar', _handle_avatar, methods=['POST'])
    app.add_url_rule('/avatar/health', 'avatar_health', _handle_health, methods=['GET'])
    return app


def _start_tunnel():
    """Expose a public URL via cloudflared (same pattern as the VoxCPM host)."""
    try:
        from flask_cloudflared import _run_cloudflared
        url = _run_cloudflared(PORT, PORT + 1)
        _log('PUBLIC URL:', url)
        _log('Use this base in the app (avatar route:', str(url) + '/avatar )')
    except Exception as e:
        _log('cloudflared not started:', e)


if __name__ == '__main__':
    _log('device:', _DEVICE, '| SadTalker:', _sadtalker_available(),
         '| LivePortrait:', _liveportrait_available())
    app = Flask(__name__)
    register_avatar_routes(app)
    _start_tunnel()
    app.run(host='0.0.0.0', port=PORT, threaded=True)
