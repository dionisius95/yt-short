#!/usr/bin/env python3
"""
active_speaker_track.py — Active speaker tracking for auto-crop.

Combines:
  1. Speaker diarization (energy-based via FFmpeg silencedetect, or pyannote if token given)
  2. Face detection (OpenCV Haar cascade + upper body fallback)
  3. Speaker-face assignment (left/right position heuristic)

Result: per-frame crop positions that follow the ACTIVE SPEAKER.
When two speakers overlap → crop to center between them (or split screen mode).

Usage:
    python active_speaker_track.py \
        --file video.mp4 --start 10.5 --end 45.2 --output crop.json \
        [--hf-token TOKEN] [--split-screen] [--samples 30]

Output JSON:
{
  "frames": [
    {"frameIndex": 0, "timestampMs": 10500, "cx": 640, "cy": 400,
     "hasFace": true, "faceSpanW": 0, "activeSpeaker": "SPEAKER_00"},
    ...
  ],
  "avgCx": 640, "avgCy": 400, "width": 1920, "height": 1080,
  "speakerFaces": {"SPEAKER_00": {"avgCx": 480}, "SPEAKER_01": {"avgCx": 1440}},
  "splitScreen": false
}
"""

import argparse
import json
import sys
import os
import subprocess
import tempfile


# ---------------------------------------------------------------------------
# Diarization (energy-based, no ML needed)
# ---------------------------------------------------------------------------

def detect_silences_ffmpeg(file_path, noise_db=-30, min_duration=0.4, start_sec=None, end_sec=None):
    """Use FFmpeg silencedetect to find silence boundaries."""
    try:
        cmd = ['ffmpeg']
        if start_sec is not None:
            cmd += ['-ss', str(start_sec)]
        cmd += ['-i', file_path]
        if end_sec is not None and start_sec is not None:
            cmd += ['-t', str(end_sec - start_sec)]
        cmd += ['-af', f'silencedetect=noise={noise_db}dB:d={min_duration}',
                '-f', 'null', '-']
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        stderr = result.stderr
    except Exception as e:
        print(f'FFmpeg silencedetect failed: {e}', file=sys.stderr)
        return []

    import re
    starts = [float(m) for m in re.findall(r'silence_start: (\d+\.?\d*)', stderr)]
    ends   = [float(m) for m in re.findall(r'silence_end: (\d+\.?\d*)', stderr)]

    # Adjust timestamps back to absolute if we used -ss offset
    offset = start_sec or 0
    silences = []
    for s, e in zip(starts, ends):
        silences.append({'start': s + offset, 'end': e + offset})
    return silences


def energy_diarize(file_path, start_sec, end_sec):
    """
    Simple energy-based diarization.
    Returns list of {speakerId, startSec, endSec}.
    Alternates speakers at pauses > 1.0s.
    """
    silences = detect_silences_ffmpeg(file_path, start_sec=start_sec, end_sec=end_sec)

    # Filter to clip range
    silences = [s for s in silences if s['end'] > start_sec and s['start'] < end_sec]

    if not silences:
        return [{'speakerId': 'SPEAKER_00', 'startSec': start_sec, 'endSec': end_sec}]

    segments = []
    cursor = start_sec
    current_speaker = 0

    for silence in sorted(silences, key=lambda x: x['start']):
        s_start = max(silence['start'], start_sec)
        s_end   = min(silence['end'],   end_sec)

        if s_start > cursor + 0.1:
            segments.append({
                'speakerId': f'SPEAKER_0{current_speaker}',
                'startSec': cursor,
                'endSec': s_start,
            })

        # Switch speaker at pauses > 1.0s
        if (s_end - s_start) > 1.0:
            current_speaker = 1 - current_speaker

        cursor = s_end

    if cursor < end_sec:
        segments.append({
            'speakerId': f'SPEAKER_0{current_speaker}',
            'startSec': cursor,
            'endSec': end_sec,
        })

    return segments


def pyannote_diarize(file_path, hf_token, start_sec, end_sec):
    """Run pyannote diarization if token available."""
    try:
        from pyannote.audio import Pipeline
        pipeline = Pipeline.from_pretrained(
            'pyannote/speaker-diarization-3.1',
            use_auth_token=hf_token,
        )
        diarization = pipeline(file_path)
        segments = []
        for turn, _, speaker in diarization.itertracks(yield_label=True):
            if turn.end < start_sec or turn.start > end_sec:
                continue
            segments.append({
                'speakerId': speaker,
                'startSec': max(turn.start, start_sec),
                'endSec':   min(turn.end,   end_sec),
            })
        return segments
    except Exception as e:
        print(f'pyannote failed: {e}, using energy fallback', file=sys.stderr)
        return None


def get_active_speaker(segments, timestamp_sec):
    """Return speakerId active at timestamp_sec, or None."""
    for seg in segments:
        if seg['startSec'] <= timestamp_sec <= seg['endSec']:
            return seg['speakerId']
    return None


# ---------------------------------------------------------------------------
# Face detection (same as detect_faces.py)
# ---------------------------------------------------------------------------

def detect_faces_at_frame(frame_small, face_cascade, body_cascade, scale, width, height, mp_detector=None):
    """Detect faces/bodies in a scaled frame. Returns list of (x,y,w,h) in original res."""

    # ── Primary: MediaPipe Face Detector (Tasks API, auto-range) ──────────
    if mp_detector is not None:
        try:
            import mediapipe as mp
            import numpy as np
            frame_rgb = frame_small[:, :, ::-1] if frame_small.shape[2] == 3 else frame_small
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(frame_rgb))

            if isinstance(mp_detector, tuple):
                det_full, det_short = mp_detector
                faces_full = []
                if det_full:
                    r = det_full.detect(mp_image)
                    faces_full = [(d.bounding_box.origin_x, d.bounding_box.origin_y,
                                   d.bounding_box.width, d.bounding_box.height)
                                  for d in (r.detections or [])]
                # Run short-range too and UNION results (better recall)
                faces_short = []
                if det_short:
                    r2 = det_short.detect(mp_image)
                    faces_short = [(d.bounding_box.origin_x, d.bounding_box.origin_y,
                                    d.bounding_box.width, d.bounding_box.height)
                                   for d in (r2.detections or [])]
                all_faces = faces_full + faces_short
            else:
                r = mp_detector.detect(mp_image)
                all_faces = [(d.bounding_box.origin_x, d.bounding_box.origin_y,
                              d.bounding_box.width, d.bounding_box.height)
                             for d in (r.detections or [])]

            if all_faces:
                faces_orig = []
                for (bx, by, bw, bh) in all_faces:
                    x = max(0, int(bx / scale)); y = max(0, int(by / scale))
                    w = min(int(bw / scale), width - x); h = min(int(bh / scale), height - y)
                    if w > 10 and h > 10:
                        faces_orig.append((x, y, w, h))
                if faces_orig:
                    return faces_orig, 'face'
        except Exception:
            pass  # Fall through to OpenCV

    # ── Fallback: OpenCV Haar Cascade ─────────────────────────────────────
    try:
        import cv2
        gray = cv2.cvtColor(frame_small, cv2.COLOR_BGR2GRAY)
    except Exception:
        return [], 'none'

    faces = face_cascade.detectMultiScale(
        gray, scaleFactor=1.08, minNeighbors=3, minSize=(25, 25)
    )
    if len(faces) > 0:
        return [(int(x/scale), int(y/scale), int(w/scale), int(h/scale))
                for (x, y, w, h) in faces], 'face'

    if body_cascade is not None:
        bodies = body_cascade.detectMultiScale(
            gray, scaleFactor=1.1, minNeighbors=2, minSize=(40, 60)
        )
        if len(bodies) > 0:
            return [(int(x/scale), int(y/scale), int(w/scale), int(h/scale))
                    for (x, y, w, h) in bodies], 'body'

    return [], 'none'


# ---------------------------------------------------------------------------
# Speaker-face assignment
# ---------------------------------------------------------------------------

def assign_speaker_to_face(faces, speaker_face_map, width):
    """
    Assign each face to a speaker based on horizontal position.
    speaker_face_map: {speakerId: avgCx} built from first few frames.
    Returns {speakerId: (cx, cy)} for this frame.
    """
    if not faces or not speaker_face_map:
        return {}

    result = {}
    used_faces = set()

    # Sort speakers by their known avgCx
    sorted_speakers = sorted(speaker_face_map.items(), key=lambda x: x[1])
    # Sort faces by cx
    sorted_faces = sorted(enumerate(faces), key=lambda x: x[1][0] + x[1][2]//2)

    for i, (spk_id, _) in enumerate(sorted_speakers):
        if i < len(sorted_faces):
            face_idx, (fx, fy, fw, fh) = sorted_faces[i]
            if face_idx not in used_faces:
                used_faces.add(face_idx)
                result[spk_id] = (fx + fw//2, fy + fh//2)

    return result


def build_speaker_face_map(cap, sample_times, face_cascade, body_cascade, width, height, n_calibration=5, mp_detector=None):
    """
    Sample first n_calibration frames to build speaker→face position map.
    Assumes speakers are spatially consistent (left/right).
    Returns {speakerId: avgCx} — just positional ordering, not true ID.
    """
    import cv2

    all_face_cxs = []

    for t in sample_times[:n_calibration]:
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
        ret, frame = cap.read()
        if not ret:
            continue

        scale = min(1.0, 480 / width)
        small = cv2.resize(frame, (int(width * scale), int(height * scale)))
        faces, _ = detect_faces_at_frame(small, face_cascade, body_cascade, scale, width, height,
                                          mp_detector)

        for (fx, fy, fw, fh) in faces:
            all_face_cxs.append(fx + fw//2)

    if not all_face_cxs:
        return {}

    # Cluster face positions into speakers using simple k-means-like split
    all_face_cxs.sort()
    n_faces = len(all_face_cxs)

    if n_faces == 0:
        return {}
    elif n_faces == 1 or max(all_face_cxs) - min(all_face_cxs) < width * 0.2:
        # Single cluster → one speaker
        return {'SPEAKER_00': int(sum(all_face_cxs) / len(all_face_cxs))}
    else:
        # Two clusters: split at largest gap
        gaps = [(all_face_cxs[i+1] - all_face_cxs[i], i) for i in range(len(all_face_cxs)-1)]
        split_idx = max(gaps, key=lambda x: x[0])[1] + 1
        left_cxs  = all_face_cxs[:split_idx]
        right_cxs = all_face_cxs[split_idx:]
        return {
            'SPEAKER_00': int(sum(left_cxs)  / len(left_cxs)),
            'SPEAKER_01': int(sum(right_cxs) / len(right_cxs)),
        }


# ---------------------------------------------------------------------------
# Smoothing (same adaptive EMA as detect_faces.py)
# ---------------------------------------------------------------------------

def smooth_positions(positions, has_face_list, alpha_track=0.3, alpha_snap=0.85):
    if not positions:
        return positions
    smoothed = [positions[0]]
    for i in range(1, len(positions)):
        prev = smoothed[-1]
        curr = positions[i]
        prev_had = has_face_list[i-1] if i > 0 else False
        curr_has = has_face_list[i]
        if curr_has and not prev_had:
            alpha = alpha_snap
        elif curr_has and prev_had:
            alpha = alpha_track
        else:
            alpha = 1.0
        s = (alpha * curr[0] + (1-alpha) * prev[0],
             alpha * curr[1] + (1-alpha) * prev[1])
        smoothed.append(s)
    return smoothed


def interpolate_missing(positions, has_face_list):
    n = len(positions)
    result = list(positions)
    i = 0
    while i < n:
        if not has_face_list[i]:
            gap_start = i
            prev_pos = result[gap_start-1] if gap_start > 0 else None
            prev_had = has_face_list[gap_start-1] if gap_start > 0 else False
            gap_end = i
            while gap_end < n and not has_face_list[gap_end]:
                gap_end += 1
            next_pos = result[gap_end] if gap_end < n else None
            next_has = gap_end < n
            gap_len = gap_end - gap_start
            for j in range(gap_start, gap_end):
                if prev_had and next_has:
                    t = (j - gap_start + 1) / (gap_len + 1)
                    result[j] = (
                        prev_pos[0] + t * (next_pos[0] - prev_pos[0]),
                        prev_pos[1] + t * (next_pos[1] - prev_pos[1]),
                    )
                elif next_has:
                    result[j] = next_pos
                elif prev_had:
                    result[j] = prev_pos
            i = gap_end
        else:
            i += 1
    return result


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--file',         required=True)
    parser.add_argument('--start',        type=float, required=True)
    parser.add_argument('--end',          type=float, required=True)
    parser.add_argument('--output',       required=True)
    parser.add_argument('--samples',      type=int, default=30)
    parser.add_argument('--hf-token',     default=None)
    parser.add_argument('--split-screen', action='store_true',
                        help='Enable split-screen mode when two speakers overlap')
    args = parser.parse_args()

    try:
        import cv2
    except ImportError:
        print('OpenCV not available', file=sys.stderr)
        _write_fallback(args.output)
        return

    duration = args.end - args.start
    if duration <= 0:
        _write_fallback(args.output)
        return

    # ── Load cascades ──────────────────────────────────────────────────────
    face_cascade_path = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
    body_cascade_path = cv2.data.haarcascades + 'haarcascade_upperbody.xml'
    face_cascade = cv2.CascadeClassifier(face_cascade_path)
    body_cascade = cv2.CascadeClassifier(body_cascade_path) if os.path.exists(body_cascade_path) else None

    # ── Initialize MediaPipe Face Detectors (full-range + short-range) ────
    mp_detector_full  = None
    mp_detector_short = None
    try:
        import mediapipe as mp
        from mediapipe.tasks import python as mp_python
        from mediapipe.tasks.python import vision as mp_vision

        script_dir = os.path.dirname(os.path.abspath(__file__))
        model_full  = os.path.join(script_dir, 'blaze_face_full_range.tflite')
        model_short = os.path.join(script_dir, 'blaze_face_short_range.tflite')

        def _make_det(path):
            return mp_vision.FaceDetector.create_from_options(
                mp_vision.FaceDetectorOptions(
                    base_options=mp_python.BaseOptions(model_asset_path=path),
                    running_mode=mp_vision.RunningMode.IMAGE,
                    min_detection_confidence=0.25,
                )
            )

        if os.path.exists(model_full):
            mp_detector_full = _make_det(model_full)
        if os.path.exists(model_short):
            mp_detector_short = _make_det(model_short)

        if mp_detector_full or mp_detector_short:
            print('MediaPipe Face Detectors initialized (speaker mode)', file=sys.stderr)
    except Exception as e:
        print(f'MediaPipe not available ({e}), using OpenCV', file=sys.stderr)
        mp_detector_full = mp_detector_short = None
    if not os.path.exists(face_cascade_path):
        _write_fallback(args.output)
        return

    # ── Open video ─────────────────────────────────────────────────────────
    cap = cv2.VideoCapture(args.file)
    if not cap.isOpened():
        _write_fallback(args.output)
        return

    width  = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))  or 1920
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 1080

    n_samples = max(args.samples, int(duration))
    sample_times = [
        args.start + (i / max(n_samples - 1, 1)) * duration
        for i in range(n_samples)
    ]

    # ── Diarization ────────────────────────────────────────────────────────
    print('Running diarization...', file=sys.stderr)
    if args.hf_token:
        diar_segments = pyannote_diarize(args.file, args.hf_token, args.start, args.end)
        if diar_segments is None:
            diar_segments = energy_diarize(args.file, args.start, args.end)
    else:
        diar_segments = energy_diarize(args.file, args.start, args.end)

    speaker_ids = list({s['speakerId'] for s in diar_segments})
    print(f'Diarization: {len(diar_segments)} segments, {len(speaker_ids)} speakers', file=sys.stderr)

    # ── Build speaker→face position map ───────────────────────────────────
    print('Calibrating speaker positions...', file=sys.stderr)
    speaker_face_map = build_speaker_face_map(
        cap, sample_times, face_cascade, body_cascade, width, height,
        n_calibration=min(8, len(sample_times)),
        mp_detector=(mp_detector_full, mp_detector_short) if (mp_detector_full or mp_detector_short) else None
    )
    print(f'Speaker face map: {speaker_face_map}', file=sys.stderr)

    # ── Per-frame tracking ─────────────────────────────────────────────────
    raw_positions = []
    has_face_list = []
    active_speakers = []
    face_span_list = []

    for t in sample_times:
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
        ret, frame = cap.read()

        active_spk = get_active_speaker(diar_segments, t)
        active_speakers.append(active_spk)

        if not ret:
            raw_positions.append((width // 2, height // 3))
            has_face_list.append(False)
            face_span_list.append(0)
            continue

        scale = min(1.0, 480 / width)
        small = cv2.resize(frame, (int(width * scale), int(height * scale)))
        faces, _ = detect_faces_at_frame(small, face_cascade, body_cascade, scale, width, height,
                                          (mp_detector_full, mp_detector_short) if (mp_detector_full or mp_detector_short) else None)

        if not faces:
            raw_positions.append((width // 2, height // 3))
            has_face_list.append(False)
            face_span_list.append(0)
            continue

        # Assign faces to speakers
        spk_face = assign_speaker_to_face(faces, speaker_face_map, width)

        if active_spk and active_spk in spk_face:
            # Track active speaker's face
            cx, cy = spk_face[active_spk]
            raw_positions.append((cx, cy))
            has_face_list.append(True)
            face_span_list.append(0)

        elif len(faces) >= 2 and args.split_screen:
            # Two faces, split screen mode → center between them
            min_x = min(fx for (fx, fy, fw, fh) in faces)
            max_x = max(fx + fw for (fx, fy, fw, fh) in faces)
            cx = (min_x + max_x) // 2
            cy = sum(fy + fh//2 for (fx, fy, fw, fh) in faces) // len(faces)
            span_w = max_x - min_x
            raw_positions.append((cx, cy))
            has_face_list.append(True)
            face_span_list.append(span_w)

        elif faces:
            # Fallback: if we know where each speaker is, pick the face closest
            # to the active speaker's expected position (or any known speaker).
            # This avoids tracking the wrong person when diarization loses sync.
            best_face = None
            if speaker_face_map:
                # Pick the face closest to any known speaker position
                best_dist = float('inf')
                for (fx, fy, fw, fh) in faces:
                    face_cx = fx + fw // 2
                    for spk_cx in speaker_face_map.values():
                        dist = abs(face_cx - spk_cx)
                        if dist < best_dist:
                            best_dist = dist
                            best_face = (fx, fy, fw, fh)
            if best_face is None:
                # Last resort: largest face (most prominent person)
                best_face = max(faces, key=lambda f: f[2] * f[3])
            fx, fy, fw, fh = best_face
            raw_positions.append((fx + fw//2, fy + fh//2))
            has_face_list.append(True)
            face_span_list.append(0)
        else:
            raw_positions.append((width // 2, height // 3))
            has_face_list.append(False)
            face_span_list.append(0)

    cap.release()

    # ── Smooth ────────────────────────────────────────────────────────────
    # ── Global-average fallback for no-face frames (avoid center crop) ─────
    detected_idx = [i for i, h in enumerate(has_face_list) if h]
    if detected_idx:
        avg_face_cx = int(sum(raw_positions[i][0] for i in detected_idx) / len(detected_idx))
        avg_face_cy = int(sum(raw_positions[i][1] for i in detected_idx) / len(detected_idx))
        for i in range(len(raw_positions)):
            if not has_face_list[i]:
                raw_positions[i] = (avg_face_cx, avg_face_cy)

    raw_positions = interpolate_missing(raw_positions, has_face_list)
    smoothed = smooth_positions(raw_positions, has_face_list)

    # ── Build output ──────────────────────────────────────────────────────
    frames_out = []
    for i, (t, (cx, cy), has_face, span_w, active_spk) in enumerate(
            zip(sample_times, smoothed, has_face_list, face_span_list, active_speakers)):
        frames_out.append({
            'frameIndex':    i,
            'timestampMs':   int(t * 1000),
            'cx':            int(cx),
            'cy':            int(cy),
            'hasFace':       has_face,
            'faceSpanW':     span_w,
            'activeSpeaker': active_spk,
        })

    use_frames = [f for f in frames_out if f['hasFace']] or frames_out
    avg_cx = int(sum(f['cx'] for f in use_frames) / len(use_frames))
    avg_cy = int(sum(f['cy'] for f in use_frames) / len(use_frames))

    face_count = sum(1 for f in frames_out if f['hasFace'])
    print(f'Active speaker tracking: {len(frames_out)} frames, {face_count} with face', file=sys.stderr)

    result = {
        'frames':       frames_out,
        'avgCx':        avg_cx,
        'avgCy':        avg_cy,
        'width':        width,
        'height':       height,
        'mode':         'active_speaker',
        'speakerFaces': speaker_face_map,
        'splitScreen':  args.split_screen,
        'detectedBoxes': [],
    }

    with open(args.output, 'w') as f:
        json.dump(result, f)


def _write_fallback(output_path):
    result = {
        'frames': [], 'avgCx': 960, 'avgCy': 360,
        'width': 1920, 'height': 1080, 'mode': 'fallback',
        'detectedBoxes': [],
    }
    with open(output_path, 'w') as f:
        json.dump(result, f)
    print('Active speaker tracking unavailable — center crop fallback', file=sys.stderr)


if __name__ == '__main__':
    main()
