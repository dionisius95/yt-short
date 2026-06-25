'use client';

/**
 * Sidebar — vertical navigation with active-route highlighting.
 * Requirements: 1.1, 1.2, 1.3, 1.5, 1.7
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '../../lib/utils';

// ---------------------------------------------------------------------------
// Nav items
// ---------------------------------------------------------------------------

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
  ariaLabel: string;
}

function HomeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
      <polyline points="9 22 9 12 15 12 15 22"/>
    </svg>
  );
}

function ImportIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="17 8 12 3 7 8"/>
      <line x1="12" y1="3" x2="12" y2="15"/>
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
      <circle cx="12" cy="12" r="3"/>
    </svg>
  );
}

const NAV_ITEMS: NavItem[] = [
  { href: '/',         label: 'Dashboard', icon: <HomeIcon />,     ariaLabel: 'Navigate to Dashboard' },
  { href: '/import',   label: 'Import',    icon: <ImportIcon />,   ariaLabel: 'Navigate to Import' },
  { href: '/settings', label: 'Settings',  icon: <SettingsIcon />, ariaLabel: 'Navigate to Settings' },
];

// ---------------------------------------------------------------------------
// Logo / Wordmark
// ---------------------------------------------------------------------------

function Wordmark() {
  return (
    <div className="px-5 py-5 border-b border-border">
      <div className="flex items-center gap-2.5">
        {/* Gradient logo mark */}
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-gradient-to-br from-accent to-[#8B5CF6] shadow-lg">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"
            className="text-white" aria-hidden="true">
            <polygon points="5 3 19 12 5 21 5 3"/>
          </svg>
        </div>
        <div className="flex flex-col leading-none">
          <span className="text-xs font-semibold text-text-primary tracking-wide">AI Shorts</span>
          <span className="text-[10px] text-text-secondary">Generator</span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar component
// ---------------------------------------------------------------------------

export function Sidebar() {
  const pathname = usePathname();

  const isActive = (href: string) => {
    if (href === '/') return pathname === '/';
    return pathname.startsWith(href);
  };

  return (
    <aside
      className="flex h-full w-[240px] flex-col border-r border-border bg-surface"
      aria-label="Primary navigation"
    >
      <Wordmark />

      <nav className="flex-1 overflow-y-auto px-3 py-4" aria-label="Main menu">
        <ul role="list" className="flex flex-col gap-1">
          {NAV_ITEMS.map((item) => {
            const active = isActive(item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-label={item.ariaLabel}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium',
                    'transition-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                    active
                      ? 'border-l-2 border-accent bg-accent/10 text-accent pl-[10px]'
                      : 'border-l-2 border-transparent text-text-secondary hover:bg-accent/5 hover:text-text-primary pl-[10px]'
                  )}
                >
                  {item.icon}
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Version footer */}
      <div className="border-t border-border px-5 py-3">
        <p className="text-[10px] text-text-secondary">v0.1.0 — alpha</p>
      </div>
    </aside>
  );
}
