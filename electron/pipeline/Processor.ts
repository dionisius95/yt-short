/**
 * Processor — FFmpeg-based clip cutter with subtitle overlay and auto-zoom.
 *
 * Takes a source video, a time range (startMs/endMs), subtitle words, and
 * rendering options, then produces a 9:16 vertical short-form clip.
 */

import { spawn, ChildProcess, execFile } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { BrowserWindow } from 'electron';
import { CHANNELS } from '../ipc/channels';
import { createLogger } from '../utils/logger';
import { Tracker } from './Tracker';
import type { TranscriptWord, SubtitleStyle, SubtitlePosition, CropFrame, CaptionStyle, CaptionPresetId, LogoOverlay, LayoutPreset, SplitLayout, GameRatio, GamePosition, LetterboxBackground, TitleOverlay, CommentatorTransitionEffect } from '../../shared/types';
import { CAPTION_PRESETS } from '../../shared/types';

const log = createLogger('Processor');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProcessOptions {
  clipId:           string;
  projectId:        string;
  sourceFile:       string;
  startMs:          number;
  endMs:            number;
  outputPath:       string;
  subtitleStyle:    SubtitleStyle;
  subtitlePosition: SubtitlePosition;
  zoomEnabled:      boolean;
  words:            TranscriptWord[];
  cropFrames?:      CropFrame[];
  captionStyle?:    CaptionStyle;
  logoOverlay?:     LogoOverlay;
  /** 'auto' = face/body detection (default), 'manual' = user-selected bbox, 'none' = center crop, 'speaker' = active speaker tracking */
  trackingMode?:    'auto' | 'manual' | 'none' | 'speaker';
  /** Manual mode: user-selected subject bbox in original video pixels {x,y,w,h} */
  subjectBbox?:     { x: number; y: number; w: number; h: number };
  /** Manual mode: timestamp (ms) where subjectBbox was selected */
  subjectSeedMs?:   number;
  /** Layout preset: 'normal' (default), 'split' (multi-speaker), 'game' (gameplay+facecam), 'letterbox' (fit+bg) */
  layoutPreset?:    LayoutPreset;
  /** Split layout direction (only used when layoutPreset === 'split') */
  splitLayout?:     SplitLayout;
  /** Game layout ratio — gameplay:facecam height (only used when layoutPreset === 'game') */
  gameRatio?:       GameRatio;
  /** Game layout position — gameplay overlay at top or bottom (only used when layoutPreset === 'game') */
  gamePosition?:    GamePosition;
  /** Letterbox background options (only used when layoutPreset === 'letterbox') */
  letterboxBg?:     LetterboxBackground;
  /** Static title overlay — user-typed text burned in for full clip duration */
  titleOverlay?:    TitleOverlay;
  /** Custom thumbnail image path — prepended as 1-second still frame at start of clip */
  thumbnailPath?:   string;
  /** Audio treatment: 'keep' (default), 'mute' (strip audio), 'replace' (swap with music). */
  audioMode?:       'keep' | 'mute' | 'replace';
  /** Replacement audio/music file path (used when audioMode === 'replace'). */
  replacementAudioPath?: string;
  /** Replacement music volume 0.0-1.0 (used when audioMode === 'replace'). Default 0.8. */
  musicVolume?:     number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emitProgress(clipId: string, percent: number, eta = ''): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(CHANNELS.CLIP_PROGRESS, { clipId, percent, eta });
    }
  }
}

// ---------------------------------------------------------------------------
// FFmpeg helpers
// ---------------------------------------------------------------------------

function runProcess(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    proc.on('error', (e) => reject(new Error(`${command} spawn error: ${e.message}`)));
    proc.on('close', (code) => {
      if (code !== 0) reject(new Error(`${command} exited ${code}: ${stderr.slice(-400)}`));
      else resolve();
    });
  });
}

/** Emit commentator:progress IPC to all BrowserWindows */
function emitCommentaryProgress(percent: number, message: string) {
  try {
    const { BrowserWindow } = require('electron');
    const wins = BrowserWindow.getAllWindows();
    for (const win of wins) {
      if (!win.isDestroyed()) {
        win.webContents.send('commentator:progress', { percent, stage: 'render', message });
      }
    }
  } catch {}
}

/**
 * Run FFmpeg with real-time progress reporting via commentator:progress IPC.
 * Parses time=HH:MM:SS.cs from stderr and maps it to percent range [startPct, endPct].
 */
function runProcessWithRealtimeProgress(
  args: string[],
  totalDurationSec: number,
  startPct: number,
  endPct: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let lastEmittedPct = startPct;

    proc.stderr.on('data', (c: Buffer) => {
      const chunk = c.toString();
      stderr += chunk;
      const match = chunk.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (match && totalDurationSec > 0) {
        const elapsedSec =
          parseInt(match[1], 10) * 3600 +
          parseInt(match[2], 10) * 60 +
          parseFloat(match[3]);
        const progress = Math.min(1, elapsedSec / totalDurationSec);
        const pct = Math.round(startPct + progress * (endPct - startPct));
        if (pct > lastEmittedPct) {
          lastEmittedPct = pct;
          try {
            const { BrowserWindow } = require('electron');
            const wins = BrowserWindow.getAllWindows();
            for (const win of wins) {
              if (!win.isDestroyed()) {
                win.webContents.send('commentator:progress', {
                  percent: pct,
                  stage: 'render',
                  message: `Rendering final video... ${pct}%`,
                });
              }
            }
          } catch {}
        }
      }
    });

    proc.on('error', (e) => reject(new Error(`ffmpeg spawn error: ${e.message}`)));
    proc.on('close', (code) => {
      if (code !== 0) reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-400)}`));
      else resolve();
    });
  });
}

/**
 * Run FFmpeg with accurate seeking and progress reporting.
 * Returns the ChildProcess so the caller can kill it for cancellation.
 */
function runFfmpegWithProgress(
  clipId: string,
  args: string[],
  totalSec: number,
): { promise: Promise<void>; proc: ChildProcess } {
  let proc!: ChildProcess;

  const promise = new Promise<void>((resolve, reject) => {
    proc = spawn('ffmpeg', ['-y', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    proc.stderr?.on('data', (c: Buffer) => {
      const chunk = c.toString();
      stderr += chunk;
      // Parse "time=HH:MM:SS.cs" from FFmpeg stderr progress
      const match = chunk.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (match && totalSec > 0) {
        const elapsedSec =
          parseInt(match[1], 10) * 3600 +
          parseInt(match[2], 10) * 60 +
          parseFloat(match[3]);
        const pct = Math.min(95, 25 + Math.round((elapsedSec / totalSec) * 70));
        emitProgress(clipId, pct);
      }
    });

    proc.on('error', (e) => reject(new Error(`ffmpeg spawn error: ${e.message}`)));
    proc.on('close', (code, signal) => {
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        reject(new Error('ffmpeg cancelled'));
        return;
      }
      if (code !== 0) {
        const cmd = ['ffmpeg', '-y', ...args].join(' ');
        reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-1200)}\n\nCMD: ${cmd}`));
      } else {
        resolve();
      }
    });
  });

  return { promise, proc };
}

// ---------------------------------------------------------------------------
// Crop filter builder — dynamic subject tracking 9:16 crop
// ---------------------------------------------------------------------------

/**
 * Build an FFmpeg filter for smooth dynamic subject tracking.
 *
 * CapCut-style auto reframe:
 * - Per-frame crop positions (cx, cy) from detect_faces.py
 * - Dynamic crop X AND Y — face is always fully inside the 9:16 frame
 * - Head-room padding: face center placed at ~35% from top (not centered),
 *   matching natural portrait framing (eyes in upper third)
 * - Smooth keyframe interpolation via FFmpeg `if(lt(t,...))` expressions
 * - Multi-face: zoom out so both faces fit inside the 1080px crop width
 *
 * Source assumed landscape → output 1080×1920 (9:16).
 *
 * KEY FIX: crop Y is now dynamic, derived from cy with head-room offset.
 * Previously crop Y was always 0 (top of frame), causing wajah terpotong.
 */
function buildCropFilter(
  cropFrames: CropFrame[],
  startMs: number,
  _endMs: number,
  srcWidth = 1920,
  srcHeight = 1080,
  targetAR: '9:16' | '1:1' | '4:3' = '9:16',
): string {
  let targetCropW = 1080;
  let targetCropH = 1920;
  if (targetAR === '1:1') {
    targetCropW = 1080;
    targetCropH = 1080;
  } else if (targetAR === '4:3') {
    targetCropW = 1080;
    targetCropH = 810;
  }

  // Guard: vertical/square source or narrower than target aspect ratio
  const srcAspect = srcWidth / srcHeight;
  const targetAspect = targetCropW / targetCropH;
  if (srcAspect <= targetAspect) {
    return `scale=${targetCropW}:${targetCropH}:force_original_aspect_ratio=decrease:flags=lanczos,` +
           `pad=${targetCropW}:${targetCropH}:(ow-iw)/2:(oh-ih)/2:black,` +
           `setsar=1`;
  }

  // Guard: source too narrow after scaling to targetCropH — treat same as vertical
  const scaledWidthCheck = Math.round(srcWidth * (targetCropH / srcHeight));
  if (scaledWidthCheck < targetCropW) {
    return `scale=${targetCropW}:${targetCropH}:force_original_aspect_ratio=decrease:flags=lanczos,` +
           `pad=${targetCropW}:${targetCropH}:(ow-iw)/2:(oh-ih)/2:black,` +
           `setsar=1`;
  }

  if (cropFrames.length === 0) {
    return `scale=-2:${targetCropH},crop=${targetCropW}:${targetCropH}:(iw-${targetCropW})/2:0`;
  }

  // ── Scale factor: fit source into scaled canvas ──────────────────────────
  // For multi-face: we may need to zoom out horizontally so both faces fit.
  // For single face: scale to targetCropH for maximum quality.
  const detectedFrames = cropFrames.filter((f) => f.hasFace);
  const multiFrames = detectedFrames.filter((f) => (f.faceSpanW ?? 0) > 0);
  let targetScaleH = targetCropH;

  if (multiFrames.length > 0) {
    const spans = multiFrames.map((f) => f.faceSpanW ?? 0).sort((a, b) => a - b);
    const medianSpan = spans[Math.floor(spans.length / 2)];
    // 1.4× headroom so faces aren't edge-to-edge in targetCropW
    const requiredCropW = Math.round(medianSpan * 1.4);
    if (requiredCropW > targetCropW) {
      const ratio = targetCropW / requiredCropW;
      targetScaleH = Math.max(targetCropH, Math.round(ratio * targetCropH));
    }
  }

  // Even dimensions for libx264
  targetScaleH = targetScaleH % 2 === 0 ? targetScaleH : targetScaleH + 1;

  const scaleFactor = targetScaleH / srcHeight;
  const scaledWidth = Math.round(srcWidth * scaleFactor);
  const evenScaledWidth = Math.max(targetCropW, scaledWidth % 2 === 0 ? scaledWidth : scaledWidth + 1);
  const maxScaledH = targetScaleH; // after scale, frame is exactly this tall

  const useFrames = detectedFrames.length > 0 ? detectedFrames : cropFrames;

  // ── Helper: compute crop X for a given frame ────────────────────────────
  // Keeps the full face span (or single face) inside targetCropW with
  // a minimum margin on both sides.
  function computeCropX(f: CropFrame): number {
    const scaledCx = Math.round(f.cx * scaleFactor);
    const scaledFaceW = (f.faceSpanW ?? 0) * scaleFactor;
    const margin = Math.max(60, Math.min(150, (targetCropW - scaledFaceW) / 4));
    const faceLeft  = scaledCx - scaledFaceW / 2;
    const faceRight = scaledCx + scaledFaceW / 2;
    const xMin = Math.max(0, Math.round(faceRight + margin) - targetCropW);
    const xMax = Math.min(evenScaledWidth - targetCropW, Math.round(faceLeft  - margin));
    if (xMin <= xMax) {
      return Math.round((xMin + xMax) / 2);
    }
    // Face too wide for margins → just center on face
    return Math.max(0, Math.min(evenScaledWidth - targetCropW, scaledCx - Math.round(targetCropW / 2)));
  }

  // ── Helper: compute crop Y for a given frame ────────────────────────────
  const HEAD_ROOM = targetAR === '9:16' ? 0.35 : 0.40;
  function computeCropY(f: CropFrame): number {
    const scaledCy = Math.round(f.cy * scaleFactor);
    // Desired top of crop: place face center at HEAD_ROOM × targetCropH
    let cropY = Math.round(scaledCy - HEAD_ROOM * targetCropH);
    // Clamp so crop never exceeds the scaled frame
    cropY = Math.max(0, Math.min(maxScaledH - targetCropH, cropY));
    return cropY;
  }

  // ── Safety net: empty useFrames ─────────────────────────────────────────
  if (useFrames.length === 0) {
    const sf = targetScaleH / srcHeight;
    const sw = Math.max(targetCropW, Math.round(srcWidth * sf) % 2 === 0 ? Math.round(srcWidth * sf) : Math.round(srcWidth * sf) + 1);
    const avgCx = cropFrames.length > 0
      ? Math.round(cropFrames.reduce((s, f) => s + f.cx, 0) / cropFrames.length * sf)
      : Math.round(sw / 2);
    const avgCy = cropFrames.length > 0
      ? Math.round(cropFrames.reduce((s, f) => s + f.cy, 0) / cropFrames.length * sf)
      : Math.round(targetScaleH * HEAD_ROOM);
    const cropX = Math.max(0, Math.min(sw - targetCropW, avgCx - Math.round(targetCropW / 2)));
    const cropY = Math.max(0, Math.min(targetScaleH - targetCropH, avgCy - Math.round(HEAD_ROOM * targetCropH)));
    return `scale=${sw}:${targetScaleH},crop=${targetCropW}:${targetCropH}:${cropX}:${cropY}`;
  }

  // ── Single frame ─────────────────────────────────────────────────────────
  if (useFrames.length === 1) {
    const cropX = computeCropX(useFrames[0]);
    const cropY = computeCropY(useFrames[0]);
    return `scale=${evenScaledWidth}:${targetScaleH},crop=${targetCropW}:${targetCropH}:${cropX}:${cropY}`;
  }

  // ── Multi-frame: build keyframe timeline ─────────────────────────────────
  const clipStartSec = startMs / 1000;

  const keyframes = useFrames.map((f) => {
    const tSec = Math.max(0, f.timestampMs / 1000 - clipStartSec);
    return { t: tSec, x: computeCropX(f), y: computeCropY(f) };
  });

  keyframes.sort((a, b) => a.t - b.t);

  // Ensure crop starts at t=0
  if (keyframes[0].t > 0.05) {
    keyframes.unshift({ t: 0, x: keyframes[0].x, y: keyframes[0].y });
  }

  // Cap at 30 keyframes to avoid FFmpeg expression depth overflow
  const MAX_KEYFRAMES = 30;
  if (keyframes.length > MAX_KEYFRAMES) {
    const step = (keyframes.length - 1) / (MAX_KEYFRAMES - 1);
    const sampled: typeof keyframes = [];
    for (let i = 0; i < MAX_KEYFRAMES; i++) {
      sampled.push(keyframes[Math.round(i * step)]);
    }
    keyframes.length = 0;
    keyframes.push(...sampled);
  }

  // ── Build FFmpeg piecewise-linear expression for X and Y ─────────────────
  function buildLerpExpr(axis: 'x' | 'y'): string {
    if (keyframes.length <= 1) return String(keyframes[0]?.[axis] ?? 0);

    let expr = String(keyframes[keyframes.length - 1][axis]);

    for (let i = keyframes.length - 2; i >= 0; i--) {
      const k0 = keyframes[i];
      const k1 = keyframes[i + 1];
      const dt = k1.t - k0.t;
      const dv = k1[axis] - k0[axis];

      let segExpr: string;
      if (dt < 0.001 || dv === 0) {
        segExpr = String(k0[axis]);
      } else {
        segExpr = `${k0[axis]}+${dv}*(min(max(t\\,${k0.t.toFixed(3)})\\,${k1.t.toFixed(3)})-${k0.t.toFixed(3)})/${dt.toFixed(3)}`;
      }

      expr = `if(lt(t\\,${k1.t.toFixed(3)})\\,${segExpr}\\,${expr})`;
    }

    return expr;
  }

  const cropXExpr = buildLerpExpr('x');
  const cropYExpr = buildLerpExpr('y');

  const maxX = evenScaledWidth - targetCropW;
  const maxY = maxScaledH - targetCropH;

  const clampedX = `min(max(${cropXExpr}\\,0)\\,${maxX})`;
  const clampedY = maxY > 0
    ? `min(max(${cropYExpr}\\,0)\\,${maxY})`
    : '0'; // source fits vertically — no vertical movement needed

  return `scale=${evenScaledWidth}:${targetScaleH},crop=${targetCropW}:${targetCropH}:${clampedX}:${clampedY}`;
}

// ---------------------------------------------------------------------------
// Logo overlay filter builder
// ---------------------------------------------------------------------------

/**
 * Build FFmpeg filter_complex args for logo overlay.
 * Assumes main video stream is [0:v], logo input is [1:v].
 * Output labeled [vout].
 * Canvas is 1080×1920 (after crop).
 */
function buildLogoFilterComplex(
  baseVf: string,
  logo: LogoOverlay,
): string {
  const logoW = Math.round(1080 * logo.scale);
  const margin = logo.margin;

  let x: string;
  let y: string;
  switch (logo.position) {
    case 'top-left':     x = `${margin}`;      y = `${margin}`;      break;
    case 'top-right':    x = `W-w-${margin}`;  y = `${margin}`;      break;
    case 'bottom-left':  x = `${margin}`;      y = `H-h-${margin}`;  break;
    case 'bottom-right': x = `W-w-${margin}`;  y = `H-h-${margin}`;  break;
    case 'center':       x = `(W-w)/2`;        y = `(H-h)/2`;        break;
    default:             x = `W-w-${margin}`;  y = `${margin}`;
  }

  // filter_complex:
  // 1. Apply crop+subtitles to [0:v] → label [base]
  // 2. Scale logo [1:v] → apply alpha → label [logo]
  // 3. Overlay [logo] on [base] → [vout]
  return (
    `[0:v]${baseVf}[base];` +
    `[1:v]format=rgba,scale=${logoW}:-1,` +
    `colorchannelmixer=aa=${logo.opacity.toFixed(3)}[logo];` +
    `[base][logo]overlay=${x}:${y}[vout]`
  );
}

// ---------------------------------------------------------------------------
// Video dimension helper
// ---------------------------------------------------------------------------

function getVideoDimensions(filePath: string): { width: number; height: number } {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execSync } = require('child_process') as typeof import('child_process');
    const raw = execSync(
      `ffprobe -v quiet -print_format json -show_streams -select_streams v:0 "${filePath}"`,
      { stdio: 'pipe', timeout: 10000 }
    ).toString();
    const data = JSON.parse(raw) as { streams: Array<{ width?: number; height?: number }> };
    const s = data.streams[0];
    if (s?.width && s?.height) return { width: s.width, height: s.height };
    log.warn({ filePath }, 'ffprobe returned no dimensions, using 1920x1080 default');
  } catch (err) {
    log.warn({ filePath, err }, 'ffprobe failed to get video dimensions, using 1920x1080 default');
  }
  return { width: 1920, height: 1080 }; // safe default
}

function hasAudioStream(filePath: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execSync } = require('child_process') as typeof import('child_process');
    const raw = execSync(
      `ffprobe -v quiet -print_format json -show_streams -select_streams a "${filePath}"`,
      { stdio: 'pipe', timeout: 10000 }
    ).toString();
    const data = JSON.parse(raw) as { streams: Array<unknown> };
    return !!(data?.streams && data.streams.length > 0);
  } catch (err) {
    log.warn({ filePath, err }, 'ffprobe failed to check audio streams, assuming yes');
    return true;
  }
}


// ---------------------------------------------------------------------------
// Split layout filter builder
// ---------------------------------------------------------------------------

/**
 * Build FFmpeg filter_complex for split-screen layout.
 *
 * Takes the same source video and crops different regions for each speaker,
 * then stacks them to fill the 1080×1920 (9:16) canvas.
 *
 * Layouts:
 *   top-bottom : two 1080×960 crops stacked vertically
 *   left-right : two 540×1920 crops side by side
 *   quad       : four 540×960 crops in 2×2 grid
 *
 * Each crop region is centered on a detected speaker face (from cropFrames),
 * or falls back to left/right/center regions of the source.
 *
 * assPath is applied to the bottom/right panel only (where the main speaker is).
 */
function computeLogoCoords(logo: LogoOverlay): { lx: string; ly: string } {
  const margin = logo.margin;
  let lx: string;
  let ly: string;

  if (logo.y !== undefined) {
    ly = `${Math.round(logo.y)}`;
  } else {
    switch (logo.position) {
      case 'top-left':
      case 'top-right':    ly = `${margin}`; break;
      case 'bottom-left':
      case 'bottom-right': ly = `H-h-${margin}`; break;
      case 'center':       ly = `(H-h)/2`; break;
      default:             ly = `${margin}`;
    }
  }

  if (logo.x !== undefined) {
    lx = `${Math.round(logo.x)}`;
  } else {
    switch (logo.position) {
      case 'top-left':
      case 'bottom-left':  lx = `${margin}`; break;
      case 'top-right':
      case 'bottom-right': lx = `W-w-${margin}`; break;
      case 'center':       lx = `(W-w)/2`; break;
      default:             lx = `W-w-${margin}`;
    }
  }

  return { lx, ly };
}

function buildSplitFilterComplex(
  splitLayout: import('../../shared/types').SplitLayout,
  cropFrames: CropFrame[],
  assPath: string,
  srcWidth: number,
  srcHeight: number,
  logo?: LogoOverlay,
  speakerPositions?: Array<{ cx: number; cy: number }>,
): string {
  // Escape ASS path for FFmpeg filter_complex subtitles filter
  // Use filename= prefix to prevent Windows drive letter being parsed as option key
  const escaped = assPath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:');
  const assEsc = getAssEsc(escaped);

  // Helper: append logo overlay on top of [sub] → [vout] if logo provided
  // Logo input is [1:v] (second -i in ffmpegArgs)
  const withLogo = (graph: string): string => {
    if (!logo) return graph.replace('[sub]', '[vout]');
    const logoW  = Math.round(1080 * logo.scale);
    const { lx, ly } = computeLogoCoords(logo);
    return (
      graph +
      `;[1:v]format=rgba,scale=${logoW}:-1,colorchannelmixer=aa=${logo.opacity.toFixed(3)}[logo];` +
      `[sub][logo]overlay=${lx}:${ly}[vout]`
    );
  };

  // Detect speaker face positions from cropFrames
  // Group frames by left/right half to identify 2 speakers
  const leftFrames  = cropFrames.filter((f) => f.hasFace && f.cx < srcWidth * 0.65);
  const rightFrames = cropFrames.filter((f) => f.hasFace && f.cx >= srcWidth * 0.65);

  const leftCx  = leftFrames.length  > 0 ? Math.round(leftFrames.reduce((s, f) => s + f.cx, 0)  / leftFrames.length)  : Math.round(srcWidth * 0.25);
  const rightCx = rightFrames.length > 0 ? Math.round(rightFrames.reduce((s, f) => s + f.cx, 0) / rightFrames.length) : Math.round(srcWidth * 0.75);

  // Scale factor: source → 1920px height
  const scale = 1920 / srcHeight;
  // Use explicit even width to match FFmpeg output exactly (avoids crop out-of-bounds)
  const scaledW = Math.round(srcWidth * scale) % 2 === 0
    ? Math.round(srcWidth * scale)
    : Math.round(srcWidth * scale) - 1;

  // Clamp crop X for 1080px wide crop
  const clamp = (cx: number) => Math.max(0, Math.min(Math.round(cx * scale) - 540, scaledW - 1080));

  const leftX  = clamp(leftCx);
  const rightX = clamp(rightCx);

  if (splitLayout === 'left-right') {
    // [src] used 2× → split=2
    const lx = Math.max(0, Math.min(Math.round(leftCx  * scale) - 270, scaledW - 540));
    const rx = Math.max(0, Math.min(Math.round(rightCx * scale) - 270, scaledW - 540));
    return withLogo(
      `[0:v]scale=${scaledW}:1920,split=2[src1][src2];` +
      `[src1]crop=540:1920:${lx}:0[left];` +
      `[src2]crop=540:1920:${rx}:0[right];` +
      `[left][right]hstack=inputs=2[stacked];` +
      `[stacked]subtitles=${assEsc}[sub]`
    );
  }

  if (splitLayout === 'quad') {
    // 2×2 grid: each panel 540×960, total 1080×1920
    // Use individual speaker positions detected by face detection script.
    // Each panel is centered on a speaker's face (both X and Y).

    const panelW = 540;
    const panelH = 960;

    // Use speakerPositions from face detection (individual face clusters)
    // Fall back to cropFrame-based estimation if not available
    type SpeakerPos = { cx: number; cy: number };
    let speakers: SpeakerPos[] = [];

    if (speakerPositions && speakerPositions.length > 0) {
      // Use pre-clustered speaker positions from Python detection
      speakers = speakerPositions.slice(0, 4).map((sp) => ({ cx: sp.cx, cy: sp.cy }));
    } else {
      // Fallback: derive from cropFrames (less accurate for 3-4 speakers)
      const faceFrames = cropFrames.filter((f) => f.hasFace);
      if (faceFrames.length > 0) {
        const xMedian = srcWidth * 0.5;
        const leftF  = faceFrames.filter((f) => f.cx < xMedian);
        const rightF = faceFrames.filter((f) => f.cx >= xMedian);

        if (leftF.length > 0) {
          speakers.push({
            cx: Math.round(leftF.reduce((s, f) => s + f.cx, 0) / leftF.length),
            cy: Math.round(leftF.reduce((s, f) => s + f.cy, 0) / leftF.length),
          });
        }
        if (rightF.length > 0) {
          speakers.push({
            cx: Math.round(rightF.reduce((s, f) => s + f.cx, 0) / rightF.length),
            cy: Math.round(rightF.reduce((s, f) => s + f.cy, 0) / rightF.length),
          });
        }
      }
    }

    // Fallback: fill remaining positions with evenly spaced defaults (face area ~35% height)
    const defaults: SpeakerPos[] = [
      { cx: Math.round(srcWidth * 0.25), cy: Math.round(srcHeight * 0.35) },
      { cx: Math.round(srcWidth * 0.75), cy: Math.round(srcHeight * 0.35) },
      { cx: Math.round(srcWidth * 0.25), cy: Math.round(srcHeight * 0.35) },
      { cx: Math.round(srcWidth * 0.75), cy: Math.round(srcHeight * 0.35) },
    ];
    while (speakers.length < 4) {
      speakers.push(defaults[speakers.length]);
    }

    // Compute crop X and Y for each speaker panel in scaled space
    const crops = speakers.slice(0, 4).map((sp) => {
      const sx = Math.round(sp.cx * scale);
      const sy = Math.round(sp.cy * scale);
      const x = Math.max(0, Math.min(sx - Math.round(panelW / 2), scaledW - panelW));
      const y = Math.max(0, Math.min(sy - Math.round(panelH / 2), 1920 - panelH));
      return { x, y };
    });

    return withLogo(
      `[0:v]scale=${scaledW}:1920,split=4[src1][src2][src3][src4];` +
      `[src1]crop=${panelW}:${panelH}:${crops[0].x}:${crops[0].y}[tl];` +
      `[src2]crop=${panelW}:${panelH}:${crops[1].x}:${crops[1].y}[tr];` +
      `[src3]crop=${panelW}:${panelH}:${crops[2].x}:${crops[2].y}[bl];` +
      `[src4]crop=${panelW}:${panelH}:${crops[3].x}:${crops[3].y}[br];` +
      `[tl][tr]hstack=inputs=2[top];` +
      `[bl][br]hstack=inputs=2[bot];` +
      `[top][bot]vstack=inputs=2[stacked];` +
      `[stacked]subtitles=${assEsc}[sub]`
    );
  }

  // Default: top-bottom — two panels each 1080×960, centered on their speaker's face
  // Use average cy from left/right frames to vertically center the face in each panel
  const leftCy  = leftFrames.length  > 0
    ? Math.round(leftFrames.reduce((s, f) => s + f.cy, 0)  / leftFrames.length  * scale)
    : Math.round(1920 * 0.35); // default: upper-third
  const rightCy = rightFrames.length > 0
    ? Math.round(rightFrames.reduce((s, f) => s + f.cy, 0) / rightFrames.length * scale)
    : Math.round(1920 * 0.35);

  // Clamp Y so crop stays within 1920px height
  const clampY = (cy: number) => Math.max(0, Math.min(cy - 480, 1920 - 960));
  const topY    = clampY(leftCy);
  const bottomY = clampY(rightCy);

  return withLogo(
    `[0:v]scale=${scaledW}:1920,split=2[src1][src2];` +
    `[src1]crop=1080:960:${leftX}:${topY}[top];` +
    `[src2]crop=1080:960:${rightX}:${bottomY}[bot];` +
    `[top][bot]vstack=inputs=2[stacked];` +
    `[stacked]subtitles=${assEsc}[sub]`
  );
}

// ---------------------------------------------------------------------------
// Game layout filter builder
// ---------------------------------------------------------------------------

/**
 * Build FFmpeg filter_complex for game layout.
 *
 * Output: 1080×1920 (9:16).
 *
 * Layout:
 *   - Background (full 1080×1920): streamer video, face-tracked crop.
 *     Uses average crop position (no keyframe interpolation) so the filter
 *     string is safe inside filter_complex without escaping issues.
 *   - Gameplay overlay (top, full 1080px wide): center crop of the source
 *     placed flush at the top of the screen.
 *
 * gameRatio controls the gameplay overlay HEIGHT:
 *   '50-50' → gameplay = 960px tall  (50% of screen)
 *   '70-30' → gameplay = 1344px tall (70% of screen — more gameplay visible)
 */
function buildGameFilterComplex(
  cropFrames: CropFrame[],
  assPath: string,
  srcWidth: number,
  srcHeight: number,
  gameRatio: GameRatio = '50-50',
  gamePosition: GamePosition = 'top',
  logo?: LogoOverlay,
): string {
  // Escape ASS path for FFmpeg filter_complex subtitles filter
  // Use filename= prefix to prevent Windows drive letter being parsed as option key
  const escaped = assPath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:');
  const assEsc = getAssEsc(escaped);

  // ── Background crop position (average — safe for filter_complex) ─────────
  // Strategy for game layout: show streamer face in the visible (non-gameplay) area.
  // Instead of overlaying gameplay on a full 1920px background, we:
  //   1. Crop a region around the face from source
  //   2. Scale it to exactly the VISIBLE area size (1080 × (1920-pipH))
  //   3. Stack streamer + gameplay vertically to form the final 1080×1920 output
  // This guarantees the face is ALWAYS visible regardless of source position.
  const detectedFrames = cropFrames.filter((f) => f.hasFace);
  const useFrames = detectedFrames.length > 0 ? detectedFrames : cropFrames;

  // Average face position in source pixels
  const avgFaceCx = useFrames.length > 0
    ? Math.round(useFrames.reduce((s, f) => s + f.cx, 0) / useFrames.length)
    : Math.round(srcWidth * 0.5);
  const avgFaceCy = useFrames.length > 0
    ? Math.round(useFrames.reduce((s, f) => s + (f.cy ?? srcHeight * 0.5), 0) / useFrames.length)
    : Math.round(srcHeight * 0.5);

  // ── Gameplay overlay dimensions ──────────────────────────────────────────
  const pipW = 1080;
  const pipH = gameRatio === '70-30' ? 1344 : 960;
  const streamerH = 1920 - pipH; // height available for streamer in output

  // ── Streamer crop: 9:16-ish region centered on face ──────────────────────
  // Target AR for streamer panel: 1080 / streamerH
  const streamerAR = 1080 / streamerH; // e.g. 1080/960 = 1.125 for 50-50
  let bgCropW: number;
  let bgCropH: number;

  // Compute crop that matches streamer panel AR
  if (srcWidth / srcHeight >= streamerAR) {
    // Source wider than target AR → use full height, crop width
    bgCropH = srcHeight;
    bgCropW = Math.round(srcHeight * streamerAR);
  } else {
    // Source taller than target AR → use full width, crop height
    bgCropW = srcWidth;
    bgCropH = Math.round(srcWidth / streamerAR);
  }

  // Apply zoom: don't use full source, zoom into face area (~50% of computed size)
  // This makes the face more prominent
  bgCropW = Math.round(bgCropW * 0.5);
  bgCropH = Math.round(bgCropH * 0.5);

  // Ensure doesn't exceed source
  bgCropW = Math.min(bgCropW, srcWidth);
  bgCropH = Math.min(bgCropH, srcHeight);

  // Ensure even dimensions and minimum size
  bgCropW = bgCropW % 2 === 0 ? bgCropW : bgCropW - 1;
  bgCropH = bgCropH % 2 === 0 ? bgCropH : bgCropH - 1;
  bgCropW = Math.max(bgCropW, 2);
  bgCropH = Math.max(bgCropH, 2);

  // Center crop on face, clamped to source bounds
  const bgCropX = Math.max(0, Math.min(srcWidth - bgCropW, avgFaceCx - Math.round(bgCropW / 2)));
  const bgCropY = Math.max(0, Math.min(srcHeight - bgCropH, avgFaceCy - Math.round(bgCropH / 2)));

  // ── Gameplay PiP crop — exclude streamer area ────────────────────────────
  // Strategy: detect where the streamer face is in the source frame.
  // Crop the gameplay area from the opposite/center region to avoid double-streamer.
  //
  // Streamer facecam is typically a small overlay in one corner of the source.
  // We crop a region from source that:
  //   1. Has the same AR as pipW×pipH (to avoid distortion after scale)
  //   2. Avoids the detected face region
  //
  // pipW:pipH = 1080:pipH → source crop AR = pipW/pipH
  // srcCropW:srcCropH must satisfy srcCropW/srcCropH = pipW/pipH
  // Use full srcWidth → srcCropH = srcWidth * pipH / pipW
  // But srcCropH may exceed srcHeight for landscape source → clamp and use srcHeight instead,
  // then derive srcCropW = srcHeight * pipW / pipH (crop width from center).

  let pipSrcX: number;
  let pipSrcY: number;
  let pipSrcW: number;
  let pipSrcH: number;

  // Compute crop dimensions that match pip AR
  const pipAspect = pipW / pipH; // e.g. 1080/960 = 1.125
  if (srcWidth / srcHeight >= pipAspect) {
    // Source is wider than pip AR → crop width, use full height
    pipSrcH = srcHeight;
    pipSrcW = Math.round(srcHeight * pipAspect);
  } else {
    // Source is taller than pip AR → crop height, use full width
    pipSrcW = srcWidth;
    pipSrcH = Math.round(srcWidth / pipAspect);
  }

  // Ensure pip crop doesn't exceed source and has even dimensions
  pipSrcW = Math.min(pipSrcW, srcWidth);
  pipSrcH = Math.min(pipSrcH, srcHeight);
  pipSrcW = pipSrcW % 2 === 0 ? pipSrcW : pipSrcW - 1;
  pipSrcH = pipSrcH % 2 === 0 ? pipSrcH : pipSrcH - 1;

  // Minimum crop size safety (avoid 0-dimension crops)
  pipSrcW = Math.max(pipSrcW, 2);
  pipSrcH = Math.max(pipSrcH, 2);

  // Determine streamer position from face detection (reuse avgFaceCx/avgFaceCy)
  // Determine which quadrant the streamer is in, then position crop to avoid it
  const faceInBottomHalf = avgFaceCy > srcHeight * 0.5;

  // Center gameplay crop horizontally — gameplay content is typically in the
  // middle of the source frame, only the Y axis needs face-avoidance logic.
  pipSrcX = Math.max(0, Math.round((srcWidth - pipSrcW) / 2));

  if (faceInBottomHalf) {
    // Streamer in bottom half → crop gameplay from top
    pipSrcY = 0;
  } else {
    // Streamer in top half → crop gameplay from bottom
    pipSrcY = Math.max(0, srcHeight - pipSrcH);
  }

  // Clamp to source bounds
  pipSrcX = Math.max(0, Math.min(pipSrcX, srcWidth  - pipSrcW));
  pipSrcY = Math.max(0, Math.min(pipSrcY, srcHeight - pipSrcH));


  // split [0:v] so it can be used for both streamer and gameplay.
  // [bg]   = streamer face crop, scaled to 1080×streamerH
  // [pip]  = gameplay crop, scaled to 1080×pipH
  // Stack them vertically based on gamePosition, then burn subtitles.
  const baseGraph = gamePosition === 'top'
    ? (
      // Gameplay on top, streamer on bottom
      `[0:v]split=2[src1][src2];` +
      `[src1]crop=${pipSrcW}:${pipSrcH}:${pipSrcX}:${pipSrcY},scale=${pipW}:${pipH}[pip];` +
      `[src2]crop=${bgCropW}:${bgCropH}:${bgCropX}:${bgCropY},scale=1080:${streamerH}[bg];` +
      `[pip][bg]vstack=inputs=2[stacked];` +
      `[stacked]subtitles=${assEsc}[sub]`
    )
    : (
      // Streamer on top, gameplay on bottom
      `[0:v]split=2[src1][src2];` +
      `[src1]crop=${bgCropW}:${bgCropH}:${bgCropX}:${bgCropY},scale=1080:${streamerH}[bg];` +
      `[src2]crop=${pipSrcW}:${pipSrcH}:${pipSrcX}:${pipSrcY},scale=${pipW}:${pipH}[pip];` +
      `[bg][pip]vstack=inputs=2[stacked];` +
      `[stacked]subtitles=${assEsc}[sub]`
    );

  if (!logo) {
    return baseGraph.replace('[sub]', '[vout]');
  }

  // Logo overlay — [1:v] is the logo input (second -i in ffmpegArgs)
  const logoW = Math.round(1080 * logo.scale);
  const { lx, ly } = computeLogoCoords(logo);

  return (
    baseGraph + `;` +
    `[1:v]format=rgba,scale=${logoW}:-1,colorchannelmixer=aa=${logo.opacity.toFixed(3)}[logo];` +
    `[sub][logo]overlay=${lx}:${ly}[vout]`
  );
}

// ---------------------------------------------------------------------------
// Letterbox layout filter builder
// ---------------------------------------------------------------------------

/**
 * Build FFmpeg -vf filter string for letterbox layout.
 *
 * Fits the source video (any AR) inside 1080×1920, centres it, and fills the
 * remaining canvas with one of:
 *   blur  — blurred+scaled copy of the source (YouTube Shorts style)
 *   color — solid hex colour
 *   image — user-supplied image file (second -i in ffmpegArgs)
 *
 * Returns { vf, needsImageInput } — caller must prepend '-i imagePath' when
 * needsImageInput is true.
 *
 * For blur bg we use filter_complex; for color/image we use -vf only.
 * All paths returned are filter strings, NOT filter_complex strings.
 */
function buildLetterboxFilter(
  assForFfmpeg: string,
  bg: LetterboxBackground,
  logo?: LogoOverlay,
  cropFilter?: string,
): { filterComplex: string; mapVideo: string; needsImageInput: boolean } {
  const blurRadius = bg.blurRadius ?? 30;
  const color      = (bg.color ?? '#000000').replace('#', '');
  const cropMode   = bg.crop ?? 'original';

  let fgPrep = '';
  if (cropMode === 'custom' && bg.cropBox) {
    const cx = bg.cropBox.x % 2 === 0 ? bg.cropBox.x : bg.cropBox.x + 1;
    const cy = bg.cropBox.y % 2 === 0 ? bg.cropBox.y : bg.cropBox.y + 1;
    const cw = bg.cropBox.w % 2 === 0 ? bg.cropBox.w : bg.cropBox.w - 1;
    const ch = bg.cropBox.h % 2 === 0 ? bg.cropBox.h : bg.cropBox.h - 1;
    fgPrep = `crop=${cw}:${ch}:${cx}:${cy},`;
  } else if (cropFilter && cropMode !== 'original') {
    // Subject tracking is active. cropFilter is generated directly for target AR (1:1, 4:3, or 9:16)
    fgPrep = `${cropFilter},`;
  } else {
    // Subject tracking is inactive. Center-crop original source.
    if (cropMode === '4:3') {
      fgPrep = `crop='min(iw,ih*4/3)':'min(ih,iw*3/4)',`;
    } else if (cropMode === '1:1') {
      fgPrep = `crop='min(iw,ih)':'min(iw,ih)',`;
    }
  }

  // Foreground: (optional crop →) scale source to FIT inside 1080×1920 (contain, no pad).
  // Output size will be smaller than canvas on one axis — overlay centres it on bg.
  // Subtitle burned AFTER overlay so it renders on the full 1080×1920 canvas.
  const fgFilter =
    `${fgPrep}scale=1080:1920:force_original_aspect_ratio=decrease:flags=lanczos,` +
    `setsar=1`;

  // Subtitle burn — applied to final 1080×1920 composite
  // Use filename= prefix to prevent FFmpeg from misinterpreting Windows drive letter as option key
  const subsBurn = `subtitles=${getAssEsc(assForFfmpeg)}`;

  let fc = '';
  if (bg.type === 'blur') {
    const bgFilter =
      `scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,` +
      `crop=1080:1920,` +
      `gblur=sigma=${Math.min(blurRadius, 100)},` +
      `setsar=1`;

    fc =
      `[0:v]split=2[bgSrc][fgSrc];` +
      `[bgSrc]${bgFilter}[bg];` +
      `[fgSrc]${fgFilter}[fg];` +
      `[bg][fg]overlay=(W-w)/2:(H-h)/2,${subsBurn}[sub_vout]`;
  } else if (bg.type === 'image') {
    const bgFilter =
      `[1:v]scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,` +
      `crop=1080:1920,setsar=1[bg];`;

    fc =
      bgFilter +
      `[0:v]${fgFilter}[fg];` +
      `[bg][fg]overlay=(W-w)/2:(H-h)/2,${subsBurn}[sub_vout]`;
  } else {
    // color bg — lavfi color source (no input needed)
    // fps=0 lets FFmpeg infer from output; no r= param to avoid fps mismatch with source
    fc =
      `color=c=#${color}:s=1080x1920[bg];` +
      `[0:v]${fgFilter}[fg];` +
      `[bg][fg]overlay=(W-w)/2:(H-h)/2,${subsBurn}[sub_vout]`;
  }

  if (logo) {
    const logoW = Math.round(1080 * logo.scale);
    const logoInputIdx = bg.type === 'image' ? 2 : 1;
    const { lx, ly } = computeLogoCoords(logo);
    fc += `;[${logoInputIdx}:v]format=rgba,scale=${logoW}:-1,colorchannelmixer=aa=${logo.opacity.toFixed(3)}[logo];` +
          `[sub_vout][logo]overlay=${lx}:${ly}[vout]`;
    return { filterComplex: fc, mapVideo: '[vout]', needsImageInput: bg.type === 'image' };
  } else {
    fc = fc.replace('[sub_vout]', '[vout]');
    return { filterComplex: fc, mapVideo: '[vout]', needsImageInput: bg.type === 'image' };
  }
}

// ---------------------------------------------------------------------------
// Title overlay builder
// ---------------------------------------------------------------------------

/**
 * Build ASS Dialogue lines for a static title overlay.
 * Returns { styleBlock, dialogueLine } to be injected at the correct positions.
 * Style must go into [V4+ Styles], dialogue into [Events].
 */
function buildTitleEvents(
  title: TitleOverlay,
  durationMs: number,
): { styleLine: string; dialogueLine: string } | null {
  if (!title.text.trim()) return null;

  const primaryAss  = hexToAss(title.color);
  const outlineAss  = hexToAss(title.outlineColor);
  const backAss     = '&H80000000';
  const text        = title.uppercase ? title.text.trim().toUpperCase() : title.text.trim();
  const bold        = title.bold ? 1 : 0;

  const fmt = (ms: number): string => {
    const h  = Math.floor(ms / 3_600_000);
    const m  = Math.floor((ms % 3_600_000) / 60_000);
    const s  = Math.floor((ms % 60_000) / 1_000);
    const cs = Math.floor((ms % 1_000) / 10);
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  };

  const styleLine =
    `Style: Title,${title.font},${title.fontSize},${primaryAss},&H000000FF,${outlineAss},${backAss},${bold},0,0,0,100,100,1,0,1,${title.outlineSize},0,2,60,60,0,1`;

  const posTag     = `{\\an2\\pos(540,${title.y})}`;
  const dialogueLine = `Dialogue: 1,${fmt(0)},${fmt(durationMs)},Title,,0,0,0,,${posTag}${text}`;

  return { styleLine, dialogueLine };
}

// ---------------------------------------------------------------------------
// Custom Font Directory Helper
// ---------------------------------------------------------------------------

function getFontsDir(): string | null {
  const paths = [
    path.join(process.resourcesPath ?? '', 'resources', 'fonts'),
    path.join(__dirname, '..', '..', '..', 'resources', 'fonts'),
    path.join(__dirname, '..', '..', 'resources', 'fonts'),
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

function getEscapedFontsDir(): string | null {
  const fontsDir = getFontsDir();
  if (!fontsDir) return null;
  return fontsDir.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:');
}

function getAssEsc(escapedAssPath: string): string {
  const fontsDirEsc = getEscapedFontsDir();
  if (fontsDirEsc) {
    return `filename='${escapedAssPath}':fontsdir='${fontsDirEsc}'`;
  }
  return `filename='${escapedAssPath}'`;
}

// ---------------------------------------------------------------------------
// Legacy style converter
// ---------------------------------------------------------------------------

/** Convert old SubtitleStyle + SubtitlePosition to a CaptionStyle */
function legacyToCaptionStyle(style: SubtitleStyle, position: SubtitlePosition): CaptionStyle {
  if (style === 'none') {
    return { ...CAPTION_PRESETS['none'], presetId: 'none', position };
  }
  if (style === 'bold-white') {
    return { ...CAPTION_PRESETS['hormozi'], presetId: 'hormozi', position };
  }
  if (style === 'gradient-pop') {
    return { ...CAPTION_PRESETS['karaoke'], presetId: 'karaoke', position };
  }
  return { ...CAPTION_PRESETS['simple'], presetId: 'simple', position };
}

// ---------------------------------------------------------------------------
// Caption helpers
// ---------------------------------------------------------------------------

/** Convert hex color '#RRGGBB' to ASS BGR format '&H00BBGGRR' */
function hexToAss(hex: string): string {
  const h = hex.replace('#', '');
  const r = h.slice(0, 2);
  const g = h.slice(2, 4);
  const b = h.slice(4, 6);
  return `&H00${b}${g}${r}`;
}

// ---------------------------------------------------------------------------
// Loudness detection — analyse audio with FFmpeg astats filter
// ---------------------------------------------------------------------------

/**
 * Analyse per-word loudness by running FFmpeg `astats` over each word's
 * audio segment.  Returns a Set of word indices (relative to the clip word
 * array) whose RMS loudness exceeds `thresholdDb`.
 *
 * Falls back to an empty Set on any error so caption generation is never
 * blocked by an audio-analysis failure.
 *
 * @param sourceFile   Path to the source video/audio file.
 * @param clipWords    Words already offset to clip-relative time (ms).
 * @param thresholdDb  RMS loudness threshold in dB (default −18 dB).
 *                     Higher (less negative) = only the very loudest words.
 */
async function detectLoudWords(
  sourceFile: string,
  clipWords: Array<{ startMs: number; endMs: number }>,
  clipStartMs: number,
  thresholdDb = -18,
): Promise<Set<number>> {
  const loudIndices = new Set<number>();

  // Limit to avoid spawning too many processes on Windows
  if (clipWords.length > 40) {
    log.info({ wordCount: clipWords.length }, 'Skipping loudness detection: too many words');
    return loudIndices;
  }


  // Batch: one FFmpeg call per word would be too slow.
  // Instead run a single pass over the full clip and sample RMS per word
  // using the `astats=metadata=1:reset=1` filter with `-af` select.
  // We use a simpler approach: for each word, run a quick FFmpeg probe
  // extracting mean_volume from `volumedetect`.  We limit to words longer
  // than 100 ms to avoid micro-words inflating results.

  const candidates = clipWords
    .map((w, i) => ({ i, startMs: w.startMs, endMs: w.endMs }))
    .filter(({ startMs, endMs }) => endMs - startMs >= 100);

  const results: Array<{ i: number; db: number }> = [];

  // Run all probes in parallel (capped at 8 concurrent) for speed
  const CONCURRENCY = 8;
  for (let batch = 0; batch < candidates.length; batch += CONCURRENCY) {
    const chunk = candidates.slice(batch, batch + CONCURRENCY);

    await Promise.all(chunk.map(async ({ i, startMs, endMs }) => {
      try {
        const startSec = (clipStartMs + startMs) / 1000;
        const durSec   = Math.max(0.1, (endMs - startMs) / 1000);

        const rmsDb = await new Promise<number>((resolve) => {
          const proc = spawn('ffmpeg', [
            '-ss',  String(startSec),
            '-t',   String(durSec),
            '-i',   sourceFile,
            '-af',  'volumedetect',
            '-vn',
            '-f',   'null', '-',
          ], { stdio: ['ignore', 'ignore', 'pipe'] });

          let stderr = '';
          proc.stderr?.on('data', (c: Buffer) => { stderr += c.toString(); });
          proc.on('close', () => {
            // Parse "mean_volume: -XX.X dB"
            const m = stderr.match(/mean_volume:\s*([-\d.]+)\s*dB/);
            resolve(m ? parseFloat(m[1]) : -999);
          });
          proc.on('error', () => resolve(-999));
          // Safety timeout per-word probe
          setTimeout(() => { proc.kill(); resolve(-999); }, 8_000);
        });

        if (rmsDb > -900) {
          results.push({ i, db: rmsDb });
        }
      } catch {
        // Non-fatal — just skip this word
      }
    }));
  }

  // Dynamic loudness threshold: select words within 4.0 dB of peak volume in clip OR >= thresholdDb
  // This ensures shake effect works on normalized TTS voice (which averages -22dB to -26dB) as well as loud video audio
  if (results.length > 0) {
    const validDbs = results.map(r => r.db);
    const maxDb = Math.max(...validDbs);
    const cutoffDb = Math.min(thresholdDb, maxDb - 4.0);
    for (const { i, db } of results) {
      if (db >= cutoffDb) {
        loudIndices.add(i);
      }
    }
  }

  return loudIndices;
}

// ---------------------------------------------------------------------------
// ASS position helper for shake effect
// ---------------------------------------------------------------------------

/**
 * Build the base X/Y position for the subtitle anchor based on CaptionStyle.
 * Canvas: PlayResX=1080, PlayResY=1920.
 */
function basePos(style: CaptionStyle): { x: number; y: number } {
  const x = 540; // horizontal center
  // captionY overrides preset position — anchor is bottom-center of text block
  if (style.captionY !== undefined) {
    return { x, y: style.captionY };
  }
  const y = style.position === 'lower-third' ? 1750
    : style.position === 'upper-third' ? 170
    : 960; // center
  return { x, y };
}

/**
 * Build an ASS subtitle file from a CaptionStyle preset.
 *
 * v2 — Word-level events with:
 *   • Bouncy pop-up animation per word  ({\fscx0\fscy0\t(...)})
 *   • Loudness-based shake effect        (multiple \pos sub-events)
 *   • Karaoke highlight preserved
 */
async function buildAssSubtitles(
  words: TranscriptWord[],
  startMs: number,
  endMs: number,
  style: CaptionStyle,
  sourceFile?: string,
): Promise<string> {
  if (style.presetId === 'none') {
    return `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 1

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,10,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,1,0,1,1,1,2,60,60,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  }

  // Filter words within clip range, offset to clip-relative time
  const clipWords = words
    .filter((w) => w.startMs < endMs && w.endMs > startMs)
    .map((w) => ({
      ...w,
      startMs: Math.max(0, w.startMs - startMs),
      endMs: Math.min(endMs - startMs, w.endMs - startMs)
    }));

  // ── Loudness detection ────────────────────────────────────────────────────
  let loudSet = new Set<number>();
  if (sourceFile && style.shakeEffect !== false) {
    try {
      loudSet = await detectLoudWords(sourceFile, clipWords, startMs);
    } catch {
      // Non-fatal — continue without shake effect
    }
  }

  const primaryAss   = hexToAss(style.primaryColor);
  const outlineAss   = hexToAss(style.outlineColor);
  const highlightAss = hexToAss(style.highlightColor);
  const backAss      = '&H80000000';

  // When captionY is set: use alignment 2 (bottom-center) so \pos Y = bottom edge of text.
  // When using preset positions: keep original alignment so MarginV works correctly.
  const alignment = style.captionY !== undefined
    ? 2  // bottom-center anchor, position via \pos
    : style.position === 'lower-third' ? 2
    : style.position === 'upper-third' ? 8
    : 5;
  const marginV = style.captionY !== undefined
    ? 0  // \pos overrides margin
    : style.position === 'lower-third' ? 120
    : style.position === 'upper-third' ? 120
    : 0;

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 1

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${style.font},${style.fontSize},${primaryAss},&H000000FF,${outlineAss},${backAss},${style.bold ? 1 : 0},0,0,0,100,100,1,0,1,${style.outlineSize},${style.shadowSize},${alignment},60,60,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const fmt = (ms: number): string => {
    const h  = Math.floor(ms / 3_600_000);
    const m  = Math.floor((ms % 3_600_000) / 60_000);
    const s  = Math.floor((ms % 60_000) / 1_000);
    const cs = Math.floor((ms % 1_000) / 10);
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  };

  // ── Deterministic pseudo-random for shake offsets (seeded per word index) ──
  // Using a simple LCG so shake pattern is consistent across re-renders.
  function lcgRand(seed: number): () => number {
    let s = seed;
    return () => {
      s = (s * 1664525 + 1013904223) & 0xffffffff;
      return (s >>> 0) / 0xffffffff; // [0, 1)
    };
  }

  const dialogueLines: string[] = [];
  const { x: baseX, y: baseY } = basePos(style);

  // ── Karaoke: group words into lines, render background + foreground layers ──
  // Background layer (Layer 0): full group visible in primaryColor for entire group duration.
  // Foreground layer (Layer 1): active word only in highlightColor + bouncy anim.
  // Non-karaoke: pure word-level events (already correct).

  if (style.karaokeHighlight) {
    // ASS karaoke approach yang reliable di libass:
    // Style header: PrimaryColour = highlightColor (active word color)
    //               SecondaryColour = primaryColor (pre-active / already-spoken color)
    // Use \kf tag: sweeps from SecondaryColour → PrimaryColour during word duration.
    // After word done: stays PrimaryColour (highlight).
    // But we want SPOKEN words to revert to primaryColor, not stay highlighted.
    // Use \k (not \kf): before word = SecondaryColour, during = SecondaryColour, after = PrimaryColour.
    // So: SecondaryColour = primaryColor (idle), PrimaryColour = highlightColor (spoken).
    // Active word during its \k window = SecondaryColour = primary (not what we want).
    //
    // Correct approach for "active=highlight, rest=primary":
    // Use \K tag: wipe fill. Or use per-event override with \1c.
    //
    // Simplest proven approach: separate Dialogue per word (word-level events),
    // BUT also show the rest of the group as background using \1c primary on same layer.
    // Avoid double render: use Layer 0 for background group (all primary),
    // Layer 1 for active word ONLY (highlight + bouncy) — but CLIP the background
    // word text so it doesn't double-render the active word.
    //
    // Cleanest: one Dialogue per WORD, not per group.
    // Show group context by rendering ALL words of the group for each word's duration,
    // with active word = highlight, rest = primary.
    // This means N events per group of N words, each showing the full group text
    // but with different word highlighted.

    const wordsPerLine = style.lines;

    for (let gi = 0; gi < clipWords.length; gi += wordsPerLine) {
      const group = clipWords.slice(gi, gi + wordsPerLine).filter((w) => w.word.trim());
      if (group.length === 0) continue;

      // For each word in group, emit one Dialogue spanning that word's duration,
      // showing the full group with active word in highlightColor, others in primaryColor.
      for (let wi = 0; wi < group.length; wi++) {
        const activeWord = group[wi];
        const lineText = group.map((w, j) => {
          const wt = style.uppercase ? w.word.trim().toUpperCase() : w.word.trim();
          if (j === wi) {
            // Active word: highlight color + bouncy scale animation
            const isLoud = loudSet.has(gi + wi);
            const bouncyTag = isLoud
              ? '{\\t(0,80,\\fscx115\\fscy115)\\t(80,180,\\fscx100\\fscy100)}'
              : '{\\t(0,80,\\fscx110\\fscy110)\\t(80,160,\\fscx100\\fscy100)}';
            return `{\\1c${highlightAss}}${bouncyTag}${wt}`;
          }
          // Other words: primary color, reset scale
          return `{\\1c${primaryAss}}{\\fscx100\\fscy100}${wt}`;
        }).join(' ');

        const animPrefix = style.animation === 'fade' ? '{\\fad(150,150)}' : '';
        const posTag = style.captionY !== undefined ? `{\\pos(${baseX},${baseY})}` : '';
        const text = `${animPrefix}{\\an${alignment}}${posTag}${lineText}`;

        dialogueLines.push(
          `Dialogue: 0,${fmt(activeWord.startMs)},${fmt(activeWord.endMs)},Default,,0,0,0,,${text}`
        );
      }
    }

    return header + dialogueLines.join('\n') + '\n';
  }

  // ── Word-level event generation (non-karaoke) ─────────────────────────────
  for (let i = 0; i < clipWords.length; i++) {
    const w = clipWords[i];
    if (!w.word.trim()) continue;

    const wordText = style.uppercase ? w.word.trim().toUpperCase() : w.word.trim();
    const isLoud   = loudSet.has(i);

    // ── Color tag ────────────────────────────────────────────────────────────
    // Non-karaoke path only (karaoke handled above with early return).
    let colorTag: string;
    if (style.highlightColor !== style.primaryColor) {
      colorTag = `{\\1c${highlightAss}}`;
    } else {
      colorTag = `{\\1c${primaryAss}}`;
    }

    // ── Bouncy pop-up animation ─────────────────────────────────────────────
    // Subtle bounce: scale from 100%→110%→100%. Starts visible, just bounces.
    // Loud words: slightly more aggressive bounce 100%→115%→100%.
    let bouncyTag: string;
    if (isLoud) {
      bouncyTag = '{\\t(0,80,\\fscx115\\fscy115)\\t(80,180,\\fscx100\\fscy100)}';
    } else {
      bouncyTag = '{\\t(0,80,\\fscx110\\fscy110)\\t(80,160,\\fscx100\\fscy100)}';
    }

    // ── Slide-up / fade animation ────────────────────────────────────────────
    let extraAnimTag = '';
    if (style.animation === 'fade') {
      extraAnimTag = '{\\fad(150,150)}';
    } else if (style.animation === 'slide-up') {
      const slideFromY = baseY + 100;
      extraAnimTag = `{\\move(${baseX},${slideFromY},${baseX},${baseY},0,200)}`;
    }
    // 'pop' = bouncyTag above (always active)

    if (!isLoud) {
      // ── Normal word: single dialogue event ───────────────────────────────
      const anTag = `{\\an${alignment}}`;
      // When captionY set: add explicit \pos so position is exact, not margin-driven
      const posTag = style.captionY !== undefined ? `{\\pos(${baseX},${baseY})}` : '';
      const text = `${anTag}${posTag}${bouncyTag}${colorTag}${extraAnimTag}${wordText}`;
      dialogueLines.push(
        `Dialogue: 0,${fmt(w.startMs)},${fmt(w.endMs)},Default,,0,0,0,,${text}`
      );
    } else {
      // ── Loud word: shake effect via multiple \pos sub-events ──────────────
      // Split the word duration into 30 ms micro-segments; each segment gets
      // a slightly randomised \pos offset to simulate camera shake.
      const SHAKE_INTERVAL_MS = 30;
      const SHAKE_AMPLITUDE   = 12; // max pixel offset from base position
      const rand = lcgRand(i * 7919); // deterministic seed per word

      const segments: Array<{ sMs: number; eMs: number }> = [];
      for (let t = w.startMs; t < w.endMs; t += SHAKE_INTERVAL_MS) {
        segments.push({ sMs: t, eMs: Math.min(t + SHAKE_INTERVAL_MS, w.endMs) });
      }

      segments.forEach((seg, si) => {
        // First sub-event gets the bouncy pop-up; the rest skip it to avoid
        // retriggering the scale animation on every micro-segment.
        const popTag = si === 0 ? bouncyTag : '{\\fscx100\\fscy100}';

        const dx = Math.round((rand() * 2 - 1) * SHAKE_AMPLITUDE);
        const dy = Math.round((rand() * 2 - 1) * SHAKE_AMPLITUDE);
        const posTag = `{\\an${alignment}\\pos(${baseX + dx},${baseY + dy})}`;

        const text = `${popTag}${posTag}${colorTag}${wordText}`;
        dialogueLines.push(
          `Dialogue: 0,${fmt(seg.sMs)},${fmt(seg.eMs)},Default,,0,0,0,,${text}`
        );
      });
    }
  }

  return header + dialogueLines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

export class Processor {
  /** clipId → active FFmpeg ChildProcess (for cancellation) */
  private readonly activeProcs = new Map<string, ChildProcess>();

  /** Individual speaker face positions from last face detection run (for quad/split layout) */
  private _lastSpeakerPositions: Array<{ cx: number; cy: number }> = [];

  /**
   * Cut a clip from a source video, add subtitles, and apply
   * auto face-tracking crop to 9:16 vertical format.
   */
  async process(opts: ProcessOptions): Promise<void> {
    const {
      clipId, projectId, sourceFile, startMs, endMs,
      outputPath, subtitleStyle, subtitlePosition,
      zoomEnabled, words,
    } = opts;
    log.info({ clipId, projectId, startMs, endMs }, 'Starting clip processing');
    emitProgress(clipId, 5);

    const durationSec = (endMs - startMs) / 1000;
    const startSec    = startMs / 1000;

    if (durationSec <= 0) {
      throw new Error(`Invalid clip range: startMs=${startMs}, endMs=${endMs} (duration=${durationSec}s)`);
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    // ── Step 1: Face detection for auto-crop ─────────────────────────────
    let cropFrames: CropFrame[] = [];
    const { width: srcWidth, height: srcHeight } = getVideoDimensions(sourceFile);
    log.info({ clipId, srcWidth, srcHeight, sourceFile }, 'Source video dimensions');
    const trackingMode = opts.trackingMode ?? 'auto';

    if (zoomEnabled && trackingMode !== 'none') {
      emitProgress(clipId, 10);

      // Heartbeat ticker during tracking — keeps progress bar moving
      let tickerStopped = false;
      let tickPct = 10;
      const TICKER_CAP = 18;
      const ticker = setInterval(() => {
        if (tickerStopped || tickPct >= TICKER_CAP) { clearInterval(ticker); return; }
        tickPct = Math.min(tickPct + 1, TICKER_CAP);
        emitProgress(clipId, tickPct);
      }, 1500);

      try {
        if (trackingMode === 'speaker') {
          cropFrames = await this._detectActiveSpeaker(sourceFile, startMs, endMs, opts.subjectBbox);
        } else if (trackingMode === 'auto') {
          // Use Tracker: MediaPipe Face Detector → OpenCV fallback
          const tracker = new Tracker();
          cropFrames = await tracker.detectFaces(
            sourceFile, startMs, endMs,
            undefined,
            srcWidth, srcHeight,
          );
        } else {
          cropFrames = await this._detectFaces(
            sourceFile, startMs, endMs,
            trackingMode,
            opts.subjectBbox,
            opts.subjectSeedMs,
          );
        }
        log.info({ clipId, frameCount: cropFrames.length, trackingMode }, 'Face detection complete');
      } catch (err) {
        log.warn({ clipId, err }, 'Face detection failed, using center crop');
      } finally {
        tickerStopped = true;
        clearInterval(ticker);
      }
    }

    emitProgress(clipId, 20);

    // ── Step 2: Build ASS subtitle file ──────────────────────────────────
    // Resolve caption style: use captionStyle if provided, else convert legacy subtitleStyle
    const resolvedCaption: CaptionStyle = opts.captionStyle ?? legacyToCaptionStyle(subtitleStyle, subtitlePosition);

    // Write ASS to a safe temp path: only alphanumeric + hyphens, no spaces.
    // Use a sanitised clipId (strip any non-alnum chars) so the path is
    // guaranteed free of spaces, colons, or other FFmpeg filter special chars.
    const safeId   = clipId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const assPath  = path.join(os.tmpdir(), `clip_${safeId}.ass`);
    // Pass sourceFile so loudness detection can mark loud words for shake effect
    const assContent = await buildAssSubtitles(words, startMs, endMs, resolvedCaption, sourceFile);
    // Inject title overlay: style into [V4+ Styles], dialogue into [Events]
    let finalAss = assContent;
    if (opts.titleOverlay) {
      const titleResult = buildTitleEvents(opts.titleOverlay, endMs - startMs);
      if (titleResult) {
        // Insert style line before [Events] — use regex to handle both \r\n and \n line endings
        finalAss = finalAss.replace(
          /\r?\n\r?\n\[Events\]/,
          `\n${titleResult.styleLine}\n\n[Events]`
        );
        finalAss += titleResult.dialogueLine + '\n';
      }
    }
    fs.writeFileSync(assPath, finalAss, 'utf-8');

    emitProgress(clipId, 25);

    try {
      const letterboxCropMode = (opts.layoutPreset ?? 'normal') === 'letterbox' ? (opts.letterboxBg?.crop ?? 'original') : '9:16';
      const targetAR: '9:16' | '1:1' | '4:3' = letterboxCropMode === '1:1' ? '1:1' : letterboxCropMode === '4:3' ? '4:3' : '9:16';
      const cropFilter = buildCropFilter(cropFrames, startMs, endMs, srcWidth, srcHeight, targetAR);

      // Build escaped path for FFmpeg subtitles / ass filter on Windows.
      // assPath is already in os.tmpdir() — typically no spaces.
      // Escape: backslashes → forward slashes, drive-letter colon → \:
      // Do NOT escape spaces here because assPath should have none;
      // if tmpdir somehow contains spaces we escape those too.
      const assForFfmpeg = assPath
        .replace(/\\/g, '/')
        .replace(/^([A-Za-z]):/, '$1\\:');

      log.info({ clipId, assPath, assForFfmpeg }, 'ASS subtitle path');

      const layoutPreset = opts.layoutPreset ?? 'normal';
      const splitLayout  = opts.splitLayout  ?? 'top-bottom';

      const useReplacementAudio = opts.audioMode === 'replace' && opts.replacementAudioPath && fs.existsSync(opts.replacementAudioPath);
      let ffmpegArgs: string[];

      if (layoutPreset === 'split') {
        // ── Split layout: two speaker panels ─────────────────────────────
        log.info({ clipId, splitLayout }, 'Using split layout');
        const logo = opts.logoOverlay && fs.existsSync(opts.logoOverlay.filePath)
          ? opts.logoOverlay : undefined;
        let replacementAudioIdx = -1;
        let inputs = [
          '-ss', String(startSec),
          '-t',  String(durationSec),
          '-i',  sourceFile,
        ];
        let currentIdx = 1;
        if (logo) {
          inputs.push('-i', logo.filePath);
          currentIdx++;
        }
        if (useReplacementAudio && opts.replacementAudioPath) {
          inputs.push('-i', opts.replacementAudioPath);
          replacementAudioIdx = currentIdx++;
        }

        const filterComplex = buildSplitFilterComplex(
          splitLayout, cropFrames, assPath, srcWidth, srcHeight, logo,
          this._lastSpeakerPositions,
        );
        ffmpegArgs = [
          ...inputs,
          '-filter_complex', filterComplex,
          '-map', '[vout]',
          '-map', replacementAudioIdx !== -1 ? `${replacementAudioIdx}:a` : '0:a?',
          '-c:v', 'libx264', '-preset', 'slow', '-crf', '15',
          '-c:a', 'aac', '-b:a', '320k',
          '-movflags', '+faststart',
          outputPath,
        ];

      } else if (layoutPreset === 'game') {
        // ── Game layout: streamer bg + gameplay overlay ───────────────────
        const gameRatio = opts.gameRatio ?? '50-50';
        const gamePosition = opts.gamePosition ?? 'top';
        log.info({ clipId, gameRatio, gamePosition }, 'Using game layout');
        const logo = opts.logoOverlay && fs.existsSync(opts.logoOverlay.filePath)
          ? opts.logoOverlay : undefined;
        let replacementAudioIdx = -1;
        let inputs = [
          '-ss', String(startSec),
          '-t',  String(durationSec),
          '-i',  sourceFile,
        ];
        let currentIdx = 1;
        if (logo) {
          inputs.push('-i', logo.filePath);
          currentIdx++;
        }
        if (useReplacementAudio && opts.replacementAudioPath) {
          inputs.push('-i', opts.replacementAudioPath);
          replacementAudioIdx = currentIdx++;
        }

        const filterComplex = buildGameFilterComplex(
          cropFrames, assPath, srcWidth, srcHeight, gameRatio, gamePosition, logo
        );
        log.info({ clipId, filterComplex }, 'Game filter_complex');
        ffmpegArgs = [
          ...inputs,
          '-filter_complex', filterComplex,
          '-map', '[vout]',
          '-map', replacementAudioIdx !== -1 ? `${replacementAudioIdx}:a` : '0:a?',
          '-c:v', 'libx264', '-preset', 'slow', '-crf', '15',
          '-c:a', 'aac', '-b:a', '320k',
          '-movflags', '+faststart',
          outputPath,
        ];

      } else if (layoutPreset === 'letterbox') {
        // ── Letterbox layout: fit source into 9:16, fill bg with blur/color/image ──
        const lbBg: LetterboxBackground = opts.letterboxBg ?? { type: 'blur' };
        log.info({ clipId, lbBg }, 'Using letterbox layout');
        const logo = opts.logoOverlay && fs.existsSync(opts.logoOverlay.filePath)
          ? opts.logoOverlay : undefined;
        const { filterComplex, mapVideo, needsImageInput } = buildLetterboxFilter(
          assForFfmpeg, lbBg, logo, opts.zoomEnabled ? cropFilter : undefined
        );
        const imageInput = needsImageInput && lbBg.imagePath && fs.existsSync(lbBg.imagePath)
          ? ['-i', lbBg.imagePath] : [];
        const logoInput = logo ? ['-i', logo.filePath] : [];
        // If image mode but file missing, fall back to blur
        const effectiveFc = (needsImageInput && imageInput.length === 0)
          ? buildLetterboxFilter(assForFfmpeg, { ...lbBg, type: 'blur' }, logo, opts.zoomEnabled ? cropFilter : undefined).filterComplex
          : filterComplex;

        let replacementAudioIdx = -1;
        let inputs = [
          '-ss', String(startSec),
          '-t',  String(durationSec),
          '-i',  sourceFile,
          ...imageInput,
          ...logoInput,
        ];
        let currentIdx = 1 + (imageInput.length > 0 ? 1 : 0) + (logoInput.length > 0 ? 1 : 0);
        if (useReplacementAudio && opts.replacementAudioPath) {
          inputs.push('-i', opts.replacementAudioPath);
          replacementAudioIdx = currentIdx++;
        }

        ffmpegArgs = [
          ...inputs,
          '-filter_complex', effectiveFc,
          '-map', mapVideo,
          '-map', replacementAudioIdx !== -1 ? `${replacementAudioIdx}:a` : '0:a?',
          '-c:v', 'libx264', '-preset', 'slow', '-crf', '15',
          '-c:a', 'aac', '-b:a', '320k',
          '-movflags', '+faststart',
          outputPath,
        ];

      } else {
        // ── Normal layout: standard crop + optional logo ──────────────────
        // For -vf (no logo): plain subtitles='path' is fine
        // For filter_complex (logo): must use subtitles=filename='path' to avoid Windows drive letter parse issue
        const baseVfForVf  = `${cropFilter},subtitles=${getAssEsc(assForFfmpeg)}`;
        const baseVfForFc  = `${cropFilter},subtitles=${getAssEsc(assForFfmpeg)}`;

        if (opts.logoOverlay && fs.existsSync(opts.logoOverlay.filePath)) {
          const filterComplex = buildLogoFilterComplex(baseVfForFc, opts.logoOverlay);
          let replacementAudioIdx = -1;
          let inputs = [
            '-ss', String(startSec),
            '-t',  String(durationSec),
            '-i',  sourceFile,
            '-i',  opts.logoOverlay.filePath,
          ];
          let currentIdx = 2;
          if (useReplacementAudio && opts.replacementAudioPath) {
            inputs.push('-i', opts.replacementAudioPath);
            replacementAudioIdx = currentIdx++;
          }
          ffmpegArgs = [
            ...inputs,
            '-filter_complex', filterComplex,
            '-map', '[vout]',
            '-map', replacementAudioIdx !== -1 ? `${replacementAudioIdx}:a` : '0:a?',
            '-c:v', 'libx264', '-preset', 'slow', '-crf', '15',
            '-c:a', 'aac', '-b:a', '320k',
            '-movflags', '+faststart',
            outputPath,
          ];
        } else {
          let replacementAudioIdx = -1;
          let inputs = [
            '-ss', String(startSec),
            '-t',  String(durationSec),
            '-i',  sourceFile,
          ];
          let currentIdx = 1;
          if (useReplacementAudio && opts.replacementAudioPath) {
            inputs.push('-i', opts.replacementAudioPath);
            replacementAudioIdx = currentIdx++;
          }

          if (replacementAudioIdx !== -1) {
            ffmpegArgs = [
              ...inputs,
              '-filter_complex', `[0:v]${baseVfForVf}[vout]`,
              '-map', '[vout]',
              '-map', `${replacementAudioIdx}:a`,
              '-c:v', 'libx264', '-preset', 'slow', '-crf', '15',
              '-c:a', 'aac', '-b:a', '320k',
              '-movflags', '+faststart',
              outputPath,
            ];
          } else {
            ffmpegArgs = [
              ...inputs,
              '-vf', baseVfForVf,
              '-c:v', 'libx264', '-preset', 'slow', '-crf', '15',
              '-c:a', 'aac', '-b:a', '320k',
              '-movflags', '+faststart',
              outputPath,
            ];
          }
        }
      }

      const ffmpegCmd = ['ffmpeg', '-y', ...ffmpegArgs].join(' ');
      log.info({ clipId, ffmpegCmd }, 'FFmpeg command');

      const { promise, proc } = runFfmpegWithProgress(clipId, ffmpegArgs, durationSec);

      // Register process for cancellation
      this.activeProcs.set(clipId, proc);

      try {
        await promise;
      } catch (err) {
        log.error({ clipId, ffmpegCmd, err }, 'FFmpeg failed');

        // ── Retry without subtitles to isolate whether the ASS filter is the issue ──
        if (layoutPreset === 'normal' && !opts.logoOverlay) {
          log.info({ clipId }, 'Retrying FFmpeg without subtitles filter');
          const fallbackVf = cropFilter;
          const fallbackArgs = [
            '-ss', String(startSec),
            '-t',  String(durationSec),
            '-i',  sourceFile,
            '-vf', fallbackVf,
            '-c:v', 'libx264', '-preset', 'slow', '-crf', '15',
            '-c:a', 'aac', '-b:a', '320k',
            '-movflags', '+faststart',
            outputPath,
          ];
          const fallbackCmd = ['ffmpeg', '-y', ...fallbackArgs].join(' ');
          log.info({ clipId, fallbackCmd }, 'FFmpeg fallback command (no subs)');
          const { promise: p2, proc: proc2 } = runFfmpegWithProgress(clipId, fallbackArgs, durationSec);
          this.activeProcs.set(clipId, proc2);
          try {
            await p2;
            log.warn({ clipId }, 'FFmpeg succeeded WITHOUT subtitles — subtitle filter was the issue');
          } catch (err2) {
            log.error({ clipId, err: err2, fallbackArgs: fallbackArgs.join(' ') }, 'FFmpeg fallback also failed — crop filter or source issue');
            throw err2;
          } finally {
            this.activeProcs.delete(clipId);
          }
        } else {
          throw err;
        }
      } finally {
        this.activeProcs.delete(clipId);
      }

      emitProgress(clipId, 98);
      log.info({ clipId }, 'Clip processing complete');
    } finally {
      try { fs.unlinkSync(assPath); } catch { /* ignore */ }
    }

    // ── Step 3.5: Audio treatment — mute or replace the original audio ───
    // Removing/replacing copyrighted source audio is the single most
    // effective LEGITIMATE way to avoid Content ID audio claims.
    if (opts.audioMode && opts.audioMode !== 'keep') {
      try {
        await this._applyAudioTreatment(
          clipId, outputPath, opts.audioMode, opts.replacementAudioPath, opts.musicVolume,
        );
      } catch (err) {
        log.warn({ clipId, err }, 'Audio treatment failed, keeping original audio');
      }
    }

    // ── Step 4: Prepend thumbnail image as 1-second still frame ──────────
    const cleanPath = outputPath.replace(/\.mp4$/i, '_clean.mp4');
    try {
      fs.copyFileSync(outputPath, cleanPath);
    } catch (err) {
      log.warn({ clipId, err }, 'Failed to backup clean video');
    }

    if (opts.thumbnailPath && fs.existsSync(opts.thumbnailPath)) {
      log.info({ clipId, thumbnailPath: opts.thumbnailPath }, 'Prepending thumbnail as 1s intro');
      emitProgress(clipId, 99);
      try {
        await this.prependThumbnail(clipId, cleanPath, outputPath, opts.thumbnailPath);
      } catch (err) {
        log.warn({ clipId, err }, 'Thumbnail prepend failed, clip still usable without it');
      }
    }
  }

  /**
   * Cancel an in-progress clip generation by killing the FFmpeg process.
   */
  cancel(clipId: string): void {
    const proc = this.activeProcs.get(clipId);
    if (proc) {
      log.info({ clipId }, 'Cancelling FFmpeg process');
      proc.kill('SIGTERM');
      // Force kill after 3s if SIGTERM not enough
      setTimeout(() => {
        if (this.activeProcs.has(clipId)) {
          proc.kill('SIGKILL');
        }
      }, 3000);
      this.activeProcs.delete(clipId);
    }
  }

  /**
   * Generate a thumbnail (JPEG) from a video at the given timestamp.
   * Crops to 9:16 (center crop) and scales to 360×640.
   *
   * @param sourceFile  Path to the source video.
   * @param timestampMs Timestamp in milliseconds to capture.
   * @param outputPath  Output JPEG path.
   */
  async generateThumbnail(
    sourceFile: string,
    timestampMs: number,
    outputPath: string,
  ): Promise<void> {
    const timestampSec = timestampMs / 1000;

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    await runProcess('ffmpeg', [
      '-y',
      '-ss', String(timestampSec),
      '-i', sourceFile,
      '-vframes', '1',
      // Center crop to 9:16 then scale to 360×640
      '-vf', 'scale=-1:640,crop=360:640',
      '-q:v', '3',
      outputPath,
    ]);

    log.info({ sourceFile, timestampMs, outputPath }, 'Thumbnail generated');
  }

  // ---------------------------------------------------------------------------
  // Preview frame renderer
  // ---------------------------------------------------------------------------

  /**
   * Render a single JPEG frame with the EXACT same FFmpeg filter stack that
   * will be used during clip generation (crop + subtitle + letterbox/logo).
   *
   * Used by the preview panel to show a pixel-accurate preview.
   * Returns base64-encoded JPEG string, or null on failure.
   *
   * @param opts  Subset of ProcessOptions — sourceFile, startMs, endMs, words,
   *              captionStyle, layoutPreset, letterboxBg, logoOverlay, etc.
   *              previewTimestampMs: which frame to render (default = startMs+1s)
   */
  async renderPreviewFrame(opts: {
    sourceFile:     string;
    startMs:        number;
    endMs:          number;
    words:          TranscriptWord[];
    captionStyle:   CaptionStyle;
    layoutPreset?:  LayoutPreset;
    splitLayout?:   import('../../shared/types').SplitLayout;
    gameRatio?:     import('../../shared/types').GameRatio;
    gamePosition?:  import('../../shared/types').GamePosition;
    letterboxBg?:   LetterboxBackground;
    logoOverlay?:   LogoOverlay;
    titleOverlay?:  TitleOverlay;
    zoomEnabled?:   boolean;
    previewTimestampMs?: number;
    trackingMode?:  'auto' | 'manual' | 'none' | 'speaker';
    subjectBbox?:   { x: number; y: number; w: number; h: number };
    subjectSeedMs?: number;
  }): Promise<string | null> {
    const {
      sourceFile, startMs, endMs, words,
      captionStyle, layoutPreset = 'normal',
      splitLayout = 'top-bottom', gameRatio = '50-50', gamePosition = 'top',
      letterboxBg, logoOverlay, zoomEnabled = false,
      trackingMode = 'auto', subjectBbox, subjectSeedMs,
    } = opts;

    if (!fs.existsSync(sourceFile)) return null;

    // Frame to capture — prefer a timestamp where caption words are active.
    // Find the midpoint of the clip's word range, falling back to clip midpoint.
    const durationMs = endMs - startMs;
    let frameTimestampMs: number;
    if (opts.previewTimestampMs !== undefined) {
      frameTimestampMs = opts.previewTimestampMs;
    } else {
      // Find a word in the middle of the clip to guarantee caption is visible
      const clipWords = words.filter((w) => w.startMs >= startMs && w.endMs <= endMs);
      if (clipWords.length > 0) {
        const midWord = clipWords[Math.floor(clipWords.length / 2)];
        // Seek to middle of that word — caption will be active
        frameTimestampMs = Math.floor((midWord.startMs + midWord.endMs) / 2);
      } else {
        frameTimestampMs = startMs + Math.min(1000, Math.floor(durationMs / 2));
      }
    }
    // Clip-relative offset for the desired frame (0 = clip start)
    const frameOffsetMs = frameTimestampMs - startMs;
    const frameOffsetSec = frameOffsetMs / 1000;
    // Input seek to clip start; output seek for frame offset within the clip.
    // Input seeking resets PTS to ~0, matching clip-relative ASS timestamps.
    const startSec = startMs / 1000;

    const { width: srcWidth, height: srcHeight } = getVideoDimensions(sourceFile);

    // Build ASS subtitle file for preview.
    // Use clip-relative timestamps (same as clip generation) so subtitle events
    // start at PTS ≈ 0 after FFmpeg input-seeking to the clip start.
    const safeId  = `prev_${Date.now()}`;
    const assPath = path.join(os.tmpdir(), `${safeId}.ass`);
    const assContent = await buildAssSubtitles(words, startMs, endMs, captionStyle, undefined);
    let finalAss = assContent;
    if (opts.titleOverlay) {
      // Title: clip-relative duration (buildTitleEvents already produces clip-relative times)
      const titleResult = buildTitleEvents(opts.titleOverlay, endMs - startMs);
      if (titleResult) {
        finalAss = finalAss.replace(/\r?\n\r?\n\[Events\]/, `\n${titleResult.styleLine}\n\n[Events]`);
        // Title dialogue is already clip-relative — append as-is
        finalAss += titleResult.dialogueLine + '\n';
      }
    }
    fs.writeFileSync(assPath, finalAss, 'utf-8');

    // assForFfmpeg: path escaped for FFmpeg subtitles filter
    const assForFfmpeg = assPath
      .replace(/\\/g, '/')
      .replace(/^([A-Za-z]):/, '$1\\:');

    const outputJpeg = path.join(os.tmpdir(), `${safeId}.jpg`);
    let ffmpegArgs: string[] = [];

    // FFmpeg seek strategy: input seek (-ss before -i) to clip start resets PTS to ~0.
    // Then output seek (-ss after -i) advances to the desired frame within the clip.
    // This keeps PTS aligned with clip-relative ASS subtitle timestamps.

    try {
      let cropFrames: CropFrame[] = [];
      if (zoomEnabled) {
        try {
          if (trackingMode === 'speaker') {
            cropFrames = await this._detectActiveSpeaker(sourceFile, startMs, endMs, subjectBbox);
          } else if (trackingMode === 'auto') {
            const tracker = new Tracker();
            cropFrames = await tracker.detectFaces(sourceFile, startMs, endMs, undefined, srcWidth, srcHeight);
          } else {
            cropFrames = await this._detectFaces(sourceFile, startMs, endMs, trackingMode, subjectBbox, subjectSeedMs);
          }
        } catch { /* fallback center crop */ }
      }
      const letterboxCropMode = layoutPreset === 'letterbox' ? (letterboxBg?.crop ?? 'original') : '9:16';
      const targetAR: '9:16' | '1:1' | '4:3' = letterboxCropMode === '1:1' ? '1:1' : letterboxCropMode === '4:3' ? '4:3' : '9:16';
      const cropFilter = buildCropFilter(cropFrames, startMs, endMs, srcWidth, srcHeight, targetAR);

      if (layoutPreset === 'split') {
        const logo = logoOverlay && fs.existsSync(logoOverlay.filePath) ? logoOverlay : undefined;
        const raw = buildSplitFilterComplex(splitLayout, [], assPath, srcWidth, srcHeight, logo, []);
        const lastIdx = raw.lastIndexOf('[vout]');
        const filterComplex = raw.slice(0, lastIdx) + '[voutRaw]' + raw.slice(lastIdx + 6)
          + ';[voutRaw]scale=540:960[vout]';
        ffmpegArgs = [
          '-ss', String(startSec),
          '-i', sourceFile,
          ...(logo ? ['-i', logo.filePath] : []),
          '-ss', String(frameOffsetSec),
          '-filter_complex', filterComplex,
          '-map', '[vout]',
          '-vframes', '1', '-q:v', '3', outputJpeg,
        ];

      } else if (layoutPreset === 'game') {
        const logo = logoOverlay && fs.existsSync(logoOverlay.filePath) ? logoOverlay : undefined;
        const raw = buildGameFilterComplex([], assPath, srcWidth, srcHeight, gameRatio, gamePosition, logo);
        const lastIdx = raw.lastIndexOf('[vout]');
        const filterComplex = raw.slice(0, lastIdx) + '[voutRaw]' + raw.slice(lastIdx + 6)
          + ';[voutRaw]scale=540:960[vout]';
        ffmpegArgs = [
          '-ss', String(startSec),
          '-i', sourceFile,
          ...(logo ? ['-i', logo.filePath] : []),
          '-ss', String(frameOffsetSec),
          '-filter_complex', filterComplex,
          '-map', '[vout]',
          '-vframes', '1', '-q:v', '3', outputJpeg,
        ];

      } else if (layoutPreset === 'letterbox') {
        const lbBg: LetterboxBackground = letterboxBg ?? { type: 'blur' };
        const logo = logoOverlay && fs.existsSync(logoOverlay.filePath)
          ? logoOverlay : undefined;
        const { filterComplex: rawFc, needsImageInput } = buildLetterboxFilter(assForFfmpeg, lbBg, logo, zoomEnabled ? cropFilter : undefined);
        const imageInput = needsImageInput && lbBg.imagePath && fs.existsSync(lbBg.imagePath)
          ? ['-i', lbBg.imagePath] : [];
        const logoInput = logo ? ['-i', logo.filePath] : [];
        const baseFc = (needsImageInput && imageInput.length === 0)
          ? buildLetterboxFilter(assForFfmpeg, { ...lbBg, type: 'blur' }, logo, zoomEnabled ? cropFilter : undefined).filterComplex
          : rawFc;
        const filterComplex = baseFc.replace('[vout]', '[voutRaw]') + ';[voutRaw]scale=540:960[vout]';
        ffmpegArgs = [
          '-ss', String(startSec),
          '-i', sourceFile,
          ...imageInput,
          ...logoInput,
          '-ss', String(frameOffsetSec),
          '-filter_complex', filterComplex,
          '-map', '[vout]',
          '-vframes', '1', '-q:v', '3', outputJpeg,
        ];

      } else {
        if (logoOverlay && fs.existsSync(logoOverlay.filePath)) {
          const baseVf = `${cropFilter},subtitles=${getAssEsc(assForFfmpeg)}`;
          const rawFc = buildLogoFilterComplex(baseVf, logoOverlay);
          const filterComplex = rawFc.replace('[vout]', '[voutRaw]') + ';[voutRaw]scale=540:960[vout]';
          ffmpegArgs = [
            '-ss', String(startSec),
            '-i', sourceFile,
            '-i', logoOverlay.filePath,
            '-ss', String(frameOffsetSec),
            '-filter_complex', filterComplex,
            '-map', '[vout]',
            '-vframes', '1', '-q:v', '3', outputJpeg,
          ];
        } else {
          const vf = `${cropFilter},subtitles=${getAssEsc(assForFfmpeg)},scale=540:960`;
          ffmpegArgs = [
            '-ss', String(startSec),
            '-i', sourceFile,
            '-ss', String(frameOffsetSec),
            '-vf', vf,
            '-vframes', '1', '-q:v', '3', outputJpeg,
          ];
        }
      }

      await runProcess('ffmpeg', ['-y', ...ffmpegArgs]);

      if (!fs.existsSync(outputJpeg)) return null;
      const data = fs.readFileSync(outputJpeg);
      return `data:image/jpeg;base64,${data.toString('base64')}`;
    } catch (err) {
      log.warn({ err }, 'renderPreviewFrame failed');
      if (ffmpegArgs.length > 0) {
        log.warn({ cmd: ['ffmpeg', '-y', ...ffmpegArgs].join(' ') }, 'renderPreviewFrame ffmpeg cmd');
      }

      // Retry with first frame of clip (in case seek overshot for short clips)
      if (frameOffsetSec > 0 && ffmpegArgs.length > 0) {
        try {
          // Replace the output -ss value (second occurrence) to 0 to get the first frame
          const retryArgs = [...ffmpegArgs];
          // Find the second -ss (output seek) and set it to 0
          let ssCount = 0;
          for (let i = 0; i < retryArgs.length; i++) {
            if (retryArgs[i] === '-ss') {
              ssCount++;
              if (ssCount === 2) { retryArgs[i + 1] = '0'; break; }
            }
          }
          await runProcess('ffmpeg', ['-y', ...retryArgs]);
          if (fs.existsSync(outputJpeg)) {
            const data = fs.readFileSync(outputJpeg);
            return `data:image/jpeg;base64,${data.toString('base64')}`;
          }
        } catch (retryErr) {
          log.warn({ retryErr }, 'renderPreviewFrame retry also failed');
        }
      }
      return null;
    } finally {
      try { fs.unlinkSync(assPath);    } catch { /* ignore */ }
      try { fs.unlinkSync(outputJpeg); } catch { /* ignore */ }
    }
  }

  // ---------------------------------------------------------------------------
  // Private — audio treatment (mute / replace original audio)
  // ---------------------------------------------------------------------------

  /**
   * Mute or replace the original audio track of a finished clip.
   *
   * - 'mute'    : strips audio entirely (-an).
   * - 'replace' : swaps the original audio with a looped music track at the
   *               given volume. Falls back to keeping the original audio if no
   *               valid music file is provided.
   *
   * Re-muxes in place (video stream is copied, so it is fast and lossless for
   * video). Intended for legitimate use: removing copyrighted source audio you
   * do not have the right to redistribute, or adding your own licensed music.
   */
  private async _applyAudioTreatment(
    clipId: string,
    outputPath: string,
    mode: 'keep' | 'mute' | 'replace',
    replacementAudioPath?: string,
    musicVolume = 0.8,
  ): Promise<void> {
    if (mode === 'keep') return;

    const tmpOut = path.join(os.tmpdir(), `audio-${clipId}-${Date.now()}.mp4`);

    if (mode === 'mute') {
      log.info({ clipId }, 'Stripping original audio (mute)');
      await runProcess('ffmpeg', [
        '-y', '-i', outputPath,
        '-c:v', 'copy', '-an',
        '-movflags', '+faststart',
        tmpOut,
      ]);
    } else {
      // mode === 'replace'
      if (!replacementAudioPath || !fs.existsSync(replacementAudioPath)) {
        log.warn({ clipId, replacementAudioPath }, 'No valid replacement audio — keeping original audio');
        return;
      }
      const vol = Math.max(0, Math.min(1, Number.isFinite(musicVolume) ? musicVolume : 0.8));
      log.info({ clipId, replacementAudioPath, vol }, 'Replacing original audio with music track');
      
      const isMixedAudio = path.basename(replacementAudioPath).startsWith('mixed-audio-');
      const loopArgs = isMixedAudio ? [] : ['-stream_loop', '-1'];
      const shortestArgs = isMixedAudio ? [] : ['-shortest'];

      await runProcess('ffmpeg', [
        '-y',
        '-i', outputPath,
        ...loopArgs,
        '-i', replacementAudioPath,
        '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'copy',
        '-c:a', 'aac', '-b:a', '320k',
        '-af', `volume=${vol.toFixed(3)}`,
        ...shortestArgs,
        '-movflags', '+faststart',
        tmpOut,
      ]);
    }

    // Replace the original output in place
    fs.copyFileSync(tmpOut, outputPath);
    try { fs.unlinkSync(tmpOut); } catch { /* ignore */ }
  }

  // ---------------------------------------------------------------------------
  // Private — prepend thumbnail image as 1-second still frame
  // ---------------------------------------------------------------------------

  /**
   * Prepends a custom thumbnail image as a 1-second still frame at the start
   * of the clip video. Uses FFmpeg concat filter to avoid timing/fps mismatch.
   *
   * Steps:
   * 1. Create 1s intro from image (matching clip's resolution/fps)
   * 2. Use concat filter to join intro + clip with re-encode
   * 3. Replace original output
   */
  async prependThumbnail(
    clipId: string,
    inputVideoPath: string,
    outputVideoPath: string,
    thumbnailImagePath: string,
  ): Promise<void> {
    try {
      const hasAudio = hasAudioStream(inputVideoPath);
      log.info({ clipId, hasAudio }, 'Checking audio stream for thumbnail prepend');

      let filterComplex = '';
      let mapArgs: string[] = [];

      if (hasAudio) {
        filterComplex =
          '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,format=yuv420p,setpts=PTS-STARTPTS,setsar=1[intro];' +
          '[1:v]fps=30,format=yuv420p,setpts=PTS-STARTPTS,setsar=1[clip];' +
          'anullsrc=r=44100:cl=stereo[silence];' +
          '[silence]atrim=0:0.1,asetpts=PTS-STARTPTS[asilence];' +
          '[intro][asilence][clip][1:a]concat=n=2:v=1:a=1[vout][aout]';
        mapArgs = ['-map', '[vout]', '-map', '[aout]', '-c:a', 'aac', '-b:a', '320k'];
      } else {
        filterComplex =
          '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,format=yuv420p,setpts=PTS-STARTPTS,setsar=1[intro];' +
          '[1:v]fps=30,format=yuv420p,setpts=PTS-STARTPTS,setsar=1[clip];' +
          '[intro][clip]concat=n=2:v=1:a=0[vout]';
        mapArgs = ['-map', '[vout]', '-an'];
      }

      await runProcess('ffmpeg', [
        '-y',
        // Input 0: thumbnail image looped for 0.1 seconds
        '-framerate', '30',
        '-loop', '1',
        '-t', '0.1',
        '-i', thumbnailImagePath,
        // Input 1: the clip video
        '-i', inputVideoPath,
        '-filter_complex', filterComplex,
        ...mapArgs,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '15',
        '-movflags', '+faststart',
        outputVideoPath,
      ]);

      log.info({ clipId, thumbnailImagePath }, 'Thumbnail prepended successfully');
    } catch (err) {
      log.error({ clipId, err }, 'Failed to prepend thumbnail');
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Private — face detection
  // ---------------------------------------------------------------------------

  private async _detectFaces(
    sourceFile: string,
    startMs: number,
    endMs: number,
    trackingMode: 'auto' | 'manual' | 'none' = 'auto',
    subjectBbox?: { x: number; y: number; w: number; h: number },
    subjectSeedMs?: number,
  ): Promise<CropFrame[]> {
    const outputJson = path.join(os.tmpdir(), `faces-${Date.now()}.json`);

    const python = this._findPython();
    const scriptCandidates = [
      path.join(process.resourcesPath ?? '', 'resources', 'detect_faces.py'),
      path.join(__dirname, '..', '..', '..', 'resources', 'detect_faces.py'),
      path.join(__dirname, '..', '..', 'resources', 'detect_faces.py'),
    ];
    const scriptPath = scriptCandidates.find((p) => fs.existsSync(p));
    if (!scriptPath) {
      log.warn('detect_faces.py not found, skipping face detection');
      return [];
    }

    const args = [
      scriptPath,
      '--file',    sourceFile,
      '--start',   String(startMs / 1000),
      '--end',     String(endMs / 1000),
      '--output',  outputJson,
      '--samples', String(Math.min(90, Math.max(30, Math.ceil((endMs - startMs) / 1000 * 5)))),
    ];

    if (trackingMode === 'manual' && subjectBbox) {
      args.push('--subject-bbox', `${subjectBbox.x},${subjectBbox.y},${subjectBbox.w},${subjectBbox.h}`);
      if (subjectSeedMs !== undefined) {
        args.push('--subject-seed-time', String(subjectSeedMs / 1000));
      }
    }

    try {
      await runProcess(python, args);

      if (!fs.existsSync(outputJson)) return [];

      const data = JSON.parse(fs.readFileSync(outputJson, 'utf-8')) as {
        frames: Array<{ frameIndex: number; timestampMs: number; cx: number; cy: number; hasFace: boolean; faceSpanW?: number }>;
        avgCx: number;
        avgCy: number;
        width: number;
        height: number;
        speakerPositions?: Array<{ cx: number; cy: number }>;
      };

      try { fs.unlinkSync(outputJson); } catch { /* ignore */ }

      // Store speaker positions for use in split/quad layout
      if (data.speakerPositions && data.speakerPositions.length > 0) {
        this._lastSpeakerPositions = data.speakerPositions;
      } else {
        this._lastSpeakerPositions = [];
      }

      return data.frames.map((f) => ({
        frameIndex:  f.frameIndex,
        timestampMs: f.timestampMs,
        cx:          f.cx,
        cy:          f.cy,
        hasFace:     f.hasFace,
        faceSpanW:   f.faceSpanW ?? 0,
      }));
    } catch {
      try { fs.unlinkSync(outputJson); } catch { /* ignore */ }
      return [];
    }
  }

  /**
   * Extract a single frame as JPEG for the subject picker UI.
   * Returns base64-encoded JPEG string.
   */
  async extractFrame(sourceFile: string, timestampMs: number): Promise<string | null> {
    const outputJpeg = path.join(os.tmpdir(), `frame-${Date.now()}.jpg`);
    const python = this._findPython();
    const scriptCandidates = [
      path.join(process.resourcesPath ?? '', 'resources', 'detect_faces.py'),
      path.join(__dirname, '..', '..', '..', 'resources', 'detect_faces.py'),
      path.join(__dirname, '..', '..', 'resources', 'detect_faces.py'),
    ];
    const scriptPath = scriptCandidates.find((p) => fs.existsSync(p));
    if (!scriptPath) return null;

    try {
      await runProcess(python, [
        scriptPath,
        '--file', sourceFile,
        '--extract-frame', String(timestampMs / 1000),
        '--output', outputJpeg,
      ]);
      if (!fs.existsSync(outputJpeg)) return null;
      const data = fs.readFileSync(outputJpeg);
      try { fs.unlinkSync(outputJpeg); } catch { /* ignore */ }
      return `data:image/jpeg;base64,${data.toString('base64')}`;
    } catch {
      try { fs.unlinkSync(outputJpeg); } catch { /* ignore */ }
      return null;
    }
  }

  /**
   * Run auto detection on a single frame, return detected bounding boxes.
   * Used by the subject picker UI to show clickable boxes.
   */
  async detectBoxesAtFrame(sourceFile: string, timestampMs: number): Promise<Array<{x:number;y:number;w:number;h:number}>> {
    const outputJson = path.join(os.tmpdir(), `boxes-${Date.now()}.json`);
    const python = this._findPython();
    const scriptCandidates = [
      path.join(process.resourcesPath ?? '', 'resources', 'detect_faces.py'),
      path.join(__dirname, '..', '..', '..', 'resources', 'detect_faces.py'),
      path.join(__dirname, '..', '..', 'resources', 'detect_faces.py'),
    ];
    const scriptPath = scriptCandidates.find((p) => fs.existsSync(p));
    if (!scriptPath) return [];

    const dummyEnd = timestampMs / 1000 + 1;
    try {
      await runProcess(python, [
        scriptPath,
        '--file',    sourceFile,
        '--start',   String(timestampMs / 1000),
        '--end',     String(dummyEnd),
        '--output',  outputJson,
        '--samples', '1',
      ]);
      if (!fs.existsSync(outputJson)) return [];
      const data = JSON.parse(fs.readFileSync(outputJson, 'utf-8')) as { detectedBoxes?: Array<{x:number;y:number;w:number;h:number}> };
      try { fs.unlinkSync(outputJson); } catch { /* ignore */ }
      return data.detectedBoxes ?? [];
    } catch {
      try { fs.unlinkSync(outputJson); } catch { /* ignore */ }
      return [];
    }
  }

  private _findPython(): string {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execSync } = require('child_process') as typeof import('child_process');
    for (const py of ['python', 'python3']) {
      try {
        execSync(`${py} --version`, { stdio: 'pipe' });
        return py;
      } catch { /* try next */ }
    }
    return 'python';
  }

  private async _detectActiveSpeaker(
    sourceFile: string,
    startMs: number,
    endMs: number,
    splitScreenBbox?: { x: number; y: number; w: number; h: number },
  ): Promise<CropFrame[]> {
    const outputJson = path.join(os.tmpdir(), `speaker-track-${Date.now()}.json`);
    const python = this._findPython();

    const scriptCandidates = [
      path.join(process.resourcesPath ?? '', 'resources', 'active_speaker_track.py'),
      path.join(__dirname, '..', '..', '..', 'resources', 'active_speaker_track.py'),
      path.join(__dirname, '..', '..', 'resources', 'active_speaker_track.py'),
    ];
    const scriptPath = scriptCandidates.find((p) => fs.existsSync(p));
    if (!scriptPath) {
      log.warn('active_speaker_track.py not found, falling back to face detection');
      return this._detectFaces(sourceFile, startMs, endMs, 'auto');
    }

    const args = [
      scriptPath,
      '--file',    sourceFile,
      '--start',   String(startMs / 1000),
      '--end',     String(endMs / 1000),
      '--output',  outputJson,
      '--samples', String(Math.min(90, Math.max(30, Math.ceil((endMs - startMs) / 1000 * 5)))),
    ];

    if (splitScreenBbox) {
      args.push('--split-screen');
    }

    try {
      await runProcess(python, args);
      if (!fs.existsSync(outputJson)) return [];

      const data = JSON.parse(fs.readFileSync(outputJson, 'utf-8')) as {
        frames: Array<{ frameIndex: number; timestampMs: number; cx: number; cy: number; hasFace: boolean; faceSpanW?: number }>;
        speakerFaces?: Record<string, { avgCx: number }>;
      };
      try { fs.unlinkSync(outputJson); } catch { /* ignore */ }

      // Store speaker face positions for split/quad layout (same as _detectFaces does)
      if (data.speakerFaces) {
        this._lastSpeakerPositions = Object.values(data.speakerFaces)
          .map((sf) => ({ cx: sf.avgCx, cy: 0 }));
      } else {
        this._lastSpeakerPositions = [];
      }

      return data.frames.map((f) => ({
        frameIndex:  f.frameIndex,
        timestampMs: f.timestampMs,
        cx:          f.cx,
        cy:          f.cy,
        hasFace:     f.hasFace,
        faceSpanW:   f.faceSpanW ?? 0,
      }));
    } catch {
      try { fs.unlinkSync(outputJson); } catch { /* ignore */ }
      return [];
    }
  }

  /**
   * Returns exact duration of a video file in milliseconds using ffprobe.
   */
  async getVideoDurationMs(videoPath: string): Promise<number> {
    return new Promise((resolve) => {
      const args = [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        videoPath,
      ];
      execFile('ffprobe', args, (err: Error | null, stdout: string) => {
        if (err || !stdout.trim()) {
          resolve(60_000); // Default 60s fallback
          return;
        }
        const sec = parseFloat(stdout.trim());
        resolve(isNaN(sec) ? 60_000 : Math.round(sec * 1000));
      });
    });
  }

  /**
   * Render commentary video by combining original video, commentary audio track (with volume ducking),
   * and burning styled subtitles based on selected preset.
   */
  async renderCommentaryVideo(opts: {
    sourceVideoPath: string;
    ttsAudioPath: string;
    words: TranscriptWord[];
    outputPath: string;
    presetId?: CaptionPresetId;
    captionStyle?: CaptionStyle;
    duckingVolume?: number;
    durationMs: number;
    commentaryMode?: 'full' | 'hook_only' | 'hook_replay_outro';
    transitionEffect?: CommentatorTransitionEffect;
    transitionSfx?: string;
    bgMusicPath?: string;
    bgMusicVolume?: number;
    clipId?: string;
    sourceFile?: string;
    startMs?: number;
    endMs?: number;
    optionsJson?: string;
    reactionTtsPath?: string;
    reactionWords?: TranscriptWord[];
    takeawayTtsPath?: string;
    takeawayWords?: TranscriptWord[];
    customThumbnailPath?: string;
    brandingLogoPath?: string;
    originalTranscriptWords?: TranscriptWord[];
  }): Promise<void> {
    if (opts.commentaryMode === 'hook_only' || opts.commentaryMode === 'hook_replay_outro') {
      return this._renderHookOnlyCommentaryVideo(opts);
    }

    const {
      sourceVideoPath,
      ttsAudioPath,
      words,
      outputPath,
      presetId = 'tiktok',
      duckingVolume = 0.15,
      durationMs,
      sourceFile,
      startMs,
      endMs,
      optionsJson,
    } = opts;

    log.info({ sourceVideoPath, ttsAudioPath, presetId, duckingVolume }, 'Rendering final commentary video with ASS subtitles and audio mixing');

    let inputVideoPath = sourceVideoPath;
    let tmpCleanVideoPath: string | null = null;

    // If raw source file & timestamps exist, render a 100% clean video segment without original subtitles
    if (sourceFile && fs.existsSync(sourceFile) && startMs !== undefined && endMs !== undefined) {
      try {
        log.info({ sourceFile, startMs, endMs }, 'Rendering clean video segment without original subtitles for commentary');
        tmpCleanVideoPath = path.join(os.tmpdir(), `clean_commentary_${Date.now()}.mp4`);
        let parsedOpts: any = {};
        if (optionsJson) {
          try { parsedOpts = JSON.parse(optionsJson); } catch {}
        }

        await this.process({
          clipId: opts.clipId || 'clean',
          projectId: 'clean',
          sourceFile,
          startMs,
          endMs,
          outputPath: tmpCleanVideoPath,
          subtitleStyle: 'none',
          subtitlePosition: 'lower-third',
          zoomEnabled: parsedOpts.zoomEnabled ?? true,
          trackingMode: parsedOpts.trackingMode ?? 'auto',
          layoutPreset: parsedOpts.layoutPreset,
          splitLayout: parsedOpts.splitLayout,
          gameRatio: parsedOpts.gameRatio,
          gamePosition: parsedOpts.gamePosition,
          letterboxBg: parsedOpts.letterboxBg,
          logoOverlay: parsedOpts.logoOverlay,
          words: [],
          captionStyle: { ...CAPTION_PRESETS['none'], presetId: 'none' },
        });

        if (fs.existsSync(tmpCleanVideoPath)) {
          inputVideoPath = tmpCleanVideoPath;
        }
      } catch (cleanErr) {
        log.warn({ cleanErr }, 'Failed to render clean video segment, falling back to sourceVideoPath');
      }
    }

    // 1. Build ASS Subtitle Content for Commentary
    const presetKey = (presetId as CaptionPresetId) in CAPTION_PRESETS ? (presetId as CaptionPresetId) : 'tiktok';
    const resolvedCaption: CaptionStyle = opts.captionStyle ?? {
      presetId: presetKey,
      ...CAPTION_PRESETS[presetKey],
    };

    const assContent = await buildAssSubtitles(words, 0, durationMs, resolvedCaption, inputVideoPath);

    // Inject title overlay if configured in optionsJson
    let titleOverlay = (opts as any).titleOverlay;
    if (!titleOverlay && optionsJson) {
      try {
        const parsed = JSON.parse(optionsJson);
        if (parsed?.titleOverlay) titleOverlay = parsed.titleOverlay;
      } catch {}
    }

    let finalAss = assContent;
    if (titleOverlay) {
      const titleResult = buildTitleEvents(titleOverlay, durationMs);
      if (titleResult) {
        finalAss = finalAss.replace(
          /\r?\n\r?\n\[Events\]/,
          `\n${titleResult.styleLine}\n\n[Events]`
        );
        finalAss += titleResult.dialogueLine + '\n';
      }
    }

    const tmpAssPath = path.join(os.tmpdir(), `commentary-sub-${Date.now()}.ass`);
    fs.writeFileSync(tmpAssPath, finalAss, 'utf-8');

    // Escape ASS file path for FFmpeg subtitles filter on Windows
    const escapedAssPath = tmpAssPath.replace(/\\/g, '/').replace(/:/g, '\\:');

    // Robust fonts directory resolution across dev environment & production Electron build (win-unpacked)
    const possibleFontDirs = [
      path.join(process.cwd(), 'resources', 'fonts'),
      path.join(__dirname, '..', '..', 'resources', 'fonts'),
      path.join(__dirname, '..', 'resources', 'fonts'),
      path.join((process as any).resourcesPath || '', 'fonts'),
      path.join((process as any).resourcesPath || '', 'resources', 'fonts'),
      'resources/fonts',
    ];
    let resolvedFontsDir = '';
    for (const d of possibleFontDirs) {
      if (d && fs.existsSync(d)) {
        resolvedFontsDir = d;
        break;
      }
    }

    const escapedFontsDir = resolvedFontsDir
      ? resolvedFontsDir.replace(/\\/g, '/').replace(/:/g, '\\:')
      : '';

    const subtitlesFilter = escapedFontsDir
      ? `subtitles='${escapedAssPath}':fontsdir='${escapedFontsDir}'`
      : `subtitles='${escapedAssPath}'`;

    // 2. FFmpeg Command Arguments — Radio Broadcaster Dynamic Sidechain Ducking with Stream Splitting
    // Calculate compression ratio for dynamic sidechain ducking (e.g. duckingVolume 0.20 -> ratio 5.0)
    const ratio = Math.max(2, Math.min(20, Math.round((1 / Math.max(0.05, duckingVolume)) * 10) / 10));

    const filterComplex = `[0:v]${subtitlesFilter}[vout];[1:a]volume=1.2,apad,asplit=2[tts_sc][tts_mix];[0:a][tts_sc]sidechaincompress=threshold=0.015:ratio=${ratio}:attack=15:release=350:knee=2.8[bg_ducked];[bg_ducked][tts_mix]amix=inputs=2:duration=first:dropout_transition=0:weights=1 1:normalize=0[aout]`;

    const args = [
      '-y',
      '-i', inputVideoPath,
      '-i', ttsAudioPath,
      '-filter_complex', filterComplex,
      '-map', '[vout]',
      '-map', '[aout]',
      '-c:v', 'libx264',
      '-crf', '17',
      '-preset', 'slow',
      '-c:a', 'aac',
      '-b:a', '320k',
      outputPath,
    ];

    try {
      await runProcess('ffmpeg', args);
      log.info({ outputPath }, 'Commentary video rendering complete');
    } finally {
      try { fs.unlinkSync(tmpAssPath); } catch { /* ignore */ }
      if (tmpCleanVideoPath) {
        try { fs.unlinkSync(tmpCleanVideoPath); } catch { /* ignore */ }
      }
    }
  }

  private async _renderHookOnlyCommentaryVideo(opts: {
    sourceVideoPath: string;
    ttsAudioPath: string;
    words: TranscriptWord[];
    outputPath: string;
    presetId?: CaptionPresetId;
    captionStyle?: CaptionStyle;
    duckingVolume?: number;
    durationMs: number;
    commentaryMode?: 'full' | 'hook_only' | 'hook_replay_outro';
    transitionEffect?: CommentatorTransitionEffect;
    transitionSfx?: string;
    bgMusicPath?: string;
    bgMusicVolume?: number;
    clipId?: string;
    sourceFile?: string;
    startMs?: number;
    endMs?: number;
    optionsJson?: string;
    reactionTtsPath?: string;
    reactionWords?: TranscriptWord[];
    takeawayTtsPath?: string;
    takeawayWords?: TranscriptWord[];
    customThumbnailPath?: string;
    brandingLogoPath?: string;
    originalTranscriptWords?: TranscriptWord[];
  }): Promise<void> {
    const {
      sourceVideoPath,
      ttsAudioPath,
      words,
      outputPath,
      presetId = 'tiktok',
      durationMs,
      sourceFile,
      startMs = 0,
      endMs = durationMs,
      optionsJson,
      bgMusicPath,
      bgMusicVolume = 0.20,
    } = opts;

    log.info({ sourceVideoPath, ttsAudioPath, bgMusicPath, bgMusicVolume }, 'Rendering Dynamic Hook Commentary Video + Raw Replay Segment');

    // Dynamically calculate exact TTS voiceover audio duration for Hook Segment A
    let hookAudioDurationMs = 3000;
    try {
      if (fs.existsSync(ttsAudioPath)) {
        hookAudioDurationMs = await this.getVideoDurationMs(ttsAudioPath);
      }
    } catch (durErr) {
      log.warn({ durErr }, 'Failed to measure ttsAudioPath duration, fallback to 3000ms');
    }
    // Add 650ms padding (250ms natural tail + 400ms transition buffer) so dubber finishes BEFORE xfade starts
    const hookDurationMs = Math.max(2000, Math.ceil(hookAudioDurationMs) + 650);
    log.info({ hookAudioDurationMs, hookDurationMs }, 'Calculated dynamic hook intro segment duration');

    const tmpDir = os.tmpdir();
    const segAPath = path.join(tmpDir, `hook_segA_${Date.now()}.mp4`);
    const segBPath = path.join(tmpDir, `hook_segB_${Date.now()}.mp4`);

    let parsedOpts: any = {};
    if (optionsJson) {
      try { parsedOpts = JSON.parse(optionsJson); } catch {}
    }

    const rawVideoFile = (sourceFile && fs.existsSync(sourceFile)) ? sourceFile : sourceVideoPath;
    const isUsingRawFile = rawVideoFile === sourceFile;

    // -------------------------------------------------------------------------
    // 1. Render Segment A (0s – 3.0s Hook Intro)
    // -------------------------------------------------------------------------
    const tmpCleanIntroPath = path.join(tmpDir, `clean_intro_${Date.now()}.mp4`);
    if (isUsingRawFile) {
      await this.process({
        clipId: opts.clipId || 'hook_intro',
        projectId: 'clean',
        sourceFile: rawVideoFile,
        startMs,
        endMs: startMs + hookDurationMs,
        outputPath: tmpCleanIntroPath,
        subtitleStyle: 'none',
        subtitlePosition: 'lower-third',
        zoomEnabled: parsedOpts.zoomEnabled ?? true,
        trackingMode: parsedOpts.trackingMode ?? 'auto',
        layoutPreset: parsedOpts.layoutPreset,
        splitLayout: parsedOpts.splitLayout,
        gameRatio: parsedOpts.gameRatio,
        gamePosition: parsedOpts.gamePosition,
        letterboxBg: parsedOpts.letterboxBg,
        logoOverlay: parsedOpts.logoOverlay,
        words: [],
        captionStyle: { ...CAPTION_PRESETS['none'], presetId: 'none' },
      });
    }

    const introInputPath = fs.existsSync(tmpCleanIntroPath) ? tmpCleanIntroPath : sourceVideoPath;

    // Build ASS Subtitles for 3s Hook Phrase
    const presetKey = (presetId as CaptionPresetId) in CAPTION_PRESETS ? (presetId as CaptionPresetId) : 'tiktok';
    const resolvedCaption: CaptionStyle = opts.captionStyle ?? {
      presetId: presetKey,
      ...CAPTION_PRESETS[presetKey],
    };

    // Use ttsAudioPath (not introInputPath) for loudness detection — shake effect
    // must analyse the TTS voice audio since `words` timestamps are TTS-relative.
    const assContent = await buildAssSubtitles(words, 0, hookDurationMs, resolvedCaption, ttsAudioPath);
    let titleOverlay = (opts as any).titleOverlay;
    if (!titleOverlay && optionsJson) {
      try {
        const parsed = JSON.parse(optionsJson);
        if (parsed?.titleOverlay) titleOverlay = parsed.titleOverlay;
      } catch {}
    }

    let finalAss = assContent;
    if (titleOverlay) {
      const titleResult = buildTitleEvents(titleOverlay, hookDurationMs);
      if (titleResult) {
        finalAss = finalAss.replace(/\r?\n\r?\n\[Events\]/, `\n${titleResult.styleLine}\n\n[Events]`);
        finalAss += titleResult.dialogueLine + '\n';
      }
    }

    const tmpAssPathA = path.join(tmpDir, `hook-sub-${Date.now()}.ass`);
    fs.writeFileSync(tmpAssPathA, finalAss, 'utf-8');

    const escapedAssPathA = tmpAssPathA.replace(/\\/g, '/').replace(/:/g, '\\:');
    const possibleFontDirs = [
      path.join(process.cwd(), 'resources', 'fonts'),
      path.join(__dirname, '..', '..', 'resources', 'fonts'),
      path.join(__dirname, '..', 'resources', 'fonts'),
      path.join((process as any).resourcesPath || '', 'fonts'),
      path.join((process as any).resourcesPath || '', 'resources', 'fonts'),
      'resources/fonts',
    ];
    let resolvedFontsDir = '';
    for (const d of possibleFontDirs) {
      if (d && fs.existsSync(d)) {
        resolvedFontsDir = d;
        break;
      }
    }

    const escapedFontsDir = resolvedFontsDir
      ? resolvedFontsDir.replace(/\\/g, '/').replace(/:/g, '\\:')
      : '';
    const subtitlesFilterA = escapedFontsDir
      ? `subtitles='${escapedAssPathA}':fontsdir='${escapedFontsDir}'`
      : `subtitles='${escapedAssPathA}'`;

    // Audio setup for Segment A: TTS (volume 1.0) + optional BGM (Mute original video audio)
    const hasBgm = bgMusicPath && fs.existsSync(bgMusicPath);
    let filterComplexA = '';
    const argsA: string[] = ['-y', '-i', introInputPath, '-i', ttsAudioPath];

    if (hasBgm) {
      argsA.push('-i', bgMusicPath!);
      const fadeStartSec = Math.max(0, (hookDurationMs - 250) / 1000);
      filterComplexA = `[0:v]${subtitlesFilterA}[vout];[1:a]volume=1.2,apad[tts];[2:a]volume=${bgMusicVolume},afade=t=out:st=${fadeStartSec}:d=0.25[bgm];[tts][bgm]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`;
    } else {
      filterComplexA = `[0:v]${subtitlesFilterA}[vout];[1:a]volume=1.2,apad[aout]`;
    }

    argsA.push(
      '-filter_complex', filterComplexA,
      '-map', '[vout]',
      '-map', '[aout]',
      '-t', String(hookDurationMs / 1000),
      '-c:v', 'libx264', '-crf', '17', '-preset', 'slow',
      '-pix_fmt', 'yuv420p', '-s', '1080x1920',
      '-c:a', 'aac', '-b:a', '320k', '-ar', '48000', '-ac', '2',
      segAPath
    );

    emitCommentaryProgress(89, 'Rendering Segment A hook intro...');
    await runProcess('ffmpeg', argsA);

    // -------------------------------------------------------------------------
    // 2. Render Segment B (Replay Clip with Original Conversation Subtitles & Audio)
    // -------------------------------------------------------------------------
    emitCommentaryProgress(90, 'Rendering Segment B video replay...');
    const origWords: TranscriptWord[] = opts.originalTranscriptWords && opts.originalTranscriptWords.length > 0
      ? opts.originalTranscriptWords
      : (parsedOpts.words || []);
    const rawSegBWords = origWords.length > 0 ? origWords : (opts.reactionWords || []);
    const segBRawPath = path.join(tmpDir, `hook_segB_raw_${Date.now()}.mp4`);

    const inputSource = (sourceFile && fs.existsSync(sourceFile)) ? sourceFile : sourceVideoPath;
    const processStartMs = inputSource === sourceFile ? startMs : 0;
    // Add 500ms buffer so Segment B audio/video doesn't get cut by xfade transition
    const processEndMs = (inputSource === sourceFile ? endMs : (endMs - startMs)) + 500;

    // Normalize segBWords timestamps so w.startMs and w.endMs align with processStartMs and processEndMs
    let normalizedWords: TranscriptWord[] = [];
    if (rawSegBWords.length > 0) {
      const firstStart = rawSegBWords[0].startMs;
      if (inputSource === sourceFile && firstStart < startMs) {
        // Words are clip-relative (0..duration), shift them to full video timeline (startMs..endMs)
        normalizedWords = rawSegBWords.map((w) => ({
          ...w,
          startMs: w.startMs + startMs,
          endMs: w.endMs + startMs,
        }));
      } else if (inputSource !== sourceFile && firstStart >= startMs && startMs > 0) {
        // Words are full-video relative, shift them to clip-relative timeline (0..duration)
        normalizedWords = rawSegBWords.map((w) => ({
          ...w,
          startMs: Math.max(0, w.startMs - startMs),
          endMs: Math.max(0, w.endMs - startMs),
        }));
      } else {
        normalizedWords = rawSegBWords;
      }
    }

    log.info({ inputSource, processStartMs, processEndMs, wordCount: normalizedWords.length }, 'Rendering Segment B with normalized subtitles');

    await this.process({
      clipId: opts.clipId || 'hook_replay',
      projectId: 'replay',
      sourceFile: inputSource,
      startMs: processStartMs,
      endMs: processEndMs,
      outputPath: segBRawPath,
      subtitleStyle: parsedOpts.subtitleStyle || 'bold-white',
      subtitlePosition: parsedOpts.subtitlePosition || 'lower-third',
      zoomEnabled: parsedOpts.zoomEnabled ?? true,
      trackingMode: parsedOpts.trackingMode ?? 'auto',
      layoutPreset: parsedOpts.layoutPreset,
      splitLayout: parsedOpts.splitLayout,
      gameRatio: parsedOpts.gameRatio,
      gamePosition: parsedOpts.gamePosition,
      letterboxBg: parsedOpts.letterboxBg,
      logoOverlay: parsedOpts.logoOverlay,
      titleOverlay: parsedOpts.titleOverlay,
      words: normalizedWords,
      captionStyle: resolvedCaption,
    });

    // -------------------------------------------------------------------------
    // 2b. Post-process Segment B: Radio Broadcaster Dynamic Audio Ducking & Watermark
    // -------------------------------------------------------------------------
    const reactionTts = opts.reactionTtsPath;
    const hasReaction = reactionTts && fs.existsSync(reactionTts);
    const brandingLogo = opts.brandingLogoPath;
    const hasBranding = brandingLogo && fs.existsSync(brandingLogo);

    if (hasReaction || hasBranding) {
      emitCommentaryProgress(93, 'Post-processing Segment B audio ducking...');
      log.info({ hasReaction, hasBranding }, 'Post-processing Segment B with Radio Broadcaster ducking and/or branding');

      const argsB: string[] = ['-y', '-i', segBRawPath];
      let inputIdx = 1;
      const reactionIdx = hasReaction ? inputIdx++ : -1;
      const brandingIdx = hasBranding ? inputIdx++ : -1;

      if (hasReaction) argsB.push('-i', reactionTts!);
      if (hasBranding) argsB.push('-i', brandingLogo!);

      // Build filter_complex
      const filterParts: string[] = [];
      if (hasBranding) {
        filterParts.push(`[${brandingIdx}:v]format=rgba,colorchannelmixer=aa=0.35,scale=120:-1[wm];[0:v][wm]overlay=W-w-20:H-h-20[vout]`);
      }
      if (hasReaction) {
        // Dynamic sidechain ducking: when AI dubbing speaks, video audio ducks; when silent, video audio swells to 100%
        // TTS must be asplit into 2 streams: one for sidechain key signal, one for final mix
        filterParts.push(`[${reactionIdx}:a]volume=1.2,apad,asplit=2[tts_sc][tts_mix];[0:a][tts_sc]sidechaincompress=threshold=0.08:ratio=8:attack=15:release=250[ducked];[ducked][tts_mix]amix=inputs=2:duration=first:dropout_transition=0[aout]`);
      }

      const filterComplex = filterParts.join(';');
      argsB.push('-filter_complex', filterComplex);

      if (hasBranding) {
        argsB.push('-map', '[vout]');
      } else {
        argsB.push('-map', '0:v');
      }

      if (hasReaction) {
        argsB.push('-map', '[aout]');
      } else {
        argsB.push('-map', '0:a');
      }

      argsB.push(
        '-c:v', 'libx264', '-crf', '17', '-preset', 'slow',
        '-pix_fmt', 'yuv420p', '-s', '1080x1920',
        '-c:a', 'aac', '-b:a', '320k', '-ar', '48000', '-ac', '2',
        segBPath
      );

      try {
        await runProcess('ffmpeg', argsB);
        log.info('Segment B post-processed with reaction commentary and/or branding');
      } catch (postErr) {
        log.warn({ postErr }, 'Segment B post-processing failed, re-encoding raw Segment B');
        try {
          await runProcess('ffmpeg', [
            '-y', '-i', segBRawPath,
            '-c:v', 'libx264', '-crf', '17', '-preset', 'slow',
            '-pix_fmt', 'yuv420p', '-s', '1080x1920',
            '-c:a', 'aac', '-b:a', '320k', '-ar', '48000', '-ac', '2',
            segBPath,
          ]);
        } catch {
          fs.copyFileSync(segBRawPath, segBPath);
        }
      }
    } else {
      // Re-encode to ensure consistent yuv420p 1080x1920 48kHz stereo for xfade joining
      try {
        await runProcess('ffmpeg', [
          '-y', '-i', segBRawPath,
          '-c:v', 'libx264', '-crf', '17', '-preset', 'slow',
          '-pix_fmt', 'yuv420p', '-s', '1080x1920',
          '-c:a', 'aac', '-b:a', '320k', '-ar', '48000', '-ac', '2',
          segBPath,
        ]);
      } catch {
        fs.copyFileSync(segBRawPath, segBPath);
      }
    }

    // -------------------------------------------------------------------------
    // 3. Optional Custom Thumbnail Opening Muted Cover Frame (0.4s)
    // -------------------------------------------------------------------------
    const customThumb = (opts as any).customThumbnailPath;
    const hasThumb = customThumb && fs.existsSync(customThumb);
    const seg0Path = path.join(tmpDir, `hook_seg0_${Date.now()}.mp4`);

    if (hasThumb) {
      try {
        await runProcess('ffmpeg', [
          '-y',
          '-loop', '1',
          '-i', customThumb,
          '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
          '-t', '0.4',
          '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,format=yuv420p',
          '-c:v', 'libx264', '-crf', '17', '-preset', 'slow',
          '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-b:a', '320k', '-ar', '48000', '-ac', '2',
          seg0Path,
        ]);
      } catch (thumbErr) {
        log.warn({ thumbErr }, 'Failed to generate custom thumbnail opening frame');
      }
    }
    // -------------------------------------------------------------------------
    // 2c. Render Segment C (Moral Takeaway / Outro Segment for Mode 3)
    // -------------------------------------------------------------------------
    const takeawayTts = opts.takeawayTtsPath || (opts.commentaryMode === 'hook_replay_outro' ? opts.reactionTtsPath : undefined);
    const hasTakeaway = takeawayTts && fs.existsSync(takeawayTts);
    const is3SegMode = opts.commentaryMode === 'hook_replay_outro' && hasTakeaway;
    const segCPath = path.join(tmpDir, `hook_segC_${Date.now()}.mp4`);
    let tmpAssPathC = '';
    let hasSegC = false;

    if (is3SegMode) {
      emitCommentaryProgress(95, 'Rendering Segment C moral takeaway outro...');
      log.info('Rendering Segment C Educational Moral Takeaway Outro (Replaying Raw Source Video Clip)');
      let takeawayAudioDurationMs = 3500;
      try {
        takeawayAudioDurationMs = await this.getVideoDurationMs(takeawayTts!);
      } catch {}
      const takeawayDurMs = Math.max(3000, Math.ceil(takeawayAudioDurationMs) + 300);

      const tmpCleanOutroPath = path.join(tmpDir, `clean_outro_${Date.now()}.mp4`);

      // Replay raw source video clip starting from processStartMs for takeawayDurMs
      await this.process({
        clipId: opts.clipId || 'hook_outro',
        projectId: 'clean',
        sourceFile: inputSource,
        startMs: processStartMs,
        endMs: Math.min(processEndMs, processStartMs + takeawayDurMs),
        outputPath: tmpCleanOutroPath,
        subtitleStyle: 'none',
        subtitlePosition: 'lower-third',
        zoomEnabled: parsedOpts.zoomEnabled ?? true,
        trackingMode: parsedOpts.trackingMode ?? 'auto',
        layoutPreset: parsedOpts.layoutPreset,
        splitLayout: parsedOpts.splitLayout,
        gameRatio: parsedOpts.gameRatio,
        gamePosition: parsedOpts.gamePosition,
        letterboxBg: parsedOpts.letterboxBg,
        logoOverlay: parsedOpts.logoOverlay,
        words: [],
        captionStyle: { ...CAPTION_PRESETS['none'], presetId: 'none' },
      });

      const outroInputPath = fs.existsSync(tmpCleanOutroPath) ? tmpCleanOutroPath : sourceVideoPath;
      const outroWords: TranscriptWord[] = opts.takeawayWords || opts.reactionWords || [];
      // DO NOT normalize timestamps — STT-aligned words are already correct relative to the TTS audio
      // timeline (input [1:a] in the FFmpeg filter). Shifting them to 0ms causes subtitles to appear
      // before the dubber actually speaks (because TTS audio has natural silence at the beginning).
      log.info({ outroWordCount: outroWords.length, firstWord: outroWords[0] }, 'Using STT-aligned Segment C subtitle words as-is (no normalization)');

      const assContentC = await buildAssSubtitles(outroWords, 0, 999999, resolvedCaption, outroInputPath);
      tmpAssPathC = path.join(tmpDir, `commentary_subC_${Date.now()}.ass`);
      fs.writeFileSync(tmpAssPathC, assContentC, 'utf-8');

      const isWin = process.platform === 'win32';
      const escapedAssC = isWin
        ? tmpAssPathC.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:')
        : tmpAssPathC;
      const subtitlesFilterC = escapedFontsDir
        ? `subtitles='${escapedAssC}':fontsdir='${escapedFontsDir}'`
        : `subtitles='${escapedAssC}'`;

      let filterComplexC = `[0:v]${subtitlesFilterC}[vout];[1:a]volume=1.2,apad[aout]`;
      const argsC: string[] = ['-y', '-i', outroInputPath, '-i', takeawayTts!];

      if (hasBgm) {
        argsC.push('-i', bgMusicPath!);
        filterComplexC = `[0:v]${subtitlesFilterC}[vout];[1:a]volume=1.2,apad[tts];[2:a]volume=${bgMusicVolume},afade=t=in:st=0:d=0.25[bgm];[tts][bgm]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`;
      }

      argsC.push(
        '-filter_complex', filterComplexC,
        '-map', '[vout]',
        '-map', '[aout]',
        '-t', String(takeawayDurMs / 1000),
        '-shortest',
        '-c:v', 'libx264', '-crf', '17', '-preset', 'slow',
        '-pix_fmt', 'yuv420p', '-s', '1080x1920',
        '-c:a', 'aac', '-b:a', '320k', '-ar', '48000', '-ac', '2',
        segCPath
      );

      try {
        await runProcess('ffmpeg', argsC);
        hasSegC = fs.existsSync(segCPath) && fs.statSync(segCPath).size > 1000;
        log.info({ segCPath, hasSegC }, 'Successfully rendered Segment C Moral Takeaway Outro with ASS Subtitles & BGM');
      } catch (segCErr) {
        log.warn({ segCErr }, 'Failed to render Segment C Outro');
      }
    }

    const useSeg0 = hasThumb && fs.existsSync(seg0Path);
    const transitionEffect = opts.transitionEffect || 'fade';

    // Resolve Transition SFX audio path
    let sfxFilePath = '';
    if (opts.transitionSfx && opts.transitionSfx !== 'none') {
      const sfxName = opts.transitionSfx;
      const candidates = [
        sfxName,
        path.join(process.cwd(), 'resources', 'sfx', `${sfxName}.wav`),
        path.join(__dirname, '..', '..', 'resources', 'sfx', `${sfxName}.wav`),
        path.join(__dirname, '..', 'resources', 'sfx', `${sfxName}.wav`),
        path.join((process as any).resourcesPath || '', 'resources', 'sfx', `${sfxName}.wav`),
      ];
      for (const p of candidates) {
        if (p && fs.existsSync(p)) {
          sfxFilePath = p;
          break;
        }
      }
    }

    const hasSfx = !!sfxFilePath && fs.existsSync(sfxFilePath);
    emitCommentaryProgress(97, 'Joining all segments with transitions...');
    log.info({ useSeg0, hasSegC, transitionEffect, hasSfx, sfxFilePath, segAPath, segBPath, segCPath }, 'Joining Segments with transition effect and SFX');

    try {
      if (hasSegC) {
        let durA_sec = 3.0;
        let durB_sec = 5.0;
        let durC_sec = 3.5;
        try { durA_sec = (await this.getVideoDurationMs(segAPath)) / 1000; } catch {}
        try { durB_sec = (await this.getVideoDurationMs(segBPath)) / 1000; } catch {}
        try { durC_sec = (await this.getVideoDurationMs(segCPath)) / 1000; } catch {}

        // Clamp transition duration so it never exceeds 25% of shortest segment
        const tDur = Math.min(0.35, durA_sec * 0.25, durB_sec * 0.25, durC_sec * 0.25);
        const offset1 = Math.max(0.1, durA_sec - tDur);
        // After first xfade, the merged v01 duration = durA + durB - tDur
        const v01_dur = durA_sec + durB_sec - tDur;
        const offset2 = Math.max(0.1, v01_dur - tDur);
        const offset1Ms = Math.round(offset1 * 1000);
        const offset2Ms = Math.round(offset2 * 1000);

        const inputArgs: string[] = ['-y', '-i', segAPath, '-i', segBPath, '-i', segCPath];
        let inputIdx = 3;
        const sfxIdx = (hasSfx && transitionEffect !== 'none') ? inputIdx++ : -1;
        if (hasSfx && transitionEffect !== 'none') inputArgs.push('-i', sfxFilePath);

        const filterParts: string[] = [];
        if (transitionEffect !== 'none') {
          filterParts.push(`[0:v][1:v]xfade=transition=${transitionEffect}:duration=${tDur}:offset=${offset1}[v01]`);
          filterParts.push(`[v01][2:v]xfade=transition=${transitionEffect}:duration=${tDur}:offset=${offset2}[vout]`);

          filterParts.push(`[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a0]`);
          filterParts.push(`[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a1]`);
          filterParts.push(`[2:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a2]`);
          filterParts.push(`[a0][a1]acrossfade=d=${tDur}:c1=tri:c2=tri[a01]`);
          filterParts.push(`[a01][a2]acrossfade=d=${tDur}:c1=tri:c2=tri[aout_raw]`);

          if (hasSfx && sfxIdx >= 0) {
            filterParts.push(`[${sfxIdx}:a]asplit=2[sfxA][sfxB]`);
            filterParts.push(`[sfxA]adelay=${offset1Ms}|${offset1Ms},volume=0.85[sfx1]`);
            filterParts.push(`[sfxB]adelay=${offset2Ms}|${offset2Ms},volume=0.85[sfx2]`);
            filterParts.push(`[aout_raw][sfx1][sfx2]amix=inputs=3:duration=first:dropout_transition=0:normalize=0[aout]`);
          } else {
            filterParts.push(`[aout_raw]anull[aout]`);
          }
        } else {
          filterParts.push('[0:v][0:a][1:v][1:a][2:v][2:a]concat=n=3:v=1:a=1[vout][aout]');
        }

        inputArgs.push(
          '-filter_complex', filterParts.join(';'),
          '-map', '[vout]',
          '-map', '[aout]',
          '-c:v', 'libx264', '-crf', '17', '-preset', 'medium',
          '-c:a', 'aac', '-b:a', '320k',
          outputPath
        );
        const totalJoinDur = durA_sec + durB_sec + durC_sec - 2 * tDur;
        await runProcessWithRealtimeProgress(inputArgs, totalJoinDur, 97, 99);
      } else {
        let durA_sec = 3.0;
        let durB_sec = 5.0;
        try { durA_sec = (await this.getVideoDurationMs(segAPath)) / 1000; } catch {}
        try { durB_sec = (await this.getVideoDurationMs(segBPath)) / 1000; } catch {}
        const tDur2 = Math.min(0.35, durA_sec * 0.25, durB_sec * 0.25);
        const offset1 = Math.max(0.1, durA_sec - tDur2);
        const offset1Ms = Math.round(offset1 * 1000);

        const inputArgs: string[] = ['-y', '-i', segAPath, '-i', segBPath];
        let inputIdx = 2;
        const sfxIdx = (hasSfx && transitionEffect !== 'none') ? inputIdx++ : -1;
        if (hasSfx && transitionEffect !== 'none') inputArgs.push('-i', sfxFilePath);

        const filterParts: string[] = [];
        if (transitionEffect !== 'none') {
          filterParts.push(`[0:v][1:v]xfade=transition=${transitionEffect}:duration=${tDur2}:offset=${offset1}[vout]`);

          filterParts.push(`[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a0]`);
          filterParts.push(`[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a1]`);
          filterParts.push(`[a0][a1]acrossfade=d=${tDur2}:c1=tri:c2=tri[aout_raw]`);

          if (hasSfx && sfxIdx >= 0) {
            filterParts.push(`[${sfxIdx}:a]adelay=${offset1Ms}|${offset1Ms},volume=0.85[sfx1]`);
            filterParts.push(`[aout_raw][sfx1]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`);
          } else {
            filterParts.push(`[aout_raw]anull[aout]`);
          }
        } else {
          filterParts.push('[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[vout][aout]');
        }

        inputArgs.push(
          '-filter_complex', filterParts.join(';'),
          '-map', '[vout]',
          '-map', '[aout]',
          '-c:v', 'libx264', '-crf', '17', '-preset', 'medium',
          '-c:a', 'aac', '-b:a', '320k',
          outputPath
        );
        const totalJoinDur2 = durA_sec + durB_sec - tDur2;
        await runProcessWithRealtimeProgress(inputArgs, totalJoinDur2, 97, 99);
      }
      log.info({ outputPath, transitionEffect, hasSfx, hasSegC }, 'Successfully generated Hook Commentary + Replay video with transition, SFX & BGM');
    } finally {
      try { fs.unlinkSync(tmpAssPathA); } catch {}
      try { fs.unlinkSync(segAPath); } catch {}
      try { fs.unlinkSync(segBPath); } catch {}
      try { fs.unlinkSync(segBRawPath); } catch {}
      try { if (hasSegC) fs.unlinkSync(segCPath); } catch {}
      try { if (hasSegC && tmpAssPathC) fs.unlinkSync(tmpAssPathC); } catch {}
      try { if (useSeg0) fs.unlinkSync(seg0Path); } catch {}
    }
  }
}


