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
    geminiApiKey: '',
    autoAttribution: true,
    attributionTemplate: 'Sumber / Source: {title}\n{url}\nAll rights belong to the original creator.',
    defaultAudioMode: 'keep',
    backgroundMusicPath: '',
    musicVolume: 0.8,
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
        geminiApiKey: { type: 'string' },
        autoAttribution: { type: 'boolean' },
        attributionTemplate: { type: 'string' },
        defaultAudioMode: {
          type: 'string',
          enum: ['keep', 'mute', 'replace'],
        },
        backgroundMusicPath: { type: 'string' },
        musicVolume: { type: 'number' },
      },
    });
  }

  /**
   * Retrieve a single setting by key.
   */
  get<K extends keyof AppSettings>(key: K): AppSettings[K] {
    return this.store.get(key) as AppSettings[K];
  }

  /**
   * Persist a single setting by key.
   */
  set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
    this.store.set(key, value);
  }

  /**
   * Return a snapshot of all settings.
   */
  getAll(): AppSettings {
    return this.store.store as AppSettings;
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
}
