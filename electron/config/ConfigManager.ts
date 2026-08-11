/**
 * ConfigManager — electron-store wrapper for typed AppSettings.
 *
 * Provides a strongly-typed interface over electron-store so the rest of the
 * main process never has to deal with raw string keys or untyped values.
 */

import Store from 'electron-store';
import { app } from 'electron';
import type { AppSettings } from '../../shared/types';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

function buildDefaults(): AppSettings {
  const downloads = (() => {
    try {
      return app.getPath('downloads');
    } catch {
      // app may not be ready in unit-test environments
      return '';
    }
  })();

  return {
    downloadDir: downloads,
    exportDir: downloads,
    whisperModelSize: 'base',
    ollamaModel: 'llama3',
    defaultSubtitleStyle: 'bold-white',
    defaultVideoQuality: '1080p',
    defaultSubtitlePosition: 'lower-third',
    youtubeClientId: '',
    youtubeClientSecret: '',
    translationLanguage: '',
    deeplApiKey: '',
    googleTtsApiKey: '',
    deepgramApiKey: '',
    googleSttServiceAccountPath: '',
    xttsColabUrl: '',
    speakerAudioPath: '',
    autoAttribution: true,
    attributionTemplate: 'Sumber / Source: {title}\n{url}\nAll rights belong to the original creator.',
    defaultAudioMode: 'keep',
    backgroundMusicPath: '',
    musicVolume: 0.8,
    youtubeApiKey: '',
    ytDlpCookiesBrowser: '',
    tiktokSessionId: '',
    facebookPageId: '',
    facebookAccessToken: '',
    telegramBotToken: '',
    telegramChatId: '',
    telegramApiServer: 'https://api.telegram.org',
    telegramUseUserbot: false,
    telegramApiId: 0,
    telegramApiHash: '',
    telegramPhone: '',
    telegramSession: '',
    accounts: [],
    previewPresets: [],
  };
}

// ---------------------------------------------------------------------------
// ConfigManager
// ---------------------------------------------------------------------------

export class ConfigManager {
  private readonly store: Store<AppSettings>;
  private readonly defaults: AppSettings;

  constructor() {
    this.defaults = buildDefaults();

    this.store = new Store<AppSettings>({
      name: 'app-settings',
      defaults: this.defaults,
      // Validate that stored values match expected types; electron-store will
      // fall back to defaults for any key that fails validation.
      schema: {
        downloadDir: { type: 'string' },
        exportDir: { type: 'string' },
        whisperModelSize: {
          type: 'string',
          enum: ['tiny', 'base', 'small', 'medium', 'large'],
        },
        ollamaModel: { type: 'string' },
        defaultSubtitleStyle: {
          type: 'string',
          enum: ['bold-white', 'gradient-pop', 'minimal-clean'],
        },
        defaultVideoQuality: {
          type: 'string',
          enum: ['1080p', '720p', '480p', '360p'],
        },
        defaultSubtitlePosition: {
          type: 'string',
          enum: ['lower-third', 'upper-third', 'center'],
        },
        youtubeClientId: { type: 'string' },
        youtubeClientSecret: { type: 'string' },
        translationLanguage: { type: 'string' },
        deeplApiKey: { type: 'string' },
        googleTtsApiKey: { type: 'string' },
        deepgramApiKey: { type: 'string' },
        googleSttServiceAccountPath: { type: 'string' },
        xttsColabUrl: { type: 'string' },
        speakerAudioPath: { type: 'string' },
        autoAttribution: { type: 'boolean' },
        attributionTemplate: { type: 'string' },
        defaultAudioMode: {
          type: 'string',
          enum: ['keep', 'mute', 'replace'],
        },
        backgroundMusicPath: { type: 'string' },
        musicVolume: { type: 'number' },
        youtubeApiKey: { type: 'string' },
        ytDlpCookiesBrowser: { type: 'string' },
        tiktokSessionId: { type: 'string' },
        facebookPageId: { type: 'string' },
        facebookAccessToken: { type: 'string' },
        telegramBotToken: { type: 'string' },
        telegramChatId: { type: 'string' },
        telegramApiServer: { type: 'string' },
        telegramUseUserbot: { type: 'boolean' },
        telegramApiId: { type: 'number' },
        telegramApiHash: { type: 'string' },
        telegramPhone: { type: 'string' },
        telegramSession: { type: 'string' },
        accounts: { type: 'array' },
        previewPresets: { type: 'array' },
      },
    });
  }

  /**
   * Retrieve a single setting by key.
   */
  get<K extends keyof AppSettings>(key: K): AppSettings[K] {
    const val = this.store.get(key);
    if (typeof val === 'string') {
      return val.trim() as AppSettings[K];
    }
    return val as AppSettings[K];
  }

  /**
   * Persist a single setting by key.
   */
  set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
    const val = typeof value === 'string' ? value.trim() : value;
    this.store.set(key, val as AppSettings[K]);
  }

  /**
   * Return a snapshot of all settings.
   */
  getAll(): AppSettings {
    const raw = this.store.store as AppSettings;
    const clean = { ...raw };
    for (const k of Object.keys(clean) as Array<keyof AppSettings>) {
      if (typeof clean[k] === 'string') {
        (clean as any)[k] = (clean[k] as string).trim();
      }
    }
    return clean;
  }

  /**
   * Reset all settings back to their default values.
   */
  reset(): void {
    this.store.clear();
    // Re-apply defaults explicitly so callers see them immediately.
    for (const [key, value] of Object.entries(this.defaults) as [keyof AppSettings, AppSettings[keyof AppSettings]][]) {
      this.store.set(key, value);
    }
  }

  getAccounts(): import('../../shared/types').UploadAccount[] {
    const raw = this.store.get('accounts');
    if (Array.isArray(raw)) return raw;
    return [];
  }

  saveAccounts(accounts: import('../../shared/types').UploadAccount[]): void {
    this.store.set('accounts', accounts);
  }

  getPreviewPresets(): import('../../shared/types').PreviewPreset[] {
    const raw = this.store.get('previewPresets');
    if (Array.isArray(raw)) return raw;
    return [];
  }

  savePreviewPresets(presets: import('../../shared/types').PreviewPreset[]): void {
    this.store.set('previewPresets', presets);
  }
}
