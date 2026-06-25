/**
 * Unit tests for transcriptSerializer.ts
 *
 * Validates Requirements 11.2, 11.3, 11.5
 */
import { describe, it, expect } from 'vitest';
import {
  serializeTranscript,
  deserializeTranscript,
  TranscriptDeserializationError,
} from '../../electron/utils/transcriptSerializer';
import type { Transcript } from '../../shared/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MINIMAL_TRANSCRIPT: Transcript = {
  projectId: 'proj-001',
  language: 'en',
  words: [],
};

const FULL_TRANSCRIPT: Transcript = {
  projectId: 'proj-abc',
  language: 'fr',
  words: [
    { word: 'Hello', startMs: 0, endMs: 500, confidence: 0.99 },
    { word: 'world', startMs: 510, endMs: 900, confidence: 0.75 },
    { word: 'low', startMs: 910, endMs: 1200, confidence: 0.45 },
  ],
};

// ---------------------------------------------------------------------------
// serializeTranscript
// ---------------------------------------------------------------------------

describe('serializeTranscript', () => {
  it('returns a string', () => {
    expect(typeof serializeTranscript(MINIMAL_TRANSCRIPT)).toBe('string');
  });

  it('produces valid JSON', () => {
    const json = serializeTranscript(FULL_TRANSCRIPT);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('includes all top-level fields', () => {
    const json = serializeTranscript(FULL_TRANSCRIPT);
    const parsed = JSON.parse(json);
    expect(parsed.projectId).toBe(FULL_TRANSCRIPT.projectId);
    expect(parsed.language).toBe(FULL_TRANSCRIPT.language);
    expect(Array.isArray(parsed.words)).toBe(true);
  });

  it('preserves all word fields', () => {
    const json = serializeTranscript(FULL_TRANSCRIPT);
    const parsed = JSON.parse(json);
    expect(parsed.words).toHaveLength(3);
    expect(parsed.words[0]).toEqual({ word: 'Hello', startMs: 0, endMs: 500, confidence: 0.99 });
    expect(parsed.words[2]).toEqual({ word: 'low', startMs: 910, endMs: 1200, confidence: 0.45 });
  });

  it('serializes an empty words array', () => {
    const json = serializeTranscript(MINIMAL_TRANSCRIPT);
    const parsed = JSON.parse(json);
    expect(parsed.words).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// deserializeTranscript — happy path
// ---------------------------------------------------------------------------

describe('deserializeTranscript — valid input', () => {
  it('deserializes a minimal transcript', () => {
    const json = serializeTranscript(MINIMAL_TRANSCRIPT);
    const result = deserializeTranscript(json);
    expect(result.projectId).toBe('proj-001');
    expect(result.language).toBe('en');
    expect(result.words).toEqual([]);
  });

  it('deserializes a full transcript with words', () => {
    const json = serializeTranscript(FULL_TRANSCRIPT);
    const result = deserializeTranscript(json);
    expect(result.projectId).toBe('proj-abc');
    expect(result.language).toBe('fr');
    expect(result.words).toHaveLength(3);
  });

  it('preserves word text exactly', () => {
    const json = serializeTranscript(FULL_TRANSCRIPT);
    const result = deserializeTranscript(json);
    expect(result.words[0].word).toBe('Hello');
    expect(result.words[1].word).toBe('world');
  });

  it('preserves timestamps exactly', () => {
    const json = serializeTranscript(FULL_TRANSCRIPT);
    const result = deserializeTranscript(json);
    expect(result.words[0].startMs).toBe(0);
    expect(result.words[0].endMs).toBe(500);
    expect(result.words[2].startMs).toBe(910);
    expect(result.words[2].endMs).toBe(1200);
  });

  it('preserves confidence scores exactly', () => {
    const json = serializeTranscript(FULL_TRANSCRIPT);
    const result = deserializeTranscript(json);
    expect(result.words[0].confidence).toBe(0.99);
    expect(result.words[2].confidence).toBe(0.45);
  });

  it('round-trips: serialize then deserialize produces equivalent object', () => {
    const json = serializeTranscript(FULL_TRANSCRIPT);
    const result = deserializeTranscript(json);
    expect(result).toEqual(FULL_TRANSCRIPT);
  });

  it('round-trips a transcript with confidence boundary values (0.0 and 1.0)', () => {
    const t: Transcript = {
      projectId: 'p1',
      language: 'en',
      words: [
        { word: 'a', startMs: 0, endMs: 100, confidence: 0.0 },
        { word: 'b', startMs: 200, endMs: 300, confidence: 1.0 },
      ],
    };
    expect(deserializeTranscript(serializeTranscript(t))).toEqual(t);
  });

  it('round-trips a transcript with unicode word text', () => {
    const t: Transcript = {
      projectId: 'p2',
      language: 'ja',
      words: [
        { word: '日本語', startMs: 0, endMs: 500, confidence: 0.9 },
      ],
    };
    expect(deserializeTranscript(serializeTranscript(t))).toEqual(t);
  });
});

// ---------------------------------------------------------------------------
// deserializeTranscript — error cases (Requirement 11.5)
// ---------------------------------------------------------------------------

describe('deserializeTranscript — malformed input throws TranscriptDeserializationError', () => {
  it('throws TranscriptDeserializationError for invalid JSON', () => {
    expect(() => deserializeTranscript('not json {')).toThrow(TranscriptDeserializationError);
  });

  it('throws TranscriptDeserializationError for a JSON array at top level', () => {
    expect(() => deserializeTranscript('[]')).toThrow(TranscriptDeserializationError);
  });

  it('throws TranscriptDeserializationError for a JSON null', () => {
    expect(() => deserializeTranscript('null')).toThrow(TranscriptDeserializationError);
  });

  it('throws TranscriptDeserializationError for a JSON number', () => {
    expect(() => deserializeTranscript('42')).toThrow(TranscriptDeserializationError);
  });

  it('throws TranscriptDeserializationError when projectId is missing', () => {
    const json = JSON.stringify({ language: 'en', words: [] });
    expect(() => deserializeTranscript(json)).toThrow(TranscriptDeserializationError);
  });

  it('throws TranscriptDeserializationError when projectId is empty string', () => {
    const json = JSON.stringify({ projectId: '', language: 'en', words: [] });
    expect(() => deserializeTranscript(json)).toThrow(TranscriptDeserializationError);
  });

  it('throws TranscriptDeserializationError when language is missing', () => {
    const json = JSON.stringify({ projectId: 'p1', words: [] });
    expect(() => deserializeTranscript(json)).toThrow(TranscriptDeserializationError);
  });

  it('throws TranscriptDeserializationError when words is not an array', () => {
    const json = JSON.stringify({ projectId: 'p1', language: 'en', words: 'bad' });
    expect(() => deserializeTranscript(json)).toThrow(TranscriptDeserializationError);
  });

  it('throws TranscriptDeserializationError when a word entry is missing the word field', () => {
    const json = JSON.stringify({
      projectId: 'p1',
      language: 'en',
      words: [{ startMs: 0, endMs: 100, confidence: 0.9 }],
    });
    expect(() => deserializeTranscript(json)).toThrow(TranscriptDeserializationError);
  });

  it('throws TranscriptDeserializationError when startMs is negative', () => {
    const json = JSON.stringify({
      projectId: 'p1',
      language: 'en',
      words: [{ word: 'hi', startMs: -1, endMs: 100, confidence: 0.9 }],
    });
    expect(() => deserializeTranscript(json)).toThrow(TranscriptDeserializationError);
  });

  it('throws TranscriptDeserializationError when endMs <= startMs', () => {
    const json = JSON.stringify({
      projectId: 'p1',
      language: 'en',
      words: [{ word: 'hi', startMs: 100, endMs: 100, confidence: 0.9 }],
    });
    expect(() => deserializeTranscript(json)).toThrow(TranscriptDeserializationError);
  });

  it('throws TranscriptDeserializationError when confidence is out of range (> 1)', () => {
    const json = JSON.stringify({
      projectId: 'p1',
      language: 'en',
      words: [{ word: 'hi', startMs: 0, endMs: 100, confidence: 1.5 }],
    });
    expect(() => deserializeTranscript(json)).toThrow(TranscriptDeserializationError);
  });

  it('throws TranscriptDeserializationError when confidence is out of range (< 0)', () => {
    const json = JSON.stringify({
      projectId: 'p1',
      language: 'en',
      words: [{ word: 'hi', startMs: 0, endMs: 100, confidence: -0.1 }],
    });
    expect(() => deserializeTranscript(json)).toThrow(TranscriptDeserializationError);
  });

  it('error message is descriptive', () => {
    try {
      deserializeTranscript('not json');
    } catch (err) {
      expect(err).toBeInstanceOf(TranscriptDeserializationError);
      expect((err as TranscriptDeserializationError).message).toContain(
        'Failed to deserialize Transcript'
      );
    }
  });

  it('error exposes the raw JSON string', () => {
    const badJson = '{"projectId":"","language":"en","words":[]}';
    try {
      deserializeTranscript(badJson);
    } catch (err) {
      expect(err).toBeInstanceOf(TranscriptDeserializationError);
      expect((err as TranscriptDeserializationError).rawJson).toBe(badJson);
    }
  });

  it('does not throw for an empty words array (valid)', () => {
    const json = JSON.stringify({ projectId: 'p1', language: 'en', words: [] });
    expect(() => deserializeTranscript(json)).not.toThrow();
  });
});
