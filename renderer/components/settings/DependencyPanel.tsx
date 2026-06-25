'use client';

/**
 * DependencyPanel — shows detection status of all 5 required tools.
 * Requirements: 8.7–8.11
 */

import { useState } from 'react';
import { ipc } from '../../lib/ipc-client';
import type { DepsCheckResult, DependencyStatus } from '../../../shared/types';
import { cn } from '../../lib/utils';

interface DependencyPanelProps {
  deps: DepsCheckResult;
  onRecheck: (result: DepsCheckResult) => void;
}

const DEP_KEYS: Array<{ key: keyof DepsCheckResult; label: string }> = [
  { key: 'ytDlp',      label: 'yt-dlp'        },
  { key: 'ffmpeg',     label: 'FFmpeg'         },
  { key: 'whisperCli', label: 'Whisper.cpp'    },
  { key: 'ollama',     label: 'Ollama'         },
  { key: 'mediaPipe',  label: 'MediaPipe'      },
];

function StatusDot({ detected }: { detected: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block h-2 w-2 rounded-full shrink-0',
        detected ? 'bg-success' : 'bg-destructive'
      )}
    />
  );
}

function DepRow({ label, status }: { label: string; status: DependencyStatus }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5 border-b border-border last:border-0">
      <div className="flex items-center gap-2.5">
        <StatusDot detected={status.detected} />
        <span className="text-sm font-medium text-text-primary">{label}</span>
      </div>
      <div className="flex items-center gap-2 text-right">
        {status.detected && status.version && (
          <span className="font-mono text-xs text-text-secondary">{status.version}</span>
        )}
        {!status.detected && (
          <span className="text-xs text-destructive">Not found</span>
        )}
      </div>
    </div>
  );
}

export function DependencyPanel({ deps, onRecheck }: DependencyPanelProps) {
  const [checking, setChecking] = useState(false);
  const missing = DEP_KEYS.filter(({ key }) => !deps[key].detected);

  const handleRecheck = async () => {
    setChecking(true);
    try {
      const result = await ipc.deps.check();
      onRecheck(result);
    } catch { /* ignore */ } finally {
      setChecking(false);
    }
  };

  return (
    <section aria-label="Dependencies" className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-text-secondary">
          Dependencies
        </h3>
        <button
          type="button"
          id="deps-recheck-btn"
          disabled={checking}
          onClick={() => void handleRecheck()}
          className={cn(
            'rounded-md border border-border px-3 py-1.5 text-xs font-medium text-text-secondary',
            'hover:border-accent/40 hover:text-text-primary transition-micro',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            'disabled:opacity-50 disabled:cursor-not-allowed'
          )}
        >
          {checking ? (
            <span className="flex items-center gap-1.5">
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-border border-t-accent" />
              Checking…
            </span>
          ) : 'Re-check'}
        </button>
      </div>

      {/* Warning banner for missing tools */}
      {missing.length > 0 && (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm"
        >
          <p className="font-medium text-destructive">Missing required tools</p>
          <p className="mt-1 text-xs text-text-secondary">
            {missing.map(({ label }) => label).join(', ')} must be installed and on your PATH.
          </p>
        </div>
      )}

      {/* Tool rows */}
      <div className="surface px-4">
        {DEP_KEYS.map(({ key, label }) => (
          <DepRow key={key} label={label} status={deps[key]} />
        ))}
      </div>
    </section>
  );
}
