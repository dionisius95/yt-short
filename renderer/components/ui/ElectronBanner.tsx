'use client';

/**
 * ElectronBanner — shows a non-intrusive notice when running in a plain browser
 * (outside Electron). Disappears automatically when the app is inside Electron.
 */

import { useState, useEffect } from 'react';
import { isElectron } from '../../lib/isElectron';

export function ElectronBanner() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    // Only show after client hydration
    if (!isElectron()) setShow(true);
  }, []);

  if (!show) return null;

  return (
    <div
      role="status"
      className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 animate-fade-in"
    >
      <div className="flex items-center gap-3 rounded-lg border border-accent/30 bg-surface px-4 py-2.5 shadow-lg backdrop-blur-sm">
        <span className="h-2 w-2 rounded-full bg-accent animate-pulse" aria-hidden="true" />
        <p className="text-xs text-text-secondary">
          Browser preview mode — IPC unavailable.{' '}
          <span className="font-medium text-text-primary">Run via Electron for full functionality.</span>
        </p>
        <button
          type="button"
          aria-label="Dismiss preview notice"
          onClick={() => setShow(false)}
          className="ml-1 text-text-secondary hover:text-text-primary transition-micro text-xs"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
