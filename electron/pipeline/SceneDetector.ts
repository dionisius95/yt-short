/**
 * SceneDetector — FFmpeg-based scene cut detection.
 *
 * Uses FFmpeg's `select` filter with scene change threshold to find
 * visual cut points in a video. Returns timestamps in milliseconds.
 *
 * Scene cuts help the Analyzer pick better clip boundaries and
 * help the Processor avoid cutting mid-scene.
 */

import { spawn } from 'child_process';
import { createLogger } from '../utils/logger';

const log = createLogger('SceneDetector');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SceneCut {
  /** Timestamp of the scene cut in milliseconds */
  timestampMs: number;
  /** Scene change score 0.0–1.0 (higher = more different from previous frame) */
  score: number;
}

export interface SceneDetectionResult {
  cuts: SceneCut[];
  /** Total number of frames analyzed */
  framesAnalyzed: number;
}

// ---------------------------------------------------------------------------
// SceneDetector
// ---------------------------------------------------------------------------

export class SceneDetector {
  /**
   * Detect scene cuts in a video file.
   *
   * @param filePath   Path to the video file.
   * @param threshold  Scene change threshold 0.0–1.0. Lower = more sensitive.
   *                   Default 0.3 works well for most content.
   * @param startMs    Optional start time in ms (analyze from here).
   * @param endMs      Optional end time in ms (analyze until here).
   * @returns          Array of scene cut timestamps sorted ascending.
   */
  async detect(
    filePath: string,
    threshold = 0.3,
    startMs?: number,
    endMs?: number,
  ): Promise<SceneDetectionResult> {
    log.info({ filePath, threshold, startMs, endMs }, 'Starting scene detection');

    const args: string[] = [];

    if (startMs !== undefined) {
      args.push('-ss', String(startMs / 1000));
    }

    args.push('-i', filePath);

    if (endMs !== undefined && startMs !== undefined) {
      args.push('-t', String((endMs - startMs) / 1000));
    }

    // select filter: output frames where scene score > threshold
    // showinfo: print frame info including pts_time to stderr
    args.push(
      '-vf', `select='gt(scene,${threshold})',showinfo`,
      '-vsync', 'vfr',
      '-f', 'null',
      '-',
    );

    const cuts: SceneCut[] = [];
    let framesAnalyzed = 0;

    await new Promise<void>((resolve) => {
      const proc = spawn('ffmpeg', ['-y', ...args], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });

      let stderr = '';

      proc.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;

        // Parse showinfo output: "pts_time:X.XXX ... Parsed_showinfo_1 ... scene_score:X.XXX"
        // FFmpeg showinfo format: [Parsed_showinfo_1 @ ...] n:N pts:N pts_time:X.XXX ...
        for (const line of text.split('\n')) {
          const ptsMatch = line.match(/pts_time:(\d+\.?\d*)/);
          const sceneMatch = line.match(/scene_score:(\d+\.?\d*)/);

          if (ptsMatch) {
            framesAnalyzed++;
            const ptsTimeSec = parseFloat(ptsMatch[1]);
            const offsetMs = startMs ?? 0;
            const absoluteMs = Math.round(ptsTimeSec * 1000) + offsetMs;

            const score = sceneMatch ? parseFloat(sceneMatch[1]) : threshold + 0.01;

            cuts.push({ timestampMs: absoluteMs, score });
          }
        }
      });

      proc.on('error', (err) => {
        log.warn({ err: err.message }, 'FFmpeg scene detection spawn error');
        resolve(); // non-fatal — return empty cuts
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          log.warn({ code, stderr: stderr.slice(-200) }, 'FFmpeg scene detection exited non-zero');
        }
        resolve();
      });

      // Timeout after 60s — scene detection should be fast (no encode)
      setTimeout(() => {
        proc.kill('SIGTERM');
        resolve();
      }, 60_000);
    });

    // Sort by timestamp ascending
    cuts.sort((a, b) => a.timestampMs - b.timestampMs);

    log.info({ filePath, cutCount: cuts.length, framesAnalyzed }, 'Scene detection complete');

    return { cuts, framesAnalyzed };
  }

  /**
   * Find the nearest scene cut to a given timestamp within a tolerance window.
   * Useful for snapping clip boundaries to natural cut points.
   *
   * @param cuts        Scene cuts from detect().
   * @param targetMs    Target timestamp in ms.
   * @param windowMs    Search window ±ms around target. Default 3000ms.
   * @returns           Nearest cut timestamp, or targetMs if none found.
   */
  static snapToCut(cuts: SceneCut[], targetMs: number, windowMs = 3000): number {
    const nearby = cuts.filter(
      (c) => Math.abs(c.timestampMs - targetMs) <= windowMs
    );

    if (nearby.length === 0) return targetMs;

    // Pick the cut closest to target
    nearby.sort((a, b) =>
      Math.abs(a.timestampMs - targetMs) - Math.abs(b.timestampMs - targetMs)
    );

    return nearby[0].timestampMs;
  }

  /**
   * Summarize scene cuts into chapter-like segments.
   * Groups cuts that are too close together (< minGapMs).
   *
   * @param cuts      Scene cuts from detect().
   * @param minGapMs  Minimum gap between returned cuts. Default 5000ms.
   * @returns         Filtered cuts with minimum spacing.
   */
  static filterCuts(cuts: SceneCut[], minGapMs = 5000): SceneCut[] {
    if (cuts.length === 0) return [];

    const filtered: SceneCut[] = [cuts[0]];

    for (let i = 1; i < cuts.length; i++) {
      const last = filtered[filtered.length - 1];
      if (cuts[i].timestampMs - last.timestampMs >= minGapMs) {
        filtered.push(cuts[i]);
      } else if (cuts[i].score > last.score) {
        // Replace with higher-score cut in same window
        filtered[filtered.length - 1] = cuts[i];
      }
    }

    return filtered;
  }
}
