/**
 * Unit tests for renderer/lib/formatters.ts
 *
 * Covers specific examples and boundary values for:
 *   - formatRelativeTime
 *   - formatDuration
 *   - formatMs
 *   - formatFileSize
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatRelativeTime, formatDuration, formatMs, formatFileSize, } from '../../renderer/lib/formatters';
// ---------------------------------------------------------------------------
// formatDuration / formatMs
// ---------------------------------------------------------------------------
describe('formatDuration', () => {
    it('formats zero milliseconds as "00:00.000"', () => {
        expect(formatDuration(0)).toBe('00:00.000');
    });
    it('formats 1 second as "00:01.000"', () => {
        expect(formatDuration(1_000)).toBe('00:01.000');
    });
    it('formats 83 seconds (1 min 23 s) as "01:23.000"', () => {
        expect(formatDuration(83_000)).toBe('01:23.000');
    });
    it('formats exactly 60 seconds as "01:00.000"', () => {
        expect(formatDuration(60_000)).toBe('01:00.000');
    });
    it('formats 3661 seconds (61 min 1 s) as "61:01.000"', () => {
        expect(formatDuration(3_661_000)).toBe('61:01.000');
    });
    it('pads single-digit seconds with a leading zero', () => {
        expect(formatDuration(65_000)).toBe('01:05.000');
    });
    it('treats negative values as zero', () => {
        expect(formatDuration(-5_000)).toBe('00:00.000');
    });
    it('formats sub-second precision correctly', () => {
        expect(formatDuration(1_999)).toBe('00:01.999');
        expect(formatDuration(83_456)).toBe('01:23.456');
    });
    it('formats without milliseconds when includeMs is false', () => {
        expect(formatDuration(83_456, false)).toBe('01:23');
    });
});
describe('formatMs', () => {
    it('is an alias for formatDuration', () => {
        expect(formatMs(83_000)).toBe('01:23.000');
        expect(formatMs(0)).toBe('00:00.000');
        expect(formatMs(3_661_000)).toBe('61:01.000');
        expect(formatMs(83_456, false)).toBe('01:23');
    });
});
// ---------------------------------------------------------------------------
// formatFileSize
// ---------------------------------------------------------------------------
describe('formatFileSize', () => {
    it('formats 0 bytes as "0 B"', () => {
        expect(formatFileSize(0)).toBe('0 B');
    });
    it('formats 500 bytes as "500 B"', () => {
        expect(formatFileSize(500)).toBe('500 B');
    });
    it('formats exactly 1024 bytes as "1.0 KiB"', () => {
        expect(formatFileSize(1_024)).toBe('1.0 KiB');
    });
    it('formats 1536 bytes as "1.5 KiB"', () => {
        expect(formatFileSize(1_536)).toBe('1.5 KiB');
    });
    it('formats 1 MiB (1048576 bytes) as "1.0 MiB"', () => {
        expect(formatFileSize(1_048_576)).toBe('1.0 MiB');
    });
    it('formats ~3.2 MiB as "3.2 MiB"', () => {
        // 3.2 * 1024 * 1024 = 3355443.2 → round to 3355443
        expect(formatFileSize(3_355_443)).toBe('3.2 MiB');
    });
    it('formats 1 GiB as "1.0 GiB"', () => {
        expect(formatFileSize(1_073_741_824)).toBe('1.0 GiB');
    });
    it('handles negative input gracefully (returns "0 B")', () => {
        expect(formatFileSize(-100)).toBe('0 B');
    });
    it('handles non-finite input gracefully (returns "0 B")', () => {
        expect(formatFileSize(Infinity)).toBe('0 B');
        expect(formatFileSize(NaN)).toBe('0 B');
    });
});
// ---------------------------------------------------------------------------
// formatRelativeTime
// ---------------------------------------------------------------------------
describe('formatRelativeTime', () => {
    afterEach(() => {
        vi.useRealTimers();
    });
    it('returns "now" for the current timestamp', () => {
        vi.useFakeTimers();
        const now = Date.now();
        vi.setSystemTime(now);
        const result = formatRelativeTime(now);
        // Intl.RelativeTimeFormat with numeric:'auto' returns "now" for 0 seconds
        expect(result).toBe('now');
    });
    it('returns a past relative string for a timestamp 3 days ago', () => {
        vi.useFakeTimers();
        const now = Date.now();
        vi.setSystemTime(now);
        const threeDaysAgo = now - 3 * 24 * 60 * 60 * 1000;
        const result = formatRelativeTime(threeDaysAgo);
        expect(result).toBe('3 days ago');
    });
    it('returns a past relative string for a timestamp 1 hour ago', () => {
        vi.useFakeTimers();
        const now = Date.now();
        vi.setSystemTime(now);
        const oneHourAgo = now - 60 * 60 * 1000;
        const result = formatRelativeTime(oneHourAgo);
        expect(result).toBe('1 hour ago');
    });
    it('returns a future relative string for a timestamp 2 days from now', () => {
        vi.useFakeTimers();
        const now = Date.now();
        vi.setSystemTime(now);
        const twoDaysLater = now + 2 * 24 * 60 * 60 * 1000;
        const result = formatRelativeTime(twoDaysLater);
        expect(result).toBe('in 2 days');
    });
    it('returns a string for a timestamp 1 year ago', () => {
        vi.useFakeTimers();
        const now = Date.now();
        vi.setSystemTime(now);
        const oneYearAgo = now - 365 * 24 * 60 * 60 * 1000;
        const result = formatRelativeTime(oneYearAgo);
        // Intl.RelativeTimeFormat may return 'last year' or '12 months ago' depending on locale/runtime
        expect(result).toMatch(/year|months/i);
    });
});
