/**
 * Processor — FFmpeg-based clip cutter with subtitle overlay and auto-zoom.
 *
 * Takes a source video, a time range (startMs/endMs), subtitle words, and
 * rendering options, then produces a 9:16 vertical short-form clip.
 */

import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { BrowserWindow } from 'electron';
import { CHANNELS } from '../ipc/channels';
import { createLogger } from '../utils/logger';
import { Tracker } from './Tracker';
import type { TranscriptWord, SubtitleStyle, SubtitlePosition, CropFrame, CaptionStyle, LogoOverlay, LayoutPreset, SplitLayout, GameRatio, GamePosition } from '../../shared/types';
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
  /** Layout preset: 'normal' (default), 'split' (multi-speaker), 'game' (gameplay+facecam) */
  layoutPreset?:    LayoutPreset;
  /** Split layout direction (only used when layoutPreset === 'split') */
  splitLayout?:     SplitLayout;
  /** Game layout ratio — gameplay:facecam height (only used when layoutPreset === 'game') */
  gameRatio?:       GameRatio;
  /** Game layout position — gameplay overlay at top or bottom (only used when layoutPreset === 'game') */
  gamePosition?:    GamePosition;
  /** Custom thumbnail image path — prepended as 1-second still frame at start of clip */
  thumbnailPath?:   string;
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
      if (code !== 0) reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-800)}`));
      else resolve();
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
 * Opus-style subject tracking:
 * - Per-frame crop positions from detect_faces.py (dense sampling + EMA smoothed)
 * - FFmpeg `crop` filter with `if()`/`between()` expressions for per-segment positions
 * - Smooth transitions between positions using lerp via `between()` time windows
 * - Falls back to center crop when no face data
 *
 * Source assumed 1920×1080 landscape → output 1080×1920 (9:16).
 * Scale to height=1920 first, then crop 1080 wide.
 */
function buildCropFilter(cropFrames: CropFrame[], startMs: number, _endMs: number, srcWidth = 1920, srcHeight = 1080): string {
  // Guard: if the source is already vertical or too narrow to produce a 1080×1920 crop,
  // scale to fit 1080 width instead and pad/crop height to 1920.
  const srcAspect = srcWidth / srcHeight;
  if (srcAspect <= 1.0) {
    // Source is vertical or square — scale width to 1080, pad height to 1920
    return 'scale=1080:-2,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black';
  }

  // Ensure that scaling to 1920 height produces a frame at least 1080 wide
  const scaledWidthCheck = Math.round(srcWidth * (1920 / srcHeight));
  if (scaledWidthCheck < 1080) {
    // Source too narrow after scaling to 1920 height — scale to 1080 width instead
    return 'scale=1080:-2,crop=1080:min(ih\\,1920):0:(ih-min(ih\\,1920))/2,pad=1080:1920:0:(oh-ih)/2:black';
  }

  if (cropFrames.length === 0) {
    return 'scale=-2:1920,crop=1080:1920';
  }

  // All frames where a face/subject was actually detected (hasFace=true)
  const detectedFrames = cropFrames.filter((f) => f.hasFace);

  // Multi-face span: only frames with faceSpanW > 0 (2+ faces grouped)
  const multiFrames = detectedFrames.filter((f) => (f.faceSpanW ?? 0) > 0);
  let targetScaleH = 1920;

  if (multiFrames.length > 0) {
    const spans = multiFrames.map((f) => f.faceSpanW ?? 0).sort((a, b) => a - b);
    const medianSpan = spans[Math.floor(spans.length / 2)];
    const requiredCropW = Math.round(medianSpan * 1.3);
    if (requiredCropW > 1080) {
      const ratio = 1080 / requiredCropW;
      // targetScaleH MUST be >= 1920 so crop=1080:1920 is always valid
      targetScaleH = Math.max(1920, Math.round(ratio * 1920));
    }
  }

  // Ensure even number for libx264 compatibility
  targetScaleH = targetScaleH % 2 === 0 ? targetScaleH : targetScaleH + 1;

  const scaleFactor = targetScaleH / srcHeight;
  const scaledWidth = Math.round(srcWidth * scaleFactor);
  // Ensure even scaled width, minimum 1080 for 9:16 crop
  const evenScaledWidth = Math.max(1080, scaledWidth % 2 === 0 ? scaledWidth : scaledWidth + 1);

  // Use detected frames for crop positions. Fall back to all frames only if nothing detected.
  // cropFrames always carries a subject-region estimate (avg/rule-of-thirds)
  // from the Tracker, so using them keeps off-center subjects in frame instead
  // of collapsing to a hard center crop.
  const useFrames = detectedFrames.length > 0 ? detectedFrames : cropFrames;

  // Safety net: if for any reason useFrames is empty, build a single keyframe
  // anchored on the average subject X rather than emitting a center crop.
  if (useFrames.length === 0) {
    const scaleH = 1920;
    const sf = scaleH / srcHeight;
    const sw = Math.max(1080, Math.round(srcWidth * sf) % 2 === 0 ? Math.round(srcWidth * sf) : Math.round(srcWidth * sf) + 1);
    const avgCx = cropFrames.length > 0
      ? Math.round(cropFrames.reduce((s, f) => s + f.cx, 0) / cropFrames.length * sf)
      : Math.round(sw / 2);
    const cropX = Math.max(0, Math.min(sw - 1080, avgCx - 540));
    return `scale=${sw}:${scaleH},crop=1080:1920:${cropX}:0`;
  }

  if (useFrames.length === 1) {
    const scaledCx = Math.round(useFrames[0].cx * scaleFactor);
    const scaledFaceW = (useFrames[0].faceSpanW ?? 0) * scaleFactor;
    const faceLeftScaled = scaledCx - scaledFaceW / 2;
    const faceRightScaled = scaledCx + scaledFaceW / 2;
    const margin = Math.min(150, (1080 - scaledFaceW) / 4);
    const cropXMin = Math.max(0, faceRightScaled + margin - 1080);
    const cropXMax = Math.min(evenScaledWidth - 1080, faceLeftScaled - margin);
    const cropX = cropXMin <= cropXMax
      ? Math.round((cropXMin + cropXMax) / 2)
      : Math.max(0, Math.min(evenScaledWidth - 1080, scaledCx - 540));
    return `scale=${evenScaledWidth}:${targetScaleH},crop=1080:1920:${cropX}:0`;
  }

  const clipStartSec = startMs / 1000;

  const keyframes = useFrames.map((f) => {
    const tSec = f.timestampMs / 1000 - clipStartSec;
    const scaledCx = Math.round(f.cx * scaleFactor);
    // Ensure entire face stays inside the 1080px crop window.
    // faceSpanW = face width in original pixels. After scaling, face becomes faceSpanW * scaleFactor.
    // Add padding (1.5x face width) so face has breathing room.
    const scaledFaceW = (f.faceSpanW ?? 0) * scaleFactor;
    const padding = Math.max(200, scaledFaceW * 0.75); // minimum 200px padding from edge
    const minCropX = Math.max(0, scaledCx - 540 + padding - (1080 - padding * 2) / 2);
    const maxCropX = Math.min(evenScaledWidth - 1080, scaledCx - 540);
    // Clamp: face center minus half crop width, but ensure face left/right edge has margin
    const faceLeftScaled = scaledCx - scaledFaceW / 2;
    const faceRightScaled = scaledCx + scaledFaceW / 2;
    // Crop must satisfy: cropX <= faceLeftScaled - margin AND cropX + 1080 >= faceRightScaled + margin
    const margin = Math.min(150, (1080 - scaledFaceW) / 4); // adaptive margin
    const cropXMin = Math.max(0, faceRightScaled + margin - 1080); // minimum X so right edge is inside
    const cropXMax = Math.min(evenScaledWidth - 1080, faceLeftScaled - margin); // max X so left edge is inside
    let cropX: number;
    if (cropXMin <= cropXMax) {
      // Face fits with margin — center it
      cropX = Math.round((cropXMin + cropXMax) / 2);
    } else {
      // Face too wide for margin — just center on face
      cropX = Math.max(0, Math.min(evenScaledWidth - 1080, scaledCx - 540));
    }
    void minCropX; void maxCropX; // suppress unused
    return { t: Math.max(0, tSec), x: cropX };
  });

  keyframes.sort((a, b) => a.t - b.t);

  // ── Ensure crop starts at t=0 with the first known face position ──
  // Without this, frames before the first keyframe get default (center) crop
  if (keyframes.length > 0 && keyframes[0].t > 0.05) {
    keyframes.unshift({ t: 0, x: keyframes[0].x });
  }

  // ── Limit keyframe count to prevent FFmpeg expression nesting overflow ──
  // FFmpeg 8.x has an internal limit on expression evaluation depth.
  // Each keyframe adds one level of if() nesting. Cap at 30 keyframes
  // by downsampling evenly — smooth tracking is preserved since
  // 30 keyframes over a typical 30-90s clip = ~1 per second.
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

  let cropXExpr: string;

  if (keyframes.length <= 1) {
    cropXExpr = String(keyframes[0]?.x ?? 0);
  } else {
    let expr = String(keyframes[keyframes.length - 1].x);

    for (let i = keyframes.length - 2; i >= 0; i--) {
      const k0 = keyframes[i];
      const k1 = keyframes[i + 1];
      const dt = k1.t - k0.t;

      let segExpr: string;
      if (dt < 0.001 || k0.x === k1.x) {
        segExpr = String(k0.x);
      } else {
        const dx = k1.x - k0.x;
        if (dx === 0) {
          segExpr = String(k0.x);
        } else {
          segExpr = `${k0.x}+${dx}*(min(max(t\\,${k0.t.toFixed(3)})\\,${k1.t.toFixed(3)})-${k0.t.toFixed(3)})/${dt.toFixed(3)}`;
        }
      }

      expr = `if(lt(t\\,${k1.t.toFixed(3)})\\,${segExpr}\\,${expr})`;
    }

    cropXExpr = expr;
  }

  const maxX = evenScaledWidth - 1080;
  const clampedExpr = `min(max(${cropXExpr}\\,0)\\,${maxX})`;

  return `scale=${evenScaledWidth}:${targetScaleH},crop=1080:1920:${clampedExpr}:0`;
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
    `[1:v]scale=${logoW}:-1,` +
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
function buildSplitFilterComplex(
  splitLayout: import('../../shared/types').SplitLayout,
  cropFrames: CropFrame[],
  assPath: string,
  srcWidth: number,
  srcHeight: number,
  logo?: LogoOverlay,
  speakerPositions?: Array<{ cx: number; cy: number }>,
): string {
  // Escape ASS path for FFmpeg
  const assEsc = assPath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:');

  // Helper: append logo overlay on top of [sub] → [vout] if logo provided
  // Logo input is [1:v] (second -i in ffmpegArgs)
  const withLogo = (graph: string): string => {
    if (!logo) return graph.replace('[sub]', '[vout]');
    const logoW  = Math.round(1080 * logo.scale);
    const margin = logo.margin;
    let lx: string, ly: string;
    switch (logo.position) {
      case 'top-left':     lx = `${margin}`;     ly = `${margin}`;     break;
      case 'top-right':    lx = `W-w-${margin}`; ly = `${margin}`;     break;
      case 'bottom-left':  lx = `${margin}`;     ly = `H-h-${margin}`; break;
      case 'bottom-right': lx = `W-w-${margin}`; ly = `H-h-${margin}`; break;
      case 'center':       lx = `(W-w)/2`;       ly = `(H-h)/2`;       break;
      default:             lx = `W-w-${margin}`; ly = `${margin}`;
    }
    return (
      graph +
      `;[1:v]scale=${logoW}:-1,colorchannelmixer=aa=${logo.opacity.toFixed(3)}[logo];` +
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
      `[stacked]subtitles='${assEsc}'[sub]`
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
      `[stacked]subtitles='${assEsc}'[sub]`
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
    `[stacked]subtitles='${assEsc}'[sub]`
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
  // Escape ASS path for FFmpeg
  const assEsc = assPath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:');

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
      `[stacked]subtitles='${assEsc}'[sub]`
    )
    : (
      // Streamer on top, gameplay on bottom
      `[0:v]split=2[src1][src2];` +
      `[src1]crop=${bgCropW}:${bgCropH}:${bgCropX}:${bgCropY},scale=1080:${streamerH}[bg];` +
      `[src2]crop=${pipSrcW}:${pipSrcH}:${pipSrcX}:${pipSrcY},scale=${pipW}:${pipH}[pip];` +
      `[bg][pip]vstack=inputs=2[stacked];` +
      `[stacked]subtitles='${assEsc}'[sub]`
    );

  if (!logo) {
    return baseGraph.replace('[sub]', '[vout]');
  }

  // Logo overlay — [1:v] is the logo input (second -i in ffmpegArgs)
  const logoW = Math.round(1080 * logo.scale);
  const margin = logo.margin;
  let lx: string;
  let ly: string;
  switch (logo.position) {
    case 'top-left':     lx = `${margin}`;      ly = `${margin}`;      break;
    case 'top-right':    lx = `W-w-${margin}`;  ly = `${margin}`;      break;
    case 'bottom-left':  lx = `${margin}`;      ly = `H-h-${margin}`;  break;
    case 'bottom-right': lx = `W-w-${margin}`;  ly = `H-h-${margin}`;  break;
    case 'center':       lx = `(W-w)/2`;        ly = `(H-h)/2`;        break;
    default:             lx = `W-w-${margin}`;  ly = `${margin}`;
  }

  return (
    baseGraph + `;` +
    `[1:v]scale=${logoW}:-1,colorchannelmixer=aa=${logo.opacity.toFixed(3)}[logo];` +
    `[sub][logo]overlay=${lx}:${ly}[vout]`
  );
}

// ---------------------------------------------------------------------------
// Legacy style converter
// ---------------------------------------------------------------------------

/** Convert old SubtitleStyle + SubtitlePosition to a CaptionStyle */
function legacyToCaptionStyle(style: SubtitleStyle, position: SubtitlePosition): CaptionStyle {
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

  // Batch: one FFmpeg call per word would be too slow.
  // Instead run a single pass over the full clip and sample RMS per word
  // using the `astats=metadata=1:reset=1` filter with `-af` select.
  // We use a simpler approach: for each word, run a quick FFmpeg probe
  // extracting mean_volume from `volumedetect`.  We limit to words longer
  // than 100 ms to avoid micro-words inflating results.

  const candidates = clipWords
    .map((w, i) => ({ i, startMs: w.startMs, endMs: w.endMs }))
    .filter(({ startMs, endMs }) => endMs - startMs >= 100);

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

        if (rmsDb >= thresholdDb) {
          loudIndices.add(i);
        }
      } catch {
        // Non-fatal — just skip this word
      }
    }));
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
  // Filter words within clip range, offset to clip-relative time
  const clipWords = words
    .filter((w) => w.startMs >= startMs && w.endMs <= endMs)
    .map((w) => ({ ...w, startMs: w.startMs - startMs, endMs: w.endMs - startMs }));

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

  const alignment = style.position === 'lower-third' ? 2
    : style.position === 'upper-third' ? 8
    : 5;
  const marginV = style.position === 'lower-third' ? 120
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
        const text = `${animPrefix}{\\an${alignment}}${lineText}`;

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
      // \an2/8/5 = alignment anchor matching style (so \pos works correctly)
      const anTag = `{\\an${alignment}}`;
      const text = `${anTag}${bouncyTag}${colorTag}${extraAnimTag}${wordText}`;
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

    const assPath = path.join(os.tmpdir(), `clip-${clipId}.ass`);
    // Pass sourceFile so loudness detection can mark loud words for shake effect
    const assContent = await buildAssSubtitles(words, startMs, endMs, resolvedCaption, sourceFile);
    fs.writeFileSync(assPath, assContent, 'utf-8');

    emitProgress(clipId, 25);

    try {
      const cropFilter = buildCropFilter(cropFrames, startMs, endMs, srcWidth, srcHeight);

      // On Windows, FFmpeg's ass/subtitles filter requires special path escaping:
      // backslashes → forward slashes, colons escaped as \:
      // We copy the ASS file to the same directory as the output to use a
      // simple relative-style path, avoiding drive letter colon issues.
      const assNearOutput = outputPath.replace(/\.mp4$/i, '.ass');
      fs.copyFileSync(assPath, assNearOutput);

      // Build escaped path for FFmpeg subtitles filter on Windows:
      // 1. Replace backslashes with forward slashes
      // 2. Escape colons (drive letter C: → C\:) 
      // 3. Escape single quotes inside path
      // 4. Also escape backslash-colon sequences properly
      const assForFfmpeg = assNearOutput
        .replace(/\\/g, '/')
        .replace(/:/g, '\\:');

      log.info({ clipId, assNearOutput, assForFfmpeg }, 'ASS subtitle path');

      const layoutPreset = opts.layoutPreset ?? 'normal';
      const splitLayout  = opts.splitLayout  ?? 'top-bottom';

      let ffmpegArgs: string[];

      if (layoutPreset === 'split') {
        // ── Split layout: two speaker panels ─────────────────────────────
        log.info({ clipId, splitLayout }, 'Using split layout');
        const logo = opts.logoOverlay && fs.existsSync(opts.logoOverlay.filePath)
          ? opts.logoOverlay : undefined;
        const filterComplex = buildSplitFilterComplex(
          splitLayout, cropFrames, assNearOutput, srcWidth, srcHeight, logo,
          this._lastSpeakerPositions,
        );
        ffmpegArgs = [
          '-ss', String(startSec),
          '-t',  String(durationSec),
          '-i',  sourceFile,
          ...(logo ? ['-i', logo.filePath] : []),
          '-filter_complex', filterComplex,
          '-map', '[vout]',
          '-map', '0:a?',
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
        const filterComplex = buildGameFilterComplex(
          cropFrames, assNearOutput, srcWidth, srcHeight, gameRatio, gamePosition, logo
        );
        log.info({ clipId, filterComplex }, 'Game filter_complex');
        ffmpegArgs = [
          '-ss', String(startSec),
          '-t',  String(durationSec),
          '-i',  sourceFile,
          ...(logo ? ['-i', logo.filePath] : []),
          '-filter_complex', filterComplex,
          '-map', '[vout]',
          '-map', '0:a?',
          '-c:v', 'libx264', '-preset', 'slow', '-crf', '15',
          '-c:a', 'aac', '-b:a', '320k',
          '-movflags', '+faststart',
          outputPath,
        ];

      } else {
        // ── Normal layout: standard crop + optional logo ──────────────────
        const baseVf = `${cropFilter},subtitles='${assForFfmpeg}'`;

        if (opts.logoOverlay && fs.existsSync(opts.logoOverlay.filePath)) {
          const filterComplex = buildLogoFilterComplex(baseVf, opts.logoOverlay);
          ffmpegArgs = [
            '-ss', String(startSec),
            '-t',  String(durationSec),
            '-i',  sourceFile,
            '-i',  opts.logoOverlay.filePath,
            '-filter_complex', filterComplex,
            '-map', '[vout]',
            '-map', '0:a?',
            '-c:v', 'libx264', '-preset', 'slow', '-crf', '15',
            '-c:a', 'aac', '-b:a', '320k',
            '-movflags', '+faststart',
            outputPath,
          ];
        } else {
          ffmpegArgs = [
            '-ss', String(startSec),
            '-t',  String(durationSec),
            '-i',  sourceFile,
            '-vf', baseVf,
            '-c:v', 'libx264', '-preset', 'slow', '-crf', '15',
            '-c:a', 'aac', '-b:a', '320k',
            '-movflags', '+faststart',
            outputPath,
          ];
        }
      }

      log.info({ clipId, ffmpegCmd: ['ffmpeg', '-y', ...ffmpegArgs].join(' ') }, 'FFmpeg command');

      const { promise, proc } = runFfmpegWithProgress(clipId, ffmpegArgs, durationSec);

      // Register process for cancellation
      this.activeProcs.set(clipId, proc);

      try {
        await promise;
      } catch (err) {
        log.error({ clipId, err, ffmpegArgs: ffmpegArgs.join(' ') }, 'FFmpeg failed');

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
          log.info({ clipId, ffmpegCmd: ['ffmpeg', '-y', ...fallbackArgs].join(' ') }, 'FFmpeg fallback command (no subs)');
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

      emitProgress(clipId, 100);
      log.info({ clipId }, 'Clip processing complete');
    } finally {
      try { fs.unlinkSync(assPath); } catch { /* ignore */ }
      // Clean up the copy near output too
      const assNearOutput = outputPath.replace(/\.mp4$/i, '.ass');
      try { fs.unlinkSync(assNearOutput); } catch { /* ignore */ }
    }

    // ── Step 4: Prepend thumbnail image as 1-second still frame ──────────
    if (opts.thumbnailPath && fs.existsSync(opts.thumbnailPath)) {
      log.info({ clipId, thumbnailPath: opts.thumbnailPath }, 'Prepending thumbnail as 1s intro');
      try {
        await this._prependThumbnail(clipId, outputPath, opts.thumbnailPath);
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
  private async _prependThumbnail(
    clipId: string,
    clipOutputPath: string,
    thumbnailImagePath: string,
  ): Promise<void> {
    const tmpDir = os.tmpdir();
    const finalPath = path.join(tmpDir, `final-${clipId}.mp4`);

    try {
      // Use concat filter: input 0 = thumbnail image (looped 1s), input 1 = clip video
      // This re-encodes but guarantees correct timing regardless of fps mismatch
      await runProcess('ffmpeg', [
        '-y',
        // Input 0: thumbnail image looped for 1 second
        '-loop', '1',
        '-t', '1',
        '-i', thumbnailImagePath,
        // Input 1: the clip video
        '-i', clipOutputPath,
        // Filter: scale thumbnail to 1080x1920, concat video+audio streams
        '-filter_complex',
        '[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,fps=30,format=yuv420p,setsar=1[intro];' +
        '[1:v]fps=30,format=yuv420p,setsar=1[clip];' +
        'anullsrc=r=44100:cl=stereo[silence];' +
        '[silence]atrim=0:1[asilence];' +
        '[intro][asilence][clip][1:a]concat=n=2:v=1:a=1[vout][aout]',
        '-map', '[vout]',
        '-map', '[aout]',
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '15',
        '-c:a', 'aac', '-b:a', '320k',
        '-movflags', '+faststart',
        finalPath,
      ]);

      // Replace original output with concatenated result
      fs.copyFileSync(finalPath, clipOutputPath);

      log.info({ clipId, thumbnailImagePath }, 'Thumbnail prepended successfully');
    } finally {
      try { fs.unlinkSync(finalPath); } catch { /* ignore */ }
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
}
