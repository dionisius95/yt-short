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

async def generate_tts_segments(segments, voice, tmp_dir, google_tts_key=None):
    """
    Generate TTS audio for each text segment.
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

        # Priority: Google Cloud TTS → gTTS → edge-tts
        if google_tts_key:
            success = await _google_tts(text, voice, mp3_path, google_tts_key)

        if not success:
            # gTTS: free, no API key, good quality for Indonesian
            success = await _gtts(text, voice, mp3_path)

        # Fallback to edge-tts
        if not success:
            success = await _edge_tts(text, voice, mp3_path)

        if success:
            results.append({
                'startMs': seg['startMs'],
                'endMs':   seg['endMs'],
                'path':    mp3_path,
                'text':    text,
            })
            print(f'TTS [{i+1}/{len(segments)}]: {text[:50]}', file=sys.stderr)
        else:
            print(f'TTS failed for segment {i}: {text[:40]}', file=sys.stderr)

    return results


async def _google_tts(text, voice_name, output_path, api_key):
    """Generate TTS using Google Cloud Text-to-Speech API."""
    import urllib.request

    # Map edge-tts voice names to Google Cloud voice names
    # e.g. 'id-ID-ArdiNeural' → language_code='id-ID', name='id-ID-Wavenet-B'
    google_voice_map = {
        'id-ID-ArdiNeural':    ('id-ID', 'id-ID-Wavenet-B', 'MALE'),
        'id-ID-GadisNeural':   ('id-ID', 'id-ID-Wavenet-A', 'FEMALE'),
        'en-US-GuyNeural':     ('en-US', 'en-US-Neural2-D', 'MALE'),
        'en-US-JennyNeural':   ('en-US', 'en-US-Neural2-F', 'FEMALE'),
        'ms-MY-OsmanNeural':   ('ms-MY', 'ms-MY-Wavenet-B', 'MALE'),
        'ms-MY-YasminNeural':  ('ms-MY', 'ms-MY-Wavenet-A', 'FEMALE'),
        'ja-JP-KeitaNeural':   ('ja-JP', 'ja-JP-Neural2-C', 'MALE'),
        'ja-JP-NanamiNeural':  ('ja-JP', 'ja-JP-Neural2-B', 'FEMALE'),
        'zh-CN-YunxiNeural':   ('zh-CN', 'cmn-CN-Wavenet-C', 'MALE'),
        'zh-CN-XiaoxiaoNeural':('zh-CN', 'cmn-CN-Wavenet-A', 'FEMALE'),
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


def group_words_into_segments(words, max_gap_ms=800, max_words=15):
    """
    Group transcript words into natural speech segments.
    Split at pauses > max_gap_ms or every max_words words.
    """
    if not words:
        return []

    segments = []
    current_words = [words[0]]

    for w in words[1:]:
        gap = w['startMs'] - current_words[-1]['endMs']
        if gap > max_gap_ms or len(current_words) >= max_words:
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
            ratio = max(0.5, min(2.0, ratio))
        else:
            ratio = 1.0

        stretched = os.path.join(tmp_dir, f'stretched_{i:04d}.wav')

        if abs(ratio - 1.0) < 0.05:
            # Close enough — no stretch needed
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
        filter_parts.append(f'[{i}]adelay={delay_ms}|{delay_ms}[tts{i}]')
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
        print(f'FFmpeg tts_track error: {result.stderr[-500:]}', file=sys.stderr)
        raise RuntimeError('Failed to build TTS track')

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
    parser.add_argument('--start',      type=float, default=0,
                        help='Clip start time in seconds')
    parser.add_argument('--end',        type=float, default=0,
                        help='Clip end time in seconds (0 = full video)')
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
        # Generate TTS
        print(f'Generating TTS with voice: {args.voice}', file=sys.stderr)
        tts_segs = asyncio.run(generate_tts_segments(
            segments, args.voice, tmp_dir,
            google_tts_key=getattr(args, 'google_tts_key', None)
        ))
        print(f'Generated {len(tts_segs)} TTS audio files', file=sys.stderr)

        # Build TTS track (all segments merged with correct timing)
        print('Building TTS track...', file=sys.stderr)
        tts_track = build_tts_track(tts_segs, clip_duration_ms, tmp_dir)

        # Build duck filter for original audio
        duck_filter = build_duck_filter(tts_segs, args.duck_db)
        print(f'Duck filter: {duck_filter[:80]}...', file=sys.stderr)

        # Final FFmpeg: video + ducked original audio + TTS track mixed
        # normalize=0 prevents amix from reducing volume
        # TTS boosted 3x, mix weight 1:4 (TTS strongly dominates during speech)
        filter_complex = (
            f'[0:a]{duck_filter}[ducked];'
            f'[1:a]volume=3.0[tts_boosted];'
            f'[ducked][tts_boosted]amix=inputs=2:duration=first:normalize=0:weights=1 4[aout]'
        )

        cmd = [
            'ffmpeg', '-y',
            '-ss', str(args.start),
            '-i', args.file,
            '-i', tts_track,
            '-t', str(clip_duration_ms / 1000),
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
