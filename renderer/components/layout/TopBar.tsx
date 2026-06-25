'use client';

/**
 * TopBar — page title bar for the Electron frameless window.
 * Requirements: 1.4, 1.8
 */

import { cn } from '../../lib/utils';

interface TopBarProps {
  title: string;
  /** Optional action buttons / content rendered on the right side. */
  actions?: React.ReactNode;
}

export function TopBar({ title, actions }: TopBarProps) {
  return (
    <header
      className={cn(
        'flex h-14 items-center justify-between border-b border-border bg-surface px-6',
        // Make the bar draggable for the Electron frameless window;
        // interactive children must opt-out with [style=-webkit-app-region:no-drag]
        '[app-region:drag]'
      )}
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <h1
        className="text-sm font-semibold text-text-primary"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        {title}
      </h1>

      {actions && (
        <div
          className="flex items-center gap-2"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          {actions}
        </div>
      )}
    </header>
  );
}
