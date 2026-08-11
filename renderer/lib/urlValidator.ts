/**
 * Renderer-side YouTube URL validation utility.
 *
 * Mirrors the logic from `electron/utils/urlValidator.ts` for the three
 * supported URL patterns:
 *   - Standard watch URL:  https://www.youtube.com/watch?v=VIDEO_ID
 *   - Shortened URL:       https://youtu.be/VIDEO_ID
 *   - Embed URL:           https://www.youtube.com/embed/VIDEO_ID
 *
 * Validates: Requirements 3.2, 3.3, 3.4
 */

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
 * Returns `{ valid: true, videoId }` when the URL matches one of the three
 * supported formats, or `{ valid: false, videoId: null }` otherwise.
 */
export function validateYouTubeUrl(url: string): { valid: boolean; videoId: string | null } {
  if (typeof url !== 'string') {
    return { valid: false, videoId: null };
  }

  const trimmed = url.trim();

  if (trimmed.length === 0) {
    return { valid: false, videoId: null };
  }

  if (trimmed.toLowerCase().includes('clip.cafe/')) {
    return { valid: true, videoId: 'clipcafe' };
  }

  const lower = trimmed.toLowerCase();
  if (lower.includes('tiktok.com/') || lower.includes('vt.tiktok.com/') || lower.includes('vm.tiktok.com/')) {
    return { valid: true, videoId: 'tiktok' };
  }

  if (
    lower.includes('xiaohongshu.com/') ||
    lower.includes('xhslink.com/') ||
    lower.includes('rednote.com/')
  ) {
    return { valid: true, videoId: 'rednote' };
  }

  // Check standard watch URL
  const watchMatch = WATCH_PATTERN.exec(trimmed);
  if (watchMatch) {
    const videoId = watchMatch[1];
    if (VIDEO_ID_PATTERN.test(videoId)) {
      return { valid: true, videoId };
    }
  }

  // Check shortened URL
  const shortMatch = SHORT_PATTERN.exec(trimmed);
  if (shortMatch) {
    const videoId = shortMatch[1];
    if (VIDEO_ID_PATTERN.test(videoId)) {
      return { valid: true, videoId };
    }
  }

  // Check embed URL
  const embedMatch = EMBED_PATTERN.exec(trimmed);
  if (embedMatch) {
    const videoId = embedMatch[1];
    if (VIDEO_ID_PATTERN.test(videoId)) {
      return { valid: true, videoId };
    }
  }

  return { valid: false, videoId: null };
}
