'use client';

/**
 * HookCard — displays a single viral hook with scrubber, scores, and actions.
 * Requirements: 5.2–5.6
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { TimelineScrubber } from './TimelineScrubber';
import { ipc } from '../../lib/ipc-client';
import { formatMs } from '../../lib/formatters';
import { electronNavigate } from '../../lib/isElectron';
import type { Hook } from '../../../shared/types';
import { cn } from '../../lib/utils';

interface HookCardProps {
  hook: Hook;
  projectDurationMs: number;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onDismissed: (id: string) => void;
}

export function HookCard({ hook, projectDurationMs, isSelected, onSelect, onDismissed }: HookCardProps) {
  const router = useRouter();
  const [startMs, setStartMs] = useState(hook.startMs);
  const [endMs, setEndMs] = useState(hook.endMs);
  const [generating, setGenerating] = useState(false);

  const durationSec = Math.round((endMs - startMs) / 1000);

  // Viral score color
  const scoreColor =
    hook.viralScore >= 80 ? 'text-success' :
    hook.viralScore >= 50 ? 'text-accent' :
    'text-text-secondary';

  const handleDismiss = async () => {
    try {
      await ipc.hooks.dismiss(hook.id);
      onDismissed(hook.id);
    } catch { /* ignore */ }
  };

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      await ipc.clips.generate(hook.id, {});
      electronNavigate(router, `/project/${hook.projectId}/clips`, {
        key: 'pendingProjectId',
        value: hook.projectId,
      });
    } catch {
      setGenerating(false);
    }
  };

  const handleScrubCommitted = async (newStart: number, newEnd: number) => {
    setStartMs(newStart);
    setEndMs(newEnd);
    try {
      await ipc.hooks.update({ id: hook.id, startMs: newStart, endMs: newEnd });
    } catch { /* ignore */ }
  };

  return (
    <div
      role="article"
      aria-label={`Hook: ${hook.summary}`}
      onClick={() => onSelect(hook.id)}
      className={cn(
        'surface flex cursor-pointer flex-col gap-3 p-4 transition-micro',
        'hover:border-accent/40',
        isSelected && 'border-accent/60 accent-glow',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'
      )}
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onSelect(hook.id); }}
    >
      {/* Header: score + timecodes */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1">
          <p className="text-sm leading-snug text-text-primary line-clamp-2">
            {hook.summary}
          </p>
        </div>
        <div className="flex flex-col items-end gap-0.5 shrink-0">
          <span className={cn('text-lg font-bold leading-none', scoreColor)}>
            {hook.viralScore}
          </span>
          <span className="text-[9px] text-text-secondary uppercase tracking-wide">viral</span>
        </div>
      </div>

      {/* Timecodes */}
      <div className="flex items-center gap-3 font-mono text-xs text-text-secondary">
        <span>▶ {formatMs(startMs)}</span>
        <span className="text-border">—</span>
        <span>⏹ {formatMs(endMs)}</span>
        <span className="ml-auto text-accent">{durationSec}s</span>
      </div>

      {/* Timeline scrubber */}
      <div onClick={(e) => e.stopPropagation()}>
        <TimelineScrubber
          durationMs={projectDurationMs}
          startMs={startMs}
          endMs={endMs}
          onChange={(s, e) => { setStartMs(s); setEndMs(e); }}
          onChangeCommitted={(s, e) => void handleScrubCommitted(s, e)}
        />
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          id={`generate-clip-${hook.id}`}
          disabled={generating}
          onClick={() => void handleGenerate()}
          aria-label="Generate clip from this hook"
          className={cn(
            'flex flex-1 items-center justify-center gap-1.5 rounded-md bg-accent px-3 py-1.5',
            'text-xs font-medium text-accent-foreground',
            'hover:bg-accent-hover transition-micro',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            'disabled:opacity-50 disabled:cursor-not-allowed'
          )}
        >
          {generating ? (
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          ) : (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
          )}
          {generating ? 'Generating…' : 'Generate Clip'}
        </button>

        <button
          type="button"
          id={`dismiss-hook-${hook.id}`}
          onClick={() => void handleDismiss()}
          aria-label="Dismiss this hook"
          className={cn(
            'rounded-md border border-border px-3 py-1.5 text-xs font-medium text-text-secondary',
            'hover:border-destructive/60 hover:text-destructive transition-micro',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'
          )}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
