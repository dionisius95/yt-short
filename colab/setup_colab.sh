#!/usr/bin/env bash
# Setup engine avatar untuk Google Colab T4.
# Jalankan sekali per sesi Colab SEBELUM menjalankan avatar_server.py.
set -e

WORK=/content
ASSETS=$WORK/assets
mkdir -p "$ASSETS"

echo "==> System deps"
apt-get -qq update && apt-get -qq install -y ffmpeg git-lfs >/dev/null

echo "==> Python deps"
pip -q install flask flask-cloudflared imageio-ffmpeg gfpgan yacs face-alignment safetensors

# --------- SadTalker (mode talk: A & C) ---------
if [ ! -d "$WORK/SadTalker" ]; then
  echo "==> Clone SadTalker"
  git clone -q https://github.com/OpenTalker/SadTalker "$WORK/SadTalker"
  pip -q install -r "$WORK/SadTalker/requirements.txt" || true
  (cd "$WORK/SadTalker" && bash scripts/download_models.sh)
fi

# --------- LivePortrait (mode idle: B) ---------
if [ ! -d "$WORK/LivePortrait" ]; then
  echo "==> Clone LivePortrait"
  git clone -q https://github.com/KwaiVGI/LivePortrait "$WORK/LivePortrait"
  pip -q install -r "$WORK/LivePortrait/requirements.txt" || true
  # checkpoint via huggingface
  pip -q install "huggingface_hub[cli]"
  huggingface-cli download KwaiVGI/LivePortrait --local-dir "$WORK/LivePortrait/pretrained_weights" --exclude "*.git*" || true
fi

# --------- Idle driving video untuk Segment B ---------
# Pakai driving sample bawaan LivePortrait (subtle head + blink), potong 3 dtk.
if [ ! -f "$ASSETS/idle_driving.mp4" ]; then
  echo "==> Siapkan idle driving video"
  SRC=$(find "$WORK/LivePortrait" -name '*.mp4' -path '*driving*' | head -n1 || true)
  if [ -n "$SRC" ]; then
    ffmpeg -y -i "$SRC" -t 3 -vf fps=25 -an "$ASSETS/idle_driving.mp4"
  else
    echo "WARN: tidak menemукan driving sample; idle akan fallback ke SadTalker still."
  fi
fi

echo "==> Selesai. Set env lalu jalankan server:"
echo "    export SADTALKER_DIR=$WORK/SadTalker"
echo "    export LIVEPORTRAIT_DIR=$WORK/LivePortrait"
echo "    export IDLE_DRIVING=$ASSETS/idle_driving.mp4"
echo "    python avatar_server.py"
