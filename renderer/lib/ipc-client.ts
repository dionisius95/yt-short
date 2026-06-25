/**
 * Typed IPC client wrappers for the renderer process.
 *
 * Each function wraps `window.electron.invoke()` or `window.electron.on()`
 * with the correct channel name and TypeScript types, so the renderer never
 * has to deal with raw strings or `unknown` return types.
 */
import type {
  DownloadRequest,
  DownloadProgress,
  UploadRequest,
  AppSettings,
  Project,
  ProjectDashboardItem,
  Hook,
  Clip,
  ExportProgress,
  DepsCheckResult,
  SubtitleStyle,
  SubtitlePosition,
  CaptionStyle,
} from '../../shared/types';

// ---------------------------------------------------------------------------
// Window type augmentation
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    electron: {
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
      on: (channel: string, listener: (...args: unknown[]) => void) => () => void;
      once: (channel: string, listener: (...args: unknown[]) => void) => void;
      off: (channel: string, listener: (...args: unknown[]) => void) => void;
    };
  }
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  if (typeof window === 'undefined' || !window.electron) {
    return Promise.reject(
      new Error(`[ipc] window.electron is not available (channel: ${channel}). Are you running inside Electron?`)
    );
  }
  return window.electron.invoke(channel, ...args) as Promise<T>;
}

function subscribe<T>(
  channel: string,
  listener: (data: T) => void
): () => void {
  if (typeof window === 'undefined' || !window.electron) {
    // Return a no-op unsubscribe when not in Electron
    return () => {};
  }
  return window.electron.on(channel, listener as (...args: unknown[]) => void);
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export const ipc = {
  projects: {
    list(): Promise<ProjectDashboardItem[]> {
      return invoke<ProjectDashboardItem[]>('project:list');
    },
    get(id: string): Promise<Project> {
      return invoke<Project>('project:get', id);
    },
    delete(id: string): Promise<void> {
      return invoke<void>('project:delete', id);
    },
  },

  // -------------------------------------------------------------------------
  // Download
  // -------------------------------------------------------------------------
  download: {
    start(req: DownloadRequest): Promise<{ projectId: string }> {
      return invoke<{ projectId: string }>('download:start', req);
    },
    cancel(projectId: string): Promise<void> {
      return invoke<void>('download:cancel', projectId);
    },
    onProgress(
      listener: (progress: DownloadProgress) => void
    ): () => void {
      return subscribe<DownloadProgress>('download:progress', listener);
    },
  },

  // -------------------------------------------------------------------------
  // Transcription
  // -------------------------------------------------------------------------
  transcribe: {
    start(projectId: string): Promise<void> {
      return invoke<void>('transcribe:start', projectId);
    },
    cancel(projectId: string): Promise<void> {
      return invoke<void>('transcribe:cancel', projectId);
    },
    getTranscript(projectId: string): Promise<import('../../shared/types').Transcript | null> {
      return invoke<import('../../shared/types').Transcript | null>('transcript:get', projectId);
    },
    onProgress(
      listener: (data: { projectId: string; percent: number }) => void
    ): () => void {
      return subscribe<{ projectId: string; percent: number }>(
        'transcribe:progress',
        listener
      );
    },
  },

  // -------------------------------------------------------------------------
  // Analysis
  // -------------------------------------------------------------------------
  analyze: {
    start(projectId: string, momentTheme?: string): Promise<Hook[]> {
      return momentTheme
        ? invoke<Hook[]>('analyze:start', projectId, momentTheme)
        : invoke<Hook[]>('analyze:start', projectId);
    },
    cancel(projectId: string): Promise<void> {
      return invoke<void>('analyze:cancel', projectId);
    },
    generateMetadata(summary: string): Promise<{ title: string; description: string; tags: string[] } | null> {
      return invoke<{ title: string; description: string; tags: string[] } | null>('analyze:generate-metadata', summary);
    },
  },

  // -------------------------------------------------------------------------
  // Hooks
  // -------------------------------------------------------------------------
  hooks: {
    list(projectId: string): Promise<Hook[]> {
      return invoke<Hook[]>('hooks:list', projectId);
    },
    update(hook: Partial<Hook> & { id: string }): Promise<void> {
      return invoke<void>('hook:update', hook);
    },
    dismiss(hookId: string): Promise<void> {
      return invoke<void>('hook:dismiss', hookId);
    },
  },

  // -------------------------------------------------------------------------
  // Clips
  // -------------------------------------------------------------------------
  clips: {
    generate(
      hookId: string,
      options: {
        subtitleStyle?: SubtitleStyle;
        subtitlePosition?: SubtitlePosition;
        zoomEnabled?: boolean;
        existingClipId?: string;
        captionStyle?: CaptionStyle;
        logoOverlay?: import('../../shared/types').LogoOverlay;
        trackingMode?: 'auto' | 'manual' | 'none' | 'speaker';
        subjectBbox?: { x: number; y: number; w: number; h: number };
        subjectSeedMs?: number;
        layoutPreset?: import('../../shared/types').LayoutPreset;
        splitLayout?: import('../../shared/types').SplitLayout;
        gameRatio?: import('../../shared/types').GameRatio;
        gamePosition?: import('../../shared/types').GamePosition;
        overrideWords?: import('../../shared/types').TranscriptWord[];
        thumbnailPath?: string;
      }
    ): Promise<{ clipId: string }> {
      return invoke<{ clipId: string }>('clip:generate', hookId, options);
    },
    cancel(clipId: string): Promise<void> {
      return invoke<void>('clip:cancel', clipId);
    },
    list(projectId: string): Promise<Clip[]> {
      return invoke<Clip[]>('clip:list', projectId);
    },
    get(clipId: string): Promise<Clip> {
      return invoke<Clip>('clip:get', clipId);
    },
    delete(clipId: string): Promise<void> {
      return invoke<void>('clip:delete', clipId);
    },
    onProgress(
      listener: (data: { clipId: string; percent: number; eta: string }) => void
    ): () => void {
      return subscribe<{ clipId: string; percent: number; eta: string }>(
        'clip:progress',
        listener
      );
    },
  },

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------
  export: {
    start(clipId: string, outputPath: string): Promise<void> {
      return invoke<void>('export:start', clipId, outputPath);
    },
    cancel(clipId: string): Promise<void> {
      return invoke<void>('export:cancel', clipId);
    },
    onProgress(listener: (data: ExportProgress) => void): () => void {
      return subscribe<ExportProgress>('export:progress', listener);
    },
  },

  // -------------------------------------------------------------------------
  // Upload / Auth
  // -------------------------------------------------------------------------
  upload: {
    startAuth(): Promise<void> {
      return invoke<void>('upload:auth:start');
    },
    getAuthStatus(): Promise<{ authenticated: boolean; email?: string }> {
      return invoke<{ authenticated: boolean; email?: string }>(
        'upload:auth:status'
      );
    },
    start(req: UploadRequest): Promise<void> {
      return invoke<void>('upload:start', req);
    },
    cancel(clipId: string): Promise<void> {
      return invoke<void>('upload:cancel', clipId);
    },
    onProgress(
      listener: (data: { clipId: string; percent: number }) => void
    ): () => void {
      return subscribe<{ clipId: string; percent: number }>(
        'upload:progress',
        listener
      );
    },
  },

  // -------------------------------------------------------------------------
  // Scene & Speaker Detection
  // -------------------------------------------------------------------------
  scene: {
    detect(projectId: string, threshold?: number): Promise<import('../../shared/types').SceneDetectionResult> {
      return invoke('scene:detect', projectId, threshold);
    },
  },

  speaker: {
    detect(projectId: string, hfToken?: string): Promise<import('../../shared/types').DiarizationResult> {
      return invoke('speaker:detect', projectId, hfToken);
    },
  },

  tracking: {
    extractFrame(projectId: string, timestampMs: number): Promise<string | null> {
      return invoke<string | null>('frame:extract', projectId, timestampMs);
    },
    detectBoxes(projectId: string, timestampMs: number): Promise<Array<{x:number;y:number;w:number;h:number}>> {
      return invoke<Array<{x:number;y:number;w:number;h:number}>>('tracking:detect', projectId, timestampMs);
    },
  },

  translate: {
    start(projectId: string, targetLanguage: string): Promise<void> {
      return invoke<void>('translate:start', projectId, targetLanguage);
    },
  },

  dub: {
    start(clipId: string, voice: string, duckDb: number): Promise<void> {
      return invoke<void>('dub:start', clipId, voice, duckDb);
    },
  },

  // -------------------------------------------------------------------------
  // Local import
  // -------------------------------------------------------------------------
  localImport: {
    /** Import a local video file as a new project (no download needed) */
    import(filePath: string, quality: string): Promise<{ projectId: string }> {
      return invoke<{ projectId: string }>('local:import', filePath, quality);
    },
    /** Open native file picker, returns selected path or null */
    openFilePicker(): Promise<string | null> {
      return invoke<string | null>('local:file-picker');
    },
  },

  // -------------------------------------------------------------------------
  // Pipeline (orchestrated)
  // -------------------------------------------------------------------------
  pipeline: {
    /**
     * Start the full pipeline (transcribe → analyze → process all hooks).
     * Returns immediately — progress arrives via onProgress events.
     */
    run(
      projectId: string,
      opts?: { autoTranscribe?: boolean; autoAnalyze?: boolean; autoProcess?: boolean }
    ): Promise<void> {
      return invoke<void>('pipeline:run', projectId, opts ?? {});
    },
    cancel(projectId: string): Promise<void> {
      return invoke<void>('pipeline:cancel', projectId);
    },
    getStatus(projectId: string): Promise<{ running: boolean }> {
      return invoke<{ running: boolean }>('pipeline:status', projectId);
    },
    onProgress(
      listener: (event: import('../../shared/types').PipelineStatus & {
        stage: string;
        stageProgress: number;
        overallProgress: number;
        error?: string;
      }) => void
    ): () => void {
      return subscribe('pipeline:progress', listener);
    },
  },

  // -------------------------------------------------------------------------
  // Thumbnail
  // -------------------------------------------------------------------------
  thumbnail: {
    generate(projectId: string, timestampMs: number): Promise<string | null> {
      return invoke<string | null>('thumbnail:generate', projectId, timestampMs);
    },
  },

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------
  settings: {
    get(): Promise<AppSettings> {
      return invoke<AppSettings>('settings:get');
    },
    set(settings: Partial<AppSettings>): Promise<void> {
      return invoke<void>('settings:set', settings);
    },
  },

  // -------------------------------------------------------------------------
  // Dependencies
  // -------------------------------------------------------------------------
  deps: {
    check(): Promise<DepsCheckResult> {
      return invoke<DepsCheckResult>('deps:check');
    },
  },

  // -------------------------------------------------------------------------
  // Shell / OS utilities
  // -------------------------------------------------------------------------
  shell: {
    openPath(filePath: string): Promise<void> {
      return invoke<void>('shell:open-path', filePath);
    },
    showItem(filePath: string): Promise<void> {
      return invoke<void>('shell:show-item', filePath);
    },
  },

  // -------------------------------------------------------------------------
  // Dialog
  // -------------------------------------------------------------------------
  dialog: {
    openDirectory(): Promise<string | null> {
      return invoke<string | null>('dialog:open-directory');
    },
    openFile(): Promise<string | null> {
      return invoke<string | null>('dialog:open-file');
    },
  },
};
