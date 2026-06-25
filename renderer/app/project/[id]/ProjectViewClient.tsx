'use client';

/**
 * Project View page — 3-column layout: Transcript | Hooks | Preview.
 * Requirements: 4.1, 9.2, 9.3, 9.7, 10.4, 10.5
 */

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AppShell } from '../../../components/layout/AppShell';
import { TranscriptPanel } from '../../../components/project/TranscriptPanel';
import { HookListPanel } from '../../../components/project/HookListPanel';
import { ClipPreviewPanel } from '../../../components/project/ClipPreviewPanel';
import { Toast } from '../../../components/ui/Toast';
import { useProject } from '../../../hooks/useProject';
import { useToast } from '../../../hooks/useToast';
import { ipc } from '../../../lib/ipc-client';
import { electronNavigate, readSessionId } from '../../../lib/isElectron';
import type { Clip } from '../../../../shared/types';
import { cn } from '../../../lib/utils';

// ---------------------------------------------------------------------------
// Default settings fallback (loaded lazily)
// ---------------------------------------------------------------------------
const DEFAULT_SETTINGS = {
  defaultSubtitleStyle: 'bold-white' as const,
  defaultSubtitlePosition: 'lower-third' as const,
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ProjectViewPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { toasts, showToast, dismissToast } = useToast();

  // Resolve the real project ID — in Electron production the shell is
  // /project/_/index.html, so params.id === '_'. The real ID is stored
  // in sessionStorage by the navigation helper. We read it in a useState
  // initialiser (runs only on client, never during SSR) to avoid hydration
  // mismatch.
  const [projectId] = useState<string>(() => {
    if (typeof window === 'undefined') return params.id;
    if (params.id !== '_') return params.id;
    return readSessionId('pendingProjectId') ?? params.id;
  });

  const { project, hooks, transcript, loading, error, refresh } = useProject(projectId);

  const [activeHooks, setActiveHooks] = useState(hooks);
  const [selectedHookId, setSelectedHookId] = useState<string | null>(null);
  const [selectedHook, setSelectedHook] = useState<import('../../../../shared/types').Hook | null>(null);
  const [currentClip, setCurrentClip] = useState<Clip | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [ollamaError, setOllamaError] = useState(false);
  const [momentTheme, setMomentTheme] = useState('');

  // Keep local hook list in sync after mount
  useEffect(() => { setActiveHooks(hooks); }, [hooks]);

  const handleRunAnalysis = async () => {
    setAnalyzing(true);
    setOllamaError(false);
    try {
      const theme = momentTheme.trim() || undefined;
      const newHooks = await ipc.analyze.start(projectId, theme);
      if (newHooks.length === 0) {
        showToast('No hooks found. Try a longer video or different content.', 'info');
      } else {
        showToast(`Found ${newHooks.length} hooks.`, 'success');
      }
      setActiveHooks(newHooks);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('OLLAMA') || msg.includes('unavailable') || msg.includes('unreachable') || msg.includes('11434')) {
        setOllamaError(true);
        showToast('Could not connect to Ollama after multiple retries. Check if Ollama is responsive (not frozen).', 'error');
      } else if (msg.includes('Transcribe') || msg.includes('transcript')) {
        showToast('Please transcribe the video first before running analysis.', 'error');
      } else if (msg.includes('INSUFFICIENT_HOOKS')) {
        showToast('Not enough hooks found. The transcript may be too short.', 'error');
      } else {
        showToast(`Analysis failed: ${msg}`, 'error');
      }
    } finally {
      setAnalyzing(false);
    }
  };

  const handleHookDismissed = (id: string) => {
    setActiveHooks((prev) => prev.map((h) => h.id === id ? { ...h, dismissed: true } : h));
    if (selectedHookId === id) setSelectedHookId(null);
    showToast('Hook dismissed.', 'info');
  };

  const handleHookSelected = async (id: string) => {
    setSelectedHookId(id);
    const hook = (activeHooks.length > 0 ? activeHooks : hooks).find((h) => h.id === id) ?? null;
    setSelectedHook(hook);
    try {
      const clips = await ipc.clips.list(projectId);
      const clip = clips.find((c) => c.hookId === id) ?? null;
      setCurrentClip(clip);
    } catch { /* ignore */ }
  };

  // ── Loading state ──
  if (loading) {
    return (
      <AppShell title="Loading project…">
        <div className="flex h-full items-center justify-center">
          <span className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-accent" />
        </div>
      </AppShell>
    );
  }

  // ── Error / not found state ──
  if (error || !project) {
    return (
      <AppShell title="Project not found">
        <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
          <p className="text-sm text-destructive">{error ?? 'Project not found.'}</p>
          <button
            type="button"
            onClick={() => router.push('/')}
            className={cn(
              'rounded-md border border-border px-4 py-2 text-sm text-text-secondary',
              'hover:text-text-primary hover:border-accent/40 transition-micro',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'
            )}
          >
            ← Back to Dashboard
          </button>
        </div>
      </AppShell>
    );
  }

  // ── TopBar actions ──
  const actions = (
    <div className="flex items-center gap-2">
      {/* Moment theme input */}
      <div className="relative">
        <input
          type="text"
          value={momentTheme}
          onChange={(e) => setMomentTheme(e.target.value)}
          disabled={analyzing || !transcript}
          placeholder="tema momen (opsional)"
          aria-label="Tema momen yang ingin dicari, misal: lucu, seru, sedih"
          maxLength={200}
          className={cn(
            'rounded-md border border-border bg-surface px-3 py-1.5 pr-7',
            'text-xs text-text-primary placeholder:text-text-secondary',
            'focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent/60',
            'disabled:opacity-40 disabled:cursor-not-allowed',
            'transition-micro w-48'
          )}
        />
        {momentTheme && (
          <button
            type="button"
            onClick={() => setMomentTheme('')}
            aria-label="Hapus tema"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-text-secondary hover:text-text-primary transition-micro"
          >
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        )}
      </div>

      <button
        type="button"
        disabled={analyzing || !transcript}
        onClick={() => void handleRunAnalysis()}
        title={!transcript ? 'Transcribe first before analyzing' : momentTheme.trim() ? `Cari momen: "${momentTheme.trim()}"` : 'Cari semua momen menarik'}
        className={cn(
          'flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5',
          'text-xs font-medium text-text-secondary',
          'hover:border-accent/40 hover:text-text-primary transition-micro',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          'disabled:opacity-40 disabled:cursor-not-allowed'
        )}
      >
        {analyzing ? (
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-border border-t-accent" />
        ) : (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            aria-hidden="true">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
        )}
        {analyzing ? 'Analyzing…' : 'Run Analysis'}
      </button>
      <button
        type="button"
        onClick={() =>
          electronNavigate(router, `/project/${projectId}/clips`, {
            key: 'pendingProjectId',
            value: projectId,
          })
        }
        className={cn(
          'flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5',
          'text-xs font-medium text-text-secondary',
          'hover:border-accent/40 hover:text-text-primary transition-micro',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'
        )}
      >
        Export Queue →
      </button>
    </div>
  );

  return (
    <>
      <AppShell title={project.title} actions={actions}>
        {/* 3-column grid — fills the remaining vertical space */}
        <div className="grid h-full grid-cols-[280px_1fr_260px] overflow-hidden">
          <TranscriptPanel
            projectId={projectId}
            transcript={transcript}
            projectDurationMs={project.durationMs}
            onPipelineDone={refresh}
          />

          <HookListPanel
            hooks={activeHooks.length > 0 ? activeHooks : hooks}
            projectId={projectId}
            projectDurationMs={project.durationMs}
            selectedHookId={selectedHookId}
            analyzing={analyzing}
            ollamaError={ollamaError}
            onHookSelected={(id) => void handleHookSelected(id)}
            onHookDismissed={handleHookDismissed}
            onRefresh={refresh}
          />

          <ClipPreviewPanel
            clip={currentClip}
            hookId={selectedHookId}
            defaultSettings={DEFAULT_SETTINGS}
            words={transcript?.words}
            hookStartMs={selectedHook?.startMs}
            hookEndMs={selectedHook?.endMs}
          />
        </div>
      </AppShell>

      <Toast toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
