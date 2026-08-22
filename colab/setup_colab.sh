#!/usr/bin/env bash
# Setup engine avatar untuk Google Colab T4.
# Jalankan sekali per sesi Colab SEBELUM menjalankan server.
# Idempotent: aman dijalankan ulang (git pull -> re-patch SadTalker di disk).
# CATATAN: sengaja TIDAK menjalankan requirements.txt SadTalker, karena pin lama
# (numpy==1.23, torch lama) akan men-downgrade env & merusak VoxCPM2.

WORK=/content
ASSETS=$WORK/assets
mkdir -p "$ASSETS"

echo "==> System deps"
apt-get -qq update >/dev/null 2>&1 || true
apt-get -qq install -y ffmpeg git-lfs >/dev/null 2>&1 || true

echo "==> Python deps (tanpa pin yang bisa merusak numpy/torch VoxCPM)"
# 1) Deps standar dengan pre-built wheels
pip -q install flask flask-cloudflared imageio imageio-ffmpeg yacs safetensors \
    face-alignment facexlib kornia pydub librosa numba resampy scikit-image scipy tqdm pyyaml yapf tb-nightly >/dev/null 2>&1 || \
  pip install flask flask-cloudflared imageio imageio-ffmpeg yacs safetensors face-alignment facexlib kornia pydub librosa numba resampy scikit-image scipy tqdm pyyaml yapf tb-nightly

# 2) basicsr & gfpgan (install dengan --no-build-isolation)
echo "==> Install basicsr & gfpgan (--no-build-isolation)"
pip -q install --no-build-isolation basicsr gfpgan facexlib >/dev/null 2>&1 || \
  pip -q install --no-build-isolation --no-deps basicsr gfpgan facexlib >/dev/null 2>&1 || \
  pip -q install --no-deps basicsr gfpgan facexlib >/dev/null 2>&1 || true

# 3) Patch basicsr di site-packages (perbaiki import functional_tensor yang dihapus di torchvision baru)
python3 - <<'BSREOF'
import glob, sys
for root in sys.path:
    if "site-packages" in root or "dist-packages" in root:
        for f in glob.glob(f"{root}/basicsr/**/*.py", recursive=True):
            try:
                txt = open(f, "r", encoding="utf-8").read()
                if "torchvision.transforms.functional_tensor" in txt:
                    txt = txt.replace("torchvision.transforms.functional_tensor", "torchvision.transforms.functional")
                    open(f, "w", encoding="utf-8").write(txt)
            except Exception:
                pass
BSREOF

echo "==> Hapus-background deps (rembg + onnxruntime GPU, fallback CPU)"
# rembg + onnxruntime (u2net_human_seg) untuk toggle "Hapus Background".
pip -q install rembg onnxruntime-gpu >/dev/null 2>&1 || \
  pip -q install rembg onnxruntime >/dev/null 2>&1 || \
  pip -q install rembg >/dev/null 2>&1 || true

# Pre-download model u2net_human_seg & test session provider (GPU -> CPU fallback)
echo "==> Warmup rembg session & model"
python3 - <<'REMBGEOF'
try:
    from rembg import new_session
    import os
    model = os.environ.get("REMBG_MODEL", "u2net_human_seg")
    try:
        sess = new_session(model, providers=['CUDAExecutionProvider', 'CPUExecutionProvider'])
        print("[rembg] Warmup OK: provider GPU/CPU (model:", model, ")")
    except Exception as egpu:
        sess = new_session(model, providers=['CPUExecutionProvider'])
        print("[rembg] Warmup OK: fallback CPU (model:", model, ")")
except Exception as e:
    print("[rembg] Warmup WARN (akan dicoba lagi saat request):", e)
REMBGEOF

# --------- SadTalker (mode talk: A & C) ---------
if [ ! -d "$WORK/SadTalker" ]; then
  echo "==> Clone SadTalker"
  git clone -q https://github.com/OpenTalker/SadTalker "$WORK/SadTalker"
fi

# Unduh checkpoint (idempotent; skip kalau sudah ada).
if [ ! -d "$WORK/SadTalker/checkpoints" ] || [ -z "$(ls -A "$WORK/SadTalker/checkpoints" 2>/dev/null)" ]; then
  echo "==> Download model SadTalker"
  ( cd "$WORK/SadTalker" && bash scripts/download_models.sh ) || echo "WARN: download_models.sh gagal sebagian"
fi

# Verifikasi checkpoint safetensors tidak korup ("header too small" = file terpotong).
# download_models.sh pakai wget -nc, jadi file yang gagal separuh tidak pernah diunduh ulang.
echo "==> Verifikasi & perbaiki checkpoint SadTalker"
python3 - <<'CKEOF'
import os, urllib.request
base = "https://github.com/OpenTalker/SadTalker/releases/download/v0.0.2-rc/"
ckpt = "/content/SadTalker/checkpoints"
os.makedirs(ckpt, exist_ok=True)
need = ["SadTalker_V0.0.2_256.safetensors", "SadTalker_V0.0.2_512.safetensors"]
MIN = 1_000_000  # file valid >> 1MB; file korup/HTML jauh lebih kecil
for f in need:
    p = os.path.join(ckpt, f)
    sz = os.path.getsize(p) if os.path.isfile(p) else 0
    if sz >= MIN:
        print("[ckpt] OK:", f, sz); continue
    print("[ckpt] KORUP/HILANG (", sz, "b) -> unduh ulang:", f)
    try:
        if os.path.isfile(p): os.remove(p)
        urllib.request.urlretrieve(base + f, p)
        print("[ckpt] terunduh:", os.path.getsize(p))
    except Exception as e:
        print("[ckpt] GAGAL unduh", f, "->", e)
CKEOF

echo "==> Tulis shim kompatibilitas SadTalker (numpy2 / torchvision0.17+ / torch2.6)"
cat > "$WORK/SadTalker/pippit_compat.py" <<'PYEOF'
# Auto-generated shim: bikin SadTalker (2023) jalan di stack modern Colab.
# Diimpor paling atas oleh inference.py (dan self-test) sebelum modul lain.
import sys
import warnings

# 1) numpy: kembalikan nama lama yang dihapus di numpy>=1.24 & numpy 2.x.
#    Dibungkus catch_warnings supaya FutureWarning hasattr tidak berisik.
try:
    import numpy as _np
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        # 1a) alias skalar lama (np.float/np.int/np.bool/np.object/np.str/...)
        _scalars = {"float": float, "int": int, "bool": bool, "object": object,
                    "str": str, "complex": complex, "long": int, "unicode": str,
                    "float_": getattr(_np, "float64", float),
                    "complex_": getattr(_np, "complex128", complex),
                    "unicode_": getattr(_np, "str_", str)}
        for _n, _t in _scalars.items():
            if not hasattr(_np, _n):
                try:
                    setattr(_np, _n, _t)
                except Exception:
                    pass
        # 1b) kelas warning/exception yang pindah ke numpy.exceptions di numpy 2.0
        _exc = getattr(_np, "exceptions", None)
        for _wn in ("VisibleDeprecationWarning", "ComplexWarning",
                    "ModuleDeprecationWarning", "RankWarning",
                    "TooHardError", "AxisError", "DTypePromotionError"):
            if not hasattr(_np, _wn):
                _c = getattr(_exc, _wn, None) if _exc is not None else None
                if _c is None:
                    _c = DeprecationWarning if _wn.endswith("Warning") else Exception
                try:
                    setattr(_np, _wn, _c)
                except Exception:
                    pass
        # 1c) konstanta float lama yang dihapus/diganti di numpy 2.0
        _consts = {"NaN": _np.nan, "NAN": _np.nan, "Inf": _np.inf,
                   "Infinity": _np.inf, "infty": _np.inf, "PINF": _np.inf,
                   "NINF": -_np.inf, "PZERO": 0.0, "NZERO": -0.0}
        for _cn, _cv in _consts.items():
            if not hasattr(_np, _cn):
                try:
                    setattr(_np, _cn, _cv)
                except Exception:
                    pass
except Exception as _e:
    print("[pippit_compat] numpy shim warn:", _e, flush=True)

# 2) torchvision.transforms.functional_tensor (dihapus di torchvision>=0.17;
#    dipakai basicsr/gfpgan). Alias-kan ke modul functional yang baru.
try:
    import torchvision.transforms.functional as _tvf
    sys.modules.setdefault("torchvision.transforms.functional_tensor", _tvf)
except Exception as _e:
    print("[pippit_compat] torchvision shim warn:", _e, flush=True)

# 3) torch.load default weights_only=True (torch>=2.6) -> paksa False supaya
#    checkpoint SadTalker (berisi objek ter-pickle) tetap bisa dimuat.
try:
    import torch as _torch
    if not getattr(_torch.load, "_pippit_patched", False):
        _orig_load = _torch.load
        def _patched_load(*a, **k):
            k.setdefault("weights_only", False)
            return _orig_load(*a, **k)
        _patched_load._pippit_patched = True
        _torch.load = _patched_load
except Exception as _e:
    print("[pippit_compat] torch.load shim warn:", _e, flush=True)
PYEOF

# Sisipkan `import pippit_compat` paling atas inference.py (idempotent).
python3 - <<'PYEOF'
import io
p = "/content/SadTalker/inference.py"
try:
    src = io.open(p, encoding="utf-8").read()
except FileNotFoundError:
    print("[patch] WARN: inference.py tidak ditemukan"); raise SystemExit(0)
if "pippit_compat" not in src:
    lines = src.splitlines(keepends=True)
    ins = 0
    for i, ln in enumerate(lines[:2]):
        if ln.startswith("#!") or "coding" in ln:
            ins = i + 1
    lines.insert(ins, "import pippit_compat  # PIPPIT: modern-stack shims\n")
    io.open(p, "w", encoding="utf-8").write("".join(lines))
    print("[patch] inference.py: pippit_compat disisipkan")
else:
    print("[patch] inference.py: pippit_compat sudah ada")
PYEOF

# Patch sumber alias numpy lama yg dipakai saat definisi modul (word-boundary aman,
# tidak mengubah np.float32 / np.int64 dsb).
for kw in float int bool object str complex; do
  grep -rlZ --include='*.py' -E "np\.${kw}\b" "$WORK/SadTalker/src" 2>/dev/null \
    | xargs -0 -r sed -i -E "s/\bnp\.${kw}\b/${kw}/g" 2>/dev/null || true
done

# Patch preprocess.py: numpy>=1.24 tolak array ragged & float(1D array) TypeError
echo "==> Patch SadTalker preprocess.py (numpy 2.x scalar & ragged-array fix)"
python3 - <<'PYEOF'
import io, re
p = "/content/SadTalker/src/face3d/util/preprocess.py"
try:
    src = io.open(p, encoding="utf-8").read()
except FileNotFoundError:
    print("[patch] WARN: preprocess.py tidak ditemukan"); raise SystemExit(0)

# 1) Patch align_img trans_params
old_trans = "trans_params = np.array([w0, h0, s, t[0], t[1]])"
new_trans = "trans_params = np.array([float(w0), float(h0), float(np.asarray(s).reshape(-1)[0]), float(np.asarray(t).reshape(-1)[0]), float(np.asarray(t).reshape(-1)[1])])"
if old_trans in src:
    src = src.replace(old_trans, new_trans)

# 2) Patch resize_n_crop_img (hindari TypeError: only 0-dimensional arrays can be converted to Python scalars)
# Ganti fungsi resize_n_crop_img dengan versi aman skalar
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
    print("[patch] resize_n_crop_img & align_img: FIXED (scalar-safe)")
else:
    print("[patch] resize_n_crop_img pattern not found (already patched or different)")

io.open(p, "w", encoding="utf-8").write(src)

# 3) Patch face_enhancer.py: ImportError GFPGANer fallback
p_enh = "/content/SadTalker/src/utils/face_enhancer.py"
try:
    src_enh = io.open(p_enh, encoding="utf-8").read()
    if "from gfpgan import GFPGANer" in src_enh and "try:" not in src_enh:
        src_enh = src_enh.replace("from gfpgan import GFPGANer", """try:
    from gfpgan import GFPGANer
except Exception:
    try:
        from gfpgan.utils import GFPGANer
    except Exception:
        GFPGANer = None""")
        io.open(p_enh, "w", encoding="utf-8").write(src_enh)
        print("[patch] face_enhancer.py GFPGANer import: FIXED (safe fallback)")
    else:
        print("[patch] face_enhancer.py: sudah aman / sudah dipatch")
except Exception as e_enh:
    print("[patch] face_enhancer.py warn:", e_enh)
PYEOF

# --------- LivePortrait (mode idle: B) ---------
echo "==> Setup LivePortrait (mode idle: B)"
if [ ! -f "$WORK/LivePortrait/inference.py" ]; then
  echo "==> [1/3] Clone LivePortrait repo ..."
  rm -rf "$WORK/LivePortrait"
  git clone --depth 1 https://github.com/KwaiVGI/LivePortrait "$WORK/LivePortrait"
fi

echo "==> [2/3] Install LivePortrait dependencies ..."
pip -q install huggingface_hub tyro pyyaml scipy imageio imageio-ffmpeg >/dev/null 2>&1 || true

echo "==> [3/3] Download pretrained weights LivePortrait (~2.5GB) ..."
python3 - <<'LPEOF'
import os, sys
try:
    from huggingface_hub import snapshot_download
    dst = "/content/LivePortrait/pretrained_weights"
    os.makedirs(dst, exist_ok=True)
    # Cek apakah file model utama sudah lengkap (hindari download ulang)
    main_files = ["appearance_feature_extractor.pth", "motion_extractor.pth", "spade_generator.pth", "warping_module.pth"]
    exists_count = sum(1 for f in main_files if os.path.exists(os.path.join(dst, f)) or os.path.exists(os.path.join(dst, "liveportrait", f)))
    if exists_count >= len(main_files):
        print("[LivePortrait] Pretrained weights SUDAH ADA (skip download).", flush=True)
    else:
        print("[LivePortrait] Mengunduh weights dari HuggingFace (KwaiVGI/LivePortrait) ...", flush=True)
        snapshot_download(repo_id="KwaiVGI/LivePortrait", local_dir=dst, ignore_patterns=["*.git*", "*.md", "*.png", "*.jpg"])
        print("[LivePortrait] Download weights SELESAI!", flush=True)
except Exception as e:
    print("[LivePortrait] Download via snapshot_download error:", e, flush=True)
    print("[LivePortrait] Coba fallback huggingface-cli ...", flush=True)
    os.system("huggingface-cli download KwaiVGI/LivePortrait --local-dir /content/LivePortrait/pretrained_weights --exclude '*.git*' || true")
LPEOF

# --------- Klip driving idle untuk Segment B (KEDIP + SENYUM tipis, terklasifikasi) ---------
# PENTING: dulu klip driving diambil asal (contoh pertama / terpendek) -> sering
# klip BICARA / SENYUM konstan, dan setelah di-loop ping-pong ritmenya seragam
# -> avatar Segmen B jadi komat-kamit / senyum terus / mata melirik kaku.
# Sekarang kita KLASIFIKASI contoh driving lalu bikin DUA klip pendek:
#   - idle_blink.mp4 : contoh dgn KEDIP nyata (EAR turun tajam / kelopak menutup).
#   - idle_smile.mp4 : contoh dengan gerak mulut ADA tapi tidak berosilasi
#                      (bukan bicara) -> senyum tipis. Dilewati bila tak aman.
# Server lalu menyusun timeline NON-periodik: netral + event pada waktu ACAK.
# Selalu regenerate (rm -f) supaya klip lama tergantikan.
echo "==> Generate idle driving (klasifikasi kedip/senyum, low-motion)"
rm -f "$ASSETS/idle_driving.mp4" "$ASSETS/idle_blink.mp4" "$ASSETS/idle_smile.mp4"
python3 - <<'PYEOF'
import os, glob, subprocess
LP = "/content/LivePortrait"
ASSETS = "/content/assets"
os.makedirs(ASSETS, exist_ok=True)

cands = sorted(glob.glob(os.path.join(LP, "assets/examples/driving", "*.mp4")))
if not cands:
    cands = sorted(
        p for p in glob.glob(os.path.join(LP, "**", "*.mp4"), recursive=True)
        if "driving" in p.lower()
    )

def _dur(p):
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", p],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60)
        return float((r.stdout.decode("utf-8", "ignore") or "0").strip() or 0)
    except Exception:
        return 0.0

def _ff(args):
    subprocess.run(args, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)

def _make(src, start, dur, out, slow=1.5):
    tmp = "/tmp/_cut.mp4"
    _ff(["ffmpeg", "-y", "-ss", "%.2f" % start, "-i", src, "-t", "%.2f" % dur,
         "-an", "-vf", "fps=25", "-c:v", "libx264", "-pix_fmt", "yuv420p", tmp])
    _ff(["ffmpeg", "-y", "-i", tmp, "-vf", "setpts=%.2f*PTS,fps=25" % slow,
         "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", out])
    return os.path.exists(out) and os.path.getsize(out) > 1000

def _fallback_blink():
    # Tak bisa analisis -> pakai heuristik lama: klip terpendek, pelan.
    if not cands:
        print("[idle] WARN: tak ada driving sample; idle -> static/SadTalker fallback")
        return
    src = min(cands, key=lambda p: (_dur(p) or 999.0))
    ok = _make(src, 0.0, 1.4, os.path.join(ASSETS, "idle_blink.mp4"), 1.6)
    if ok:
        _ff(["ffmpeg", "-y", "-i", os.path.join(ASSETS, "idle_blink.mp4"),
             "-c", "copy", os.path.join(ASSETS, "idle_driving.mp4")])
    print("[idle] fallback blink <-", os.path.basename(src), "ok=", ok)

try:
    import numpy as np
    import cv2
except Exception as e:
    print("[idle] numpy/cv2 tak tersedia (", e, ") -> fallback heuristik")
    _fallback_blink()
    raise SystemExit(0)

def _analyze(p, maxf=90):
    cap = cv2.VideoCapture(p)
    frames = []
    while len(frames) < maxf:
        ok, f = cap.read()
        if not ok:
            break
        g = cv2.cvtColor(f, cv2.COLOR_BGR2GRAY)
        g = cv2.resize(g, (128, 128)).astype("float32")
        frames.append(g)
    cap.release()
    if len(frames) < 4:
        return None
    fr = np.array(frames)
    h, w = 128, 128
    def reg(a, y0, y1, x0, x1):
        return a[:, int(y0 * h):int(y1 * h), int(x0 * w):int(x1 * w)]
    def mot(a):
        d = np.abs(np.diff(a, axis=0))
        return d.reshape(d.shape[0], -1).mean(axis=1)
    eye = mot(reg(fr, 0.30, 0.52, 0.20, 0.80))
    mouth = mot(reg(fr, 0.60, 0.85, 0.28, 0.72))
    thr = mouth.mean() + mouth.std() + 1e-6
    peaks = int(((mouth[1:-1] > thr) & (mouth[1:-1] >= mouth[:-2]) & (mouth[1:-1] >= mouth[2:])).sum())
    return dict(path=p, eye=float(eye.mean()), mouth=float(mouth.mean()),
                mouthmax=float(mouth.max()), peaks=peaks,
                eye_argmax=int(eye.argmax()), nframes=len(frames))

# --- KEDIP SEJATI via Eye Aspect Ratio (EAR) dari landmark wajah ---
# Gerak area mata TIDAK bisa membedakan kedip (kelopak menutup) dari lirik
# kanan-kiri. EAR = rasio tinggi:lebar mata; turun tajam HANYA saat kelopak
# menutup -> inilah sinyal kedip yang benar (menolak lirikan).
_FA = [None]


def _get_fa():
    if _FA[0] is not None:
        return _FA[0] or None
    try:
        import face_alignment
        try:
            lt = face_alignment.LandmarksType.TWO_D
        except AttributeError:
            lt = face_alignment.LandmarksType._2D
        dev = "cpu"
        try:
            import torch
            dev = "cuda" if torch.cuda.is_available() else "cpu"
        except Exception:
            pass
        _FA[0] = face_alignment.FaceAlignment(lt, flip_input=False, device=dev)
    except Exception as e:
        print("[drv] face-alignment tak tersedia (", e, ") -> pakai motion heuristik")
        _FA[0] = False
    return _FA[0] or None


def _ear_series(p, maxf=150):
    fa = _get_fa()
    if fa is None:
        return None
    cap = cv2.VideoCapture(p)
    ears, idx = [], 0
    while idx < maxf:
        ok, f = cap.read()
        if not ok:
            break
        idx += 1
        try:
            preds = fa.get_landmarks(cv2.cvtColor(f, cv2.COLOR_BGR2RGB))
        except Exception:
            preds = None
        if not preds:
            ears.append(np.nan)
            continue
        lm = np.asarray(preds[0], dtype="float32")

        def _ear(e):
            a = np.linalg.norm(lm[e[1]] - lm[e[5]])
            b = np.linalg.norm(lm[e[2]] - lm[e[4]])
            c = np.linalg.norm(lm[e[0]] - lm[e[3]]) + 1e-6
            return (a + b) / (2.0 * c)

        ears.append(0.5 * (_ear([36, 37, 38, 39, 40, 41]) + _ear([42, 43, 44, 45, 46, 47])))
    cap.release()
    return np.asarray(ears, dtype="float32")


def _pick_blink_ear():
    best = None
    for p in cands:
        s = _ear_series(p)
        if s is None:
            return "NOFA"
        v = s[~np.isnan(s)]
        if v.size < 5:
            continue
        base = float(np.median(v))
        mn = float(np.nanmin(s))
        drop = (base - mn) / (base + 1e-6)
        fidx = int(np.nanargmin(s))
        print("[drv] EAR", os.path.basename(p),
              "base=%.3f min=%.3f drop=%.2f" % (base, mn, drop))
        # drop >= 0.28 = kelopak benar-benar menutup (bukan sekadar lirikan).
        if drop >= 0.28 and (best is None or drop > best["drop"]):
            best = dict(path=p, drop=drop, fidx=fidx)
    return best


blink_done = False
picked = _pick_blink_ear()
if picked == "NOFA":
    picked = None
elif picked:
    bstart = max(0.0, picked["fidx"] / 25.0 - 0.22)
    ok_b = _make(picked["path"], bstart, 0.9, os.path.join(ASSETS, "idle_blink.mp4"), 1.4)
    print("[drv] BLINK(EAR) <-", os.path.basename(picked["path"]),
          "drop=%.2f ok=" % picked["drop"], ok_b)
    if ok_b:
        _ff(["ffmpeg", "-y", "-i", os.path.join(ASSETS, "idle_blink.mp4"),
             "-c", "copy", os.path.join(ASSETS, "idle_driving.mp4")])
        blink_done = True
else:
    print("[drv] BLINK(EAR): tak ada kedip nyata di contoh -> coba motion heuristik")

info = [a for a in (_analyze(p) for p in cands) if a]
for a in info:
    print("[drv]", os.path.basename(a["path"]),
          "eye=%.3f mouth=%.3f peaks=%d" % (a["eye"], a["mouth"], a["peaks"]))

if not blink_done:
    if not info:
        print("[idle] analisis kosong -> fallback heuristik")
        _fallback_blink()
        raise SystemExit(0)
    # Fallback: mata paling dominan (bisa jadi lirikan, tapi lebih baik dari nihil).
    blink = max(info, key=lambda a: a["eye"] / (a["mouth"] + 0.05))
    bstart = max(0.0, blink["eye_argmax"] / 25.0 - 0.15)
    ok_b = _make(blink["path"], bstart, 0.8, os.path.join(ASSETS, "idle_blink.mp4"), 1.5)
    print("[drv] BLINK(motion) <-", os.path.basename(blink["path"]), "ok=", ok_b)
    if ok_b:
        _ff(["ffmpeg", "-y", "-i", os.path.join(ASSETS, "idle_blink.mp4"),
             "-c", "copy", os.path.join(ASSETS, "idle_driving.mp4")])

# SMILE: ada gerak mulut TAPI peaks sedikit (bukan bicara), bukan klip kedip.
blink_path = picked["path"] if picked else None
sm = [a for a in info if a["peaks"] <= 3 and a["mouth"] > 0.05 and a["path"] != blink_path]
if sm:
    smile = max(sm, key=lambda a: a["mouthmax"])
    ok_s = _make(smile["path"], 0.0, 0.9, os.path.join(ASSETS, "idle_smile.mp4"), 1.5)
    print("[drv] SMILE <-", os.path.basename(smile["path"]), "ok=", ok_s)
else:
    print("[drv] SMILE: tak ada kandidat aman -> Segmen B jadi kedip-only")
PYEOF

# --------- SELF-TEST: import + render nyata (diagnosa lengkap) ---------
echo "==> Self-test 1/2: import SadTalker di stack modern ..."
python3 - <<'PYEOF'
import sys, traceback
sys.path.insert(0, "/content/SadTalker")
try:
    import pippit_compat  # aktifkan shim modern-stack
    from src.utils.preprocess import CropAndExtract
    from src.test_audio2coeff import Audio2Coeff
    from src.facerender.animate import AnimateFromCoeff
    from src.generate_batch import get_data
    print("SADTALKER_IMPORT_OK")
except Exception:
    print("SADTALKER_IMPORT_FAILED")
    traceback.print_exc()
PYEOF

echo "==> Self-test 2/2: render nyata SadTalker (image contoh + audio diam) ..."
python3 - <<'PYEOF'
import subprocess, sys, os, glob
os.chdir("/content/SadTalker")
cands = sorted(glob.glob("/content/SadTalker/examples/source_image/*.*"))
img = cands[0] if cands else None
print("test image:", img)
if img is None:
    print("SADTALKER_RENDER_SKIP: tidak ada contoh gambar")
    raise SystemExit(0)
subprocess.run("ffmpeg -y -loglevel error -f lavfi -i anullsrc=r=16000:cl=mono -t 1 /tmp/sil.wav", shell=True)
r = subprocess.run([sys.executable, "inference.py",
    "--source_image", img, "--driven_audio", "/tmp/sil.wav",
    "--result_dir", "/tmp/sadout", "--still", "--preprocess", "full", "--size", "512"],
    capture_output=True, text=True)
print("RENDER_RETURN_CODE:", r.returncode)
if r.returncode == 0:
    print("SADTALKER_RENDER_OK")
else:
    print("SADTALKER_RENDER_FAILED")
    print("=== STDERR tail ===")
    print(r.stderr[-8000:])
    print("=== STDOUT tail ===")
    print(r.stdout[-2000:])
PYEOF

echo
echo "==> Selesai. Set env lalu jalankan server:"
echo "    export SADTALKER_DIR=$WORK/SadTalker"
echo "    export LIVEPORTRAIT_DIR=$WORK/LivePortrait"
echo "    export IDLE_DRIVING=$ASSETS/idle_driving.mp4"
echo "    python avatar_server.py"
