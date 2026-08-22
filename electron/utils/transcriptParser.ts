/**
 * Whisper.cpp JSON output parser.
 *
 * Converts the raw JSON produced by Whisper.cpp into the application's
 * `TranscriptWord[]` format. Words with a probability below 0.6 are
 * preserved but their `confidence` value reflects the low probability.
 *
 * Validates: Requirements 2.2, 11.1
 */

import type { TranscriptWord } from '../../shared/types';

// ---------------------------------------------------------------------------
// Internal types that mirror the Whisper.cpp JSON schema
// ---------------------------------------------------------------------------

interface WhisperWord {
  word: string;
  start: number;  // seconds
  end: number;    // seconds
  probability: number;  // 0.0–1.0
}

interface WhisperSegment {
  words?: unknown[];
}

interface WhisperOutput {
  segments?: unknown[];
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWhisperWord(value: unknown): value is WhisperWord {
  if (!isObject(value)) return false;

  const { word, start, end, probability } = value as Record<string, unknown>;

  return (
    typeof word === 'string' &&
    typeof start === 'number' &&
    isFinite(start) &&
    start >= 0 &&
    typeof end === 'number' &&
    isFinite(end) &&
    end >= 0 &&
    typeof probability === 'number' &&
    isFinite(probability)
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract the detected language from Whisper JSON output.
 * Returns 'auto' if not present.
 */
export function parseWhisperLanguage(json: unknown): string {
  if (typeof json === 'object' && json !== null) {
    const lang = (json as Record<string, unknown>)['language'];
    if (typeof lang === 'string' && lang.length > 0) return lang;
  }
  return 'auto';
}

/**
 * Parse Whisper.cpp JSON output into a flat array of `TranscriptWord` objects.
 *
 * - Iterates over every segment and every word within each segment.
 * - Converts `start`/`end` from seconds to milliseconds.
 * - Maps `probability` directly to `confidence`.
 * - Words with `probability < 0.6` are included with their actual confidence
 *   value so callers can filter or highlight low-confidence words.
 * - Never throws: returns an empty array for any invalid or missing input.
 *
 * @param json - Raw parsed JSON from Whisper.cpp (type `unknown` for safety).
 * @returns Flat array of `TranscriptWord` objects, or `[]` on invalid input.
 */
export function parseWhisperOutput(json: unknown): TranscriptWord[] {
  if (!isObject(json)) return [];

  const whisper = json as WhisperOutput;

  if (!Array.isArray(whisper.segments)) return [];

  const words: TranscriptWord[] = [];

  for (const segment of whisper.segments) {
    if (!isObject(segment)) continue;

    const seg = segment as WhisperSegment;

    if (!Array.isArray(seg.words)) continue;

    for (const rawWord of seg.words) {
      if (!isWhisperWord(rawWord)) continue;

      const sMs = Math.round(rawWord.start * 1000);
      const rawEndMs = Math.round(rawWord.end * 1000);
      const eMs = (rawEndMs > sMs && rawEndMs - sMs <= 4000) ? rawEndMs : sMs + 800;

      words.push({
        word: rawWord.word,
        startMs: sMs,
        endMs: eMs,
        confidence: rawWord.probability,
      });
    }
  }

  return words;
}
