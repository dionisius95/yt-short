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
  CommentatorRequest,
  CommentatorResult,
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
        letterboxBg?: import('../../shared/types').LetterboxBackground;
        overrideWords?: import('../../shared/types').TranscriptWord[];
        thumbnailPath?: string;
        titleOverlay?: import('../../shared/types').TitleOverlay;
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
    updateScript(clipId: string, customScript: string): Promise<void> {
      return invoke<void>('clip:update-script', clipId, customScript);
    },
    updateCaptionVisibility(clipId: string, visible: boolean, customStyle?: CaptionStyle): Promise<void> {
      return invoke<void>('clip:update-caption-visibility', clipId, visible, customStyle);
    },
    saveMetadata(clipId: string, metadata: { title: string; description: string; tags: string[] }): Promise<void> {
      return invoke<void>('clip:save-metadata', clipId, metadata);
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
    disconnectAuth(): Promise<void> {
      return invoke<void>('upload:auth:disconnect');
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

  preview: {
    /** Render a single frame with full FFmpeg filter stack → base64 JPEG */
    renderFrame(opts: {
      hookId?:            string;
      projectId?:         string;
      sourceFile?:        string;
      startMs?:           number;
      endMs?:             number;
      captionStyle:       import('../../shared/types').CaptionStyle;
      layoutPreset?:      import('../../shared/types').LayoutPreset;
      splitLayout?:       import('../../shared/types').SplitLayout;
      gameRatio?:         import('../../shared/types').GameRatio;
      gamePosition?:      import('../../shared/types').GamePosition;
      letterboxBg?:       import('../../shared/types').LetterboxBackground;
      logoOverlay?:       import('../../shared/types').LogoOverlay;
      titleOverlay?:      import('../../shared/types').TitleOverlay;
      zoomEnabled?:       boolean;
      previewTimestampMs?: number;
      overrideWords?:     import('../../shared/types').TranscriptWord[];
      trackingMode?:      'auto' | 'manual' | 'none' | 'speaker';
      subjectBbox?:       { x: number; y: number; w: number; h: number };
      subjectSeedMs?:     number;
    }): Promise<string | null> {
      return invoke<string | null>('preview:render', opts);
    },
  },

  translate: {
    start(projectId: string, targetLanguage: string, startMs?: number, endMs?: number): Promise<void> {
      return invoke<void>('translate:start', projectId, targetLanguage, startMs, endMs);
    },
    reset(projectId: string): Promise<void> {
      return invoke<void>('translate:reset', projectId);
    },
  },

  dub: {
    start(clipId: string, voice: string, duckDb: number, customScript?: string): Promise<void> {
      return invoke<void>('dub:start', clipId, voice, duckDb, customScript);
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
    saveCustom(projectId: string, clipId: string, base64Data: string): Promise<string> {
      return invoke<string>('thumbnail:save-custom', projectId, clipId, base64Data);
    },
    generateAi(projectId: string, frameBase64: string, title: string): Promise<string | null> {
      return invoke<string | null>('thumbnail:generate-ai', projectId, frameBase64, title);
    },
  },

  // -------------------------------------------------------------------------
  // Settings & Accounts / Presets
  // -------------------------------------------------------------------------
  settings: {
    get(): Promise<AppSettings> {
      return invoke<AppSettings>('settings:get');
    },
    set(settings: Partial<AppSettings>): Promise<void> {
      return invoke<void>('settings:set', settings);
    },
  },

  accounts: {
    get(): Promise<import('../../shared/types').UploadAccount[]> {
      return invoke<import('../../shared/types').UploadAccount[]>('accounts:get');
    },
    save(accounts: import('../../shared/types').UploadAccount[]): Promise<void> {
      return invoke<void>('accounts:save', accounts);
    },
  },

  presets: {
    get(): Promise<import('../../shared/types').PreviewPreset[]> {
      return invoke<import('../../shared/types').PreviewPreset[]>('presets:get');
    },
    save(presets: import('../../shared/types').PreviewPreset[]): Promise<void> {
      return invoke<void>('presets:save', presets);
    },
  },

  avatarPresets: {
    get(): Promise<import('../../shared/avatarTypes').AvatarPreset[]> {
      return invoke<import('../../shared/avatarTypes').AvatarPreset[]>('avatar-presets:get');
    },
    save(preset: import('../../shared/avatarTypes').AvatarPreset): Promise<import('../../shared/avatarTypes').AvatarPreset> {
      return invoke<import('../../shared/avatarTypes').AvatarPreset>('avatar-presets:save', preset);
    },
    delete(id: string): Promise<void> {
      return invoke<void>('avatar-presets:delete', id);
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
  // Telegram Userbot
  // -------------------------------------------------------------------------
  telegram: {
    sendCode(params: { apiId: number; apiHash: string; phoneNumber: string }): Promise<{ phoneCodeHash: string; tempSession: string }> {
      return invoke('telegram:send-code', params);
    },
    signIn(params: { apiId: number; apiHash: string; phoneNumber: string; phoneCodeHash: string; phoneCode: string; tempSession: string; password?: string }): Promise<string> {
      return invoke('telegram:sign-in', params);
    },
  },

  // -------------------------------------------------------------------------
  // YouTube discovery (search / trending)
  // -------------------------------------------------------------------------
  youtube: {
    search(params: import('../../shared/types').YouTubeSearchParams): Promise<import('../../shared/types').YouTubeVideoResult[]> {
      return invoke('youtube:search', params);
    },
    trending(params: import('../../shared/types').YouTubeTrendingParams): Promise<import('../../shared/types').YouTubeVideoResult[]> {
      return invoke('youtube:trending', params);
    },
    analyzeTrend(params: { topic?: string; title?: string; description?: string; regionCode?: string; userScript?: string }): Promise<import('../../shared/types').TrendAnalysisResult> {
      return invoke('youtube:analyze-trend', params);
    },
    optimizeGist(params: { topic: string; originalIdea?: string; userScript: string; durationSec?: number; clipId?: string; analyzeVisual?: boolean }): Promise<import('../../shared/types').GistOptimizationResult> {
      return invoke('youtube:optimize-gist', params);
    },
  },

  // -------------------------------------------------------------------------
  // Clip.Cafe discovery
  // -------------------------------------------------------------------------
  clipCafe: {
    search(query: string): Promise<import('../../shared/types').ClipCafeVideoResult[]> {
      return invoke('clipcafe:search', query);
    },
    getGenreMovies(genre: string, page: number): Promise<import('../../shared/types').ClipCafeGenreMoviesResponse> {
      return invoke('clipcafe:genre-movies', genre, page);
    },
    getMovieClips(movieUrl: string, page: number): Promise<import('../../shared/types').ClipCafeMovieClipsResponse> {
      return invoke('clipcafe:movie-clips', movieUrl, page);
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

  // -------------------------------------------------------------------------
  // AI Video Commentator
  // -------------------------------------------------------------------------
  commentator: {
    generate(req: CommentatorRequest): Promise<CommentatorResult> {
      return invoke<CommentatorResult>('commentator:generate', req);
    },
    getVoices(): Promise<unknown> {
      return invoke('commentator:get-voices');
    },
    onProgress(
      listener: (data: { percent: number; stage?: string; message?: string }) => void
    ): () => void {
      return subscribe<{ percent: number; stage?: string; message?: string }>(
        'commentator:progress',
        listener
      );
    },
  },
};
