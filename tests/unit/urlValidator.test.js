/**
 * Unit tests for the YouTube URL validator.
 * Validates Requirements 1.1, 1.4
 */
import { describe, it, expect } from 'vitest';
import { validateYouTubeUrl } from '../../electron/utils/urlValidator';
// ---------------------------------------------------------------------------
// Valid URL formats
// ---------------------------------------------------------------------------
describe('validateYouTubeUrl — valid URLs', () => {
    it('accepts a standard watch URL with www', () => {
        const result = validateYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
        expect(result.valid).toBe(true);
        if (result.valid) {
            expect(result.videoId).toBe('dQw4w9WgXcQ');
            expect(result.format).toBe('watch');
        }
    });
    it('accepts a standard watch URL without www', () => {
        const result = validateYouTubeUrl('https://youtube.com/watch?v=dQw4w9WgXcQ');
        expect(result.valid).toBe(true);
        if (result.valid) {
            expect(result.videoId).toBe('dQw4w9WgXcQ');
            expect(result.format).toBe('watch');
        }
    });
    it('accepts a standard watch URL with http', () => {
        const result = validateYouTubeUrl('http://www.youtube.com/watch?v=dQw4w9WgXcQ');
        expect(result.valid).toBe(true);
        if (result.valid) {
            expect(result.videoId).toBe('dQw4w9WgXcQ');
        }
    });
    it('accepts a watch URL with extra query parameters', () => {
        const result = validateYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=PLxxx');
        expect(result.valid).toBe(true);
        if (result.valid) {
            expect(result.videoId).toBe('dQw4w9WgXcQ');
        }
    });
    it('accepts a watch URL where v= is not the first query param', () => {
        const result = validateYouTubeUrl('https://www.youtube.com/watch?list=PLxxx&v=dQw4w9WgXcQ');
        expect(result.valid).toBe(true);
        if (result.valid) {
            expect(result.videoId).toBe('dQw4w9WgXcQ');
        }
    });
    it('accepts a shortened youtu.be URL', () => {
        const result = validateYouTubeUrl('https://youtu.be/dQw4w9WgXcQ');
        expect(result.valid).toBe(true);
        if (result.valid) {
            expect(result.videoId).toBe('dQw4w9WgXcQ');
            expect(result.format).toBe('short');
        }
    });
    it('accepts a shortened youtu.be URL with http', () => {
        const result = validateYouTubeUrl('http://youtu.be/dQw4w9WgXcQ');
        expect(result.valid).toBe(true);
        if (result.valid) {
            expect(result.videoId).toBe('dQw4w9WgXcQ');
        }
    });
    it('accepts a shortened youtu.be URL with query params', () => {
        const result = validateYouTubeUrl('https://youtu.be/dQw4w9WgXcQ?t=42');
        expect(result.valid).toBe(true);
        if (result.valid) {
            expect(result.videoId).toBe('dQw4w9WgXcQ');
        }
    });
    it('accepts an embed URL with www', () => {
        const result = validateYouTubeUrl('https://www.youtube.com/embed/dQw4w9WgXcQ');
        expect(result.valid).toBe(true);
        if (result.valid) {
            expect(result.videoId).toBe('dQw4w9WgXcQ');
            expect(result.format).toBe('embed');
        }
    });
    it('accepts an embed URL without www', () => {
        const result = validateYouTubeUrl('https://youtube.com/embed/dQw4w9WgXcQ');
        expect(result.valid).toBe(true);
        if (result.valid) {
            expect(result.videoId).toBe('dQw4w9WgXcQ');
        }
    });
    it('accepts a URL with leading/trailing whitespace', () => {
        const result = validateYouTubeUrl('  https://youtu.be/dQw4w9WgXcQ  ');
        expect(result.valid).toBe(true);
    });
    it('accepts video IDs with hyphens and underscores', () => {
        // 11-char ID: a,b,c,-,d,e,f,_,1,2,3 = 11 chars
        const result = validateYouTubeUrl('https://youtu.be/abc-def_123');
        expect(result.valid).toBe(true);
        if (result.valid) {
            expect(result.videoId).toBe('abc-def_123');
        }
    });
});
// ---------------------------------------------------------------------------
// Invalid URL formats
// ---------------------------------------------------------------------------
describe('validateYouTubeUrl — invalid URLs', () => {
    it('rejects an empty string', () => {
        const result = validateYouTubeUrl('');
        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.reason).toBeTruthy();
        }
    });
    it('rejects a whitespace-only string', () => {
        const result = validateYouTubeUrl('   ');
        expect(result.valid).toBe(false);
    });
    it('rejects a non-URL string', () => {
        const result = validateYouTubeUrl('not a url at all');
        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.reason).toBeTruthy();
        }
    });
    it('rejects a URL from a different domain', () => {
        const result = validateYouTubeUrl('https://vimeo.com/123456789');
        expect(result.valid).toBe(false);
    });
    it('rejects a YouTube channel URL (not a video)', () => {
        const result = validateYouTubeUrl('https://www.youtube.com/channel/UCxxxxxx');
        expect(result.valid).toBe(false);
    });
    it('rejects a YouTube playlist URL without a video ID', () => {
        const result = validateYouTubeUrl('https://www.youtube.com/playlist?list=PLxxx');
        expect(result.valid).toBe(false);
    });
    it('rejects a watch URL with a missing video ID', () => {
        const result = validateYouTubeUrl('https://www.youtube.com/watch?v=');
        expect(result.valid).toBe(false);
    });
    it('rejects a watch URL with a too-short video ID', () => {
        const result = validateYouTubeUrl('https://www.youtube.com/watch?v=short');
        expect(result.valid).toBe(false);
    });
    it('rejects a watch URL with a too-long video ID', () => {
        const result = validateYouTubeUrl('https://www.youtube.com/watch?v=toolongvideoid123');
        expect(result.valid).toBe(false);
    });
    it('rejects a youtu.be URL with no path', () => {
        const result = validateYouTubeUrl('https://youtu.be/');
        expect(result.valid).toBe(false);
    });
    it('rejects a URL with invalid characters in video ID', () => {
        const result = validateYouTubeUrl('https://youtu.be/invalid!@#$%^&');
        expect(result.valid).toBe(false);
    });
    it('returns a descriptive reason for YouTube-like but malformed URLs', () => {
        const result = validateYouTubeUrl('https://www.youtube.com/watch?v=bad');
        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.reason).toContain('YouTube');
        }
    });
    it('returns a descriptive reason for non-YouTube URLs', () => {
        const result = validateYouTubeUrl('https://example.com/video/123');
        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.reason).toContain('YouTube');
        }
    });
});
// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------
describe('validateYouTubeUrl — edge cases', () => {
    it('handles a URL with a fragment (#) in youtu.be format', () => {
        const result = validateYouTubeUrl('https://youtu.be/dQw4w9WgXcQ#t=42');
        expect(result.valid).toBe(true);
    });
    it('handles a URL with a fragment in embed format', () => {
        const result = validateYouTubeUrl('https://www.youtube.com/embed/dQw4w9WgXcQ#autoplay');
        expect(result.valid).toBe(true);
    });
    it('rejects a URL that looks like YouTube but has a different TLD', () => {
        const result = validateYouTubeUrl('https://www.youtube.org/watch?v=dQw4w9WgXcQ');
        expect(result.valid).toBe(false);
    });
    it('rejects a URL with youtube.com as a subdomain of another domain', () => {
        const result = validateYouTubeUrl('https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ');
        expect(result.valid).toBe(false);
    });
});
