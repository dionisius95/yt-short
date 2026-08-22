'use client';

/**
 * Export Queue page — lists all clips for a project with live progress.
 * Requirements: 7.1, 7.2, 7.5, 7.10–7.13, 9.3, 9.4, 9.7
 */

import { useState, useEffect, useCallback } from 'react';import { useParams, useRouter } from 'next/navigation';
import { AppShell } from '../../../../components/layout/AppShell';
import { ClipItem } from '../../../../components/export/ClipItem';
import { ExportSummaryBanner } from '../../../../components/export/ExportSummaryBanner';
import { Toast } from '../../../../components/ui/Toast';
import { useToast } from '../../../../hooks/useToast';
import { useIpcEvent } from '../../../../hooks/useIpcEvent';
import { ipc } from '../../../../lib/ipc-client';
import { isElectron, electronNavigate, readSessionId } from '../../../../lib/isElectron';
import type { Clip, Hook } from '../../../../../shared/types';
import { cn } from '../../../../lib/utils';

// Skeleton row
function ClipItemSkeleton() {
  return (
    <div className="surface flex flex-col gap-3 p-4 animate-pulse">
      <div className="flex items-start gap-3">
        <div className="h-12 w-20 rounded bg-border" />
        <div className="flex flex-1 flex-col gap-2">
          <div className="h-4 w-3/4 rounded bg-border" />
          <div className="h-5 w-16 rounded-sm bg-border" />
        </div>
      </div>
    </div>
  );
}

export default function ExportQueuePage() {
  const params  = useParams<{ id: string }>();
  // In Electron production the shell is /project/_/clips/index.html.
  // The real project id is stored in sessionStorage by the navigation helper.
  const [projectId] = useState<string>(() => {
    if (typeof window === 'undefined') return params.id;
    if (params.id && params.id !== '_') {
      try {
        sessionStorage.setItem('pendingProjectId', params.id);
        localStorage.setItem('pendingProjectId', params.id);
      } catch {}
      return params.id;
    }
    const stored = readSessionId('pendingProjectId');
    return (stored && stored !== '_') ? stored : params.id;
  });
  const router  = useRouter();
  const { toasts, showToast, dismissToast } = useToast();

  const [clips, setClips]   = useState<Clip[]>([]);
  const [hooks, setHooks]   = useState<Hook[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!isElectron()) { setLoading(false); return; }
    setLoading(true);
    try {
      const [clipList, hookList] = await Promise.all([
        ipc.clips.list(projectId),
        ipc.hooks.list(projectId),
      ]);
      setClips(clipList);
      setHooks(hookList);
    } catch {
      showToast('Failed to load clips.', 'error');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
    const handleUpdated = () => { void load(); };
    window.addEventListener('clips:updated', handleUpdated);
    return () => window.removeEventListener('clips:updated', handleUpdated);
  }, [load]);

  // Live clip progress — update status in-place or reload when new clip finishes
  useIpcEvent<{ clipId: string; percent: number; eta: string }>(
    'clip:progress',
    (data) => {
      setClips((prev) => {
        const exists = prev.some((c) => c.id === data.clipId);
        if (!exists && data.percent >= 100) {
          // New clip created in DB (e.g. commentary clip)
          void load();
          return prev;
        }
        return prev.map((c) => {
          if (c.id !== data.clipId) return c;
          if (data.percent < 0) return { ...c, status: 'failed' as const };
          if (data.percent >= 100) return { ...c, status: 'complete' as const };
          return { ...c, status: 'processing' as const };
        });
      });
      // Re-fetch clip to get outputPath when complete
      if (data.percent >= 100) {
        void ipc.clips.get(data.clipId).then((updated) => {
          if (updated) {
            setClips((prev) => {
              const exists = prev.some((c) => c.id === updated.id);
              if (exists) return prev.map((c) => c.id === updated.id ? updated : c);
              return [updated, ...prev];
            });
          }
        }).catch(() => {/* ignore */});
      }
    },
    [projectId, load]
  );

  // Export progress
  useIpcEvent<{ clipId: string; percent: number; eta: string }>(
    'export:progress',
    (data) => {
      setClips((prev) =>
        prev.map((c) =>
          c.id === data.clipId ? { ...c, status: 'processing' } : c
        )
      );
    },
    [projectId]
  );

  // Pipeline progress — reload clips when new ones are generated
  useIpcEvent<{ projectId: string; stage: string; overallProgress: number }>(
    'pipeline:progress',
    (data) => {
      if (data.projectId !== projectId) return;
      // Reload when pipeline finishes processing stage or completes
      if (data.stage === 'done' || data.stage === 'process') {
        void load();
      }
    },
    [projectId]
  );

  const handleRemoved = (clipId: string) => {
    setClips((prev) => prev.filter((c) => c.id !== clipId));
    showToast('Clip removed.', 'success');
  };

  const handleGenerateAll = async () => {
    // Find hooks that don't have a clip yet
    const existingHookIds = new Set(clips.map((c) => c.hookId));
    const pending = hooks.filter((h) => !h.dismissed && !existingHookIds.has(h.id));
    if (pending.length === 0) {
      showToast('All hooks already have clips.', 'info');
      return;
    }
    showToast(`Generating ${pending.length} clip${pending.length > 1 ? 's' : ''}…`, 'info');
    await Promise.allSettled(pending.map((h) => ipc.clips.generate(h.id, {})));
    await load();
  };

  // Summary counts for TopBar
  const complete   = clips.filter((c) => c.status === 'complete').length;
  const processing = clips.filter((c) => c.status === 'processing').length;
  const pending    = clips.filter((c) => c.status === 'pending').length;

  const statusSummary = clips.length > 0
    ? `${complete} complete · ${processing} processing · ${pending} pending`
    : '';

  const actions = (
    <div className="flex items-center gap-3">
      {projectId && projectId !== '_' && (
        <button
          type="button"
          onClick={() => electronNavigate(router, `/project/${projectId}`, { key: 'pendingProjectId', value: projectId })}
          className={cn(
            'flex items-center gap-1.5 rounded-md border border-accent/40 bg-accent/10 px-3 py-1.5',
            'text-xs font-semibold text-accent',
            'hover:bg-accent hover:text-accent-foreground transition-micro',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'
          )}
        >
          ← Back to Hooks
        </button>
      )}
      {statusSummary && (
        <span className="text-xs font-mono text-text-secondary">{statusSummary}</span>
      )}
      {hooks.length > 0 && (
        <button
          type="button"
          onClick={() => void handleGenerateAll()}
          className={cn(
            'flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5',
            'text-xs font-medium text-text-secondary',
            'hover:border-accent/40 hover:text-text-primary transition-micro',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'
          )}
        >
          + Generate Missing Clips
        </button>
      )}
    </div>
  );

  return (
    <>
      <AppShell title="Export Queue" actions={actions}>
        <div className="mx-auto max-w-2xl px-6 py-6 flex flex-col gap-4">

          {/* Navigation Bar / Breadcrumb */}
          {projectId && projectId !== '_' && (
            <div className="flex items-center justify-between pb-1">
              <button
                type="button"
                onClick={() => electronNavigate(router, `/project/${projectId}`, { key: 'pendingProjectId', value: projectId })}
                className={cn(
                  'inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5',
                  'text-xs font-medium text-text-secondary',
                  'hover:border-accent/40 hover:text-text-primary hover:bg-surface-elevated transition-micro group',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'
                )}
              >
                <span className="text-sm leading-none group-hover:-translate-x-0.5 transition-transform">←</span>
                <span>Kembali ke Halaman Project / Clip Hook</span>
              </button>
            </div>
          )}

          {/* Loading skeletons */}
          {loading && Array.from({ length: 4 }).map((_, i) => (
            <ClipItemSkeleton key={i} />
          ))}

          {/* Empty state */}
          {!loading && clips.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
              <p className="text-sm font-medium text-text-primary">No clips yet</p>
              <p className="text-xs text-text-secondary">
                Go to a project, select a hook, and click Generate Clip.
              </p>
              <div className="flex items-center gap-2 mt-2">
                {projectId && projectId !== '_' && (
                  <button
                    type="button"
                    onClick={() => electronNavigate(router, `/project/${projectId}`, { key: 'pendingProjectId', value: projectId })}
                    className={cn(
                      'rounded-md bg-accent px-4 py-2 text-xs font-semibold text-accent-foreground',
                      'hover:bg-accent-hover transition-micro',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'
                    )}
                  >
                    ← Back to Project (Hooks)
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => electronNavigate(router, '/')}
                  className={cn(
                    'rounded-md border border-border px-4 py-2 text-xs text-text-secondary',
                    'hover:border-accent/40 hover:text-text-primary transition-micro',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'
                  )}
                >
                  Dashboard
                </button>
              </div>
            </div>
          )}

          {/* Clip list */}
          {!loading && clips.length > 0 && (
            <>
              {/* Summary banner (terminal state) */}
              <ExportSummaryBanner clips={clips} />

              {clips.map((clip) => (
                <ClipItem
                  key={clip.id}
                  clip={clip}
                  hook={hooks.find((h) => h.id === clip.hookId)}
                  onRemoved={handleRemoved}
                />
              ))}
            </>
          )}
        </div>
      </AppShell>

      <Toast toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
