# -*- coding: utf-8 -*-
"""
🎙️ Server VoxCPM + Wav2Lip AI Talking Avatar untuk PippitLokal / Shorts Editor (Google Colab T4 GPU).

Petunjuk Penggunaan di Google Colab:
1. Buka Google Colab: https://colab.research.google.com/
2. Pilih Runtime -> Change runtime type -> T4 GPU (Gratis).
3. Buat sel baru (Cell 1):
   !pip -q install voxcpm soundfile librosa opencv-python face-alignment
   !git clone https://github.com/rudrabha/Wav2Lip.git
   !mkdir -p Wav2Lip/checkpoints ~/.cache/torch/hub/checkpoints
   !wget -q https://github.com/rudrabha/Wav2Lip/releases/download/v1.0/wav2lip_gan.pth -O Wav2Lip/checkpoints/wav2lip_gan.pth
   !wget -q https://www.adrianbulat.com/downloads/python-fan/s3fd-619a3168.pth -O ~/.cache/torch/hub/checkpoints/s3fd-619a3168.pth
4. Buat sel baru (Cell 2): Tempelkan isi file python ini lalu jalankan.
5. Salin URL publik gratis (...trycloudflare.com) ke menu Settings di aplikasi desktop.
"""

import os, io, sys, json, base64, tempfile, traceback, subprocess
try:
    import numpy as np  # type: ignore
except ImportError:
    np = None  # type: ignore
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
try:
    import soundfile as sf  # type: ignore
except ImportError:
    sf = None  # type: ignore

MODEL_ID = os.environ.get("VOXCPM_MODEL", "openbmb/VoxCPM2")
DEVICE   = os.environ.get("VOXCPM_DEVICE", "auto")
PORT     = int(os.environ.get("VOXCPM_PORT", "8081"))

print(f"[VoxCPM] Memuat model Voice Cloning {MODEL_ID} (device={DEVICE}) ...", flush=True)
try:
    from voxcpm import VoxCPM  # type: ignore
    MODEL = VoxCPM.from_pretrained(MODEL_ID, load_denoiser=False, device=DEVICE)
    try:
        MODEL.generate(text="Warmup test audio")
    except Exception:
        pass
    print("[VoxCPM] Model Voice Cloning siap 100%!", flush=True)
except Exception as e:
    print(f"[VoxCPM] GAGAL memuat model Voice Cloning: {e}", flush=True)


class VoxCPMHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        return

    def do_GET(self):
        if self.path in ["/health", "/", "/tts", "/clone", "/lipsync", "/avatar"]:
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"ok")
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        req_path = self.path.rstrip("/")

        # ---------------------------------------------------------------------
        # 1. Endpoint Voice Cloning TTS (/tts & /clone)
        # ---------------------------------------------------------------------
        if req_path in ["", "/tts", "/clone"]:
            try:
                length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(length)
                req = json.loads(body.decode("utf-8") or "{}")

                text = req.get("text", "")
                prompt_wav_b64 = req.get("prompt_wav_b64") or req.get("speaker_wav_b64") or req.get("ref_audio_b64")

                if not text:
                    self.send_error(400, "Field 'text' required")
                    return

                print(f"[VoxCPM] Memproses dubbing Voice Clone ({len(text)} karakter)...", flush=True)

                prompt_file = None
                if prompt_wav_b64:
                    wav_data = base64.b64decode(prompt_wav_b64)
                    prompt_file = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
                    prompt_file.write(wav_data)
                    prompt_file.close()

                prompt_text = req.get("prompt_text") or req.get("prompt") or "Reference audio voice sample"
                if prompt_file:
                    audio_res = MODEL.generate(text=text, prompt_wav_path=prompt_file.name, prompt_text=prompt_text)
                else:
                    audio_res = MODEL.generate(text=text)

                sr = 24000
                if isinstance(audio_res, tuple):
                    wav_data = audio_res[0]
                    if len(audio_res) > 1 and isinstance(audio_res[1], int):
                        sr = audio_res[1]
                elif hasattr(audio_res, "audio"):
                    wav_data = audio_res.audio
                    if hasattr(audio_res, "sample_rate"):
                        sr = audio_res.sample_rate
                else:
                    wav_data = audio_res

                wav_data = np.asarray(wav_data, dtype=np.float32)
                if wav_data.ndim > 1:
                    wav_data = wav_data.squeeze()

                max_val = np.abs(wav_data).max()
                if max_val > 0:
                    wav_data = (wav_data / max_val * 0.95)

                pcm16_data = (wav_data * 32767.0).astype(np.int16)

                out_wav = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
                sf.write(out_wav.name, pcm16_data, sr, subtype='PCM_16')
                out_wav.close()

                wav_bytes = open(out_wav.name, "rb").read()

                self.send_response(200)
                self.send_header("Content-Type", "audio/wav")
                self.send_header("Content-Length", str(len(wav_bytes)))
                self.end_headers()
                self.wfile.write(wav_bytes)

                try: os.unlink(out_wav.name)
                except: pass
                if prompt_file:
                    try: os.unlink(prompt_file.name)
                    except: pass

            except Exception as e:
                err_msg = traceback.format_exc()
                print(f"[VoxCPM] ERROR: {err_msg}", flush=True)
                self.send_response(500)
                self.send_header("Content-Type", "text/plain")
                self.end_headers()
                self.wfile.write(err_msg.encode("utf-8"))

        # ---------------------------------------------------------------------
        # 2. Endpoint AI Talking Avatar Video Generator (/lipsync & /avatar)
        # ---------------------------------------------------------------------
        elif req_path in ["/lipsync", "/avatar"]:
            try:
                length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(length)
                req = json.loads(body.decode("utf-8") or "{}")

                img_b64   = req.get("image_b64") or req.get("avatar_b64") or req.get("face_b64")
                audio_b64 = req.get("audio_b64") or req.get("speaker_wav_b64") or req.get("speaker_b64")

                if not img_b64 or not audio_b64:
                    self.send_error(400, "Fields 'image_b64' and 'audio_b64' required")
                    return

                img_tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
                img_tmp.write(base64.b64decode(img_b64))
                img_tmp.close()

                audio_tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
                audio_tmp.write(base64.b64decode(audio_b64))
                audio_tmp.close()

                clean_audio = tempfile.NamedTemporaryFile(suffix=".wav", delete=False).name
                subprocess.run(["ffmpeg", "-y", "-i", audio_tmp.name, "-ar", "16000", "-ac", "1", clean_audio], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

                out_video = tempfile.NamedTemporaryFile(suffix=".mp4", delete=False).name

                # Opsi A: Wav2Lip AI Neural Talking Head generator pada Colab GPU
                if os.path.exists("Wav2Lip/inference.py") and os.path.exists("Wav2Lip/checkpoints/wav2lip_gan.pth"):
                    print("[Colab Avatar] Memproses AI Talking Head bibir bergerak via Wav2Lip GPU...", flush=True)
                    env = os.environ.copy()
                    env["PYTHONPATH"] = f"Wav2Lip:{env.get('PYTHONPATH', '')}"
                    cmd = f"python3 Wav2Lip/inference.py --checkpoint_path Wav2Lip/checkpoints/wav2lip_gan.pth --face \"{img_tmp.name}\" --audio \"{clean_audio}\" --outfile \"{out_video}\" --nosmooth --pads 0 10 0 0 --resize_factor 1"
                    res = subprocess.run(cmd, shell=True, env=env, capture_output=True, text=True)
                    if res.returncode != 0:
                        print(f"[Colab Avatar] Wav2Lip Warning (code {res.returncode}): {res.stderr[:300]}", flush=True)

                # Opsi B: Precise Talking Mouth Open/Close Synthesis (OpenCV Morphological Mouth Movement)
                if not os.path.exists(out_video) or os.path.getsize(out_video) < 1000:
                    print("[Colab Avatar] Merender Talking Mouth Lipsync Video (Bibir terbuka-tertutup pas audio)...", flush=True)
                    anim_cmd = f"""python3 -c "
import cv2, numpy as np, wave

w = wave.open('{clean_audio}', 'rb')
fps, num_frames = 30, int(w.getnframes() / w.getframerate() * 30)
audio_data = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
w.close()

img = cv2.imread('{img_tmp.name}')
h, w_img = img.shape[:2]
fourcc = cv2.VideoWriter_fourcc(*'mp4v')
raw_v = '{out_video}.raw.mp4'
writer = cv2.VideoWriter(raw_v, fourcc, fps, (w_img, h))

# Define mouth region (lower-center 30% of face)
my1, my2 = int(h * 0.60), int(h * 0.88)
mx1, mx2 = int(w_img * 0.28), int(w_img * 0.72)
mouth_crop = img[my1:my2, mx1:mx2].copy()
mh, mw = mouth_crop.shape[:2]

chunk = len(audio_data) // max(1, num_frames)
for i in range(num_frames):
    sub = audio_data[i*chunk:(i+1)*chunk]
    vol = np.abs(sub).mean() if len(sub) > 0 else 0
    
    open_factor = min(0.35, vol / 60000.0)
    frame = img.copy()
    
    if open_factor > 0.03:
        shift = int(mh * open_factor)
        lower_lip = cv2.resize(mouth_crop[mh//2:, :], (mw, mh//2 + shift))
        frame[my1+mh//2:my1+mh//2+shift, mx1:mx2] = (15, 15, 15)
        frame[my1+mh//2+shift : min(h, my1+mh//2+shift+lower_lip.shape[0]), mx1:mx2] = lower_lip[:max(0, h - (my1+mh//2+shift)), :]
    
    writer.write(frame)
writer.release()
"
"""
                    subprocess.run(anim_cmd, shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    raw_v = f"{out_video}.raw.mp4"
                    if os.path.exists(raw_v):
                        subprocess.run([
                            "ffmpeg", "-y", "-i", raw_v, "-i", clean_audio,
                            "-c:v", "libx264", "-c:a", "aac", "-b:a", "192k",
                            "-pix_fmt", "yuv420p", "-shortest", out_video
                        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                        try: os.unlink(raw_v)
                        except: pass

                if os.path.exists(out_video) and os.path.getsize(out_video) > 500:
                    video_bytes = open(out_video, "rb").read()
                    for p in [img_tmp.name, audio_tmp.name, clean_audio, out_video]:
                        try: os.unlink(p)
                        except: pass

                    print(f"[Colab Avatar] SUKSES: Video Talking Avatar ({len(video_bytes)} bytes) siap dikirim!", flush=True)
                    self.send_response(200)
                    self.send_header("Content-Type", "video/mp4")
                    self.send_header("Content-Length", str(len(video_bytes)))
                    self.end_headers()
                    self.wfile.write(video_bytes)
                    return
            except Exception as avErr:
                print(f"[Colab Avatar] GAGAL generate video avatar: {avErr}", flush=True)
                traceback.print_exc()

            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Gagal menghasilkan video talking avatar."}).encode())
            return
        else:
            self.send_response(404)
            self.end_headers()


if __name__ == "__main__":
    print(f"[VoxCPM + Wav2Lip] Server siap di http://0.0.0.0:{PORT} (POST /tts, POST /lipsync)", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), VoxCPMHandler).serve_forever()
