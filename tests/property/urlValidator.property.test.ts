/**
 * Property-based tests for the YouTube URL validator.
 *
 * **Validates: Requirements 1.1, 1.4**
 *
 * Property 1: URL Validation Accepts Valid Formats and Rejects Invalid Inputs
 *
 * For any string input to the URL validator, the validator SHALL return `valid`
 * if and only if the string matches a recognized YouTube URL pattern (standard
 * `watch?v=`, shortened `youtu.be/`, or embed `/embed/` format), and SHALL
 * return `invalid` with a descriptive reason for all other inputs.
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { validateYouTubeUrl } from '../../electron/utils/urlValidator';

// ---------------------------------------------------------------------------
// Helpers — generators for valid and invalid inputs
// ---------------------------------------------------------------------------

/**
 * Generates a valid YouTube video ID: exactly 11 characters from [A-Za-z0-9_-].
 */
const videoIdArb = fc.stringOf(
  fc.mapToConstant(
    { num: 26, build: (n) => String.fromCharCode(65 + n) },   // A-Z
    { num: 26, build: (n) => String.fromCharCode(97 + n) },   // a-z
    { num: 10, build: (n) => String.fromCharCode(48 + n) },   // 0-9
    { num: 1,  build: () => '-' },
    { num: 1,  build: () => '_' },
  ),
  { minLength: 11, maxLength: 11 }
);

/**
 * Generates a valid standard watch URL.
 */
const watchUrlArb = videoIdArb.map(
  (id) => `https://www.youtube.com/watch?v=${id}`
);

/**
 * Generates a valid shortened youtu.be URL.
 */
const shortUrlArb = videoIdArb.map(
  (id) => `https://youtu.be/${id}`
);

/**
 * Generates a valid embed URL.
 */
const embedUrlArb = videoIdArb.map(
  (id) => `https://www.youtube.com/embed/${id}`
);

/**
 * Union of all valid YouTube URL formats.
 */
const validYouTubeUrlArb = fc.oneof(watchUrlArb, shortUrlArb, embedUrlArb);

/**
 * Generates strings that are clearly not YouTube URLs:
 * random printable ASCII strings that don't contain "youtube.com" or "youtu.be".
 */
const nonYouTubeStringArb = fc.string({ minLength: 0, maxLength: 200 }).filter(
  (s) => !s.includes('youtube.com') && !s.includes('youtu.be')
);

/**
 * Generates video IDs that are NOT exactly 11 characters (too short or too long).
 */
const invalidVideoIdArb = fc.oneof(
  // Too short (0–10 chars)
  fc.stringOf(
    fc.mapToConstant(
      { num: 26, build: (n) => String.fromCharCode(65 + n) },
      { num: 26, build: (n) => String.fromCharCode(97 + n) },
      { num: 10, build: (n) => String.fromCharCode(48 + n) },
    ),
    { minLength: 0, maxLength: 10 }
  ),
  // Too long (12–30 chars)
  fc.stringOf(
    fc.mapToConstant(
      { num: 26, build: (n) => String.fromCharCode(65 + n) },
      { num: 26, build: (n) => String.fromCharCode(97 + n) },
      { num: 10, build: (n) => String.fromCharCode(48 + n) },
    ),
    { minLength: 12, maxLength: 30 }
  )
);

// ---------------------------------------------------------------------------
// Property 1a: Valid YouTube URLs always return valid: true
// ---------------------------------------------------------------------------

describe('Property 1a — valid YouTube URLs always pass validation', () => {
  it('watch URLs with valid 11-char video IDs are always accepted', () => {
    fc.assert(
      fc.property(watchUrlArb, (url) => {
        const result = validateYouTubeUrl(url);
        expect(result.valid).toBe(true);
        if (result.valid) {
          expect(result.format).toBe('watch');
          expect(result.videoId).toHaveLength(11);
        }
      }),
      { numRuns: 200 }
    );
  });

  it('shortened youtu.be URLs with valid 11-char video IDs are always accepted', () => {
    fc.assert(
      fc.property(shortUrlArb, (url) => {
        const result = validateYouTubeUrl(url);
        expect(result.valid).toBe(true);
        if (result.valid) {
          expect(result.format).toBe('short');
          expect(result.videoId).toHaveLength(11);
        }
      }),
      { numRuns: 200 }
    );
  });

  it('embed URLs with valid 11-char video IDs are always accepted', () => {
    fc.assert(
      fc.property(embedUrlArb, (url) => {
        const result = validateYouTubeUrl(url);
        expect(result.valid).toBe(true);
        if (result.valid) {
          expect(result.format).toBe('embed');
          expect(result.videoId).toHaveLength(11);
        }
      }),
      { numRuns: 200 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 1b: Non-YouTube strings always return valid: false with a reason
// ---------------------------------------------------------------------------

describe('Property 1b — non-YouTube strings always fail validation with a reason', () => {
  it('arbitrary non-YouTube strings are always rejected with a non-empty reason', () => {
    fc.assert(
      fc.property(nonYouTubeStringArb, (input) => {
        const result = validateYouTubeUrl(input);
        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(typeof result.reason).toBe('string');
          expect(result.reason.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 500 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 1c: Watch URLs with invalid video IDs are always rejected
// ---------------------------------------------------------------------------

describe('Property 1c — watch URLs with invalid video IDs are always rejected', () => {
  it('watch URLs with non-11-char video IDs are always rejected', () => {
    fc.assert(
      fc.property(invalidVideoIdArb, (badId) => {
        const url = `https://www.youtube.com/watch?v=${badId}`;
        const result = validateYouTubeUrl(url);
        expect(result.valid).toBe(false);
      }),
      { numRuns: 200 }
    );
  });

  it('youtu.be URLs with non-11-char video IDs are always rejected', () => {
    fc.assert(
      fc.property(invalidVideoIdArb, (badId) => {
        const url = `https://youtu.be/${badId}`;
        const result = validateYouTubeUrl(url);
        expect(result.valid).toBe(false);
      }),
      { numRuns: 200 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 1d: Extracted video ID always matches the input video ID
// ---------------------------------------------------------------------------

describe('Property 1d — extracted video ID always matches the input', () => {
  it('for any valid URL, the extracted videoId equals the ID used to construct the URL', () => {
    fc.assert(
      fc.property(
        videoIdArb,
        fc.oneof(
          fc.constant('watch' as const),
          fc.constant('short' as const),
          fc.constant('embed' as const)
        ),
        (id, format) => {
          let url: string;
          if (format === 'watch') {
            url = `https://www.youtube.com/watch?v=${id}`;
          } else if (format === 'short') {
            url = `https://youtu.be/${id}`;
          } else {
            url = `https://www.youtube.com/embed/${id}`;
          }

          const result = validateYouTubeUrl(url);
          expect(result.valid).toBe(true);
          if (result.valid) {
            expect(result.videoId).toBe(id);
            expect(result.format).toBe(format);
          }
        }
      ),
      { numRuns: 300 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 1e: Validator never throws for any string input
// ---------------------------------------------------------------------------

describe('Property 1e — validator never throws for any string input', () => {
  it('does not throw for any arbitrary string', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 500 }), (input) => {
        expect(() => validateYouTubeUrl(input)).not.toThrow();
        const result = validateYouTubeUrl(input);
        // Result is always either valid or invalid with a reason
        if (result.valid) {
          expect(result.videoId).toBeDefined();
          expect(result.format).toBeDefined();
        } else {
          expect(result.reason).toBeDefined();
          expect(result.reason.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 1000 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 1f: Leading/trailing whitespace does not affect validity
// ---------------------------------------------------------------------------

describe('Property 1f — whitespace trimming is consistent', () => {
  it('a valid URL with surrounding whitespace is still valid', () => {
    fc.assert(
      fc.property(
        validYouTubeUrlArb,
        fc.string({ minLength: 0, maxLength: 5 }).filter((s) => s.trim() === ''),
        fc.string({ minLength: 0, maxLength: 5 }).filter((s) => s.trim() === ''),
        (url, leading, trailing) => {
          const paddedUrl = `${leading}${url}${trailing}`;
          const result = validateYouTubeUrl(paddedUrl);
          expect(result.valid).toBe(true);
        }
      ),
      { numRuns: 200 }
    );
  });
});
