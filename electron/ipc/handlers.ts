import { ipcMain, shell, dialog, BrowserWindow } from 'electron';
import pino from 'pino';
import { CHANNELS } from './channels';
import type {
  DownloadRequest,
  UploadRequest,
  AppSettings,
  Hook,
} from '../../shared/types';

const log = pino({ name: 'Handlers' });

/**
 * Service interface injected into the IPC handlers.
 * Actual implementations live in the pipeline classes; this interface keeps
 * handlers unit-testable without a real Electron environment.
 */
export interface IpcServices {
  /** Returns the list of projects from the DB */
  listProjects: () => Promise<unknown[]>;
  /** Returns a single project by id */
  getProject: (id: string) => Promise<unknown>;
  /** Deletes a project and all associated data */
  deleteProject: (id: string) => Promise<void>;
  /** Starts a download pipeline stage */
  startDownload: (req: DownloadRequest) => Promise<{ projectId: string }>;
  /** Cancels an in-progress download */
  cancelDownload: (projectId: string) => Promise<void>;
  /** Starts transcription for a project */
  startTranscribe: (projectId: string, onProgress?: (pct: number) => void) => Promise<void>;
  /** Cancels an in-progress transcription */
  cancelTranscribe: (projectId: string) => Promise<void>;
  /** Returns the transcript for a project */
  getTranscript: (projectId: string) => Promise<unknown>;
  /** Runs hook analysis and returns hooks */
  startAnalyze: (projectId: string, momentTheme?: string) => Promise<unknown[]>;
  /** Cancels an in-progress analysis */
  cancelAnalyze: (projectId: string) => Promise<void>;
  /** Generate YouTube metadata (title, description, tags) using AI */
  generateMetadata: (summary: string) => Promise<{ title: string; description: string; tags: string[] } | null>;
  /** Lists hooks for a project */
  listHooks: (projectId: string) => Promise<unknown[]>;
  /** Updates a hook (e.g. viral score, summary) */
  updateHook: (hook: Partial<Hook> & { id: string }) => Promise<void>;
  /** Dismisses a hook */
  dismissHook: (hookId: string) => Promise<void>;
  /** Gets a single hook */
  getHook?: (hookId: string) => Promise<any>;
  /** Generates a clip from a hook */
  generateClip: (hookId: string, options: Record<string, unknown>) => Promise<{ clipId: string }>;
  /** Cancels clip generation */
  cancelClip: (clipId: string) => Promise<void>;
  /** Lists clips for a project */
  listClips: (projectId: string) => Promise<unknown[]>;
  /** Gets a single clip */
  getClip: (clipId: string) => Promise<unknown>;
  /** Inserts a new clip record */
  insertClip?: (data: any) => Promise<unknown>;
  /** Updates output path of a clip */
  updateClipOutputPath?: (clipId: string, outputPath: string) => Promise<void>;
  /** Deletes a clip */
  deleteClip: (clipId: string) => Promise<void>;
  /** Starts export of a clip */
  startExport: (clipId: string, outputPath: string) => Promise<void>;
  /** Cancels an in-progress export */
  cancelExport: (clipId: string) => Promise<void>;
  /** Starts YouTube OAuth flow */
  startAuthFlow: () => Promise<void>;
  /** Disconnects YouTube primary auth */
  disconnectAuth: () => Promise<void>;
  /** Returns current auth status */
  getAuthStatus: () => Promise<{ authenticated: boolean; email?: string }>;
  /** Starts a YouTube upload */
  startUpload: (req: UploadRequest) => Promise<void>;
  /** Cancels an in-progress upload */
  cancelUpload: (clipId: string) => Promise<void>;
  /** Send Telegram Userbot OTP code */
  telegramSendCode: (req: { apiId: number; apiHash: string; phoneNumber: string }) => Promise<{ phoneCodeHash: string; tempSession: string }>;
  /** Verify Telegram Userbot OTP code and sign in */
  telegramSignIn: (req: { apiId: number; apiHash: string; phoneNumber: string; phoneCodeHash: string; phoneCode: string; tempSession: string; password?: string }) => Promise<string>;
  /** Gets all app settings */
  getSettings: () => Promise<AppSettings>;
  /** Updates app settings */
  setSettings: (settings: Partial<AppSettings>) => Promise<void>;
  /** Gets upload accounts */
  getAccounts: () => Promise<import('../../shared/types').UploadAccount[]>;
  /** Saves upload accounts */
  saveAccounts: (accounts: import('../../shared/types').UploadAccount[]) => Promise<void>;
  /** Gets preview presets */
  getPresets: () => Promise<import('../../shared/types').PreviewPreset[]>;
  /** Saves preview presets */
  savePresets: (presets: import('../../shared/types').PreviewPreset[]) => Promise<void>;
  /** Gets avatar presets */
  getAvatarPresets: () => Promise<import('../../shared/avatarTypes').AvatarPreset[]>;
  /** Saves avatar preset */
  saveAvatarPreset: (preset: import('../../shared/avatarTypes').AvatarPreset) => Promise<import('../../shared/avatarTypes').AvatarPreset>;
  /** Deletes avatar preset by id */
  deleteAvatarPreset: (id: string) => Promise<void>;
  /** Runs the full pipeline (transcribe → analyze → process) for a project */
  runPipeline: (projectId: string, opts?: Record<string, boolean>) => Promise<void>;
  /** Cancels an in-progress pipeline run */
  cancelPipeline: (projectId: string) => Promise<void>;
  /** Returns whether a pipeline is currently running for a project */
  getPipelineStatus: (projectId: string) => Promise<{ running: boolean }>;
  /** Generate a thumbnail for a project at a given timestamp */
  generateThumbnail: (projectId: string, timestampMs: number) => Promise<string | null>;
  /** Save custom thumbnail from base64 image data */
  saveCustomThumbnail: (projectId: string, clipId: string, base64Data: string) => Promise<string>;
  /** Generate AI thumbnail using Vertex AI Imagen */
  generateAiThumbnail: (projectId: string, frameBase64: string, title: string) => Promise<string | null>;
  /** Import a local video file (no download needed) */
  importLocalFile: (filePath: string, quality: string) => Promise<{ projectId: string }>;
  /** Open a native file picker for video files */
  openFilePicker: () => Promise<string | null>;
  /** Detect scene cuts in a project video */
  detectScenes: (projectId: string, threshold?: number) => Promise<import('../../shared/types').SceneDetectionResult>;
  /** Detect speakers in a project video */
  detectSpeakers: (projectId: string, hfToken?: string) => Promise<import('../../shared/types').DiarizationResult>;
  /** Checks external dependency availability */
  checkDeps: () => Promise<unknown>;
  /** Search YouTube for videos (in-app discovery) */
  searchYouTube: (params: import('../../shared/types').YouTubeSearchParams) => Promise<import('../../shared/types').YouTubeVideoResult[]>;
  /** Search Clip.Cafe for movie clips */
  searchClipCafe: (query: string) => Promise<import('../../shared/types').ClipCafeVideoResult[]>;
  /** Get Clip.Cafe movies for a genre */
  getClipCafeGenreMovies: (genre: string, page: number) => Promise<import('../../shared/types').ClipCafeGenreMoviesResponse>;
  /** Get Clip.Cafe clips for a movie url */
  getClipCafeMovieClips: (movieUrl: string, page: number) => Promise<import('../../shared/types').ClipCafeMovieClipsResponse>;
  /** Get trending YouTube videos for a region/category */
  getTrendingYouTube: (params: import('../../shared/types').YouTubeTrendingParams) => Promise<import('../../shared/types').YouTubeVideoResult[]>;
  /** Analyze a YouTube video or a topic for virality & high RPM */
  analyzeTrendYouTube: (params: { topic?: string; title?: string; description?: string; regionCode?: string; userScript?: string }) => Promise<import('../../shared/types').TrendAnalysisResult>;
  /** Optimize a G.I.S.T script to make it unique and significantly transformative */
  optimizeGistScript: (params: { topic: string; originalIdea?: string; userScript: string; durationSec?: number; clipId?: string; analyzeVisual?: boolean }) => Promise<import('../../shared/types').GistOptimizationResult>;
  /** Extract a single frame as base64 JPEG for subject picker UI */
  extractFrame: (projectId: string, timestampMs: number) => Promise<string | null>;
  /** Detect subject bounding boxes at a specific frame */
  detectBoxesAtFrame: (projectId: string, timestampMs: number) => Promise<Array<{x:number;y:number;w:number;h:number}>>;
  /** Translate transcript words to target language, optionally only within a time range */
  translateTranscript: (projectId: string, targetLanguage: string, startMs?: number, endMs?: number) => Promise<void>;
  /** Reset transcript to original (pre-translation) words */
  resetTranscript: (projectId: string) => Promise<void>;
  /** Generate dubbed video with TTS replacing speech, preserving background */
  dubClip: (clipId: string, voice: string, duckDb: number, customScript?: string) => Promise<void>;
  /** Save edited clip script to database */
  saveClipScript: (clipId: string, customScript: string) => Promise<void>;
  /** Save clip caption visibility (whether subtitle preset is 'none' or not) */
  saveClipCaptionVisibility: (clipId: string, visible: boolean, customStyle?: import('../../shared/types').CaptionStyle) => Promise<void>;
  /** Save generated metadata to clip options database */
  saveClipMetadata: (clipId: string, metadata: { title: string; description: string; tags: string[] }) => Promise<void>;
  /** Render a single preview frame with full filter stack (crop+subtitle+letterbox) → base64 JPEG */
  renderPreviewFrame: (opts: Record<string, unknown>) => Promise<string | null>;
}

/**
 * Register all IPC handlers with the provided service implementations.
 * Call once during app initialization in main.ts.
 */
export function registerIpcHandlers(services: IpcServices): void {
  // ---------------------------------------------------------------------------
  // Projects
  // ---------------------------------------------------------------------------
  ipcMain.handle(CHANNELS.PROJECT_LIST, async () => {
    return services.listProjects();
  });

  ipcMain.handle(CHANNELS.PROJECT_GET, async (_event, id: string) => {
    return services.getProject(id);
  });

  ipcMain.handle(CHANNELS.PROJECT_DELETE, async (_event, id: string) => {
    return services.deleteProject(id);
  });

  // ---------------------------------------------------------------------------
  // Download
  // ---------------------------------------------------------------------------
  ipcMain.handle(CHANNELS.DOWNLOAD_START, async (_event, req: DownloadRequest) => {
    return services.startDownload(req);
  });

  ipcMain.handle(CHANNELS.DOWNLOAD_CANCEL, async (_event, projectId: string) => {
    return services.cancelDownload(projectId);
  });

  // ---------------------------------------------------------------------------
  // Transcription
  // ---------------------------------------------------------------------------
  ipcMain.handle(CHANNELS.TRANSCRIBE_START, async (_event, projectId: string) => {
    return services.startTranscribe(projectId);
  });

  ipcMain.handle(CHANNELS.TRANSCRIBE_CANCEL, async (_event, projectId: string) => {
    return services.cancelTranscribe(projectId);
  });

  ipcMain.handle(CHANNELS.TRANSCRIPT_GET, async (_event, projectId: string) => {
    return services.getTranscript(projectId);
  });

  // ---------------------------------------------------------------------------
  // Analysis
  // ---------------------------------------------------------------------------
  ipcMain.handle(CHANNELS.ANALYZE_START, async (_event, projectId: string, momentTheme?: string) => {
    return services.startAnalyze(projectId, momentTheme);
  });

  ipcMain.handle(CHANNELS.ANALYZE_CANCEL, async (_event, projectId: string) => {
    return services.cancelAnalyze(projectId);
  });

  ipcMain.handle(CHANNELS.ANALYZE_GENERATE_METADATA, async (_event, summary: string) => {
    return services.generateMetadata(summary);
  });

  // ---------------------------------------------------------------------------
  // Hooks
  // ---------------------------------------------------------------------------
  ipcMain.handle(CHANNELS.HOOKS_LIST, async (_event, projectId: string) => {
    return services.listHooks(projectId);
  });

  ipcMain.handle(CHANNELS.HOOK_UPDATE, async (_event, hook: Partial<Hook> & { id: string }) => {
    return services.updateHook(hook);
  });

  ipcMain.handle(CHANNELS.HOOK_DISMISS, async (_event, hookId: string) => {
    return services.dismissHook(hookId);
  });

  // ---------------------------------------------------------------------------
  // Clips
  // ---------------------------------------------------------------------------
  ipcMain.handle(
    CHANNELS.CLIP_GENERATE,
    async (_event, hookId: string, options: Record<string, unknown>) => {
      return services.generateClip(hookId, options);
    }
  );

  ipcMain.handle(CHANNELS.CLIP_CANCEL, async (_event, clipId: string) => {
    return services.cancelClip(clipId);
  });

  ipcMain.handle(CHANNELS.CLIP_LIST, async (_event, projectId: string) => {
    return services.listClips(projectId);
  });

  ipcMain.handle(CHANNELS.CLIP_GET, async (_event, clipId: string) => {
    return services.getClip(clipId);
  });

  ipcMain.handle(CHANNELS.CLIP_DELETE, async (_event, clipId: string) => {
    return services.deleteClip(clipId);
  });

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------
  ipcMain.handle(
    CHANNELS.EXPORT_START,
    async (_event, clipId: string, outputPath: string) => {
      return services.startExport(clipId, outputPath);
    }
  );

  ipcMain.handle(CHANNELS.EXPORT_CANCEL, async (_event, clipId: string) => {
    return services.cancelExport(clipId);
  });

  // ---------------------------------------------------------------------------
  // Upload / Auth
  // ---------------------------------------------------------------------------
  ipcMain.handle(CHANNELS.UPLOAD_AUTH_START, async () => {
    return services.startAuthFlow();
  });

  ipcMain.handle(CHANNELS.UPLOAD_AUTH_DISCONNECT, async () => {
    return services.disconnectAuth();
  });

  ipcMain.handle(CHANNELS.UPLOAD_AUTH_STATUS, async () => {
    return services.getAuthStatus();
  });

  ipcMain.handle(CHANNELS.UPLOAD_START, async (_event, req: UploadRequest) => {
    return services.startUpload(req);
  });

  ipcMain.handle(CHANNELS.UPLOAD_CANCEL, async (_event, clipId: string) => {
    return services.cancelUpload(clipId);
  });

  ipcMain.handle(CHANNELS.TELEGRAM_SEND_CODE, async (_event, req: { apiId: number; apiHash: string; phoneNumber: string }) => {
    return services.telegramSendCode(req);
  });

  ipcMain.handle(CHANNELS.TELEGRAM_SIGN_IN, async (_event, req: { apiId: number; apiHash: string; phoneNumber: string; phoneCodeHash: string; phoneCode: string; tempSession: string; password?: string }) => {
    return services.telegramSignIn(req);
  });

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------
  ipcMain.handle(CHANNELS.SETTINGS_GET, async () => {
    return services.getSettings();
  });

  ipcMain.handle(CHANNELS.SETTINGS_SET, async (_event, settings: Partial<AppSettings>) => {
    return services.setSettings(settings);
  });

  ipcMain.handle(CHANNELS.ACCOUNTS_GET, async () => {
    return services.getAccounts();
  });

  ipcMain.handle(CHANNELS.ACCOUNTS_SAVE, async (_event, accounts: import('../../shared/types').UploadAccount[]) => {
    return services.saveAccounts(accounts);
  });

  ipcMain.handle(CHANNELS.PRESETS_GET, async () => {
    return services.getPresets();
  });

  ipcMain.handle(CHANNELS.PRESETS_SAVE, async (_event, presets: import('../../shared/types').PreviewPreset[]) => {
    return services.savePresets(presets);
  });

  ipcMain.handle(CHANNELS.AVATAR_PRESETS_GET, async () => {
    return services.getAvatarPresets();
  });

  ipcMain.handle(CHANNELS.AVATAR_PRESETS_SAVE, async (_event, preset: import('../../shared/avatarTypes').AvatarPreset) => {
    return services.saveAvatarPreset(preset);
  });

  ipcMain.handle(CHANNELS.AVATAR_PRESETS_DELETE, async (_event, id: string) => {
    return services.deleteAvatarPreset(id);
  });

  // ---------------------------------------------------------------------------
  // Pipeline
  // ---------------------------------------------------------------------------
  ipcMain.handle(CHANNELS.PIPELINE_RUN, async (_event, projectId: string, opts?: Record<string, boolean>) => {
    return services.runPipeline(projectId, opts);
  });

  ipcMain.handle(CHANNELS.PIPELINE_CANCEL, async (_event, projectId: string) => {
    return services.cancelPipeline(projectId);
  });

  ipcMain.handle(CHANNELS.PIPELINE_STATUS, async (_event, projectId: string) => {
    return services.getPipelineStatus(projectId);
  });

  // ---------------------------------------------------------------------------
  // Thumbnail
  // ---------------------------------------------------------------------------
  ipcMain.handle(CHANNELS.THUMBNAIL_GENERATE, async (_event, projectId: string, timestampMs: number) => {
    return services.generateThumbnail(projectId, timestampMs);
  });

  ipcMain.handle(CHANNELS.THUMBNAIL_SAVE_CUSTOM, async (_event, projectId: string, clipId: string, base64Data: string) => {
    return services.saveCustomThumbnail(projectId, clipId, base64Data);
  });

  ipcMain.handle(CHANNELS.THUMBNAIL_GENERATE_AI, async (_event, projectId: string, frameBase64: string, title: string) => {
    return services.generateAiThumbnail(projectId, frameBase64, title);
  });

  // ---------------------------------------------------------------------------
  // Local file import
  // ---------------------------------------------------------------------------
  ipcMain.handle(CHANNELS.LOCAL_IMPORT, async (_event, filePath: string, quality: string) => {
    return services.importLocalFile(filePath, quality);
  });

  // ---------------------------------------------------------------------------
  // Dialog
  // ---------------------------------------------------------------------------
  ipcMain.handle(CHANNELS.DIALOG_OPEN_FILE, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(
      win ?? new BrowserWindow({ show: false }),
      {
        properties: ['openFile'],
        filters: [
          { name: 'All Files (*.*)', extensions: ['*'] },
        ],
      }
    );
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle(CHANNELS.LOCAL_FILE_PICKER, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(
      win ?? new BrowserWindow({ show: false }),
      {
        title: 'Select File',
        properties: ['openFile'],
        filters: [
          { name: 'All Files (*.*)', extensions: ['*'] },
        ],
      }
    );
    return result.canceled ? null : result.filePaths[0];
  });

  // ---------------------------------------------------------------------------
  // Scene & Speaker Detection
  // ---------------------------------------------------------------------------
  ipcMain.handle(CHANNELS.SCENE_DETECT, async (_event, projectId: string, threshold?: number) => {
    return services.detectScenes(projectId, threshold);
  });

  ipcMain.handle(CHANNELS.SPEAKER_DETECT, async (_event, projectId: string, hfToken?: string) => {
    return services.detectSpeakers(projectId, hfToken);
  });

  // ---------------------------------------------------------------------------
  // Dependencies
  // ---------------------------------------------------------------------------
  ipcMain.handle(CHANNELS.DEPS_CHECK, async () => {
    return services.checkDeps();
  });

  // ---------------------------------------------------------------------------
  // YouTube discovery (search / trending)
  // ---------------------------------------------------------------------------
  ipcMain.handle(CHANNELS.YOUTUBE_SEARCH, async (_event, params: import('../../shared/types').YouTubeSearchParams) => {
    return services.searchYouTube(params);
  });

  ipcMain.handle(CHANNELS.YOUTUBE_TRENDING, async (_event, params: import('../../shared/types').YouTubeTrendingParams) => {
    return services.getTrendingYouTube(params);
  });

  ipcMain.handle(CHANNELS.YOUTUBE_ANALYZE_TREND, async (_event, params: { topic?: string; title?: string; description?: string; regionCode?: string; userScript?: string }) => {
    return services.analyzeTrendYouTube(params);
  });

  ipcMain.handle(CHANNELS.YOUTUBE_OPTIMIZE_GIST, async (_event, params: { topic: string; originalIdea?: string; userScript: string; durationSec?: number }) => {
    return services.optimizeGistScript(params);
  });

  ipcMain.handle(CHANNELS.CLIPCAFE_SEARCH, async (_event, query: string) => {
    return services.searchClipCafe(query);
  });

  ipcMain.handle(CHANNELS.CLIPCAFE_GENRE_MOVIES, async (_event, genre: string, page: number) => {
    return services.getClipCafeGenreMovies(genre, page);
  });

  ipcMain.handle(CHANNELS.CLIPCAFE_MOVIE_CLIPS, async (_event, movieUrl: string, page: number) => {
    return services.getClipCafeMovieClips(movieUrl, page);
  });

  // ---------------------------------------------------------------------------
  // Subject Tracking
  // ---------------------------------------------------------------------------
  ipcMain.handle(CHANNELS.FRAME_EXTRACT, async (_event, projectId: string, timestampMs: number) => {
    return services.extractFrame(projectId, timestampMs);
  });

  ipcMain.handle(CHANNELS.TRACKING_DETECT, async (_event, projectId: string, timestampMs: number) => {
    return services.detectBoxesAtFrame(projectId, timestampMs);
  });

  ipcMain.handle(CHANNELS.TRANSLATE_START, async (_event, projectId: string, targetLanguage: string, startMs?: number, endMs?: number) => {
    return services.translateTranscript(projectId, targetLanguage, startMs, endMs);
  });

  ipcMain.handle(CHANNELS.TRANSLATE_RESET, async (_event, projectId: string) => {
    return services.resetTranscript(projectId);
  });

  ipcMain.handle(CHANNELS.DUB_START, async (_event, clipId: string, voice: string, duckDb: number, customScript?: string) => {
    return services.dubClip(clipId, voice, duckDb, customScript);
  });

  ipcMain.handle(CHANNELS.CLIP_UPDATE_SCRIPT, async (_event, clipId: string, customScript: string) => {
    return services.saveClipScript(clipId, customScript);
  });

  ipcMain.handle(CHANNELS.CLIP_UPDATE_CAPTION_VISIBILITY, async (_event, clipId: string, visible: boolean, customStyle?: any) => {
    return services.saveClipCaptionVisibility(clipId, visible, customStyle);
  });

  ipcMain.handle(CHANNELS.CLIP_SAVE_METADATA, async (_event, clipId: string, metadata: { title: string; description: string; tags: string[] }) => {
    return services.saveClipMetadata(clipId, metadata);
  });

  ipcMain.handle(CHANNELS.PREVIEW_RENDER, async (_event, opts: Record<string, unknown>) => {
    return services.renderPreviewFrame(opts);
  });

  ipcMain.handle(CHANNELS.COMMENTATOR_GENERATE, async (_event, req: any) => {
    try {
      const { CommentatorPipeline } = await import('../pipeline/CommentatorPipeline');
      const settings = await services.getSettings() as any;
      const pipeline = new CommentatorPipeline();

      let clip: any = null;
      let project: any = null;
      let hook: any = null;
      let rawWords: any[] = [];
      if (req.clipId) {
        try {
          clip = await services.getClip(req.clipId);
          if (clip?.projectId) {
            project = await services.getProject(clip.projectId);
            if (services.getTranscript) {
              try {
                const tr = await services.getTranscript(clip.projectId) as any;
                if (tr && tr.words_json) {
                  rawWords = JSON.parse(tr.words_json);
                } else if (tr && Array.isArray(tr.words)) {
                  rawWords = tr.words;
                }
              } catch (trErr) {}
            }
          }
          if (clip?.hookId && services.getHook) {
            hook = await services.getHook(clip.hookId);
          }
        } catch (err) {
          console.warn('Failed to fetch clip/project details for commentator:', err);
        }
      }

      const rawSourceFile = project?.filePath || project?.file_path || req.sourceFile;
      const clipStartMs = hook?.startMs ?? clip?.startMs ?? req.startMs;
      const clipEndMs = hook?.endMs ?? clip?.endMs ?? req.endMs;

      // Filter project transcript words strictly within the clip's startMs and endMs range!
      let clipOriginalWords: any[] = [];
      if (clip?.optionsJson || req.optionsJson) {
        try {
          const parsed = JSON.parse(clip?.optionsJson || req.optionsJson);
          if (parsed?.words && parsed.words.length > 0) clipOriginalWords = parsed.words;
        } catch (err) {}
      }

      if (clipOriginalWords.length === 0 && rawWords.length > 0) {
        if (clipStartMs !== undefined && clipEndMs !== undefined && clipEndMs > clipStartMs) {
          clipOriginalWords = rawWords.filter((w: any) => w.startMs < clipEndMs && w.endMs > clipStartMs);
        } else {
          clipOriginalWords = rawWords;
        }
      }

      const serviceAccountPath = settings?.googleSttServiceAccountPath || settings?.googleServiceAccountPath || settings?.serviceAccountPath;

      const result = await pipeline.processCommentary({
        ...req,
        originalTranscriptWords: clipOriginalWords,
        sourceFile: rawSourceFile,
        startMs: clipStartMs,
        endMs: clipEndMs,
        optionsJson: clip?.optionsJson || req.optionsJson,
      }, {
        googleTtsApiKey: settings?.googleTtsApiKey,
        googleServiceAccountPath: serviceAccountPath || undefined,
        xttsColabUrl: settings?.xttsColabUrl,
        speakerAudioPath: settings?.speakerAudioPath,
        whisperModelSize: settings?.whisperModelSize || 'large',
      });

      // Create a NEW distinct Clip record for the Commentary Video in the DB
      if (services.insertClip) {
        try {
          const { randomUUID } = await import('crypto');
          let parsedOpts: any = {};
          if (clip?.optionsJson) {
            try { parsedOpts = JSON.parse(clip.optionsJson); } catch {}
          }
          const captionPresetId = req.captionPresetId || req.captionStyle?.presetId || 'tiktok';
          const customCaptionStyle = req.captionStyle || (parsedOpts.caption ?? null);

          const newClipId = randomUUID();
          const fallbackHookId = clip?.hookId || 'commentary-hook';
          const fallbackProjectId = clip?.projectId || req.projectId || 'commentary-project';

          await services.insertClip({
            id: newClipId,
            hookId: fallbackHookId,
            projectId: fallbackProjectId,
            status: 'complete',
            subtitleStyle: clip?.subtitleStyle || 'bold-white',
            subtitlePosition: req.captionStyle?.position || clip?.subtitlePosition || 'lower-third',
            zoomEnabled: clip?.zoomEnabled ?? true,
            optionsJson: JSON.stringify({
              ...parsedOpts,
              presetId: captionPresetId,
              caption: customCaptionStyle,
              captionStyle: customCaptionStyle,
              captionY: req.captionStyle?.captionY ?? parsedOpts.captionY,
              aiTitle: `🎙️ [AI Commentary] ${result.hookText || 'Viral Commentary'}`,
              aiDescription: result.scriptText || '',
              isCommentary: true,
              originalClipId: clip?.id,
            }),
          });

          if (services.updateClipOutputPath) {
            await services.updateClipOutputPath(newClipId, result.outputPath);
          }

          // Broadcast to all renderer windows so the Export Queue refreshes immediately
          BrowserWindow.getAllWindows().forEach((win) => {
            if (!win.isDestroyed()) {
              win.webContents.send('clip:progress', { clipId: newClipId, percent: 100, eta: '' });
            }
          });
        } catch (insertErr) {
          console.error('Failed to insert commentary clip record into DB:', insertErr);
        }
      }

      return result;
    } catch (err) {
      log.error({ err, req }, 'commentator:generate pipeline execution failed');
      throw err;
    }
  });

  ipcMain.handle(CHANNELS.COMMENTATOR_GET_VOICES, async () => {
    const { TTS_VOICES } = await import('../pipeline/Dubber');
    return TTS_VOICES;
  });

  // ---------------------------------------------------------------------------
  // Shell / OS utilities (no service injection needed)
  // ---------------------------------------------------------------------------
  ipcMain.handle(CHANNELS.SHELL_OPEN_PATH, async (_event, filePath: string) => {
    await shell.openPath(filePath);
  });

  ipcMain.handle(CHANNELS.SHELL_SHOW_ITEM, async (_event, filePath: string) => {
    shell.showItemInFolder(filePath);
  });

  ipcMain.handle(CHANNELS.DIALOG_OPEN_DIRECTORY, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(
      win ?? new BrowserWindow({ show: false }),
      {
        properties: ['openDirectory', 'createDirectory'],
      }
    );
    return result.canceled ? null : result.filePaths[0];
  });
}

/**
 * Remove all registered IPC handlers.
 * Useful for cleanup in tests or when re-registering with new services.
 */
export function unregisterIpcHandlers(): void {
  const allChannels = Object.values(CHANNELS);
  for (const channel of allChannels) {
    ipcMain.removeHandler(channel);
  }
}
