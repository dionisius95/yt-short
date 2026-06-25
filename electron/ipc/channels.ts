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
  CLIP_PROGRESS: 'clip:progress',           // main → renderer (event)

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------
  EXPORT_START: 'export:start',
  EXPORT_CANCEL: 'export:cancel',
  EXPORT_PROGRESS: 'export:progress',       // main → renderer (event)

  // ---------------------------------------------------------------------------
  // Upload (YouTube)
  // ---------------------------------------------------------------------------
  UPLOAD_AUTH_START: 'upload:auth:start',
  UPLOAD_AUTH_CALLBACK: 'upload:auth:callback',
  UPLOAD_AUTH_STATUS: 'upload:auth:status',
  UPLOAD_START: 'upload:start',
  UPLOAD_CANCEL: 'upload:cancel',
  UPLOAD_PROGRESS: 'upload:progress',       // main → renderer (event)

  // ---------------------------------------------------------------------------
  // Projects
  // ---------------------------------------------------------------------------
  PROJECT_LIST: 'project:list',
  PROJECT_GET: 'project:get',
  PROJECT_DELETE: 'project:delete',

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',

  // ---------------------------------------------------------------------------
  // Dependencies
  // ---------------------------------------------------------------------------
  DEPS_CHECK: 'deps:check',

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
  DUB_START: 'dub:start',               // generate dubbed video with TTS

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
] as const;

export type PushChannelName = (typeof PUSH_CHANNELS)[number];
