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
  originalWords?: TranscriptWord[];
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
export type SubtitleStyle = 'bold-white' | 'gradient-pop' | 'minimal-clean' | 'none';
export type SubtitlePosition = 'lower-third' | 'upper-third' | 'center';

// ---------------------------------------------------------------------------
// Layout Presets
// ---------------------------------------------------------------------------

/**
 * Layout preset for clip generation.
 * - normal    : standard 9:16 crop with subject tracking (default)
 * - split     : split-screen for 2+ speakers — stack crops vertically or horizontally
 * - game      : gameplay top 50% + facecam bottom 50%, both from same source file
 * - letterbox : fit source video (any AR) into 9:16 canvas; background fills empty space
 */
export type LayoutPreset = 'normal' | 'split' | 'game' | 'letterbox';

/**
 * Background fill type for letterbox layout.
 * - blur  : blurred+scaled source video (YouTube Shorts style)
 * - color : solid color fill
 * - image : user-supplied image file
 */
export type LetterboxBgType = 'blur' | 'color' | 'image';

/**
 * Source video crop ratio for letterbox layout.
 * - original : keep original aspect ratio (default, e.g. 16:9)
 * - 4:3      : center-crop to 4:3 before fitting into 9:16 canvas
 * - 1:1      : center-crop to 1:1 (square)
 */
export type LetterboxCrop = 'original' | '4:3' | '1:1' | 'custom';

/** Settings for letterbox layout background. */
export interface LetterboxBackground {
  type:       LetterboxBgType;
  /** Hex color, used when type === 'color'. Default '#000000'. */
  color?:     string;
  /** Absolute path to image file, used when type === 'image'. */
  imagePath?: string;
  /** Blur radius (px) for blur bg. Default 30. */
  blurRadius?: number;
  /** Crop source video to a different AR before letterboxing. Default 'original'. */
  crop?:      LetterboxCrop;
  cropBox?:   { x: number; y: number; w: number; h: number };
}

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
  | 'tiktok'
  | 'bangers'
  | 'custom'
  | 'none';

export type CaptionFont =
  | 'Arial'
  | 'Impact'
  | 'Montserrat'
  | 'Oswald'
  | 'Roboto'
  | 'Anton'
  | 'Lilita One'
  | 'Bangers'
  | 'Bebas Neue'
  | 'Fredoka One'
  | 'System';

export type CaptionAnimation = 'none' | 'fade' | 'pop' | 'slide-up';
export type CaptionLines = 1 | 2 | 3;

export interface CaptionStyle {
  presetId:         CaptionPresetId;
  font:             CaptionFont;
  fontSize:         number;          // px on 1080×1920 canvas
  position:         SubtitlePosition;
  /** Custom Y position on 1080×1920 canvas (0=top, 1920=bottom).
   *  If set, overrides the preset position. Anchor: bottom-center of text block. */
  captionY?:        number;
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

/** Static title overlay — user-typed text burned into the video for its full duration. */
export interface TitleOverlay {
  text:        string;          // user-typed title text
  font:        CaptionFont;
  fontSize:    number;          // px on 1080×1920 canvas
  color:       string;          // hex primary color
  outlineColor: string;         // hex outline color
  outlineSize: number;          // px
  bold:        boolean;
  uppercase:   boolean;
  /** Y position on canvas (0=top, 1920=bottom). Anchor: bottom-center. */
  y:           number;
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
  tiktok: {
    font: 'Lilita One', fontSize: 90, position: 'lower-third',
    animation: 'pop', lines: 2,
    primaryColor: '#FFFFFF', outlineColor: '#000000', highlightColor: '#FFFF00',
    bold: true, uppercase: true, outlineSize: 6, shadowSize: 2,
    shakeEffect: true, karaokeHighlight: true,
  },
  bangers: {
    font: 'Bangers', fontSize: 96, position: 'lower-third',
    animation: 'pop', lines: 2,
    primaryColor: '#FFFFFF', outlineColor: '#000000', highlightColor: '#00FFFF',
    bold: true, uppercase: true, outlineSize: 7, shadowSize: 3,
    shakeEffect: true, karaokeHighlight: false,
  },
  custom: {
    font: 'Arial', fontSize: 80, position: 'lower-third',
    animation: 'none', lines: 2,
    primaryColor: '#FFFFFF', outlineColor: '#000000', highlightColor: '#FFFF00',
    bold: true, uppercase: false, outlineSize: 5, shadowSize: 2,
    shakeEffect: true, karaokeHighlight: false,
  },
  none: {
    font: 'Arial', fontSize: 10, position: 'lower-third',
    animation: 'none', lines: 1,
    primaryColor: '#FFFFFF', outlineColor: '#000000', highlightColor: '#FFFFFF',
    bold: false, uppercase: false, outlineSize: 0, shadowSize: 0,
    shakeEffect: false, karaokeHighlight: false,
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
  tiktokUrl?: string | null;
  facebookUrl?: string | null;
  telegramUrl?: string | null;
  optionsJson?: string | null;
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
  /** Custom Y position on 1080×1920 canvas (0=top, 1920=bottom). If set, overrides vertical anchor. */
  y?: number;
  /** Custom X position on 1080×1920 canvas (0=left, 1080=right). If set, overrides horizontal anchor. */
  x?: number;
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
// Multi-Account & Preview Presets
// ---------------------------------------------------------------------------

export interface UploadAccount {
  id: string;
  platform: 'youtube' | 'tiktok' | 'facebook' | 'telegram';
  name: string;
  youtubeTokens?: {
    access_token: string;
    refresh_token: string;
    expiry_date?: number;
    email?: string;
    channelTitle?: string;
  };
  tiktokSessionId?: string;
  facebookPageId?: string;
  facebookAccessToken?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
  telegramUseUserbot?: boolean;
  telegramApiId?: number;
  telegramApiHash?: string;
  telegramPhone?: string;
  telegramSession?: string;
  createdAt: number;
}

export interface PreviewPreset {
  id: string;
  name: string;
  settings: {
    presetId: CaptionPresetId;
    caption: CaptionStyle;
    zoomEnabled: boolean;
    trackingMode: 'auto' | 'manual' | 'none' | 'speaker';
    layoutPreset: LayoutPreset;
    splitLayout: SplitLayout;
    gameRatio: GameRatio;
    gamePosition: GamePosition;
    letterboxBg: LetterboxBackground;
    captionY: number | null;
    logo: LogoOverlay | null;
    titleOverlay: TitleOverlay | null;
  };
  createdAt: number;
}

// ---------------------------------------------------------------------------
export type PrivacySetting = 'public' | 'unlisted' | 'private' | 'private_scheduled';

export const YOUTUBE_CATEGORIES = [
  { id: '22', name: 'People & Blogs (Default)' },
  { id: '1', name: 'Film & Animation' },
  { id: '2', name: 'Autos & Vehicles' },
  { id: '10', name: 'Music' },
  { id: '15', name: 'Pets & Animals' },
  { id: '17', name: 'Sports' },
  { id: '19', name: 'Travel & Events' },
  { id: '20', name: 'Gaming' },
  { id: '23', name: 'Comedy' },
  { id: '24', name: 'Entertainment' },
  { id: '25', name: 'News & Politics' },
  { id: '26', name: 'Howto & Style' },
  { id: '27', name: 'Education' },
  { id: '28', name: 'Science & Technology' },
  { id: '29', name: 'Nonprofits & Activism' },
] as const;

export const YOUTUBE_LANGUAGES = [
  { code: '', name: 'Default (Otomatis)' },
  { code: 'id', name: 'Bahasa Indonesia (Indonesian)' },
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Español (Spanish)' },
  { code: 'ms', name: 'Bahasa Melayu (Malay)' },
  { code: 'ja', name: '日本語 (Japanese)' },
  { code: 'ko', name: '한국어 (Korean)' },
  { code: 'zh', name: '中文 (Chinese)' },
  { code: 'hi', name: 'हिन्दी (Hindi)' },
  { code: 'ar', name: 'العربية (Arabic)' },
  { code: 'pt', name: 'Português (Portuguese)' },
  { code: 'ru', name: 'Русский (Russian)' },
  { code: 'fr', name: 'Français (French)' },
  { code: 'de', name: 'Deutsch (German)' },
] as const;

export interface UploadRequest {
  clipId: string;
  platforms: Array<'youtube' | 'tiktok' | 'facebook' | 'telegram'>;
  accountIds?: string[];
  title: string;
  description: string;
  tags: string[];
  privacy: PrivacySetting;
  publishAt?: string; // ISO 8601 UTC date string
  categoryId?: string; // YouTube video category ID (default '22')
  defaultAudioLanguage?: string; // e.g. 'id', 'en'
  defaultLanguage?: string; // e.g. 'id', 'en'
  customThumbnailPath?: string; // Absolute path to custom thumbnail image
  hasAlteredOrSyntheticContent?: boolean; // YouTube Altered or Synthetic Content disclosure (YPP Compliance)
  autoFairUseDisclaimer?: boolean; // Append Fair Use / Transformative Commentary disclaimer
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
  /** Google Colab / Self-hosted XTTS v2 Voice Cloning API URL (e.g. https://xxxx.ngrok-free.app) */
  xttsColabUrl: string;
  /** Reference audio sample (.wav/.mp3) of user's voice for voice cloning */
  speakerAudioPath: string;
  /** YouTube Data API v3 key for in-app video search & trending discovery. */
  youtubeApiKey: string;
  /**
   * Browser to pull cookies from when yt-dlp hits bot-detection.
   * Maps to --cookies-from-browser. Empty string = disabled.
   * Valid values: 'chrome' | 'firefox' | 'edge' | 'opera' | 'brave' | 'chromium' | 'safari'
   */
  ytDlpCookiesBrowser: string;
  // --- Copyright safety ---------------------------------------------------
  /** Auto-append source attribution to YouTube upload descriptions. */
  autoAttribution: boolean;
  /** Attribution template. {title} and {url} are replaced with the source video's. */
  attributionTemplate: string;
  /** Auto-append Fair Use / Transformative Commentary disclaimer to description. */
  autoFairUseDisclaimer?: boolean;
  /** Fair Use disclaimer template. {url} is replaced with the source video URL. */
  fairUseDisclaimerTemplate?: string;
  /** Default declare altered or synthetic media to YouTube (YPP Policy). */
  hasAlteredOrSyntheticContent?: boolean;
  /** Default audio treatment for generated clips. */
  defaultAudioMode: 'keep' | 'mute' | 'replace';
  /** Background music file used when defaultAudioMode === 'replace'. */
  backgroundMusicPath: string;
  /** Replacement background-music volume (0.0-1.0). */
  musicVolume: number;
  // --- TikTok & Facebook upload credentials ------------------------------
  tiktokSessionId: string;
  facebookPageId: string;
  facebookAccessToken: string;
  // --- Telegram Bot & Userbot credentials ---------------------------------
  telegramBotToken: string;
  telegramChatId: string;
  /** Telegram Bot API server base URL. Defaults to 'https://api.telegram.org'. Set to 'http://localhost:8081' for self-hosted local bot API server. */
  telegramApiServer?: string;
  /** Enable personal Telegram account (Userbot MTProto) mode for up to 2 GB uncompressed uploads. */
  telegramUseUserbot?: boolean;
  telegramApiId?: number;
  telegramApiHash?: string;
  telegramPhone?: string;
  telegramSession?: string;
  // --- Multi-Account & Preview Presets ------------------------------------
  accounts?: UploadAccount[];
  previewPresets?: PreviewPreset[];
  // --- B-Roll Settings ---------------------------------------------------
  brollConfig?: BrollConfig;
  /** Pexels API key for free automatic contextual B-roll video downloads */
  pexelsApiKey?: string;
  /** Pixabay API key for free automatic contextual B-roll video downloads */
  pixabayApiKey?: string;
}

// ---------------------------------------------------------------------------
// YouTube discovery (in-app search & trending)
// ---------------------------------------------------------------------------

export interface YouTubeVideoResult {
  videoId: string;
  url: string;
  title: string;
  channelTitle: string;
  thumbnail: string;
  publishedAt: string;
  viewCount: number | null;
  likeCount: number | null;
  durationSeconds: number | null;
}

export interface YouTubeSearchParams {
  query: string;
  regionCode?: string;
  relevanceLanguage?: string;
  order?: 'relevance' | 'viewCount' | 'date' | 'rating';
  maxResults?: number;
}

export interface YouTubeTrendingParams {
  regionCode?: string;
  categoryId?: string;
  maxResults?: number;
}

export interface ClipCafeVideoResult {
  clipId: string;
  url: string;
  title: string;
  movieTitle: string;
  movieYear: number;
  thumbnail: string;
  durationSeconds: number;
}

export interface ClipCafeMovieResult {
  url: string;
  title: string;
  poster: string;
}

export interface ClipCafeGenreMoviesResponse {
  movies: ClipCafeMovieResult[];
  currentPage: number;
  totalPages: number;
}

export interface ClipCafeMovieClipsResponse {
  clips: ClipCafeVideoResult[];
  currentPage: number;
  totalPages: number;
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
  isCut?: boolean;     // true if frame marks a scene/shot cut boundary
  confidence?: number;
}

export interface SubtitleBlock {
  words: TranscriptWord[];
  startMs: number;
  endMs: number;
  lineIndex: number;
}

// ---------------------------------------------------------------------------
// Viral Trend & RPM Analysis
// ---------------------------------------------------------------------------

export interface TrendHookIdea {
  hookText: string;
  hookType: string;
  whyItWorks: string;
}

export interface GistAudit {
  netInformationGain: number; // 0-100 score
  conflictRadiusRisk: 'duplicate' | 'somewhat_transformative' | 'significantly_transformative';
  similarityScore: number; // 0-100 score compared to userScript
  originalIdeaOverlap: string; // Token 7 overlap explanation in Indonesian
  deliveryOverlap: string; // Token 8 overlap explanation in Indonesian
  diversityActionPlan: string[]; // Steps to escape conflict radius in Indonesian
}

export interface GistOptimizationResult {
  optimizedScript: string; // The rewritten optimized script (English)
  explanation: string; // Brief Indonesian explanation of what was changed and why it keeps retention
}

export interface TrendAnalysisResult {
  topic: string;
  trendStrength: number; // 0-100 score
  rpmPotential: 'very_high' | 'high' | 'medium';
  estimatedRpm: string;
  whyViral: string;
  targetAudience: string;
  hooks: TrendHookIdea[];
  suggestedTitles: string[];
  gistAudit?: GistAudit;
}

// ---------------------------------------------------------------------------
// AI Video Commentator
// ---------------------------------------------------------------------------

export type CommentatorVoiceProvider = 'google-tts' | 'gemini-audio' | 'edge-tts' | 'elevenlabs';

export interface CommentatorVoice {
  id: string;
  name: string;
  provider: CommentatorVoiceProvider;
  gender: 'male' | 'female';
  accent: string;
  sampleDescription?: string;
}

export type CommentatorTransitionEffect = 'fade' | 'slideleft' | 'slideright' | 'wipeleft' | 'pixelize' | 'zoomin' | 'none';

// ---------------------------------------------------------------------------
// Automatic B-Roll Cutaway
// ---------------------------------------------------------------------------

export type BrollCategory = 'minecraft' | 'gameplay' | 'satisfying' | 'contextual' | 'custom' | 'all';
export type BrollMode = 'fullscreen_cutaway' | 'pip_overlay';

export interface BrollConfig {
  enabled: boolean;
  category?: BrollCategory;
  mode?: BrollMode;
  customDir?: string;
  frequencySec?: number; // interval between cuts in seconds (e.g. 6)
  durationSec?: number;  // duration of each b-roll cut in seconds (e.g. 2.5)
}

export interface CommentatorRequest {
  clipId?: string;
  videoPath: string;
  projectId?: string;
  voiceProvider?: CommentatorVoiceProvider;
  voiceId?: string;
  captionPresetId?: CaptionPresetId;
  captionStyle?: CaptionStyle;
  targetAudience?: 'US' | 'UK' | 'ID';
  duckingVolume?: number; // 0.0–1.0 background audio volume during commentary
  commentaryMode?: 'full' | 'hook_only' | 'hook_replay_outro';
  transitionEffect?: CommentatorTransitionEffect;
  transitionSfx?: string; // 'whoosh' | 'swoosh' | 'glitch' | 'none' or custom filepath
  bgMusicPath?: string;
  bgMusicVolume?: number; // 0.0–1.0 background music volume (default 0.20)
  customThumbnailPath?: string;
  brandingLogoPath?: string;
  speakerAudioPath?: string;
  brollConfig?: BrollConfig;
  words?: TranscriptWord[];
  originalTranscriptWords?: TranscriptWord[];
  outputDir?: string;
  sourceFile?: string;
  startMs?: number;
  endMs?: number;
  optionsJson?: string;
}

export interface CommentatorResult {
  outputPath: string;
  scriptText: string;
  hookText: string;
  takeawayText?: string;
  durationMs: number;
}




