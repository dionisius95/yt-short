/**
 * Tracker — Face tracking using MediaPipe Face Detector (via Python script).
 *
 * MediaPipe Face Detector is Google's ML-based face detection that is:
 * - Much more accurate than OpenCV Haar Cascade
 * - Works on tilted/profile faces
 * - Runs locally (no cloud needed)
 * - Falls back to OpenCV if MediaPipe not installed
 *
 * Output: CropFrame[] compatible with Processor.ts buildCropFilter().
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createLogger } from '../utils/logger';
import type { CropFrame } from '../../shared/types';

const log = createLogger('Tracker');

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

export class Tracker {
  /**
   * Detect faces in a video segment and return crop frames for auto-zoom.
   * Uses detect_faces.py which internally uses MediaPipe (primary) → OpenCV (fallback).
   */
  async detectFaces(
    sourceFile: string,
    startMs: number,
    endMs: number,
    _serviceAccountPath?: string,
    srcWidth = 1920,
    srcHeight = 1080,
  ): Promise<CropFrame[]> {
    // Attempt detection, retry once on failure (transient MediaPipe/IO errors).
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const frames = await this._detectWithScript(sourceFile, startMs, endMs);
        if (frames.length > 0) return frames;
        log.warn({ attempt }, 'Face detection returned no frames');
      } catch (err) {
        log.warn({ err, attempt }, 'Face detection attempt failed');
      }
    }
    // Never return empty: synthesize a rule-of-thirds crop so the Processor
    // keeps the subject region instead of collapsing to a hard center crop.
    log.warn('Face detection unavailable, using rule-of-thirds fallback frames');
    return this._fallbackFrames(startMs, endMs, srcWidth, srcHeight);
  }

  /**
   * Build synthetic crop frames anchored on the upper-third center of the
   * frame (where faces most commonly sit) so the output is never a dead
   * center crop when detection fails entirely.
   */
  private _fallbackFrames(
    startMs: number,
    endMs: number,
    srcWidth: number,
    srcHeight: number,
  ): CropFrame[] {
    const cx = Math.round(srcWidth / 2);
    const cy = Math.round(srcHeight / 3);
    const count = 2;
    const out: CropFrame[] = [];
    for (let i = 0; i < count; i++) {
      const timestampMs = startMs + ((endMs - startMs) * i) / Math.max(1, count - 1);
      out.push({ frameIndex: i, timestampMs, cx, cy, hasFace: false, faceSpanW: 0 });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Python script detection (MediaPipe primary → OpenCV fallback)
  // ---------------------------------------------------------------------------

  private async _detectWithScript(
    sourceFile: string,
    startMs: number,
    endMs: number,
  ): Promise<CropFrame[]> {
    const outputJson = path.join(os.tmpdir(), `tracker-${Date.now()}.json`);
    const python = this._findPython();

    const scriptCandidates = [
      path.join(process.resourcesPath ?? '', 'resources', 'detect_faces.py'),
      path.join(__dirname, '..', '..', '..', 'resources', 'detect_faces.py'),
      path.join(__dirname, '..', '..', 'resources', 'detect_faces.py'),
    ];
    const scriptPath = scriptCandidates.find((p) => fs.existsSync(p));
    if (!scriptPath) {
      log.warn('detect_faces.py not found');
      return [];
    }

    const durationSec = (endMs - startMs) / 1000;
    // 5 samples/sec, cap 90 — balance between accuracy and processing time (~45s for 90 frames)
    const samples = Math.min(90, Math.max(30, Math.ceil(durationSec * 5)));
    const args = [
      scriptPath,
      '--file', sourceFile,
      '--start', String(startMs / 1000),
      '--end', String(endMs / 1000),
      '--output', outputJson,
      '--samples', String(samples),
    ];

    log.info({ sourceFile, startMs, endMs, samples }, 'Running MediaPipe face detection');

    try {
      await this._runProcess(python, args);

      if (!fs.existsSync(outputJson)) return [];

      const data = JSON.parse(fs.readFileSync(outputJson, 'utf-8')) as {
        frames: Array<{ frameIndex: number; timestampMs: number; cx: number; cy: number; hasFace: boolean; faceSpanW?: number; isCut?: boolean }>;
        avgCx?: number;
        avgCy?: number;
      };

      try { fs.unlinkSync(outputJson); } catch { /* ignore */ }

      const detectedCount = data.frames.filter((f) => f.hasFace).length;
      log.info({ frameCount: data.frames.length, detectedCount }, 'Face detection complete');

      // If the script produced frames but none has a face, anchor every frame
      // on the script's average position (still better than center crop).
      if (data.frames.length > 0 && detectedCount === 0 && data.avgCx != null) {
        return data.frames.map((f) => ({
          frameIndex: f.frameIndex,
          timestampMs: f.timestampMs,
          cx: data.avgCx as number,
          cy: (data.avgCy ?? f.cy) as number,
          hasFace: false,
          faceSpanW: 0,
          isCut: f.isCut ?? false,
        }));
      }

      return data.frames.map((f) => ({
        frameIndex: f.frameIndex,
        timestampMs: f.timestampMs,
        cx: f.cx,
        cy: f.cy,
        hasFace: f.hasFace,
        faceSpanW: f.faceSpanW ?? 0,
        isCut: f.isCut ?? false,
      }));
    } catch (err) {
      try { fs.unlinkSync(outputJson); } catch { /* ignore */ }
      throw err;
    }
  }

  private _findPython(): string {
    const { execSync } = require('child_process') as typeof import('child_process');
    for (const py of ['python', 'python3']) {
      try {
        execSync(`${py} --version`, { stdio: 'pipe' });
        return py;
      } catch { /* try next */ }
    }
    throw new Error('Python not found');
  }

  private _runProcess(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      proc.on('error', (err) => reject(new Error(`${command} error: ${err.message}`)));
      proc.on('close', (code) => {
        if (code !== 0) reject(new Error(`${command} exited ${code}: ${stderr.slice(-300)}`));
        else resolve(stdout);
      });
    });
  }
}
