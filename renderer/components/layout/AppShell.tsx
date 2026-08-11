'use client';

/**
 * AppShell — root layout grid.
 * Grid: [160px sidebar | 1fr main]
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
    <div className="grid h-screen grid-cols-[160px_1fr] overflow-hidden bg-background">
      {/* ── Left column: persistent sidebar ── */}
      <Sidebar />

      {/* ── Right column: top bar + scrollable content ── */}
      <div className="flex flex-col overflow-hidden">
        {/* Inline TopBar to avoid circular import; keep it lightweight */}
        <header
          className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-surface px-4"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          <div
            className="flex items-center gap-4"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <h1 className="text-xs font-bold text-text-primary tracking-wide">
              {title}
            </h1>

            {/* NLE Editor Top Menu Bar */}
            <div className="hidden md:flex items-center gap-2.5 text-[11px] font-medium text-text-secondary select-none border-l border-border/60 pl-3">
              <span className="hover:text-text-primary cursor-pointer transition-micro">File</span>
              <span className="hover:text-text-primary cursor-pointer transition-micro">Edit</span>
              <span className="hover:text-text-primary cursor-pointer transition-micro">Sequence</span>
              <span className="hover:text-text-primary cursor-pointer transition-micro font-semibold text-accent/90">Tracks</span>
              <span className="hover:text-text-primary cursor-pointer transition-micro">Audio</span>
              <span className="hover:text-text-primary cursor-pointer transition-micro">View</span>
              <span className="hover:text-text-primary cursor-pointer transition-micro">Window</span>
            </div>
          </div>

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
