#!/usr/bin/env python3
"""
transcribe.py — faster-whisper CLI wrapper.

Usage:
    python transcribe.py --model base --language auto --file audio.wav --output-json result.json

Outputs a JSON file compatible with the whisper.cpp format expected by
transcriptParser.ts:
{
  "segments": [
    {
      "words": [
        { "word": "Hello", "start": 0.0, "end": 0.5, "probability": 0.99 },
        ...
      ]
    }
  ]
}
"""

import argparse
import json
import sys
import os

def get_audio_duration(file_path):
    """Get audio duration in seconds using ffprobe."""
    try:
        import subprocess
        result = subprocess.run(
            ['ffprobe', '-v', 'quiet', '-print_format', 'json',
             '-show_format', file_path],
            capture_output=True, text=True, timeout=30
        )
        data = json.loads(result.stdout)
        return float(data['format']['duration'])
    except Exception:
        return 0.0

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model',       required=True, help='Model size: tiny/base/small/medium/large')
    parser.add_argument('--language',    default='auto', help='Language code or "auto"')
    parser.add_argument('--file',        required=True, help='Path to audio/video file')
    parser.add_argument('--output-json', required=True, help='Path to write JSON output')
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print('ERROR: faster-whisper is not installed. Run: pip install faster-whisper', file=sys.stderr)
        sys.exit(1)

    language = None if args.language in ('auto', 'automatic') else args.language

    print('whisper_print_progress_callback: progress = 5 %', file=sys.stderr, flush=True)

    # Load model (may download on first run)
    model = WhisperModel(args.model, device='cpu', compute_type='int8')

    print('whisper_print_progress_callback: progress = 20 %', file=sys.stderr, flush=True)

    # Get total duration for progress calculation
    total_duration = get_audio_duration(args.file)

    # Transcribe — iterate segment generator to emit live progress
    segments_out = []
    last_pct = 20

    segments_gen, info = model.transcribe(
        args.file,
        language=language,
        word_timestamps=True,
        vad_filter=True,
    )

    # Use info.duration if ffprobe failed
    if total_duration <= 0 and hasattr(info, 'duration') and info.duration:
        total_duration = info.duration

    for segment in segments_gen:
        words = []
        if segment.words:
            for w in segment.words:
                words.append({
                    'word':        w.word.strip(),
                    'start':       round(w.start, 3),
                    'end':         round(w.end, 3),
                    'probability': round(w.probability, 4),
                })
        segments_out.append({'words': words})

        # Emit progress based on how far through the audio we are (20–95%)
        if total_duration > 0:
            pct = 20 + int((segment.end / total_duration) * 75)
            pct = min(pct, 95)
        else:
            pct = min(last_pct + 2, 95)

        if pct > last_pct:
            print(f'whisper_print_progress_callback: progress = {pct} %',
                  file=sys.stderr, flush=True)
            last_pct = pct

    result = {'segments': segments_out, 'language': info.language if hasattr(info, 'language') else (language or 'auto')}

    with open(args.output_json, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False)

    print('whisper_print_progress_callback: progress = 100 %', file=sys.stderr, flush=True)
    print(f'Transcription complete: {len(segments_out)} segments', file=sys.stderr, flush=True)

if __name__ == '__main__':
    main()
