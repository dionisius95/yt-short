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
    _srcWidth = 1920,
    _srcHeight = 1080,
  ): Promise<CropFrame[]> {
    try {
      return await this._detectWithScript(sourceFile, startMs, endMs);
    } catch (err) {
      log.warn({ err }, 'Face detection failed, returning empty frames');
      return [];
    }
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
        frames: Array<{ frameIndex: number; timestampMs: number; cx: number; cy: number; hasFace: boolean; faceSpanW?: number }>;
      };

      try { fs.unlinkSync(outputJson); } catch { /* ignore */ }

      log.info({ frameCount: data.frames.length }, 'Face detection complete');

      return data.frames.map((f) => ({
        frameIndex: f.frameIndex,
        timestampMs: f.timestampMs,
        cx: f.cx,
        cy: f.cy,
        hasFace: f.hasFace,
        faceSpanW: f.faceSpanW ?? 0,
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
