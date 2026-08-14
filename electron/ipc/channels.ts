/**
 * IPC channel name constants shared between main and renderer processes.
 * All channel names are defined here to prevent typos and enable refactoring.
 */
export const CHANNELS = {
  // ---------------------------------------------------------------------------
  // Download
  // ---------------------------------------------------------------------------
  DOWNLOAD_START: 'download:start',
  DOWNLOAD_CANCEL: 'download:cancel',
  DOWNLOAD_PROGRESS: 'download:progress',   // main → renderer (event)

  // ---------------------------------------------------------------------------
  // Transcription
  // ---------------------------------------------------------------------------
  TRANSCRIBE_START: 'transcribe:start',
  TRANSCRIBE_CANCEL: 'transcribe:cancel',
  TRANSCRIBE_PROGRESS: 'transcribe:progress', // main → renderer (event)
  TRANSCRIPT_GET: 'transcript:get',

  // ---------------------------------------------------------------------------
  // Analysis (Ollama)
  // ---------------------------------------------------------------------------
  ANALYZE_START: 'analyze:start',
  ANALYZE_CANCEL: 'analyze:cancel',
  ANALYZE_GENERATE_METADATA: 'analyze:generate-metadata',

  // ---------------------------------------------------------------------------
  // Hooks
  // ---------------------------------------------------------------------------
  HOOKS_LIST: 'hooks:list',
  HOOK_UPDATE: 'hook:update',
  HOOK_DISMISS: 'hook:dismiss',

  // ---------------------------------------------------------------------------
  // Clips
  // ---------------------------------------------------------------------------
  CLIP_GENERATE: 'clip:generate',
  CLIP_CANCEL: 'clip:cancel',
  CLIP_LIST: 'clip:list',
  CLIP_GET: 'clip:get',
  CLIP_DELETE: 'clip:delete',
  CLIP_UPDATE_SCRIPT: 'clip:update-script',
  CLIP_UPDATE_CAPTION_VISIBILITY: 'clip:update-caption-visibility',
  CLIP_SAVE_METADATA: 'clip:save-metadata',
  CLIP_PROGRESS: 'clip:progress',           // main → renderer (event)

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------
  EXPORT_START: 'export:start',
  EXPORT_CANCEL: 'export:cancel',
  EXPORT_PROGRESS: 'export:progress',       // main → renderer (event)

  // ---------------------------------------------------------------------------
  // AI Video Commentator
  // ---------------------------------------------------------------------------
  COMMENTATOR_GENERATE: 'commentator:generate',
  COMMENTATOR_GET_VOICES: 'commentator:get-voices',
  COMMENTATOR_PROGRESS: 'commentator:progress',       // main → renderer (event)

  // ---------------------------------------------------------------------------
  // Upload (YouTube)
  // ---------------------------------------------------------------------------
  UPLOAD_AUTH_START: 'upload:auth:start',
  UPLOAD_AUTH_DISCONNECT: 'upload:auth:disconnect',
  UPLOAD_AUTH_CALLBACK: 'upload:auth:callback',
  UPLOAD_AUTH_STATUS: 'upload:auth:status',
  UPLOAD_START: 'upload:start',
  UPLOAD_CANCEL: 'upload:cancel',
  UPLOAD_PROGRESS: 'upload:progress',       // main → renderer (event)
  TELEGRAM_SEND_CODE: 'telegram:send-code',
  TELEGRAM_SIGN_IN: 'telegram:sign-in',

  // ---------------------------------------------------------------------------
  // Projects
  // ---------------------------------------------------------------------------
  PROJECT_LIST: 'project:list',
  PROJECT_GET: 'project:get',
  PROJECT_DELETE: 'project:delete',

  // ---------------------------------------------------------------------------
  // Settings & Presets / Accounts
  // ---------------------------------------------------------------------------
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  ACCOUNTS_GET: 'accounts:get',
  ACCOUNTS_SAVE: 'accounts:save',
  PRESETS_GET: 'presets:get',
  PRESETS_SAVE: 'presets:save',
  AVATAR_PRESETS_GET: 'avatar-presets:get',
  AVATAR_PRESETS_SAVE: 'avatar-presets:save',
  AVATAR_PRESETS_DELETE: 'avatar-presets:delete',

  // ---------------------------------------------------------------------------
  // Dependencies
  // ---------------------------------------------------------------------------
  DEPS_CHECK: 'deps:check',

  // ---------------------------------------------------------------------------
  // YouTube discovery (search / trending)
  // ---------------------------------------------------------------------------
  YOUTUBE_SEARCH: 'youtube:search',
  YOUTUBE_TRENDING: 'youtube:trending',
  YOUTUBE_ANALYZE_TREND: 'youtube:analyze-trend',
  YOUTUBE_OPTIMIZE_GIST: 'youtube:optimize-gist',
  CLIPCAFE_SEARCH: 'clipcafe:search',
  CLIPCAFE_GENRE_MOVIES: 'clipcafe:genre-movies',
  CLIPCAFE_MOVIE_CLIPS: 'clipcafe:movie-clips',


  // ---------------------------------------------------------------------------
  // Pipeline (orchestrated multi-stage)
  // ---------------------------------------------------------------------------
  PIPELINE_RUN: 'pipeline:run',
  PIPELINE_CANCEL: 'pipeline:cancel',
  PIPELINE_STATUS: 'pipeline:status',
  PIPELINE_PROGRESS: 'pipeline:progress',   // main → renderer (event)

  // ---------------------------------------------------------------------------
  // Thumbnail
  // ---------------------------------------------------------------------------
  THUMBNAIL_GENERATE: 'thumbnail:generate',
  THUMBNAIL_SAVE_CUSTOM: 'thumbnail:save-custom',
  THUMBNAIL_GENERATE_AI: 'thumbnail:generate-ai',

  // ---------------------------------------------------------------------------
  // Local import
  // ---------------------------------------------------------------------------
  LOCAL_IMPORT: 'local:import',
  LOCAL_FILE_PICKER: 'local:file-picker',

  // ---------------------------------------------------------------------------
  // Scene & Speaker Detection
  // ---------------------------------------------------------------------------
  SCENE_DETECT: 'scene:detect',
  SPEAKER_DETECT: 'speaker:detect',

  // ---------------------------------------------------------------------------
  // Subject Tracking
  // ---------------------------------------------------------------------------
  FRAME_EXTRACT: 'frame:extract',       // extract single frame JPEG for subject picker
  TRACKING_DETECT: 'tracking:detect',   // run auto detection on a frame, return boxes
  TRANSLATE_START: 'translate:start',   // translate transcript to target language
  TRANSLATE_RESET: 'translate:reset',   // reset transcript to original (pre-translation) words
  DUB_START: 'dub:start',               // generate dubbed video with TTS

  // ---------------------------------------------------------------------------
  // Preview render
  // ---------------------------------------------------------------------------
  PREVIEW_RENDER: 'preview:render',     // render 1 frame with full filter stack → base64 JPEG

  // ---------------------------------------------------------------------------
  // Shell / OS utilities
  // ---------------------------------------------------------------------------
  SHELL_OPEN_PATH: 'shell:open-path',
  SHELL_SHOW_ITEM: 'shell:show-item',
  DIALOG_OPEN_DIRECTORY: 'dialog:open-directory',
  DIALOG_OPEN_FILE: 'dialog:open-file',
} as const;

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];

/**
 * Channels that flow from main → renderer (push events, not request/response).
 * These are used with ipcRenderer.on() rather than ipcRenderer.invoke().
 */
export const PUSH_CHANNELS = [
  CHANNELS.DOWNLOAD_PROGRESS,
  CHANNELS.TRANSCRIBE_PROGRESS,
  CHANNELS.CLIP_PROGRESS,
  CHANNELS.EXPORT_PROGRESS,
  CHANNELS.UPLOAD_PROGRESS,
  CHANNELS.PIPELINE_PROGRESS,
  CHANNELS.COMMENTATOR_PROGRESS,
] as const;

export type PushChannelName = (typeof PUSH_CHANNELS)[number];
