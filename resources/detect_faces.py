#!/usr/bin/env python3
"""
detect_faces.py — Top-tier Subject Tracking & Auto-Reframe (CapCut / Premiere Pro standard).

Features:
  1. Primary Engine: YOLOv8-Pose with ByteTrack (17 keypoints: head, shoulders, torso).
     - Full person/pose tracking even when turning back, bending, or occluded.
     - ByteTrack ID tracking prevents jumping to background passers-by.
  2. Multi-tier Fallbacks: MediaPipe BlazeFace (Full+Short range) -> OpenCV Haar Cascade.
  3. Virtual Cameraman Deadband Box (Anti-jitter):
     - Camera stays 100% still while subject is within 15% width / 20% height deadband.
     - Smooth cubic spring damping when subject pans outside deadzone.
  4. Shot / Scene Cut Detection:
     - Hard cut camera switch on scene transitions (eliminates fast whip pans across cuts).
  5. Multi-Subject Auto-Zoom:
     - Automatically measures span across all active subjects for dynamic 9:16 framing.
  6. Manual Mode:
     - Template matching tracker for user-selected bounding boxes.
"""

import argparse
import json
import math
import os
import sys
import numpy as np

# ---------------------------------------------------------------------------
# Scene Cut Detection
# ---------------------------------------------------------------------------

def compute_frame_hist(frame_gray):
    """Compute normalized 32-bin grayscale histogram."""
    import cv2
    hist = cv2.calcHist([frame_gray], [0], None, [32], [0, 256])
    cv2.normalize(hist, hist)
    return hist


def is_scene_cut(prev_gray, curr_gray, prev_hist=None, curr_hist=None, threshold=0.45):
    """
    Detect shot/scene transitions using combined histogram correlation & pixel delta.
    Returns (is_cut: bool, curr_hist)
    """
    import cv2
    if prev_gray is None or curr_gray is None:
        ch = compute_frame_hist(curr_gray) if curr_gray is not None else None
        return False, ch

    if curr_hist is None:
        curr_hist = compute_frame_hist(curr_gray)
    if prev_hist is None:
        prev_hist = compute_frame_hist(prev_gray)

    # 1. Histogram correlation (1.0 = identical, < 0.5 = major color/lighting shift)
    corr = cv2.compareHist(prev_hist, curr_hist, cv2.HISTCMP_CORREL)

    # 2. Mean absolute difference on low-res frames
    diff = cv2.absdiff(prev_gray, curr_gray)
    mean_diff = np.mean(diff) / 255.0

    # Scene cut condition: low histogram correlation OR large sudden pixel difference
    is_cut = bool(corr < 0.40 or (corr < 0.65 and mean_diff > 0.35))
    return is_cut, curr_hist


# ---------------------------------------------------------------------------
# Virtual Cameraman Deadband & Damped Easing
# ---------------------------------------------------------------------------

class DeadbandCamera:
    """
    Simulates a human cameraman:
    - Deadband box: ignore small fidgets / head tilts.
    - Smooth spring damping: smoothly catch up when subject moves out of deadband.
    - Hard cut on scene transitions.
    """
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

        # Horizontal Deadband
        half_w = self.deadband_w / 2.0
        diff_x = target_x - self.cam_x
        if abs(diff_x) > half_w:
            # Shift camera towards the edge of deadband
            pull_x = diff_x - math.copysign(half_w, diff_x)
            self.cam_x += pull_x * self.alpha_move

        # Vertical Deadband
        half_h = self.deadband_h / 2.0
        diff_y = target_y - self.cam_y
        if abs(diff_y) > half_h:
            pull_y = diff_y - math.copysign(half_h, diff_y)
            self.cam_y += pull_y * self.alpha_move

        # Clamp to frame bounds
        self.cam_x = max(0.0, min(float(self.width), self.cam_x))
        self.cam_y = max(0.0, min(float(self.height), self.cam_y))

        return int(round(self.cam_x)), int(round(self.cam_y))


# ---------------------------------------------------------------------------
# YOLOv8-Pose + ByteTrack Engine
# ---------------------------------------------------------------------------

class YOLOPoseTracker:
    def __init__(self, script_dir):
        self.model = None
        self.primary_track_id = None
        self._init_model(script_dir)

    def _init_model(self, script_dir):
        try:
            from ultralytics import YOLO
            import torch

            candidates = [
                os.path.join(script_dir, 'yolov8n-pose.pt'),
                os.path.join(os.path.dirname(script_dir), 'yolov8n-pose.pt'),
                'yolov8n-pose.pt',
            ]
            model_path = next((p for p in candidates if os.path.exists(p)), 'yolov8n-pose.pt')

            device = 'cuda:0' if torch.cuda.is_available() else 'cpu'
            self.model = YOLO(model_path)
            self.model.to(device)
            print(f'YOLOv8-Pose initialized on {device} ({model_path})', file=sys.stderr)
        except Exception as e:
            print(f'YOLOv8-Pose init skipped ({e})', file=sys.stderr)
            self.model = None

    def is_available(self):
        return self.model is not None

    def track_frame(self, frame_bgr, width, height, prev_cx=None):
        """
        Run YOLO-Pose with ByteTrack.
        Returns:
          best_person: (cx, cy, span_w, bbox, track_id)
          all_boxes: list of (x, y, w, h)
          all_faces: list of dict(cx, cy, w, h)
        """
        if self.model is None:
            return None, [], []

        try:
            results = self.model.track(
                frame_bgr,
                persist=True,
                tracker="bytetrack.yaml",
                verbose=False,
                conf=0.15,
                iou=0.5,
                classes=[0], # person
            )
            if not results or len(results) == 0:
                return None, [], []

            res = results[0]
            boxes = res.boxes
            keypoints = res.keypoints

            if boxes is None or len(boxes) == 0:
                return None, [], []

            xyxy = boxes.xyxy.cpu().numpy() if boxes.xyxy is not None else []
            confs = boxes.conf.cpu().numpy() if boxes.conf is not None else []
            track_ids = boxes.id.int().cpu().numpy() if (boxes.id is not None) else [None] * len(xyxy)
            kpts = keypoints.data.cpu().numpy() if (keypoints is not None and hasattr(keypoints, 'data')) else None

            candidates = []
            all_boxes = []
            all_faces = []

            for i in range(len(xyxy)):
                x1, y1, x2, y2 = xyxy[i]
                bw = max(1, int(x2 - x1))
                bh = max(1, int(y2 - y1))
                bx = max(0, int(x1))
                by = max(0, int(y1))
                conf = float(confs[i]) if i < len(confs) else 0.5
                tid = int(track_ids[i]) if (i < len(track_ids) and track_ids[i] is not None) else None

                all_boxes.append((bx, by, bw, bh))

                # Determine head/anchor center using keypoints
                head_cx, head_cy = None, None
                if kpts is not None and i < len(kpts):
                    person_kpts = kpts[i] # 17 x 3 [x, y, conf]
                    head_indices = [0, 1, 2, 3, 4]
                    valid_head = [person_kpts[k] for k in head_indices if k < len(person_kpts) and person_kpts[k][2] > 0.35]

                    if valid_head:
                        head_cx = int(np.mean([pt[0] for pt in valid_head]))
                        head_cy = int(np.mean([pt[1] for pt in valid_head]))
                    else:
                        l_sh = person_kpts[5] if len(person_kpts) > 5 else None
                        r_sh = person_kpts[6] if len(person_kpts) > 6 else None
                        if l_sh is not None and r_sh is not None and l_sh[2] > 0.3 and r_sh[2] > 0.3:
                            sh_cx = (l_sh[0] + r_sh[0]) / 2.0
                            sh_cy = (l_sh[1] + r_sh[1]) / 2.0
                            head_cx = int(sh_cx)
                            head_cy = int(max(0, sh_cy - bh * 0.18))

                if head_cx is None:
                    head_cx = int(bx + bw / 2.0)
                    head_cy = int(by + min(bh * 0.25, 120))

                head_cx = max(0, min(width - 1, head_cx))
                head_cy = max(0, min(height - 1, head_cy))

                all_faces.append({'cx': head_cx, 'cy': head_cy, 'w': bw, 'h': bh})

                area = bw * bh
                area_ratio = area / (width * height)
                area_weight = math.sqrt(area_ratio)
                v_bonus = 1.3 if head_cy < height * 0.65 else 1.0
                center_bonus = 1.25 if abs(head_cx - width / 2.0) < width * 0.35 else 1.0
                continuity = 1.0
                if self.primary_track_id is not None and tid == self.primary_track_id:
                    continuity = 2.0
                elif prev_cx is not None:
                    dist = abs(head_cx - prev_cx)
                    continuity = max(0.4, 1.0 - (dist / width))

                score = area_weight * v_bonus * center_bonus * continuity * (0.5 + conf)
                candidates.append({
                    'cx': head_cx,
                    'cy': head_cy,
                    'bw': bw,
                    'bh': bh,
                    'bx': bx,
                    'by': by,
                    'tid': tid,
                    'score': score,
                })

            if not candidates:
                return None, all_boxes, all_faces

            best = max(candidates, key=lambda c: c['score'])
            if best['tid'] is not None:
                self.primary_track_id = best['tid']

            span_w = 0
            if len(candidates) >= 2:
                min_x = min(c['bx'] for c in candidates)
                max_x = max(c['bx'] + c['bw'] for c in candidates)
                span_w = max_x - min_x

            return (best['cx'], best['cy'], span_w, (best['bx'], best['by'], best['bw'], best['bh']), best['tid']), all_boxes, all_faces
        except Exception as err:
            print(f'YOLO track exception ({err})', file=sys.stderr)
            return None, [], []


# ---------------------------------------------------------------------------
# Fallback Detectors (MediaPipe & OpenCV)
# ---------------------------------------------------------------------------

def _dedupe_boxes(boxes, iou_thresh=0.5):
    if not boxes:
        return []
    def iou(a, b):
        ax, ay, aw, ah = a
        bx, by, bw, bh = b
        ix1 = max(ax, bx); iy1 = max(ay, by)
        ix2 = min(ax + aw, bx + bw); iy2 = min(ay + ah, by + bh)
        iw = max(0, ix2 - ix1); ih = max(0, iy2 - iy1)
        inter = iw * ih
        union = aw * ah + bw * bh - inter
        return inter / union if union > 0 else 0.0

    boxes_sorted = sorted(boxes, key=lambda b: b[2] * b[3], reverse=True)
    kept = []
    for box in boxes_sorted:
        if all(iou(box, k) < iou_thresh for k in kept):
            kept.append(box)
    return kept


def detect_subjects_mediapipe(frame_small, mp_detector, scale, width, height):
    """MediaPipe face detection fallback."""
    if mp_detector is None:
        return []
    try:
        import mediapipe as mp
        frame_rgb = frame_small[:, :, ::-1] if frame_small.shape[2] == 3 else frame_small
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(frame_rgb))

        faces_full, faces_short = [], []
        if isinstance(mp_detector, tuple):
            det_full, det_short = mp_detector
            if det_full:
                r = det_full.detect(mp_image)
                faces_full = [(d.bounding_box.origin_x, d.bounding_box.origin_y,
                               d.bounding_box.width, d.bounding_box.height)
                              for d in (r.detections or [])]
            if det_short:
                r2 = det_short.detect(mp_image)
                faces_short = [(d.bounding_box.origin_x, d.bounding_box.origin_y,
                                d.bounding_box.width, d.bounding_box.height)
                               for d in (r2.detections or [])]
            all_faces = _dedupe_boxes(faces_full + faces_short)
        else:
            r = mp_detector.detect(mp_image)
            all_faces = [(d.bounding_box.origin_x, d.bounding_box.origin_y,
                          d.bounding_box.width, d.bounding_box.height)
                         for d in (r.detections or [])]

        results = []
        for (bx, by, bw, bh) in all_faces:
            x = max(0, int(bx / scale))
            y = max(0, int(by / scale))
            w = min(int(bw / scale), width - x)
            h = min(int(bh / scale), height - y)
            if w > 10 and h > 10:
                results.append((x, y, w, h))
        return results
    except Exception:
        return []


def detect_subjects_opencv(frame_gray, face_cascade, body_cascade, scale, width, height):
    """OpenCV Haar cascade fallback."""
    try:
        faces = face_cascade.detectMultiScale(
            frame_gray, scaleFactor=1.08, minNeighbors=3, minSize=(25, 25)
        )
        if len(faces) > 0:
            return [(int(x / scale), int(y / scale), int(w / scale), int(h / scale)) for (x, y, w, h) in faces], 'face'

        if body_cascade is not None:
            bodies = body_cascade.detectMultiScale(
                frame_gray, scaleFactor=1.1, minNeighbors=2, minSize=(40, 60)
            )
            if len(bodies) > 0:
                return [(int(x / scale), int(y / scale), int(w / scale), int(h / scale)) for (x, y, w, h) in bodies], 'body'
    except Exception:
        pass
    return [], 'none'


def pick_best_detection(detections, width, height, prev_cx=None):
    if not detections:
        return None
    if len(detections) == 1:
        x, y, w, h = detections[0]
        return (int(x + w / 2), int(y + h / 2))

    best = None
    best_score = -1.0
    for (x, y, w, h) in detections:
        cx = int(x + w / 2)
        cy = int(y + h / 2)
        area_weight = math.sqrt(max(1, w * h))
        vertical_bonus = 1.3 if cy < height * 0.65 else 1.0
        center_bonus = 1.25 if abs(cx - width / 2.0) < width * 0.35 else 1.0
        continuity = 1.0
        if prev_cx is not None:
            dist = abs(cx - prev_cx)
            continuity = max(0.3, 1.0 - dist / width)
        score = area_weight * vertical_bonus * center_bonus * continuity
        if score > best_score:
            best_score = score
            best = (cx, cy)
    return best


# ---------------------------------------------------------------------------
# Template Matching (Manual Mode)
# ---------------------------------------------------------------------------

def track_with_template(cap, sample_times, seed_frame_time, subject_bbox, width, height, search_margin=0.18):
    try:
        import cv2
    except ImportError:
        return [(width // 2, height // 3, False, False)] * len(sample_times)

    sx, sy, sw, sh = subject_bbox
    cap.set(cv2.CAP_PROP_POS_MSEC, seed_frame_time * 1000)
    ret, seed_frame = cap.read()
    if not ret:
        return [(width // 2, height // 3, False, False)] * len(sample_times)

    sx = max(0, min(sx, width - 1))
    sy = max(0, min(sy, height - 1))
    sw = min(sw, width - sx)
    sh = min(sh, height - sy)

    template = seed_frame[sy:sy+sh, sx:sx+sw]
    if template.size == 0:
        return [(width // 2, height // 3, False, False)] * len(sample_times)

    scale = min(1.0, 480 / width)
    tmpl_small = cv2.resize(template, (max(1, int(sw * scale)), max(1, int(sh * scale))))

    results = []
    prev_cx = sx + sw // 2
    prev_cy = sy + sh // 2
    prev_gray = None
    prev_hist = None

    margin_x = int(width * search_margin)
    margin_y = int(height * search_margin)

    for t in sample_times:
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
        ret, frame = cap.read()
        if not ret:
            results.append((prev_cx, prev_cy, False, False))
            continue

        curr_gray = cv2.cvtColor(cv2.resize(frame, (320, 180)), cv2.COLOR_BGR2GRAY)
        cut, curr_hist = is_scene_cut(prev_gray, curr_gray, prev_hist)
        prev_gray = curr_gray
        prev_hist = curr_hist

        rx1 = max(0, prev_cx - margin_x - sw // 2)
        ry1 = max(0, prev_cy - margin_y - sh // 2)
        rx2 = min(width,  prev_cx + margin_x + sw // 2)
        ry2 = min(height, prev_cy + margin_y + sh // 2)

        region = frame[ry1:ry2, rx1:rx2]
        if region.shape[0] < tmpl_small.shape[0] or region.shape[1] < tmpl_small.shape[1]:
            results.append((prev_cx, prev_cy, False, cut))
            continue

        region_small = cv2.resize(region, (
            max(1, int((rx2 - rx1) * scale)),
            max(1, int((ry2 - ry1) * scale)),
        ))

        try:
            match_res = cv2.matchTemplate(region_small, tmpl_small, cv2.TM_CCOEFF_NORMED)
            _, max_val, _, max_loc = cv2.minMaxLoc(match_res)
        except Exception:
            results.append((prev_cx, prev_cy, False, cut))
            continue

        if max_val < 0.30:
            results.append((prev_cx, prev_cy, False, cut))
            continue

        match_x = int(max_loc[0] / scale) + rx1 + sw // 2
        match_y = int(max_loc[1] / scale) + ry1 + sh // 2
        prev_cx, prev_cy = match_x, match_y
        results.append((match_x, match_y, True, cut))

    return results


# ---------------------------------------------------------------------------
# Frame Extraction for UI Picker
# ---------------------------------------------------------------------------

def extract_frame(video_path, timestamp_sec, output_path):
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

    h, w = frame.shape[:2]
    max_w = 960
    if w > max_w:
        scale = max_w / w
        frame = cv2.resize(frame, (max_w, int(h * scale)))

    cv2.imwrite(output_path, frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
    print(f'Frame extracted: {output_path}', file=sys.stderr)


# ---------------------------------------------------------------------------
# Main Routine
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

    n_samples = max(15, min(args.samples, 90))
    sample_times = [
        args.start + (i / max(n_samples - 1, 1)) * duration
        for i in range(n_samples)
    ]

    script_dir = os.path.dirname(os.path.abspath(__file__))

    # ── Manual mode ───────────────────────────────────────────────────────
    if args.subject_bbox:
        try:
            parts = [int(v) for v in args.subject_bbox.split(',')]
            subject_bbox = tuple(parts[:4])
            seed_time = args.subject_seed_time if args.subject_seed_time is not None else args.start
            tracking_results = track_with_template(
                cap, sample_times, seed_time, subject_bbox, width, height
            )
            cap.release()

            camera = DeadbandCamera(width, height, deadband_x_ratio=0.12, deadband_y_ratio=0.18, alpha_move=0.30)
            frames_out = []
            for i, (t, (cx, cy, has_subj, is_cut)) in enumerate(zip(sample_times, tracking_results)):
                cam_cx, cam_cy = camera.update(cx, cy, is_cut=is_cut)
                frames_out.append({
                    'frameIndex':  i,
                    'timestampMs': int(t * 1000),
                    'cx':          cam_cx,
                    'cy':          cam_cy,
                    'hasFace':     has_subj,
                    'faceSpanW':   0,
                    'confidence':  0.85 if has_subj else 0.3,
                    'isCut':       is_cut,
                })

            result = {
                'frames': frames_out,
                'avgCx': int(sum(f['cx'] for f in frames_out) / len(frames_out)) if frames_out else width // 2,
                'avgCy': int(sum(f['cy'] for f in frames_out) / len(frames_out)) if frames_out else height // 3,
                'width': width, 'height': height,
                'mode': 'manual',
            }
            with open(args.output, 'w') as f:
                json.dump(result, f)
            print(f'Manual tracking complete: {len(frames_out)} frames', file=sys.stderr)
            return
        except Exception as e:
            print(f'Manual tracking failed: {e}, falling back to auto', file=sys.stderr)

    # ── Initialize Primary YOLO-Pose Tracker ──────────────────────────────
    yolo_tracker = YOLOPoseTracker(script_dir)

    # ── Initialize MediaPipe Fallback ──────────────────────────────────────
    mp_detector_full, mp_detector_short = None, None
    try:
        import mediapipe as mp
        from mediapipe.tasks import python as mp_python
        from mediapipe.tasks.python import vision as mp_vision

        model_full  = os.path.join(script_dir, 'blaze_face_full_range.tflite')
        model_short = os.path.join(script_dir, 'blaze_face_short_range.tflite')

        def _make_detector(model_path):
            return mp_vision.FaceDetector.create_from_options(
                mp_vision.FaceDetectorOptions(
                    base_options=mp_python.BaseOptions(model_asset_path=model_path),
                    running_mode=mp_vision.RunningMode.IMAGE,
                    min_detection_confidence=0.25,
                )
            )

        if os.path.exists(model_full):
            mp_detector_full = _make_detector(model_full)
        if os.path.exists(model_short):
            mp_detector_short = _make_detector(model_short)
    except Exception:
        pass

    # ── Initialize OpenCV Fallback ─────────────────────────────────────────
    face_cascade_path = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
    body_cascade_path = cv2.data.haarcascades + 'haarcascade_upperbody.xml'
    face_cascade = cv2.CascadeClassifier(face_cascade_path) if os.path.exists(face_cascade_path) else None
    body_cascade = cv2.CascadeClassifier(body_cascade_path) if os.path.exists(body_cascade_path) else None

    # Tracking storage
    raw_detections = []
    has_detection_list = []
    face_span_list = []
    detection_types = []
    is_cut_list = []
    all_detections_per_frame = []
    detected_boxes_at_start = []

    prev_cx = None
    prev_gray = None
    prev_hist = None

    for idx, t in enumerate(sample_times):
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
        ret, frame = cap.read()
        if not ret:
            cx = prev_cx if prev_cx is not None else width // 2
            raw_detections.append((cx, height // 3))
            has_detection_list.append(False)
            face_span_list.append(0)
            detection_types.append('none')
            is_cut_list.append(False)
            all_detections_per_frame.append([])
            continue

        # 1. Shot / Scene Cut Detection
        low_res = cv2.resize(frame, (320, 180))
        curr_gray = cv2.cvtColor(low_res, cv2.COLOR_BGR2GRAY)
        cut, curr_hist = is_scene_cut(prev_gray, curr_gray, prev_hist)
        prev_gray = curr_gray
        prev_hist = curr_hist
        is_cut_list.append(cut)

        # 2. Subject Detection Pipeline
        target_cx, target_cy = None, None
        span_w = 0
        det_type = 'none'
        frame_all_faces = []

        # A) Primary: YOLOv8-Pose
        if yolo_tracker.is_available():
            best_person, all_boxes, all_faces = yolo_tracker.track_frame(frame, width, height, prev_cx)
            frame_all_faces = all_faces
            if idx == 0 and all_boxes:
                detected_boxes_at_start = [{'x': b[0], 'y': b[1], 'w': b[2], 'h': b[3]} for b in all_boxes]

            if best_person:
                target_cx, target_cy, span_w, _, _ = best_person
                det_type = 'yolo_pose'

        # B) Fallback: MediaPipe BlazeFace
        if target_cx is None and (mp_detector_full or mp_detector_short):
            scale = min(1.0, 720 / width)
            small = cv2.resize(frame, (int(width * scale), int(height * scale)))
            mp_boxes = detect_subjects_mediapipe(small, (mp_detector_full, mp_detector_short), scale, width, height)
            if mp_boxes:
                best_face = pick_best_detection(mp_boxes, width, height, prev_cx)
                if best_face:
                    target_cx, target_cy = best_face
                    det_type = 'mediapipe_face'
                frame_all_faces = [{'cx': int(b[0] + b[2]/2), 'cy': int(b[1] + b[3]/2), 'w': b[2], 'h': b[3]} for b in mp_boxes]
                if idx == 0 and not detected_boxes_at_start:
                    detected_boxes_at_start = [{'x': b[0], 'y': b[1], 'w': b[2], 'h': b[3]} for b in mp_boxes]

        # C) Fallback: OpenCV Haar Cascade
        if target_cx is None and face_cascade is not None:
            scale = min(1.0, 480 / width)
            small_gray = cv2.cvtColor(cv2.resize(frame, (int(width * scale), int(height * scale))), cv2.COLOR_BGR2GRAY)
            cv_boxes, cv_type = detect_subjects_opencv(small_gray, face_cascade, body_cascade, scale, width, height)
            if cv_boxes:
                best_cv = pick_best_detection(cv_boxes, width, height, prev_cx)
                if best_cv:
                    target_cx, target_cy = best_cv
                    det_type = f'opencv_{cv_type}'
                frame_all_faces = [{'cx': int(b[0] + b[2]/2), 'cy': int(b[1] + b[3]/2), 'w': b[2], 'h': b[3]} for b in cv_boxes]
                if idx == 0 and not detected_boxes_at_start:
                    detected_boxes_at_start = [{'x': b[0], 'y': b[1], 'w': b[2], 'h': b[3]} for b in cv_boxes]

        all_detections_per_frame.append(frame_all_faces)

        if target_cx is not None:
            prev_cx = target_cx
            raw_detections.append((target_cx, target_cy))
            has_detection_list.append(True)
            face_span_list.append(span_w)
            detection_types.append(det_type)
        else:
            cx = prev_cx if prev_cx is not None else width // 2
            raw_detections.append((cx, height // 3))
            has_detection_list.append(False)
            face_span_list.append(0)
            detection_types.append('none')

    cap.release()

    # ── Scene-Aware Gap Filling ────────────────────────────────────────────
    processed_positions = list(raw_detections)
    n_frames = len(processed_positions)

    scene_segments = []
    seg_start = 0
    for i in range(1, n_frames):
        if is_cut_list[i]:
            scene_segments.append((seg_start, i))
            seg_start = i
    scene_segments.append((seg_start, n_frames))

    for s_start, s_end in scene_segments:
        seg_has_det = [has_detection_list[k] for k in range(s_start, s_end)]
        if any(seg_has_det):
            first_idx = next(k for k in range(s_start, s_end) if has_detection_list[k])
            last_idx  = max(k for k in range(s_start, s_end) if has_detection_list[k])
            for k in range(s_start, first_idx):
                processed_positions[k] = processed_positions[first_idx]
            for k in range(last_idx + 1, s_end):
                processed_positions[k] = processed_positions[last_idx]
            curr = first_idx
            while curr < last_idx:
                if not has_detection_list[curr]:
                    gap_st = curr
                    gap_ed = curr
                    while gap_ed <= last_idx and not has_detection_list[gap_ed]:
                        gap_ed += 1
                    p0 = processed_positions[gap_st - 1]
                    p1 = processed_positions[gap_ed]
                    gap_len = gap_ed - gap_st
                    for j in range(gap_st, gap_ed):
                        ratio = (j - gap_st + 1) / (gap_len + 1)
                        processed_positions[j] = (
                            int(p0[0] + ratio * (p1[0] - p0[0])),
                            int(p0[1] + ratio * (p1[1] - p0[1]))
                        )
                    curr = gap_ed
                else:
                    curr += 1

    # ── Apply Virtual Cameraman Deadband Box ───────────────────────────────
    camera = DeadbandCamera(width, height, deadband_x_ratio=0.15, deadband_y_ratio=0.20, alpha_move=0.25)
    frames_out = []

    for i in range(n_frames):
        t = sample_times[i]
        tgt_x, tgt_y = processed_positions[i]
        cut = is_cut_list[i]
        cam_cx, cam_cy = camera.update(tgt_x, tgt_y, is_cut=cut)

        frames_out.append({
            'frameIndex':  i,
            'timestampMs': int(t * 1000),
            'cx':          cam_cx,
            'cy':          cam_cy,
            'hasFace':     has_detection_list[i],
            'faceSpanW':   face_span_list[i],
            'confidence':  0.95 if has_detection_list[i] else 0.25,
            'detType':     detection_types[i],
            'isCut':       cut,
        })

    face_frames = [f for f in frames_out if f['hasFace']]
    use_frames  = face_frames if face_frames else frames_out

    avg_cx = int(sum(f['cx'] for f in use_frames) / len(use_frames)) if use_frames else width // 2
    avg_cy = int(sum(f['cy'] for f in use_frames) / len(use_frames)) if use_frames else height // 3

    # Cluster distinct speakers for split/quad layouts
    all_face_centers = []
    for frame_faces in all_detections_per_frame:
        for fc in frame_faces:
            all_face_centers.append((fc['cx'], fc['cy']))

    distinct_speakers = []
    cluster_radius_x = width * 0.20
    cluster_radius_y = height * 0.25

    for (fcx, fcy) in all_face_centers:
        merged = False
        for sp in distinct_speakers:
            if abs(fcx - sp['cx']) < cluster_radius_x and abs(fcy - sp['cy']) < cluster_radius_y:
                sp['count'] += 1
                sp['cx'] = int(sp['cx'] + (fcx - sp['cx']) / sp['count'])
                sp['cy'] = int(sp['cy'] + (fcy - sp['cy']) / sp['count'])
                merged = True
                break
        if not merged:
            distinct_speakers.append({'cx': fcx, 'cy': fcy, 'count': 1})

    distinct_speakers.sort(key=lambda s: s['count'], reverse=True)
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

    yolo_count = sum(1 for d in detection_types if d == 'yolo_pose')
    mp_count   = sum(1 for d in detection_types if d == 'mediapipe_face')
    cut_count  = sum(1 for c in is_cut_list if c)
    print(
        f'Top-tier Tracking Complete: {len(frames_out)} frames ({yolo_count} YOLO-Pose, '
        f'{mp_count} MediaPipe, {cut_count} Scene Cuts, Deadband Active)',
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


if __name__ == '__main__':
    main()
