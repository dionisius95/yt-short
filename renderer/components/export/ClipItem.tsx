'use client';

/**
 * ClipItem — single row in the Export Queue.
 * Requirements: 7.3, 7.4, 7.6–7.9, 12.3
 */

import { useState, useEffect } from 'react';
import { StatusBadge } from '../ui/StatusBadge';
import { ProgressBar } from '../ui/ProgressBar';
import { VideoModal } from '../ui/VideoModal';
import { CommentatorModal } from './CommentatorModal';
import { useConfirm } from '../../hooks/useConfirm';
import { useIpcEvent } from '../../hooks/useIpcEvent';
import { ipc } from '../../lib/ipc-client';
import type { Clip, Hook, PrivacySetting, TrendAnalysisResult, GistOptimizationResult, AppSettings } from '../../../shared/types';
import { YOUTUBE_CATEGORIES, YOUTUBE_LANGUAGES } from '../../../shared/types';
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
  clip: Clip;
  hook?: Hook;
  onConfirm: (
    platforms: Array<'youtube' | 'tiktok' | 'facebook' | 'telegram'>,
    title: string,
    description: string,
    tags: string[],
    privacy: PrivacySetting,
    publishAt?: string,
    accountIds?: string[],
    categoryId?: string,
    defaultAudioLanguage?: string,
    defaultLanguage?: string,
    customThumbnailPath?: string
  ) => void;
  onCancel: () => void;
  uploading: boolean;
  error: string | null;
}

function UploadDialog({ hook, clip, onConfirm, onCancel, uploading, error }: UploadDialogProps) {
  // Load initial title, description, tags from optionsJson if they exist
  const getInitialMetadata = () => {
    try {
      if (clip.optionsJson) {
        const opts = JSON.parse(clip.optionsJson);
        if (opts.aiTitle || opts.aiDescription || opts.aiTags) {
          return {
            title: opts.aiTitle || hook?.summary || '',
            description: opts.aiDescription || '',
            tags: Array.isArray(opts.aiTags) ? opts.aiTags.join(', ') : (opts.aiTags || ''),
          };
        }
      }
    } catch {}
    return {
      title: hook?.summary ?? '',
      description: '',
      tags: '',
    };
  };

  const initial = getInitialMetadata();
  const [title, setTitle] = useState(initial.title);
  const [description, setDescription] = useState(initial.description);
  const [tags, setTags] = useState(initial.tags);
  const [privacy, setPrivacy] = useState<PrivacySetting>('private');
  const [categoryId, setCategoryId] = useState<string>('22');
  const [defaultAudioLanguage, setDefaultAudioLanguage] = useState<string>('');
  const [defaultLanguage, setDefaultLanguage] = useState<string>('');
  const [customThumbnailPath, setCustomThumbnailPath] = useState<string>('');
  const [aiGenerating, setAiGenerating] = useState(false);
  const [rightsConfirmed, setRightsConfirmed] = useState(false);

  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [youtubeAuth, setYoutubeAuth] = useState<{ authenticated: boolean; email?: string } | null>(null);
  const [selectedPlatforms, setSelectedPlatforms] = useState<Array<'youtube' | 'tiktok' | 'facebook' | 'telegram'>>([]);
  const [availableAccounts, setAvailableAccounts] = useState<import('../../../shared/types').UploadAccount[]>([]);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [isScheduled, setIsScheduled] = useState(false);

  useEffect(() => {
    void ipc.settings.get().then(setSettings).catch(() => {});
    void ipc.upload.getAuthStatus().then(setYoutubeAuth).catch(() => {});
    void ipc.accounts.get().then((list) => {
      if (Array.isArray(list)) setAvailableAccounts(list);
    }).catch(() => {});
  }, []);

  const getPlatformAccounts = (platform: 'youtube' | 'tiktok' | 'facebook' | 'telegram') => {
    return availableAccounts.filter((acc) => acc.platform === platform);
  };

  useEffect(() => {
    setSelectedAccountIds(availableAccounts.map((a) => a.id));
  }, [availableAccounts]);

  useEffect(() => {
    if (!settings) return;
    const platforms: Array<'youtube' | 'tiktok' | 'facebook' | 'telegram'> = [];
    if (youtubeAuth?.authenticated || availableAccounts.some(a => a.platform === 'youtube')) {
      platforms.push('youtube');
    }
    if (settings.tiktokSessionId || availableAccounts.some(a => a.platform === 'tiktok')) {
      platforms.push('tiktok');
    }
    if ((settings.facebookPageId && settings.facebookAccessToken) || availableAccounts.some(a => a.platform === 'facebook')) {
      platforms.push('facebook');
    }
    if ((settings.telegramBotToken && settings.telegramChatId) || availableAccounts.some(a => a.platform === 'telegram')) {
      platforms.push('telegram');
    }
    setSelectedPlatforms(platforms);
  }, [settings, youtubeAuth, availableAccounts]);

  const toggleAccountId = (id: string) => {
    if (selectedAccountIds.includes(id)) {
      setSelectedAccountIds(selectedAccountIds.filter(i => i !== id));
    } else {
      setSelectedAccountIds([...selectedAccountIds, id]);
    }
  };

  const togglePlatform = (platform: 'youtube' | 'tiktok' | 'facebook' | 'telegram', enabled: boolean) => {
    const platformAccIds = getPlatformAccounts(platform).map(a => a.id);
    if (enabled) {
      setSelectedPlatforms(prev => Array.from(new Set([...prev, platform])));
      setSelectedAccountIds(prev => Array.from(new Set([...prev, ...platformAccIds])));
    } else {
      setSelectedPlatforms(prev => prev.filter(p => p !== platform));
      setSelectedAccountIds(prev => prev.filter(id => !platformAccIds.includes(id)));
    }
  };
  
  const [publishDate, setPublishDate] = useState(() => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow.toISOString().split('T')[0];
  });
  const [publishTime, setPublishTime] = useState('12:00');

  const getPublishAtIso = () => {
    if (!publishDate) return undefined;
    const localDateTimeStr = `${publishDate}T${publishTime || '00:00'}`;
    const dateObj = new Date(localDateTimeStr);
    if (isNaN(dateObj.getTime())) return undefined;
    return dateObj.toISOString();
  };

  const [hasTranslation, setHasTranslation] = useState(false);
  const [useTranslated, setUseTranslated] = useState(true);

  const getGistScript = (): string | undefined => {
    try {
      if (clip.optionsJson) {
        const opts = JSON.parse(clip.optionsJson);
        if (opts.customScript && opts.customScript.trim()) {
          return opts.customScript;
        }
      }
    } catch {}
    return undefined;
  };

  const gistScript = getGistScript();
  const hasGistScript = !!gistScript;

  const [sourceType, setSourceType] = useState<'transcript' | 'gist'>(hasGistScript ? 'gist' : 'transcript');

  // Check if translation is available for this project
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const transcript = await ipc.transcribe.getTranscript(clip.projectId);
        if (active && transcript?.originalWords && transcript.originalWords.length > 0) {
          setHasTranslation(true);
        }
      } catch { /* ignore */ }
    })();
    return () => { active = false; };
  }, [clip.projectId]);

  const handleAiGenerate = async () => {
    setAiGenerating(true);
    try {
      let clipText = hook?.summary ?? '';

      if (sourceType === 'gist' && gistScript) {
        clipText = gistScript;
      } else {
        // Get transcript for this clip's time range
        const transcript = await ipc.transcribe.getTranscript(clip.projectId);
        if (transcript && hook) {
          // Choose source words: translated or original
          const wordsSource = (useTranslated && transcript.words.length > 0)
            ? transcript.words
            : (transcript.originalWords && transcript.originalWords.length > 0)
              ? transcript.originalWords
              : transcript.words;

          // Extract words within the clip's time range
          const clipWords = wordsSource
            .filter((w: { startMs: number; endMs: number; word: string }) => w.startMs >= hook.startMs && w.endMs <= hook.endMs)
            .map((w: { word: string }) => w.word)
            .join(' ');
          if (clipWords.trim()) clipText = clipWords;
        }
      }

      const result = await ipc.analyze.generateMetadata(clipText);
      if (result) {
        const newTitle = result.title || '';
        const newDesc = result.description || '';
        const newTagsStr = result.tags ? result.tags.join(', ') : '';

        setTitle(newTitle);
        setDescription(newDesc);
        setTags(newTagsStr);

        // Save generated AI metadata to database immediately
        await ipc.clips.saveMetadata(clip.id, {
          title: newTitle,
          description: newDesc,
          tags: result.tags || []
        });
      }
    } catch { /* ignore */ }
    setAiGenerating(false);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Upload Video"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <div className="w-full max-w-md rounded-xl border border-border bg-surface p-6 shadow-2xl flex flex-col gap-5">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text-primary">Upload Klip Video</h2>
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
        <div className="flex flex-col gap-4 max-h-[70vh] overflow-y-auto pr-1">
          {/* Platform selection checkboxes */}
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-background/50 p-3">
            <span className="text-[10px] font-semibold text-text-secondary uppercase tracking-wide">
              Pilih Platform Unggahan
            </span>
            <div className="flex flex-col gap-2 mt-1">
              {/* YouTube */}
              <div className="flex flex-col gap-1">
                <label className="flex items-center gap-2.5 text-xs font-medium text-text-primary cursor-pointer">
                  <input
                    type="checkbox"
                    disabled={getPlatformAccounts('youtube').length === 0}
                    checked={selectedPlatforms.includes('youtube')}
                    onChange={(e) => togglePlatform('youtube', e.target.checked)}
                    className="rounded border-border text-accent focus:ring-accent accent-accent h-4 w-4"
                  />
                  <span>YouTube Shorts {getPlatformAccounts('youtube').length === 0 && <span className="text-[10px] text-text-secondary/60">(Belum Terhubung)</span>}</span>
                </label>
                {selectedPlatforms.includes('youtube') && getPlatformAccounts('youtube').length > 0 && (
                  <div className="ml-6 flex flex-col gap-1 text-[11px] pt-1">
                    <span className="text-[10px] font-semibold text-text-secondary">Pilih Akun YouTube Target:</span>
                    {getPlatformAccounts('youtube').map((acc) => (
                      <label key={acc.id} className="flex items-center gap-2 text-text-primary cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selectedAccountIds.includes(acc.id)}
                          onChange={() => toggleAccountId(acc.id)}
                          className="rounded border-border text-accent focus:ring-accent accent-accent h-3.5 w-3.5"
                        />
                        <span>{acc.name}</span>
                      </label>
                    ))}
                    {!getPlatformAccounts('youtube').some(a => selectedAccountIds.includes(a.id)) && (
                      <span className="text-[10px] font-medium text-destructive mt-0.5 animate-fade-in">⚠️ Pilih minimal 1 akun target untuk diunggah</span>
                    )}
                  </div>
                )}
              </div>

              {/* TikTok */}
              <div className="flex flex-col gap-1">
                <label className="flex items-center gap-2.5 text-xs font-medium text-text-primary cursor-pointer">
                  <input
                    type="checkbox"
                    disabled={getPlatformAccounts('tiktok').length === 0}
                    checked={selectedPlatforms.includes('tiktok')}
                    onChange={(e) => togglePlatform('tiktok', e.target.checked)}
                    className="rounded border-border text-accent focus:ring-accent accent-accent h-4 w-4"
                  />
                  <span>TikTok {getPlatformAccounts('tiktok').length === 0 && <span className="text-[10px] text-text-secondary/60">(Token Belum Diatur)</span>}</span>
                </label>
                {selectedPlatforms.includes('tiktok') && getPlatformAccounts('tiktok').length > 0 && (
                  <div className="ml-6 flex flex-col gap-1 text-[11px] pt-1">
                    <span className="text-[10px] font-semibold text-text-secondary">Pilih Akun TikTok Target:</span>
                    {getPlatformAccounts('tiktok').map((acc) => (
                      <label key={acc.id} className="flex items-center gap-2 text-text-primary cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selectedAccountIds.includes(acc.id)}
                          onChange={() => toggleAccountId(acc.id)}
                          className="rounded border-border text-accent focus:ring-accent accent-accent h-3.5 w-3.5"
                        />
                        <span>{acc.name}</span>
                      </label>
                    ))}
                    {!getPlatformAccounts('tiktok').some(a => selectedAccountIds.includes(a.id)) && (
                      <span className="text-[10px] font-medium text-destructive mt-0.5 animate-fade-in">⚠️ Pilih minimal 1 akun target untuk diunggah</span>
                    )}
                  </div>
                )}
              </div>

              {/* Facebook */}
              <div className="flex flex-col gap-1">
                <label className="flex items-center gap-2.5 text-xs font-medium text-text-primary cursor-pointer">
                  <input
                    type="checkbox"
                    disabled={getPlatformAccounts('facebook').length === 0}
                    checked={selectedPlatforms.includes('facebook')}
                    onChange={(e) => togglePlatform('facebook', e.target.checked)}
                    className="rounded border-border text-accent focus:ring-accent accent-accent h-4 w-4"
                  />
                  <span>Facebook Fanpage {getPlatformAccounts('facebook').length === 0 && <span className="text-[10px] text-text-secondary/60">(Kredensial Belum Diatur)</span>}</span>
                </label>
                {selectedPlatforms.includes('facebook') && getPlatformAccounts('facebook').length > 0 && (
                  <div className="ml-6 flex flex-col gap-1 text-[11px] pt-1">
                    <span className="text-[10px] font-semibold text-text-secondary">Pilih Halaman Facebook Target:</span>
                    {getPlatformAccounts('facebook').map((acc) => (
                      <label key={acc.id} className="flex items-center gap-2 text-text-primary cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selectedAccountIds.includes(acc.id)}
                          onChange={() => toggleAccountId(acc.id)}
                          className="rounded border-border text-accent focus:ring-accent accent-accent h-3.5 w-3.5"
                        />
                        <span>{acc.name}</span>
                      </label>
                    ))}
                    {!getPlatformAccounts('facebook').some(a => selectedAccountIds.includes(a.id)) && (
                      <span className="text-[10px] font-medium text-destructive mt-0.5 animate-fade-in">⚠️ Pilih minimal 1 halaman target untuk diunggah</span>
                    )}
                  </div>
                )}
              </div>

              {/* Telegram */}
              <div className="flex flex-col gap-1">
                <label className="flex items-center gap-2.5 text-xs font-medium text-text-primary cursor-pointer">
                  <input
                    type="checkbox"
                    disabled={getPlatformAccounts('telegram').length === 0}
                    checked={selectedPlatforms.includes('telegram')}
                    onChange={(e) => togglePlatform('telegram', e.target.checked)}
                    className="rounded border-border text-accent focus:ring-accent accent-accent h-4 w-4"
                  />
                  <span>Telegram {getPlatformAccounts('telegram').length === 0 && <span className="text-[10px] text-text-secondary/60">(Bot Belum Diatur)</span>}</span>
                </label>
                {selectedPlatforms.includes('telegram') && getPlatformAccounts('telegram').length > 0 && (
                  <div className="ml-6 flex flex-col gap-1 text-[11px] pt-1">
                    <span className="text-[10px] font-semibold text-text-secondary">Pilih Akun Telegram Target:</span>
                    {getPlatformAccounts('telegram').map((acc) => (
                      <label key={acc.id} className="flex items-center gap-2 text-text-primary cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selectedAccountIds.includes(acc.id)}
                          onChange={() => toggleAccountId(acc.id)}
                          className="rounded border-border text-accent focus:ring-accent accent-accent h-3.5 w-3.5"
                        />
                        <span>{acc.name}</span>
                      </label>
                    ))}
                    {!getPlatformAccounts('telegram').some(a => selectedAccountIds.includes(a.id)) && (
                      <span className="text-[10px] font-medium text-destructive mt-0.5 animate-fade-in">⚠️ Pilih minimal 1 akun target untuk diunggah</span>
                    )}
                  </div>
                )}
              </div>

              <label className="flex items-center gap-2.5 text-xs font-medium text-text-primary cursor-pointer border-t border-border/45 pt-2.5 mt-1 select-none">
                <input
                  type="checkbox"
                  checked={isScheduled}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setIsScheduled(checked);
                    if (checked) {
                      setPrivacy('private_scheduled');
                    } else {
                      setPrivacy('private');
                    }
                  }}
                  className="rounded border-border text-accent focus:ring-accent accent-accent h-4 w-4"
                />
                <span>Jadwalkan Unggahan (Schedule Upload)</span>
              </label>
            </div>
          </div>

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
              <>✨ Generate Title, Description &amp; Tags</>
            )}
          </button>

          {hasGistScript && (
            <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-background/50 p-2.5">
              <span className="text-[10px] font-semibold text-text-secondary uppercase tracking-wide">
                Sumber Data (Metadata)
              </span>
              <div className="flex gap-1 bg-surface p-1 rounded-md border border-border/60">
                <button
                  type="button"
                  onClick={() => setSourceType('transcript')}
                  className={cn(
                    "flex-1 py-1 text-xs font-medium rounded transition-micro focus:outline-none",
                    sourceType === 'transcript'
                      ? "bg-accent text-white shadow-sm"
                      : "text-text-secondary hover:text-text-primary hover:bg-background/45"
                  )}
                >
                  Transkrip Klip
                </button>
                <button
                  type="button"
                  onClick={() => setSourceType('gist')}
                  className={cn(
                    "flex-1 py-1 text-xs font-medium rounded transition-micro focus:outline-none",
                    sourceType === 'gist'
                      ? "bg-accent text-white shadow-sm"
                      : "text-text-secondary hover:text-text-primary hover:bg-background/45"
                  )}
                >
                  Naskah GIST
                </button>
              </div>
            </div>
          )}

          {sourceType === 'transcript' && hasTranslation && (
            <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-background/50 p-2.5">
              <span className="text-[10px] font-semibold text-text-secondary uppercase tracking-wide">
                Source Caption Language
              </span>
              <div className="flex gap-1 bg-surface p-1 rounded-md border border-border/60">
                <button
                  type="button"
                  onClick={() => setUseTranslated(false)}
                  className={cn(
                    "flex-1 py-1 text-xs font-medium rounded transition-micro focus:outline-none",
                    !useTranslated
                      ? "bg-accent text-white shadow-sm"
                      : "text-text-secondary hover:text-text-primary hover:bg-background/45"
                  )}
                >
                  Original Caption
                </button>
                <button
                  type="button"
                  onClick={() => setUseTranslated(true)}
                  className={cn(
                    "flex-1 py-1 text-xs font-medium rounded transition-micro focus:outline-none",
                    useTranslated
                      ? "bg-accent text-white shadow-sm"
                      : "text-text-secondary hover:text-text-primary hover:bg-background/45"
                  )}
                >
                  Translated Caption
                </button>
              </div>
            </div>
          )}

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
            <span className="text-[10px] text-text-secondary">Pisahkan dengan koma (Contoh: tag1, tag2, tag3)</span>
          </div>

          {selectedPlatforms.includes('youtube') && (
            <div className="flex flex-col gap-3 rounded-lg border border-border bg-background/40 p-3">
              <span className="text-[10px] font-semibold text-text-secondary uppercase tracking-wide">
                Pengaturan Lanjutan YouTube
              </span>

              <div className="flex gap-2">
                <div className="flex-1 flex flex-col gap-1.5">
                  <label htmlFor="upload-privacy" className="text-[11px] font-medium text-text-secondary">
                    Privacy
                  </label>
                  <select
                    id="upload-privacy"
                    value={privacy}
                    onChange={(e) => {
                      const val = e.target.value as PrivacySetting;
                      setPrivacy(val);
                      setIsScheduled(val === 'private_scheduled');
                    }}
                    className={cn(
                      'rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-text-primary',
                      'focus:outline-none focus:ring-1 focus:ring-accent transition-micro'
                    )}
                  >
                    <option value="private">Private</option>
                    <option value="unlisted">Unlisted</option>
                    <option value="public">Public</option>
                    <option value="private_scheduled">✨ Terjadwal (Scheduled)</option>
                  </select>
                </div>

                <div className="flex-1 flex flex-col gap-1.5">
                  <label htmlFor="upload-category" className="text-[11px] font-medium text-text-secondary">
                    Kategori Video
                  </label>
                  <select
                    id="upload-category"
                    value={categoryId}
                    onChange={(e) => setCategoryId(e.target.value)}
                    className={cn(
                      'rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-text-primary',
                      'focus:outline-none focus:ring-1 focus:ring-accent transition-micro'
                    )}
                  >
                    {YOUTUBE_CATEGORIES.map((cat) => (
                      <option key={cat.id} value={cat.id}>
                        {cat.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Language Settings */}
              <div className="flex gap-2">
                <div className="flex-1 flex flex-col gap-1.5">
                  <label htmlFor="upload-audio-lang" className="text-[11px] font-medium text-text-secondary">
                    Bahasa Audio
                  </label>
                  <select
                    id="upload-audio-lang"
                    value={defaultAudioLanguage}
                    onChange={(e) => setDefaultAudioLanguage(e.target.value)}
                    className={cn(
                      'rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-text-primary',
                      'focus:outline-none focus:ring-1 focus:ring-accent transition-micro'
                    )}
                  >
                    {YOUTUBE_LANGUAGES.map((lang) => (
                      <option key={lang.code} value={lang.code}>
                        {lang.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex-1 flex flex-col gap-1.5">
                  <label htmlFor="upload-text-lang" className="text-[11px] font-medium text-text-secondary">
                    Bahasa Judul/Deskripsi
                  </label>
                  <select
                    id="upload-text-lang"
                    value={defaultLanguage}
                    onChange={(e) => setDefaultLanguage(e.target.value)}
                    className={cn(
                      'rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-text-primary',
                      'focus:outline-none focus:ring-1 focus:ring-accent transition-micro'
                    )}
                  >
                    {YOUTUBE_LANGUAGES.map((lang) => (
                      <option key={lang.code} value={lang.code}>
                        {lang.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Custom Thumbnail Setting */}
              <div className="flex flex-col gap-1.5">
                <label className="text-[11px] font-medium text-text-secondary">
                  Custom Thumbnail (Opsional)
                </label>
                <div className="flex gap-2 items-center">
                  <input
                    type="text"
                    readOnly
                    value={customThumbnailPath}
                    placeholder="Gunakan thumbnail otomatis / pilih gambar kustom…"
                    className="flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-text-primary truncate"
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      const filePath = await ipc.dialog.openFile();
                      if (filePath) setCustomThumbnailPath(filePath);
                    }}
                    className="rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-background transition-micro"
                  >
                    Pilih File
                  </button>
                  {customThumbnailPath && (
                    <button
                      type="button"
                      onClick={() => setCustomThumbnailPath('')}
                      className="text-xs text-destructive hover:underline"
                    >
                      Hapus
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {((selectedPlatforms.includes('youtube') && privacy === 'private_scheduled') || isScheduled) && (
            <div className="flex gap-2 animate-fade-in">
              <div className="flex-1 flex flex-col gap-1">
                <label className="text-[10px] font-medium text-text-secondary uppercase">Tanggal Publikasi</label>
                <input
                  type="date"
                  value={publishDate}
                  onChange={(e) => setPublishDate(e.target.value)}
                  required
                  className="rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                />
              </div>
              <div className="flex-1 flex flex-col gap-1">
                <label className="text-[10px] font-medium text-text-secondary uppercase">Waktu</label>
                <input
                  type="time"
                  value={publishTime}
                  onChange={(e) => setPublishTime(e.target.value)}
                  required
                  className="rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                />
              </div>
            </div>
          )}
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
            Saya memiliki hak atau izin atas materi ini, dan bertanggung jawab penuh atas kepatuhan hak cipta saat mengunggah.
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
            onClick={async () => {
              const tagsArray = tags.split(',').map((t: string) => t.trim().replace(/^#+/, '')).filter(Boolean);
              try {
                // Save latest metadata input values to database
                await ipc.clips.saveMetadata(clip.id, {
                  title,
                  description,
                  tags: tagsArray
                });
              } catch {}
              const publishAt = privacy === 'private_scheduled' ? getPublishAtIso() : undefined;
              onConfirm(selectedPlatforms, title, description, tagsArray, privacy, publishAt, selectedAccountIds, categoryId, defaultAudioLanguage, defaultLanguage, customThumbnailPath);
            }}
            disabled={
              uploading ||
              !title.trim() ||
              !rightsConfirmed ||
              (selectedPlatforms.includes('youtube') && privacy === 'private_scheduled' && !publishDate) ||
              selectedPlatforms.length === 0 ||
              selectedPlatforms.some(p => getPlatformAccounts(p).length > 0 && !getPlatformAccounts(p).some(a => selectedAccountIds.includes(a.id)))
            }
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
  const [videoNonce, setVideoNonce] = useState(0);
  const [commentatorModalOpen, setCommentatorModalOpen] = useState(false);

  const [captionVisible, setCaptionVisible] = useState(clip.subtitleStyle !== 'none');

  useEffect(() => {
    setCaptionVisible(clip.subtitleStyle !== 'none');
  }, [clip.subtitleStyle]);

  const getSavedCaptionStyle = () => {
    try {
      if (clip.optionsJson) {
        const opts = JSON.parse(clip.optionsJson);
        if (opts?.caption) return opts.caption;
        if (opts?.captionStyle) return opts.captionStyle;
        if (opts?.presetId) return { presetId: opts.presetId };
      }
      const saved = localStorage.getItem('clip-preview-settings');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed?.caption) return parsed.caption;
        if (parsed?.presetId) return { presetId: parsed.presetId };
      }
    } catch (e) {}
    return undefined;
  };

  const getCustomStyle = () => {
    try {
      const saved = localStorage.getItem('clip-preview-settings');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.caption) {
          let style = { ...parsed.caption };
          let y = parsed.captionY;

          if (style.presetId === 'none') {
            if (parsed.lastCustomCaption && parsed.lastCustomCaption.presetId !== 'none') {
              style = { ...parsed.lastCustomCaption };
            } else {
              style = {
                presetId: 'custom',
                font: 'Arial',
                fontSize: 80,
                position: 'lower-third',
                primaryColor: '#FFFFFF',
                outlineColor: '#000000',
                outlineSize: 4,
              };
            }
          }
          if (y === undefined || y === null) {
            y = parsed.lastCaptionY !== undefined && parsed.lastCaptionY !== null ? parsed.lastCaptionY : undefined;
          }

          return {
            ...style,
            captionY: y !== undefined && y !== null ? y : undefined,
          };
        }
      }
    } catch (e) {
      console.error('Failed to parse clip-preview-settings:', e);
    }
    return undefined;
  };

  const handleToggleCaption = async (visible: boolean) => {
    setCaptionVisible(visible);
    try {
      const customStyle = getCustomStyle();
      await ipc.clips.updateCaptionVisibility(clip.id, visible, customStyle);
    } catch (err) {
      console.error('Failed to toggle caption:', err);
    }
  };

  const [gistOpen, setGistOpen] = useState(false);
  const [gistResult, setGistResult] = useState<TrendAnalysisResult | null>(null);
  const [gistLoading, setGistLoading] = useState(false);
  const [gistError, setGistError] = useState<string | null>(null);

  const [scriptOpen, setScriptOpen] = useState(false);
  const [scriptText, setScriptText] = useState('');
  const [scriptSaving, setScriptSaving] = useState(false);

  const handleScriptEditToggle = async () => {
    if (scriptOpen) {
      setScriptOpen(false);
      return;
    }
    setScriptOpen(true);
    if (scriptText) return;

    const clipOpts = clip.optionsJson ? JSON.parse(clip.optionsJson) : {};
    let text = clipOpts.customScript || '';

    if (!text && hook) {
      try {
        const transcript = await ipc.transcribe.getTranscript(clip.projectId);
        if (transcript) {
          const wordsSource = transcript.words.length > 0
            ? transcript.words
            : (transcript.originalWords && transcript.originalWords.length > 0)
              ? transcript.originalWords
              : transcript.words;

          const clipWords = wordsSource
            .filter((w: { startMs: number; endMs: number; word: string }) => w.startMs >= hook.startMs && w.endMs <= hook.endMs)
            .map((w: { word: string }) => w.word)
            .join(' ');
          if (clipWords.trim()) text = clipWords;
        }
      } catch { /* ignore */ }
    }

    if (!text) {
      text = hook?.summary ?? '';
    }

    setScriptText(text);
  };

  const handleSaveScript = async () => {
    setScriptSaving(true);
    try {
      await ipc.clips.updateScript(clip.id, scriptText);
      clip.optionsJson = JSON.stringify({
        ...(clip.optionsJson ? JSON.parse(clip.optionsJson) : {}),
        customScript: scriptText
      });
      setScriptOpen(false);
    } catch (err) {
      setDubError(err instanceof Error ? err.message : 'Gagal menyimpan naskah.');
    } finally {
      setScriptSaving(false);
    }
  };

  const handleGistAuditToggle = async () => {
    if (gistOpen) {
      setGistOpen(false);
      return;
    }
    setGistOpen(true);
    if (gistResult) return;

    setGistLoading(true);
    setGistError(null);
    try {
      const clipOpts = clip.optionsJson ? JSON.parse(clip.optionsJson) : {};
      let clipText = clipOpts.customScript || (hook?.summary ?? '');

      if (!clipOpts.customScript && hook) {
        try {
          const transcript = await ipc.transcribe.getTranscript(clip.projectId);
          if (transcript) {
            const wordsSource = transcript.words.length > 0
              ? transcript.words
              : (transcript.originalWords && transcript.originalWords.length > 0)
                ? transcript.originalWords
                : transcript.words;

            const clipWords = wordsSource
              .filter((w: { startMs: number; endMs: number; word: string }) => w.startMs >= hook.startMs && w.endMs <= hook.endMs)
              .map((w: { word: string }) => w.word)
              .join(' ');
            if (clipWords.trim()) clipText = clipWords;
          }
        } catch { /* ignore */ }
      }

      const project = await ipc.projects.get(clip.projectId);
      const res = await ipc.youtube.analyzeTrend({
        topic: project.title,
        description: project.sourceUrl,
        userScript: clipText,
        regionCode: 'US'
      });
      setGistResult(res);
    } catch (err) {
      setGistError(err instanceof Error ? err.message : 'Audit failed.');
    } finally {
      setGistLoading(false);
    }
  };

  const [gistOptimizing, setGistOptimizing] = useState(false);
  const [gistOptimizationResult, setGistOptimizationResult] = useState<GistOptimizationResult | null>(null);
  const [analyzeVisual, setAnalyzeVisual] = useState(false);

  const handleGistOptimize = async () => {
    if (!gistResult || !hook) return;
    setGistOptimizing(true);
    setGistOptimizationResult(null);
    try {
      const clipOpts = clip.optionsJson ? JSON.parse(clip.optionsJson) : {};
      let clipText = clipOpts.customScript || hook.summary;
      
      if (!clipOpts.customScript) {
        try {
          const transcript = await ipc.transcribe.getTranscript(clip.projectId);
          if (transcript) {
            const wordsSource = transcript.words.length > 0
              ? transcript.words
              : (transcript.originalWords && transcript.originalWords.length > 0)
                ? transcript.originalWords
                : transcript.words;

            const clipWords = wordsSource
              .filter((w: { startMs: number; endMs: number; word: string }) => w.startMs >= hook.startMs && w.endMs <= hook.endMs)
              .map((w: { word: string }) => w.word)
              .join(' ');
            if (clipWords.trim()) clipText = clipWords;
          }
        } catch { /* ignore */ }
      }

      const project = await ipc.projects.get(clip.projectId);
      const clipDurationSec = hook ? (hook.endMs - hook.startMs) / 1000 : 30;
      const res = await ipc.youtube.optimizeGist({
        topic: project.title,
        originalIdea: project.sourceUrl,
        userScript: clipText,
        durationSec: clipDurationSec,
        clipId: clip.id,
        analyzeVisual
      });
      setGistOptimizationResult(res);
    } catch (err) {
      setGistError(err instanceof Error ? err.message : 'Optimization failed.');
    } finally {
      setGistOptimizing(false);
    }
  };

  const [optVoice, setOptVoice] = useState('en-US-GuyNeural');
  const [bgVolume, setBgVolume] = useState('samar'); // 'samar' (-12dB), 'pelan' (-24dB), 'senyap' (-99dB)

  const getDuckDb = (vol: string) => {
    if (vol === 'samar') return -12;
    if (vol === 'pelan') return -24;
    if (vol === 'uvr') return -999; // UVR AI vocal remover
    return -99; // senyap / mute
  };

  const handleDubCustom = async (voiceId: string) => {
    if (!gistOptimizationResult) return;
    setDubbing(true);
    setDubError(null);
    try {
      const customStyle = getCustomStyle();
      await ipc.clips.updateCaptionVisibility(clip.id, captionVisible, customStyle);
      await ipc.dub.start(clip.id, voiceId, getDuckDb(bgVolume), gistOptimizationResult.optimizedScript);
      setGistOpen(false);
    } catch (err) {
      setDubError(err instanceof Error ? err.message : 'Dubbing failed.');
    } finally {
      setDubbing(false);
      setVideoNonce((v) => v + 1);
    }
  };

  const DUB_VOICES = [
    { id: 'gemini-Puck-commentator', label: '✨ Gemini — Puck (Laki-laki Komentator)' },
    { id: 'gemini-Kore-commentator', label: '✨ Gemini — Kore (Perempuan Komentator)' },
    { id: 'id-ID-ArdiNeural',    label: '🇮🇩 Indonesian — Ardi (Male)'    },
    { id: 'id-ID-GadisNeural',   label: '🇮🇩 Indonesian — Gadis (Female)' },
    { id: 'google-id-ID-Neural2-B', label: '🇮🇩 Google Neural2 — Male B (Natural)' },
    { id: 'google-id-ID-Neural2-C', label: '🇮🇩 Google Neural2 — Male C (Natural)' },
    { id: 'google-id-ID-Neural2-A', label: '🇮🇩 Google Neural2 — Female A (Natural)' },
    { id: 'ms-MY-OsmanNeural',   label: '🇲🇾 Malay — Osman (Male)'        },
    { id: 'en-US-GuyNeural',     label: '🇺🇸 English — Guy (Male)'        },
    { id: 'en-US-JennyNeural',   label: '🇺🇸 English — Jenny (Female)'    },
    { id: 'google-en-US-Neural2-D', label: '🇺🇸 Google Neural2 — Male D (Natural)' },
    { id: 'google-en-US-Neural2-F', label: '🇺🇸 Google Neural2 — Female F (Natural)' },
    { id: 'ja-JP-KeitaNeural',   label: '🇯🇵 Japanese — Keita (Male)'     },
    { id: 'google-ja-JP-Neural2-C', label: '🇯🇵 Google Neural2 — Male C (Natural)' },
    { id: 'google-ja-JP-Neural2-B', label: '🇯🇵 Google Neural2 — Female B (Natural)' },
    { id: 'zh-CN-YunxiNeural',   label: '🇨🇳 Chinese — Yunxi (Male)'      },
  ];

  const handleDub = async (voice: string) => {
    setShowDubMenu(false);
    setDubbing(true);
    setDubError(null);
    try {
      const customStyle = getCustomStyle();
      await ipc.clips.updateCaptionVisibility(clip.id, captionVisible, customStyle);
      await ipc.dub.start(clip.id, voice, getDuckDb(bgVolume));
    } catch (err) {
      setDubError(err instanceof Error ? err.message : 'Dubbing failed.');
    } finally {
      setDubbing(false);
      setVideoNonce((v) => v + 1);
    }
  };

  useIpcEvent<{ clipId: string; percent: number; eta: string }>(
    'clip:progress',
    (data) => {
      if (data.clipId !== clip.id) return;
      setProgress(data.percent);
      setEta(data.eta);
      if (data.percent >= 100) {
        setVideoNonce((v) => v + 1);
      }
    },
    [clip.id]
  );

  const videoSrc = clip.outputPath
    ? `localfile:///${clip.outputPath.replace(/\\/g, '/')}?v=${videoNonce}`
    : null;

  const handlePreview = () => {
    if (videoSrc) {
      setPreviewOpen(true);
    } else if (clip.outputPath) {
      void ipc.shell.openPath(clip.outputPath);
    }
  };

  const handleUploadClick = () => {
    setUploadError(null);
    setUploadDialogOpen(true);
  };

  const handleUploadConfirm = async (
    platforms: Array<'youtube' | 'tiktok' | 'facebook' | 'telegram'>,
    title: string,
    description: string,
    tags: string[],
    privacy: PrivacySetting,
    publishAt?: string,
    accountIds?: string[],
    categoryId?: string,
    defaultAudioLanguage?: string,
    defaultLanguage?: string,
    customThumbnailPath?: string
  ) => {
    setUploading(true);
    setUploadError(null);
    try {
      await ipc.upload.start({
        clipId: clip.id,
        platforms,
        accountIds,
        title,
        description,
        tags,
        privacy,
        publishAt,
        categoryId,
        defaultAudioLanguage,
        defaultLanguage,
        customThumbnailPath,
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
          onConfirm={(platforms, title, desc, tags, privacy, publishAt, accountIds, categoryId, audioLang, textLang, thumbPath) => void handleUploadConfirm(platforms, title, desc, tags, privacy, publishAt, accountIds, categoryId, audioLang, textLang, thumbPath)}
          onCancel={() => { setUploadDialogOpen(false); setUploadError(null); }}
          uploading={uploading}
          error={uploadError}
        />
      )}

      {/* AI Commentator modal */}
      {commentatorModalOpen && clip.outputPath && (
        <CommentatorModal
          videoPath={clip.outputPath}
          clipId={clip.id}
          projectId={clip.projectId}
          optionsJson={clip.optionsJson ?? undefined}
          initialCaptionStyle={getSavedCaptionStyle()}
          initialPresetId={(() => {
            const style = getSavedCaptionStyle();
            return (style?.presetId && (style.presetId as string) !== 'none' ? (style.presetId as any) : undefined);
          })()}
          onClose={() => setCommentatorModalOpen(false)}
          onSuccess={() => {
            setVideoNonce((n) => n + 1);
            if (typeof window !== 'undefined') {
              window.dispatchEvent(new CustomEvent('clips:updated'));
            }
          }}
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
            <div className="flex flex-col gap-1 mt-1">
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
              {clip.tiktokUrl && (
                <a
                  href={clip.tiktokUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] text-accent underline underline-offset-2 hover:no-underline"
                >
                  View on TikTok ↗
                </a>
              )}
              {clip.facebookUrl && (
                <a
                  href={clip.facebookUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] text-accent underline underline-offset-2 hover:no-underline"
                >
                  View on Facebook ↗
                </a>
              )}
            </div>
          </div>
        </div>

        {/* Progress bar — only while processing or pending */}
        {(clip.status === 'processing' || clip.status === 'pending') && (
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

              {/* Edit Naskah Button */}
              <IconButton
                label="Edit Script / Naskah"
                onClick={() => void handleScriptEditToggle()}
                disabled={scriptSaving || dubbing}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                  aria-hidden="true">
                  <path d="M12 20h9"/>
                  <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
                </svg>
                Edit Naskah
              </IconButton>

              {/* AI Commentator Button */}
              <button
                type="button"
                onClick={() => setCommentatorModalOpen(true)}
                className="flex items-center gap-1.5 rounded-md border border-indigo-500/40 bg-indigo-500/10 px-2.5 py-1.5 text-xs font-semibold text-indigo-400 hover:bg-indigo-500/20 hover:border-indigo-500/60 transition-micro"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                </svg>
                Commentator
              </button>

              {/* Background Volume Selector */}
              <div className="flex items-center gap-1.5 mr-1">
                <span className="text-[10px] text-text-secondary whitespace-nowrap">Audio Latar:</span>
                <select
                  value={bgVolume}
                  onChange={(e) => setBgVolume(e.target.value)}
                  className="bg-surface text-text-primary text-[10px] rounded px-1.5 py-1 border border-border focus:outline-none cursor-pointer"
                >
                  <option value="samar">Samar (-12dB)</option>
                  <option value="pelan">Pelan (-24dB)</option>
                  <option value="uvr">✨ Hilangkan Vokal Asli (UVR)</option>
                  <option value="senyap">Senyap (Mute)</option>
                </select>
              </div>

              {/* Caption Visibility Toggle */}
              <div className="flex items-center gap-1.5 border border-border rounded-md px-2 py-1 bg-surface/50 select-none h-[30px]">
                <input
                  type="checkbox"
                  id={`caption-toggle-${clip.id}`}
                  checked={captionVisible}
                  onChange={(e) => void handleToggleCaption(e.target.checked)}
                  disabled={dubbing}
                  className="rounded border-border text-accent focus:ring-accent accent-accent cursor-pointer h-3.5 w-3.5"
                />
                <label
                  htmlFor={`caption-toggle-${clip.id}`}
                  className="text-[10px] text-text-secondary font-medium cursor-pointer"
                >
                  Tampilkan Caption
                </label>
              </div>

              {/* Dub button */}
              <div className="relative">
                <IconButton
                  label="Dub with voice"
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
                    className="absolute bottom-full left-0 z-50 mb-1 w-64 max-h-60 overflow-y-auto rounded-md border border-border bg-surface shadow-lg"
                    onMouseLeave={() => setShowDubMenu(false)}
                  >
                    <p className="border-b border-border px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
                      Voice (replaces speech)
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

              {/* G.I.S.T. Audit Button */}
              <IconButton
                label="Audit G.I.S.T. Uniqueness"
                onClick={() => void handleGistAuditToggle()}
                disabled={gistLoading}
              >
                <span>🔬 G.I.S.T. Audit</span>
              </IconButton>
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

        {/* Script Editor Panel */}
        {scriptOpen && (
          <div className="mt-3 rounded-lg border border-border bg-background/30 p-3.5 space-y-3 animate-fade-in text-left">
            <div className="flex items-center justify-between border-b border-border/40 pb-2">
              <span className="text-[10px] font-bold text-accent uppercase tracking-wider flex items-center gap-1">
                <span>📝</span> Edit Naskah (Dubbing Script)
              </span>
              <button 
                type="button" 
                onClick={() => setScriptOpen(false)}
                className="text-[10px] text-text-secondary hover:text-text-primary transition-micro"
              >
                Batal
              </button>
            </div>
            
            <textarea
              value={scriptText}
              onChange={(e) => setScriptText(e.target.value)}
              rows={4}
              placeholder="Masukkan naskah kustom untuk dubbing..."
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-xs text-text-primary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent font-mono leading-relaxed"
            />

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setScriptOpen(false)}
                className="rounded border border-border px-3 py-1.5 text-[10px] font-medium text-text-secondary hover:border-accent/40 hover:text-text-primary transition-micro"
              >
                Batal
              </button>
              <button
                type="button"
                disabled={scriptSaving}
                onClick={() => void handleSaveScript()}
                className="rounded bg-accent px-3 py-1.5 text-[10px] font-semibold text-accent-foreground hover:bg-accent/90 transition-micro flex items-center gap-1.5"
              >
                {scriptSaving && <span className="h-2.5 w-2.5 animate-spin rounded-full border border-accent-foreground/30 border-t-accent-foreground" />}
                {scriptSaving ? 'Menyimpan…' : 'Simpan Naskah'}
              </button>
            </div>
          </div>
        )}

        {/* G.I.S.T. Audit Panel */}
        {gistOpen && (
          <div className="mt-3 rounded-lg border border-border bg-background/30 p-3.5 space-y-3 animate-fade-in text-left">
            <div className="flex items-center justify-between border-b border-border/40 pb-2 flex-wrap gap-1">
              <span className="text-[10px] font-bold text-accent uppercase tracking-wider flex items-center gap-1">
                <span>🔬</span> G.I.S.T. Uniqueness Audit (YouTube 2026)
              </span>
              <button 
                type="button" 
                onClick={() => setGistOpen(false)}
                className="text-[10px] text-text-secondary hover:text-text-primary transition-micro"
              >
                Tutup
              </button>
            </div>

            {gistLoading && (
              <div className="flex flex-col items-center justify-center py-4 text-center">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                <p className="text-[10px] text-text-secondary mt-1.5 animate-pulse">Menghitung Net Information Gain...</p>
              </div>
            )}

            {gistError && (
              <p className="text-xs text-destructive">{gistError}</p>
            )}

            {!gistLoading && gistResult?.gistAudit && (
              <div className="space-y-3">
                <div className="flex items-center justify-between flex-wrap gap-1.5">
                  <span className="text-[10px] font-semibold text-text-secondary">Jangkauan Konten:</span>
                  {gistResult.gistAudit.conflictRadiusRisk === 'duplicate' && (
                    <span className="rounded bg-destructive/15 px-2.5 py-0.5 text-[10px] font-bold text-destructive">
                      Duplikat (Limit: 0 - 1k views) ⚠️
                    </span>
                  )}
                  {gistResult.gistAudit.conflictRadiusRisk === 'somewhat_transformative' && (
                    <span className="rounded bg-amber-500/15 px-2.5 py-0.5 text-[10px] font-bold text-amber-500">
                      Somewhat Transformative (Limit: ~30k views) ⚠️
                    </span>
                  )}
                  {gistResult.gistAudit.conflictRadiusRisk === 'significantly_transformative' && (
                    <span className="rounded bg-success/15 px-2.5 py-0.5 text-[10px] font-bold text-success">
                      Significantly Transformative (No Limit) ✅
                    </span>
                  )}
                </div>

                <div className="space-y-2 pt-1 border-t border-border/40">
                  <div>
                    <div className="flex items-center justify-between text-[10px] text-text-secondary mb-0.5">
                      <span>Net Information Gain (Token 7 & 8)</span>
                      <span className="font-bold text-text-primary">{gistResult.gistAudit.netInformationGain}%</span>
                    </div>
                    <div className="h-1.5 w-full rounded bg-border/40 overflow-hidden">
                      <div 
                        className={cn(
                          "h-full transition-all duration-300", 
                          gistResult.gistAudit.netInformationGain > 70 ? "bg-success" : 
                          gistResult.gistAudit.netInformationGain > 35 ? "bg-amber-500" : "bg-destructive"
                        )} 
                        style={{ width: `${gistResult.gistAudit.netInformationGain}%` }}
                      />
                    </div>
                  </div>
                  
                  <div>
                    <div className="flex items-center justify-between text-[10px] text-text-secondary mb-0.5">
                      <span>Kemiripan Ide (Similarity Score)</span>
                      <span className="font-bold text-text-primary">{gistResult.gistAudit.similarityScore}%</span>
                    </div>
                    <div className="h-1.5 w-full rounded bg-border/40 overflow-hidden">
                      <div 
                        className={cn(
                          "h-full transition-all duration-300", 
                          gistResult.gistAudit.similarityScore > 75 ? "bg-destructive" : 
                          gistResult.gistAudit.similarityScore > 35 ? "bg-amber-500" : "bg-success"
                        )} 
                        style={{ width: `${gistResult.gistAudit.similarityScore}%` }}
                      />
                    </div>
                  </div>
                </div>

                <div className="text-[10px] space-y-1.5 pt-1.5 border-t border-border/40 leading-relaxed text-text-secondary">
                  <p><strong className="text-text-primary">Token 7 (Idea Overlap):</strong> {gistResult.gistAudit.originalIdeaOverlap}</p>
                  <p><strong className="text-text-primary">Token 8 (Delivery Overlap):</strong> {gistResult.gistAudit.deliveryOverlap}</p>
                </div>

                <div className="pt-1.5 border-t border-border/40 text-[10px]">
                  <strong className="block text-text-primary mb-1">Taktik Agar Lolos Limit Algoritma:</strong>
                  <ul className="list-disc list-inside text-text-secondary space-y-1 pl-0.5 leading-relaxed">
                    {gistResult.gistAudit.diversityActionPlan.map((step, idx) => (
                      <li key={idx}>{step}</li>
                    ))}
                  </ul>
                </div>

                {/* G.I.S.T. Rewrite/Optimization Option */}
                <div className="pt-2 border-t border-border/40 space-y-2">
                  <label className="flex items-center gap-2 text-[10px] text-text-secondary cursor-pointer pb-1 select-none">
                    <input
                      type="checkbox"
                      checked={analyzeVisual}
                      onChange={(e) => setAnalyzeVisual(e.target.checked)}
                      className="rounded border-border bg-background text-accent focus:ring-accent focus:ring-offset-0 focus:outline-none"
                    />
                    <span>Sertakan Analisis Visual Video (Multimodal)</span>
                  </label>

                  <button
                    type="button"
                    disabled={gistOptimizing}
                    onClick={() => void handleGistOptimize()}
                    className="w-full rounded bg-accent/10 hover:bg-accent/20 border border-accent/30 py-1.5 text-[10px] font-semibold text-accent transition-micro flex items-center justify-center gap-1"
                  >
                    {gistOptimizing ? (
                      <>
                        <span className="h-2.5 w-2.5 animate-spin rounded-full border border-accent/30 border-t-accent" />
                        Mengoptimalkan Video...
                      </>
                    ) : (
                      <>✨ Optimasi Otomatis (G.I.S.T. Rewrite)</>
                    )}
                  </button>

                  {gistOptimizationResult && (
                    <div className="rounded border border-success/30 bg-success/5 p-2.5 space-y-1.5 text-[10px] animate-fade-in text-left">
                      <div className="text-success font-semibold flex items-center justify-between">
                        <span>Draf Naskah Rekomendasi (Lolos Limit):</span>
                        <button
                          type="button"
                          onClick={() => {
                            navigator.clipboard.writeText(gistOptimizationResult.optimizedScript).catch(() => {});
                          }}
                          className="text-[9px] text-accent underline hover:no-underline"
                          title="Salin ke clipboard"
                        >
                          Salin Naskah
                        </button>
                      </div>
                      <p className="italic text-text-primary bg-background/50 p-1.5 rounded max-h-20 overflow-y-auto font-mono">
                        "{gistOptimizationResult.optimizedScript}"
                      </p>
                      <p className="text-text-secondary leading-normal">
                        <strong className="text-text-primary">Penjelasan:</strong> {gistOptimizationResult.explanation}
                      </p>
                      <div className="flex flex-wrap items-center gap-2 pt-1.5 border-t border-success/20">
                        <div className="flex items-center gap-1">
                          <span className="text-[9px] text-text-secondary">Suara:</span>
                          <select
                            value={optVoice}
                            onChange={(e) => setOptVoice(e.target.value)}
                            className="bg-surface text-text-primary text-[9px] rounded px-1.5 py-1 border border-border/80 focus:outline-none"
                          >
                            {DUB_VOICES.map(({ id, label }) => (
                              <option key={id} value={id}>{label}</option>
                            ))}
                          </select>
                        </div>
                        
                        <div className="flex items-center gap-1">
                          <span className="text-[9px] text-text-secondary">Audio Latar:</span>
                          <select
                            value={bgVolume}
                            onChange={(e) => setBgVolume(e.target.value)}
                            className="bg-surface text-text-primary text-[9px] rounded px-1.5 py-1 border border-border/80 focus:outline-none"
                          >
                            <option value="samar">Samar (-12dB)</option>
                            <option value="pelan">Pelan (-24dB)</option>
                            <option value="uvr">✨ Hilangkan Vokal Asli (UVR)</option>
                            <option value="senyap">Senyap (Mute)</option>
                          </select>
                        </div>

                        <button
                          type="button"
                          disabled={dubbing}
                          onClick={() => void handleDubCustom(optVoice)}
                          className="ml-auto rounded bg-success/20 hover:bg-success/30 px-2.5 py-1 text-[9px] font-bold text-success transition-micro"
                        >
                          {dubbing ? 'Memproses Dub...' : '✨ Terapkan & Dubbing Otomatis'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
