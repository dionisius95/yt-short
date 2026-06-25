/**
 * Unit tests for the Whisper.cpp transcript parser.
 * Validates Requirements 2.2, 11.1
 */
import { describe, it, expect } from 'vitest';
import { parseWhisperOutput } from '../../electron/utils/transcriptParser';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWord(
  word: string,
  start: number,
  end: number,
  probability: number,
) {
  return { word, start, end, probability };
}

function makeSegment(words: unknown[]) {
  return { words };
}

function makeWhisperJson(segments: unknown[]) {
  return { segments };
}

// ---------------------------------------------------------------------------
// Happy-path parsing
// ---------------------------------------------------------------------------

describe('parseWhisperOutput — valid input', () => {
  it('parses a single word from a single segment', () => {
    const json = makeWhisperJson([
      makeSegment([makeWord(' Hello', 0, 0.5, 0.95)]),
    ]);

    const result = parseWhisperOutput(json);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      word: ' Hello',
      startMs: 0,
      endMs: 500,
      confidence: 0.95,
    });
  });

  it('converts start/end seconds to milliseconds correctly', () => {
    const json = makeWhisperJson([
      makeSegment([makeWord(' world', 1.234, 2.567, 0.9)]),
    ]);

    const result = parseWhisperOutput(json);

    expect(result[0].startMs).toBe(1234);
    expect(result[0].endMs).toBe(2567);
  });

  it('rounds fractional milliseconds', () => {
    // 1.2345 * 1000 = 1234.5 → rounds to 1235
    const json = makeWhisperJson([
      makeSegment([makeWord(' test', 1.2345, 2.5005, 0.8)]),
    ]);

    const result = parseWhisperOutput(json);

    expect(result[0].startMs).toBe(1235);
    expect(result[0].endMs).toBe(2501);
  });

  it('maps probability directly to confidence', () => {
    const json = makeWhisperJson([
      makeSegment([makeWord(' hi', 0, 1, 0.75)]),
    ]);

    const result = parseWhisperOutput(json);

    expect(result[0].confidence).toBe(0.75);
  });

  it('includes words with probability below 0.6 (low confidence)', () => {
    const json = makeWhisperJson([
      makeSegment([makeWord(' unclear', 0, 1, 0.4)]),
    ]);

    const result = parseWhisperOutput(json);

    expect(result).toHaveLength(1);
    expect(result[0].confidence).toBe(0.4);
  });

  it('includes words with probability exactly 0.6', () => {
    const json = makeWhisperJson([
      makeSegment([makeWord(' borderline', 0, 1, 0.6)]),
    ]);

    const result = parseWhisperOutput(json);

    expect(result).toHaveLength(1);
    expect(result[0].confidence).toBe(0.6);
  });

  it('flattens words from multiple segments into a single array', () => {
    const json = makeWhisperJson([
      makeSegment([makeWord(' Hello', 0, 0.5, 0.9), makeWord(' world', 0.5, 1.0, 0.85)]),
      makeSegment([makeWord(' foo', 1.0, 1.5, 0.7), makeWord(' bar', 1.5, 2.0, 0.65)]),
    ]);

    const result = parseWhisperOutput(json);

    expect(result).toHaveLength(4);
    expect(result.map((w) => w.word)).toEqual([' Hello', ' world', ' foo', ' bar']);
  });

  it('preserves word order across segments', () => {
    const json = makeWhisperJson([
      makeSegment([makeWord(' a', 0, 0.1, 0.9)]),
      makeSegment([makeWord(' b', 0.1, 0.2, 0.9)]),
      makeSegment([makeWord(' c', 0.2, 0.3, 0.9)]),
    ]);

    const result = parseWhisperOutput(json);

    expect(result.map((w) => w.word)).toEqual([' a', ' b', ' c']);
  });

  it('handles probability of 0.0 (minimum)', () => {
    const json = makeWhisperJson([
      makeSegment([makeWord(' silent', 0, 1, 0.0)]),
    ]);

    const result = parseWhisperOutput(json);

    expect(result[0].confidence).toBe(0.0);
  });

  it('handles probability of 1.0 (maximum)', () => {
    const json = makeWhisperJson([
      makeSegment([makeWord(' clear', 0, 1, 1.0)]),
    ]);

    const result = parseWhisperOutput(json);

    expect(result[0].confidence).toBe(1.0);
  });

  it('handles a word with start === end (zero-duration)', () => {
    const json = makeWhisperJson([
      makeSegment([makeWord(' instant', 1.5, 1.5, 0.8)]),
    ]);

    const result = parseWhisperOutput(json);

    expect(result[0].startMs).toBe(1500);
    expect(result[0].endMs).toBe(1500);
  });
});

// ---------------------------------------------------------------------------
// Invalid / missing input — must return []
// ---------------------------------------------------------------------------

describe('parseWhisperOutput — invalid input returns empty array', () => {
  it('returns [] for null', () => {
    expect(parseWhisperOutput(null)).toEqual([]);
  });

  it('returns [] for undefined', () => {
    expect(parseWhisperOutput(undefined)).toEqual([]);
  });

  it('returns [] for a plain string', () => {
    expect(parseWhisperOutput('not json')).toEqual([]);
  });

  it('returns [] for a number', () => {
    expect(parseWhisperOutput(42)).toEqual([]);
  });

  it('returns [] for an array at the top level', () => {
    expect(parseWhisperOutput([])).toEqual([]);
  });

  it('returns [] when segments field is missing', () => {
    expect(parseWhisperOutput({})).toEqual([]);
  });

  it('returns [] when segments is not an array', () => {
    expect(parseWhisperOutput({ segments: 'bad' })).toEqual([]);
    expect(parseWhisperOutput({ segments: 42 })).toEqual([]);
    expect(parseWhisperOutput({ segments: null })).toEqual([]);
  });

  it('returns [] for an empty segments array', () => {
    expect(parseWhisperOutput({ segments: [] })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Edge cases — partial / malformed data
// ---------------------------------------------------------------------------

describe('parseWhisperOutput — edge cases', () => {
  it('skips segments that are not objects', () => {
    const json = makeWhisperJson([
      null,
      'bad segment',
      42,
      makeSegment([makeWord(' ok', 0, 1, 0.9)]),
    ]);

    const result = parseWhisperOutput(json);

    expect(result).toHaveLength(1);
    expect(result[0].word).toBe(' ok');
  });

  it('skips segments with no words field', () => {
    const json = makeWhisperJson([
      { text: 'segment without words array' },
      makeSegment([makeWord(' valid', 0, 1, 0.9)]),
    ]);

    const result = parseWhisperOutput(json);

    expect(result).toHaveLength(1);
  });

  it('skips segments where words is not an array', () => {
    const json = makeWhisperJson([
      { words: 'not an array' },
      makeSegment([makeWord(' valid', 0, 1, 0.9)]),
    ]);

    const result = parseWhisperOutput(json);

    expect(result).toHaveLength(1);
  });

  it('skips individual words with missing fields', () => {
    const json = makeWhisperJson([
      makeSegment([
        { word: ' missing-end', start: 0, probability: 0.9 },   // no end
        { word: ' missing-start', end: 1, probability: 0.9 },   // no start
        { start: 0, end: 1, probability: 0.9 },                  // no word
        makeWord(' valid', 0, 1, 0.9),
      ]),
    ]);

    const result = parseWhisperOutput(json);

    expect(result).toHaveLength(1);
    expect(result[0].word).toBe(' valid');
  });

  it('skips words where numeric fields are non-finite (NaN, Infinity)', () => {
    const json = makeWhisperJson([
      makeSegment([
        { word: ' nan-start', start: NaN, end: 1, probability: 0.9 },
        { word: ' inf-end', start: 0, end: Infinity, probability: 0.9 },
        makeWord(' valid', 0, 1, 0.9),
      ]),
    ]);

    const result = parseWhisperOutput(json);

    expect(result).toHaveLength(1);
  });

  it('skips words where fields have wrong types', () => {
    const json = makeWhisperJson([
      makeSegment([
        { word: 123, start: 0, end: 1, probability: 0.9 },       // word is number
        { word: ' ok', start: '0', end: 1, probability: 0.9 },   // start is string
        makeWord(' valid', 0, 1, 0.9),
      ]),
    ]);

    const result = parseWhisperOutput(json);

    expect(result).toHaveLength(1);
  });

  it('handles an empty words array inside a segment', () => {
    const json = makeWhisperJson([makeSegment([])]);

    const result = parseWhisperOutput(json);

    expect(result).toEqual([]);
  });

  it('handles extra unknown fields on word objects gracefully', () => {
    const json = makeWhisperJson([
      makeSegment([
        { word: ' extra', start: 0, end: 1, probability: 0.9, tokens: [1, 2, 3], id: 42 },
      ]),
    ]);

    const result = parseWhisperOutput(json);

    expect(result).toHaveLength(1);
    expect(result[0].word).toBe(' extra');
  });

  it('handles extra unknown fields on segment objects gracefully', () => {
    const json = makeWhisperJson([
      {
        id: 0,
        seek: 0,
        start: 0,
        end: 5,
        text: ' Hello world',
        words: [makeWord(' Hello', 0, 0.5, 0.9), makeWord(' world', 0.5, 1.0, 0.85)],
      },
    ]);

    const result = parseWhisperOutput(json);

    expect(result).toHaveLength(2);
  });
});
