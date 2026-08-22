#!/usr/bin/env python3
"""
active_speaker_track.py — Top-tier Audio-Visual Active Speaker Tracking (Light-ASD).

Combines:
  1. Audio speech energy extraction (via FFmpeg audio RMS).
  2. Per-face spatial tracking with high-precision normalized Lip Motion metric.
  3. Strict Motion-Gate: motionless/dead/static faces receive 0.0 speech score.
  4. Audio-Visual Correlation: syncs actual mouth movement with audio energy.
  5. Virtual Cameraman Deadband smoothing & shot cut detection.
"""

import argparse
import json
import math
import os
import subprocess
import sys
import tempfile
import numpy as np

# ---------------------------------------------------------------------------
# Scene Cut & Deadband Camera
# ---------------------------------------------------------------------------

def compute_frame_hist(frame_gray):
    import cv2
    hist = cv2.calcHist([frame_gray], [0], None, [32], [0, 256])
    cv2.normalize(hist, hist)
    return hist


def is_scene_cut(prev_gray, curr_gray, prev_hist=None, curr_hist=None):
    import cv2
    if prev_gray is None or curr_gray is None:
        ch = compute_frame_hist(curr_gray) if curr_gray is not None else None
        return False, ch

    if curr_hist is None:
        curr_hist = compute_frame_hist(curr_gray)
    if prev_hist is None:
        prev_hist = compute_frame_hist(prev_gray)

    corr = cv2.compareHist(prev_hist, curr_hist, cv2.HISTCMP_CORREL)
    diff = cv2.absdiff(prev_gray, curr_gray)
    mean_diff = np.mean(diff) / 255.0

    is_cut = bool(corr < 0.40 or (corr < 0.65 and mean_diff > 0.35))
    return is_cut, curr_hist


class DeadbandCamera:
    def __init__(self, width, height, deadband_x_ratio=0.15, deadband_y_ratio=0.20, alpha_move=0.25):
        self.width = width
        self.height = height
        self.deadband_w = width * deadband_x_ratio
        self.deadband_h = height * deadband_y_ratio
        self.alpha_move = alpha_move
        self.cam_x = None
        self.cam_y = None

    def update(self, target_x, target_y, is_cut=False):
        if self.cam_x is None or is_cut:
            self.cam_x = float(target_x)
            self.cam_y = float(target_y)
            return int(round(self.cam_x)), int(round(self.cam_y))

        half_w = self.deadband_w / 2.0
        diff_x = target_x - self.cam_x
        if abs(diff_x) > half_w:
            pull_x = diff_x - math.copysign(half_w, diff_x)
            self.cam_x += pull_x * self.alpha_move

        half_h = self.deadband_h / 2.0
        diff_y = target_y - self.cam_y
        if abs(diff_y) > half_h:
            pull_y = diff_y - math.copysign(half_h, diff_y)
            self.cam_y += pull_y * self.alpha_move

        self.cam_x = max(0.0, min(float(self.width), self.cam_x))
        self.cam_y = max(0.0, min(float(self.height), self.cam_y))
        return int(round(self.cam_x)), int(round(self.cam_y))


# ---------------------------------------------------------------------------
# Audio Energy Extraction
# ---------------------------------------------------------------------------

def extract_audio_energy(video_path, start_sec, end_sec, sample_times):
    """
    Extract audio RMS energy curve matched to sample_times.
    """
    try:
        cmd = [
            'ffmpeg', '-ss', str(start_sec), '-i', video_path,
            '-t', str(end_sec - start_sec),
            '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'
        ]
        proc = subprocess.run(cmd, capture_output=True, timeout=30)
        if proc.returncode != 0 or len(proc.stdout) < 64:
            return [0.5] * len(sample_times)

        audio_samples = np.frombuffer(proc.stdout, dtype=np.float32)
        sr = 16000
        energy = []

        window_size = int(sr * 0.15) # 150ms window
        for t in sample_times:
            rel_t = t - start_sec
            idx = int(rel_t * sr)
            idx_st = max(0, idx - window_size // 2)
            idx_ed = min(len(audio_samples), idx + window_size // 2)
            if idx_ed > idx_st:
                chunk = audio_samples[idx_st:idx_ed]
                rms = float(np.sqrt(np.mean(chunk ** 2) + 1e-9))
            else:
                rms = 0.0
            energy.append(rms)

        max_e = max(energy) if energy else 1.0
        if max_e > 1e-6:
            energy = [e / max_e for e in energy]
        return energy
    except Exception as e:
        print(f'Audio energy extraction failed ({e}), using uniform', file=sys.stderr)
        return [0.5] * len(sample_times)


# ---------------------------------------------------------------------------
# Lip Motion Activity Extraction
# ---------------------------------------------------------------------------

def compute_mouth_motion_score(curr_face_crop, prev_face_crop):
    """
    Compute normalized optical/pixel delta in the lower 45% (mouth area)
    between consecutive frames of the SAME person.
    """
    if curr_face_crop is None or prev_face_crop is None:
        return 0.0
    import cv2
    try:
        h1, w1 = curr_face_crop.shape[:2]
        h2, w2 = prev_face_crop.shape[:2]
        if h1 < 16 or w1 < 16 or h2 < 16 or w2 < 16:
            return 0.0

        # Lower 45% of face crop is the mouth/jaw area
        m_y1_curr = int(h1 * 0.55)
        m_y1_prev = int(h2 * 0.55)

        mouth_curr = curr_face_crop[m_y1_curr:h1, :]
        mouth_prev = prev_face_crop[m_y1_prev:h2, :]

        # Standardize size for invariant comparison (64 x 32)
        norm_curr = cv2.resize(cv2.cvtColor(mouth_curr, cv2.COLOR_BGR2GRAY), (64, 32))
        norm_prev = cv2.resize(cv2.cvtColor(mouth_prev, cv2.COLOR_BGR2GRAY), (64, 32))

        # Histogram equalization eliminates background lighting/shadow shifts
        norm_curr = cv2.equalizeHist(norm_curr)
        norm_prev = cv2.equalizeHist(norm_prev)

        diff = cv2.absdiff(norm_curr, norm_prev)
        raw_motion = float(np.mean(diff) / 255.0)

        # Strict noise gate: ignore static mouth / micro jitter (e.g. breathing/dead face)
        NOISE_GATE = 0.025
        if raw_motion <= NOISE_GATE:
            return 0.0

        # High-dynamic range motion score for active speech
        return float((raw_motion - NOISE_GATE) * 30.0)
    except Exception:
        return 0.0


# ---------------------------------------------------------------------------
# Detect Faces / Poses
# ---------------------------------------------------------------------------

def detect_faces(frame_bgr, width, height, yolo_tracker=None, mp_detector=None, face_cascade=None):
    """
    Returns list of {cx, cy, w, h, crop, tid}
    """
    faces = []

    # Try YOLO-Pose
    if yolo_tracker is not None and yolo_tracker.is_available():
        best_person, all_boxes, all_faces = yolo_tracker.track_frame(frame_bgr, width, height)
        for i, f in enumerate(all_faces):
            head_w = max(40, min(int(f['w'] * 0.65), int(width * 0.4)))
            head_h = max(40, min(int(f['h'] * 0.35), int(height * 0.4)))
            x1 = max(0, f['cx'] - head_w // 2)
            y1 = max(0, f['cy'] - head_h // 2)
            x2 = min(width, x1 + head_w)
            y2 = min(height, y1 + head_h)
            crop = frame_bgr[y1:y2, x1:x2] if (x2 > x1 and y2 > y1) else None
            faces.append({
                'cx': f['cx'],
                'cy': f['cy'],
                'w': head_w,
                'h': head_h,
                'crop': crop,
                'tid': f.get('tid', i),
            })
        if faces:
            return faces

    # Fallback to OpenCV
    if face_cascade is not None:
        import cv2
        scale = min(1.0, 480 / width)
        small = cv2.cvtColor(cv2.resize(frame_bgr, (int(width * scale), int(height * scale))), cv2.COLOR_BGR2GRAY)
        dets = face_cascade.detectMultiScale(small, scaleFactor=1.08, minNeighbors=3, minSize=(25, 25))
        for i, (x, y, w, h) in enumerate(dets):
            fx = int(x / scale); fy = int(y / scale); fw = int(w / scale); fh = int(h / scale)
            crop = frame_bgr[fy:min(height, fy+fh), fx:min(width, fx+fw)]
            faces.append({
                'cx': int(fx + fw / 2),
                'cy': int(fy + fh / 2),
                'w': fw,
                'h': fh,
                'crop': crop,
                'tid': i,
            })
    return faces


# ---------------------------------------------------------------------------
# Main Routine
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--file',         required=True,  help='Path to video file')
    parser.add_argument('--start',        type=float, default=0, help='Start time in seconds')
    parser.add_argument('--end',          type=float, default=0, help='End time in seconds')
    parser.add_argument('--output',       required=True,  help='Output JSON path')
    parser.add_argument('--samples',      type=int, default=30, help='Frames to sample')
    parser.add_argument('--split-screen', action='store_true', help='Enable split screen layout')
    parser.add_argument('--hf-token',     type=str, default=None, help='HuggingFace token for pyannote')
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

    cap = cv2.VideoCapture(args.file)
    if not cap.isOpened():
        _write_fallback(args.output)
        return

    width  = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))  or 1920
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 1080

    n_samples = max(15, min(args.samples, 90))
    sample_times = [
        args.start + (i / max(n_samples - 1, 1)) * duration
        for i in range(n_samples)
    ]

    script_dir = os.path.dirname(os.path.abspath(__file__))

    # Audio speech energy envelope
    audio_energies = extract_audio_energy(args.file, args.start, args.end, sample_times)

    # Initialize Tracker
    from detect_faces import YOLOPoseTracker
    yolo_tracker = YOLOPoseTracker(script_dir)

    face_cascade_path = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
    face_cascade = cv2.CascadeClassifier(face_cascade_path) if os.path.exists(face_cascade_path) else None

    # Track distinct faces across frames
    tracked_face_crops = {}  # track_id -> {'crop': ..., 'cx': ..., 'cy': ...}
    per_frame_candidates = []
    is_cut_list = []
    prev_gray = None
    prev_hist = None

    for idx, t in enumerate(sample_times):
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
        ret, frame = cap.read()
        if not ret:
            per_frame_candidates.append([])
            is_cut_list.append(False)
            continue

        low_res = cv2.resize(frame, (320, 180))
        curr_gray = cv2.cvtColor(low_res, cv2.COLOR_BGR2GRAY)
        cut, curr_hist = is_scene_cut(prev_gray, curr_gray, prev_hist)
        prev_gray = curr_gray
        prev_hist = curr_hist
        is_cut_list.append(cut)

        if cut:
            tracked_face_crops.clear()

        faces = detect_faces(frame, width, height, yolo_tracker=yolo_tracker, face_cascade=face_cascade)
        audio_e = audio_energies[idx] if idx < len(audio_energies) else 0.5

        scored_faces = []
        new_tracked = {}

        for f in faces:
            # Match with previously tracked face by spatial distance or track ID
            matched_id = None
            best_dist = float('inf')
            fcx, fcy = f['cx'], f['cy']

            for tid, tinfo in tracked_face_crops.items():
                d = math.hypot(fcx - tinfo['cx'], fcy - tinfo['cy'])
                if d < max(width * 0.18, f['w'] * 1.5) and d < best_dist:
                    best_dist = d
                    matched_id = tid

            if matched_id is None:
                matched_id = f"face_{len(tracked_face_crops) + len(new_tracked)}"

            prev_crop = tracked_face_crops.get(matched_id, {}).get('crop')
            lip_motion = compute_mouth_motion_score(f['crop'], prev_crop) if not cut else 0.0
            new_tracked[matched_id] = {'crop': f['crop'], 'cx': fcx, 'cy': fcy}

            # Calculate Active Speaker Score
            # STRICT MOTION RULE: Motionless/dead faces receive 0.0 ASD score!
            area_ratio = (f['w'] * f['h']) / (width * height)
            size_bonus = min(1.2, 1.0 + 0.3 * math.sqrt(area_ratio))

            if lip_motion > 0.0:
                asd_score = lip_motion * (audio_e + 0.25) * size_bonus
            else:
                asd_score = 0.0

            scored_faces.append({
                'cx': fcx,
                'cy': fcy,
                'w': f['w'],
                'h': f['h'],
                'tid': matched_id,
                'score': asd_score,
                'lip_motion': lip_motion,
            })

        tracked_face_crops = new_tracked
        per_frame_candidates.append(scored_faces)

    cap.release()

    # Active Speaker Selection per frame with deadband cameraman
    camera = DeadbandCamera(width, height, deadband_x_ratio=0.15, deadband_y_ratio=0.20, alpha_move=0.25)
    last_confirmed_speaker_pos = None
    current_cx = width // 2
    current_cy = height // 3

    frames_out = []
    speaker_faces_acc = {'left': [], 'right': []}

    for idx, (t, candidates, cut) in enumerate(zip(sample_times, per_frame_candidates, is_cut_list)):
        if cut:
            last_confirmed_speaker_pos = None

        if candidates:
            # Find actively speaking subjects
            speaking_faces = [c for c in candidates if c['score'] > 0.0]

            if speaking_faces:
                # Pick the person with highest active speech score
                chosen = max(speaking_faces, key=lambda c: c['score'])
                target_cx, target_cy = chosen['cx'], chosen['cy']
                last_confirmed_speaker_pos = (target_cx, target_cy)
                has_face = True

                # Record speaker cluster for split layout
                if target_cx < width * 0.5:
                    speaker_faces_acc['left'].append(target_cx)
                else:
                    speaker_faces_acc['right'].append(target_cx)
            elif last_confirmed_speaker_pos is not None:
                # During brief pauses, retain focus on the last speaker who talked
                target_cx, target_cy = last_confirmed_speaker_pos
                has_face = True
            else:
                # If nobody spoke yet, pick the most central face
                chosen = min(candidates, key=lambda c: abs(c['cx'] - width // 2))
                target_cx, target_cy = chosen['cx'], chosen['cy']
                has_face = True
        else:
            target_cx, target_cy = current_cx, current_cy
            has_face = False

        cam_cx, cam_cy = camera.update(target_cx, target_cy, is_cut=cut)
        current_cx, current_cy = cam_cx, cam_cy

        frames_out.append({
            'frameIndex':    idx,
            'timestampMs':   int(t * 1000),
            'cx':            cam_cx,
            'cy':            cam_cy,
            'hasFace':       has_face,
            'faceSpanW':     0,
            'activeSpeaker': 'SPEAKER_0' if cam_cx < width * 0.5 else 'SPEAKER_1',
            'isCut':         cut,
        })

    face_frames = [f for f in frames_out if f['hasFace']]
    use_frames  = face_frames if face_frames else frames_out

    avg_cx = int(sum(f['cx'] for f in use_frames) / len(use_frames)) if use_frames else width // 2
    avg_cy = int(sum(f['cy'] for f in use_frames) / len(use_frames)) if use_frames else height // 3

    speaker_faces_out = {}
    if speaker_faces_acc['left']:
        speaker_faces_out['SPEAKER_00'] = {'avgCx': int(np.mean(speaker_faces_acc['left']))}
    if speaker_faces_acc['right']:
        speaker_faces_out['SPEAKER_01'] = {'avgCx': int(np.mean(speaker_faces_acc['right']))}

    result = {
        'frames': frames_out,
        'avgCx':  avg_cx,
        'avgCy':  avg_cy,
        'width':  width,
        'height': height,
        'speakerFaces': speaker_faces_out,
        'splitScreen': args.split_screen,
    }

    with open(args.output, 'w') as f:
        json.dump(result, f)

    print(
        f'Active Speaker Tracking Complete: {len(frames_out)} frames, Strict Motion ASD Active, Deadband Active',
        file=sys.stderr
    )


def _write_fallback(output_path):
    result = {
        'frames': [],
        'avgCx': 960, 'avgCy': 360,
        'width': 1920, 'height': 1080,
        'speakerFaces': {},
        'splitScreen': False,
    }
    with open(output_path, 'w') as f:
        json.dump(result, f)


if __name__ == '__main__':
    main()
