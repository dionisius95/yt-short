/**
 * Property-based tests for transcript serialization utilities.
 *
 * **Validates: Requirements 11.2, 11.3**
 *
 * Property 5: Transcript Serialization Round-Trip
 *
 * For any valid `Transcript` object, serializing then deserializing SHALL
 * produce a `Transcript` structurally equivalent to the original, with all
 * word texts, timestamps, and confidence scores preserved exactly.
 *
 * Also verifies: `deserializeTranscript` throws `TranscriptDeserializationError`
 * for any invalid JSON string.
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { serializeTranscript, deserializeTranscript, TranscriptDeserializationError, } from '../../electron/utils/transcriptSerializer';
// ---------------------------------------------------------------------------
// Arbitraries — valid Transcript structures
// ---------------------------------------------------------------------------
/**
 * Generates a non-empty string suitable for projectId or language.
 * Avoids empty strings which would fail validation.
 */
const nonEmptyStringArb = fc.string({ minLength: 1, maxLength: 50 });
/**
 * Generates a valid TranscriptWord where:
 * - word is non-empty
 * - startMs >= 0
 * - endMs > startMs (strictly, as required by deserializeTranscript)
 * - confidence in [0.0, 1.0]
 */
const transcriptWordArb = fc
    .tuple(nonEmptyStringArb, // word
fc.integer({ min: 0, max: 3_600_000 }), // startMs
fc.integer({ min: 1, max: 10_000 }), // duration (> 0 ensures endMs > startMs)
fc.integer({ min: 0, max: 1_000_000 }).map((n) => n / 1_000_000))
    .map(([word, startMs, duration, confidence]) => ({
    word,
    startMs,
    endMs: startMs + duration, // endMs > startMs always
    confidence,
}));
/**
 * Generates a valid Transcript with:
 * - arbitrary non-empty projectId
 * - arbitrary non-empty language
 * - 0–50 valid TranscriptWord entries
 */
const transcriptArb = fc.record({
    projectId: nonEmptyStringArb,
    language: nonEmptyStringArb,
    words: fc.array(transcriptWordArb, { minLength: 0, maxLength: 50 }),
});
// ---------------------------------------------------------------------------
// Property 5a: Round-trip preserves deep equality
// ---------------------------------------------------------------------------
describe('Property 5a — serialize then deserialize produces the original Transcript', () => {
    it('round-trip is deeply equal to the original for any valid Transcript', () => {
        fc.assert(fc.property(transcriptArb, (transcript) => {
            const json = serializeTranscript(transcript);
            const restored = deserializeTranscript(json);
            expect(restored).toEqual(transcript);
        }), { numRuns: 200 });
    });
});
// ---------------------------------------------------------------------------
// Property 5b: Round-trip preserves projectId exactly
// ---------------------------------------------------------------------------
describe('Property 5b — round-trip preserves projectId', () => {
    it('projectId is identical after round-trip', () => {
        fc.assert(fc.property(transcriptArb, (transcript) => {
            const restored = deserializeTranscript(serializeTranscript(transcript));
            expect(restored.projectId).toBe(transcript.projectId);
        }), { numRuns: 200 });
    });
});
// ---------------------------------------------------------------------------
// Property 5c: Round-trip preserves language exactly
// ---------------------------------------------------------------------------
describe('Property 5c — round-trip preserves language', () => {
    it('language is identical after round-trip', () => {
        fc.assert(fc.property(transcriptArb, (transcript) => {
            const restored = deserializeTranscript(serializeTranscript(transcript));
            expect(restored.language).toBe(transcript.language);
        }), { numRuns: 200 });
    });
});
// ---------------------------------------------------------------------------
// Property 5d: Round-trip preserves word count
// ---------------------------------------------------------------------------
describe('Property 5d — round-trip preserves word count', () => {
    it('words array length is identical after round-trip', () => {
        fc.assert(fc.property(transcriptArb, (transcript) => {
            const restored = deserializeTranscript(serializeTranscript(transcript));
            expect(restored.words.length).toBe(transcript.words.length);
        }), { numRuns: 200 });
    });
});
// ---------------------------------------------------------------------------
// Property 5e: Round-trip preserves all word fields exactly
// ---------------------------------------------------------------------------
describe('Property 5e — round-trip preserves all word fields', () => {
    it('every word text, startMs, endMs, and confidence is preserved exactly', () => {
        fc.assert(fc.property(transcriptArb, (transcript) => {
            const restored = deserializeTranscript(serializeTranscript(transcript));
            for (let i = 0; i < transcript.words.length; i++) {
                const original = transcript.words[i];
                const result = restored.words[i];
                expect(result.word).toBe(original.word);
                expect(result.startMs).toBe(original.startMs);
                expect(result.endMs).toBe(original.endMs);
                expect(result.confidence).toBe(original.confidence);
            }
        }), { numRuns: 200 });
    });
});
// ---------------------------------------------------------------------------
// Property 5f: serializeTranscript always produces valid JSON
// ---------------------------------------------------------------------------
describe('Property 5f — serializeTranscript always produces valid JSON', () => {
    it('output of serializeTranscript is always parseable by JSON.parse', () => {
        fc.assert(fc.property(transcriptArb, (transcript) => {
            const json = serializeTranscript(transcript);
            expect(typeof json).toBe('string');
            expect(() => JSON.parse(json)).not.toThrow();
        }), { numRuns: 200 });
    });
});
// ---------------------------------------------------------------------------
// Property 5g: deserializeTranscript throws TranscriptDeserializationError
//              for any invalid JSON string
// ---------------------------------------------------------------------------
describe('Property 5g — deserializeTranscript throws TranscriptDeserializationError for invalid JSON', () => {
    /**
     * Generates strings that are not valid JSON at all (not parseable by JSON.parse).
     * We filter out strings that happen to be valid JSON.
     */
    const invalidJsonStringArb = fc
        .string({ minLength: 1, maxLength: 100 })
        .filter((s) => {
        try {
            JSON.parse(s);
            return false; // valid JSON — skip
        }
        catch {
            return true; // invalid JSON — keep
        }
    });
    it('throws TranscriptDeserializationError for any non-JSON string', () => {
        fc.assert(fc.property(invalidJsonStringArb, (badJson) => {
            expect(() => deserializeTranscript(badJson)).toThrow(TranscriptDeserializationError);
        }), { numRuns: 200 });
    });
    it('thrown error is always an instance of TranscriptDeserializationError', () => {
        fc.assert(fc.property(invalidJsonStringArb, (badJson) => {
            let caught;
            try {
                deserializeTranscript(badJson);
            }
            catch (err) {
                caught = err;
            }
            expect(caught).toBeInstanceOf(TranscriptDeserializationError);
        }), { numRuns: 200 });
    });
    it('error exposes the original raw JSON string', () => {
        fc.assert(fc.property(invalidJsonStringArb, (badJson) => {
            try {
                deserializeTranscript(badJson);
            }
            catch (err) {
                expect(err).toBeInstanceOf(TranscriptDeserializationError);
                expect(err.rawJson).toBe(badJson);
            }
        }), { numRuns: 200 });
    });
});
// ---------------------------------------------------------------------------
// Property 5h: deserializeTranscript throws for structurally invalid JSON
//              (valid JSON but wrong schema)
// ---------------------------------------------------------------------------
describe('Property 5h — deserializeTranscript throws for structurally invalid JSON objects', () => {
    /**
     * Generates JSON strings that parse successfully but do NOT conform to the
     * Transcript schema (missing required fields, wrong types, etc.).
     */
    const invalidTranscriptJsonArb = fc.oneof(
    // JSON primitives
    fc.constant('null'), fc.constant('42'), fc.constant('"a string"'), fc.constant('true'), 
    // JSON arrays
    fc.constant('[]'), fc.constant('[1,2,3]'), 
    // Objects missing required fields
    fc.record({
        language: nonEmptyStringArb,
        words: fc.constant([]),
    }).map((o) => JSON.stringify(o)), // missing projectId
    fc.record({
        projectId: nonEmptyStringArb,
        words: fc.constant([]),
    }).map((o) => JSON.stringify(o)), // missing language
    fc.record({
        projectId: nonEmptyStringArb,
        language: nonEmptyStringArb,
    }).map((o) => JSON.stringify(o)), // missing words
    // Empty projectId
    fc.record({
        projectId: fc.constant(''),
        language: nonEmptyStringArb,
        words: fc.constant([]),
    }).map((o) => JSON.stringify(o)), 
    // Empty language
    fc.record({
        projectId: nonEmptyStringArb,
        language: fc.constant(''),
        words: fc.constant([]),
    }).map((o) => JSON.stringify(o)));
    it('throws TranscriptDeserializationError for structurally invalid JSON', () => {
        fc.assert(fc.property(invalidTranscriptJsonArb, (badJson) => {
            expect(() => deserializeTranscript(badJson)).toThrow(TranscriptDeserializationError);
        }), { numRuns: 200 });
    });
});
