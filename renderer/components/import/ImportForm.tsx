'use client';

/**
 * ImportForm — URL input + quality selector, with local file import tab.
 * Requirements: 3.1–3.5, 3.12, 3.13
 */

import { useState, useEffect, useRef } from 'react';
import { SegmentedControl } from '../ui/SegmentedControl';
import { validateYouTubeUrl } from '../../lib/urlValidator';
import { ipc } from '../../lib/ipc-client';
import { cn } from '../../lib/utils';

export type VideoQuality = '1080p' | '720p' | '480p' | '360p';
export type ImportMode = 'url' | 'local';

interface ImportFormProps {
  initialUrl?: string;
  isSubmitting: boolean;
  onSubmit: (url: string, quality: VideoQuality) => void;
  onLocalImport: (filePath: string, quality: VideoQuality) => void;
}

const QUALITY_OPTIONS = [
  { value: '1080p', label: '1080p' },
  { value: '720p',  label: '720p'  },
  { value: '480p',  label: '480p'  },
  { value: '360p',  label: '360p'  },
];

export function ImportForm({ initialUrl = '', isSubmitting, onSubmit, onLocalImport }: ImportFormProps) {
  const [mode, setMode] = useState<ImportMode>('url');
  const [url, setUrl] = useState(initialUrl);
  const [quality, setQuality] = useState<VideoQuality>('1080p');
  const [touched, setTouched] = useState(false);
  const [localFile, setLocalFile] = useState<string | null>(null);
  const [pickingFile, setPickingFile] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (mode === 'url') inputRef.current?.focus(); }, [mode]);
  useEffect(() => { if (initialUrl) setUrl(initialUrl); }, [initialUrl]);

  const validation = validateYouTubeUrl(url);
  const isValid = validation.valid;
  const showError = touched && url.length > 0 && !isValid;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;

    if (mode === 'local') {
      if (!localFile) return;
      onLocalImport(localFile, quality);
      return;
    }

    setTouched(true);
    if (!isValid) return;
    onSubmit(url.trim(), quality);
  };

  const handlePickFile = async () => {
    setPickingFile(true);
    try {
      const filePath = await ipc.localImport.openFilePicker();
      if (filePath) setLocalFile(filePath);
    } finally {
      setPickingFile(false);
    }
  };

  const canSubmit = mode === 'url' ? isValid : !!localFile;

  return (
    <form
      id="import-form"
      onSubmit={handleSubmit}
      aria-label="Import video"
      className="flex flex-col gap-6"
    >
      {/* Mode tabs */}
      <div className="flex rounded-md border border-border overflow-hidden">
        {(['url', 'local'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={cn(
              'flex-1 py-2 text-sm font-medium transition-micro',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              mode === m
                ? 'bg-accent text-accent-foreground'
                : 'bg-surface text-text-secondary hover:text-text-primary'
            )}
          >
            {m === 'url' ? '🔗 YouTube URL' : '📁 Local File'}
          </button>
        ))}
      </div>

      {/* URL mode */}
      {mode === 'url' && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="import-url-input" className="text-sm font-medium text-text-primary">
            YouTube URL
          </label>
          <div className="relative">
            <input
              ref={inputRef}
              id="import-url-input"
              type="url"
              value={url}
              onChange={(e) => { setUrl(e.target.value); setTouched(true); }}
              placeholder="Paste YouTube URL here…"
              disabled={isSubmitting}
              aria-invalid={showError}
              aria-describedby={showError ? 'import-url-error' : undefined}
              className={cn(
                'w-full rounded-md border bg-surface px-4 py-3 pr-10',
                'text-sm text-text-primary placeholder:text-text-secondary/50',
                'transition-micro focus:outline-none focus:ring-2 focus:ring-accent',
                'disabled:opacity-50 disabled:cursor-not-allowed',
                showError
                  ? 'border-destructive/60 focus:ring-destructive/60'
                  : isValid && touched
                  ? 'border-success/60'
                  : 'border-border'
              )}
            />
            {touched && url.length > 0 && (
              <span
                aria-hidden="true"
                className={cn(
                  'absolute right-3 top-1/2 -translate-y-1/2 text-sm font-bold',
                  isValid ? 'text-success' : 'text-destructive'
                )}
              >
                {isValid ? '✓' : '✕'}
              </span>
            )}
          </div>
          {showError && (
            <p id="import-url-error" role="alert" className="text-xs text-destructive">
              Please enter a valid YouTube URL (youtube.com/watch, youtu.be, or youtube.com/shorts).
            </p>
          )}
        </div>
      )}

      {/* Local file mode */}
      {mode === 'local' && (
        <div className="flex flex-col gap-3">
          <label className="text-sm font-medium text-text-primary">Video File</label>

          {/* Drop zone / picker */}
          <div
            role="button"
            tabIndex={0}
            aria-label="Choose video file"
            onClick={() => void handlePickFile()}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') void handlePickFile(); }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const file = e.dataTransfer.files[0];
              if (file) setLocalFile((file as unknown as { path?: string }).path ?? file.name ?? '');
            }}
            className={cn(
              'flex flex-col items-center justify-center gap-3 rounded-md border-2 border-dashed',
              'border-border bg-surface px-6 py-10 cursor-pointer',
              'hover:border-accent/60 hover:bg-accent/5 transition-micro',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              localFile && 'border-success/60 bg-success/5'
            )}
          >
            {pickingFile ? (
              <span className="h-6 w-6 animate-spin rounded-full border-2 border-border border-t-accent" />
            ) : localFile ? (
              <>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                  className="text-success" aria-hidden="true">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
                <p className="text-sm font-medium text-success text-center break-all max-w-full">
                  {localFile.split(/[\\/]/).pop()}
                </p>
                <p className="text-xs text-text-secondary">{localFile}</p>
              </>
            ) : (
              <>
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                  className="text-text-secondary" aria-hidden="true">
                  <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/>
                  <line x1="7" y1="2" x2="7" y2="22"/>
                  <line x1="17" y1="2" x2="17" y2="22"/>
                  <line x1="2" y1="12" x2="22" y2="12"/>
                  <line x1="2" y1="7" x2="7" y2="7"/>
                  <line x1="2" y1="17" x2="7" y2="17"/>
                  <line x1="17" y1="17" x2="22" y2="17"/>
                  <line x1="17" y1="7" x2="22" y2="7"/>
                </svg>
                <div className="text-center">
                  <p className="text-sm font-medium text-text-primary">Click to choose file</p>
                  <p className="text-xs text-text-secondary mt-1">or drag & drop</p>
                  <p className="text-[10px] text-text-secondary mt-1">MP4, MKV, WebM, MOV, AVI</p>
                </div>
              </>
            )}
          </div>

          {localFile && (
            <button
              type="button"
              onClick={() => setLocalFile(null)}
              className="self-start text-xs text-text-secondary underline underline-offset-2 hover:text-destructive"
            >
              Clear selection
            </button>
          )}
        </div>
      )}

      {/* Quality selector */}
      <div className="flex flex-col gap-1.5">
        <label id="quality-label" className="text-sm font-medium text-text-primary">
          {mode === 'local' ? 'Source Quality (for metadata)' : 'Download Quality'}
        </label>
        <SegmentedControl
          id="import-quality-control"
          aria-label="Download quality"
          options={QUALITY_OPTIONS}
          value={quality}
          onChange={(v) => setQuality(v as VideoQuality)}
        />
      </div>

      {/* Submit */}
      <button
        type="submit"
        id="import-submit-btn"
        disabled={!canSubmit || isSubmitting}
        className={cn(
          'flex items-center justify-center gap-2 rounded-md bg-accent px-6 py-3',
          'text-sm font-semibold text-accent-foreground',
          'hover:bg-accent-hover transition-micro',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          'disabled:opacity-40 disabled:cursor-not-allowed'
        )}
      >
        {isSubmitting ? (
          <>
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
            {mode === 'local' ? 'Importing…' : 'Starting download…'}
          </>
        ) : (
          <>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              aria-hidden="true">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/>
              <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            {mode === 'local' ? 'Import File' : 'Start Import'}
          </>
        )}
      </button>
    </form>
  );
}
