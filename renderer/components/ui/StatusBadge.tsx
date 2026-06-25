'use client';

/**
 * StatusBadge — displays a coloured pill label for pipeline statuses.
 * Requirements: 2.6, 7.3, 12.5
 */

import { cn } from '../../lib/utils';

export type BadgeVariant =
  | 'complete'
  | 'failed'
  | 'processing'
  | 'pending'
  | 'uploading'
  | 'idle';

interface StatusBadgeProps {
  variant: BadgeVariant;
  /** Override the default label. */
  label?: string;
  className?: string;
}

const VARIANT_CONFIG: Record<
  BadgeVariant,
  { label: string; classes: string }
> = {
  complete:   { label: 'Complete',   classes: 'bg-success/15 text-success border-success/30' },
  failed:     { label: 'Failed',     classes: 'bg-destructive/15 text-destructive border-destructive/30' },
  processing: { label: 'Processing', classes: 'bg-accent/15 text-accent border-accent/30' },
  uploading:  { label: 'Uploading',  classes: 'bg-accent/15 text-accent border-accent/30' },
  pending:    { label: 'Pending',    classes: 'bg-[#888888]/15 text-[#888888] border-[#888888]/30' },
  idle:       { label: 'Idle',       classes: 'bg-[#888888]/15 text-[#888888] border-[#888888]/30' },
};

export function StatusBadge({ variant, label, className }: StatusBadgeProps) {
  const config = VARIANT_CONFIG[variant];
  const displayLabel = label ?? config.label;

  return (
    <span
      role="status"
      aria-label={`Status: ${displayLabel}`}
      className={cn(
        'inline-flex items-center rounded-sm border px-2 py-0.5',
        'text-xs font-medium leading-none',
        config.classes,
        className
      )}
    >
      {displayLabel}
    </span>
  );
}
