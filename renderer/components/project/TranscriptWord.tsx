'use client';

/**
 * TranscriptWord — editable word span with confidence-based styling.
 * Requirements: 4.2–4.6
 *
 * NOTE: Word-level editing is a local UI concern only. The edited text is
 * surfaced via `onUpdated` so the parent can persist it (e.g. by re-serialising
 * the full transcript). No IPC call is made here — the parent is responsible
 * for deciding how/when to persist changes.
 */

import { useState, useRef } from 'react';
import type { TranscriptWord as TWord } from '../../../shared/types';
import { cn } from '../../lib/utils';

interface TranscriptWordProps {
  word: TWord;
  onUpdated?: (newText: string) => void;
}

export function TranscriptWordSpan({ word, onUpdated }: TranscriptWordProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(word.word);
  const inputRef = useRef<HTMLInputElement>(null);

  const isLowConfidence = word.confidence < 0.6;

  const startEdit = () => {
    setDraft(word.word);
    setEditing(true);
    // Focus the input after the next paint
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const confirm = () => {
    setEditing(false);
    if (draft !== word.word) {
      onUpdated?.(draft);
    }
  };

  const cancel = () => {
    setDraft(word.word);
    setEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); confirm(); }
    if (e.key === 'Escape') { cancel(); }
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => confirm()}
        onKeyDown={handleKeyDown}
        aria-label={`Edit word: ${word.word}`}
        className={cn(
          'inline-block rounded border border-accent bg-accent/10 px-1 py-0 text-sm',
          'font-mono text-text-primary focus:outline-none',
          // width roughly matches the word
          'min-w-[2ch] max-w-[20ch]'
        )}
        style={{ width: `${Math.max(3, draft.length + 1)}ch` }}
      />
    );
  }

  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={`Word: ${word.word}${isLowConfidence ? ' (low confidence)' : ''}`}
      onDoubleClick={startEdit}
      onKeyDown={(e) => { if (e.key === 'Enter') startEdit(); }}
      title={isLowConfidence ? `Low confidence: ${(word.confidence * 100).toFixed(0)}%` : undefined}
      className={cn(
        'inline cursor-text select-text rounded px-0.5 text-sm leading-relaxed',
        'transition-micro hover:bg-accent/10',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
        isLowConfidence
          ? 'italic text-text-secondary'
          : 'text-text-primary'
      )}
    >
      {word.word}{' '}
    </span>
  );
}
