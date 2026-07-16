#!/usr/bin/env python3
"""
dub.py — AI dubbing: replace speech with TTS in target language,
         preserve background audio via volume ducking.

Pipeline:
  1. Generate TTS audio for each transcript segment (edge-tts)
  2. Build a silence-padded TTS track aligned to original timestamps
  3. Mix: duck original audio during TTS speech, restore during silence
  4. Merge dubbed audio back into video

Usage:
    python dub.py \
        --file video.mp4 \
        --transcript transcript.json \
        --output dubbed.mp4 \
        --voice id-ID-ArdiNeural \
        --duck-db -18 \
        --start 0 --end 60

transcript.json format:
    [{"word": "hello", "startMs": 0, "endMs": 500}, ...]
"""

import argparse
import asyncio
import json
import os
import sys
import tempfile
import subprocess
import shutil


# ---------------------------------------------------------------------------
# TTS generation
# ---------------------------------------------------------------------------

async def generate_tts_segments(
    segments, voice, tmp_dir, google_tts_key=None, gemini_api_key=None,
    vertex_access_token=None, vertex_project_id=None
):
    """
    Generate TTS audio for each text segment.
    Uses Gemini API on Vertex AI if vertex_access_token is provided.
    Falls back to Gemini AI Studio if gemini_api_key is provided.
    Uses Google Cloud TTS if api_key provided, falls back to edge-tts.
    Returns list of (startMs, endMs, wav_path).
    """
    results = []
    for i, seg in enumerate(segments):
        text = seg['text'].strip()
        if not text:
            continue

        mp3_path = os.path.join(tmp_dir, f'seg_{i:04d}.mp3')
        success = False

        # If it is a Gemini voice
        if voice.startswith('gemini-'):
            if vertex_access_token and vertex_project_id:
                success = await _gemini_tts(text, voice, mp3_path, vertex_access_token, vertex_project_id)
            elif gemini_api_key:
                success = await _gemini_tts_studio(text, voice, mp3_path, gemini_api_key)
            
            if not success:
                # Fallback to standard neural voice
                fallback_voice = 'id-ID-ArdiNeural' if 'Puck' in voice or 'male' in voice.lower() else 'id-ID-GadisNeural'
                print(f"Gemini TTS failed. Falling back to neural voice: {fallback_voice}", file=sys.stderr)
                success = await _edge_tts(text, fallback_voice, mp3_path)
        else:
            # Priority: Google Cloud TTS → edge-tts → gTTS
            if google_tts_key:
                success = await _google_tts(text, voice, mp3_path, google_tts_key)

            if not success:
                # edge-tts: supports gender, neural quality, free
                success = await _edge_tts(text, voice, mp3_path)

        # Fallback to gTTS
        if not success:
            success = await _gtts(text, voice, mp3_path)

        if success:
            results.append({
                'startMs': seg['startMs'],
                'endMs':   seg['endMs'],
                'path':    mp3_path,
                'text':    text,
            })
            print(f'TTS [{i+1}/{len(segments)}]: {text[:50]}', file=sys.stderr)
            if voice.startswith('gemini-') and i < len(segments) - 1:
                await asyncio.sleep(0.5)
        else:
            print(f'TTS failed for segment {i}: {text[:40]}', file=sys.stderr)

    return results


async def _gemini_tts(text, voice_name, output_path, access_token, project_id):
    """Generate TTS using Gemini 3.1 Flash TTS API on Vertex AI."""
    import urllib.request
    import json
    import base64
    import subprocess
    import sys

    # Map voice names
    gemini_voice = "Puck"
    if "Kore" in voice_name:
        gemini_voice = "Kore"

    system_instruction = "Synthesize speech for the performance defined below. Use a professional, energetic video commentator style. Always speak with a flawless native accent matching the language of the text (e.g., native American/British English accent if the text is in English, or native Indonesian accent if the text is in Indonesian)."
    prompt = f"{system_instruction}\n\n#### TRANSCRIPT\n{text}"

    payload = {
        "contents": [
            {
                "role": "user",
                "parts": [
                    {
                        "text": prompt
                    }
                ]
            }
        ],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {
                "voiceConfig": {
                    "prebuiltVoiceConfig": {
                        "voiceName": gemini_voice
                    }
                }
            }
        },
        "safetySettings": [
            { "category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE" },
            { "category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE" },
            { "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE" },
            { "category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE" }
        ]
    }

    max_attempts = 5
    for attempt in range(max_attempts):
        try:
            url = f"https://us-central1-aiplatform.googleapis.com/v1/projects/{project_id}/locations/us-central1/publishers/google/models/gemini-3.1-flash-tts-preview:generateContent"
            data = json.dumps(payload).encode('utf-8')
            req = urllib.request.Request(
                url, 
                data=data, 
                headers={
                    'Content-Type': 'application/json',
                    'Authorization': f'Bearer {access_token}'
                }
            )

            with urllib.request.urlopen(req, timeout=300) as resp:
                result = json.loads(resp.read())

            candidates = result.get('candidates', [])
            if not candidates:
                raise RuntimeError("No candidates in response")

            content = candidates[0].get('content', {})
            parts = content.get('parts', [])
            if not parts:
                raise RuntimeError("No parts in candidate content")

            audio_part = None
            for p in parts:
                if 'inlineData' in p and p['inlineData'].get('mimeType', '').startswith('audio/'):
                    audio_part = p
                    break

            if not audio_part:
                raise RuntimeError("No audio inlineData found in response parts")

            audio_base64 = audio_part['inlineData']['data']
            audio_bytes = base64.b64decode(audio_base64)
            mime_type = audio_part['inlineData'].get('mimeType', '').lower()

            if 'pcm' in mime_type or 'raw' in mime_type or 'l16' in mime_type:
                raw_path = output_path + ".raw"
                with open(raw_path, 'wb') as f:
                    f.write(audio_bytes)
                # Convert raw PCM (16-bit s16le, mono, 24000Hz) to MP3/WAV
                result_conv = subprocess.run([
                    'ffmpeg', '-y', '-f', 's16le', '-ar', '24000', '-ac', '1',
                    '-i', raw_path, output_path
                ], capture_output=True)
                try:
                    os.remove(raw_path)
                except:
                    pass
                if result_conv.returncode != 0:
                    raise RuntimeError("PCM conversion failed")
            else:
                with open(output_path, 'wb') as f:
                    f.write(audio_bytes)
            return True
        except Exception as e:
            print(f"Vertex Gemini TTS HTTP error: {e}", file=sys.stderr)
            if hasattr(e, 'read'):
                try:
                    err_body = e.read().decode('utf-8')
                    print(f"Vertex Gemini TTS error details: {err_body}", file=sys.stderr)
                except Exception:
                    pass
            is_rate_limit = False
            if hasattr(e, 'code') and e.code == 429:
                is_rate_limit = True
            elif '429' in str(e) or 'rate' in str(e).lower() or 'exhausted' in str(e).lower():
                is_rate_limit = True

            if attempt < max_attempts - 1:
                delay = 5.0 if is_rate_limit else (2.0 ** attempt)
                print(f"Retrying in {delay}s (attempt {attempt+1}/{max_attempts})...", file=sys.stderr)
                await asyncio.sleep(delay)
            else:
                return False


async def _gemini_tts_studio(text, voice_name, output_path, api_key):
    """Generate TTS using Gemini 3.1 Flash TTS API via Google AI Studio."""
    import urllib.request
    import json
    import base64
    import subprocess
    import sys

    # Map voice names
    gemini_voice = "Puck"
    if "Kore" in voice_name:
        gemini_voice = "Kore"

    system_instruction = "Synthesize speech for the performance defined below. Use a professional, energetic video commentator style. Always speak with a flawless native accent matching the language of the text (e.g., native American/British English accent if the text is in English, or native Indonesian accent if the text is in Indonesian)."
    prompt = f"{system_instruction}\n\n#### TRANSCRIPT\n{text}"

    payload = {
        "contents": [
            {
                "role": "user",
                "parts": [
                    {
                        "text": prompt
                    }
                ]
            }
        ],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {
                "voiceConfig": {
                    "prebuiltVoiceConfig": {
                        "voiceName": gemini_voice
                    }
                }
            }
        },
        "safetySettings": [
            { "category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE" },
            { "category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE" },
            { "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE" },
            { "category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE" }
        ]
    }

    max_attempts = 5
    for attempt in range(max_attempts):
        try:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-tts-preview:generateContent?key={api_key}"
            data = json.dumps(payload).encode('utf-8')
            req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'})

            with urllib.request.urlopen(req, timeout=300) as resp:
                result = json.loads(resp.read())

            candidates = result.get('candidates', [])
            if not candidates:
                raise RuntimeError("No candidates in response")

            content = candidates[0].get('content', {})
            parts = content.get('parts', [])
            if not parts:
                raise RuntimeError("No parts in candidate content")

            audio_part = None
            for p in parts:
                if 'inlineData' in p and p['inlineData'].get('mimeType', '').startswith('audio/'):
                    audio_part = p
                    break

            if not audio_part:
                raise RuntimeError("No audio inlineData found in response parts")

            audio_base64 = audio_part['inlineData']['data']
            audio_bytes = base64.b64decode(audio_base64)
            mime_type = audio_part['inlineData'].get('mimeType', '').lower()

            if 'pcm' in mime_type or 'raw' in mime_type or 'l16' in mime_type:
                raw_path = output_path + ".raw"
                with open(raw_path, 'wb') as f:
                    f.write(audio_bytes)
                # Convert raw PCM (16-bit s16le, mono, 24000Hz) to MP3/WAV
                result_conv = subprocess.run([
                    'ffmpeg', '-y', '-f', 's16le', '-ar', '24000', '-ac', '1',
                    '-i', raw_path, output_path
                ], capture_output=True)
                try:
                    os.remove(raw_path)
                except:
                    pass
                if result_conv.returncode != 0:
                    raise RuntimeError("PCM conversion failed")
            else:
                with open(output_path, 'wb') as f:
                    f.write(audio_bytes)
            return True
        except Exception as e:
            print(f"Gemini TTS HTTP error: {e}", file=sys.stderr)
            if hasattr(e, 'read'):
                try:
                    err_body = e.read().decode('utf-8')
                    print(f"Gemini TTS error details: {err_body}", file=sys.stderr)
                except Exception:
                    pass
            is_rate_limit = False
            if hasattr(e, 'code') and e.code == 429:
                is_rate_limit = True
            elif '429' in str(e) or 'rate' in str(e).lower() or 'exhausted' in str(e).lower():
                is_rate_limit = True

            if attempt < max_attempts - 1:
                delay = 5.0 if is_rate_limit else (2.0 ** attempt)
                print(f"Retrying in {delay}s (attempt {attempt+1}/{max_attempts})...", file=sys.stderr)
                await asyncio.sleep(delay)
            else:
                return False


async def _google_tts(text, voice_name, output_path, api_key):
    """Generate TTS using Google Cloud Text-to-Speech API."""
    import urllib.request

    # Map edge-tts voice names to Google Cloud voice names
    # e.g. 'id-ID-ArdiNeural' → language_code='id-ID', name='id-ID-Wavenet-B'
    google_voice_map = {
        'id-ID-ArdiNeural':    ('id-ID', 'id-ID-Neural2-B', 'MALE'),
        'id-ID-GadisNeural':   ('id-ID', 'id-ID-Neural2-A', 'FEMALE'),
        'en-US-GuyNeural':     ('en-US', 'en-US-Neural2-D', 'MALE'),
        'en-US-JennyNeural':   ('en-US', 'en-US-Neural2-F', 'FEMALE'),
        'ms-MY-OsmanNeural':   ('ms-MY', 'ms-MY-Wavenet-B', 'MALE'),
        'ms-MY-YasminNeural':  ('ms-MY', 'ms-MY-Wavenet-A', 'FEMALE'),
        'ja-JP-KeitaNeural':   ('ja-JP', 'ja-JP-Neural2-C', 'MALE'),
        'ja-JP-NanamiNeural':  ('ja-JP', 'ja-JP-Neural2-B', 'FEMALE'),
        'zh-CN-YunxiNeural':   ('zh-CN', 'cmn-CN-Wavenet-C', 'MALE'),
        'zh-CN-XiaoxiaoNeural':('zh-CN', 'cmn-CN-Wavenet-A', 'FEMALE'),
        
        # Explicit Google Neural2 selector IDs
        'google-id-ID-Neural2-B':    ('id-ID', 'id-ID-Neural2-B', 'MALE'),
        'google-id-ID-Neural2-C':    ('id-ID', 'id-ID-Neural2-C', 'MALE'),
        'google-id-ID-Neural2-A':    ('id-ID', 'id-ID-Neural2-A', 'FEMALE'),
        'google-en-US-Neural2-D':    ('en-US', 'en-US-Neural2-D', 'MALE'),
        'google-en-US-Neural2-F':    ('en-US', 'en-US-Neural2-F', 'FEMALE'),
        'google-ja-JP-Neural2-C':    ('ja-JP', 'ja-JP-Neural2-C', 'MALE'),
        'google-ja-JP-Neural2-B':    ('ja-JP', 'ja-JP-Neural2-B', 'FEMALE'),
    }

    voice_info = google_voice_map.get(voice_name)
    if not voice_info:
        # Auto-detect from voice name prefix
        parts = voice_name.split('-')
        if len(parts) >= 2:
            lang_code = f'{parts[0]}-{parts[1]}'
            ssml_gender = 'MALE' if 'Male' in voice_name or 'Ardi' in voice_name or 'Guy' in voice_name else 'FEMALE'
            voice_info = (lang_code, None, ssml_gender)
        else:
            return False

    lang_code, voice_name_google, ssml_gender = voice_info

    payload = {
        'input': {'text': text},
        'voice': {
            'languageCode': lang_code,
            'ssmlGender': ssml_gender,
        },
        'audioConfig': {
            'audioEncoding': 'MP3',
            'speakingRate': 1.0,
            'pitch': 0.0,
            'effectsProfileId': ['headphone-class-device'],
        },
    }

    if voice_name_google:
        payload['voice']['name'] = voice_name_google

    try:
        url = f'https://texttospeech.googleapis.com/v1/text:synthesize?key={api_key}'
        data = json.dumps(payload).encode('utf-8')
        req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'})

        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read())

        import base64
        audio_data = base64.b64decode(result['audioContent'])
        with open(output_path, 'wb') as f:
            f.write(audio_data)
        return True
    except Exception as e:
        print(f'Google TTS error: {e}', file=sys.stderr)
        return False


async def _edge_tts(text, voice, output_path):
    """Generate TTS using edge-tts (Microsoft Neural TTS, free)."""
    try:
        import edge_tts
        communicate = edge_tts.Communicate(text, voice)
        await communicate.save(output_path)
        return True
    except ImportError:
        print('edge-tts not installed. Run: pip install edge-tts', file=sys.stderr)
        return False
    except Exception as e:
        print(f'edge-tts error: {e}', file=sys.stderr)
        return False


def _gtts_sync(text, lang_code, output_path):
    """
    Generate TTS using gTTS (Google Translate TTS, free, no API key).
    Synchronous — called from async context via executor.
    lang_code: ISO 639-1 e.g. 'id', 'en', 'ja'
    """
    try:
        from gtts import gTTS
        tts = gTTS(text=text, lang=lang_code, slow=False)
        tts.save(output_path)
        return True
    except ImportError:
        print('gtts not installed. Run: pip install gtts', file=sys.stderr)
        return False
    except Exception as e:
        print(f'gTTS error: {e}', file=sys.stderr)
        return False


async def _gtts(text, voice_name, output_path):
    """
    Async wrapper for gTTS.
    Extracts language code from voice name: 'id-ID-ArdiNeural' → 'id'
    """
    import asyncio
    # Extract lang code from voice name prefix
    lang_code = voice_name.split('-')[0].lower() if voice_name else 'id'
    # gTTS lang code map for special cases
    lang_map = {'zh': 'zh-CN', 'pt': 'pt-BR'}
    lang_code = lang_map.get(lang_code, lang_code)

    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _gtts_sync, text, lang_code, output_path)


def group_words_into_segments(words, max_gap_ms=1000, max_words=45):
    """
    Group transcript words into natural speech segments.
    Split at sentence ends (. ? !), large pauses (> max_gap_ms), or max_words.
    """
    if not words:
        return []

    segments = []
    current_words = [words[0]]

    for w in words[1:]:
        prev = current_words[-1]
        gap = w['startMs'] - prev['endMs']
        
        # Check if previous word ends with sentence termination punctuation (. ? !)
        word_clean = prev['word'].strip()
        ends_sentence = word_clean and word_clean[-1] in ('.', '?', '!')

        if ends_sentence or gap > max_gap_ms or len(current_words) >= max_words:
            segments.append({
                'text':    ' '.join(cw['word'] for cw in current_words),
                'startMs': current_words[0]['startMs'],
                'endMs':   current_words[-1]['endMs'],
            })
            current_words = [w]
        else:
            current_words.append(w)

    if current_words:
        segments.append({
            'text':    ' '.join(cw['word'] for cw in current_words),
            'startMs': current_words[0]['startMs'],
            'endMs':   current_words[-1]['endMs'],
        })

    return segments


# ---------------------------------------------------------------------------
# Audio assembly
# ---------------------------------------------------------------------------

def get_audio_duration_ms(path):
    """Get duration of audio file in ms using ffprobe."""
    try:
        result = subprocess.run(
            ['ffprobe', '-v', 'quiet', '-print_format', 'json',
             '-show_streams', '-select_streams', 'a:0', path],
            capture_output=True, text=True, timeout=10
        )
        data = json.loads(result.stdout)
        dur = float(data['streams'][0].get('duration', 0))
        return int(dur * 1000)
    except Exception:
        return 0


def build_tts_track(tts_segments, total_duration_ms, tmp_dir, sample_rate=44100):
    """
    Build a single WAV file with TTS segments placed at correct timestamps.
    Each TTS segment is time-stretched to fit its original speech duration.
    Uses atempo filter (0.5x–2.0x range, chained for larger ratios).
    """
    if not tts_segments:
        silent = os.path.join(tmp_dir, 'silent.wav')
        subprocess.run([
            'ffmpeg', '-y', '-f', 'lavfi',
            '-i', f'anullsrc=r={sample_rate}:cl=stereo',
            '-t', str(total_duration_ms / 1000),
            silent
        ], capture_output=True)
        return silent

    stretched_files = []

    for i, seg in enumerate(tts_segments):
        tts_path = seg['path']
        target_duration_ms = seg['endMs'] - seg['startMs']

        # Get actual TTS duration
        tts_duration_ms = get_audio_duration_ms(tts_path)
        if tts_duration_ms <= 0:
            tts_duration_ms = target_duration_ms

        # Compute tempo ratio: >1 = speed up (TTS too long), <1 = slow down
        # Clamp to 0.5–2.0 range (atempo limit per filter)
        # Allow up to 10% overflow — don't stretch too aggressively
        if target_duration_ms > 0 and tts_duration_ms > 0:
            ratio = tts_duration_ms / target_duration_ms
            # Only speed up if TTS is longer than target (ratio > 1.0). Never slow down (ratio < 1.0).
            if ratio < 1.0:
                ratio = 1.0
            else:
                ratio = min(1.25, ratio)
        else:
            ratio = 1.0

        stretched = os.path.join(tmp_dir, f'stretched_{i:04d}.wav')

        if abs(ratio - 1.0) < 0.05:
            # Close enough — no stretch needed, but convert to standard WAV format
            result = subprocess.run([
                'ffmpeg', '-y', '-i', tts_path,
                '-ar', str(sample_rate),
                '-ac', '2',
                stretched
            ], capture_output=True, text=True)

            if result.returncode != 0:
                print(f'normalization failed for seg {i}, using original', file=sys.stderr)
                stretched = tts_path
        else:
            # atempo only accepts 0.5–2.0; chain for larger ratios
            if ratio > 2.0:
                atempo = f'atempo=2.0,atempo={ratio/2.0:.4f}'
            elif ratio < 0.5:
                atempo = f'atempo=0.5,atempo={ratio/0.5:.4f}'
            else:
                atempo = f'atempo={ratio:.4f}'

            result = subprocess.run([
                'ffmpeg', '-y', '-i', tts_path,
                '-af', atempo,
                '-ar', str(sample_rate),
                '-ac', '2',
                stretched
            ], capture_output=True, text=True)

            if result.returncode != 0:
                print(f'atempo failed for seg {i}, using original', file=sys.stderr)
                stretched = tts_path

        stretched_files.append({**seg, 'stretchedPath': stretched})

    # Build final track: delay each stretched segment to its start time
    inputs = []
    filter_parts = []
    labels = []

    for i, seg in enumerate(stretched_files):
        inputs.extend(['-i', seg['stretchedPath']])
        delay_ms = seg['startMs']
        label = f'[tts{i}]'
        filter_parts.append(f'[{i}]adelay={delay_ms}:all=1[tts{i}]')
        labels.append(label)

    # Mix all delayed TTS streams — normalize=0 preserves individual volumes
    mix_label = '[ttsout]'
    filter_parts.append(
        f"{''.join(labels)}amix=inputs={len(labels)}:duration=longest:normalize=0{mix_label}"
    )

    filter_complex = ';'.join(filter_parts)

    tts_track = os.path.join(tmp_dir, 'tts_track.wav')
    cmd = ['ffmpeg', '-y'] + inputs + [
        '-filter_complex', filter_complex,
        '-map', mix_label,
        '-t', str(total_duration_ms / 1000),
        '-ar', str(sample_rate),
        tts_track
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        err_msg = f'FFmpeg tts_track error: {result.stderr[-1000:]}'
        print(err_msg, file=sys.stderr)
        raise RuntimeError(f'Failed to build TTS track: {err_msg}')

    return tts_track


def build_duck_filter(tts_segments, duck_db=-18):
    """
    Build FFmpeg filter to duck original audio during TTS speech.
    Uses volume filter with enable expression.

    duck_db: how much to reduce original audio during TTS (e.g. -18dB)
    """
    if not tts_segments:
        return 'anull'

    # Build time ranges where TTS is active
    # Add 100ms padding before/after each segment for smooth ducking
    pad_ms = 100
    ranges = []
    for seg in tts_segments:
        start = max(0, (seg['startMs'] - pad_ms) / 1000)
        end = (seg['endMs'] + pad_ms) / 1000
        ranges.append((start, end))

    # Merge overlapping ranges
    merged = []
    for r in sorted(ranges):
        if merged and r[0] <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], r[1]))
        else:
            merged.append(list(r))

    # Build enable expression: between(t,start,end) OR between(t,...) ...
    duck_factor = 10 ** (duck_db / 20)  # dB to linear
    enable_expr = '+'.join(f'between(t,{s:.3f},{e:.3f})' for s, e in merged)

    # volume filter: duck when TTS active, normal otherwise
    return f"volume=enable='{enable_expr}':volume={duck_factor:.4f}"


def separate_vocals(video_path, tmp_dir):
    """
    Extracts the audio, separates vocals using audio-separator (UVR),
    and returns the instrumental track file path.
    """
    print("Running AI Vocal Separation (UVR MDX-Net)...", file=sys.stderr)
    input_wav = os.path.join(tmp_dir, "extracted_audio.wav")
    
    result = subprocess.run([
        'ffmpeg', '-y', '-i', video_path,
        '-vn', '-acodec', 'pcm_s16le', '-ar', '44100',
        input_wav
    ], capture_output=True, text=True)
    if result.returncode != 0:
        print(f"FFmpeg audio extraction failed: {result.stderr}", file=sys.stderr)
        return video_path

    try:
        from audio_separator.separator import Separator
        model_dir = os.environ.get("AUDIO_SEPARATOR_MODEL_DIR")
        if not model_dir:
            model_dir = os.path.join(os.path.expanduser("~"), ".audio-separator-models")
        os.makedirs(model_dir, exist_ok=True)
        separator = Separator(output_dir=tmp_dir, model_file_dir=model_dir)
        separator.load_model('UVR-MDX-NET-Inst_HQ_5.onnx')
        output_files = separator.separate(input_wav)
        
        instrumental_file = None
        for f in output_files:
            if "Instrumental" in f:
                instrumental_file = os.path.join(tmp_dir, f)
                break
                
        if instrumental_file and os.path.exists(instrumental_file):
            print(f"AI Vocal Separation successful: {instrumental_file}", file=sys.stderr)
            return instrumental_file
    except Exception as e:
        print(f"Vocal separation failed: {e}. Using original audio.", file=sys.stderr)

    return input_wav


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--file',       required=True,  help='Input video file')
    parser.add_argument('--transcript', required=True,  help='JSON transcript words array')
    parser.add_argument('--output',     required=True,  help='Output video file')
    parser.add_argument('--voice',      default='id-ID-ArdiNeural',
                        help='edge-tts voice name (default: id-ID-ArdiNeural)')
    parser.add_argument('--duck-db',    type=float, default=-30,
                        help='Original audio reduction during TTS in dB (default: -30)')
    parser.add_argument('--google-tts-key', default=None,
                        help='Google Cloud TTS API key (optional, falls back to gTTS then edge-tts)')
    parser.add_argument('--gemini-api-key', default=None,
                        help='Gemini API key for Gemini 3.1 Flash TTS')
    parser.add_argument('--vertex-access-token', default=None,
                        help='Vertex AI OAuth access token')
    parser.add_argument('--vertex-project-id', default=None,
                        help='Vertex AI GCP project ID')
    parser.add_argument('--start',      type=float, default=0,
                        help='Clip start time in seconds')
    parser.add_argument('--end',        type=float, default=0,
                        help='Clip end time in seconds (0 = full video)')
    parser.add_argument('--tts-track',          default=None,  help='Pre-generated TTS track WAV path')
    parser.add_argument('--output-transcript', default=None,  help='Save aligned JSON transcript to path')
    parser.add_argument('--output-tts-track',   default=None,  help='Save generated tts_track WAV to path')
    parser.add_argument('--only-tts',           action='store_true', help='Only generate TTS track and aligned transcript, do not mix/merge')
    args = parser.parse_args()

    # Load transcript
    with open(args.transcript, 'r', encoding='utf-8') as f:
        words = json.load(f)

    if not words:
        print('Empty transcript, copying video as-is', file=sys.stderr)
        shutil.copy2(args.file, args.output)
        return

    # Get video duration
    try:
        result = subprocess.run(
            ['ffprobe', '-v', 'quiet', '-print_format', 'json',
             '-show_format', args.file],
            capture_output=True, text=True, timeout=15
        )
        meta = json.loads(result.stdout)
        total_duration_ms = int(float(meta['format']['duration']) * 1000)
    except Exception:
        total_duration_ms = int((args.end - args.start) * 1000) if args.end > args.start else 60000

    clip_start_ms = int(args.start * 1000)
    clip_end_ms   = int(args.end * 1000) if args.end > 0 else total_duration_ms
    clip_duration_ms = clip_end_ms - clip_start_ms

    # Filter words to clip range, offset to clip-relative time
    clip_words = [
        {**w, 'startMs': w['startMs'] - clip_start_ms, 'endMs': w['endMs'] - clip_start_ms}
        for w in words
        if w['startMs'] >= clip_start_ms and w['endMs'] <= clip_end_ms
    ]

    if not clip_words:
        print('No words in clip range, copying video as-is', file=sys.stderr)
        shutil.copy2(args.file, args.output)
        return

    # Group into segments
    segments = group_words_into_segments(clip_words)
    print(f'Grouped into {len(segments)} TTS segments', file=sys.stderr)

    tmp_dir = tempfile.mkdtemp(prefix='dub_')
    try:
        if args.tts_track:
            print(f'Using pre-generated TTS track: {args.tts_track}', file=sys.stderr)
            tts_track = args.tts_track
            tts_segs = segments
        else:
            # Generate TTS
            print(f'Generating TTS with voice: {args.voice}', file=sys.stderr)
            tts_segs = asyncio.run(generate_tts_segments(
                segments, args.voice, tmp_dir,
                google_tts_key=getattr(args, 'google_tts_key', None),
                gemini_api_key=getattr(args, 'gemini_api_key', None),
                vertex_access_token=getattr(args, 'vertex_access_token', None),
                vertex_project_id=getattr(args, 'vertex_project_id', None)
            ))
            print(f'Generated {len(tts_segs)} TTS audio files', file=sys.stderr)

            # Build TTS track (all segments merged with correct timing)
            print('Building TTS track...', file=sys.stderr)
            tts_track = build_tts_track(tts_segs, clip_duration_ms, tmp_dir)

            if args.output_transcript:
                aligned_words = []
                for i, seg in enumerate(tts_segs):
                    seg_words = [
                        w for w in clip_words
                        if w['startMs'] >= seg['startMs'] and w['endMs'] <= seg['endMs']
                    ]
                    if not seg_words:
                        continue
                    
                    target_duration = seg['endMs'] - seg['startMs']
                    actual_duration = get_audio_duration_ms(seg['path'])
                    
                    if target_duration > 0 and actual_duration > 0:
                        ratio = actual_duration / target_duration
                        if ratio < 1.0:
                            scale = actual_duration / target_duration
                            for w in seg_words:
                                w_start = seg['startMs'] + (w['startMs'] - seg['startMs']) * scale
                                w_end = seg['startMs'] + (w['endMs'] - seg['startMs']) * scale
                                aligned_words.append({
                                    **w,
                                    'startMs': int(w_start + clip_start_ms),
                                    'endMs': int(w_end + clip_start_ms)
                                })
                        else:
                            for w in seg_words:
                                aligned_words.append({
                                    **w,
                                    'startMs': int(w['startMs'] + clip_start_ms),
                                    'endMs': int(w['endMs'] + clip_start_ms)
                                })
                    else:
                        for w in seg_words:
                            aligned_words.append({
                                **w,
                                'startMs': int(w['startMs'] + clip_start_ms),
                                'endMs': int(w['endMs'] + clip_start_ms)
                            })
                
                with open(args.output_transcript, 'w', encoding='utf-8') as f:
                    json.dump(aligned_words, f, ensure_ascii=False, indent=2)
                print(f'Saved aligned transcript: {args.output_transcript}', file=sys.stderr)

            if args.output_tts_track:
                shutil.copy2(tts_track, args.output_tts_track)
                print(f'Saved TTS track: {args.output_tts_track}', file=sys.stderr)

        if args.only_tts:
            print('Only TTS generation requested. Exiting successfully.', file=sys.stderr)
            return

        # Check if we should remove vocals
        remove_vocals = (args.duck_db == -999)

        if remove_vocals:
            # Separate vocals
            bg_audio_track = separate_vocals(args.file, tmp_dir)
            # Constant -12dB volume for background instrumental
            duck_filter = "volume=0.2512"
            print("Background audio is separated instrumental at constant -12dB", file=sys.stderr)
        else:
            duck_filter = build_duck_filter(tts_segs, args.duck_db)
            print(f'Duck filter: {duck_filter[:80]}...', file=sys.stderr)

        # Final FFmpeg: video + ducked original audio + TTS track mixed
        # normalize=0 prevents amix from reducing volume
        # TTS boosted 3x, mix weight 1:4 (TTS strongly dominates during speech)
        actual_duration_sec = clip_duration_ms / 1000
        if args.voice.startswith('gemini-') and not args.tts_track:
            actual_duration_sec = get_audio_duration_ms(tts_track) / 1000

        tts_volume = 1.5

        if remove_vocals:
            filter_complex = (
                f'[2:a]{duck_filter}[ducked];'
                f'[1:a]volume={tts_volume}[tts_boosted];'
                f'[ducked][tts_boosted]amix=inputs=2:duration=first:normalize=0:weights=1 1[aout]'
            )
            cmd = [
                'ffmpeg', '-y',
                '-ss', str(args.start),
                '-i', args.file,
                '-i', tts_track,
                '-ss', str(args.start),
                '-i', bg_audio_track,
                '-t', str(actual_duration_sec),
                '-filter_complex', filter_complex,
                '-map', '0:v',
                '-map', '[aout]',
                '-c:v', 'copy',
                '-c:a', 'aac', '-b:a', '192k',
                '-movflags', '+faststart',
                args.output,
            ]
        else:
            filter_complex = (
                f'[0:a]{duck_filter}[ducked];'
                f'[1:a]volume={tts_volume}[tts_boosted];'
                f'[ducked][tts_boosted]amix=inputs=2:duration=first:normalize=0:weights=1 1[aout]'
            )
            cmd = [
                'ffmpeg', '-y',
                '-ss', str(args.start),
                '-i', args.file,
                '-i', tts_track,
                '-t', str(actual_duration_sec),
                '-filter_complex', filter_complex,
                '-map', '0:v',
                '-map', '[aout]',
                '-c:v', 'copy',
                '-c:a', 'aac', '-b:a', '192k',
                '-movflags', '+faststart',
                args.output,
            ]

        print('Merging video + dubbed audio...', file=sys.stderr)
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if result.returncode != 0:
            print(f'FFmpeg merge error: {result.stderr[-800:]}', file=sys.stderr)
            raise RuntimeError('Failed to merge dubbed audio')

        print(f'Dubbing complete: {args.output}', file=sys.stderr)

    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


if __name__ == '__main__':
    main()
