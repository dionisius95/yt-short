/**
 * Downloader — yt-dlp child process wrapper.
 *
 * Spawns yt-dlp to download a video, parses progress output, emits IPC
 * progress events to the renderer, and supports cancellation per project.
 * Retries up to 3 times with a 5-second delay on failure.
 */

import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { BrowserWindow } from 'electron';
import { CHANNELS } from '../ipc/channels';
import { createLogger } from '../utils/logger';
import type { DownloadRequest, DownloadProgress } from '../../shared/types';

const log = createLogger('Downloader');

// ---------------------------------------------------------------------------
// Quality → yt-dlp format string mapping
// ---------------------------------------------------------------------------

const QUALITY_FORMAT: Record<string, string> = {
  '1080p': 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080]',
  '720p':  'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720]',
  '480p':  'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480]',
  '360p':  'bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/best[height<=360]',
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const RETRY_LIMIT = 3;
const RETRY_DELAY_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse a yt-dlp progress template line of the form:
 *   "<percent>|<speed>|<eta>"
 * Returns null when the line does not match the expected format.
 */
function parseProgressLine(line: string): { percent: number; speed: string; eta: string } | null {
  const parts = line.trim().split('|');
  if (parts.length < 3) return null;

  const percentStr = parts[0].trim().replace('%', '');
  const percent = parseFloat(percentStr);
  if (isNaN(percent)) return null;

  return {
    percent: Math.min(100, Math.max(0, percent)),
    speed: parts[1].trim(),
    eta: parts[2].trim(),
  };
}

/**
 * Emit a DownloadProgress event to all renderer windows.
 */
function emitProgress(progress: DownloadProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(CHANNELS.DOWNLOAD_PROGRESS, progress);
    }
  }
}

// ---------------------------------------------------------------------------
// Downloader
// ---------------------------------------------------------------------------

export class Downloader {
  /** Map of projectId → active yt-dlp child process */
  private readonly processes = new Map<string, ChildProcess>();

  /**
   * Download a video using yt-dlp.
   *
   * @returns The local file path, video title, and duration in seconds.
   * @throws  An Error when all retry attempts are exhausted.
   */
  async download(
    req: DownloadRequest & { projectId: string },
  ): Promise<{ filePath: string; title: string; duration: number }> {
    const format = QUALITY_FORMAT[req.quality] ?? QUALITY_FORMAT['1080p'];
    const outputTemplate = path.join(req.outputDir, '%(id)s.%(ext)s');

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
      // Check if cancelled before each attempt
      if (!this.processes.has(req.projectId) && attempt > 1) {
        // If the entry was removed by cancel() between retries, abort.
        throw new Error(`Download cancelled for project ${req.projectId}`);
      }

      try {
        const result = await this._runYtDlp(req, format, outputTemplate);
        this.processes.delete(req.projectId);
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // If the process was explicitly cancelled, do not retry.
        if (lastError.message.includes('cancelled')) {
          this.processes.delete(req.projectId);
          throw lastError;
        }

        log.warn(
          { attempt, projectId: req.projectId, error: lastError.message },
          'yt-dlp attempt failed, retrying',
        );

        if (attempt < RETRY_LIMIT) {
          await sleep(RETRY_DELAY_MS);
        }
      }
    }

    this.processes.delete(req.projectId);
    throw lastError ?? new Error('Download failed after all retries');
  }

  /**
   * Cancel an in-progress download for the given project.
   * Kills the child process if one is running.
   */
  cancel(projectId: string): void {
    const proc = this.processes.get(projectId);
    if (proc) {
      log.info({ projectId }, 'Cancelling download');
      proc.kill('SIGTERM');
      this.processes.delete(projectId);
    }
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private _runYtDlp(
    req: DownloadRequest & { projectId: string },
    format: string,
    outputTemplate: string,
  ): Promise<{ filePath: string; title: string; duration: number }> {
    return new Promise((resolve, reject) => {
      const args = [
        '--format', format,
        '--output', outputTemplate,
        '--progress-template', '%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
        '--print', 'after_move:filepath',
        '--print-json',
        '--no-playlist',
        req.url,
      ];

      log.debug({ projectId: req.projectId, args }, 'Spawning yt-dlp');

      const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      this.processes.set(req.projectId, proc);

      let jsonOutput = '';
      let filePath = '';
      let stdoutBuffer = '';

      proc.stdout.on('data', (chunk: Buffer) => {
        stdoutBuffer += chunk.toString();
        const lines = stdoutBuffer.split('\n');
        // Keep the last (potentially incomplete) line in the buffer
        stdoutBuffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;

          // Lines starting with '{' are JSON metadata
          if (line.trim().startsWith('{')) {
            jsonOutput += line;
            continue;
          }

          // Lines that look like a file path (after_move:filepath print)
          if (line.trim().startsWith('/') || /^[A-Za-z]:\\/.test(line.trim())) {
            filePath = line.trim();
            continue;
          }

          // Otherwise try to parse as progress
          const progress = parseProgressLine(line);
          if (progress) {
            emitProgress({
              projectId: req.projectId,
              percent: progress.percent,
              speed: progress.speed,
              eta: progress.eta,
            });
          }
        }
      });

      let stderrOutput = '';
      proc.stderr.on('data', (chunk: Buffer) => {
        stderrOutput += chunk.toString();
      });

      proc.on('error', (err) => {
        reject(new Error(`yt-dlp spawn error: ${err.message}`));
      });

      proc.on('close', (code, signal) => {
        if (signal === 'SIGTERM') {
          this.processes.delete(req.projectId);
          reject(new Error(`Download cancelled for project ${req.projectId}`));
          return;
        }

        if (code !== 0) {
          // Do NOT delete from processes here — the outer retry loop manages
          // the map so it can distinguish cancellation from natural failure.
          reject(
            new Error(
              `yt-dlp exited with code ${code}. stderr: ${stderrOutput.slice(-500)}`,
            ),
          );
          return;
        }

        this.processes.delete(req.projectId);

        // Parse the JSON metadata for title and duration
        let title = 'Unknown';
        let duration = 0;

        if (jsonOutput) {
          try {
            const meta = JSON.parse(jsonOutput) as Record<string, unknown>;
            if (typeof meta['title'] === 'string') title = meta['title'];
            if (typeof meta['duration'] === 'number') duration = meta['duration'];
            // Prefer the filepath from JSON if we didn't get it from stdout
            if (!filePath && typeof meta['requested_downloads'] === 'object') {
              const downloads = meta['requested_downloads'] as Array<Record<string, unknown>>;
              if (downloads[0] && typeof downloads[0]['filepath'] === 'string') {
                filePath = downloads[0]['filepath'];
              }
            }
          } catch {
            log.warn({ projectId: req.projectId }, 'Failed to parse yt-dlp JSON metadata');
          }
        }

        if (!filePath) {
          reject(new Error('yt-dlp did not report an output file path'));
          return;
        }

        resolve({ filePath, title, duration });
      });
    });
  }
}
