/**
 * Transcript serialization utilities for SQLite storage.
 *
 * Provides `serializeTranscript` and `deserializeTranscript` to convert
 * `Transcript` objects to/from JSON strings for persistence in the
 * `transcripts.words_json` column.
 *
 * Deserialization is non-throwing: on any failure (malformed JSON, missing
 * fields, wrong types) a typed `TranscriptDeserializationError` is thrown so
 * callers can catch it and surface a recovery option (re-run transcription)
 * rather than crashing the application.
 *
 * Validates: Requirements 11.2, 11.3, 11.5
 */

import type { Transcript, TranscriptWord } from '../../shared/types';

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * Thrown by `deserializeTranscript` when the stored JSON cannot be converted
 * back to a valid `Transcript` object.
 *
 * Callers MUST catch this error and surface a recovery option (e.g. re-run
 * transcription) rather than letting it propagate as an unhandled exception.
 *
 * Requirement 11.5: "IF a Transcript JSON record in SQLite is malformed or
 * fails to deserialize, THEN THE Application SHALL surface a recovery option
 * to re-run transcription for that Project without deleting other Project data."
 */
export class TranscriptDeserializationError extends Error {
  /** The raw JSON string that failed to deserialize. */
  readonly rawJson: string;
  /** The underlying cause (parse error or validation message). */
  readonly cause: unknown;

  constructor(rawJson: string, cause: unknown) {
    const causeMessage =
      cause instanceof Error ? cause.message : String(cause);
    super(`Failed to deserialize Transcript: ${causeMessage}`);
    this.name = 'TranscriptDeserializationError';
    this.rawJson = rawJson;
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a `Transcript` object to a JSON string suitable for storage in
 * the SQLite `transcripts.words_json` column.
 *
 * The full `Transcript` (including `projectId`, `language`, and `words`) is
 * serialized so that `deserializeTranscript` can reconstruct the complete
 * object without needing additional context.
 *
 * @param transcript - The `Transcript` to serialize.
 * @returns A JSON string representation of the transcript.
 */
export function serializeTranscript(transcript: Transcript): string {
  return JSON.stringify(transcript);
}

// ---------------------------------------------------------------------------
// Deserialization
// ---------------------------------------------------------------------------

/**
 * Deserialize a JSON string back to a typed `Transcript` object.
 *
 * Validates the structure of the parsed value:
 * - `projectId` must be a non-empty string
 * - `language` must be a non-empty string
 * - `words` must be an array where every element is a valid `TranscriptWord`
 *
 * Each `TranscriptWord` must have:
 * - `word`: non-empty string
 * - `startMs`: finite number >= 0
 * - `endMs`: finite number > `startMs`
 * - `confidence`: finite number in [0.0, 1.0]
 *
 * @param json - The JSON string to deserialize.
 * @returns A validated `Transcript` object.
 * @throws {TranscriptDeserializationError} When the JSON is malformed or the
 *   structure does not match the `Transcript` schema. Callers must catch this
 *   and offer the user a recovery option (re-run transcription).
 */
export function deserializeTranscript(json: string): Transcript {
  let parsed: unknown;

  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new TranscriptDeserializationError(json, err);
  }

  try {
    return validateTranscript(parsed);
  } catch (err) {
    throw new TranscriptDeserializationError(json, err);
  }
}

// ---------------------------------------------------------------------------
// Internal validation helpers
// ---------------------------------------------------------------------------

/**
 * Validate that `value` conforms to the `Transcript` interface.
 * Throws a plain `Error` with a descriptive message on any violation.
 */
function validateTranscript(value: unknown): Transcript {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a JSON object at the top level.');
  }

  const obj = value as Record<string, unknown>;

  if (typeof obj['projectId'] !== 'string' || obj['projectId'].length === 0) {
    throw new Error(
      `Invalid "projectId": expected a non-empty string, got ${JSON.stringify(obj['projectId'])}.`
    );
  }

  if (typeof obj['language'] !== 'string' || obj['language'].length === 0) {
    throw new Error(
      `Invalid "language": expected a non-empty string, got ${JSON.stringify(obj['language'])}.`
    );
  }

  if (!Array.isArray(obj['words'])) {
    throw new Error(
      `Invalid "words": expected an array, got ${JSON.stringify(obj['words'])}.`
    );
  }

  const words: TranscriptWord[] = (obj['words'] as unknown[]).map(
    (item, index) => validateTranscriptWord(item, index)
  );

  return {
    projectId: obj['projectId'] as string,
    language: obj['language'] as string,
    words,
  };
}

/**
 * Validate that `value` conforms to the `TranscriptWord` interface.
 * Throws a plain `Error` with a descriptive message on any violation.
 */
function validateTranscriptWord(value: unknown, index: number): TranscriptWord {
  const prefix = `words[${index}]`;

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${prefix}: expected an object, got ${JSON.stringify(value)}.`);
  }

  const w = value as Record<string, unknown>;

  // word
  if (typeof w['word'] !== 'string' || w['word'].length === 0) {
    throw new Error(
      `${prefix}.word: expected a non-empty string, got ${JSON.stringify(w['word'])}.`
    );
  }

  // startMs
  if (typeof w['startMs'] !== 'number' || !isFinite(w['startMs']) || w['startMs'] < 0) {
    throw new Error(
      `${prefix}.startMs: expected a finite non-negative number, got ${JSON.stringify(w['startMs'])}.`
    );
  }

  // endMs
  if (typeof w['endMs'] !== 'number' || !isFinite(w['endMs']) || w['endMs'] <= w['startMs']) {
    throw new Error(
      `${prefix}.endMs: expected a finite number greater than startMs (${w['startMs']}), got ${JSON.stringify(w['endMs'])}.`
    );
  }

  // confidence
  if (
    typeof w['confidence'] !== 'number' ||
    !isFinite(w['confidence']) ||
    w['confidence'] < 0 ||
    w['confidence'] > 1
  ) {
    throw new Error(
      `${prefix}.confidence: expected a finite number in [0.0, 1.0], got ${JSON.stringify(w['confidence'])}.`
    );
  }

  return {
    word: w['word'] as string,
    startMs: w['startMs'] as number,
    endMs: w['endMs'] as number,
    confidence: w['confidence'] as number,
    // speakerId is optional — present only when Deepgram diarization was enabled
    ...(typeof w['speakerId'] === 'string' && w['speakerId'].length > 0
      ? { speakerId: w['speakerId'] as string }
      : {}),
  };
}
