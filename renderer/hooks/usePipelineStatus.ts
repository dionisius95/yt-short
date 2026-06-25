'use client';

/**
 * usePipelineStatus — subscribes to pipeline progress events from the main process.
 * Full implementation in the renderer UI tasks.
 */
import { useState, useEffect } from 'react';
import type { PipelineStatus, PipelineStage } from '../../shared/types';

/** Maps each push channel to the pipeline stage it represents */
const CHANNEL_STAGE_MAP: Record<string, PipelineStage> = {
  'download:progress':  'download',
  'transcribe:progress': 'transcribe',
  'clip:progress':      'process',
  'export:progress':    'process',
  'upload:progress':    'upload',
};

/**
 * Hook that subscribes to pipeline progress events for a given project.
 * Returns the latest pipeline status.
 */
export function usePipelineStatus(projectId: string | null): PipelineStatus | null {
  const [status, setStatus] = useState<PipelineStatus | null>(null);

  useEffect(() => {
    if (!projectId) return;

    const unsubscribers: Array<() => void> = [];

    for (const [channel, stage] of Object.entries(CHANNEL_STAGE_MAP)) {
      const unsub = window.electron.on(channel, (data: unknown) => {
        const payload = data as { projectId?: string; percent?: number };
        if (payload.projectId === projectId) {
          setStatus({
            projectId,
            stage,
            status: 'running',
            progress: payload.percent ?? 0,
          });
        }
      });
      unsubscribers.push(unsub);
    }

    return () => {
      for (const unsub of unsubscribers) unsub();
    };
  }, [projectId]);

  return status;
}
