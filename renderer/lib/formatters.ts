/**
 * Formatting utilities for the renderer process.
 *
 * - formatRelativeTime: converts a Unix timestamp (ms) to a human-readable
 *   relative string like "3 days ago" using Intl.RelativeTimeFormat.
 * - formatDuration / formatMs: converts a duration in milliseconds to "MM:SS".
 * - formatFileSize: converts a byte count to a human-readable IEC string like
 *   "3.2 MiB".
 */

// ---------------------------------------------------------------------------
// Relative time
// ---------------------------------------------------------------------------

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

const TIME_DIVISIONS: { amount: number; unit: Intl.RelativeTimeFormatUnit }[] =
  [
    { amount: 60, unit: 'seconds' },
    { amount: 60, unit: 'minutes' },
    { amount: 24, unit: 'hours' },
    { amount: 7, unit: 'days' },
    { amount: 4.34524, unit: 'weeks' },
    { amount: 12, unit: 'months' },
    { amount: Number.POSITIVE_INFINITY, unit: 'years' },
  ];

/**
 * Formats a Unix timestamp (milliseconds) as a relative time string.
 *
 * @example
 * formatRelativeTime(Date.now() - 3 * 24 * 60 * 60 * 1000) // "3 days ago"
 */
export function formatRelativeTime(timestampMs: number): string {
  const elapsedMs = timestampMs - Date.now();
  let duration = Math.abs(elapsedMs) / 1000; // start in seconds

  for (const division of TIME_DIVISIONS) {
    if (duration < division.amount) {
      // Round toward zero so we don't overshoot the boundary unit.
      const value = Math.round(elapsedMs < 0 ? -duration : duration);
      return rtf.format(value, division.unit);
    }
    duration /= division.amount;
  }

  // Fallback — should never be reached due to Infinity sentinel above.
  return rtf.format(Math.round(elapsedMs < 0 ? -duration : duration), 'years');
}

// ---------------------------------------------------------------------------
// Duration / timestamp formatting
// ---------------------------------------------------------------------------

/**
 * Formats a duration in milliseconds as a zero-padded "MM:SS.mmm" (or "MM:SS" if includeMs is false).
 *
 * @example
 * formatDuration(83000)        // "01:23.000"
 * formatDuration(83456)        // "01:23.456"
 * formatDuration(83000, false) // "01:23"
 * formatDuration(0)            // "00:00.000"
 */
export function formatDuration(ms: number, includeMs = true): string {
  const totalMs = Math.max(0, Math.round(ms));
  const totalSeconds = Math.floor(totalMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const millis = totalMs % 1000;
  const base = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  if (includeMs) {
    return `${base}.${String(millis).padStart(3, '0')}`;
  }
  return base;
}

/**
 * Alias for `formatDuration`. Formats a millisecond timestamp as "MM:SS.mmm".
 * Used for displaying hook start/end times on HookCards and TimelineScrubber.
 *
 * @example
 * formatMs(83000) // "01:23.000"
 * formatMs(83456) // "01:23.456"
 */
export function formatMs(ms: number, includeMs = true): string {
  return formatDuration(ms, includeMs);
}

// ---------------------------------------------------------------------------
// File size
// ---------------------------------------------------------------------------

const IEC_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;

/**
 * Formats a byte count as a human-readable IEC (binary) size string.
 *
 * @example
 * formatFileSize(3_355_443)  // "3.2 MiB"
 * formatFileSize(1024)       // "1.0 KiB"
 * formatFileSize(500)        // "500 B"
 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';

  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < IEC_UNITS.length - 1) {
    value /= 1024;
    unitIndex++;
  }

  const unit = IEC_UNITS[unitIndex];

  // Bytes are always whole numbers; larger units get one decimal place.
  const formatted = unitIndex === 0 ? String(Math.round(value)) : value.toFixed(1);
  return `${formatted} ${unit}`;
}
