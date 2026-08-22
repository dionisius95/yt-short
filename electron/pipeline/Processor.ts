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
import { BrollManager } from './BrollManager';
import type { TranscriptWord, SubtitleStyle, SubtitlePosition, CropFrame, CaptionStyle, CaptionPresetId, LogoOverlay, LayoutPreset, SplitLayout, GameRatio, GamePosition, LetterboxBackground, TitleOverlay, CommentatorTransitionEffect, BrollConfig } from '../../shared/types';
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
    return { t: tSec, x: computeCropX(f), y: computeCropY(f), isCut: f.isCut ?? false };
  });

  keyframes.sort((a, b) => a.t - b.t);

  // Ensure crop starts at t=0
  if (keyframes[0].t > 0.05) {
    keyframes.unshift({ t: 0, x: keyframes[0].x, y: keyframes[0].y, isCut: false });
  }

  // Cap at 30 keyframes to avoid FFmpeg expression depth overflow, preserving scene cuts
  const MAX_KEYFRAMES = 30;
  if (keyframes.length > MAX_KEYFRAMES) {
    const cutIndices = new Set(keyframes.map((k, idx) => k.isCut ? idx : -1).filter((idx) => idx >= 0));
    const step = (keyframes.length - 1) / (MAX_KEYFRAMES - 1);
    const sampledMap = new Map<number, typeof keyframes[0]>();
    for (let i = 0; i < MAX_KEYFRAMES; i++) {
      const idx = Math.round(i * step);
      sampledMap.set(idx, keyframes[idx]);
    }
    for (const cutIdx of cutIndices) {
      sampledMap.set(cutIdx, keyframes[cutIdx]);
    }
    const sampled = Array.from(sampledMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map((entry) => entry[1]);
    keyframes.length = 0;
    keyframes.push(...sampled.slice(0, MAX_KEYFRAMES + 6));
  }

  // ── Build FFmpeg piecewise-linear expression for X and Y with hard-cut support ─────────────────
  function buildLerpExpr(axis: 'x' | 'y'): string {
    if (keyframes.length <= 1) return String(keyframes[0]?.[axis] ?? 0);

    let expr = String(keyframes[keyframes.length - 1][axis]);

    for (let i = keyframes.length - 2; i >= 0; i--) {
      const k0 = keyframes[i];
      const k1 = keyframes[i + 1];
      const dt = k1.t - k0.t;
      const dv = k1[axis] - k0[axis];

      let segExpr: string;
      if (dt < 0.001 || dv === 0 || k1.isCut) {
        // Hard step jump on scene cut or zero duration
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

  const fontName = (title.font === 'System' || (title.font as string) === 'system')
    ? (process.platform === 'win32' ? 'Segoe UI' : 'Arial')
    : title.font;

  const styleLine =
    `Style: Title,${fontName},${title.fontSize},${primaryAss},&H000000FF,${outlineAss},${backAss},${bold},0,0,0,100,100,1,0,1,${title.outlineSize},0,2,60,60,0,1`;

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
 * Analyse per-word loudness using a single-pass 8kHz PCM audio extraction.
 * Returns a Set of word indices whose RMS loudness exceeds dynamic threshold.
 * Works instantaneously for any number of words without spawning multiple processes.
 */
async function detectLoudWords(
  sourceFile: string,
  clipWords: Array<{ startMs: number; endMs: number }>,
  clipStartMs: number,
  thresholdDb = -18,
): Promise<Set<number>> {
  const loudIndices = new Set<number>();
  if (!fs.existsSync(sourceFile) || clipWords.length === 0) {
    return loudIndices;
  }

  try {
    const SAMPLE_RATE = 8000;
    const clipStartSec = Math.max(0, clipStartMs / 1000);
    const maxEndMs = Math.max(...clipWords.map((w) => w.endMs));
    const durSec = Math.max(1, Math.ceil(maxEndMs / 1000) + 1);

    const pcmBuffer = await new Promise<Buffer>((resolve) => {
      const proc = spawn('ffmpeg', [
        '-ss', String(clipStartSec),
        '-t',  String(durSec),
        '-i',  sourceFile,
        '-vn',
        '-ac', '1',
        '-ar', String(SAMPLE_RATE),
        '-f',  's16le',
        '-',
      ], { stdio: ['ignore', 'pipe', 'ignore'] });

      const chunks: any[] = [];
      proc.stdout?.on('data', (c: any) => chunks.push(c));
      proc.on('close', () => resolve(Buffer.concat(chunks)));
      proc.on('error', () => resolve(Buffer.alloc(0)));
      setTimeout(() => { proc.kill(); resolve(Buffer.alloc(0)); }, 10_000);
    });

    if (pcmBuffer.length < 100) return loudIndices;

    const totalSamples = Math.floor(pcmBuffer.length / 2);
    const results: Array<{ i: number; db: number }> = [];

    for (let i = 0; i < clipWords.length; i++) {
      const w = clipWords[i];
      if (w.endMs - w.startMs < 60) continue;

      const s0 = Math.max(0, Math.floor((w.startMs / 1000) * SAMPLE_RATE));
      const s1 = Math.min(totalSamples, Math.ceil((w.endMs / 1000) * SAMPLE_RATE));
      if (s1 <= s0) continue;

      let sumSq = 0;
      for (let s = s0; s < s1; s++) {
        const val = pcmBuffer.readInt16LE(s * 2) / 32768;
        sumSq += val * val;
      }
      const rms = Math.sqrt(sumSq / (s1 - s0));
      const db = rms > 0 ? 20 * Math.log10(rms) : -99;
      if (db > -80) {
        results.push({ i, db });
      }
    }

    if (results.length > 0) {
      const validDbs = results.map((r) => r.db);
      const maxDb = Math.max(...validDbs);
      // Words within 4.5 dB of peak volume in clip OR >= thresholdDb
      const cutoffDb = Math.min(thresholdDb, maxDb - 4.5);
      for (const { i, db } of results) {
        if (db >= cutoffDb) {
          loudIndices.add(i);
        }
      }
    }
  } catch (err) {
    log.warn({ err }, 'Fast loudness detection failed, continuing without shake effect');
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
export async function buildAssSubtitles(
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

  // 1. Filter and offset words to clip-relative time
  const rawClipWords: Array<{ word: string; startMs: number; endMs: number }> = [];
  for (const w of words) {
    if (!w || !w.word || !w.word.trim()) continue;
    if (w.endMs <= startMs || w.startMs >= endMs) continue;

    const s = Math.max(0, w.startMs - startMs);
    const clampedEnd = Math.min(w.endMs, w.startMs + 3500);
    const e = Math.min(endMs - startMs, Math.max(clampedEnd - startMs, s + 50));
    if (e > s) {
      rawClipWords.push({
        word: w.word.trim(),
        startMs: s,
        endMs: e,
      });
    }
  }

  // Sort chronologically
  rawClipWords.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  // 2. De-overlap consecutive words (clean chronological chain, zero overlaps)
  const clipWords: Array<{ word: string; startMs: number; endMs: number }> = [];
  for (const w of rawClipWords) {
    if (clipWords.length === 0) {
      clipWords.push(w);
      continue;
    }
    const prev = clipWords[clipWords.length - 1];

    if (w.startMs < prev.startMs) {
      w.startMs = prev.startMs;
    }

    if (prev.endMs > w.startMs) {
      if (w.startMs > prev.startMs + 50) {
        prev.endMs = w.startMs;
      } else {
        w.startMs = prev.endMs;
        if (w.endMs <= w.startMs) {
          w.endMs = w.startMs + 60;
        }
      }
    }

    if (w.endMs > w.startMs) {
      clipWords.push(w);
    }
  }

  const primaryAss   = hexToAss(style.primaryColor);
  const outlineAss   = hexToAss(style.outlineColor);
  const highlightAss = hexToAss(style.highlightColor);
  const backAss      = '&H80000000';

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

  const fontName = (style.font === 'System' || (style.font as string) === 'system')
    ? (process.platform === 'win32' ? 'Segoe UI' : 'Arial')
    : style.font;

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 1

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontName},${style.fontSize},${primaryAss},&H000000FF,${outlineAss},${backAss},${style.bold ? 1 : 0},0,0,0,100,100,1,0,1,${style.outlineSize},${style.shadowSize},${alignment},60,60,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  if (clipWords.length === 0) {
    return header;
  }

  // ── Loudness detection ────────────────────────────────────────────────────
  let loudSet = new Set<number>();
  if (sourceFile && style.shakeEffect !== false) {
    try {
      loudSet = await detectLoudWords(sourceFile, clipWords, startMs);
    } catch {
      // Non-fatal — continue without shake effect
    }
  }

  const fmt = (ms: number): string => {
    const h  = Math.floor(ms / 3_600_000);
    const m  = Math.floor((ms % 3_600_000) / 60_000);
    const s  = Math.floor((ms % 60_000) / 1_000);
    const cs = Math.floor((ms % 1_000) / 10);
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  };

  function lcgRand(seed: number): () => number {
    let s = seed;
    return () => {
      s = (s * 1664525 + 1013904223) & 0xffffffff;
      return (s >>> 0) / 0xffffffff;
    };
  }

  const dialogueLines: string[] = [];
  const { x: baseX, y: baseY } = basePos(style);
  const wordsPerLine = Math.max(1, style.lines || 1);
  const MAX_GROUP_GAP_MS = 600; // split group if pause between words > 600ms
  const isShakeEnabled = style.shakeEffect !== false;

  // 3. Intelligent grouping into visual lines
  const groups: Array<Array<{ word: string; startMs: number; endMs: number; wordIdx: number }>> = [];
  let currentGroup: Array<{ word: string; startMs: number; endMs: number; wordIdx: number }> = [];

  for (let i = 0; i < clipWords.length; i++) {
    const w = { ...clipWords[i], wordIdx: i };
    if (currentGroup.length === 0) {
      currentGroup.push(w);
      continue;
    }

    const prevW = currentGroup[currentGroup.length - 1];
    const gap = w.startMs - prevW.endMs;

    const isTerminal = /[.!?]$/.test(prevW.word.trim()) && gap > 200;
    const isLargeGap = gap > MAX_GROUP_GAP_MS;
    const isFull = currentGroup.length >= wordsPerLine;

    if (isFull || isLargeGap || isTerminal) {
      groups.push(currentGroup);
      currentGroup = [w];
    } else {
      currentGroup.push(w);
    }
  }
  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  const clipDurationMs = endMs - startMs;
  const MIN_HOLD_MS = 500; // minimum duration (ms) a subtitle line stays on screen
  const GAP_BRIDGE_MS = 750; // bridge natural pauses under 750ms to eliminate subtitle blinking

  if (style.karaokeHighlight) {
    // ── Karaoke Highlight Mode ──────────────────────────────────────────────
    for (let gi = 0; gi < groups.length; gi++) {
      const group = groups[gi];
      const nextGroupStart = gi + 1 < groups.length ? groups[gi + 1][0].startMs : clipDurationMs;

      const grpStart = group[0].startMs;
      const rawGrpEnd = group[group.length - 1].endMs;
      let grpEnd: number;
      if (nextGroupStart - rawGrpEnd <= GAP_BRIDGE_MS) {
        // Seamless bridge across speaking pause — zero blink
        grpEnd = nextGroupStart;
      } else {
        // Long silence/pause: hold for minimum readability before disappearing
        grpEnd = Math.min(nextGroupStart, Math.max(rawGrpEnd + 400, grpStart + MIN_HOLD_MS));
      }

      for (let wi = 0; wi < group.length; wi++) {
        const activeWord = group[wi];

        // Start time for this word's active highlight
        const evStart = wi === 0
          ? grpStart
          : (group[wi].startMs > group[wi - 1].endMs ? group[wi].startMs : group[wi - 1].endMs);

        // End time for this word's active highlight (bridge gap to next word in group so subtitle line doesn't blink off)
        let evEnd: number;
        if (wi < group.length - 1) {
          const nextWordStart = group[wi + 1].startMs;
          evEnd = Math.min(Math.max(activeWord.endMs, nextWordStart), nextGroupStart);
        } else {
          evEnd = grpEnd;
        }

        const safeStart = Math.max(0, evStart);
        const safeEnd = Math.max(safeStart + 40, evEnd);
        const isLoud = isShakeEnabled && loudSet.has(activeWord.wordIdx);

        const lineText = group.map((w, j) => {
          const wt = style.uppercase ? w.word.trim().toUpperCase() : w.word.trim();
          if (j === wi) {
            const bouncyTag = isLoud
              ? '{\\t(0,80,\\fscx115\\fscy115)\\t(80,180,\\fscx100\\fscy100)}'
              : '{\\t(0,80,\\fscx110\\fscy110)\\t(80,160,\\fscx100\\fscy100)}';
            return `{\\1c${highlightAss}}${bouncyTag}${wt}`;
          }
          return `{\\1c${primaryAss}}{\\fscx100\\fscy100}${wt}`;
        }).join(' ');

        const animPrefix = style.animation === 'fade' ? '{\\fad(100,100)}' : '';

        if (isLoud) {
          // Micro-segment camera shake during loud word highlight
          const SHAKE_INTERVAL_MS = 35;
          const SHAKE_AMPLITUDE = 12;
          const rand = lcgRand(activeWord.wordIdx * 7919);

          for (let t = safeStart; t < safeEnd; t += SHAKE_INTERVAL_MS) {
            const segS = t;
            const segE = Math.min(t + SHAKE_INTERVAL_MS, safeEnd);
            const dx = Math.round((rand() * 2 - 1) * SHAKE_AMPLITUDE);
            const dy = Math.round((rand() * 2 - 1) * SHAKE_AMPLITUDE);
            const posTag = `{\\pos(${baseX + dx},${baseY + dy})}`;
            const text = `${animPrefix}{\\an${alignment}}${posTag}${lineText}`;
            dialogueLines.push(
              `Dialogue: 0,${fmt(segS)},${fmt(segE)},Default,,0,0,0,,${text}`
            );
          }
        } else {
          const posTag = style.captionY !== undefined ? `{\\pos(${baseX},${baseY})}` : '';
          const text = `${animPrefix}{\\an${alignment}}${posTag}${lineText}`;
          dialogueLines.push(
            `Dialogue: 0,${fmt(safeStart)},${fmt(safeEnd)},Default,,0,0,0,,${text}`
          );
        }
      }
    }
  } else {
    // ── Non-Karaoke Mode ───────────────────────────────────────────────────
    for (let gi = 0; gi < groups.length; gi++) {
      const group = groups[gi];
      const nextGroupStart = gi + 1 < groups.length ? groups[gi + 1][0].startMs : clipDurationMs;

      const grpStart = group[0].startMs;
      const rawGrpEnd = group[group.length - 1].endMs;
      let grpEnd: number;
      if (nextGroupStart - rawGrpEnd <= GAP_BRIDGE_MS) {
        grpEnd = nextGroupStart;
      } else {
        grpEnd = Math.min(nextGroupStart, Math.max(rawGrpEnd + 400, grpStart + MIN_HOLD_MS));
      }

      const safeStart = Math.max(0, grpStart);
      const safeEnd = Math.max(safeStart + 40, grpEnd);

      const isAnyLoud = isShakeEnabled && group.some((w) => loudSet.has(w.wordIdx));
      const groupText = group
        .map((w) => (style.uppercase ? w.word.trim().toUpperCase() : w.word.trim()))
        .join(' ');

      const colorTag = style.highlightColor !== style.primaryColor
        ? `{\\1c${highlightAss}}`
        : `{\\1c${primaryAss}}`;

      const bouncyTag = isAnyLoud
        ? '{\\t(0,80,\\fscx115\\fscy115)\\t(80,180,\\fscx100\\fscy100)}'
        : style.animation === 'pop'
        ? '{\\t(0,80,\\fscx110\\fscy110)\\t(80,160,\\fscx100\\fscy100)}'
        : '';

      let extraAnimTag = '';
      if (style.animation === 'fade') {
        extraAnimTag = '{\\fad(150,150)}';
      } else if (style.animation === 'slide-up') {
        const slideFromY = baseY + 100;
        extraAnimTag = `{\\move(${baseX},${slideFromY},${baseX},${baseY},0,200)}`;
      }

      const anTag = `{\\an${alignment}}`;

      if (isAnyLoud) {
        const SHAKE_INTERVAL_MS = 35;
        const SHAKE_AMPLITUDE = 12;
        const rand = lcgRand(group[0].wordIdx * 7919);

        for (let t = safeStart; t < safeEnd; t += SHAKE_INTERVAL_MS) {
          const segS = t;
          const segE = Math.min(t + SHAKE_INTERVAL_MS, safeEnd);
          const dx = Math.round((rand() * 2 - 1) * SHAKE_AMPLITUDE);
          const dy = Math.round((rand() * 2 - 1) * SHAKE_AMPLITUDE);
          const posTag = `{\\pos(${baseX + dx},${baseY + dy})}`;
          const text = `${anTag}${posTag}${bouncyTag}${colorTag}${extraAnimTag}${groupText}`;
          dialogueLines.push(
            `Dialogue: 0,${fmt(segS)},${fmt(segE)},Default,,0,0,0,,${text}`
          );
        }
      } else {
        const posTag = style.captionY !== undefined ? `{\\pos(${baseX},${baseY})}` : '';
        const text = `${anTag}${posTag}${bouncyTag}${colorTag}${extraAnimTag}${groupText}`;
        dialogueLines.push(
          `Dialogue: 0,${fmt(safeStart)},${fmt(safeEnd)},Default,,0,0,0,,${text}`
        );
      }
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
    const shouldTrack = trackingMode !== 'none' && (zoomEnabled || trackingMode === 'speaker' || trackingMode === 'manual' || trackingMode === 'auto');

    if (shouldTrack) {
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
        const effectiveCropFilter = (shouldTrack || cropFrames.length > 0) ? cropFilter : undefined;
        const { filterComplex, mapVideo, needsImageInput } = buildLetterboxFilter(
          assForFfmpeg, lbBg, logo, effectiveCropFilter
        );
        const imageInput = needsImageInput && lbBg.imagePath && fs.existsSync(lbBg.imagePath)
          ? ['-i', lbBg.imagePath] : [];
        const logoInput = logo ? ['-i', logo.filePath] : [];
        // If image mode but file missing, fall back to blur
        const effectiveFc = (needsImageInput && imageInput.length === 0)
          ? buildLetterboxFilter(assForFfmpeg, { ...lbBg, type: 'blur' }, logo, effectiveCropFilter).filterComplex
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
      const shouldTrack = trackingMode !== 'none' && (zoomEnabled || trackingMode === 'speaker' || trackingMode === 'manual' || trackingMode === 'auto');
      if (shouldTrack) {
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
        const effectiveCropFilter = (shouldTrack || cropFrames.length > 0) ? cropFilter : undefined;
        const { filterComplex: rawFc, needsImageInput } = buildLetterboxFilter(assForFfmpeg, lbBg, logo, effectiveCropFilter);
        const imageInput = needsImageInput && lbBg.imagePath && fs.existsSync(lbBg.imagePath)
          ? ['-i', lbBg.imagePath] : [];
        const logoInput = logo ? ['-i', logo.filePath] : [];
        const baseFc = (needsImageInput && imageInput.length === 0)
          ? buildLetterboxFilter(assForFfmpeg, { ...lbBg, type: 'blur' }, logo, effectiveCropFilter).filterComplex
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
        frames: Array<{ frameIndex: number; timestampMs: number; cx: number; cy: number; hasFace: boolean; faceSpanW?: number; isCut?: boolean }>;
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
        isCut:       f.isCut ?? false,
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
        frames: Array<{ frameIndex: number; timestampMs: number; cx: number; cy: number; hasFace: boolean; faceSpanW?: number; isCut?: boolean }>;
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
        isCut:       f.isCut ?? false,
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
    reactionDurationMs?: number;
    interruptionTimestampSec?: number;
    takeawayTtsPath?: string;
    takeawayWords?: TranscriptWord[];
    customThumbnailPath?: string;
    brandingLogoPath?: string;
    brollConfig?: BrollConfig;
    originalTranscriptWords?: TranscriptWord[];
    pexelsApiKey?: string;
    pixabayApiKey?: string;
    hookHeadline?: string;
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

    let parsedOpts: any = {};
    if (optionsJson) {
      try { parsedOpts = JSON.parse(optionsJson); } catch {}
    }

    let inputVideoPath = sourceVideoPath;
    let tmpCleanVideoPath: string | null = null;

    // If raw source file & timestamps exist, render a 100% clean video segment without original subtitles
    if (sourceFile && fs.existsSync(sourceFile) && startMs !== undefined && endMs !== undefined) {
      try {
        log.info({ sourceFile, startMs, endMs }, 'Rendering clean video segment without original subtitles for commentary');
        tmpCleanVideoPath = path.join(os.tmpdir(), `clean_commentary_${Date.now()}.mp4`);

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

    // Generate ASS subtitle file
    const resolvedCaption: CaptionStyle = opts.captionStyle ?? {
      presetId,
      ...CAPTION_PRESETS[presetId],
    };

    // Use ttsAudioPath (not inputVideoPath) for loudness detection — shake effect
    // must analyse the TTS voice audio since `words` timestamps are TTS-relative.
    const assContent = await buildAssSubtitles(words, 0, durationMs, resolvedCaption, ttsAudioPath);
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
        finalAss = finalAss.replace(/\r?\n\r?\n\[Events\]/, `\n${titleResult.styleLine}\n\n[Events]`);
        finalAss += titleResult.dialogueLine + '\n';
      }
    }

    const tmpAssPath = path.join(os.tmpdir(), `commentary-sub-${Date.now()}.ass`);
    fs.writeFileSync(tmpAssPath, finalAss, 'utf-8');

    // Build FFmpeg command with subtitles filter and audio ducking
    const isWin = process.platform === 'win32';
    const escapedAssPath = isWin
      ? tmpAssPath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:')
      : tmpAssPath;

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
      ? (isWin ? resolvedFontsDir.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:') : resolvedFontsDir)
      : '';

    const subtitlesFilter = escapedFontsDir
      ? `subtitles='${escapedAssPath}':fontsdir='${escapedFontsDir}'`
      : `subtitles='${escapedAssPath}'`;

    const bgMusicPath = opts.bgMusicPath;
    const hasBgm = bgMusicPath && fs.existsSync(bgMusicPath);

    const args: string[] = [
      '-y',
      '-i', inputVideoPath,
      '-i', ttsAudioPath,
    ];

    let bgmIdx = 2;
    if (hasBgm) {
      args.push('-i', bgMusicPath!);
      bgmIdx = args.length / 2 - 1; // 2
    }

    let brandIdx = -1;
    const brandingLogoPath = opts.brandingLogoPath;
    const hasBranding = brandingLogoPath && fs.existsSync(brandingLogoPath);
    if (hasBranding) {
      args.push('-i', brandingLogoPath!);
      brandIdx = hasBgm ? 3 : 2;
    }

    // Video filter chain: optional Branding Logo -> ASS subtitles
    const filterParts: string[] = [];
    let currentVLabel = '0:v';

    if (hasBranding) {
      filterParts.push(`[${brandIdx}:v]scale=120:-1[brand_scaled]`);
      filterParts.push(`[0:v][brand_scaled]overlay=W-w-32:32[vout_brand]`);
      currentVLabel = 'vout_brand';
    }

    filterParts.push(`[${currentVLabel}]${subtitlesFilter}[vout]`);

    // Audio mixing with sidechain ducking + optional BGM (BGM volume stays constant, original video audio ducks)
    const ratio = Math.max(2, Math.min(20, Math.round((1 / Math.max(0.05, duckingVolume)) * 10) / 10));
    if (hasBgm) {
      const bgmVol = opts.bgMusicVolume ?? 0.20;
      filterParts.push(`[1:a]volume=1.3,apad,asplit=2[tts_sc][tts_mix];[0:a][tts_sc]sidechaincompress=threshold=0.015:ratio=${ratio}:attack=15:release=350:knee=2.8[bg_ducked];[${bgmIdx}:a]volume=${bgmVol}[bgm_layer];[bg_ducked][bgm_layer][tts_mix]amix=inputs=3:duration=first:dropout_transition=0:weights=1 1 1:normalize=0[aout]`);
    } else {
      filterParts.push(`[1:a]volume=1.3,apad,asplit=2[tts_sc][tts_mix];[0:a][tts_sc]sidechaincompress=threshold=0.015:ratio=${ratio}:attack=15:release=350:knee=2.8[bg_ducked];[bg_ducked][tts_mix]amix=inputs=2:duration=first:dropout_transition=0:weights=1 1:normalize=0[aout]`);
    }

    args.push(
      '-filter_complex', filterParts.join(';'),
      '-map', '[vout]',
      '-map', '[aout]',
      '-c:v', 'libx264',
      '-crf', '17',
      '-preset', 'slow',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '320k',
      outputPath,
    );

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
    reactionDurationMs?: number;
    interruptionTimestampSec?: number;
    takeawayTtsPath?: string;
    takeawayWords?: TranscriptWord[];
    customThumbnailPath?: string;
    brandingLogoPath?: string;
    brollConfig?: BrollConfig;
    originalTranscriptWords?: TranscriptWord[];
    pexelsApiKey?: string;
    pixabayApiKey?: string;
    hookHeadline?: string;
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
    // High-retention J-Cut: 1.2s raw cartoon dialogue before TTS voiceover + 1.15x speed rate
    const voiceDelayMs = 1200;
    const effectiveTtsDurMs = Math.ceil(hookAudioDurationMs / 1.15);
    const hookDurationMs = Math.max(3000, effectiveTtsDurMs + voiceDelayMs + 450);
    log.info({ hookAudioDurationMs, effectiveTtsDurMs, voiceDelayMs, hookDurationMs }, 'Calculated dynamic hook intro segment duration with J-Cut');

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
    // 1. Render Segment A (0s – 3.5s Hook Intro)
    // Logo & Channel Title Overlay are hidden in 0-3.5s, replaced by Auto Top Hook Banner
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
        logoOverlay: undefined, // Hide channel logo in 0-3.5s hook intro
        words: [],
        captionStyle: { ...CAPTION_PRESETS['none'], presetId: 'none' },
      });
    }

    const introInputPath = fs.existsSync(tmpCleanIntroPath) ? tmpCleanIntroPath : sourceVideoPath;

    // Build ASS Subtitles for Hook Phrase shifted by voiceDelayMs and scaled by 1.15x
    const presetKey = (presetId as CaptionPresetId) in CAPTION_PRESETS ? (presetId as CaptionPresetId) : 'tiktok';
    const resolvedCaption: CaptionStyle = opts.captionStyle ?? {
      presetId: presetKey,
      ...CAPTION_PRESETS[presetKey],
    };

    const shiftedWordsA: TranscriptWord[] = (words || []).map(w => ({
      ...w,
      startMs: Math.round(w.startMs / 1.15 + voiceDelayMs),
      endMs: Math.round(w.endMs / 1.15 + voiceDelayMs),
    }));

    const assContent = await buildAssSubtitles(shiftedWordsA, 0, hookDurationMs, resolvedCaption, ttsAudioPath);
    // Auto Top Hook Banner (High-contrast curiosity headline in the top third 0-3.5s)
    let finalAss = assContent;
    let hookHeadlineText = (opts.hookHeadline || '').trim();
    if (!hookHeadlineText && words && words.length > 0) {
      hookHeadlineText = words.map(w => w.word).join(' ').trim();
    }

    if (hookHeadlineText) {
      const bannerDurationSec = Math.min(3.5, hookDurationMs / 1000);
      const durFormat = (sec: number) => {
        const m = Math.floor(sec / 60);
        const s = (sec % 60).toFixed(2);
        return `0:${m.toString().padStart(2, '0')}:${s.padStart(5, '0')}`;
      };
      const endFormatted = durFormat(bannerDurationSec);

      // Smart 2-line balancing for maximum readability without ugly '...' truncation
      const wordsArr = hookHeadlineText.split(/\s+/).filter(Boolean);
      let displayHook = '';
      if (wordsArr.length > 5) {
        const mid = Math.ceil(wordsArr.length / 2);
        displayHook = wordsArr.slice(0, mid).join(' ') + '\\N' + wordsArr.slice(mid).join(' ');
      } else {
        displayHook = wordsArr.join(' ');
      }

      // Premium High-Converting Banner: Bold Montserrat 52px, vibrant yellow text with solid dark badge box at Y: 140px
      const bannerStyleLine = `Style: HookBanner,Montserrat,52,&H0000FFFF,&H000000FF,&H00000000,&H00111111,-1,0,0,0,100,100,1,0,3,14,0,8,48,48,140,1`;
      const bannerDialogueLine = `Dialogue: 1,0:00:00.00,${endFormatted},HookBanner,,0,0,0,,{\\fad(120,200)}⚠️ ${displayHook.toUpperCase()}`;

      finalAss = finalAss.replace(/\r?\n\r?\n\[Events\]/, `\n${bannerStyleLine}\n\n[Events]`);
      finalAss += bannerDialogueLine + '\n';
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

    // Audio setup for Segment A: J-Cut raw cartoon audio for 1.2s then ducked, 1.15x TTS + optional BGM
    const hasBgm = bgMusicPath && fs.existsSync(bgMusicPath);
    let filterComplexA = '';
    const argsA: string[] = ['-y', '-i', introInputPath, '-i', ttsAudioPath];

    if (hasBgm) {
      argsA.push('-i', bgMusicPath!);
      const fadeStartSec = Math.max(0, (hookDurationMs - 250) / 1000);
      filterComplexA = `[0:v]${subtitlesFilterA}[vout];[0:a]volume='if(lt(t,1.0),1.0,if(lt(t,1.3),1.0-(t-1.0)/0.3*(1.0-0.12),0.12))':eval=frame,aformat=sample_rates=48000:channel_layouts=stereo[orig_a];[1:a]atempo=1.15,adelay=1200|1200,volume=1.4,apad,aformat=sample_rates=48000:channel_layouts=stereo[tts];[2:a]volume=${bgMusicVolume},afade=t=in:st=1.0:d=0.4,afade=t=out:st=${fadeStartSec}:d=0.25,aformat=sample_rates=48000:channel_layouts=stereo[bgm];[orig_a][tts][bgm]amix=inputs=3:duration=first:dropout_transition=0:weights=1 1 1:normalize=0[aout]`;
    } else {
      filterComplexA = `[0:v]${subtitlesFilterA}[vout];[0:a]volume='if(lt(t,1.0),1.0,if(lt(t,1.3),1.0-(t-1.0)/0.3*(1.0-0.12),0.12))':eval=frame,aformat=sample_rates=48000:channel_layouts=stereo[orig_a];[1:a]atempo=1.15,adelay=1200|1200,volume=1.4,apad,aformat=sample_rates=48000:channel_layouts=stereo[tts];[orig_a][tts]amix=inputs=2:duration=first:dropout_transition=0:weights=1 1:normalize=0[aout]`;
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
    // 2. Render Segment B (Raw Replay with Mid-Scene Freeze & Vocal Interjection)
    // -------------------------------------------------------------------------
    emitCommentaryProgress(91, 'Rendering Segment B Replay & Mid-Scene Commentary...');
    const origWords = (opts.originalTranscriptWords && opts.originalTranscriptWords.length > 0)
      ? opts.originalTranscriptWords
      : (parsedOpts.words || []);
    const rawSegBWords = origWords.length > 0 ? origWords : (opts.reactionWords || []);

    const inputSource = (sourceFile && fs.existsSync(sourceFile)) ? sourceFile : sourceVideoPath;
    const processStartMs = inputSource === sourceFile ? startMs : 0;
    // Add 500ms buffer so Segment B audio/video doesn't get cut by xfade transition
    const processEndMs = (inputSource === sourceFile ? endMs : (endMs - startMs)) + 500;
    const segBDurMs = processEndMs - processStartMs;

    let normalizedWords: TranscriptWord[] = [];
    if (rawSegBWords.length > 0) {
      const usingReactionFallback = origWords.length === 0;
      if (inputSource === sourceFile) {
        normalizedWords = usingReactionFallback
          ? rawSegBWords.map((w: TranscriptWord) => ({ ...w, startMs: w.startMs + startMs, endMs: w.endMs + startMs }))
          : rawSegBWords;
      } else {
        normalizedWords = usingReactionFallback
          ? rawSegBWords
          : rawSegBWords.map((w: TranscriptWord) => ({ ...w, startMs: Math.max(0, w.startMs - startMs), endMs: Math.max(0, w.endMs - startMs) }));
      }
    }

    // Plan B-roll cutaways if enabled
    const effectiveBroll: BrollConfig | undefined = opts.brollConfig || (parsedOpts.brollConfig as BrollConfig | undefined);
    let brollPlan: import('./BrollManager').BrollPlan = { cuts: [], uniqueVideos: [] };
    if (effectiveBroll && effectiveBroll.enabled) {
      try {
        if (effectiveBroll.category === 'contextual') {
          emitCommentaryProgress(92, 'AI Contextual B-Roll: scanning keywords and fetching matching footage...');
          brollPlan = await BrollManager.getInstance().planContextualBroll(
            normalizedWords,
            segBDurMs,
            effectiveBroll,
            {
              pexelsApiKey: opts.pexelsApiKey,
              pixabayApiKey: opts.pixabayApiKey,
            }
          );
        } else {
          brollPlan = await BrollManager.getInstance().planBrollAsync(
            segBDurMs,
            effectiveBroll,
            {
              pexelsApiKey: opts.pexelsApiKey,
              pixabayApiKey: opts.pixabayApiKey,
            }
          );
        }
      } catch (brollErr) {
        log.warn({ brollErr }, 'Failed to plan B-roll cutaways for Segment B');
      }
    }
    const hasBroll = brollPlan.cuts.length > 0;

    const reactionTts = opts.reactionTtsPath;
    const hasReaction = reactionTts && fs.existsSync(reactionTts);
    const shouldSplitB = opts.commentaryMode === 'hook_replay_outro' && hasReaction && segBDurMs >= 14000;

    const applyBrollCuts = async (inPath: string, cuts: import('./BrollManager').BrollCut[], uniqueVideos: string[], outPath: string): Promise<void> => {
      if (cuts.length === 0 || uniqueVideos.length === 0) {
        fs.copyFileSync(inPath, outPath);
        return;
      }
      const argsBroll = ['-y', '-i', inPath];
      const videoMap = new Map<string, number>();
      let inIdx = 1;
      for (const uv of uniqueVideos) {
        if (fs.existsSync(uv)) {
          argsBroll.push('-i', uv);
          videoMap.set(uv, inIdx++);
        }
      }
      const isLetterbox = !!parsedOpts.letterboxBg || parsedOpts.layoutPreset === 'letterbox';
      const cropRatio = parsedOpts.letterboxBg?.crop || '1:1';
      const brollRes = BrollManager.getInstance().buildFfmpegFilter('0:v', cuts, videoMap, 1080, 1920, { isLetterbox, crop: cropRatio });
      if (brollRes.filterString) {
        argsBroll.push(
          '-filter_complex', brollRes.filterString,
          '-map', `[${brollRes.outputLabel}]`,
          '-map', '0:a',
          '-c:v', 'libx264', '-crf', '17', '-preset', 'slow',
          '-pix_fmt', 'yuv420p', '-r', '30',
          '-c:a', 'copy',
          outPath
        );
        await runProcess('ffmpeg', argsBroll);
      } else {
        fs.copyFileSync(inPath, outPath);
      }
    };

    const burnSubtitlesOnVideo = async (inVideoPath: string, wordsList: TranscriptWord[], clipStartMs: number, clipEndMs: number, outVideoPath: string): Promise<void> => {
      const assData = await buildAssSubtitles(wordsList, clipStartMs, clipEndMs, resolvedCaption, inVideoPath);
      let finalAssB = assData;
      let channelTitleOverlay = (opts as any).titleOverlay;
      if (!channelTitleOverlay && optionsJson) {
        try {
          const parsed = JSON.parse(optionsJson);
          if (parsed?.titleOverlay) channelTitleOverlay = parsed.titleOverlay;
        } catch {}
      }
      if (channelTitleOverlay) {
        const titleResult = buildTitleEvents(channelTitleOverlay, clipEndMs - clipStartMs);
        if (titleResult) {
          finalAssB = finalAssB.replace(/\r?\n\r?\n\[Events\]/, `\n${titleResult.styleLine}\n\n[Events]`);
          finalAssB += titleResult.dialogueLine + '\n';
        }
      }
      const tmpAssPath = path.join(tmpDir, `commentary_sub_${Date.now()}_${Math.random().toString(36).substring(2, 6)}.ass`);
      fs.writeFileSync(tmpAssPath, finalAssB, 'utf-8');
      const isWin = process.platform === 'win32';
      const escapedPath = isWin
        ? tmpAssPath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:')
        : tmpAssPath;
      const subsFilter = escapedFontsDir
        ? `subtitles='${escapedPath}':fontsdir='${escapedFontsDir}'`
        : `subtitles='${escapedPath}'`;
      await runProcess('ffmpeg', [
        '-y',
        '-i', inVideoPath,
        '-filter_complex', `[0:v]${subsFilter},format=yuv420p[vout]`,
        '-map', '[vout]',
        '-map', '0:a',
        '-c:v', 'libx264', '-crf', '17', '-preset', 'slow',
        '-pix_fmt', 'yuv420p', '-r', '30',
        '-c:a', 'copy',
        outVideoPath,
      ]);
      try { fs.unlinkSync(tmpAssPath); } catch {}
    };

    if (shouldSplitB) {
      // -----------------------------------------------------------------------
      // 2A. ACTIVE MID-SCENE VOCAL INTERJECTION & FREEZE-FRAME SPLIT (B1 + Jeda + B2)
      // -----------------------------------------------------------------------
      emitCommentaryProgress(92, 'Creating Mid-Scene Freeze-Frame & Vocal Commentary Interruption...');
      let interruptionMs = opts.interruptionTimestampSec
        ? Math.round(opts.interruptionTimestampSec * 1000)
        : Math.round(segBDurMs * 0.60);
      interruptionMs = Math.max(5000, Math.min(segBDurMs - 4000, interruptionMs));

      const splitPointMs = processStartMs + interruptionMs;

      // 1. Render Segment B1 (0 to interruptionMs): Clean video without subtitle burn-in
      const segB1CleanPath = path.join(tmpDir, `segB1_clean_${Date.now()}.mp4`);
      const wordsB1 = normalizedWords.filter(w => w.startMs < splitPointMs);
      await this.process({
        clipId: opts.clipId || 'hook_replay_b1',
        projectId: 'replay_b1',
        sourceFile: inputSource,
        startMs: processStartMs,
        endMs: splitPointMs,
        outputPath: segB1CleanPath,
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

      // Extract freeze frame image from CLEAN B1 (zero burned-in subtitles)
      const freezeImgPath = path.join(tmpDir, `freeze_frame_${Date.now()}.jpg`);
      let frameExtracted = false;
      try {
        await runProcess('ffmpeg', [
          '-y',
          '-sseof', '-0.3',
          '-i', segB1CleanPath,
          '-vframes', '1',
          '-q:v', '2',
          freezeImgPath,
        ]);
        if (fs.existsSync(freezeImgPath) && fs.statSync(freezeImgPath).size > 100) {
          frameExtracted = true;
        }
      } catch {}

      if (!frameExtracted) {
        try {
          await runProcess('ffmpeg', [
            '-y',
            '-i', segB1CleanPath,
            '-vframes', '1',
            '-q:v', '2',
            freezeImgPath,
          ]);
          if (fs.existsSync(freezeImgPath) && fs.statSync(freezeImgPath).size > 100) {
            frameExtracted = true;
          }
        } catch {}
      }

      if (!frameExtracted) {
        try {
          await runProcess('ffmpeg', [
            '-y',
            '-ss', String(processStartMs / 1000),
            '-i', inputSource,
            '-vframes', '1',
            '-q:v', '2',
            freezeImgPath,
          ]);
        } catch {}
      }

      // Apply B-roll cuts on clean B1 (Punchline protection: leave 3.5s before interruption)
      const segB1BrollPath = path.join(tmpDir, `segB1_broll_${Date.now()}.mp4`);
      const cutsB1 = hasBroll ? brollPlan.cuts.filter(c => c.startMs >= 3500 && c.endMs <= interruptionMs - 3500) : [];
      if (cutsB1.length > 0) {
        await applyBrollCuts(segB1CleanPath, cutsB1, brollPlan.uniqueVideos, segB1BrollPath);
        try { fs.unlinkSync(segB1CleanPath); } catch {}
      } else {
        fs.copyFileSync(segB1CleanPath, segB1BrollPath);
        try { fs.unlinkSync(segB1CleanPath); } catch {}
      }

      // Burn conversation subtitles ON TOP of B-roll (Subtitles are never covered!)
      const segB1Path = path.join(tmpDir, `segB1_${Date.now()}.mp4`);
      await burnSubtitlesOnVideo(segB1BrollPath, wordsB1, processStartMs, splitPointMs, segB1Path);
      try { fs.unlinkSync(segB1BrollPath); } catch {}

      // 2. Render Segment Jeda (Freeze Frame + 1.15x AI Voiceover + BGM + Reaction Subtitles)
      let reactionAudioDurMs = 2800;
      try {
        reactionAudioDurMs = (await this.getVideoDurationMs(reactionTts!)) / 1.15;
      } catch {}
      const freezeDurSec = Math.max(1.8, (Math.ceil(reactionAudioDurMs) + 300) / 1000);
      const freezeDurMs = Math.round(freezeDurSec * 1000);

      // Build Subtitles for Segment Jeda scaled by 1.15x
      const rawReactionWords: TranscriptWord[] = (opts.reactionWords && opts.reactionWords.length > 0)
        ? opts.reactionWords
        : [{ word: 'Wait, look at this!', startMs: 100, endMs: freezeDurMs - 100, confidence: 1 }];
      const scaledReactionWords = rawReactionWords.map(w => ({
        ...w,
        startMs: Math.round(w.startMs / 1.15),
        endMs: Math.round(w.endMs / 1.15),
      }));

      const assContentJeda = await buildAssSubtitles(
        scaledReactionWords,
        0,
        freezeDurMs,
        resolvedCaption,
        freezeImgPath
      );
      const tmpAssPathJeda = path.join(tmpDir, `commentary_subJeda_${Date.now()}.ass`);
      fs.writeFileSync(tmpAssPathJeda, assContentJeda, 'utf-8');
      const isWin = process.platform === 'win32';
      const escapedAssJeda = isWin
        ? tmpAssPathJeda.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:')
        : tmpAssPathJeda;
      const subsFilterJeda = escapedFontsDir
        ? `subtitles='${escapedAssJeda}':fontsdir='${escapedFontsDir}'`
        : `subtitles='${escapedAssJeda}'`;

      const segBJedaPath = path.join(tmpDir, `segB_jeda_${Date.now()}.mp4`);
      const argsJeda: string[] = [
        '-y',
        '-loop', '1',
        '-framerate', '30',
        '-t', String(freezeDurSec),
        '-i', freezeImgPath,
        '-i', reactionTts!,
      ];
      let jedaFilter = '';

      if (hasBgm) {
        argsJeda.push('-i', bgMusicPath!);
        const bgmVol = opts.bgMusicVolume ?? 0.20;
        const fadeOutSec = Math.max(0, freezeDurSec - 0.25);
        jedaFilter = `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,scale=1242:2208,crop=1080:1920,setsar=1,fps=30,${subsFilterJeda},format=yuv420p[vout];[1:a]atempo=1.15,volume=1.4,apad,aformat=sample_rates=48000:channel_layouts=stereo[tts];[2:a]volume=${bgmVol},afade=t=in:st=0:d=0.2,afade=t=out:st=${fadeOutSec}:d=0.25,aformat=sample_rates=48000:channel_layouts=stereo[bgm];[tts][bgm]amix=inputs=2:duration=first:dropout_transition=0:weights=1 1:normalize=0[aout]`;
      } else {
        jedaFilter = `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,scale=1242:2208,crop=1080:1920,setsar=1,fps=30,${subsFilterJeda},format=yuv420p[vout];[1:a]atempo=1.15,volume=1.4,apad,aformat=sample_rates=48000:channel_layouts=stereo[aout]`;
      }

      argsJeda.push(
        '-filter_complex', jedaFilter,
        '-map', '[vout]',
        '-map', '[aout]',
        '-t', String(freezeDurSec),
        '-c:v', 'libx264', '-crf', '17', '-preset', 'slow',
        '-pix_fmt', 'yuv420p', '-r', '30',
        '-c:a', 'aac', '-b:a', '320k', '-ar', '48000', '-ac', '2',
        segBJedaPath
      );
      await runProcess('ffmpeg', argsJeda);
      try { fs.unlinkSync(tmpAssPathJeda); } catch {}
      try { fs.unlinkSync(freezeImgPath); } catch {}

      // 3. Render Segment B2 (interruptionMs to end): Clean video without subtitle burn-in
      const segB2CleanPath = path.join(tmpDir, `segB2_clean_${Date.now()}.mp4`);
      const wordsB2 = normalizedWords.filter(w => w.startMs >= splitPointMs);
      await this.process({
        clipId: opts.clipId || 'hook_replay_b2',
        projectId: 'replay_b2',
        sourceFile: inputSource,
        startMs: splitPointMs,
        endMs: processEndMs,
        outputPath: segB2CleanPath,
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

      // Apply B-roll cuts on clean B2 (Punchline protection: exclude cuts in first 2.5s and last 3.5s)
      const segB2BrollPath = path.join(tmpDir, `segB2_broll_${Date.now()}.mp4`);
      const cutsB2 = hasBroll ? brollPlan.cuts.filter(c => c.startMs >= interruptionMs + 2500 && c.endMs <= segBDurMs - 3500).map(c => ({
        ...c,
        startMs: Math.max(0, c.startMs - interruptionMs),
        endMs: Math.max(0, c.endMs - interruptionMs),
      })) : [];
      if (cutsB2.length > 0) {
        await applyBrollCuts(segB2CleanPath, cutsB2, brollPlan.uniqueVideos, segB2BrollPath);
        try { fs.unlinkSync(segB2CleanPath); } catch {}
      } else {
        fs.copyFileSync(segB2CleanPath, segB2BrollPath);
        try { fs.unlinkSync(segB2CleanPath); } catch {}
      }

      // Burn conversation subtitles ON TOP of B-roll
      const segB2Path = path.join(tmpDir, `segB2_${Date.now()}.mp4`);
      await burnSubtitlesOnVideo(segB2BrollPath, wordsB2, splitPointMs, processEndMs, segB2Path);
      try { fs.unlinkSync(segB2BrollPath); } catch {}

      // 4. Concatenate B1 + Jeda + B2 into segBPath with explicit format and framerate alignment
      emitCommentaryProgress(94, 'Joining Replay Part 1, Vocal Interruption & Part 2...');
      await runProcess('ffmpeg', [
        '-y',
        '-i', segB1Path,
        '-i', segBJedaPath,
        '-i', segB2Path,
        '-filter_complex', '[0:v]fps=30,setsar=1,format=yuv420p[v0];[0:a]aformat=sample_rates=48000:channel_layouts=stereo[a0];[1:v]fps=30,setsar=1,format=yuv420p[v1];[1:a]aformat=sample_rates=48000:channel_layouts=stereo[a1];[2:v]fps=30,setsar=1,format=yuv420p[v2];[2:a]aformat=sample_rates=48000:channel_layouts=stereo[a2];[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[vcat][acat]',
        '-map', '[vcat]',
        '-map', '[acat]',
        '-c:v', 'libx264', '-crf', '17', '-preset', 'slow',
        '-pix_fmt', 'yuv420p', '-r', '30',
        '-c:a', 'aac', '-b:a', '320k', '-ar', '48000', '-ac', '2',
        segBPath,
      ]);

      try { fs.unlinkSync(segB1Path); } catch {}
      try { fs.unlinkSync(segBJedaPath); } catch {}
      try { fs.unlinkSync(segB2Path); } catch {}
      log.info('Segment B (B1 + Jeda + B2) successfully rendered and joined');
    } else {
      // Single continuous Segment B
      const segBCleanPath = path.join(tmpDir, `hook_segB_clean_${Date.now()}.mp4`);
      await this.process({
        clipId: opts.clipId || 'hook_replay',
        projectId: 'replay',
        sourceFile: inputSource,
        startMs: processStartMs,
        endMs: processEndMs,
        outputPath: segBCleanPath,
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
        titleOverlay: parsedOpts.titleOverlay,
        words: [],
        captionStyle: { ...CAPTION_PRESETS['none'], presetId: 'none' },
      });

      const segBBrollPath = path.join(tmpDir, `hook_segB_broll_${Date.now()}.mp4`);
      if (hasBroll) {
        await applyBrollCuts(segBCleanPath, brollPlan.cuts, brollPlan.uniqueVideos, segBBrollPath);
        try { fs.unlinkSync(segBCleanPath); } catch {}
      } else {
        fs.copyFileSync(segBCleanPath, segBBrollPath);
        try { fs.unlinkSync(segBCleanPath); } catch {}
      }

      // Burn subtitles ON TOP of B-roll
      await burnSubtitlesOnVideo(segBBrollPath, normalizedWords, processStartMs, processEndMs, segBPath);
      try { fs.unlinkSync(segBBrollPath); } catch {}
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
      emitCommentaryProgress(95, 'Rendering Segment C trivia takeaway outro...');
      log.info('Rendering Segment C Trivia Takeaway Outro (Replaying Raw Source Video Clip)');
      let takeawayAudioDurationMs = 3500;
      try {
        takeawayAudioDurationMs = (await this.getVideoDurationMs(takeawayTts!)) / 1.15;
      } catch {}
      // Clamp Outro to max 4.5s for tight retention
      const takeawayDurMs = Math.min(4500, Math.max(2500, Math.ceil(takeawayAudioDurationMs) + 300));

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
        titleOverlay: parsedOpts.titleOverlay,
        words: [],
        captionStyle: { ...CAPTION_PRESETS['none'], presetId: 'none' },
      });

      const outroInputPath = fs.existsSync(tmpCleanOutroPath) ? tmpCleanOutroPath : sourceVideoPath;
      const rawOutroWords: TranscriptWord[] = opts.takeawayWords || opts.reactionWords || [];
      const scaledOutroWords: TranscriptWord[] = rawOutroWords.map(w => ({
        ...w,
        startMs: Math.round(w.startMs / 1.15),
        endMs: Math.round(w.endMs / 1.15),
      }));

      const assContentC = await buildAssSubtitles(scaledOutroWords, 0, 999999, resolvedCaption, outroInputPath);
      tmpAssPathC = path.join(tmpDir, `commentary_subC_${Date.now()}.ass`);
      fs.writeFileSync(tmpAssPathC, assContentC, 'utf-8');

      const isWin = process.platform === 'win32';
      const escapedAssC = isWin
        ? tmpAssPathC.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:')
        : tmpAssPathC;
      const subtitlesFilterC = escapedFontsDir
        ? `subtitles='${escapedAssC}':fontsdir='${escapedFontsDir}'`
        : `subtitles='${escapedAssC}'`;

      let filterComplexC = `[0:v]${subtitlesFilterC}[vout];[1:a]atempo=1.15,volume=1.35,apad,aformat=sample_rates=48000:channel_layouts=stereo[aout]`;
      const argsC: string[] = ['-y', '-i', outroInputPath, '-i', takeawayTts!];

      if (hasBgm) {
        argsC.push('-i', bgMusicPath!);
        filterComplexC = `[0:v]${subtitlesFilterC}[vout];[1:a]atempo=1.15,volume=1.35,apad,aformat=sample_rates=48000:channel_layouts=stereo[tts];[2:a]volume=${bgMusicVolume},afade=t=in:st=0:d=0.25,aformat=sample_rates=48000:channel_layouts=stereo[bgm];[tts][bgm]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`;
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
          filterParts.push(`[0:v]format=yuv420p[v0]`);
          filterParts.push(`[1:v]format=yuv420p[v1]`);
          filterParts.push(`[2:v]format=yuv420p[v2]`);
          filterParts.push(`[v0][v1]xfade=transition=${transitionEffect}:duration=${tDur}:offset=${offset1}[v01]`);
          filterParts.push(`[v01][v2]xfade=transition=${transitionEffect}:duration=${tDur}:offset=${offset2},format=yuv420p[vout]`);

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
          '-pix_fmt', 'yuv420p',
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
          filterParts.push(`[0:v]format=yuv420p[v0]`);
          filterParts.push(`[1:v]format=yuv420p[v1]`);
          filterParts.push(`[v0][v1]xfade=transition=${transitionEffect}:duration=${tDur2}:offset=${offset1},format=yuv420p[vout]`);

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
          '-pix_fmt', 'yuv420p',
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
      try { if (hasSegC) fs.unlinkSync(segCPath); } catch {}
      try { if (hasSegC && tmpAssPathC) fs.unlinkSync(tmpAssPathC); } catch {}
      try { if (useSeg0) fs.unlinkSync(seg0Path); } catch {}
    }
  }
}


