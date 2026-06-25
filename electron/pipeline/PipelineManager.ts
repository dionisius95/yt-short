/**
 * PipelineManager — orchestrates the full pipeline end-to-end:
 * Download → Transcribe → Analyze → Process (all hooks) → done.
 *
 * Emits IPC progress events at each stage so the renderer can show
 * a unified progress view without manually chaining stages.
 *
 * Usage:
 *   const pm = new PipelineManager(services);
 *   await pm.run(projectId, { autoTranscribe: true, autoAnalyze: true, autoProcess: true });
 *   pm.cancel(projectId);
 */

import { BrowserWindow } from 'electron';
import { createLogger } from '../utils/logger';

const log = createLogger('PipelineManager');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PipelineStage =
  | 'download'
  | 'transcribe'
  | 'analyze'
  | 'process'
  | 'done'
  | 'failed';

export interface PipelineRunOptions {
  /** Auto-start transcription after download completes. Default: true */
  autoTranscribe?: boolean;
  /** Auto-start analysis after transcription completes. Default: true */
  autoAnalyze?: boolean;
  /** Auto-generate clips for all detected hooks after analysis. Default: true */
  autoProcess?: boolean;
}

export interface PipelineEvent {
  projectId: string;
  stage: PipelineStage;
  /** 0–100 within the current stage */
  stageProgress: number;
  /** 0–100 overall across all stages */
  overallProgress: number;
  error?: string;
}

/** Minimal service interface — injected from main.ts to avoid circular deps */
export interface PipelineServices {
  startTranscribe: (projectId: string, onProgress?: (pct: number) => void) => Promise<void>;
  startAnalyze: (projectId: string) => Promise<unknown[]>;
  generateClip: (hookId: string, options: Record<string, unknown>) => Promise<{ clipId: string }>;
}

// ---------------------------------------------------------------------------
// Stage weight map (must sum to 100)
// ---------------------------------------------------------------------------

const STAGE_WEIGHTS: Record<string, number> = {
  transcribe: 30,
  analyze:    20,
  process:    50,
};

// ---------------------------------------------------------------------------
// PipelineManager
// ---------------------------------------------------------------------------

export class PipelineManager {
  private readonly services: PipelineServices;

  /** projectId → AbortController for cancellation */
  private readonly cancels = new Map<string, AbortController>();

  constructor(services: PipelineServices) {
    this.services = services;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Run the full pipeline for a project that has already been downloaded.
   * Stages: Transcribe → Analyze → Process all hooks.
   *
   * Resolves when all stages complete or rejects on first unrecoverable error.
   * Cancellation via cancel(projectId) causes an early resolve (not reject).
   */
  async run(
    projectId: string,
    opts: PipelineRunOptions = {},
  ): Promise<void> {
    const {
      autoTranscribe = true,
      autoAnalyze    = true,
      autoProcess    = true,
    } = opts;

    const ac = new AbortController();
    this.cancels.set(projectId, ac);

    log.info({ projectId, opts }, 'Pipeline started');

    try {
      // ── Stage 1: Transcribe ──────────────────────────────────────────────
      if (autoTranscribe) {
        if (ac.signal.aborted) return;
        this._emit(projectId, 'transcribe', 0, 0);
        log.info({ projectId }, 'Pipeline: transcribe start');

        // onProgress callback: forward whisper % → pipeline:progress
        const onTranscribeProgress = (pct: number) => {
          if (ac.signal.aborted) return;
          const overall = Math.round((pct / 100) * STAGE_WEIGHTS.transcribe);
          this._emit(projectId, 'transcribe', pct, overall);
        };

        try {
          await this.services.startTranscribe(projectId, onTranscribeProgress);
        } finally {
          // ensure cleanup even on error
        }

        if (ac.signal.aborted) return;
        this._emit(projectId, 'transcribe', 100, STAGE_WEIGHTS.transcribe);
        log.info({ projectId }, 'Pipeline: transcribe done');
      }

      // ── Stage 2: Analyze ─────────────────────────────────────────────────
      let hooks: unknown[] = [];
      if (autoAnalyze) {
        if (ac.signal.aborted) return;
        const transcribeWeight = autoTranscribe ? STAGE_WEIGHTS.transcribe : 0;
        this._emit(projectId, 'analyze', 0, transcribeWeight);
        log.info({ projectId }, 'Pipeline: analyze start');

        hooks = await this.services.startAnalyze(projectId);

        if (ac.signal.aborted) return;
        this._emit(
          projectId,
          'analyze',
          100,
          transcribeWeight + STAGE_WEIGHTS.analyze,
        );
        log.info({ projectId, hookCount: hooks.length }, 'Pipeline: analyze done');
      }

      // ── Stage 3: Process all hooks ───────────────────────────────────────
      if (autoProcess && hooks.length > 0) {
        if (ac.signal.aborted) return;

        const transcribeWeight = autoTranscribe ? STAGE_WEIGHTS.transcribe : 0;
        const analyzeWeight    = autoAnalyze    ? STAGE_WEIGHTS.analyze    : 0;
        const baseProgress     = transcribeWeight + analyzeWeight;

        log.info({ projectId, hookCount: hooks.length }, 'Pipeline: process start');

        // Generate clips sequentially to avoid overwhelming FFmpeg
        for (let i = 0; i < hooks.length; i++) {
          if (ac.signal.aborted) return;

          const hook = hooks[i] as { id: string };
          const stageProgress = Math.round(((i) / hooks.length) * 100);
          const overallProgress = Math.round(
            baseProgress + (stageProgress / 100) * STAGE_WEIGHTS.process
          );

          this._emit(projectId, 'process', stageProgress, overallProgress);
          log.info({ projectId, hookId: hook.id, index: i + 1, total: hooks.length }, 'Pipeline: generating clip');

          try {
            await this.services.generateClip(hook.id, {});
          } catch (err) {
            // Log but continue — one failed clip shouldn't abort the rest
            log.warn({ projectId, hookId: hook.id, err }, 'Clip generation failed, continuing');
          }
        }

        this._emit(projectId, 'process', 100, 100);
        log.info({ projectId }, 'Pipeline: process done');
      }

      // ── Done ─────────────────────────────────────────────────────────────
      this._emit(projectId, 'done', 100, 100);
      log.info({ projectId }, 'Pipeline complete');
    } catch (err) {
      if (ac.signal.aborted) return; // cancelled — not an error

      const msg = err instanceof Error ? err.message : String(err);
      log.error({ projectId, err: msg }, 'Pipeline failed');
      this._emit(projectId, 'failed', 0, 0, msg);
      throw err;
    } finally {
      this.cancels.delete(projectId);
    }
  }

  /**
   * Cancel an in-progress pipeline run for the given project.
   * The run() promise will resolve (not reject) after the current
   * awaited operation finishes.
   */
  cancel(projectId: string): void {
    const ac = this.cancels.get(projectId);
    if (ac) {
      log.info({ projectId }, 'Pipeline cancelled');
      ac.abort();
      this.cancels.delete(projectId);
    }
  }

  /** True if a pipeline is currently running for this project */
  isRunning(projectId: string): boolean {
    return this.cancels.has(projectId);
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private _emit(
    projectId: string,
    stage: PipelineStage,
    stageProgress: number,
    overallProgress: number,
    error?: string,
  ): void {
    const event: PipelineEvent = {
      projectId,
      stage,
      stageProgress,
      overallProgress,
      error,
    };

    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('pipeline:progress', event);
      }
    }
  }
}
