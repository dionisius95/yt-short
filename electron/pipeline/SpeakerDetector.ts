/**
 * SpeakerDetector — speaker diarization wrapper.
 *
 * Strategy (in priority order):
 *   1. pyannote.audio via Python (best quality, requires HuggingFace token)
 *   2. Simple energy-based segmentation via FFmpeg (fallback, no ML needed)
 *
 * Returns speaker segments that can be overlaid on the transcript to label
 * which speaker said which words.
 */

import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createLogger } from '../utils/logger';

const log = createLogger('SpeakerDetector');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpeakerSegment {
  speakerId: string;   // e.g. 'SPEAKER_00', 'SPEAKER_01'
  startMs: number;
  endMs: number;
}

export interface DiarizationResult {
  segments: SpeakerSegment[];
  speakerCount: number;
  method: 'pyannote' | 'energy' | 'none';
}

// ---------------------------------------------------------------------------
// SpeakerDetector
// ---------------------------------------------------------------------------

export class SpeakerDetector {
  /**
   * Detect speakers in an audio/video file.
   *
   * @param filePath       Path to audio or video file.
   * @param hfToken        HuggingFace token for pyannote (optional).
   * @param maxSpeakers    Max expected speakers (default 4).
   * @returns              Speaker segments sorted by startMs.
   */
  async detect(
    filePath: string,
    hfToken?: string,
    maxSpeakers = 4,
  ): Promise<DiarizationResult> {
    // Try pyannote first if token available
    if (hfToken) {
      try {
        const result = await this._runPyannote(filePath, hfToken, maxSpeakers);
        if (result.segments.length > 0) return result;
      } catch (err) {
        log.warn({ err }, 'pyannote failed, falling back to energy-based');
      }
    }

    // Fallback: energy-based segmentation
    try {
      return await this._runEnergyBased(filePath);
    } catch (err) {
      log.warn({ err }, 'Energy-based speaker detection failed');
      return { segments: [], speakerCount: 0, method: 'none' };
    }
  }

  /**
   * Assign speaker labels to transcript words based on diarization segments.
   * Returns a map of wordIndex → speakerId.
   */
  static assignSpeakers(
    words: Array<{ startMs: number; endMs: number }>,
    segments: SpeakerSegment[],
  ): Map<number, string> {
    const map = new Map<number, string>();

    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const midMs = (word.startMs + word.endMs) / 2;

      // Find segment that contains word midpoint
      const seg = segments.find(
        (s) => s.startMs <= midMs && s.endMs >= midMs
      );

      if (seg) map.set(i, seg.speakerId);
    }

    return map;
  }

  /**
   * Get unique speakers sorted by first appearance.
   */
  static getSpeakers(segments: SpeakerSegment[]): string[] {
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const seg of segments.sort((a, b) => a.startMs - b.startMs)) {
      if (!seen.has(seg.speakerId)) {
        seen.add(seg.speakerId);
        ordered.push(seg.speakerId);
      }
    }
    return ordered;
  }

  // ---------------------------------------------------------------------------
  // Private — pyannote.audio
  // ---------------------------------------------------------------------------

  private async _runPyannote(
    filePath: string,
    hfToken: string,
    maxSpeakers: number,
  ): Promise<DiarizationResult> {
    const python = this._findPython();
    const outputJson = path.join(os.tmpdir(), `diarize-${Date.now()}.json`);

    const scriptCandidates = [
      path.join(process.resourcesPath ?? '', 'resources', 'diarize.py'),
      path.join(__dirname, '..', '..', '..', 'resources', 'diarize.py'),
      path.join(__dirname, '..', '..', 'resources', 'diarize.py'),
    ];
    const scriptPath = scriptCandidates.find((p) => fs.existsSync(p));

    if (!scriptPath) {
      throw new Error('diarize.py not found');
    }

    await this._runProcess(python, [
      scriptPath,
      '--file', filePath,
      '--token', hfToken,
      '--max-speakers', String(maxSpeakers),
      '--output', outputJson,
    ]);

    if (!fs.existsSync(outputJson)) throw new Error('diarize.py produced no output');

    const raw = JSON.parse(fs.readFileSync(outputJson, 'utf-8')) as {
      segments: Array<{ speaker: string; start: number; end: number }>;
    };

    try { fs.unlinkSync(outputJson); } catch { /* ignore */ }

    const segments: SpeakerSegment[] = raw.segments.map((s) => ({
      speakerId: s.speaker,
      startMs: Math.round(s.start * 1000),
      endMs: Math.round(s.end * 1000),
    }));

    const speakerCount = new Set(segments.map((s) => s.speakerId)).size;
    log.info({ segmentCount: segments.length, speakerCount }, 'pyannote diarization complete');

    return { segments, speakerCount, method: 'pyannote' };
  }

  // ---------------------------------------------------------------------------
  // Private — energy-based fallback via FFmpeg silencedetect
  // ---------------------------------------------------------------------------

  private async _runEnergyBased(filePath: string): Promise<DiarizationResult> {
    // Use FFmpeg silencedetect to find speech/silence boundaries
    // Then label alternating segments as different speakers (heuristic)
    const silences = await this._detectSilences(filePath);

    if (silences.length === 0) {
      // No silence detected — treat as single speaker
      return {
        segments: [{ speakerId: 'SPEAKER_00', startMs: 0, endMs: 999999999 }],
        speakerCount: 1,
        method: 'energy',
      };
    }

    // Build speech segments from silence gaps
    const speechSegments: Array<{ startMs: number; endMs: number }> = [];
    let cursor = 0;

    for (const silence of silences) {
      if (silence.startMs > cursor + 500) {
        speechSegments.push({ startMs: cursor, endMs: silence.startMs });
      }
      cursor = silence.endMs;
    }
    // Final segment after last silence
    speechSegments.push({ startMs: cursor, endMs: 999999999 });

    // Heuristic: alternate speakers at long pauses (>1.5s)
    // This is a rough approximation — not true diarization
    const segments: SpeakerSegment[] = [];
    let currentSpeaker = 0;
    let lastEnd = 0;

    for (const seg of speechSegments) {
      const gap = seg.startMs - lastEnd;
      if (gap > 1500 && lastEnd > 0) {
        currentSpeaker = (currentSpeaker + 1) % 2; // alternate between 2 speakers
      }
      segments.push({
        speakerId: `SPEAKER_0${currentSpeaker}`,
        startMs: seg.startMs,
        endMs: seg.endMs,
      });
      lastEnd = seg.endMs;
    }

    const speakerCount = new Set(segments.map((s) => s.speakerId)).size;
    log.info({ segmentCount: segments.length, speakerCount }, 'Energy-based diarization complete');

    return { segments, speakerCount, method: 'energy' };
  }

  private async _detectSilences(
    filePath: string,
  ): Promise<Array<{ startMs: number; endMs: number }>> {
    const silences: Array<{ startMs: number; endMs: number }> = [];

    await new Promise<void>((resolve) => {
      const proc = spawn('ffmpeg', [
        '-i', filePath,
        '-af', 'silencedetect=noise=-30dB:d=0.5',
        '-f', 'null', '-',
      ], { stdio: ['ignore', 'ignore', 'pipe'] });

      let stderr = '';
      proc.stderr?.on('data', (c: Buffer) => { stderr += c.toString(); });

      proc.on('close', () => {
        // Parse silence_start / silence_end pairs
        const startMatches = [...stderr.matchAll(/silence_start: (\d+\.?\d*)/g)];
        const endMatches   = [...stderr.matchAll(/silence_end: (\d+\.?\d*)/g)];

        for (let i = 0; i < Math.min(startMatches.length, endMatches.length); i++) {
          silences.push({
            startMs: Math.round(parseFloat(startMatches[i][1]) * 1000),
            endMs:   Math.round(parseFloat(endMatches[i][1])   * 1000),
          });
        }
        resolve();
      });

      proc.on('error', () => resolve());
      setTimeout(() => { proc.kill(); resolve(); }, 30_000);
    });

    return silences;
  }

  private _runProcess(command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      proc.stderr?.on('data', (c: Buffer) => { stderr += c.toString(); });
      proc.on('error', (e) => reject(new Error(`${command}: ${e.message}`)));
      proc.on('close', (code) => {
        if (code !== 0) reject(new Error(`${command} exited ${code}: ${stderr.slice(-300)}`));
        else resolve();
      });
    });
  }

  private _findPython(): string {
    for (const py of ['python', 'python3']) {
      try {
        execSync(`${py} --version`, { stdio: 'pipe' });
        return py;
      } catch { /* try next */ }
    }
    return 'python';
  }
}
