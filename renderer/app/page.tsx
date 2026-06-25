'use client';

/**
 * Dashboard page — lists all projects, provides empty-state URL import.
 * Requirements: 2.1–2.12
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from '../components/layout/AppShell';
import { ProjectGrid } from '../components/dashboard/ProjectGrid';
import { Toast } from '../components/ui/Toast';
import { useToast } from '../hooks/useToast';
import { ipc } from '../lib/ipc-client';
import { validateYouTubeUrl } from '../lib/urlValidator';
import type { ProjectDashboardItem } from '../../shared/types';
import { cn } from '../lib/utils';

// ---------------------------------------------------------------------------
// Empty state — large URL input
// ---------------------------------------------------------------------------

function EmptyState({ onSubmit }: { onSubmit: (url: string) => void }) {
  const [url, setUrl] = useState('');
  const validation = validateYouTubeUrl(url);
  const isValid = url.length > 0 && validation.valid;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isValid) onSubmit(url);
  };

  return (
    <div className="flex flex-col items-center justify-center gap-6 py-24 text-center">
      {/* Illustration */}
      <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-accent/10 ring-1 ring-accent/20">
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
          className="text-accent" aria-hidden="true">
          <circle cx="12" cy="12" r="10"/>
          <polygon points="10 8 16 12 10 16 10 8"/>
        </svg>
      </div>

      <div>
        <h2 className="text-lg font-semibold text-text-primary">No projects yet</h2>
        <p className="mt-1 text-sm text-text-secondary">
          Paste a YouTube URL below to import your first video.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex w-full max-w-lg gap-3">
        <div className="relative flex-1">
          <input
            id="dashboard-url-input"
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.youtube.com/watch?v=..."
            aria-label="YouTube URL"
            className={cn(
              'w-full rounded-md border bg-surface px-4 py-2.5 text-sm text-text-primary',
              'placeholder:text-text-secondary/60',
              'focus:outline-none focus:ring-2 focus:ring-accent',
              'transition-micro',
              url.length > 0 && !isValid ? 'border-destructive/60' : 'border-border'
            )}
          />
          {url.length > 0 && (
            <span className={cn(
              'absolute right-3 top-1/2 -translate-y-1/2 text-xs',
              isValid ? 'text-success' : 'text-destructive'
            )}>
              {isValid ? '✓' : '✕'}
            </span>
          )}
        </div>
        <button
          type="submit"
          disabled={!isValid}
          className={cn(
            'rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-accent-foreground',
            'hover:bg-accent-hover transition-micro',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            'disabled:opacity-40 disabled:cursor-not-allowed'
          )}
        >
          Import
        </button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard page
// ---------------------------------------------------------------------------

export default function DashboardPage() {
  const router = useRouter();
  const { toasts, showToast, dismissToast } = useToast();

  const [projects, setProjects] = useState<ProjectDashboardItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    // Guard: ipc is only available inside Electron
    if (typeof window === 'undefined' || !window.electron) {
      setLoading(false);
      setProjects([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await ipc.projects.list();
      setProjects(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load projects.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleDeleted = (id: string) => {
    setProjects((prev) => prev.filter((p) => p.id !== id));
    showToast('Project deleted.', 'success');
  };

  const handleEmptySubmit = (url: string) => {
    router.push(`/import?url=${encodeURIComponent(url)}`);
  };

  // TopBar action button
  const actions = (
    <button
      type="button"
      id="dashboard-new-import-btn"
      onClick={() => router.push('/import')}
      className={cn(
        'flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5',
        'text-xs font-medium text-accent-foreground',
        'hover:bg-accent-hover transition-micro',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'
      )}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
        aria-hidden="true">
        <line x1="12" y1="5" x2="12" y2="19"/>
        <line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
      New Import
    </button>
  );

  return (
    <>
      <AppShell title="Dashboard" actions={actions}>
        <div className="p-6">
          {/* Error state */}
          {error && (
            <div className="mb-6 flex items-center justify-between rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3">
              <p className="text-sm text-destructive">{error}</p>
              <button
                type="button"
                onClick={load}
                className="ml-4 text-xs font-medium text-destructive underline underline-offset-2 hover:no-underline"
              >
                Retry
              </button>
            </div>
          )}

          <ProjectGrid
            projects={projects}
            loading={loading}
            onDeleted={handleDeleted}
            emptyState={<EmptyState onSubmit={handleEmptySubmit} />}
          />
        </div>
      </AppShell>

      <Toast toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
