#!/usr/bin/env python3
"""
detect_faces.py — Subject tracking for auto-crop in vertical video clips.

Two modes:
  1. Automatic: face + upper-body detection, EMA smoothing, multi-face grouping
  2. Manual: user provides --subject-bbox x,y,w,h to seed tracking from a
     specific region; uses template matching to follow it across frames

Usage:
    # Automatic
    python detect_faces.py --file video.mp4 --start 10.5 --end 45.2 --output crop.json

    # Manual (seed from user-selected bbox in original video coordinates)
    python detect_faces.py --file video.mp4 --start 10.5 --end 45.2 --output crop.json \
        --subject-bbox 800,200,320,480 --subject-seed-time 12.0

    # Extract single frame for UI subject picker
    python detect_faces.py --file video.mp4 --extract-frame 12.5 --output frame.jpg

Output JSON (tracking mode):
{
  "frames": [
    {"frameIndex": 0, "timestampMs": 10500, "cx": 960, "cy": 400,
     "hasFace": true, "faceSpanW": 0, "confidence": 0.9},
    ...
  ],
  "avgCx": 960, "avgCy": 400, "width": 1920, "height": 1080,
  "detectedBoxes": [{"x":800,"y":200,"w":320,"h":480}, ...]  // boxes at seed frame
}
"""

import argparse
import json
import sys
import os
import base64


# ---------------------------------------------------------------------------
# Smoothing
# ---------------------------------------------------------------------------

def smooth_positions(positions, has_face_list, alpha_track=0.3, alpha_snap=0.85):
    """
    Adaptive EMA smoothing.
    - alpha_snap (0.85): used when transitioning FROM no-face TO face → fast snap
    - alpha_track (0.3): used when already tracking face → smooth follow
    - Between two no-face positions: alpha=0 (hold, no smoothing needed)
    """
    if not positions:
        return positions

    smoothed = [positions[0]]
    for i in range(1, len(positions)):
        prev = smoothed[-1]
        curr = positions[i]
        prev_had_face = has_face_list[i - 1] if i > 0 else False
        curr_has_face = has_face_list[i]

        if curr_has_face and not prev_had_face:
            # Transition: no-face → face. Snap quickly.
            alpha = alpha_snap
        elif curr_has_face and prev_had_face:
            # Both tracking: smooth follow
            alpha = alpha_track
        else:
            # No face on current frame: hold interpolated position (alpha=1 = use curr as-is)
            alpha = 1.0

        s = (alpha * curr[0] + (1 - alpha) * prev[0],
             alpha * curr[1] + (1 - alpha) * prev[1])
        smoothed.append(s)

    return smoothed


def interpolate_missing(positions, has_face_list):
    """
    Fill no-face gaps:
    - Gap between two face positions → linear interpolation (smooth pan)
    - Gap at START before first face → hold first face position (jump immediately)
    - Gap at END after last face → hold last face position
    - Gap followed immediately by face → jump directly to face (no slow approach)
    """
    n = len(positions)
    result = list(positions)

    i = 0
    while i < n:
        if not has_face_list[i]:
            gap_start = i
            prev_pos = result[gap_start - 1] if gap_start > 0 else None
            prev_had_face = has_face_list[gap_start - 1] if gap_start > 0 else False

            # Find end of gap
            gap_end = i
            while gap_end < n and not has_face_list[gap_end]:
                gap_end += 1

            next_pos = result[gap_end] if gap_end < n else None
            next_has_face = gap_end < n  # True if gap ends at a face frame

            gap_len = gap_end - gap_start

            for j in range(gap_start, gap_end):
                if prev_had_face and next_has_face:
                    # Gap between two face detections → smooth interpolation
                    t = (j - gap_start + 1) / (gap_len + 1)
                    result[j] = (
                        prev_pos[0] + t * (next_pos[0] - prev_pos[0]),
                        prev_pos[1] + t * (next_pos[1] - prev_pos[1]),
                    )
                elif next_has_face:
                    # Gap before first face → jump to face position immediately
                    result[j] = next_pos
                elif prev_had_face:
                    # Gap after last face → hold last face position
                    result[j] = prev_pos
                # else: no face anywhere → leave as center (already set)

            i = gap_end
        else:
            i += 1

    return result


# ---------------------------------------------------------------------------
# Detection helpers
# ---------------------------------------------------------------------------

def pick_group_center(faces):
    """Union bounding box center of all faces. Returns (cx, cy, span_w)."""
    if not faces:
        return None
    min_x = min(x for (x, y, w, h) in faces)
    max_x = max(x + w for (x, y, w, h) in faces)
    min_y = min(y for (x, y, w, h) in faces)
    max_y = max(y + h for (x, y, w, h) in faces)
    cx = int((min_x + max_x) / 2)
    cy = int((min_y + max_y) / 2)
    span_w = max_x - min_x
    return (cx, cy, span_w)


def pick_best_detection(detections, width, height, prev_cx=None):
    """
    Score detections by area × vertical_bonus × continuity.
    Returns (cx, cy) of best detection.
    """
    if not detections:
        return None
    if len(detections) == 1:
        x, y, w, h = detections[0]
        return (int(x + w / 2), int(y + h / 2))

    best = None
    best_score = -1
    for (x, y, w, h) in detections:
        cx = int(x + w / 2)
        cy = int(y + h / 2)
        area = w * h
        vertical_bonus = 1.5 if cy < height * 0.65 else 1.0
        continuity = 1.0
        if prev_cx is not None:
            dist = abs(cx - prev_cx)
            continuity = max(0.3, 1.0 - dist / width)
        score = area * vertical_bonus * continuity
        if score > best_score:
            best_score = score
            best = (cx, cy)
    return best


def detect_subjects(frame_small, face_cascade, body_cascade, scale, width, height, prev_cx=None, mp_detector=None):
    """
    Detect faces using MediaPipe Face Detector with auto-switch between full-range and short-range.
    mp_detector can be a tuple (detector_full, detector_short) for auto-distance switching,
    or a single detector, or None (fallback to OpenCV).
    Returns list of (x, y, w, h) in original resolution, detection_type.
    """
    # ── Primary: MediaPipe Face Detector (Tasks API) ──────────────────────
    if mp_detector is not None:
        try:
            import mediapipe as mp
            import numpy as np

            frame_rgb = frame_small[:, :, ::-1] if frame_small.shape[2] == 3 else frame_small
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(frame_rgb))

            if isinstance(mp_detector, tuple):
                det_full, det_short = mp_detector

                # Run full-range first (catches far faces)
                faces_full = []
                if det_full:
                    r = det_full.detect(mp_image)
                    faces_full = [(d.bounding_box.origin_x, d.bounding_box.origin_y,
                                   d.bounding_box.width, d.bounding_box.height)
                                  for d in (r.detections or [])]

                # If largest face > 120px wide → close-up → use short-range for precision
                max_w_scaled = max((bw / scale for _, _, bw, _ in faces_full), default=0)
                if max_w_scaled > 120 and det_short:
                    r2 = det_short.detect(mp_image)
                    faces_short = [(d.bounding_box.origin_x, d.bounding_box.origin_y,
                                    d.bounding_box.width, d.bounding_box.height)
                                   for d in (r2.detections or [])]
                    # Use short-range if it found faces, else keep full-range
                    all_faces = faces_short if faces_short else faces_full
                else:
                    all_faces = faces_full
            else:
                r = mp_detector.detect(mp_image)
                all_faces = [(d.bounding_box.origin_x, d.bounding_box.origin_y,
                              d.bounding_box.width, d.bounding_box.height)
                             for d in (r.detections or [])]

            if all_faces:
                faces_orig = []
                for (bx, by, bw, bh) in all_faces:
                    x = max(0, int(bx / scale))
                    y = max(0, int(by / scale))
                    w = min(int(bw / scale), width - x)
                    h = min(int(bh / scale), height - y)
                    if w > 10 and h > 10:
                        faces_orig.append((x, y, w, h))
                if faces_orig:
                    return faces_orig, 'face'
        except Exception:
            pass  # Fall through to OpenCV

    # ── Fallback: OpenCV Haar Cascade ─────────────────────────────────────
    gray = None
    try:
        import cv2
        gray = cv2.cvtColor(frame_small, cv2.COLOR_BGR2GRAY)
    except Exception:
        return [], 'none'

    faces = face_cascade.detectMultiScale(
        gray,
        scaleFactor=1.08,
        minNeighbors=3,
        minSize=(25, 25),
        flags=0,
    )

    if len(faces) > 0:
        faces_orig = [(int(x / scale), int(y / scale),
                       int(w / scale), int(h / scale))
                      for (x, y, w, h) in faces]
        return faces_orig, 'face'

    if body_cascade is not None:
        bodies = body_cascade.detectMultiScale(
            gray,
            scaleFactor=1.1,
            minNeighbors=2,
            minSize=(40, 60),
        )
        if len(bodies) > 0:
            bodies_orig = [(int(x / scale), int(y / scale),
                            int(w / scale), int(h / scale))
                           for (x, y, w, h) in bodies]
            return bodies_orig, 'body'

    return [], 'none'


# ---------------------------------------------------------------------------
# Template matching tracker (manual mode)
# ---------------------------------------------------------------------------

def track_with_template(cap, sample_times, seed_frame_time, subject_bbox,
                         width, height, search_margin=0.15):
    """
    Track a user-selected subject using template matching.
    seed_frame_time: timestamp (sec) where subject_bbox was selected
    subject_bbox: (x, y, w, h) in original resolution

    Returns list of (cx, cy, has_subject) per sample_time.
    """
    try:
        import cv2
        import numpy as np
    except ImportError:
        return [(width // 2, height // 3, False)] * len(sample_times)

    sx, sy, sw, sh = subject_bbox

    # Extract template from seed frame
    cap.set(cv2.CAP_PROP_POS_MSEC, seed_frame_time * 1000)
    ret, seed_frame = cap.read()
    if not ret:
        return [(width // 2, height // 3, False)] * len(sample_times)

    # Clamp bbox to frame
    sx = max(0, min(sx, width - 1))
    sy = max(0, min(sy, height - 1))
    sw = min(sw, width - sx)
    sh = min(sh, height - sy)

    template = seed_frame[sy:sy+sh, sx:sx+sw]
    if template.size == 0:
        return [(width // 2, height // 3, False)] * len(sample_times)

    # Scale template for faster matching
    scale = min(1.0, 480 / width)
    tmpl_small = cv2.resize(template, (max(1, int(sw * scale)), max(1, int(sh * scale))))

    results = []
    prev_cx = sx + sw // 2
    prev_cy = sy + sh // 2

    margin_x = int(width * search_margin)
    margin_y = int(height * search_margin)

    for t in sample_times:
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
        ret, frame = cap.read()
        if not ret:
            results.append((prev_cx, prev_cy, False))
            continue

        # Search region around previous position
        rx1 = max(0, prev_cx - margin_x - sw // 2)
        ry1 = max(0, prev_cy - margin_y - sh // 2)
        rx2 = min(width,  prev_cx + margin_x + sw // 2)
        ry2 = min(height, prev_cy + margin_y + sh // 2)

        region = frame[ry1:ry2, rx1:rx2]
        if region.shape[0] < tmpl_small.shape[0] or region.shape[1] < tmpl_small.shape[1]:
            results.append((prev_cx, prev_cy, False))
            continue

        region_small = cv2.resize(region, (
            max(1, int((rx2 - rx1) * scale)),
            max(1, int((ry2 - ry1) * scale)),
        ))

        try:
            result = cv2.matchTemplate(region_small, tmpl_small, cv2.TM_CCOEFF_NORMED)
            _, max_val, _, max_loc = cv2.minMaxLoc(result)
        except Exception:
            results.append((prev_cx, prev_cy, False))
            continue

        if max_val < 0.35:  # low confidence → hold position
            results.append((prev_cx, prev_cy, False))
            continue

        # Convert match location back to original coords
        match_x = int(max_loc[0] / scale) + rx1 + sw // 2
        match_y = int(max_loc[1] / scale) + ry1 + sh // 2
        prev_cx = match_x
        prev_cy = match_y
        results.append((match_x, match_y, True))

    return results


# ---------------------------------------------------------------------------
# Frame extraction (for UI subject picker)
# ---------------------------------------------------------------------------

def extract_frame(video_path, timestamp_sec, output_path):
    """Extract a single frame as JPEG for the subject picker UI."""
    try:
        import cv2
    except ImportError:
        print('OpenCV not available', file=sys.stderr)
        sys.exit(1)

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f'Cannot open video: {video_path}', file=sys.stderr)
        sys.exit(1)

    cap.set(cv2.CAP_PROP_POS_MSEC, timestamp_sec * 1000)
    ret, frame = cap.read()
    cap.release()

    if not ret:
        print('Cannot read frame', file=sys.stderr)
        sys.exit(1)

    # Scale to max 960px wide for UI
    h, w = frame.shape[:2]
    max_w = 960
    if w > max_w:
        scale = max_w / w
        frame = cv2.resize(frame, (max_w, int(h * scale)))

    cv2.imwrite(output_path, frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
    print(f'Frame extracted: {output_path}', file=sys.stderr)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--file',         required=True,  help='Path to video file')
    parser.add_argument('--start',        type=float, default=0, help='Start time in seconds')
    parser.add_argument('--end',          type=float, default=0, help='End time in seconds')
    parser.add_argument('--output',       required=True,  help='Output JSON or JPEG path')
    parser.add_argument('--samples',      type=int, default=30, help='Frames to sample')
    parser.add_argument('--extract-frame', type=float, default=None,
                        help='If set, extract single frame at this timestamp (sec) and exit')
    parser.add_argument('--subject-bbox', type=str, default=None,
                        help='Manual subject bbox: x,y,w,h in original video pixels')
    parser.add_argument('--subject-seed-time', type=float, default=None,
                        help='Timestamp (sec) where subject-bbox was selected')
    args = parser.parse_args()

    # ── Frame extraction mode ──────────────────────────────────────────────
    if args.extract_frame is not None:
        extract_frame(args.file, args.extract_frame, args.output)
        return

    # ── Tracking mode ─────────────────────────────────────────────────────
    try:
        import cv2
    except ImportError:
        print('OpenCV not available — using center crop fallback', file=sys.stderr)
        _write_fallback(args.output)
        return

    duration = args.end - args.start
    if duration <= 0:
        _write_fallback(args.output)
        return

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

    # ── Manual mode: template matching ────────────────────────────────────
    if args.subject_bbox:
        try:
            parts = [int(v) for v in args.subject_bbox.split(',')]
            subject_bbox = tuple(parts[:4])  # x, y, w, h
            seed_time = args.subject_seed_time if args.subject_seed_time is not None else args.start
            tracking_results = track_with_template(
                cap, sample_times, seed_time, subject_bbox, width, height
            )
            cap.release()

            raw_positions = [(cx, cy) for (cx, cy, _) in tracking_results]
            has_face_list = [has for (_, _, has) in tracking_results]
            face_span_list = [0] * len(tracking_results)

            raw_positions = interpolate_missing(raw_positions, has_face_list)
            smoothed = smooth_positions(raw_positions, has_face_list)

            frames_out = []
            for i, (t, (cx, cy), has_face, span_w) in enumerate(
                    zip(sample_times, smoothed, has_face_list, face_span_list)):
                frames_out.append({
                    'frameIndex':  i,
                    'timestampMs': int(t * 1000),
                    'cx':          int(cx),
                    'cy':          int(cy),
                    'hasFace':     has_face,
                    'faceSpanW':   span_w,
                    'confidence':  0.8 if has_face else 0.3,
                })

            use_frames = [f for f in frames_out if f['hasFace']] or frames_out
            avg_cx = int(sum(f['cx'] for f in use_frames) / len(use_frames))
            avg_cy = int(sum(f['cy'] for f in use_frames) / len(use_frames))

            result = {
                'frames': frames_out,
                'avgCx': avg_cx, 'avgCy': avg_cy,
                'width': width, 'height': height,
                'mode': 'manual',
            }
            with open(args.output, 'w') as f:
                json.dump(result, f)
            print(f'Manual tracking complete: {len(frames_out)} frames', file=sys.stderr)
            return
        except Exception as e:
            print(f'Manual tracking failed: {e}, falling back to auto', file=sys.stderr)

    # ── Automatic mode: face + body detection ─────────────────────────────
    face_cascade_path = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
    body_cascade_path = cv2.data.haarcascades + 'haarcascade_upperbody.xml'

    if not os.path.exists(face_cascade_path):
        print('Haar cascade not found — using center crop fallback', file=sys.stderr)
        cap.release()
        _write_fallback(args.output)
        return

    face_cascade = cv2.CascadeClassifier(face_cascade_path)
    body_cascade = cv2.CascadeClassifier(body_cascade_path) if os.path.exists(body_cascade_path) else None

    # ── Initialize MediaPipe Face Detectors (Tasks API) ────────────────────
    # Use VIDEO mode for temporal tracking consistency across frames
    mp_detector_full  = None  # Full-range: faces 2-5m away (crowds, panels)
    mp_detector_short = None  # Short-range: faces < 2m (close-up interviews)

    try:
        import mediapipe as mp
        from mediapipe.tasks import python as mp_python
        from mediapipe.tasks.python import vision as mp_vision

        script_dir = os.path.dirname(os.path.abspath(__file__))
        model_full  = os.path.join(script_dir, 'blaze_face_full_range.tflite')
        model_short = os.path.join(script_dir, 'blaze_face_short_range.tflite')

        def _make_detector(model_path):
            return mp_vision.FaceDetector.create_from_options(
                mp_vision.FaceDetectorOptions(
                    base_options=mp_python.BaseOptions(model_asset_path=model_path),
                    running_mode=mp_vision.RunningMode.IMAGE,
                    min_detection_confidence=0.35,
                )
            )

        if os.path.exists(model_full):
            mp_detector_full = _make_detector(model_full)
            print('MediaPipe full-range detector initialized', file=sys.stderr)
        if os.path.exists(model_short):
            mp_detector_short = _make_detector(model_short)
            print('MediaPipe short-range detector initialized', file=sys.stderr)

        if not mp_detector_full and not mp_detector_short:
            print('MediaPipe model files not found, using OpenCV fallback', file=sys.stderr)
    except Exception as e:
        print(f'MediaPipe not available ({e}), using OpenCV Haar Cascade', file=sys.stderr)
        mp_detector_full = mp_detector_short = None

    # Also collect detected boxes at first frame for UI subject picker
    detected_boxes_at_start = []

    # Collect ALL individual face/body detections per frame for multi-speaker layouts
    all_detections_per_frame = []

    raw_positions = []
    has_face_list = []
    face_span_list = []
    detection_types = []
    prev_cx = None

    for idx, t in enumerate(sample_times):
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
        ret, frame = cap.read()
        if not ret:
            cx = prev_cx if prev_cx is not None else width // 2
            raw_positions.append((cx, height // 3))
            has_face_list.append(False)
            face_span_list.append(0)
            detection_types.append('none')
            all_detections_per_frame.append([])
            continue

        scale = min(1.0, 480 / width)
        small = cv2.resize(frame, (int(width * scale), int(height * scale)))

        detections, det_type = detect_subjects(
            small, face_cascade, body_cascade, scale, width, height, prev_cx,
            (mp_detector_full, mp_detector_short) if (mp_detector_full or mp_detector_short) else None
        )

        # Collect boxes at first sample for UI
        if idx == 0 and detections:
            detected_boxes_at_start = [
                {'x': x, 'y': y, 'w': w, 'h': h}
                for (x, y, w, h) in detections
            ]

        # Store all individual detections for this frame (face centers)
        frame_faces = []
        for (x, y, w, h) in detections:
            frame_faces.append({
                'cx': int(x + w / 2),
                'cy': int(y + h / 2),
                'w': w,
                'h': h,
            })
        all_detections_per_frame.append(frame_faces)

        if detections:
            if len(detections) >= 2:
                result = pick_group_center(detections)
                if result:
                    cx, cy, span_w = result
                    prev_cx = cx
                    raw_positions.append((cx, cy))
                    has_face_list.append(True)
                    face_span_list.append(span_w)
                    detection_types.append(det_type)
                    continue
            else:
                result_single = pick_best_detection(detections, width, height, prev_cx)
                if result_single:
                    cx, cy = result_single
                    prev_cx = cx
                    raw_positions.append((cx, cy))
                    has_face_list.append(True)
                    face_span_list.append(0)
                    detection_types.append(det_type)
                    continue

        # No detection
        cx = prev_cx if prev_cx is not None else width // 2
        raw_positions.append((cx, height // 3))
        has_face_list.append(False)
        face_span_list.append(0)
        detection_types.append('none')

    cap.release()

    # Interpolate missing frames, then smooth
    raw_positions = interpolate_missing(raw_positions, has_face_list)
    smoothed = smooth_positions(raw_positions, has_face_list)

    frames_out = []
    for i, (t, (cx, cy), has_face, span_w, det_type) in enumerate(
            zip(sample_times, smoothed, has_face_list, face_span_list, detection_types)):
        frames_out.append({
            'frameIndex':  i,
            'timestampMs': int(t * 1000),
            'cx':          int(cx),
            'cy':          int(cy),
            'hasFace':     has_face,
            'faceSpanW':   span_w,
            'confidence':  0.9 if has_face else 0.2,
            'detType':     det_type,
        })

    face_frames = [f for f in frames_out if f['hasFace']]
    use_frames  = face_frames if face_frames else frames_out

    avg_cx = int(sum(f['cx'] for f in use_frames) / len(use_frames)) if use_frames else width // 2
    avg_cy = int(sum(f['cy'] for f in use_frames) / len(use_frames)) if use_frames else height // 3

    face_count = sum(1 for h in has_face_list if h)
    body_count = sum(1 for t in detection_types if t == 'body')

    # Aggregate all individual face positions across frames to find distinct speakers
    # This is used by quad/split layouts to position each speaker's panel
    all_face_centers = []
    for frame_faces in all_detections_per_frame:
        for fc in frame_faces:
            all_face_centers.append((fc['cx'], fc['cy']))

    # Cluster face centers into distinct speakers using simple grid-based clustering
    # Group faces that are within 20% of frame width from each other
    distinct_speakers = []
    cluster_radius_x = width * 0.20
    cluster_radius_y = height * 0.25

    for (fcx, fcy) in all_face_centers:
        merged = False
        for sp in distinct_speakers:
            if abs(fcx - sp['cx']) < cluster_radius_x and abs(fcy - sp['cy']) < cluster_radius_y:
                # Update running average
                sp['count'] += 1
                sp['cx'] = int(sp['cx'] + (fcx - sp['cx']) / sp['count'])
                sp['cy'] = int(sp['cy'] + (fcy - sp['cy']) / sp['count'])
                merged = True
                break
        if not merged:
            distinct_speakers.append({'cx': fcx, 'cy': fcy, 'count': 1})

    # Sort by count descending (most frequently detected speakers first)
    distinct_speakers.sort(key=lambda s: s['count'], reverse=True)
    # Keep top speakers (max 8)
    speaker_positions = [{'cx': s['cx'], 'cy': s['cy']} for s in distinct_speakers[:8]]

    result = {
        'frames': frames_out,
        'avgCx':  avg_cx,
        'avgCy':  avg_cy,
        'width':  width,
        'height': height,
        'mode':   'auto',
        'detectedBoxes': detected_boxes_at_start,
        'speakerPositions': speaker_positions,
    }

    with open(args.output, 'w') as f:
        json.dump(result, f)

    print(
        f'Auto tracking: {len(frames_out)} frames, {face_count} face, '
        f'{body_count} body, avgCx={avg_cx}',
        file=sys.stderr
    )


def _write_fallback(output_path):
    result = {
        'frames': [],
        'avgCx': 960, 'avgCy': 360,
        'width': 1920, 'height': 1080,
        'mode': 'fallback',
        'detectedBoxes': [],
    }
    with open(output_path, 'w') as f:
        json.dump(result, f)
    print('Subject tracking unavailable — center crop fallback', file=sys.stderr)


if __name__ == '__main__':
    main()
