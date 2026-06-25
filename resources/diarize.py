#!/usr/bin/env python3
"""
diarize.py — pyannote.audio speaker diarization wrapper.

Usage:
    python diarize.py --file audio.wav --token HF_TOKEN --max-speakers 4 --output result.json

Requires:
    pip install pyannote.audio

Output JSON:
{
  "segments": [
    {"speaker": "SPEAKER_00", "start": 0.5, "end": 3.2},
    ...
  ]
}
"""

import argparse
import json
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--file',         required=True,  help='Path to audio/video file')
    parser.add_argument('--token',        required=True,  help='HuggingFace access token')
    parser.add_argument('--max-speakers', type=int, default=4, help='Max number of speakers')
    parser.add_argument('--output',       required=True,  help='Output JSON path')
    args = parser.parse_args()

    try:
        from pyannote.audio import Pipeline
    except ImportError:
        print('ERROR: pyannote.audio not installed. Run: pip install pyannote.audio', file=sys.stderr)
        sys.exit(1)

    print('Loading pyannote pipeline...', file=sys.stderr, flush=True)

    try:
        pipeline = Pipeline.from_pretrained(
            'pyannote/speaker-diarization-3.1',
            use_auth_token=args.token,
        )
    except Exception as e:
        print(f'ERROR: Failed to load pyannote pipeline: {e}', file=sys.stderr)
        sys.exit(1)

    print('Running diarization...', file=sys.stderr, flush=True)

    try:
        diarization = pipeline(
            args.file,
            max_speakers=args.max_speakers,
        )
    except Exception as e:
        print(f'ERROR: Diarization failed: {e}', file=sys.stderr)
        sys.exit(1)

    segments = []
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        segments.append({
            'speaker': speaker,
            'start':   round(turn.start, 3),
            'end':     round(turn.end,   3),
        })

    result = {'segments': segments}

    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False)

    print(f'Diarization complete: {len(segments)} segments', file=sys.stderr, flush=True)


if __name__ == '__main__':
    main()
