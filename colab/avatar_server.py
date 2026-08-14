#!/usr/bin/env python3
"""
Talking Avatar server for Google Colab (T4-friendly).

Exposes avatar routes on the SAME Flask host you already use for the VoxCPM/
XTTS voice clone. The desktop app posts the user photo + cloned-voice audio and
gets back an mp4.

Engines (hybrid, natural):
  - mode == talk  -> SadTalker (lip-sync + head motion + blinks) for Segment A/C
  - mode == idle  -> LivePortrait retargeting of a subtle driving clip for
                     Segment B (silent but blinking/expressive). Falls back to a
                     still SadTalker render if LivePortrait is unavailable.

Async contract (avoids Cloudflare 524 timeouts)
-----------------------------------------------
Rendering can take several minutes, but Cloudflare quick tunnels drop any single
request that runs past ~100 seconds (HTTP 524). So the render is a background
job and the client polls for the result:

POST /avatar   (JSON)
  { image_b64, audio_b64|null, mode: talk|idle, duration, fps }
  -> 202 application/json { job_id, status: pending }

GET /avatar/result/<job_id>
  -> 202 application/json { status: pending|running }   (still working)
  -> 200 video/mp4                                       (done)
  -> 5xx application/json { status: error, error }       (failed)

GET /avatar/health -> { status, talk, idle, device, max_side }

Usage in Colab
--------------
  from avatar_server import register_avatar_routes
  from flask import Flask
  app = Flask(__name__)
  register_avatar_routes(app)      # or pass your existing VoxCPM app
  app.run(port=7860, threaded=True)

Env vars: SADTALKER_DIR, LIVEPORTRAIT_DIR, IDLE_DRIVING, AVATAR_MAX_SIDE,
AVATAR_FP16, AVATAR_FPS, AVATAR_WORKDIR, AVATAR_PORT.
"""
import base64
import os
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import uuid
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

# --- Async job registry -------------------------------------------------------
# Cloudflare quick tunnels drop any single request that runs past ~100s (HTTP
# 524). Avatar renders can take several minutes, so /avatar enqueues a job and
# returns immediately; the client polls /avatar/result/<job_id> (each poll is
# fast). A single render lock keeps GPU work serialized on the shared T4.
_JOBS = {}
_JOBS_LOCK = threading.Lock()
_RENDER_LOCK = threading.Lock()


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


def _probe_duration(path: Path) -> float:
    """Durasi video (detik) via ffprobe; 0.0 kalau gagal."""
    try:
        r = subprocess.run(
            ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
             '-of', 'default=nw=1:nk=1', str(path)],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60,
        )
        return float((r.stdout.decode('utf-8', 'ignore') or '0').strip() or 0)
    except Exception:
        return 0.0


def _loop_to_duration(src: Path, dst: Path, seconds: float, fps: int) -> Path:
    """Perpanjang klip idle agar sepanjang `seconds` dengan PING-PONG loop
    (maju + mundur) supaya transisi mulus tanpa lompatan, gerak kedip/senyum
    berulang natural. Kalau `src` sudah cukup panjang, cukup di-trim."""
    seconds = max(0.5, float(seconds))
    dur = _probe_duration(src)
    if dur <= 0:
        return src
    if dur >= seconds - 0.05:
        _run(['ffmpeg', '-y', '-i', str(src), '-t', '%.2f' % seconds,
              '-r', str(fps), '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
              '-an', str(dst)])
        return dst
    # 1) unit ping-pong = maju lalu dibalik (boomerang) -> loopable mulus
    pp = dst.with_name('idle_pingpong.mp4')
    _run(['ffmpeg', '-y', '-i', str(src), '-filter_complex',
          '[0:v]fps=' + str(fps) + ',split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1[v]',
          '-map', '[v]', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(pp)])
    # 2) ulang unit ping-pong sampai >= seconds lalu trim tepat
    _run(['ffmpeg', '-y', '-stream_loop', '-1', '-i', str(pp), '-t', '%.2f' % seconds,
          '-r', str(fps), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', str(dst)])
    return dst


def _sadtalker_available() -> bool:
    return SADTALKER_DIR.exists() and (SADTALKER_DIR / 'inference.py').exists()


def _liveportrait_available() -> bool:
    return LIVEPORTRAIT_DIR.exists() and (LIVEPORTRAIT_DIR / 'inference.py').exists()


_LP_HELP_CACHE = None


def _lp_help_text() -> str:
    """Ambil (sekali) teks `inference.py --help` LivePortrait supaya kita bisa
    memilih flag yang BENAR-BENAR ada di versi terpasang (hindari menebak nama
    flag yang beda antar versi -> error)."""
    global _LP_HELP_CACHE
    if _LP_HELP_CACHE is not None:
        return _LP_HELP_CACHE
    try:
        r = subprocess.run(
            [sys.executable, 'inference.py', '--help'],
            cwd=str(LIVEPORTRAIT_DIR),
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120,
        )
        _LP_HELP_CACHE = r.stdout.decode('utf-8', 'ignore')
    except Exception as e:
        _log('LivePortrait --help gagal:', e)
        _LP_HELP_CACHE = ''
    return _LP_HELP_CACHE


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


def _lp_render_unit(image: Path, driving: Path, out_dir: Path, normalize_lip: bool, multiplier: float = 0.9) -> Path:
    """Render satu 'unit' ekspresif pendek: wajah user mengikuti klip driving.

    - normalize_lip=True  -> mulut DIKUNCI tertutup (dipakai untuk unit KEDIP).
    - normalize_lip=False -> biarkan gerak bibir tipis (dipakai untuk SENYUM).
    KEDIP dirender amplitudo penuh (multiplier ~0.9) supaya mata BENAR-BENAR
    menutup; SENYUM pakai multiplier rendah (~0.4) supaya halus/tidak agresif.
    Kesan 'tidak agresif' datang dari penjarangan waktu acak, bukan meredam kedip.
    Flag dipilih dinamis dari `inference.py --help` (tidak menebak nama flag).
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    _free_cuda()
    help_txt = _lp_help_text()
    cmd = [
        sys.executable, 'inference.py',
        '-s', str(image),
        '-d', str(driving),
        '-o', str(out_dir),
    ]
    if normalize_lip:
        if '--flag_normalize_lip' in help_txt:
            cmd.append('--flag_normalize_lip')
        elif '--flag_lip_zero' in help_txt:
            cmd.append('--flag_lip_zero')
    if '--driving_multiplier' in help_txt:
        cmd += ['--driving_multiplier', '%.2f' % multiplier]
    if '--flag_stitching' in help_txt:
        cmd.append('--flag_stitching')
    _run(cmd, cwd=LIVEPORTRAIT_DIR, timeout=900)
    vids = [p for p in out_dir.rglob('*.mp4') if 'concat' not in p.name.lower()]
    if not vids:
        vids = list(out_dir.rglob('*.mp4'))
    if not vids:
        raise RuntimeError('LivePortrait produced no mp4')
    return max(vids, key=lambda p: p.stat().st_mtime)


def _vid_dims(path: Path):
    try:
        r = subprocess.run(
            ['ffprobe', '-v', 'error', '-select_streams', 'v:0',
             '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', str(path)],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60,
        )
        w, h = r.stdout.decode('utf-8', 'ignore').strip().split('x')
        return int(w), int(h)
    except Exception:
        return 256, 256


def _build_random_idle(units, out_dir: Path, out: Path, seconds: float, fps: int) -> Path:
    """Rangkai timeline idle NON-periodik supaya terasa natural seperti manusia.

    Prinsip: sebagian besar waktu wajah NETRAL/diam. Event (kedip / senyum tipis)
    disisipkan pada waktu ACAK dengan jeda acak, sehingga:
      - tidak ada senyum terus-menerus (senyum hanya sesekali),
      - ritme tidak seragam (bukan loop ping-pong yang berulang identik),
      - kedip terjadi sesekali, bukan mata melirik kaku berirama.
    """
    import random
    import time as _time
    random.seed((int(_time.time() * 1000) ^ os.getpid()) & 0x7fffffff)
    seconds = max(1.5, float(seconds))
    tmpd = out_dir / 'idle_parts'
    tmpd.mkdir(parents=True, exist_ok=True)

    first_unit = next(iter(units.values()))
    W, H = _vid_dims(first_unit)

    # Normalisasi tiap unit (fps + ukuran + codec seragam) agar bisa di-concat.
    norm, udur = {}, {}
    for kind, u in units.items():
        pu = tmpd / ('u_' + kind + '.mp4')
        _run(['ffmpeg', '-y', '-i', str(u), '-r', str(fps),
              '-vf', 'fps=' + str(fps) + ',scale=' + str(W) + ':' + str(H),
              '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(pu)])
        norm[kind] = pu
        udur[kind] = max(0.2, _probe_duration(pu))

    # Frame NETRAL = frame pertama unit (pose asli user, tenang).
    neutral_png = tmpd / 'neutral.png'
    _run(['ffmpeg', '-y', '-i', str(first_unit), '-frames:v', '1',
          '-vf', 'scale=' + str(W) + ':' + str(H), str(neutral_png)])

    parts = []
    nidx = [0]

    def add_neutral(dur):
        dur = max(0.4, float(dur))
        p = tmpd / ('n' + str(nidx[0]) + '.mp4')
        nidx[0] += 1
        _run(['ffmpeg', '-y', '-loop', '1', '-t', '%.2f' % dur, '-i', str(neutral_png),
              '-r', str(fps),
              '-vf', 'fps=' + str(fps) + ',scale=' + str(W) + ':' + str(H),
              '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(p)])
        parts.append(p)
        return dur

    t = 0.0
    # Jeda tenang di awal (durasi acak).
    t += add_neutral(random.uniform(1.2, 2.6))
    have_smile = 'smile' in norm
    while t < seconds - 0.3:
        # Mayoritas event = kedip; sesekali (~1 dari 4) = senyum tipis.
        if have_smile and random.random() < 0.26:
            kind = 'smile'
        else:
            kind = 'blink' if 'blink' in norm else next(iter(norm.keys()))
        parts.append(norm[kind])
        t += udur[kind]
        if t >= seconds - 0.3:
            break
        # Jeda tenang ACAK antar event -> ritme tidak seragam.
        gap = random.uniform(2.0, 5.5) if kind == 'blink' else random.uniform(3.0, 6.5)
        t += add_neutral(gap)

    listf = tmpd / 'list.txt'
    listf.write_text(''.join("file '" + str(p) + "'\n" for p in parts))
    _run(['ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', str(listf),
          '-t', '%.2f' % seconds, '-r', str(fps),
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', str(out)])
    return out


def _render_liveportrait_idle(image: Path, out_dir: Path, seconds: float, fps: int) -> Path:
    """Idle Segmen B natural: kedip SESEKALI + senyum tipis SESEKALI, ritme ACAK.

    Alur:
      1) Render 1 unit KEDIP (mulut dikunci tertutup) dari klip driving 'idle_blink'.
      2) (opsional) Render 1 unit SENYUM tipis dari 'idle_smile' bila tersedia.
      3) Susun timeline non-periodik: basis wajah netral + sisipkan unit pada
         waktu acak (lihat _build_random_idle).
    Sumber driving diambil dari folder yang sama dengan IDLE_DRIVING
    (idle_blink.mp4 / idle_smile.mp4), sehingga tidak perlu env var baru.
    """
    if not IDLE_DRIVING or not Path(IDLE_DRIVING).exists():
        raise RuntimeError('no IDLE_DRIVING clip configured')
    out_dir.mkdir(parents=True, exist_ok=True)

    assets_dir = Path(IDLE_DRIVING).parent
    blink_src = assets_dir / 'idle_blink.mp4'
    smile_src = assets_dir / 'idle_smile.mp4'
    if not blink_src.exists():
        blink_src = Path(IDLE_DRIVING)

    units = {}
    # Unit kedip: mulut DIKUNCI tertutup (normalize lip), amplitudo penuh (0.9).
    try:
        units['blink'] = _lp_render_unit(image, blink_src, out_dir / 'u_blink', True, 0.9)
    except Exception as e:
        _log('blink unit gagal:', e)
    # Unit senyum: biarkan senyum tipis (JANGAN normalize lip); hanya bila ada sumbernya.
    if smile_src.exists():
        try:
            units['smile'] = _lp_render_unit(image, smile_src, out_dir / 'u_smile', False, 0.4)
        except Exception as e:
            _log('smile unit gagal:', e)

    if not units:
        raise RuntimeError('LivePortrait produced no idle unit')

    try:
        return _build_random_idle(units, out_dir, out_dir / 'idle_full.mp4', seconds, fps)
    except Exception as e:
        _log('random idle assembly gagal, fallback ping-pong:', e)
        base = units.get('blink') or next(iter(units.values()))
        return _loop_to_duration(base, out_dir / 'idle_full.mp4', seconds, fps)


def _do_render(image_b64, audio_b64, mode, duration, fps) -> Path:
    """Blocking render. Dipanggil dari worker thread (bukan dari request handler)."""
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
            # Samakan panjang dengan durasi segmen (loop kalau kurang).
            vid = _loop_to_duration(vid, out_dir / 'idle_full.mp4', duration, fps)
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
    return final


def _run_job(job_id, params):
    """Worker thread: render satu job dan simpan status/hasil di _JOBS."""
    t0 = time.time()
    with _JOBS_LOCK:
        if job_id in _JOBS:
            _JOBS[job_id]['status'] = 'running'
    # Serialize GPU work: only one render at a time on the shared T4.
    with _RENDER_LOCK:
        try:
            final = _do_render(**params)
            with _JOBS_LOCK:
                _JOBS[job_id].update(status='done', path=str(final))
            _log('job ' + job_id + ' (' + params['mode'] + ') done in %.1fs -> %s' % (time.time() - t0, final))
        except subprocess.TimeoutExpired:
            with _JOBS_LOCK:
                _JOBS[job_id].update(status='error', error='render timeout')
        except Exception as e:  # pragma: no cover
            traceback.print_exc()
            with _JOBS_LOCK:
                _JOBS[job_id].update(status='error', error=str(e))


def _handle_avatar():
    """Terima job render, jalankan di background, balikan job_id segera (202).

    Async by design: Cloudflare quick tunnels putus di ~100 detik (HTTP 524),
    sedangkan render SadTalker bisa lebih lama. Client lalu polling
    /avatar/result/<job_id> yang tiap responsnya cepat."""
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

        job_id = uuid.uuid4().hex
        params = {
            'image_b64': image_b64,
            'audio_b64': audio_b64,
            'mode': mode,
            'duration': duration,
            'fps': fps,
        }
        with _JOBS_LOCK:
            _JOBS[job_id] = {'status': 'pending', 'path': None, 'error': None}
        threading.Thread(target=_run_job, args=(job_id, params), daemon=True).start()
        _log('queued job', job_id, 'mode', mode, 'duration', duration)
        return jsonify({'job_id': job_id, 'status': 'pending'}), 202
    except Exception as e:  # pragma: no cover
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


def _handle_avatar_result(job_id):
    """Polling hasil job: 202 selama proses, mp4 saat selesai, 5xx saat gagal."""
    with _JOBS_LOCK:
        job = _JOBS.get(job_id)
        snapshot = dict(job) if job else None
    if not snapshot:
        return jsonify({'status': 'error', 'error': 'unknown job_id'}), 404
    status = snapshot.get('status')
    if status in ('pending', 'running'):
        return jsonify({'status': status}), 202
    if status == 'error':
        return jsonify({'status': 'error', 'error': snapshot.get('error') or 'render failed'}), 500
    path = snapshot.get('path')
    if not path or not Path(path).exists():
        return jsonify({'status': 'error', 'error': 'result file missing'}), 500
    return send_file(path, mimetype='video/mp4')


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
    app.add_url_rule('/avatar/result/<job_id>', 'avatar_result', _handle_avatar_result, methods=['GET'])
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
