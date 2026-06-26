'use client';

/**
 * ClipItem — single row in the Export Queue.
 * Requirements: 7.3, 7.4, 7.6–7.9, 12.3
 */

import { useState } from 'react';
import { StatusBadge } from '../ui/StatusBadge';
import { ProgressBar } from '../ui/ProgressBar';
import { VideoModal } from '../ui/VideoModal';
import { useConfirm } from '../../hooks/useConfirm';
import { useIpcEvent } from '../../hooks/useIpcEvent';
import { ipc } from '../../lib/ipc-client';
import type { Clip, Hook, PrivacySetting } from '../../../shared/types';
import { cn } from '../../lib/utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ClipItemProps {
  clip: Clip;
  hook: Hook | undefined;
  onRemoved: (clipId: string) => void;
}

// ---------------------------------------------------------------------------
// IconButton
// ---------------------------------------------------------------------------

function IconButton({ label, onClick, danger, disabled, children }: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5',
        'text-xs font-medium text-text-secondary transition-micro',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        'disabled:opacity-40 disabled:cursor-not-allowed',
        danger
          ? 'hover:border-destructive/60 hover:text-destructive'
          : 'hover:border-accent/40 hover:text-text-primary'
      )}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Upload Dialog
// ---------------------------------------------------------------------------

interface UploadDialogProps {
  hook: Hook | undefined;
  clip: Clip;
  onConfirm: (title: string, description: string, tags: string[], privacy: PrivacySetting) => void;
  onCancel: () => void;
  uploading: boolean;
  error: string | null;
}

function UploadDialog({ hook, clip, onConfirm, onCancel, uploading, error }: UploadDialogProps) {
  const [title, setTitle] = useState(hook?.summary ?? '');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [privacy, setPrivacy] = useState<PrivacySetting>('private');
  const [aiGenerating, setAiGenerating] = useState(false);
  const [rightsConfirmed, setRightsConfirmed] = useState(false);

  const handleAiGenerate = async () => {
    setAiGenerating(true);
    try {
      // Get transcript for this clip's time range
      const transcript = await ipc.transcribe.getTranscript(clip.projectId);
      let clipText = hook?.summary ?? '';

      if (transcript && transcript.words.length > 0 && hook) {
        // Extract words within the clip's time range
        const clipWords = transcript.words
          .filter((w: { startMs: number; endMs: number; word: string }) => w.startMs >= hook.startMs && w.endMs <= hook.endMs)
          .map((w: { word: string }) => w.word)
          .join(' ');
        if (clipWords.trim()) clipText = clipWords;
      }

      const result = await ipc.analyze.generateMetadata(clipText);
      if (result) {
        if (result.title) setTitle(result.title);
        if (result.description) setDescription(result.description);
        if (result.tags) setTags(result.tags.join(', '));
      }
    } catch { /* ignore */ }
    setAiGenerating(false);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Upload to YouTube"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="w-full max-w-md rounded-xl border border-border bg-surface p-6 shadow-2xl flex flex-col gap-5">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text-primary">Upload to YouTube</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onCancel}
            className="text-text-secondary hover:text-text-primary transition-micro"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* Fields */}
        <div className="flex flex-col gap-4">
          {/* AI Generate button */}
          <button
            type="button"
            onClick={() => void handleAiGenerate()}
            disabled={aiGenerating}
            className={cn(
              'flex items-center justify-center gap-2 rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-xs font-medium text-accent',
              'hover:bg-accent/20 transition-micro',
              'disabled:opacity-40 disabled:cursor-not-allowed'
            )}
          >
            {aiGenerating ? (
              <>
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
                Generating…
              </>
            ) : (
              <>✨ AI Generate Title, Description &amp; Tags</>
            )}
          </button>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="upload-title" className="text-xs font-medium text-text-secondary uppercase tracking-wide">
              Title
            </label>
            <input
              id="upload-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={100}
              placeholder="Video title"
              className={cn(
                'rounded-md border border-border bg-background px-3 py-2 text-sm text-text-primary',
                'placeholder:text-text-secondary/50',
                'focus:outline-none focus:ring-2 focus:ring-accent transition-micro'
              )}
            />
            <span className="text-right text-[10px] text-text-secondary">{title.length}/100</span>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="upload-description" className="text-xs font-medium text-text-secondary uppercase tracking-wide">
              Description
            </label>
            <textarea
              id="upload-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              maxLength={5000}
              placeholder="Optional description…"
              className={cn(
                'rounded-md border border-border bg-background px-3 py-2 text-sm text-text-primary resize-none',
                'placeholder:text-text-secondary/50',
                'focus:outline-none focus:ring-2 focus:ring-accent transition-micro'
              )}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="upload-tags" className="text-xs font-medium text-text-secondary uppercase tracking-wide">
              Tags
            </label>
            <input
              id="upload-tags"
              type="text"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="tag1, tag2, tag3…"
              className={cn(
                'rounded-md border border-border bg-background px-3 py-2 text-sm text-text-primary',
                'placeholder:text-text-secondary/50',
                'focus:outline-none focus:ring-2 focus:ring-accent transition-micro'
              )}
            />
            <span className="text-[10px] text-text-secondary">Comma-separated</span>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="upload-privacy" className="text-xs font-medium text-text-secondary uppercase tracking-wide">
              Privacy
            </label>
            <select
              id="upload-privacy"
              value={privacy}
              onChange={(e) => setPrivacy(e.target.value as PrivacySetting)}
              className={cn(
                'rounded-md border border-border bg-background px-3 py-2 text-sm text-text-primary',
                'focus:outline-none focus:ring-2 focus:ring-accent transition-micro'
              )}
            >
              <option value="private">Private</option>
              <option value="unlisted">Unlisted</option>
              <option value="public">Public</option>
            </select>
          </div>
        </div>

        {/* Error */}
        {error && (
          <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        )}

        {/* Copyright confirmation */}
        <label
          htmlFor="upload-rights-confirm"
          className={cn(
            'flex items-start gap-3 rounded-md border px-3 py-2.5 cursor-pointer transition-micro',
            rightsConfirmed ? 'border-success/60 bg-success/5' : 'border-border bg-background'
          )}
        >
          <input
            id="upload-rights-confirm"
            type="checkbox"
            checked={rightsConfirmed}
            onChange={(e) => setRightsConfirmed(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
          />
          <span className="text-[11px] text-text-secondary leading-relaxed">
            Saya memiliki hak atau izin atas materi ini, dan bertanggung jawab penuh atas kepatuhan hak cipta saat mengunggah ke YouTube.
          </span>
        </label>

        {/* Actions */}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={uploading}
            className={cn(
              'rounded-md border border-border px-4 py-2 text-xs font-medium text-text-secondary',
              'hover:border-accent/40 hover:text-text-primary transition-micro',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              'disabled:opacity-40 disabled:cursor-not-allowed'
            )}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(title, description, tags.split(',').map(t => t.trim()).filter(Boolean), privacy)}
            disabled={uploading || !title.trim() || !rightsConfirmed}
            className={cn(
              'flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-xs font-semibold text-accent-foreground',
              'hover:bg-accent-hover transition-micro',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              'disabled:opacity-40 disabled:cursor-not-allowed'
            )}
          >
            {uploading && (
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-accent-foreground/30 border-t-accent-foreground" />
            )}
            {uploading ? 'Uploading…' : 'Upload'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ClipItem
// ---------------------------------------------------------------------------

export function ClipItem({ clip, hook, onRemoved }: ClipItemProps) {
  const { confirm, ConfirmDialogNode } = useConfirm();
  const [progress, setProgress] = useState(0);
  const [eta, setEta] = useState('');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dubbing, setDubbing] = useState(false);
  const [dubError, setDubError] = useState<string | null>(null);
  const [showDubMenu, setShowDubMenu] = useState(false);

  const DUB_VOICES = [
    { id: 'id-ID-ArdiNeural',    label: '🇮🇩 Indonesian — Ardi (Male)'    },
    { id: 'id-ID-GadisNeural',   label: '🇮🇩 Indonesian — Gadis (Female)' },
    { id: 'ms-MY-OsmanNeural',   label: '🇲🇾 Malay — Osman (Male)'        },
    { id: 'en-US-GuyNeural',     label: '🇺🇸 English — Guy (Male)'        },
    { id: 'en-US-JennyNeural',   label: '🇺🇸 English — Jenny (Female)'    },
    { id: 'ja-JP-KeitaNeural',   label: '🇯🇵 Japanese — Keita (Male)'     },
    { id: 'zh-CN-YunxiNeural',   label: '🇨🇳 Chinese — Yunxi (Male)'      },
  ];

  const handleDub = async (voice: string) => {
    setShowDubMenu(false);
    setDubbing(true);
    setDubError(null);
    try {
      await ipc.dub.start(clip.id, voice, -30);
    } catch (err) {
      setDubError(err instanceof Error ? err.message : 'Dubbing failed.');
    } finally {
      setDubbing(false);
    }
  };

  useIpcEvent<{ clipId: string; percent: number; eta: string }>(
    'clip:progress',
    (data) => {
      if (data.clipId !== clip.id) return;
      setProgress(data.percent);
      setEta(data.eta);
    },
    [clip.id]
  );

  const videoSrc = clip.outputPath
    ? `localfile:///${clip.outputPath.replace(/\\/g, '/')}`
    : null;

  const handlePreview = () => {
    if (videoSrc) {
      setPreviewOpen(true);
    } else if (clip.outputPath) {
      void ipc.shell.openPath(clip.outputPath);
    }
  };

  const handleUploadClick = async () => {
    // Check auth before opening dialog
    try {
      const status = await ipc.upload.getAuthStatus();
      if (!status.authenticated) {
        setUploadError('Not connected to YouTube. Go to Settings → YouTube Account to connect.');
        setUploadDialogOpen(true);
        return;
      }
    } catch {
      setUploadError('Could not check YouTube auth status.');
      setUploadDialogOpen(true);
      return;
    }
    setUploadError(null);
    setUploadDialogOpen(true);
  };

  const handleUploadConfirm = async (title: string, description: string, tags: string[], privacy: PrivacySetting) => {
    setUploading(true);
    setUploadError(null);
    try {
      await ipc.upload.start({
        clipId: clip.id,
        title,
        description,
        tags,
        privacy,
      });
      setUploadDialogOpen(false);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setUploading(false);
    }
  };

  const handleRemove = async () => {
    const ok = await confirm({
      title: 'Remove clip?',
      description: 'This clip will be removed from the queue. The output file will not be deleted.',
      confirmLabel: 'Remove',
      cancelLabel: 'Keep',
      destructive: true,
    });
    if (!ok) return;
    try {
      await ipc.clips.delete(clip.id);
      onRemoved(clip.id);
    } catch { /* ignore */ }
  };

  const handleRetry = async () => {
    if (!hook) return;
    try { await ipc.clips.generate(hook.id, {}); } catch { /* ignore */ }
  };

  return (
    <>
      {ConfirmDialogNode}

      {/* In-app video preview modal */}
      {previewOpen && videoSrc && (
        <VideoModal
          src={videoSrc}
          title={hook?.summary}
          onClose={() => setPreviewOpen(false)}
        />
      )}

      {/* Upload dialog */}
      {uploadDialogOpen && (
        <UploadDialog
          hook={hook}
          clip={clip}
          onConfirm={(title, desc, tags, privacy) => void handleUploadConfirm(title, desc, tags, privacy)}
          onCancel={() => { setUploadDialogOpen(false); setUploadError(null); }}
          uploading={uploading}
          error={uploadError}
        />
      )}

      <div
        className={cn(
          'surface flex flex-col gap-3 p-4 transition-micro',
          clip.status === 'failed' && 'border-destructive/30'
        )}
        aria-label={`Clip: ${hook?.summary ?? clip.id}`}
      >
        {/* Top row */}
        <div className="flex items-start justify-between gap-3">
          {/* Thumbnail / video preview button */}
          <button
            type="button"
            aria-label="Preview clip"
            disabled={clip.status !== 'complete'}
            onClick={handlePreview}
            className={cn(
              'relative flex h-14 w-24 shrink-0 items-center justify-center rounded overflow-hidden bg-border',
              clip.status === 'complete' && 'cursor-pointer hover:ring-2 hover:ring-accent/60 transition-micro',
              clip.status !== 'complete' && 'cursor-default'
            )}
          >
            {videoSrc && clip.status === 'complete' ? (
              // eslint-disable-next-line jsx-a11y/media-has-caption
              <video
                src={videoSrc}
                className="h-full w-full object-cover"
                muted
                preload="metadata"
                aria-hidden="true"
              />
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                className="text-text-secondary" aria-hidden="true">
                <polygon points="5 3 19 12 5 21 5 3"/>
              </svg>
            )}
            {clip.status === 'complete' && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 hover:opacity-100 transition-micro">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="white" aria-hidden="true">
                  <polygon points="5 3 19 12 5 21 5 3"/>
                </svg>
              </div>
            )}
          </button>

          {/* Summary + badge */}
          <div className="flex flex-1 flex-col gap-1.5">
            <p className="text-sm font-medium text-text-primary line-clamp-2">
              {hook?.summary ?? `Clip ${clip.id.slice(0, 8)}`}
            </p>
            <StatusBadge variant={clip.status} />
            {clip.youtubeUrl && (
              <a
                href={clip.youtubeUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] text-accent underline underline-offset-2 hover:no-underline"
              >
                View on YouTube ↗
              </a>
            )}
          </div>
        </div>

        {/* Progress bar — only while processing */}
        {clip.status === 'processing' && (
          <div className="flex flex-col gap-1">
            <ProgressBar value={progress} />
            {eta && (
              <p className="text-right text-[10px] font-mono text-text-secondary">ETA {eta}</p>
            )}
          </div>
        )}

        {/* Error message */}
        {clip.status === 'failed' && clip.errorMessage && (
          <p className="text-xs text-destructive">{clip.errorMessage}</p>
        )}

        {/* Action buttons */}
        <div className="flex flex-wrap items-center gap-2">
          {clip.status === 'complete' && (
            <>
              <IconButton
                label="Open in file explorer"
                onClick={() => clip.outputPath && void ipc.shell.showItem(clip.outputPath)}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                  aria-hidden="true">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                </svg>
                Show in folder
              </IconButton>
              <IconButton
                label="Upload to YouTube"
                onClick={() => void handleUploadClick()}
                disabled={uploading}
              >
                {uploading ? (
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-border border-t-text-secondary" aria-hidden="true" />
                ) : (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                    aria-hidden="true">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="17 8 12 3 7 8"/>
                    <line x1="12" y1="3" x2="12" y2="15"/>
                  </svg>
                )}
                {uploading ? 'Uploading…' : 'Upload'}
              </IconButton>

              {/* Dub button */}
              <div className="relative">
                <IconButton
                  label="Dub with AI voice"
                  onClick={() => setShowDubMenu((v) => !v)}
                  disabled={dubbing}
                >
                  {dubbing ? (
                    <span className="h-3 w-3 animate-spin rounded-full border-2 border-border border-t-text-secondary" aria-hidden="true" />
                  ) : (
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
                      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                      aria-hidden="true">
                      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                      <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                      <line x1="12" y1="19" x2="12" y2="23"/>
                      <line x1="8" y1="23" x2="16" y2="23"/>
                    </svg>
                  )}
                  {dubbing ? 'Dubbing…' : 'Dub'}
                </IconButton>

                {showDubMenu && (
                  <div
                    className="absolute bottom-full left-0 z-50 mb-1 w-52 rounded-md border border-border bg-surface shadow-lg"
                    onMouseLeave={() => setShowDubMenu(false)}
                  >
                    <p className="border-b border-border px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
                      AI Voice (replaces speech)
                    </p>
                    {DUB_VOICES.map(({ id, label }) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => void handleDub(id)}
                        className="w-full px-3 py-1.5 text-left text-[11px] text-text-primary hover:bg-accent/10 transition-micro"
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          {/* Dub error */}
          {dubError && (
            <p className="w-full text-[10px] text-destructive">{dubError}</p>
          )}

          {clip.status === 'failed' && hook && (
            <IconButton label="Retry clip generation" onClick={() => void handleRetry()}>
              Retry
            </IconButton>
          )}

          <IconButton label="Remove clip from queue" onClick={() => void handleRemove()} danger>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              aria-hidden="true">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
            </svg>
            Remove
          </IconButton>
        </div>
      </div>
    </>
  );
}
