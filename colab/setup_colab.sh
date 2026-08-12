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
pip -q install flask flask-cloudflared imageio imageio-ffmpeg yacs safetensors \
    face-alignment kornia pydub librosa numba resampy gfpgan basicsr scikit-image >/dev/null 2>&1 || \
  pip -q install flask flask-cloudflared imageio imageio-ffmpeg yacs safetensors face-alignment kornia pydub librosa numba resampy gfpgan basicsr scikit-image || true

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

# Patch align_img: numpy>=1.24 tolak array ragged (w0,h0,s skalar + t[0],t[1] array).
echo "==> Patch SadTalker align_img (numpy ragged-array fix)"
python3 - <<'PYEOF'
import io
p = "/content/SadTalker/src/face3d/util/preprocess.py"
try:
    src = io.open(p, encoding="utf-8").read()
except FileNotFoundError:
    print("[patch] WARN: preprocess.py tidak ditemukan"); raise SystemExit(0)
old = "trans_params = np.array([w0, h0, s, t[0], t[1]])"
new = "trans_params = np.array([float(w0), float(h0), float(np.asarray(s).reshape(-1)[0]), float(np.asarray(t).reshape(-1)[0]), float(np.asarray(t).reshape(-1)[1])])"
if new in src:
    print("[patch] align_img: sudah dipatch")
elif old in src:
    io.open(p, "w", encoding="utf-8").write(src.replace(old, new))
    print("[patch] align_img: FIXED")
else:
    print("[patch] align_img: pola tidak ditemukan (mungkin versi beda)")
PYEOF

# --------- LivePortrait (mode idle: B) ---------
if [ ! -d "$WORK/LivePortrait" ]; then
  echo "==> Clone LivePortrait"
  git clone -q https://github.com/KwaiVGI/LivePortrait "$WORK/LivePortrait"
  pip -q install -r "$WORK/LivePortrait/requirements.txt" >/dev/null 2>&1 || true
  pip -q install "huggingface_hub[cli]" >/dev/null 2>&1 || true
  huggingface-cli download KwaiVGI/LivePortrait --local-dir "$WORK/LivePortrait/pretrained_weights" --exclude "*.git*" >/dev/null 2>&1 || true
fi

# --------- Idle driving video untuk Segment B ---------
if [ ! -f "$ASSETS/idle_driving.mp4" ]; then
  echo "==> Siapkan idle driving video"
  SRC=$(find "$WORK/LivePortrait" -name '*.mp4' -path '*driving*' 2>/dev/null | head -n1)
  if [ -n "$SRC" ]; then
    ffmpeg -y -i "$SRC" -t 3 -vf fps=25 -an "$ASSETS/idle_driving.mp4" >/dev/null 2>&1 || true
  else
    echo "WARN: tidak menemukan driving sample; idle akan fallback ke SadTalker still."
  fi
fi

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
