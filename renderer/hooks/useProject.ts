'use client';

/**
 * useProject (fully implemented) — fetches project, hooks, transcript, and clips in parallel.
 * Requirements: 4.1, 5.1
 */

import { useState, useEffect, useCallback } from 'react';
import { ipc } from '../lib/ipc-client';
import type { Project, Hook, Transcript } from '../../shared/types';

export interface UseProjectResult {
  project: Project | null;
  hooks: Hook[];
  transcript: Transcript | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useProject(projectId: string | null): UseProjectResult {
  const [project, setProject] = useState<Project | null>(null);
  const [hooks, setHooks] = useState<Hook[]>([]);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      // Fetch project + hooks in parallel
      const [proj, hookList] = await Promise.all([
        ipc.projects.get(id),
        ipc.hooks.list(id),
      ]);
      setProject(proj);
      setHooks(hookList);

      // Transcript may not exist yet — treat null as no transcript yet
      try {
        const tx = await ipc.transcribe.getTranscript(id);
        setTranscript(tx);
      } catch {
        setTranscript(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (projectId) void load(projectId);
    else {
      setProject(null);
      setHooks([]);
      setTranscript(null);
    }
  }, [projectId, load]);

  const refresh = useCallback(() => {
    if (projectId) void load(projectId);
  }, [projectId, load]);

  return { project, hooks, transcript, loading, error, refresh };
}
