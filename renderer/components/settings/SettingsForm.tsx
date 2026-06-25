'use client';

/**
 * SettingsForm — controlled form for all AppSettings sections.
 * Requirements: 8.1, 8.3–8.6, 8.12
 */

import { useState, useEffect } from 'react';
import { SegmentedControl } from '../ui/SegmentedControl';
import { ipc } from '../../lib/ipc-client';
import type { AppSettings, SubtitleStyle, SubtitlePosition, WhisperModelSize } from '../../../shared/types';
import { cn } from '../../lib/utils';

interface SettingsFormProps {
  settings: AppSettings;
  onSaved: () => void;
  onError: (msg: string) => void;
}

const QUALITY_OPTS   = [{ value: '1080p', label: '1080p' }, { value: '720p', label: '720p' }, { value: '480p', label: '480p' }, { value: '360p', label: '360p' }];
const STYLE_OPTS     = [{ value: 'bold-white', label: 'Bold White' }, { value: 'gradient-pop', label: 'Gradient Pop' }, { value: 'minimal-clean', label: 'Minimal' }];
const POSITION_OPTS  = [{ value: 'lower-third', label: 'Lower' }, { value: 'upper-third', label: 'Upper' }, { value: 'center', label: 'Center' }];
const WHISPER_OPTS   = [{ value: 'tiny', label: 'Tiny' }, { value: 'base', label: 'Base' }, { value: 'small', label: 'Small' }, { value: 'medium', label: 'Medium' }, { value: 'large', label: 'Large' }];

function SectionHeader({ title }: { title: string }) {
  return (
    <h3 className="mb-3 text-xs font-semibold uppercase tracking-widest text-text-secondary border-b border-border pb-2">
      {title}
    </h3>
  );
}

function Field({ label, id, children }: { label: string; id?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-text-primary">{label}</label>
      {children}
    </div>
  );
}

function TextInput({ id, value, onChange, placeholder }: {
  id: string; value: string; onChange: (v: string) => void; placeholder?: string;
}) {
  return (
    <input
      id={id}
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={cn(
        'rounded-md border border-border bg-background px-3 py-2 text-sm text-text-primary',
        'placeholder:text-text-secondary/50',
        'focus:outline-none focus:ring-2 focus:ring-accent transition-micro'
      )}
    />
  );
}

function BrowseField({ id, label, value, onChange }: {
  id: string; label: string; value: string; onChange: (v: string) => void;
}) {
  const handleBrowse = async () => {
    const dir = await ipc.dialog.openDirectory();
    if (dir) onChange(dir);
  };

  return (
    <Field label={label} id={id}>
      <div className="flex gap-2">
        <input
          id={id}
          type="text"
          readOnly
          value={value}
          placeholder="Not set"
          className={cn(
            'flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm text-text-primary',
            'placeholder:text-text-secondary/50 cursor-default',
            'focus:outline-none focus:ring-2 focus:ring-accent'
          )}
        />
        <button
          type="button"
          aria-label={`Browse for ${label}`}
          onClick={() => void handleBrowse()}
          className={cn(
            'rounded-md border border-border px-3 py-2 text-sm text-text-secondary',
            'hover:border-accent/40 hover:text-text-primary transition-micro',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'
          )}
        >
          Browse…
        </button>
      </div>
    </Field>
  );
}

export function SettingsForm({ settings, onSaved, onError }: SettingsFormProps) {
  const [form, setForm] = useState<AppSettings>({ ...settings });
  const [saving, setSaving] = useState(false);
  const [authStatus, setAuthStatus] = useState<{ authenticated: boolean; email?: string } | null>(null);

  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  // Load auth status once on mount
  useEffect(() => {
    void ipc.upload.getAuthStatus().then(setAuthStatus).catch(() => {});
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await ipc.settings.set(form);
      onSaved();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to save settings.');
    } finally {
      setSaving(false);
    }
  };

  const handleConnect = async () => {
    if (!form.youtubeClientId || !form.youtubeClientSecret) {
      onError('Please enter YouTube Client ID and Client Secret first, then save settings before connecting.');
      return;
    }
    try {
      await ipc.upload.startAuth();
      const status = await ipc.upload.getAuthStatus();
      setAuthStatus(status);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Authentication failed.');
    }
  };

  return (
    <form id="settings-form" onSubmit={(e) => void handleSave(e)} className="flex flex-col gap-8">

      {/* ── Directories ── */}
      <div>
        <SectionHeader title="Directories" />
        <div className="flex flex-col gap-4">
          <BrowseField id="setting-download-dir" label="Download Directory"
            value={form.downloadDir} onChange={(v) => set('downloadDir', v)} />
          <BrowseField id="setting-export-dir" label="Export Directory"
            value={form.exportDir} onChange={(v) => set('exportDir', v)} />
        </div>
      </div>

      {/* ── AI Models ── */}
      <div>
        <SectionHeader title="AI Models" />
        <div className="flex flex-col gap-4">
          <Field label="Whisper Model Size" id="setting-whisper-model">
            <SegmentedControl
              id="setting-whisper-model"
              aria-label="Whisper model size"
              options={WHISPER_OPTS}
              value={form.whisperModelSize}
              onChange={(v) => set('whisperModelSize', v as WhisperModelSize)}
            />
            <p className="text-[10px] text-text-secondary mt-1">
              {form.whisperModelSize === 'tiny'   && '⚡ Fastest — ~1 min/10 min video. Lower accuracy.'}
              {form.whisperModelSize === 'base'   && '⚡ Fast — ~2 min/10 min video. Good accuracy.'}
              {form.whisperModelSize === 'small'  && '⚖ Balanced — ~4 min/10 min video.'}
              {form.whisperModelSize === 'medium' && '🐢 Slow on CPU — ~10 min/10 min video. High accuracy.'}
              {form.whisperModelSize === 'large'  && '🐢 Very slow on CPU — ~20+ min/10 min video. Best accuracy.'}
            </p>
          </Field>
          <Field label="Ollama Model" id="setting-ollama-model">
            <TextInput id="setting-ollama-model" value={form.ollamaModel}
              onChange={(v) => set('ollamaModel', v)} placeholder="llama3" />
          </Field>
        </div>
      </div>

      {/* ── Subtitle Defaults ── */}
      <div>
        <SectionHeader title="Subtitle Defaults" />
        <div className="flex flex-col gap-4">
          <Field label="Default Subtitle Style" id="setting-subtitle-style">
            <SegmentedControl
              id="setting-subtitle-style"
              aria-label="Default subtitle style"
              options={STYLE_OPTS}
              value={form.defaultSubtitleStyle}
              onChange={(v) => set('defaultSubtitleStyle', v as SubtitleStyle)}
            />
          </Field>
          <Field label="Default Subtitle Position" id="setting-subtitle-position">
            <SegmentedControl
              id="setting-subtitle-position"
              aria-label="Default subtitle position"
              options={POSITION_OPTS}
              value={form.defaultSubtitlePosition}
              onChange={(v) => set('defaultSubtitlePosition', v as SubtitlePosition)}
            />
          </Field>
        </div>
      </div>

      {/* ── Video ── */}
      <div>
        <SectionHeader title="Video" />
        <Field label="Default Download Quality" id="setting-video-quality">
          <SegmentedControl
            id="setting-video-quality"
            aria-label="Default video quality"
            options={QUALITY_OPTS}
            value={form.defaultVideoQuality}
            onChange={(v) => set('defaultVideoQuality', v as AppSettings['defaultVideoQuality'])}
          />
        </Field>
      </div>

      {/* ── Translation ── */}
      <div>
        <SectionHeader title="Translation" />
        <div className="flex flex-col gap-4">
          <Field label="Default Translation Language" id="setting-translation-lang">
            <select
              id="setting-translation-lang"
              value={form.translationLanguage ?? ''}
              onChange={(e) => set('translationLanguage', e.target.value)}
              className={cn(
                'rounded-md border border-border bg-background px-3 py-2 text-sm text-text-primary',
                'focus:outline-none focus:ring-2 focus:ring-accent transition-micro'
              )}
            >
              <option value="">No translation (keep original)</option>
              <option value="id">🇮🇩 Indonesian (Bahasa Indonesia)</option>
              <option value="en">🇺🇸 English</option>
              <option value="es">🇪🇸 Spanish</option>
              <option value="fr">🇫🇷 French</option>
              <option value="de">🇩🇪 German</option>
              <option value="ja">🇯🇵 Japanese</option>
              <option value="ko">🇰🇷 Korean</option>
              <option value="zh">🇨🇳 Chinese (Simplified)</option>
              <option value="pt">🇧🇷 Portuguese</option>
              <option value="ms">🇲🇾 Malay</option>
            </select>
            <p className="text-[10px] text-text-secondary mt-1">
              When set, transcript will be auto-translated after transcription. Uses DeepL if key set, else Ollama.
            </p>
          </Field>

          <Field label="DeepL API Key" id="setting-deepl-key">
            <TextInput
              id="setting-deepl-key"
              value={(form as AppSettings & { deeplApiKey?: string }).deeplApiKey ?? ''}
              onChange={(v) => set('deeplApiKey' as keyof AppSettings, v as never)}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx:fx (free) or pro key"
            />
            <p className="text-[10px] text-text-secondary mt-1">
              Free tier: 500K chars/month. Get key at{' '}
              <a href="https://www.deepl.com/pro-api" target="_blank" rel="noopener noreferrer"
                className="text-accent underline">deepl.com/pro-api</a>.
              Free keys end with <code>:fx</code>.
            </p>
          </Field>

          <Field label="Google Cloud TTS API Key" id="setting-google-tts-key">
            <TextInput
              id="setting-google-tts-key"
              value={(form as AppSettings & { googleTtsApiKey?: string }).googleTtsApiKey ?? ''}
              onChange={(v) => set('googleTtsApiKey' as keyof AppSettings, v as never)}
              placeholder="AIza..."
            />
            <p className="text-[10px] text-text-secondary mt-1">
              Free: 1M chars WaveNet/month. Get key at{' '}
              <a href="https://console.cloud.google.com/apis/library/texttospeech.googleapis.com"
                target="_blank" rel="noopener noreferrer" className="text-accent underline">
                Google Cloud Console
              </a>. Without key, falls back to edge-tts (Microsoft Neural, free).
            </p>
          </Field>

          <Field label="Deepgram API Key" id="setting-deepgram-key">
            <TextInput
              id="setting-deepgram-key"
              value={(form as AppSettings & { deepgramApiKey?: string }).deepgramApiKey ?? ''}
              onChange={(v) => set('deepgramApiKey' as keyof AppSettings, v as never)}
              placeholder="Token xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
            />
            <p className="text-[10px] text-text-secondary mt-1">
              Nova-2 model — more accurate than Whisper, faster. Free $200 credit. Get key at{' '}
              <a href="https://console.deepgram.com" target="_blank" rel="noopener noreferrer"
                className="text-accent underline">console.deepgram.com</a>.
              Without key, falls back to local Whisper.
            </p>
          </Field>

          <Field label="Google Cloud Speech-to-Text (Service Account)" id="setting-google-stt-sa">
            <div className="flex gap-2">
              <TextInput
                id="setting-google-stt-sa"
                value={(form as AppSettings & { googleSttServiceAccountPath?: string }).googleSttServiceAccountPath ?? ''}
                onChange={(v) => set('googleSttServiceAccountPath' as keyof AppSettings, v as never)}
                placeholder="C:\path\to\service-account.json"
              />
              <button
                type="button"
                onClick={async () => {
                  try {
                    const filePath = await ipc.dialog.openFile();
                    if (filePath) set('googleSttServiceAccountPath' as keyof AppSettings, filePath as never);
                  } catch { /* cancelled */ }
                }}
                className="shrink-0 rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium hover:bg-surface-hover transition-micro"
              >
                Browse
              </button>
            </div>
            <p className="text-[10px] text-text-secondary mt-1">
              Chirp 2 model — same technology used by YouTube captions. Highest accuracy.{' '}
              Create a Service Account with Speech-to-Text permission at{' '}
              <a href="https://console.cloud.google.com/iam-admin/serviceaccounts"
                target="_blank" rel="noopener noreferrer" className="text-accent underline">
                Google Cloud Console → IAM → Service Accounts
              </a>, then download the JSON key file.
              Priority: Google STT → Deepgram → Whisper.
            </p>
          </Field>

          <Field label="Gemini API Key (Hook Detection)" id="setting-gemini-key">
            <TextInput
              id="setting-gemini-key"
              value={(form as AppSettings & { geminiApiKey?: string }).geminiApiKey ?? ''}
              onChange={(v) => set('geminiApiKey' as keyof AppSettings, v as never)}
              placeholder="AQ.Ab8... or AIzaSy..."
            />
            <p className="text-[10px] text-text-secondary mt-1">
              Gemini 2.5 Flash — fast &amp; accurate hook/segment detection (replaces Ollama). Get key at{' '}
              <a href="https://aistudio.google.com/apikey"
                target="_blank" rel="noopener noreferrer" className="text-accent underline">
                AI Studio
              </a>{' '}or use Vertex AI Express key.
              Priority: Gemini → Ollama.
            </p>
          </Field>
        </div>
      </div>

      {/* ── YouTube Account ── */}
      <div>
        <SectionHeader title="YouTube Account" />
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between rounded-md border border-border bg-background px-4 py-3">
            <div>
              <p className="text-sm font-medium text-text-primary">
                {authStatus?.authenticated ? 'Connected' : 'Not connected'}
              </p>
              {authStatus?.email && (
                <p className="text-xs text-text-secondary">{authStatus.email}</p>
              )}
            </div>
            <button
              type="button"
              id="youtube-auth-btn"
              onClick={() => void handleConnect()}
              className={cn(
                'rounded-md border px-3 py-1.5 text-xs font-medium transition-micro',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                authStatus?.authenticated
                  ? 'border-destructive/40 text-destructive hover:bg-destructive/10'
                  : 'border-accent/40 text-accent hover:bg-accent/10'
              )}
            >
              {authStatus?.authenticated ? 'Disconnect' : 'Connect'}
            </button>
          </div>
          <div className="flex flex-col gap-3">
            <Field label="YouTube Client ID" id="setting-yt-client-id">
              <TextInput id="setting-yt-client-id" value={form.youtubeClientId}
                onChange={(v) => set('youtubeClientId', v)} placeholder="OAuth 2.0 Client ID" />
            </Field>
            <Field label="YouTube Client Secret" id="setting-yt-client-secret">
              <TextInput id="setting-yt-client-secret" value={form.youtubeClientSecret}
                onChange={(v) => set('youtubeClientSecret', v)} placeholder="OAuth 2.0 Client Secret" />
            </Field>
          </div>
        </div>
      </div>

      {/* ── Save button ── */}
      <button
        type="submit"
        id="settings-save-btn"
        disabled={saving}
        className={cn(
          'self-start rounded-md bg-accent px-6 py-2.5 text-sm font-semibold text-accent-foreground',
          'hover:bg-accent-hover transition-micro',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          'disabled:opacity-50 disabled:cursor-not-allowed'
        )}
      >
        {saving ? 'Saving…' : 'Save Settings'}
      </button>
    </form>
  );
}
