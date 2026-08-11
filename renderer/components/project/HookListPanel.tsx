'use client';

/**
 * HookListPanel — sorted list of hooks with bulk generate, loading, empty, error states.
 * Requirements: 5.1, 5.7–5.10
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { HookCard } from './HookCard';
import { ipc } from '../../lib/ipc-client';
import { electronNavigate } from '../../lib/isElectron';
import type { Hook } from '../../../shared/types';
import { cn } from '../../lib/utils';

interface HookListPanelProps {
  hooks: Hook[];
  projectId: string;
  projectDurationMs: number;
  selectedHookId: string | null;
  analyzing: boolean;
  ollamaError: boolean;
  onHookSelected: (id: string) => void;
  onHookDismissed: (id: string) => void;
  onRefresh: () => void;
}

export function HookListPanel({
  hooks,
  projectId,
  projectDurationMs,
  selectedHookId,
  analyzing,
  ollamaError,
  onHookSelected,
  onHookDismissed,
  onRefresh,
}: HookListPanelProps) {
  const router = useRouter();
  const [generatingAll, setGeneratingAll] = useState(false);

  // Filter dismissed and sort by viralScore descending, prioritizing Full video clip to the very top
  const visible = hooks
    .filter((h) => !h.dismissed)
    .sort((a, b) => {
      const aIsFull = a.summary === 'Full video clip' || (a.startMs === 0 && a.endMs === projectDurationMs);
      const bIsFull = b.summary === 'Full video clip' || (b.startMs === 0 && b.endMs === projectDurationMs);
      if (aIsFull && !bIsFull) return -1;
      if (!aIsFull && bIsFull) return 1;
      return b.viralScore - a.viralScore;
    });


  const handleGenerateAll = async () => {
    setGeneratingAll(true);
    try {
      await Promise.all(visible.map((h) => ipc.clips.generate(h.id, {})));
      electronNavigate(router, `/project/${projectId}/clips`, {
        key: 'pendingProjectId',
        value: projectId,
      });
    } catch {
      setGeneratingAll(false);
    }
  };

  return (
    <section
      aria-label="Viral hooks"
      className="flex h-full flex-col overflow-hidden border-r border-border"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-text-secondary">
          Timeline Sequences & Cuts
        </h2>
        {visible.length > 0 && (
          <span className="text-[10px] font-mono text-text-secondary">
            {visible.length} sequences
          </span>
        )}
      </div>

      {/* Body */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Analyzing spinner */}
        {analyzing && (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
            <span className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-accent" />
            <p className="text-sm text-text-secondary animate-pulse">
              Analyzing transcript for hooks…
            </p>
          </div>
        )}

        {/* Ollama error */}
        {!analyzing && ollamaError && (
          <div className="m-4 rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm">
            <p className="font-medium text-destructive">Ollama is not running</p>
            <p className="mt-1 text-text-secondary text-xs">
              Start Ollama and ensure a model is loaded, then retry.
            </p>
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={onRefresh}
                className={cn(
                  'rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground',
                  'hover:bg-accent-hover transition-micro',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'
                )}
              >
                Retry
              </button>
              <Link
                href="/settings"
                className="text-xs text-text-secondary underline underline-offset-2 hover:text-text-primary"
              >
                Open Settings →
              </Link>
            </div>
          </div>
        )}

        {/* Empty state — no hooks at all */}
        {!analyzing && !ollamaError && visible.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
            <p className="text-sm font-medium text-text-primary">No hooks detected</p>
            <p className="text-xs text-text-secondary">Try re-running analysis after transcription.</p>
            <button
              type="button"
              onClick={onRefresh}
              className={cn(
                'mt-2 rounded-md border border-border px-3 py-1.5 text-xs text-text-secondary',
                'hover:text-text-primary hover:border-accent/40 transition-micro',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'
              )}
            >
              Re-run Analysis
            </button>
          </div>
        )}

        {/* Hook list */}
        {!analyzing && !ollamaError && visible.length > 0 && (
          <>
            {/* Generate All button */}
            <div className="border-b border-border px-4 py-2.5">
              <button
                type="button"
                id="generate-all-clips-btn"
                disabled={generatingAll}
                onClick={() => void handleGenerateAll()}
                className={cn(
                  'w-full rounded-md bg-accent/10 border border-accent/20 px-3 py-2',
                  'text-xs font-medium text-accent',
                  'hover:bg-accent/20 transition-micro',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                  'disabled:opacity-50 disabled:cursor-not-allowed'
                )}
              >
                {generatingAll ? 'Generating all clips…' : `Generate All ${visible.length} Clips`}
              </button>
            </div>

            {/* Cards */}
            <div className="flex-1 overflow-y-auto flex flex-col gap-3 p-4">
              {visible.map((hook) => (
                <HookCard
                  key={hook.id}
                  hook={hook}
                  projectDurationMs={projectDurationMs}
                  isSelected={selectedHookId === hook.id}
                  onSelect={onHookSelected}
                  onDismissed={onHookDismissed}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
