'use client';

/**
 * Settings page — two-column: SettingsForm (left) + DependencyPanel (right).
 * Requirements: 8.1, 8.2, 8.9
 */

import { useState, useEffect, useCallback } from 'react';
import { AppShell } from '../../components/layout/AppShell';
import { SettingsForm } from '../../components/settings/SettingsForm';
import { DependencyPanel } from '../../components/settings/DependencyPanel';
import { Toast } from '../../components/ui/Toast';
import { useToast } from '../../hooks/useToast';
import { ipc } from '../../lib/ipc-client';
import { isElectron } from '../../lib/isElectron';
import type { AppSettings, DepsCheckResult } from '../../../shared/types';

// ---------------------------------------------------------------------------
// Skeleton helpers
// ---------------------------------------------------------------------------

function FormSkeleton() {
  return (
    <div className="flex flex-col gap-6 animate-pulse">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex flex-col gap-3">
          <div className="h-3 w-24 rounded bg-border" />
          <div className="h-10 w-full rounded-md bg-border" />
        </div>
      ))}
    </div>
  );
}

function DepSkeleton() {
  return (
    <div className="surface flex flex-col gap-0 animate-pulse px-4">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center justify-between py-2.5 border-b border-border last:border-0">
          <div className="flex items-center gap-2.5">
            <div className="h-2 w-2 rounded-full bg-border" />
            <div className="h-4 w-20 rounded bg-border" />
          </div>
          <div className="h-3 w-10 rounded bg-border" />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function SettingsPage() {
  const { toasts, showToast, dismissToast } = useToast();

  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [deps, setDeps] = useState<DepsCheckResult | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!isElectron()) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [s, d] = await Promise.all([
        ipc.settings.get(),
        ipc.deps.check(),
      ]);
      setSettings(s);
      setDeps(d);
    } catch {
      showToast('Failed to load settings.', 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <>
      <AppShell title="Settings">
        <div className="px-8 py-8">
          <div className="grid grid-cols-[1fr_320px] gap-10">
            {/* Left — settings form */}
            <div>
              {loading || !settings
                ? <FormSkeleton />
                : (
                  <SettingsForm
                    settings={settings}
                    onSaved={() => showToast('Settings saved.', 'success')}
                    onError={(msg) => showToast(msg, 'error')}
                  />
                )
              }
            </div>

            {/* Right — dependency panel */}
            <div className="flex flex-col gap-6">
              {loading || !deps
                ? <DepSkeleton />
                : (
                  <DependencyPanel
                    deps={deps}
                    onRecheck={(result) => {
                      setDeps(result);
                      showToast('Dependency check complete.', 'success');
                    }}
                  />
                )
              }
            </div>
          </div>
        </div>
      </AppShell>

      <Toast toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
