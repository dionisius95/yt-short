/**
 * Property-based tests for the Whisper.cpp transcript parser.
 *
 * **Validates: Requirements 2.2, 11.1**
 *
 * Property 4: Whisper.cpp Output Parsing Produces Complete TranscriptWord Records
 *
 * For any valid Whisper.cpp JSON output, `parseWhisperOutput` SHALL produce a
 * `TranscriptWord[]` where every element has:
 * - a non-empty `word` string
 * - a non-negative `startMs`
 * - an `endMs` >= `startMs` (zero-duration words are allowed)
 * - a `confidence` value in [0.0, 1.0]
 *
 * Also verifies: the function never throws for any arbitrary input.
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { parseWhisperOutput } from '../../electron/utils/transcriptParser';

// ---------------------------------------------------------------------------
// Arbitraries — valid Whisper.cpp structures
// ---------------------------------------------------------------------------

/**
 * Generates a non-empty word string (may include leading space, as Whisper
 * typically produces " Hello" style tokens).
 */
const wordStringArb = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter((s) => s.length > 0);

/**
 * Generates a valid Whisper word object with:
 * - non-empty word string
 * - start >= 0 (seconds)
 * - end >= start (seconds, zero-duration allowed)
 * - probability in [0.0, 1.0]
 */
const whisperWordArb = fc
  .tuple(
    wordStringArb,
    fc.float({ min: 0, max: 3600, noNaN: true }),   // start (seconds)
    fc.float({ min: 0, max: 1, noNaN: true }),       // delta (added to start for end)
    fc.float({ min: 0, max: 1, noNaN: true }),       // probability
  )
  .map(([word, start, delta, probability]) => ({
    word,
    start,
    end: start + delta,   // end >= start always
    probability,
  }));

/**
 * Generates a valid Whisper segment with 0–10 words.
 */
const whisperSegmentArb = fc.record({
  words: fc.array(whisperWordArb, { minLength: 0, maxLength: 10 }),
});

/**
 * Generates a valid Whisper.cpp JSON output with 0–5 segments.
 */
const whisperOutputArb = fc.record({
  segments: fc.array(whisperSegmentArb, { minLength: 0, maxLength: 5 }),
});

// ---------------------------------------------------------------------------
// Property 4a: Every output word has a non-empty word string
// ---------------------------------------------------------------------------

describe('Property 4a — every output word has a non-empty word string', () => {
  it('word field is always a non-empty string', () => {
    fc.assert(
      fc.property(whisperOutputArb, (json) => {
        const result = parseWhisperOutput(json);
        for (const w of result) {
          expect(typeof w.word).toBe('string');
          expect(w.word.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 200 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4b: Every output word has a non-negative startMs
// ---------------------------------------------------------------------------

describe('Property 4b — every output word has a non-negative startMs', () => {
  it('startMs is always >= 0', () => {
    fc.assert(
      fc.property(whisperOutputArb, (json) => {
        const result = parseWhisperOutput(json);
        for (const w of result) {
          expect(w.startMs).toBeGreaterThanOrEqual(0);
        }
      }),
      { numRuns: 200 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4c: Every output word has endMs >= startMs
// ---------------------------------------------------------------------------

describe('Property 4c — every output word has endMs >= startMs', () => {
  it('endMs is always >= startMs (zero-duration words are allowed)', () => {
    fc.assert(
      fc.property(whisperOutputArb, (json) => {
        const result = parseWhisperOutput(json);
        for (const w of result) {
          expect(w.endMs).toBeGreaterThanOrEqual(w.startMs);
        }
      }),
      { numRuns: 200 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4d: Every output word has confidence in [0.0, 1.0]
// ---------------------------------------------------------------------------

describe('Property 4d — every output word has confidence in [0.0, 1.0]', () => {
  it('confidence is always in [0.0, 1.0]', () => {
    fc.assert(
      fc.property(whisperOutputArb, (json) => {
        const result = parseWhisperOutput(json);
        for (const w of result) {
          expect(w.confidence).toBeGreaterThanOrEqual(0.0);
          expect(w.confidence).toBeLessThanOrEqual(1.0);
        }
      }),
      { numRuns: 200 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4e: Output word count equals total valid words across all segments
// ---------------------------------------------------------------------------

describe('Property 4e — output word count matches total valid words in input', () => {
  it('result length equals the sum of words across all segments', () => {
    fc.assert(
      fc.property(whisperOutputArb, (json) => {
        const totalWords = json.segments.reduce(
          (sum, seg) => sum + seg.words.length,
          0
        );
        const result = parseWhisperOutput(json);
        expect(result.length).toBe(totalWords);
      }),
      { numRuns: 200 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4f: parseWhisperOutput never throws for any arbitrary input
// ---------------------------------------------------------------------------

describe('Property 4f — parseWhisperOutput never throws for any input', () => {
  it('does not throw for arbitrary valid Whisper JSON', () => {
    fc.assert(
      fc.property(whisperOutputArb, (json) => {
        expect(() => parseWhisperOutput(json)).not.toThrow();
      }),
      { numRuns: 200 }
    );
  });

  it('does not throw for completely arbitrary unknown values', () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        expect(() => parseWhisperOutput(input)).not.toThrow();
      }),
      { numRuns: 500 }
    );
  });

  it('returns an array for any input', () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        const result = parseWhisperOutput(input);
        expect(Array.isArray(result)).toBe(true);
      }),
      { numRuns: 500 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4g: Timestamps are converted from seconds to milliseconds
// ---------------------------------------------------------------------------

describe('Property 4g — timestamps are converted from seconds to milliseconds', () => {
  it('startMs equals Math.round(start * 1000) for each word', () => {
    fc.assert(
      fc.property(whisperOutputArb, (json) => {
        const result = parseWhisperOutput(json);
        let wordIndex = 0;
        for (const seg of json.segments) {
          for (const w of seg.words) {
            const expected = Math.round(w.start * 1000);
            expect(result[wordIndex].startMs).toBe(expected);
            wordIndex++;
          }
        }
      }),
      { numRuns: 200 }
    );
  });

  it('endMs equals Math.round(end * 1000) for each word', () => {
    fc.assert(
      fc.property(whisperOutputArb, (json) => {
        const result = parseWhisperOutput(json);
        let wordIndex = 0;
        for (const seg of json.segments) {
          for (const w of seg.words) {
            const expected = Math.round(w.end * 1000);
            expect(result[wordIndex].endMs).toBe(expected);
            wordIndex++;
          }
        }
      }),
      { numRuns: 200 }
    );
  });
});
