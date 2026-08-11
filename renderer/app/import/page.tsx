'use client';

/**
 * Import page — wires ImportForm + DownloadProgressCard with IPC.
 * Requirements: 3.6, 3.8, 3.10, 3.11, 9.1
 */

import { useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AppShell } from '../../components/layout/AppShell';
import { ImportForm, type VideoQuality } from '../../components/import/ImportForm';
import { DownloadProgressCard } from '../../components/import/DownloadProgressCard';
import { Toast } from '../../components/ui/Toast';
import { useToast } from '../../hooks/useToast';
import { useIpcEvent } from '../../hooks/useIpcEvent';
import { ipc } from '../../lib/ipc-client';
import type { DownloadProgress } from '../../../shared/types';

// ---------------------------------------------------------------------------
// Inner component (needs Suspense for useSearchParams)
// ---------------------------------------------------------------------------

function ImportPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialUrl = searchParams.get('url') ?? '';
  const { toasts, dismissToast } = useToast();

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Subscribe to download progress events for the active download
  useIpcEvent<DownloadProgress>('download:progress', (data) => {
    if (currentProjectId && data.projectId !== currentProjectId) return;
    setProgress(data);

    // Navigate to project view when download completes (100%)
    if (data.percent >= 100) {
      setIsSubmitting(false);
      const projectId = data.projectId;
      // In Electron production (app:// protocol) the static export only has
      // /project/_/index.html as a shell. Store the real id in sessionStorage
      // so the project page can read it via useParams fallback.
      if (typeof window !== 'undefined' && window.location.protocol === 'app:') {
        sessionStorage.setItem('pendingProjectId', projectId);
        window.location.href = '/project/_/index.html';
      } else {
        router.push(`/project/${projectId}`);
      }
    }
  }, [currentProjectId]);

  const handleSubmit = async (url: string, quality: VideoQuality) => {
    setIsSubmitting(true);
    setError(null);
    setProgress(null);

    try {
      const { projectId } = await ipc.download.start({
        url,
        quality,
        outputDir: '', // main process resolves from settings
      });
      setCurrentProjectId(projectId);
    } catch (err) {
      setIsSubmitting(false);
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg.includes('INVALID_URL')
        ? 'Invalid YouTube URL. Please check the link and try again.'
        : msg.includes('DEPENDENCY_MISSING')
        ? 'A required tool (yt-dlp) is missing. Check Settings → Dependencies.'
        : `Download failed: ${msg}`
      );
    }
  };

  const handleLocalImport = async (filePath: string, quality: VideoQuality) => {
    setIsSubmitting(true);
    setError(null);
    setProgress(null);

    try {
      const { projectId } = await ipc.localImport.import(filePath, quality);
      setCurrentProjectId(projectId);
      // Local import is instant — navigate immediately
      if (typeof window !== 'undefined' && window.location.protocol === 'app:') {
        sessionStorage.setItem('pendingProjectId', projectId);
        window.location.href = '/project/_/index.html';
      } else {
        router.push(`/project/${projectId}`);
      }
    } catch (err) {
      setIsSubmitting(false);
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Import failed: ${msg}`);
    }
  };

  const handleCancel = async () => {
    if (currentProjectId) {
      try { await ipc.download.cancel(currentProjectId); } catch { /* ignore */ }
    }
    setIsSubmitting(false);
    setProgress(null);
    setCurrentProjectId(null);
  };

  return (
    <>
      <AppShell title="Import Video">
        <div className="mx-auto max-w-xl px-6 py-10">
          {/* Page heading */}
          <div className="mb-8">
            <h2 className="text-xl font-bold text-text-primary">Import a YouTube Video</h2>
            <p className="mt-1 text-sm text-text-secondary">
              Paste a YouTube link and select quality. The video will be downloaded and queued for processing.
            </p>
          </div>

          {/* Inline error */}
          {error && (
            <div
              role="alert"
              className="mb-6 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
            >
              {error}
            </div>
          )}

          {/* Form */}
          <ImportForm
            initialUrl={initialUrl}
            isSubmitting={isSubmitting}
            onSubmit={handleSubmit}
            onLocalImport={handleLocalImport}
          />

          {/* Download progress */}
          {progress && (
            <div className="mt-6 animate-fade-in">
              <DownloadProgressCard progress={progress} onCancel={handleCancel} />
            </div>
          )}
        </div>
      </AppShell>

      <Toast toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Exported page (wrapped in Suspense for useSearchParams)
// ---------------------------------------------------------------------------

export default function ImportPage() {
  return (
    <Suspense>
      <ImportPageInner />
    </Suspense>
  );
}
