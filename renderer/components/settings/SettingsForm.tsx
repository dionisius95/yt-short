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

const QUALITY_OPTS = [{ value: '1080p', label: '1080p' }, { value: '720p', label: '720p' }, { value: '480p', label: '480p' }, { value: '360p', label: '360p' }];
const STYLE_OPTS = [{ value: 'bold-white', label: 'Bold White' }, { value: 'gradient-pop', label: 'Gradient Pop' }, { value: 'minimal-clean', label: 'Minimal' }, { value: 'none', label: 'Tidak Ditampilkan (None)' }];
const POSITION_OPTS = [{ value: 'lower-third', label: 'Lower' }, { value: 'upper-third', label: 'Upper' }, { value: 'center', label: 'Center' }];
const WHISPER_OPTS = [{ value: 'tiny', label: 'Tiny' }, { value: 'base', label: 'Base' }, { value: 'small', label: 'Small' }, { value: 'medium', label: 'Medium' }, { value: 'large', label: 'Large' }];

function SectionHeader({ title }: { title: string }) {
  return (
    <h3 className="mb-3 text-xs font-semibold uppercase tracking-widest text-text-secondary border-b border-border pb-2">
      {title}
    </h3>
  );
}

function Field({ label, id, description, children }: { label: string; id?: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-text-primary">{label}</label>
      {children}
      {description && <p className="text-xs text-text-secondary">{description}</p>}
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
    void ipc.upload.getAuthStatus().then(setAuthStatus).catch(() => { });
  }, []);

  const [tgOtpModal, setTgOtpModal] = useState(false);
  const [tgPhoneCodeHash, setTgPhoneCodeHash] = useState('');
  const [tgTempSession, setTgTempSession] = useState('');
  const [tgOtpCode, setTgOtpCode] = useState('');
  const [tg2faPassword, setTg2faPassword] = useState('');
  const [tgConnecting, setTgConnecting] = useState(false);

  const handleSendTgCode = async () => {
    if (!form.telegramApiId || !form.telegramApiHash || !form.telegramPhone) {
      onError('Lengkapi API ID, API Hash, dan Nomor HP terlebih dahulu.');
      return;
    }
    setTgConnecting(true);
    try {
      const res = await ipc.telegram.sendCode({
        apiId: Number(form.telegramApiId),
        apiHash: form.telegramApiHash,
        phoneNumber: form.telegramPhone,
      });
      setTgPhoneCodeHash(res.phoneCodeHash);
      setTgTempSession(res.tempSession);
      setTgOtpModal(true);
    } catch (err: any) {
      onError(err.message || 'Gagal mengirim kode OTP Telegram.');
    } finally {
      setTgConnecting(false);
    }
  };

  const handleVerifyTgOtp = async () => {
    if (!tgOtpCode) return;
    setTgConnecting(true);
    try {
      const sessionString = await ipc.telegram.signIn({
        apiId: Number(form.telegramApiId),
        apiHash: form.telegramApiHash!,
        phoneNumber: form.telegramPhone!,
        phoneCodeHash: tgPhoneCodeHash,
        phoneCode: tgOtpCode,
        tempSession: tgTempSession,
        password: tg2faPassword || undefined,
      });
      set('telegramSession', sessionString);
      setTgOtpModal(false);
      onSaved();
    } catch (err: any) {
      onError(err.message || 'Gagal memverifikasi OTP Telegram.');
    } finally {
      setTgConnecting(false);
    }
  };

  const [accounts, setAccounts] = useState<import('../../../shared/types').UploadAccount[]>([]);
  const [showAddAccountModal, setShowAddAccountModal] = useState<null | 'tiktok' | 'facebook' | 'telegram'>(null);
  const [accNameInput, setAccNameInput] = useState('');
  const [accField1Input, setAccField1Input] = useState('');
  const [accField2Input, setAccField2Input] = useState('');

  useEffect(() => {
    ipc.accounts.get().then((list) => {
      if (Array.isArray(list)) setAccounts(list);
    }).catch(() => { });
  }, []);

  const handleAddAccountSubmit = async () => {
    if (!showAddAccountModal || !accNameInput.trim()) return;
    const newAcc: import('../../../shared/types').UploadAccount = {
      id: `acc_${Date.now()}`,
      platform: showAddAccountModal,
      name: accNameInput.trim(),
      createdAt: Date.now(),
    };
    if (showAddAccountModal === 'tiktok') {
      newAcc.tiktokSessionId = accField1Input.trim();
    } else if (showAddAccountModal === 'facebook') {
      newAcc.facebookPageId = accField1Input.trim();
      newAcc.facebookAccessToken = accField2Input.trim();
    } else if (showAddAccountModal === 'telegram') {
      newAcc.telegramBotToken = accField1Input.trim();
      newAcc.telegramChatId = accField2Input.trim();
    }
    const updated = [...accounts, newAcc];
    setAccounts(updated);
    await ipc.accounts.save(updated);
    setShowAddAccountModal(null);
    setAccNameInput('');
    setAccField1Input('');
    setAccField2Input('');
  };

  const handleDeleteAccount = async (id: string) => {
    const updated = accounts.filter((a) => a.id !== id);
    setAccounts(updated);
    await ipc.accounts.save(updated);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await ipc.settings.set(form);
      await ipc.accounts.save(accounts);
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
      const list = await ipc.accounts.get();
      if (Array.isArray(list)) setAccounts(list);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Authentication failed.');
    }
  };

  const handleDisconnect = async () => {
    try {
      await ipc.upload.disconnectAuth();
      const status = await ipc.upload.getAuthStatus();
      setAuthStatus(status);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Disconnect failed.');
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
        <SectionHeader title="Models" />
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
              {form.whisperModelSize === 'tiny' && '⚡ Fastest — ~1 min/10 min video. Lower accuracy.'}
              {form.whisperModelSize === 'base' && '⚡ Fast — ~2 min/10 min video. Good accuracy.'}
              {form.whisperModelSize === 'small' && '⚖ Balanced — ~4 min/10 min video.'}
              {form.whisperModelSize === 'medium' && '🐢 Slow on CPU — ~10 min/10 min video. High accuracy.'}
              {form.whisperModelSize === 'large' && '🐢 Very slow on CPU — ~20+ min/10 min video. Best accuracy.'}
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
        <div className="flex flex-col gap-4">
          <Field label="Default Download Quality" id="setting-video-quality">
            <SegmentedControl
              id="setting-video-quality"
              aria-label="Default video quality"
              options={QUALITY_OPTS}
              value={form.defaultVideoQuality}
              onChange={(v) => set('defaultVideoQuality', v as AppSettings['defaultVideoQuality'])}
            />
          </Field>

          <Field label="YouTube Cookie Source" id="setting-cookies-browser">
            <select
              id="setting-cookies-browser"
              value={form.ytDlpCookiesBrowser ?? ''}
              onChange={(e) => set('ytDlpCookiesBrowser', e.target.value)}
              className={cn(
                'rounded-md border border-border bg-background px-3 py-2 text-sm text-text-primary',
                'focus:outline-none focus:ring-2 focus:ring-accent transition-micro'
              )}
            >
              <option value="">Disabled (no cookies)</option>
              <option value="chrome">Chrome</option>
              <option value="firefox">Firefox</option>
              <option value="edge">Microsoft Edge</option>
              <option value="brave">Brave</option>
              <option value="opera">Opera</option>
              <option value="chromium">Chromium</option>
              <option value="safari">Safari (macOS only)</option>
            </select>
            <p className="text-[10px] text-text-secondary mt-1">
              If YouTube shows a "Sign in to confirm you&apos;re not a bot" error, select the browser
              where you are logged into YouTube. yt-dlp will read cookies from that browser automatically.
              The browser must be <strong>closed</strong> or have the tab available when downloading.
            </p>
          </Field>
        </div>
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
              value={form.deeplApiKey ?? ''}
              onChange={(v) => set('deeplApiKey', v)}
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
              value={form.googleTtsApiKey ?? ''}
              onChange={(v) => set('googleTtsApiKey', v)}
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
              value={form.deepgramApiKey ?? ''}
              onChange={(v) => set('deepgramApiKey', v)}
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
                value={form.googleSttServiceAccountPath ?? ''}
                onChange={(v) => set('googleSttServiceAccountPath', v)}
                placeholder="C:\path\to\service-account.json"
              />
              <button
                type="button"
                onClick={async () => {
                  try {
                    const filePath = await ipc.dialog.openFile();
                    if (filePath) set('googleSttServiceAccountPath', filePath);
                  } catch { /* cancelled */ }
                }}
                className="rounded-md border border-border px-3 py-2 text-sm text-text-secondary hover:border-accent/40 hover:text-text-primary transition-micro"
              >
                Browse JSON…
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

          {/* ── Google Colab XTTS Voice Clone ── */}
          <div className="pt-2 border-t border-border mt-2">
            <Field label="Google Colab XTTS Voice Clone Server URL" id="setting-xtts-colab-url">
              <TextInput
                id="setting-xtts-colab-url"
                value={form.xttsColabUrl ?? ''}
                onChange={(v) => set('xttsColabUrl', v)}
                placeholder="https://xxxx.ngrok-free.app or https://xxxx.loca.lt"
              />
              <p className="text-[10px] text-text-secondary mt-1">
                Run the 1-click Colab Notebook on free Google Colab T4 GPU to clone your own voice! Notebook template available in{' '}
                <code>resources/voice_clone_colab.ipynb</code>.
              </p>
            </Field>

            <div className="mt-3">
              <Field label="Reference Speaker Voice Sample (.mp3/.wav)" id="setting-speaker-audio-path">
                <div className="flex gap-2">
                  <TextInput
                    id="setting-speaker-audio-path"
                    value={form.speakerAudioPath ?? ''}
                    onChange={(v) => set('speakerAudioPath', v)}
                    placeholder="C:\path\to\my_voice_sample.mp3"
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const file = await ipc.dialog.openFile();
                        if (file) set('speakerAudioPath', file);
                      } catch {}
                    }}
                    className="rounded-md border border-border px-3 py-2 text-sm text-text-secondary hover:border-accent/40 hover:text-text-primary transition-micro"
                  >
                    Choose Sample
                  </button>
                </div>
                <p className="text-[10px] text-text-secondary mt-1">
                  Upload a 15–30 second audio recording of your voice. The AI will speak using your exact voice timber and accent!
                </p>
              </Field>
            </div>
          </div>
        </div>
      </div>

      {/* ── Copyright & Audio ── */}
      <div>
        <SectionHeader title="Copyright & Audio" />
        <div className="flex flex-col gap-4">
          <label htmlFor="setting-auto-attribution" className="flex items-start gap-3 cursor-pointer">
            <input
              id="setting-auto-attribution"
              type="checkbox"
              checked={form.autoAttribution ?? true}
              onChange={(e) => set('autoAttribution', e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
            />
            <span className="text-sm text-text-primary">
              Auto-add source attribution to upload description
              <span className="block text-[10px] text-text-secondary">
                Appends a credit to the original video (downloaded sources only). Does not prevent Content ID claims.
              </span>
            </span>
          </label>

          <Field label="Attribution Template" id="setting-attribution-template">
            <textarea
              id="setting-attribution-template"
              value={form.attributionTemplate ?? ''}
              onChange={(e) => set('attributionTemplate', e.target.value)}
              rows={3}
              placeholder="Source: {title} {url}"
              className={cn(
                'rounded-md border border-border bg-background px-3 py-2 text-sm text-text-primary resize-none',
                'placeholder:text-text-secondary/50',
                'focus:outline-none focus:ring-2 focus:ring-accent transition-micro'
              )}
            />
            <p className="text-[10px] text-text-secondary mt-1">
              Use <code>{'{title}'}</code> and <code>{'{url}'}</code> placeholders for the source video.
            </p>
          </Field>

          <Field label="Default Audio for Clips" id="setting-audio-mode">
            <SegmentedControl
              id="setting-audio-mode"
              aria-label="Default audio mode"
              options={[
                { value: 'keep', label: 'Keep original' },
                { value: 'mute', label: 'Mute' },
                { value: 'replace', label: 'Replace music' },
              ]}
              value={form.defaultAudioMode ?? 'keep'}
              onChange={(v) => set('defaultAudioMode', v as AppSettings['defaultAudioMode'])}
            />
            <p className="text-[10px] text-text-secondary mt-1">
              Removing/replacing copyrighted source audio is the most effective legitimate way to avoid audio Content ID claims.
            </p>
          </Field>

          {form.defaultAudioMode === 'replace' && (
            <>
              <Field label="Background Music File" id="setting-music-path">
                <div className="flex gap-2">
                  <input
                    id="setting-music-path"
                    type="text"
                    readOnly
                    value={form.backgroundMusicPath ?? ''}
                    placeholder="No music selected"
                    className={cn(
                      'flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm text-text-primary',
                      'placeholder:text-text-secondary/50 cursor-default',
                      'focus:outline-none focus:ring-2 focus:ring-accent'
                    )}
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const filePath = await ipc.dialog.openFile();
                        if (filePath) set('backgroundMusicPath', filePath);
                      } catch { /* cancelled */ }
                    }}
                    className="shrink-0 rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium hover:bg-surface-hover transition-micro"
                  >
                    Browse
                  </button>
                </div>
                <p className="text-[10px] text-text-secondary mt-1">
                  Use only music you have the right to use (royalty-free / licensed / your own).
                </p>
              </Field>

              <Field label={`Music Volume (${Math.round((form.musicVolume ?? 0.8) * 100)}%)`} id="setting-music-volume">
                <input
                  id="setting-music-volume"
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={form.musicVolume ?? 0.8}
                  onChange={(e) => set('musicVolume', parseFloat(e.target.value))}
                  className="w-full accent-accent"
                />
              </Field>
            </>
          )}
        </div>
      </div>

      {/* ── YouTube Account ── */}
      <div>
        <SectionHeader title="YouTube Account" />
        <div className="flex flex-col gap-3">
          {/* Multi YouTube Accounts Card */}
          <div className="flex flex-col gap-2 rounded-md border border-border p-3 bg-surface/30">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-text-primary">Daftar Akun YouTube Terhubung ({accounts.filter(a => a.platform === 'youtube').length})</span>
              <button
                type="button"
                id="youtube-auth-btn"
                onClick={() => void handleConnect()}
                className="rounded bg-accent/20 px-2.5 py-1 text-[11px] font-semibold text-accent hover:bg-accent/30 transition-micro"
              >
                + Hubungkan Akun YouTube Baru
              </button>
            </div>
            {accounts.filter(a => a.platform === 'youtube').length === 0 ? (
              <p className="text-xs text-text-secondary py-1.5">Belum ada akun YouTube terhubung.</p>
            ) : (
              accounts.filter(a => a.platform === 'youtube').map((acc) => (
                <div key={acc.id} className="flex items-center justify-between rounded border border-border/60 bg-background px-3 py-1.5 text-xs">
                  <div className="flex flex-col">
                    <span className="font-medium text-text-primary">{acc.name}</span>
                    {acc.youtubeTokens?.email && (
                      <span className="text-[10px] text-text-secondary">{acc.youtubeTokens.email}</span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleDeleteAccount(acc.id)}
                    className="text-[10px] text-destructive hover:underline"
                  >
                    Hapus
                  </button>
                </div>
              ))
            )}
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
            <Field label="YouTube Data API Key" id="setting-yt-api-key">
              <TextInput id="setting-yt-api-key"
                value={form.youtubeApiKey ?? ''}
                onChange={(v) => set('youtubeApiKey', v)}
                placeholder="AIza... (untuk Search & Trending di Dashboard)" />
            </Field>
          </div>
        </div>
      </div>

      {/* ── TikTok Account ── */}
      <div>
        <SectionHeader title="TikTok Account" />
        <div className="flex flex-col gap-3">
          <Field label="TikTok Cookies / Session ID" id="setting-tiktok-session">
            <TextInput id="setting-tiktok-session" value={form.tiktokSessionId ?? ''}
              onChange={(v) => set('tiktokSessionId', v)} placeholder="Salin Cookie string lengkap dari Browser Anda" />
            <p className="text-[10px] text-text-secondary mt-1 leading-relaxed">
              Buka <code>tiktok.com/tiktokstudio</code> di browser utama Anda, tekan <strong>F12</strong>, masuk ke tab <strong>Network</strong>, reload halaman, klik salah satu request, salin nilai <strong>Cookie</strong> yang ada di bagian <strong>Request Headers</strong> lalu tempel di sini.
            </p>
          </Field>

          {/* Saved Multi TikTok Accounts */}
          <div className="flex flex-col gap-2 rounded-md border border-border p-3 bg-surface/30">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-text-primary">Daftar Akun TikTok Terhubung ({accounts.filter(a => a.platform === 'tiktok').length})</span>
              <button
                type="button"
                onClick={() => {
                  setShowAddAccountModal('tiktok');
                  setAccNameInput('');
                  setAccField1Input('');
                }}
                className="rounded bg-accent/20 px-2.5 py-1 text-[11px] font-semibold text-accent hover:bg-accent/30 transition-micro"
              >
                + Tambah Akun TikTok
              </button>
            </div>
            {accounts.filter(a => a.platform === 'tiktok').map((acc) => (
              <div key={acc.id} className="flex items-center justify-between rounded border border-border/60 bg-background px-3 py-1.5 text-xs">
                <span className="font-medium text-text-primary">{acc.name}</span>
                <button
                  type="button"
                  onClick={() => void handleDeleteAccount(acc.id)}
                  className="text-[10px] text-destructive hover:underline"
                >
                  Hapus
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Facebook Fanpage Account ── */}
      <div>
        <SectionHeader title="Facebook Fanpage Account" />
        <div className="flex flex-col gap-3">
          <Field label="Facebook Page ID" id="setting-fb-page-id">
            <TextInput id="setting-fb-page-id" value={form.facebookPageId ?? ''}
              onChange={(v) => set('facebookPageId', v)} placeholder="Facebook Page ID" />
          </Field>
          <Field label="Facebook Page Access Token" id="setting-fb-token">
            <TextInput id="setting-fb-token" value={form.facebookAccessToken ?? ''}
              onChange={(v) => set('facebookAccessToken', v)} placeholder="Facebook Page Access Token" />
          </Field>

          {/* Saved Multi Facebook Accounts */}
          <div className="flex flex-col gap-2 rounded-md border border-border p-3 bg-surface/30">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-text-primary">Daftar Halaman Facebook Terhubung ({accounts.filter(a => a.platform === 'facebook').length})</span>
              <button
                type="button"
                onClick={() => {
                  setShowAddAccountModal('facebook');
                  setAccNameInput('');
                  setAccField1Input('');
                  setAccField2Input('');
                }}
                className="rounded bg-accent/20 px-2.5 py-1 text-[11px] font-semibold text-accent hover:bg-accent/30 transition-micro"
              >
                + Tambah Halaman Facebook
              </button>
            </div>
            {accounts.filter(a => a.platform === 'facebook').map((acc) => (
              <div key={acc.id} className="flex items-center justify-between rounded border border-border/60 bg-background px-3 py-1.5 text-xs">
                <div className="flex flex-col">
                  <span className="font-medium text-text-primary">{acc.name}</span>
                  <span className="text-[10px] text-text-secondary">Page ID: {acc.facebookPageId}</span>
                </div>
                <button
                  type="button"
                  onClick={() => void handleDeleteAccount(acc.id)}
                  className="text-[10px] text-destructive hover:underline"
                >
                  Hapus
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Telegram Integration Settings ── */}
      <div>
        <SectionHeader title="Telegram Integration Settings" />
        <div className="flex flex-col gap-4">
          <Field label="Metode Pengiriman Telegram" id="setting-tg-mode">
            <div className="flex gap-4">
              <label className="flex items-center gap-2 text-xs font-medium cursor-pointer">
                <input
                  type="radio"
                  name="tg-mode"
                  checked={!form.telegramUseUserbot}
                  onChange={() => set('telegramUseUserbot', false)}
                  className="accent-accent"
                />
                <span>Telegram Bot API (Batas 50 MB)</span>
              </label>
              <label className="flex items-center gap-2 text-xs font-medium cursor-pointer">
                <input
                  type="radio"
                  name="tg-mode"
                  checked={!!form.telegramUseUserbot}
                  onChange={() => set('telegramUseUserbot', true)}
                  className="accent-accent"
                />
                <span>Akun Telegram Pribadi / MTProto (Batas 2 GB - 0% Kompresi)</span>
              </label>
            </div>
          </Field>

          {!form.telegramUseUserbot ? (
            <>
              <Field label="Telegram Bot Token" id="setting-tg-bot-token">
                <TextInput id="setting-tg-bot-token" value={form.telegramBotToken ?? ''}
                  onChange={(v) => set('telegramBotToken', v)} placeholder="123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ" />
              </Field>
              <Field label="Telegram Chat ID" id="setting-tg-chat-id">
                <TextInput id="setting-tg-chat-id" value={form.telegramChatId ?? ''}
                  onChange={(v) => set('telegramChatId', v)} placeholder="e.g. 123456789 or @channelname" />
              </Field>
              <Field label="Telegram API Server URL" id="setting-tg-api-server" description="Default: https://api.telegram.org (Batas 50 MB). Ubah ke server lokal (misal: http://localhost:8081) untuk unlock batas 2 GB tanpa kompresi.">
                <TextInput id="setting-tg-api-server" value={form.telegramApiServer ?? 'https://api.telegram.org'}
                  onChange={(v) => set('telegramApiServer', v)} placeholder="https://api.telegram.org atau http://localhost:8081" />
              </Field>
            </>
          ) : (
            <div className="rounded-md border border-border p-4 bg-surface/40 flex flex-col gap-3">
              <div className="flex items-center justify-between border-b border-border/50 pb-2">
                <span className="text-xs font-semibold text-text-primary">Status Akun Telegram Pribadi</span>
                <span className={cn('text-xs px-2.5 py-0.5 rounded font-semibold', form.telegramSession ? 'bg-green-500/20 text-green-400' : 'bg-yellow-500/20 text-yellow-400')}>
                  {form.telegramSession ? 'Terhubung (Connected)' : 'Belum Terhubung'}
                </span>
              </div>
              <Field label="Telegram API ID" id="setting-tg-api-id" description="Dapatkan App api_id dari https://my.telegram.org">
                <TextInput id="setting-tg-api-id" value={form.telegramApiId ? String(form.telegramApiId) : ''}
                  onChange={(v) => set('telegramApiId', Number(v) || 0)} placeholder="Contoh: 1234567" />
              </Field>
              <Field label="Telegram API Hash" id="setting-tg-api-hash" description="Dapatkan App api_hash dari https://my.telegram.org">
                <TextInput id="setting-tg-api-hash" value={form.telegramApiHash ?? ''}
                  onChange={(v) => set('telegramApiHash', v)} placeholder="Contoh: 0123456789abcdef0123456789abcdef" />
              </Field>
              <Field label="Nomor HP Telegram" id="setting-tg-phone" description="Nomor telepon terdaftar Telegram (sertakan kode negara, misal: +628123456789)">
                <TextInput id="setting-tg-phone" value={form.telegramPhone ?? ''}
                  onChange={(v) => set('telegramPhone', v)} placeholder="+628123456789" />
              </Field>
              <Field label="Target Chat ID / Username" id="setting-tg-target" description="Isi 'me' untuk mengirim langsung ke Saved Messages (Pesan Tersimpan), atau isi ID chat/channel target.">
                <TextInput id="setting-tg-target" value={form.telegramChatId || 'me'}
                  onChange={(v) => set('telegramChatId', v)} placeholder="me" />
              </Field>

              <button
                type="button"
                onClick={() => void handleSendTgCode()}
                disabled={tgConnecting}
                className="self-start mt-2 rounded bg-accent px-4 py-2 text-xs font-semibold text-accent-foreground hover:bg-accent-hover disabled:opacity-50"
              >
                {tgConnecting ? 'Mengirim Kode OTP…' : form.telegramSession ? 'Hubungkan Ulang Akun' : 'Hubungkan Akun Telegram (OTP)'}
              </button>
            </div>
          )}
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

      {/* OTP Verification Modal */}
      {tgOtpModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in">
          <div className="w-full max-w-sm rounded-lg border border-border bg-surface p-6 flex flex-col gap-4 shadow-xl">
            <h4 className="text-sm font-semibold text-text-primary">Verifikasi Kode OTP Telegram</h4>
            <p className="text-xs text-text-secondary">Masukkan kode verifikasi yang baru saja dikirimkan ke aplikasi Telegram Anda.</p>
            <TextInput
              id="otp-code-input"
              value={tgOtpCode}
              onChange={setTgOtpCode}
              placeholder="Kode OTP (contoh: 12345)"
            />
            <TextInput
              id="2fa-password-input"
              value={tg2faPassword}
              onChange={setTg2faPassword}
              placeholder="Password 2FA (opsional jika aktif)"
            />
            <div className="flex justify-end gap-2 mt-2">
              <button
                type="button"
                onClick={() => setTgOtpModal(false)}
                className="rounded border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={() => void handleVerifyTgOtp()}
                disabled={tgConnecting || !tgOtpCode}
                className="rounded bg-accent px-4 py-1.5 text-xs font-semibold text-accent-foreground hover:bg-accent-hover disabled:opacity-50"
              >
                {tgConnecting ? 'Verifikasi…' : 'Verifikasi & Simpan'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Account Modal */}
      {showAddAccountModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in p-4">
          <div className="w-full max-w-sm rounded-lg border border-border bg-surface p-5 flex flex-col gap-4 shadow-xl">
            <h4 className="text-sm font-semibold text-text-primary uppercase tracking-wide">
              + Tambah Akun {showAddAccountModal.toUpperCase()}
            </h4>

            <Field label="Nama Profil Akun" id="add-acc-name" description="Contoh: Akun Utama, Akun Gaming 2, Channel Shorts B">
              <TextInput
                id="add-acc-name"
                value={accNameInput}
                onChange={setAccNameInput}
                placeholder="Nama Akun"
              />
            </Field>

            {showAddAccountModal === 'tiktok' && (
              <Field label="TikTok Cookie / Session ID" id="add-acc-field1">
                <TextInput
                  id="add-acc-field1"
                  value={accField1Input}
                  onChange={setAccField1Input}
                  placeholder="sessionid=..."
                />
              </Field>
            )}

            {showAddAccountModal === 'facebook' && (
              <>
                <Field label="Facebook Page ID" id="add-acc-field1">
                  <TextInput
                    id="add-acc-field1"
                    value={accField1Input}
                    onChange={setAccField1Input}
                    placeholder="Facebook Page ID"
                  />
                </Field>
                <Field label="Facebook Page Access Token" id="add-acc-field2">
                  <TextInput
                    id="add-acc-field2"
                    value={accField2Input}
                    onChange={setAccField2Input}
                    placeholder="Page Access Token"
                  />
                </Field>
              </>
            )}

            {showAddAccountModal === 'telegram' && (
              <>
                <Field label="Telegram Bot Token" id="add-acc-field1">
                  <TextInput
                    id="add-acc-field1"
                    value={accField1Input}
                    onChange={setAccField1Input}
                    placeholder="123456:ABC..."
                  />
                </Field>
                <Field label="Telegram Chat ID" id="add-acc-field2">
                  <TextInput
                    id="add-acc-field2"
                    value={accField2Input}
                    onChange={setAccField2Input}
                    placeholder="Chat ID atau @channelname"
                  />
                </Field>
              </>
            )}

            <div className="flex justify-end gap-2 mt-2">
              <button
                type="button"
                onClick={() => setShowAddAccountModal(null)}
                className="rounded border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={() => void handleAddAccountSubmit()}
                disabled={!accNameInput.trim()}
                className="rounded bg-accent px-4 py-1.5 text-xs font-semibold text-accent-foreground hover:bg-accent-hover disabled:opacity-50"
              >
                Simpan Akun
              </button>
            </div>
          </div>
        </div>
      )}
    </form>
  );
}
