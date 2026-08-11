/**
 * YouTube URL validation utility.
 *
 * Validates that a given string is a recognized YouTube URL in one of the
 * supported formats:
 *   - Standard watch URL:  https://www.youtube.com/watch?v=VIDEO_ID
 *   - Shortened URL:       https://youtu.be/VIDEO_ID
 *   - Embed URL:           https://www.youtube.com/embed/VIDEO_ID
 *
 * Validates: Requirements 1.1, 1.4
 */

export type ValidationResult =
  | { valid: true; videoId: string; format: 'watch' | 'short' | 'embed' }
  | { valid: false; reason: string };

/**
 * YouTube video ID pattern: 11 alphanumeric characters (plus - and _).
 * This is the canonical format used by YouTube.
 */
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

/**
 * Recognized YouTube URL patterns.
 *
 * Standard:  https://www.youtube.com/watch?v=VIDEO_ID
 *            https://youtube.com/watch?v=VIDEO_ID
 *            http://www.youtube.com/watch?v=VIDEO_ID
 *
 * Shortened: https://youtu.be/VIDEO_ID
 *            http://youtu.be/VIDEO_ID
 *
 * Embed:     https://www.youtube.com/embed/VIDEO_ID
 *            https://youtube.com/embed/VIDEO_ID
 */
const WATCH_PATTERN =
  /^https?:\/\/(?:www\.)?youtube\.com\/watch\?(?:[^&]*&)*v=([A-Za-z0-9_-]{11})(?:&.*)?$/;

const SHORT_PATTERN =
  /^https?:\/\/youtu\.be\/([A-Za-z0-9_-]{11})(?:[?#].*)?$/;

const EMBED_PATTERN =
  /^https?:\/\/(?:www\.)?youtube\.com\/embed\/([A-Za-z0-9_-]{11})(?:[?#].*)?$/;

/**
 * Validate a YouTube URL string.
 *
 * Returns a `ValidationResult`:
 * - `{ valid: true, videoId, format }` when the URL is recognized.
 * - `{ valid: false, reason }` with a descriptive message when it is not.
 */
export function validateYouTubeUrl(input: string): ValidationResult {
  if (typeof input !== 'string') {
    return { valid: false, reason: 'Input must be a string.' };
  }

  const trimmed = input.trim();

  if (trimmed.length === 0) {
     return { valid: false, reason: 'URL must not be empty.' };
  }

  if (trimmed.toLowerCase().includes('clip.cafe/')) {
    return { valid: true, videoId: 'clipcafe', format: 'watch' };
  }

  const lower = trimmed.toLowerCase();
  if (lower.includes('tiktok.com/') || lower.includes('vt.tiktok.com/') || lower.includes('vm.tiktok.com/')) {
    return { valid: true, videoId: 'tiktok', format: 'watch' };
  }

  if (
    lower.includes('xiaohongshu.com/') ||
    lower.includes('xhslink.com/') ||
    lower.includes('rednote.com/')
  ) {
    return { valid: true, videoId: 'rednote', format: 'watch' };
  }

  // Check standard watch URL
  const watchMatch = WATCH_PATTERN.exec(trimmed);
  if (watchMatch) {
    const videoId = watchMatch[1];
    if (VIDEO_ID_PATTERN.test(videoId)) {
      return { valid: true, videoId, format: 'watch' };
    }
  }

  // Check shortened URL
  const shortMatch = SHORT_PATTERN.exec(trimmed);
  if (shortMatch) {
    const videoId = shortMatch[1];
    if (VIDEO_ID_PATTERN.test(videoId)) {
      return { valid: true, videoId, format: 'short' };
    }
  }

  // Check embed URL
  const embedMatch = EMBED_PATTERN.exec(trimmed);
  if (embedMatch) {
    const videoId = embedMatch[1];
    if (VIDEO_ID_PATTERN.test(videoId)) {
      return { valid: true, videoId, format: 'embed' };
    }
  }

  // Provide a more specific rejection reason
  if (trimmed.includes('youtube.com') || trimmed.includes('youtu.be')) {
    return {
      valid: false,
      reason:
        'Unrecognized YouTube URL format. Supported formats: ' +
        'youtube.com/watch?v=ID, youtu.be/ID, youtube.com/embed/ID.',
    };
  }

  return {
    valid: false,
    reason: 'Not a YouTube URL. Please enter a valid YouTube video link.',
  };
}
