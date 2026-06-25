'use client';

/**
 * AppShell — root layout grid.
 * Grid: [240px sidebar | 1fr main]
 * Main column: [TopBar row | scrollable content row]
 * Requirements: 1.6, 10.6
 */

import { Sidebar } from './Sidebar';

interface AppShellProps {
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}

export function AppShell({ title, actions, children }: AppShellProps) {
  return (
    <div className="grid h-screen grid-cols-[240px_1fr] overflow-hidden bg-background">
      {/* ── Left column: persistent sidebar ── */}
      <Sidebar />

      {/* ── Right column: top bar + scrollable content ── */}
      <div className="flex flex-col overflow-hidden">
        {/* Inline TopBar to avoid circular import; keep it lightweight */}
        <header
          className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-surface px-6"
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

        {/* Scrollable page content */}
        <main className="flex-1 overflow-y-auto" id="main-content">
          {children}
        </main>
      </div>
    </div>
  );
}
