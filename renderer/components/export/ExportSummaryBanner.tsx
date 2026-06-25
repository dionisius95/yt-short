'use client';

/**
 * ExportSummaryBanner — shown when all clips reach a terminal state.
 * Requirements: 7.12
 */

import type { Clip } from '../../../shared/types';
import { cn } from '../../lib/utils';

interface ExportSummaryBannerProps {
  clips: Clip[];
}

export function ExportSummaryBanner({ clips }: ExportSummaryBannerProps) {
  const complete = clips.filter((c) => c.status === 'complete').length;
  const failed   = clips.filter((c) => c.status === 'failed').length;

  const allTerminal = clips.length > 0 &&
    clips.every((c) => c.status === 'complete' || c.status === 'failed');

  if (!allTerminal) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'flex items-center justify-center gap-4 rounded-md border px-5 py-4 text-sm font-medium',
        failed > 0
          ? 'border-destructive/30 bg-destructive/10 text-destructive'
          : 'border-success/30 bg-success/10 text-success'
      )}
    >
      <span>✓ {complete} complete</span>
      {failed > 0 && <span>· ✕ {failed} failed</span>}
    </div>
  );
}
