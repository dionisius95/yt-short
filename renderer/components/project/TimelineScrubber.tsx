'use client';

/**
 * TimelineScrubber — dual-handle range slider for hook start/end times.
 * Supports drag handles AND direct time input (click label to type MM:SS or M:SS).
 * Requirements: 5.5, 5.6
 */

import { useRef, useCallback, useState } from 'react';
import { formatMs } from '../../lib/formatters';
import { cn } from '../../lib/utils';

interface TimelineScrubberProps {
  durationMs: number;
  startMs: number;
  endMs: number;
  /** Called on every pointer move (preview only). */
  onChange: (startMs: number, endMs: number) => void;
  /** Called on pointer-up or input commit (fires IPC). */
  onChangeCommitted: (startMs: number, endMs: number) => void;
}

type Handle = 'start' | 'end';

const MIN_DURATION_MS = 1000; // 1 s minimum clip

// ---------------------------------------------------------------------------
// Parse "M:SS", "MM:SS", "M:SS.s", "SS" → milliseconds
// Returns null if unparseable.
// ---------------------------------------------------------------------------
function parseTimeInput(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;

  // MM:SS or M:SS or MM:SS.s
  const colonMatch = s.match(/^(\d{1,2}):(\d{2})(\.\d+)?$/);
  if (colonMatch) {
    const mins = parseInt(colonMatch[1], 10);
    const secs = parseFloat(colonMatch[2] + (colonMatch[3] ?? ''));
    if (secs >= 60) return null;
    return Math.round((mins * 60 + secs) * 1000);
  }

  // Plain seconds e.g. "90" or "90.5"
  const secMatch = s.match(/^(\d+)(\.\d+)?$/);
  if (secMatch) {
    return Math.round(parseFloat(s) * 1000);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Inline time input — shown when user clicks a time label
// ---------------------------------------------------------------------------
function TimeInput({
  valueMs,
  onCommit,
  onCancel,
}: {
  valueMs: number;
  onCommit: (ms: number) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(formatMs(valueMs));
  const inputRef = useRef<HTMLInputElement>(null);

  const commit = () => {
    const parsed = parseTimeInput(draft);
    if (parsed !== null) {
      onCommit(parsed);
    } else {
      onCancel();
    }
  };

  return (
    <input
      ref={inputRef}
      autoFocus
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
      }}
      onClick={(e) => e.stopPropagation()}
      placeholder="M:SS"
      aria-label="Enter time"
      className={cn(
        'w-14 rounded border border-accent bg-surface px-1 py-0 text-center',
        'font-mono text-[10px] text-accent',
        'focus:outline-none focus:ring-1 focus:ring-accent',
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export function TimelineScrubber({
  durationMs,
  startMs,
  endMs,
  onChange,
  onChangeCommitted,
}: TimelineScrubberProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingHandle = useRef<Handle | null>(null);

  // Which label is being edited inline
  const [editingHandle, setEditingHandle] = useState<Handle | null>(null);

  const pct = (ms: number) => (ms / durationMs) * 100;

  // Convert pointer X → ms
  const xToMs = useCallback(
    (clientX: number): number => {
      const track = trackRef.current;
      if (!track) return 0;
      const { left, width } = track.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - left) / width));
      return Math.round(ratio * durationMs);
    },
    [durationMs]
  );

  const handlePointerDown = (handle: Handle) => (e: React.PointerEvent) => {
    e.preventDefault();
    draggingHandle.current = handle;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!draggingHandle.current) return;
    const ms = xToMs(e.clientX);
    if (draggingHandle.current === 'start') {
      const newStart = Math.min(ms, endMs - MIN_DURATION_MS);
      onChange(Math.max(0, newStart), endMs);
    } else {
      const newEnd = Math.max(ms, startMs + MIN_DURATION_MS);
      onChange(startMs, Math.min(durationMs, newEnd));
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (!draggingHandle.current) return;
    const ms = xToMs(e.clientX);
    if (draggingHandle.current === 'start') {
      const newStart = Math.max(0, Math.min(ms, endMs - MIN_DURATION_MS));
      onChangeCommitted(newStart, endMs);
    } else {
      const newEnd = Math.min(durationMs, Math.max(ms, startMs + MIN_DURATION_MS));
      onChangeCommitted(startMs, newEnd);
    }
    draggingHandle.current = null;
  };

  // Keyboard: arrow keys adjust by 1 s
  const handleKeyDown = (handle: Handle) => (e: React.KeyboardEvent) => {
    const STEP = 1000;
    if (handle === 'start') {
      if (e.key === 'ArrowLeft')  { e.preventDefault(); onChangeCommitted(Math.max(0, startMs - STEP), endMs); }
      if (e.key === 'ArrowRight') { e.preventDefault(); onChangeCommitted(Math.min(startMs + STEP, endMs - MIN_DURATION_MS), endMs); }
    } else {
      if (e.key === 'ArrowLeft')  { e.preventDefault(); onChangeCommitted(startMs, Math.max(endMs - STEP, startMs + MIN_DURATION_MS)); }
      if (e.key === 'ArrowRight') { e.preventDefault(); onChangeCommitted(startMs, Math.min(endMs + STEP, durationMs)); }
    }
  };

  // Commit from inline input
  const commitInput = (handle: Handle, rawMs: number) => {
    setEditingHandle(null);
    if (handle === 'start') {
      const clamped = Math.max(0, Math.min(rawMs, endMs - MIN_DURATION_MS));
      onChangeCommitted(clamped, endMs);
    } else {
      const clamped = Math.min(durationMs, Math.max(rawMs, startMs + MIN_DURATION_MS));
      onChangeCommitted(startMs, clamped);
    }
  };

  const startPct = pct(startMs);
  const endPct   = pct(endMs);
  const durationSec = Math.round((endMs - startMs) / 1000);

  return (
    <div className="flex flex-col gap-1.5 select-none" aria-label="Timeline scrubber">
      {/* Track */}
      <div
        ref={trackRef}
        className="relative h-5 cursor-crosshair"
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        {/* Full track */}
        <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-border" />

        {/* Selected range */}
        <div
          className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-accent/60"
          style={{ left: `${startPct}%`, width: `${endPct - startPct}%` }}
        />

        {/* Start handle */}
        <div
          role="slider"
          aria-label="Start time"
          aria-valuemin={0}
          aria-valuemax={durationMs}
          aria-valuenow={startMs}
          tabIndex={0}
          onPointerDown={handlePointerDown('start')}
          onKeyDown={handleKeyDown('start')}
          className={cn(
            'absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full',
            'border-2 border-accent bg-surface shadow-md',
            'hover:border-accent-hover active:cursor-grabbing',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'
          )}
          style={{ left: `${startPct}%` }}
        />

        {/* End handle */}
        <div
          role="slider"
          aria-label="End time"
          aria-valuemin={0}
          aria-valuemax={durationMs}
          aria-valuenow={endMs}
          tabIndex={0}
          onPointerDown={handlePointerDown('end')}
          onKeyDown={handleKeyDown('end')}
          className={cn(
            'absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full',
            'border-2 border-accent bg-surface shadow-md',
            'hover:border-accent-hover active:cursor-grabbing',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'
          )}
          style={{ left: `${endPct}%` }}
        />
      </div>

      {/* Time labels — click to edit inline */}
      <div className="flex items-center justify-between text-[10px] font-mono text-text-secondary">
        {/* Start time */}
        {editingHandle === 'start' ? (
          <TimeInput
            valueMs={startMs}
            onCommit={(ms) => commitInput('start', ms)}
            onCancel={() => setEditingHandle(null)}
          />
        ) : (
          <button
            type="button"
            title="Click to edit start time"
            onClick={() => setEditingHandle('start')}
            className={cn(
              'rounded px-1 py-0.5 font-mono text-[10px]',
              'hover:bg-accent/10 hover:text-accent transition-micro',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
              'cursor-text'
            )}
          >
            {formatMs(startMs)}
          </button>
        )}

        {/* Duration — click to edit end time via duration */}
        <span className="text-accent">{durationSec}s</span>

        {/* End time */}
        {editingHandle === 'end' ? (
          <TimeInput
            valueMs={endMs}
            onCommit={(ms) => commitInput('end', ms)}
            onCancel={() => setEditingHandle(null)}
          />
        ) : (
          <button
            type="button"
            title="Click to edit end time"
            onClick={() => setEditingHandle('end')}
            className={cn(
              'rounded px-1 py-0.5 font-mono text-[10px]',
              'hover:bg-accent/10 hover:text-accent transition-micro',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
              'cursor-text'
            )}
          >
            {formatMs(endMs)}
          </button>
        )}
      </div>

      {/* Hint text */}
      <p className="text-[9px] text-text-secondary opacity-60 text-center">
        drag handles or click time to edit (M:SS)
      </p>
    </div>
  );
}
