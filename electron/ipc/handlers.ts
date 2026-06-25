import { ipcMain, shell, dialog, BrowserWindow } from 'electron';
import { CHANNELS } from './channels';
import type {
  DownloadRequest,
  UploadRequest,
  AppSettings,
  Hook,
} from '../../shared/types';

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
  /** Generates a clip from a hook */
  generateClip: (hookId: string, options: Record<string, unknown>) => Promise<{ clipId: string }>;
  /** Cancels clip generation */
  cancelClip: (clipId: string) => Promise<void>;
  /** Lists clips for a project */
  listClips: (projectId: string) => Promise<unknown[]>;
  /** Gets a single clip */
  getClip: (clipId: string) => Promise<unknown>;
  /** Deletes a clip */
  deleteClip: (clipId: string) => Promise<void>;
  /** Starts export of a clip */
  startExport: (clipId: string, outputPath: string) => Promise<void>;
  /** Cancels an in-progress export */
  cancelExport: (clipId: string) => Promise<void>;
  /** Starts YouTube OAuth flow */
  startAuthFlow: () => Promise<void>;
  /** Returns current auth status */
  getAuthStatus: () => Promise<{ authenticated: boolean; email?: string }>;
  /** Starts a YouTube upload */
  startUpload: (req: UploadRequest) => Promise<void>;
  /** Cancels an in-progress upload */
  cancelUpload: (clipId: string) => Promise<void>;
  /** Gets all app settings */
  getSettings: () => Promise<AppSettings>;
  /** Saves app settings */
  setSettings: (settings: Partial<AppSettings>) => Promise<void>;
  /** Runs the full pipeline (transcribe → analyze → process) for a project */
  runPipeline: (projectId: string, opts?: Record<string, boolean>) => Promise<void>;
  /** Cancels an in-progress pipeline run */
  cancelPipeline: (projectId: string) => Promise<void>;
  /** Returns whether a pipeline is currently running for a project */
  getPipelineStatus: (projectId: string) => Promise<{ running: boolean }>;
  /** Generate a thumbnail for a project at a given timestamp */
  generateThumbnail: (projectId: string, timestampMs: number) => Promise<string | null>;
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
  /** Extract a single frame as base64 JPEG for subject picker UI */
  extractFrame: (projectId: string, timestampMs: number) => Promise<string | null>;
  /** Detect subject bounding boxes at a specific frame */
  detectBoxesAtFrame: (projectId: string, timestampMs: number) => Promise<Array<{x:number;y:number;w:number;h:number}>>;
  /** Translate transcript words to target language */
  translateTranscript: (projectId: string, targetLanguage: string) => Promise<void>;
  /** Generate dubbed video with TTS replacing speech, preserving background */
  dubClip: (clipId: string, voice: string, duckDb: number) => Promise<void>;
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

  ipcMain.handle(CHANNELS.UPLOAD_AUTH_STATUS, async () => {
    return services.getAuthStatus();
  });

  ipcMain.handle(CHANNELS.UPLOAD_START, async (_event, req: UploadRequest) => {
    return services.startUpload(req);
  });

  ipcMain.handle(CHANNELS.UPLOAD_CANCEL, async (_event, clipId: string) => {
    return services.cancelUpload(clipId);
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
          { name: 'Video Files', extensions: ['mp4', 'mkv', 'webm', 'mov', 'avi', 'flv', 'm4v'] },
          { name: 'All Files', extensions: ['*'] },
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
        title: 'Select Video File',
        properties: ['openFile'],
        filters: [
          { name: 'Video Files', extensions: ['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v', 'flv'] },
          { name: 'All Files', extensions: ['*'] },
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
  // Subject Tracking
  // ---------------------------------------------------------------------------
  ipcMain.handle(CHANNELS.FRAME_EXTRACT, async (_event, projectId: string, timestampMs: number) => {
    return services.extractFrame(projectId, timestampMs);
  });

  ipcMain.handle(CHANNELS.TRACKING_DETECT, async (_event, projectId: string, timestampMs: number) => {
    return services.detectBoxesAtFrame(projectId, timestampMs);
  });

  ipcMain.handle(CHANNELS.TRANSLATE_START, async (_event, projectId: string, targetLanguage: string) => {
    return services.translateTranscript(projectId, targetLanguage);
  });

  ipcMain.handle(CHANNELS.DUB_START, async (_event, clipId: string, voice: string, duckDb: number) => {
    return services.dubClip(clipId, voice, duckDb);
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
