# Endpoint F5-TTS + Avatar (Colab T4) untuk Commentary

Menyediakan route `POST /tts` (voice-clone F5-TTS Flow Matching) dan `POST /avatar` di server Colab yang **sama**. App memanggilnya dengan base URL yang sama seperti `xttsColabUrl`.

## Isi

- `avatar_server.py` — Flask server, route `/avatar` (talk/idle) -> output mp4.
- `setup_colab.sh` — install SadTalker + LivePortrait + siapkan idle driving video.

## Cara pakai di Colab (Runtime = GPU T4)

```bash
# 1) Setup (sekali per sesi)
!bash setup_colab.sh
```

```python
# 2) Set env engine
import os
os.environ['SADTALKER_DIR']    = '/content/SadTalker'
os.environ['LIVEPORTRAIT_DIR'] = '/content/LivePortrait'
os.environ['IDLE_DRIVING']     = '/content/assets/idle_driving.mp4'
os.environ['AVATAR_MAX_SIDE']  = '512'   # T4-friendly
os.environ['AVATAR_FP16']      = '1'

# 3) Jalankan server + tunnel publik (cloudflared)
from flask import Flask
from flask_cloudflared import run_with_cloudflared
from avatar_server import register_avatar_routes
app = Flask(__name__)
register_avatar_routes(app)
run_with_cloudflared(app)     # cetak URL publik https://xxxx.trycloudflare.com
app.run(port=7860)
```

Kalau kamu SUDAH punya server VoxCPM `/clone`, cukup daftarkan route-nya ke app
yang sama supaya **base URL identik**:

```python
from avatar_server import register_avatar_routes
register_avatar_routes(app)   # app VoxCPM kamu yang sudah ada
```

## Kontrak API

`POST {baseHostUrl}/avatar`

```jsonc
{
  "image_b64": "<foto avatar base64>",
  "audio_b64": "<wav cloned voice base64 | null utk idle>",
  "mode": "talk" | "idle",   // talk = Segment A/C, idle = Segment B
  "duration": 4.2,            // detik (utk loop idle)
  "fps": 25
}
```

Response: **`video/mp4`** (body raw). Validasi magic-bytes `ftyp` — cocok dengan
pola validasi voice-clone yang sudah ada.

Health check: `GET /avatar/health`.

## Catatan T4

- SadTalker (talk) & LivePortrait (idle) nyaman di T4 (16GB). Resolusi dikunci <=512, fp16.
- Naikkan timeout di sisi app (endpoint avatar butuh menitan, bukan 120s).
- Colab free bisa putus sesi -> pertimbangkan Colab Pro untuk produksi rutin.
- Kalau LivePortrait/idle driving tidak tersedia, `idle` otomatis fallback ke
  SadTalker still + audio senyap (kedip minimal).
