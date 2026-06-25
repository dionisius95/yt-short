'use client';

/**
 * ProgressBar — accessible filled-bar progress indicator.
 * Requirements: 3.7, 7.4, 9.3
 *
 * When `indeterminate` is true (or value === 0 and loading), shows an
 * animated shimmer so the bar never appears frozen.
 */

import { cn } from '../../lib/utils';

interface ProgressBarProps {
  /** Current progress value, 0–100. */
  value: number;
  className?: string;
  /** Optional label shown to the right of the bar. */
  label?: string;
  /**
   * When true the bar shows a looping shimmer animation instead of a
   * static fill — useful while waiting for the first real progress tick.
   */
  indeterminate?: boolean;
}

export function ProgressBar({ value, className, label, indeterminate }: ProgressBarProps) {
  const clamped = Math.min(100, Math.max(0, value));
  const showShimmer = indeterminate || clamped === 0;

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div
        role="progressbar"
        aria-valuenow={showShimmer ? undefined : clamped}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label ?? `${clamped}% complete`}
        className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-border"
      >
        {showShimmer ? (
          /* Indeterminate shimmer — looping slide animation */
          <div
            className="absolute inset-y-0 w-1/3 rounded-full bg-accent/70"
            style={{
              animation: 'progress-shimmer 1.6s ease-in-out infinite',
            }}
          />
        ) : (
          <div
            className="h-full rounded-full bg-accent transition-all duration-500 ease-out"
            style={{ width: `${clamped}%` }}
          />
        )}
      </div>
      {label !== undefined && (
        <span className="shrink-0 text-xs font-mono text-text-secondary">
          {label}
        </span>
      )}
    </div>
  );
}
