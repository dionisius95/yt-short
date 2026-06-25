/**
 * Shared TypeScript types used by both the Electron main process and the
 * Next.js renderer process. These types define the IPC contract.
 */

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

export interface DownloadRequest {
  url: string;
  quality: '1080p' | '720p' | '480p' | '360p';
  outputDir: string;
}

export interface DownloadProgress {
  projectId: string;
  percent: number;
  speed: string;  // e.g. "3.2 MiB/s"
  eta: string;    // e.g. "00:01:23"
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

export interface TranscriptWord {
  word: string;
  startMs: number;
  endMs: number;
  confidence: number;  // 0.0–1.0
  /** Speaker ID from diarization, e.g. 'SPEAKER_00'. Undefined if diarization was not run. */
  speakerId?: string;
}

export interface Transcript {
  projectId: string;
  language: string;
  words: TranscriptWord[];
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export interface Hook {
  id: string;
  projectId: string;
  startMs: number;
  endMs: number;
  viralScore: number;   // 0–100
  summary: string;
  dismissed: boolean;
}

// ---------------------------------------------------------------------------
// Clips
// ---------------------------------------------------------------------------

export type ClipStatus = 'pending' | 'processing' | 'complete' | 'failed';
export type SubtitleStyle = 'bold-white' | 'gradient-pop' | 'minimal-clean';
export type SubtitlePosition = 'lower-third' | 'upper-third' | 'center';

// ---------------------------------------------------------------------------
// Layout Presets
// ---------------------------------------------------------------------------

/**
 * Layout preset for clip generation.
 * - normal : standard 9:16 crop with subject tracking (default)
 * - split  : split-screen for 2+ speakers — stack crops vertically or horizontally
 * - game   : gameplay top 50% + facecam bottom 50%, both from same source file
 */
export type LayoutPreset = 'normal' | 'split' | 'game';

/**
 * Split layout direction.
 * - top-bottom : speaker A top half, speaker B bottom half
 * - left-right : speaker A left half, speaker B right half
 * - quad       : 4-way split (2×2 grid) for 3-4 speakers
 */
export type SplitLayout = 'top-bottom' | 'left-right' | 'quad';

/**
 * Game layout — controls gameplay overlay height.
 * - 50-50 : gameplay = 960px tall (50% of screen)
 * - 70-30 : gameplay = 1344px tall (70% of screen — more gameplay visible)
 */
export type GameRatio = '50-50' | '70-30';

/**
 * Game layout — controls gameplay overlay position.
 * - top    : gameplay at top, streamer background fills behind (default)
 * - bottom : gameplay at bottom, streamer visible at top
 */
export type GamePosition = 'top' | 'bottom';

// ---------------------------------------------------------------------------
// Caption Presets
// ---------------------------------------------------------------------------

export type CaptionPresetId =
  | 'karaoke'
  | 'simple'
  | 'thinkmedia'
  | 'hormozi'
  | 'reels'
  | 'custom';

export type CaptionFont =
  | 'Arial'
  | 'Impact'
  | 'Montserrat'
  | 'Oswald'
  | 'Roboto'
  | 'Anton';

export type CaptionAnimation = 'none' | 'fade' | 'pop' | 'slide-up';
export type CaptionLines = 1 | 2 | 3;

export interface CaptionStyle {
  presetId:         CaptionPresetId;
  font:             CaptionFont;
  fontSize:         number;          // px on 1080×1920 canvas
  position:         SubtitlePosition;
  animation:        CaptionAnimation;
  lines:            CaptionLines;    // words per line group
  primaryColor:     string;          // hex e.g. '#FFFFFF'
  outlineColor:     string;          // hex e.g. '#000000'
  highlightColor:   string;          // hex for active/karaoke word e.g. '#FFFF00'
  bold:             boolean;
  uppercase:        boolean;
  outlineSize:      number;          // px
  shadowSize:       number;          // px
  shakeEffect:      boolean;         // loud-word shake animation
  karaokeHighlight: boolean;         // word-by-word highlight (active=highlightColor, rest=primaryColor)
}

/** Built-in preset definitions */
export const CAPTION_PRESETS: Record<CaptionPresetId, Omit<CaptionStyle, 'presetId'>> = {
  karaoke: {
    font: 'Montserrat', fontSize: 80, position: 'lower-third',
    animation: 'pop', lines: 2,
    primaryColor: '#FFFFFF', outlineColor: '#000000', highlightColor: '#FFFF00',
    bold: true, uppercase: false, outlineSize: 5, shadowSize: 2,
    shakeEffect: true, karaokeHighlight: true,
  },
  simple: {
    font: 'Arial', fontSize: 72, position: 'lower-third',
    animation: 'none', lines: 2,
    primaryColor: '#FFFFFF', outlineColor: '#000000', highlightColor: '#FFFFFF',
    bold: false, uppercase: false, outlineSize: 3, shadowSize: 1,
    shakeEffect: true, karaokeHighlight: false,
  },
  thinkmedia: {
    font: 'Oswald', fontSize: 88, position: 'lower-third',
    animation: 'slide-up', lines: 1,
    primaryColor: '#FFFF00', outlineColor: '#000000', highlightColor: '#FF6600',
    bold: true, uppercase: true, outlineSize: 4, shadowSize: 2,
    shakeEffect: true, karaokeHighlight: false,
  },
  hormozi: {
    font: 'Impact', fontSize: 96, position: 'center',
    animation: 'pop', lines: 1,
    primaryColor: '#FFFFFF', outlineColor: '#000000', highlightColor: '#FF0000',
    bold: true, uppercase: true, outlineSize: 6, shadowSize: 3,
    shakeEffect: true, karaokeHighlight: false,
  },
  reels: {
    font: 'Anton', fontSize: 76, position: 'lower-third',
    animation: 'fade', lines: 3,
    primaryColor: '#FFFFFF', outlineColor: '#000000', highlightColor: '#00FFFF',
    bold: true, uppercase: false, outlineSize: 4, shadowSize: 1,
    shakeEffect: true, karaokeHighlight: false,
  },
  custom: {
    font: 'Arial', fontSize: 80, position: 'lower-third',
    animation: 'none', lines: 2,
    primaryColor: '#FFFFFF', outlineColor: '#000000', highlightColor: '#FFFF00',
    bold: true, uppercase: false, outlineSize: 5, shadowSize: 2,
    shakeEffect: true, karaokeHighlight: false,
  },
};

export interface Clip {
  id: string;
  hookId: string;
  projectId: string;
  status: ClipStatus;
  outputPath: string | null;
  subtitleStyle: SubtitleStyle;
  subtitlePosition: SubtitlePosition;
  zoomEnabled: boolean;
  errorMessage: string | null;
  youtubeUrl?: string | null;
}

// ---------------------------------------------------------------------------
// Logo Overlay
// ---------------------------------------------------------------------------

export type LogoPosition =
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'
  | 'center';

export interface LogoOverlay {
  /** Absolute path to logo image (PNG/JPG/SVG) */
  filePath: string;
  position: LogoPosition;
  /** 0.0–1.0 */
  opacity: number;
  /** Scale relative to video width, e.g. 0.15 = 15% of 1080px = 162px */
  scale: number;
  /** Margin from edge in pixels (on 1080×1920 canvas) */
  margin: number;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface ExportProgress {
  clipId: string;
  percent: number;
  eta: string;
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export type PrivacySetting = 'public' | 'unlisted' | 'private';

export interface UploadRequest {
  clipId: string;
  title: string;
  description: string;
  tags: string[];
  privacy: PrivacySetting;
}

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

export interface Project {
  id: string;
  sourceUrl: string;
  title: string;
  filePath: string;
  durationMs: number;
  thumbnail: string | null;
  language: string;
  quality: '1080p' | '720p' | '480p' | '360p';
  createdAt: number;   // Unix timestamp ms
  updatedAt: number;
}

export interface ProjectDashboardItem {
  id: string;
  title: string;
  thumbnail: string | null;
  createdAt: number;
  clipCount: number;
  exportCount: number;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type WhisperModelSize = 'tiny' | 'base' | 'small' | 'medium' | 'large';

export interface AppSettings {
  downloadDir: string;
  exportDir: string;
  whisperModelSize: WhisperModelSize;
  ollamaModel: string;           // default: 'llama3'
  defaultSubtitleStyle: SubtitleStyle;
  defaultVideoQuality: '1080p' | '720p' | '480p' | '360p';
  defaultSubtitlePosition: SubtitlePosition;
  youtubeClientId: string;
  youtubeClientSecret: string;
  /** Target translation language ISO code, e.g. 'id'. Empty = no translation. */
  translationLanguage: string;
  /** DeepL API key for high-quality translation */
  deeplApiKey: string;
  /** Google Cloud TTS API key for high-quality voice synthesis */
  googleTtsApiKey: string;
  /** Deepgram API key for high-accuracy transcription (replaces Whisper when set) */
  deepgramApiKey: string;
  /** Path to Google Cloud Service Account JSON key file for Speech-to-Text V2 (Chirp) */
  googleSttServiceAccountPath: string;
  /** Gemini API key for hook detection (Vertex AI Express or AI Studio key) */
  geminiApiKey: string;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export type PipelineStage =
  | 'download'
  | 'transcribe'
  | 'analyze'
  | 'process'
  | 'upload';

export interface PipelineStatus {
  projectId: string;
  stage: PipelineStage;
  status: 'idle' | 'running' | 'complete' | 'failed' | 'cancelled';
  progress: number;  // 0–100
  error?: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type AppErrorCode =
  | 'INVALID_URL'
  | 'DOWNLOAD_FAILED'
  | 'TRANSCRIPTION_FAILED'
  | 'OLLAMA_UNAVAILABLE'
  | 'INSUFFICIENT_HOOKS'
  | 'EXPORT_FAILED'
  | 'UPLOAD_FAILED'
  | 'AUTH_FAILED'
  | 'DB_ERROR'
  | 'DEPENDENCY_MISSING';

export interface AppError {
  code: AppErrorCode;
  message: string;
  details?: string;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface DependencyStatus {
  name: string;
  detected: boolean;
  version?: string;
  error?: string;
}

export interface DepsCheckResult {
  ytDlp: DependencyStatus;
  ffmpeg: DependencyStatus;
  whisperCli: DependencyStatus;
  ollama: DependencyStatus;
  mediaPipe: DependencyStatus;
}

// ---------------------------------------------------------------------------
// Scene Detection
// ---------------------------------------------------------------------------

export interface SceneCut {
  timestampMs: number;
  score: number;
}

export interface SceneDetectionResult {
  cuts: SceneCut[];
  framesAnalyzed: number;
}

// ---------------------------------------------------------------------------
// Speaker Detection
// ---------------------------------------------------------------------------

export interface SpeakerSegment {
  speakerId: string;
  startMs: number;
  endMs: number;
}

export interface DiarizationResult {
  segments: SpeakerSegment[];
  speakerCount: number;
  method: 'pyannote' | 'energy' | 'none';
}

// ---------------------------------------------------------------------------
// Tracker / Processor
// ---------------------------------------------------------------------------

export interface CropFrame {
  frameIndex: number;
  timestampMs: number;
  cx: number;    // crop center X (pixels in 1920h-scaled space)
  cy: number;    // crop center Y
  hasFace: boolean;
  faceSpanW?: number;  // pixel width spanning all faces in original res (0 = single face)
}

export interface SubtitleBlock {
  words: TranscriptWord[];
  startMs: number;
  endMs: number;
  lineIndex: number;
}
