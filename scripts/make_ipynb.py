import json, os

py_code = open('resources/PippitLokal_VoxCPM_Colab.py', 'r', encoding='utf-8').read()

nb = {
  'cells': [
    {
      'cell_type': 'markdown',
      'metadata': {},
      'source': [
        '# 🎙️ Server VoxCPM + Wav2Lip AI Talking Avatar untuk PippitLokal (GPU Gratis)\n',
        '\n',
        'Jalankan **Runtime → Change runtime type → T4 GPU**, lalu **Runtime → Run all**.\n',
        'Tunggu sampai muncul **URL SERVER** (…trycloudflare.com), salin ke menu Settings PippitLokal.\n'
      ]
    },
    {
      'cell_type': 'markdown',
      'metadata': {},
      'source': ['### 1) Install Dependensi & Model Wav2Lip AI Talking Avatar']
    },
    {
      'cell_type': 'code',
      'execution_count': None,
      'metadata': {},
      'outputs': [],
      'source': [
        '!pip -q install voxcpm soundfile librosa opencv-python face-alignment\n',
        '!git clone https://github.com/rudrabha/Wav2Lip.git\n',
        '!mkdir -p Wav2Lip/checkpoints ~/.cache/torch/hub/checkpoints\n',
        '!wget -q https://github.com/rudrabha/Wav2Lip/releases/download/v1.0/wav2lip_gan.pth -O Wav2Lip/checkpoints/wav2lip_gan.pth\n',
        '!wget -q https://www.adrianbulat.com/downloads/python-fan/s3fd-619a3168.pth -O ~/.cache/torch/hub/checkpoints/s3fd-619a3168.pth\n'
      ]
    },
    {
      'cell_type': 'markdown',
      'metadata': {},
      'source': ['### 2) Tulis File Server VoxCPM + Wav2Lip']
    },
    {
      'cell_type': 'code',
      'execution_count': None,
      'metadata': {},
      'outputs': [],
      'source': ['%%writefile voxcpm_server.py\n'] + [line + '\n' for line in py_code.splitlines()]
    },
    {
      'cell_type': 'markdown',
      'metadata': {},
      'source': ['### 3) Jalankan Server + Cloudflare Tunnel (URL Publik)']
    },
    {
      'cell_type': 'code',
      'execution_count': None,
      'metadata': {},
      'outputs': [],
      'source': [
        'import os, subprocess, time, re, urllib.request, http.client\n',
        '\n',
        'os.environ["VOXCPM_MODEL"]  = os.environ.get("VOXCPM_MODEL", "openbmb/VoxCPM2")\n',
        'os.environ["VOXCPM_DEVICE"] = os.environ.get("VOXCPM_DEVICE", "auto")\n',
        'os.environ["VOXCPM_PORT"]   = "8081"\n',
        '\n',
        'if not os.path.exists("cloudflared"):\n',
        '    urllib.request.urlretrieve("https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64", "cloudflared")\n',
        '    os.chmod("cloudflared", 0o755)\n',
        '\n',
        'p_srv = subprocess.Popen(["python3", "voxcpm_server.py"])\n',
        'print("Memuat model VoxCPM + Wav2Lip & menunggu server (maks ~2 menit) ...", flush=True)\n',
        'for _ in range(240):\n',
        '    try:\n',
        '        conn = http.client.HTTPConnection("127.0.0.1", 8081, timeout=2)\n',
        '        conn.request("GET", "/health")\n',
        '        r = conn.getresponse()\n',
        '        if r.status == 200:\n',
        '            print("Server SIAP! Membuka Cloudflare Tunnel...", flush=True)\n',
        '            break\n',
        '    except:\n',
        '        pass\n',
        '    time.sleep(3)\n',
        '\n',
        'p_cf = subprocess.Popen(["./cloudflared", "tunnel", "--url", "http://127.0.0.1:8081"], stderr=subprocess.PIPE, text=True)\n',
        'url_found = False\n',
        'for line in p_cf.stderr:\n',
        '    m = re.search(r"https://[a-zA-Z0-9-]+\\.trycloudflare\\.com", line)\n',
        '    if m:\n',
        '        cf_url = m.group(0)\n',
        '        print("\\n" + "="*60)\n',
        '        print("   URL SERVER VOXCPM + WAV2LIP AI TALKING AVATAR:")\n',
        '        print(f"   {cf_url}")\n',
        '        print("="*60 + "\\n", flush=True)\n',
        '        url_found = True\n',
        '        break\n',
        'p_srv.wait()\n'
      ]
    }
  ],
  'metadata': {
    'colab': {'provenance': []},
    'language_info': {'name': 'python'}
  },
  'nbformat': 4,
  'nbformat_minor': 0
}

with open('resources/PippitLokal_VoxCPM_Colab.ipynb', 'w', encoding='utf-8') as f:
    json.dump(nb, f, indent=2, ensure_ascii=False)

print('SUKSES update PippitLokal_VoxCPM_Colab.ipynb!')
