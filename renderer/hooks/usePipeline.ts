'use client';

/**
 * usePipeline — manages the full automated pipeline for a project.
 *
 * Wraps ipc.pipeline.run/cancel and subscribes to pipeline:progress events.
 * Exposes a simple { run, cancel, running, stage, overallProgress, error } API
 * so any component can trigger and monitor the pipeline without boilerplate.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { ipc } from '../lib/ipc-client';

export type PipelineStage =
  | 'idle'
  | 'transcribe'
  | 'analyze'
  | 'process'
  | 'done'
  | 'failed';

export interface PipelineState {
  running: boolean;
  stage: PipelineStage;
  stageProgress: number;   // 0–100 within current stage
  overallProgress: number; // 0–100 across all stages
  error: string | null;
}

export interface UsePipelineResult extends PipelineState {
  /** Start the full pipeline. Resolves immediately; progress via state. */
  run: (opts?: { autoTranscribe?: boolean; autoAnalyze?: boolean; autoProcess?: boolean }) => Promise<void>;
  /** Cancel the running pipeline. */
  cancel: () => Promise<void>;
}

const IDLE_STATE: PipelineState = {
  running: false,
  stage: 'idle',
  stageProgress: 0,
  overallProgress: 0,
  error: null,
};

export function usePipeline(projectId: string | null): UsePipelineResult {
  const [state, setState] = useState<PipelineState>(IDLE_STATE);
  // Keep projectId in a ref so the event listener closure always has latest value
  const projectIdRef = useRef(projectId);
  useEffect(() => { projectIdRef.current = projectId; }, [projectId]);

  // Subscribe to pipeline:progress events
  useEffect(() => {
    if (!projectId) return;

    const unsub = ipc.pipeline.onProgress((event) => {
      if (event.projectId !== projectIdRef.current) return;

      const stage = event.stage as PipelineStage;
      const done  = stage === 'done';
      const failed = stage === 'failed';

      setState({
        running:         !done && !failed,
        stage,
        stageProgress:   event.stageProgress,
        overallProgress: event.overallProgress,
        error:           event.error ?? null,
      });
    });

    return unsub;
  }, [projectId]);

  const run = useCallback(async (opts?: {
    autoTranscribe?: boolean;
    autoAnalyze?: boolean;
    autoProcess?: boolean;
  }) => {
    if (!projectId) return;

    setState({
      running: true,
      stage: 'transcribe',
      stageProgress: 0,
      overallProgress: 0,
      error: null,
    });

    try {
      await ipc.pipeline.run(projectId, opts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setState((prev) => ({ ...prev, running: false, stage: 'failed', error: msg }));
    }
  }, [projectId]);

  const cancel = useCallback(async () => {
    if (!projectId) return;
    await ipc.pipeline.cancel(projectId);
    setState(IDLE_STATE);
  }, [projectId]);

  return { ...state, run, cancel };
}
