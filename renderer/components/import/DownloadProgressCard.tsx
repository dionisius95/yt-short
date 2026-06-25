'use client';

/**
 * DownloadProgressCard — shows live download progress with cancel button.
 * Requirements: 3.7, 3.8, 3.9
 */

import { ProgressBar } from '../ui/ProgressBar';
import type { DownloadProgress } from '../../../shared/types';
import { cn } from '../../lib/utils';

interface DownloadProgressCardProps {
  progress: DownloadProgress;
  onCancel: () => void;
}

export function DownloadProgressCard({ progress, onCancel }: DownloadProgressCardProps) {
  const { percent, speed, eta } = progress;

  return (
    <div
      className="surface flex flex-col gap-4 p-5"
      role="region"
      aria-label="Download progress"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-text-primary">Downloading…</h3>
        <span className="font-mono text-sm font-medium text-accent">
          {Math.round(percent)}%
        </span>
      </div>

      <ProgressBar
        value={percent}
        label={`${Math.round(percent)}%`}
      />

      <div className="flex items-center justify-between text-xs text-text-secondary font-mono">
        <span aria-label={`Speed: ${speed}`}>⚡ {speed}</span>
        <span aria-label={`ETA: ${eta}`}>⏱ {eta}</span>
      </div>

      <button
        type="button"
        id="download-cancel-btn"
        onClick={onCancel}
        className={cn(
          'self-end rounded-md border border-border px-3 py-1.5',
          'text-xs font-medium text-text-secondary',
          'hover:border-destructive/60 hover:text-destructive transition-micro',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'
        )}
      >
        Cancel Download
      </button>
    </div>
  );
}
