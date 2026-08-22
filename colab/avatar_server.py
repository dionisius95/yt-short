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


def _patch_sadtalker_preprocess():
    """Auto-patch SadTalker preprocess.py to prevent numpy 2.x 0-dim scalar TypeError."""
    try:
        p = SADTALKER_DIR / 'src' / 'face3d' / 'util' / 'preprocess.py'
        if not p.exists():
            return
        src = p.read_text(encoding='utf-8')
        import re
        pattern = r"def resize_n_crop_img\(img, lm, t, s, target_size=224\., mask=None\):[\s\S]*?return img, lm, mask"
        replacement = """def resize_n_crop_img(img, lm, t, s, target_size=224., mask=None):
    w0, h0 = img.size
    s_val = float(np.asarray(s).reshape(-1)[0])
    t_val = np.asarray(t).reshape(-1)
    w = int(round(float(w0) * s_val))
    h = int(round(float(h0) * s_val))
    left = int(round(float(w)/2.0 - float(target_size)/2.0 + float(t_val[0] - w0/2.0) * s_val))
    right = int(round(left + target_size))
    up = int(round(float(h)/2.0 - float(target_size)/2.0 + float(t_val[1] - h0/2.0) * s_val))
    below = int(round(up + target_size))

    img = img.resize((w, h), resample=Image.BICUBIC)
    img = img.crop((left, up, right, below))

    if mask is not None:
        mask = mask.resize((w, h), resample=Image.BICUBIC)
        mask = mask.crop((left, up, right, below))

    lm = np.stack([lm[:, 0] - t_val[0] + w0/2.0, lm[:, 1] -
                  t_val[1] + h0/2.0], axis=1)*(float(w)/float(w0))
    lm = lm - np.reshape(
        np.array([(float(w)/2.0 - float(target_size)/2.0), (float(h)/2.0 - float(target_size)/2.0)]), [1, 2])
    return img, lm, mask"""
        if re.search(pattern, src):
            src = re.sub(pattern, replacement, src)
            p.write_text(src, encoding='utf-8')
            print('[avatar] auto-patched SadTalker preprocess.py (scalar-safe)', flush=True)

        p_enh = SADTALKER_DIR / 'src' / 'utils' / 'face_enhancer.py'
        if p_enh.exists():
            src_enh = p_enh.read_text(encoding='utf-8')
            if 'from gfpgan import GFPGANer' in src_enh and 'try:' not in src_enh:
                src_enh = src_enh.replace('from gfpgan import GFPGANer', """try:
    from gfpgan import GFPGANer
except Exception:
    try:
        from gfpgan.utils import GFPGANer
    except Exception:
        GFPGANer = None""")
                p_enh.write_text(src_enh, encoding='utf-8')
                print('[avatar] auto-patched SadTalker face_enhancer.py (safe GFPGANer import)', flush=True)

        p_u = SADTALKER_DIR / 'src' / 'utils' / 'preprocess.py'
        if p_u.exists():
            src_u = p_u.read_text(encoding='utf-8')
            old_u = 'trans_params = np.array([float(item) for item in np.hsplit(trans_params, 5)]).astype(np.float32)'
            new_u = 'trans_params = np.asarray(trans_params, dtype=np.float32).reshape(-1)'
            if old_u in src_u:
                src_u = src_u.replace(old_u, new_u)
                p_u.write_text(src_u, encoding='utf-8')
                print('[avatar] auto-patched SadTalker src/utils/preprocess.py (trans_params hsplit)', flush=True)
    except Exception as e:
        print('[avatar] preprocess patch warn:', e, flush=True)

    # Patch basicsr functional_tensor
    try:
        import glob
        for root in sys.path:
            if 'site-packages' in root or 'dist-packages' in root:
                for f in glob.glob(f"{root}/basicsr/**/*.py", recursive=True):
                    try:
                        txt = Path(f).read_text(encoding='utf-8')
                        if 'torchvision.transforms.functional_tensor' in txt:
                            txt = txt.replace('torchvision.transforms.functional_tensor', 'torchvision.transforms.functional')
                            Path(f).write_text(txt, encoding='utf-8')
                    except Exception:
                        pass
    except Exception:
        pass


_patch_sadtalker_preprocess()

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


def _find_idle_driving_sources():
    """Cari sumber driving kedip/senyum terbaik yang tersedia."""
    candidates = []
    if IDLE_DRIVING:
        candidates.append(Path(IDLE_DRIVING))
    candidates.extend([
        Path('/content/assets/idle_driving.mp4'),
        Path('/content/assets/idle_blink.mp4'),
        WORKDIR.parent / 'assets' / 'idle_driving.mp4',
        WORKDIR.parent / 'assets' / 'idle_blink.mp4',
        Path('./assets/idle_driving.mp4'),
        Path('./assets/idle_blink.mp4'),
        LIVEPORTRAIT_DIR / 'assets' / 'examples' / 'driving' / 'd14.mp4',
        LIVEPORTRAIT_DIR / 'assets' / 'examples' / 'driving' / 'd0.mp4',
    ])
    blink_src = None
    smile_src = None
    for p in candidates:
        if p and p.exists() and p.stat().st_size > 1000:
            blink_src = p
            p_smile = p.parent / 'idle_smile.mp4'
            if p_smile.exists() and p_smile.stat().st_size > 1000:
                smile_src = p_smile
            elif (LIVEPORTRAIT_DIR / 'assets' / 'examples' / 'driving' / 'd9.mp4').exists():
                smile_src = LIVEPORTRAIT_DIR / 'assets' / 'examples' / 'driving' / 'd9.mp4'
            break
    return blink_src, smile_src


def _render_liveportrait_idle(image: Path, out_dir: Path, seconds: float, fps: int) -> Path:
    """Idle Segmen B natural: kedip SESEKALI + senyum tipis SESEKALI, ritme ACAK.

    Alur:
      1) Render 1 unit KEDIP (mulut dikunci tertutup) dari klip driving 'idle_blink'.
      2) (opsional) Render 1 unit SENYUM tipis dari 'idle_smile' bila tersedia.
      3) Susun timeline non-periodik: basis wajah netral + sisipkan unit pada
         waktu acak (lihat _build_random_idle).
    """
    blink_src, smile_src = _find_idle_driving_sources()
    if not blink_src or not blink_src.exists():
        raise RuntimeError('no IDLE_DRIVING clip configured or found')
    out_dir.mkdir(parents=True, exist_ok=True)
    _log('LivePortrait idle driving source:', blink_src, '(smile:', smile_src, ')')

    units = {}
    # Unit kedip: mulut DIKUNCI tertutup (normalize lip), amplitudo penuh (0.9).
    try:
        units['blink'] = _lp_render_unit(image, blink_src, out_dir / 'u_blink', True, 0.9)
    except Exception as e:
        _log('blink unit gagal:', e)
    # Unit senyum: biarkan senyum tipis (JANGAN normalize lip); hanya bila ada sumbernya.
    if smile_src and smile_src.exists():
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


# --- Background removal (opsional) --------------------------------------------
# Saat toggle "Hapus Background" aktif, klip avatar di-matte per-frame dengan
# rembg (model u2net_human_seg) sehingga hanya orangnya tersisa, lalu di-encode
# ke VP9/webm ber-alpha (yuva420p). Kompositor desktop mempertahankan alpha ini.
# Fail-safe: bila rembg/onnxruntime tak tersedia atau gagal, kembalikan klip
# aslinya (mp4 opaque) sehingga render tetap jalan tanpa error.
_REMBG_SESSION = [None]


def _get_rembg_session():
    if _REMBG_SESSION[0] is not None:
        return _REMBG_SESSION[0] or None
    try:
        from rembg import new_session
        model = os.environ.get('REMBG_MODEL', 'u2net_human_seg')
        # 1) Coba GPU provider terlebih dahulu jika onnxruntime-gpu & CUDA kompatibel
        try:
            _REMBG_SESSION[0] = new_session(model, providers=['CUDAExecutionProvider', 'CPUExecutionProvider'])
            _log('rembg session siap (CUDA/CPU, model=' + model + ')')
            return _REMBG_SESSION[0]
        except Exception as egpu:
            _log('rembg CUDA provider gagal (' + str(egpu) + '), beralih ke CPU...')

        # 2) Fallback ke CPU provider
        try:
            _REMBG_SESSION[0] = new_session(model, providers=['CPUExecutionProvider'])
            _log('rembg session siap (CPU, model=' + model + ')')
            return _REMBG_SESSION[0]
        except Exception as ecpu:
            _log('rembg CPU fallback gagal (' + str(ecpu) + '), coba default new_session...')
            _REMBG_SESSION[0] = new_session(model)
            _log('rembg session siap (default, model=' + model + ')')
            return _REMBG_SESSION[0]
    except Exception as e:
        _log('rembg tak tersedia (', e, ') -> lewati hapus background')
        _REMBG_SESSION[0] = False
    return _REMBG_SESSION[0] or None


def remove_background_video(in_path, out_dir, fps) -> Path:
    """Matte orang dari tiap frame -> webm VP9 ber-alpha (yuva420p).

    Fail-safe: kalau rembg/onnxruntime/cv2 tak tersedia atau ada error, kembalikan
    `in_path` apa adanya (mp4 opaque) supaya pipeline tidak gagal.
    """
    in_path = Path(in_path)
    out_dir = Path(out_dir)
    try:
        from rembg import remove
    except Exception as e:
        _log('rembg import gagal, background tidak dihapus:', e)
        return in_path
    session = _get_rembg_session()
    if session is None:
        return in_path
    try:
        import cv2
        from PIL import Image as _PILImage
    except Exception as e:
        _log('cv2/PIL tak tersedia untuk matting:', e)
        return in_path

    try:
        out_dir.mkdir(parents=True, exist_ok=True)
        frames_dir = out_dir / 'matte_frames'
        frames_dir.mkdir(parents=True, exist_ok=True)
        cap = cv2.VideoCapture(str(in_path))
        idx = 0
        try:
            while True:
                ok, frame = cap.read()
                if not ok:
                    break
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                pil = _PILImage.fromarray(rgb)
                cut = remove(pil, session=session)  # RGBA person cutout
                if cut.mode != 'RGBA':
                    cut = cut.convert('RGBA')
                cut.save(frames_dir / ('f_%06d.png' % idx))
                idx += 1
        finally:
            cap.release()
        if idx == 0:
            _log('matting: tak ada frame terbaca -> kembalikan asli')
            return in_path
        out_mov = out_dir / 'avatar_rgba.mov'
        # PNG RGBA sequence -> QuickTime MOV dengan codec PNG (lossless RGBA).
        # MOV + PNG codec menjamin full alpha channel dibaca 100% transparan
        # oleh semua versi FFmpeg di Windows/Linux tanpa konversi ke hitam.
        _run([
            'ffmpeg', '-y', '-framerate', str(fps),
            '-i', str(frames_dir / 'f_%06d.png'),
            '-c:v', 'png', '-pix_fmt', 'rgba',
            '-an',
            str(out_mov),
        ], timeout=1200)
        if not out_mov.exists() or out_mov.stat().st_size < 1000:
            _log('matting: encode mov gagal -> kembalikan asli')
            return in_path
        _log('matting: background dihapus ->', out_mov)
        return out_mov
    except Exception as e:
        traceback.print_exc()
        _log('matting gagal (', e, ') -> kembalikan asli')
        return in_path


def _do_render(image_b64, audio_b64, mode, duration, fps, remove_bg=False) -> Path:
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

    # Opsional: hapus background -> MOV ber-alpha (orangnya saja). Fail-safe:
    # kalau gagal, remove_background_video mengembalikan `vid` mp4 asli.
    if remove_bg:
        matted = remove_background_video(vid, job / 'matte', fps)
        if matted and (str(matted).lower().endswith('.mov') or str(matted).lower().endswith('.webm')):
            return Path(matted)
        # matting gagal -> lanjut ke normalisasi mp4 opaque di bawah.

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
        remove_bg = bool(data.get('remove_bg'))

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
            'remove_bg': remove_bg,
        }
        with _JOBS_LOCK:
            _JOBS[job_id] = {'status': 'pending', 'path': None, 'error': None}
        threading.Thread(target=_run_job, args=(job_id, params), daemon=True).start()
        _log('queued job', job_id, 'mode', mode, 'duration', duration, 'remove_bg', remove_bg)
        return jsonify({'job_id': job_id, 'status': 'pending'}), 202
    except Exception as e:  # pragma: no cover
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


def _handle_avatar_result(job_id):
    """Polling hasil job: 202 selama proses, video saat selesai, 5xx saat gagal."""
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
    # webm saat background dihapus (VP9 alpha), selain itu mp4.
    mime = 'video/webm' if str(path).lower().endswith('.webm') else 'video/mp4'
    return send_file(path, mimetype=mime)


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
