/**
 * Analyzer — Hook detection using Vertex AI Gemini (primary) or Ollama (fallback).
 *
 * Vertex AI Gemini: fast, accurate, reliable JSON output, understands viral content.
 * Ollama: local fallback when no service account or Gemini fails.
 */

import { parseHooks, clampHooks } from '../utils/hookParser';
import { createLogger } from '../utils/logger';
import { ensureOllamaRunning } from '../utils/ollamaHealth';
import type { Transcript, Hook, AppError } from '../../shared/types';
import crypto from 'crypto';
import fs from 'fs';

const log = createLogger('Analyzer');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_PARSE_RETRIES = 2;
const MIN_HOOKS = 1;

// ---------------------------------------------------------------------------
// Transcript builder
// ---------------------------------------------------------------------------

const LINE_SIZE = 12;

/**
 * Build a full transcript text — used for Gemini which supports very large
 * context windows (up to 1M tokens). No word limit is applied.
 */
function buildTranscriptText(transcript: Transcript): string {
  const lines: string[] = [];
  const words = transcript.words;
  for (let i = 0; i < words.length; i += LINE_SIZE) {
    const group = words.slice(i, i + LINE_SIZE);
    const timeSec = Math.round(group[0].startMs / 1000);
    const text = group.map((w) => w.word).join(' ');
    lines.push(`[${timeSec}s] ${text}`);
  }
  return lines.join('\n');
}

/**
 * Build a sampled transcript for Ollama (limited context window).
 *
 * Strategy: evenly sample up to MAX_WORDS words across the entire video so
 * that ALL parts of the video are represented, not just the first N minutes.
 *
 * Example: a 10 000-word transcript sampled to 1 200 words picks one word
 * roughly every 8 words, preserving timestamps and coverage end-to-end.
 */
function buildSampledTranscriptText(transcript: Transcript, maxWords = 1200): string {
  const words = transcript.words;
  if (words.length === 0) return '';

  // If short enough, use all words
  if (words.length <= maxWords) return buildTranscriptText(transcript);

  // Pick evenly-spaced indices across the full word list
  const step = words.length / maxWords;
  const sampled = Array.from({ length: maxWords }, (_, i) => words[Math.round(i * step)]);

  const lines: string[] = [];
  for (let i = 0; i < sampled.length; i += LINE_SIZE) {
    const group = sampled.slice(i, i + LINE_SIZE);
    const timeSec = Math.round(group[0].startMs / 1000);
    const text = group.map((w) => w.word).join(' ');
    lines.push(`[${timeSec}s] ${text}`);
  }
  return lines.join('\n');
}

/**
 * Split words into N roughly equal chunks and return the transcript text
 * for each chunk. Used by the Ollama chunking path.
 */
function buildChunkedTranscriptTexts(transcript: Transcript, chunkCount: number): string[] {
  const words = transcript.words;
  if (words.length === 0) return [];

  const chunkSize = Math.ceil(words.length / chunkCount);
  const chunks: string[] = [];

  for (let c = 0; c < chunkCount; c++) {
    const slice = words.slice(c * chunkSize, (c + 1) * chunkSize);
    if (slice.length === 0) continue;
    const lines: string[] = [];
    for (let i = 0; i < slice.length; i += LINE_SIZE) {
      const group = slice.slice(i, i + LINE_SIZE);
      const timeSec = Math.round(group[0].startMs / 1000);
      const text = group.map((w) => w.word).join(' ');
      lines.push(`[${timeSec}s] ${text}`);
    }
    chunks.push(lines.join('\n'));
  }

  return chunks;
}

// Map ISO 639-1 codes to full language names that LLMs understand reliably
const ISO_TO_LANGUAGE: Record<string, string> = {
  id: 'Indonesian',
  en: 'English',
  ms: 'Malay',
  zh: 'Chinese',
  ja: 'Japanese',
  ko: 'Korean',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  pt: 'Portuguese',
  ar: 'Arabic',
  hi: 'Hindi',
  th: 'Thai',
  vi: 'Vietnamese',
  ru: 'Russian',
  it: 'Italian',
  nl: 'Dutch',
  tr: 'Turkish',
  pl: 'Polish',
  sv: 'Swedish',
};

function detectLanguage(transcript: Transcript): string {
  const code = transcript.language;
  if (!code || code === 'auto' || code === 'unknown' || code === 'und') {
    return 'the same language as the transcript';
  }
  // Try exact match, then prefix match (e.g. "zh-TW" → "zh")
  return ISO_TO_LANGUAGE[code]
    ?? ISO_TO_LANGUAGE[code.split('-')[0]]
    ?? code;
}

// ---------------------------------------------------------------------------
// Sanitizer
// ---------------------------------------------------------------------------

/**
 * Strip ASCII control characters and truncate to 200 characters.
 * Exported so it can be tested independently.
 */
export function sanitizeMomentTheme(raw: string): string {
  // Remove ASCII control chars: \x00–\x08, \x0B, \x0C, \x0E–\x1F, \x7F
  // (keep \x09 = tab, \x0A = newline, \x0D = carriage return as they are safe)
  const cleaned = raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  return cleaned.slice(0, 200);
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildSystemPrompt(durationMs?: number, language?: string, momentTheme?: string): string {
  const maxMs = durationMs ?? 600000;
  const durationSec = Math.round(maxMs / 1000);
  const minSegMs = durationMs && durationMs < 120000 ? 15000 : 25000;
  const maxSegMs = durationMs && durationMs < 120000
    ? Math.min(58000, Math.floor(durationMs * 0.8))
    : 58000;
  const langInstruction = language && language !== 'auto' && language !== 'unknown'
    ? `Write all summaries in ${language}.`
    : 'Write summaries in the same language as the transcript.';

  return `You are a video analysis assistant. When given a transcript, you output ONLY a valid JSON array identifying the most engaging segments.

Each object in the array must have:
- "startMs": number (milliseconds from start of video)
- "endMs": number (milliseconds, must satisfy: endMs - startMs >= ${minSegMs} AND endMs - startMs <= ${maxSegMs})
- "viralScore": number between 1 and 100
- "summary": string (brief description of why this segment is engaging)

Constraints:
- Video total duration: ${durationSec} seconds (${maxMs} ms)
- All timestamps must be real values from the transcript, between 0 and ${maxMs}
- Return 3 to 5 segments for long videos, 1 to 3 for short ones
- ${langInstruction}${momentTheme ? `\n- If relevant to the theme, give higher priority to segments matching: "${sanitizeMomentTheme(momentTheme)}".` : ''}
- Output ONLY the JSON array. No explanation, no markdown, no extra text.`;
}

function buildUserPrompt(transcriptText: string): string {
  return `Here is the transcript. Identify the most engaging segments and return the JSON array:\n\n${transcriptText}`;
}

function buildRetryUserPrompt(transcriptText: string, durationMs?: number): string {
  const maxMs = durationMs ?? 600000;
  const minSegMs = durationMs && durationMs < 120000 ? 15000 : 25000;
  const maxSegMs = durationMs && durationMs < 120000
    ? Math.min(58000, Math.floor(durationMs * 0.8))
    : 58000;

  return `The previous response was not valid JSON. Try again.

Return ONLY a JSON array like this (use real timestamps from the transcript, not these placeholder values):
[{"startMs":10000,"endMs":45000,"viralScore":85,"summary":"description"},{"startMs":60000,"endMs":95000,"viralScore":78,"summary":"description"}]

Rules: each segment duration must be between ${minSegMs}ms and ${maxSegMs}ms. All endMs values must be <= ${maxMs}.

TRANSCRIPT:
${transcriptText}`;
}

// ---------------------------------------------------------------------------
// Vertex AI Gemini (Google Cloud) via Generative Language API
// ---------------------------------------------------------------------------

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
}

/**
 * Call Gemini via Vertex AI (Google Cloud credits only).
 * Uses service account OAuth2 for authentication.
 */
async function callGemini(
  systemPrompt: string,
  userPrompt: string,
  serviceAccountPath?: string,
): Promise<string> {
  if (serviceAccountPath && fs.existsSync(serviceAccountPath)) {
    return await _callGeminiVertexAI(systemPrompt, userPrompt, serviceAccountPath);
  }

  throw new Error('Google Cloud Service Account JSON Key (Vertex AI) is required for AI Analysis.');
}

/** Vertex AI Gemini — uses Google Cloud credits */
async function _callGeminiVertexAI(
  systemPrompt: string,
  userPrompt: string,
  serviceAccountPath: string,
): Promise<string> {
  const keyData = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf-8')) as {
    client_email: string; private_key: string; project_id: string; token_uri?: string;
  };

  const tokenUri = keyData.token_uri || 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claimSet = { iss: keyData.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: tokenUri, iat: now, exp: now + 3600 };

  const encodeBase64Url = (obj: unknown): string =>
    Buffer.from(JSON.stringify(obj)).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const signInput = `${encodeBase64Url(header)}.${encodeBase64Url(claimSet)}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signInput);
  const signature = sign.sign(keyData.private_key, 'base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const jwt = `${signInput}.${signature}`;
  const tokenResponse = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  if (!tokenResponse.ok) throw new Error(`Token exchange failed: ${tokenResponse.status}`);
  const tokenData = await tokenResponse.json() as { access_token: string };

  const models = ['gemini-3.6-flash', 'gemini-3.0-flash', 'gemini-1.5-flash-002', 'gemini-1.5-flash-001', 'gemini-2.5-flash', 'gemini-2.0-flash-001', 'gemini-1.5-flash'];
  let lastErr: Error | null = null;

  for (const model of models) {
    const url = `https://us-central1-aiplatform.googleapis.com/v1/projects/${keyData.project_id}/locations/us-central1/publishers/google/models/${model}:generateContent`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tokenData.access_token}`,
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 8192, responseMimeType: 'application/json' },
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        if (response.status === 404 || errText.includes('NOT_FOUND')) continue;
        throw new Error(`Vertex AI Gemini error ${response.status}: ${errText.slice(0, 300)}`);
      }

      const data = await response.json() as GeminiResponse;
      return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    } catch (e: any) {
      lastErr = e;
      if (e?.message?.includes('404') || e?.message?.includes('NOT_FOUND')) continue;
      throw e;
    }
  }
  throw lastErr || new Error('All Vertex AI Gemini model candidates failed');
}


// ---------------------------------------------------------------------------
// HTTP helpers (Ollama)
// ---------------------------------------------------------------------------

interface OllamaChatResponse {
  message?: { content: string };
}

type HttpRequestFn = typeof import('http').request;

let _httpRequest: HttpRequestFn | null = null;

export function _setHttpRequest(fn: HttpRequestFn | null): void {
  _httpRequest = fn;
}

function getHttpRequest(): HttpRequestFn {
  if (_httpRequest) return _httpRequest;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('http') as typeof import('http')).request;
}

/**
 * Call Ollama /api/chat endpoint (instruct format).
 * llama3 follows system+user message format much more reliably than /api/generate.
 *
 * Includes retry logic for transient connection errors (ECONNRESET, ECONNREFUSED,
 * EPIPE) which commonly happen when Ollama is idle and needs to wake up or reload
 * the model into memory.
 */
async function callOllamaChat(
  systemPrompt: string,
  userPrompt: string,
  modelName: string,
): Promise<string> {
  const MAX_CONN_RETRIES = 3;
  const RETRY_DELAY_MS   = 3000; // wait 3s between retries to let Ollama recover

  const RETRIABLE_CODES = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'EPIPE',
    'ENOTFOUND',
    'ETIMEDOUT',
    'ECONNABORTED',
    'EAI_AGAIN',
  ]);

  let lastError: Error | AppError | null = null;

  for (let attempt = 0; attempt <= MAX_CONN_RETRIES; attempt++) {
    if (attempt > 0) {
      log.warn({ attempt }, `Retrying Ollama connection in ${RETRY_DELAY_MS}ms...`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      // Re-check if Ollama is alive; if not, try to start it
      await ensureOllamaRunning();
    }

    try {
      const result = await _callOllamaChatOnce(systemPrompt, userPrompt, modelName);
      return result;
    } catch (err: unknown) {
      lastError = err as Error | AppError;
      const errCode = (err as NodeJS.ErrnoException)?.code
                   ?? (err as AppError)?.code
                   ?? '';
      const errDetails = (err as AppError)?.details ?? '';

      // Check if the underlying network error is retriable
      const isRetriable = RETRIABLE_CODES.has(errCode)
        || RETRIABLE_CODES.has(errDetails)
        || (typeof errDetails === 'string' && [...RETRIABLE_CODES].some((c) => errDetails.includes(c)));

      if (!isRetriable) {
        // Non-retriable error (e.g. model not found, parse error) — fail immediately
        throw err;
      }

      log.warn({ attempt, errCode, errDetails }, 'Ollama connection failed (retriable)');
    }
  }

  // All retries exhausted
  throw lastError ?? { code: 'OLLAMA_UNAVAILABLE', message: 'Ollama connection failed after retries' };
}

/** Single attempt to call Ollama /api/chat */
function _callOllamaChatOnce(
  systemPrompt: string,
  userPrompt: string,
  modelName: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const httpRequest = getHttpRequest();

    const body = JSON.stringify({
      model: modelName,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ],
      stream: false,
      options: {
        num_predict: 768,
        num_ctx: 6144,
        temperature: 0.1,
      },
      keep_alive: '10m', // keep model loaded in memory for 10 minutes after request
    });

    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port: 11434,
        path: '/api/chat',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          let body = '';
          res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
          res.on('end', () => {
            const appError: AppError = {
              code: 'OLLAMA_UNAVAILABLE',
              message: `Ollama returned HTTP ${res.statusCode}`,
              details: body.slice(0, 200),
            };
            reject(appError);
          });
          res.resume();
          return;
        }

        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data) as OllamaChatResponse;
            resolve(parsed.message?.content ?? '');
          } catch {
            reject(new Error('Failed to parse Ollama chat response JSON'));
          }
        });
      }
    );

    req.on('error', (err: NodeJS.ErrnoException) => {
      const appError: AppError = {
        code: 'OLLAMA_UNAVAILABLE',
        message: 'Ollama is not running or unreachable at http://localhost:11434',
        details: err.code ?? err.message,
      };
      reject(appError);
    });

    req.setTimeout(1200_000, () => {
      req.destroy();
      reject(new Error('Ollama request timed out after 1200s. Try a shorter video or a faster model.'));
    });

    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// JSON extraction
// ---------------------------------------------------------------------------

function extractJsonArray(raw: string): string {
  let trimmed = raw.trim();

  // Strip markdown code fences
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    trimmed = fenceMatch[1].trim();
  }

  // Find the first '[' and last ']'
  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start !== -1 && end !== -1 && end > start) {
    trimmed = trimmed.slice(start, end + 1);
  } else {
    // Fallback: single object — wrap in array
    const objStart = trimmed.indexOf('{');
    const objEnd = trimmed.lastIndexOf('}');
    if (objStart !== -1 && objEnd !== -1 && objEnd > objStart) {
      trimmed = '[' + trimmed.slice(objStart, objEnd + 1) + ']';
    }
  }

  // Remove ellipsis lines
  trimmed = trimmed
    .split('\n')
    .filter((line) => !/^\s*\.{2,}\s*,?\s*$/.test(line))
    .join('\n');
  trimmed = trimmed.replace(/,\s*\.\.\./g, '').replace(/\.\.\.\s*,/g, '');
  // Remove trailing commas before ] or }
  trimmed = trimmed.replace(/,\s*([}\]])/g, '$1');

  return trimmed;
}

// ---------------------------------------------------------------------------
// Analyzer
// ---------------------------------------------------------------------------

export class Analyzer {
  async detectHooks(
    projectId: string,
    transcript: Transcript,
    modelName: string = 'llama3',
    durationMs?: number,
    serviceAccountPath?: string,
    momentTheme?: string,
  ): Promise<Hook[]> {
    // Short video bypass: ≤90s → single hook covering full video
    const SHORT_VIDEO_THRESHOLD_MS = 90_000;
    if (durationMs && durationMs <= SHORT_VIDEO_THRESHOLD_MS) {
      log.info({ projectId, durationMs }, 'Short video (≤90s) — skipping analysis, using full video as single hook');
      const { randomUUID } = await import('crypto');
      return [{
        id:         randomUUID(),
        projectId,
        startMs:    0,
        endMs:      durationMs,
        viralScore: 85,
        summary:    'Full video clip',
        dismissed:  false,
      }];
    }

    const language = detectLanguage(transcript);
    const systemPrompt = buildSystemPrompt(durationMs, language, momentTheme);

    let hooksData: Hook[] = [];
    let processedSuccessfully = false;

    const GEMINI_WORDS_PER_CHUNK = 5000;
    const totalWords = transcript.words.length;
    const geminiChunkCount = Math.max(1, Math.ceil(totalWords / GEMINI_WORDS_PER_CHUNK));
    const geminiChunkTexts = geminiChunkCount > 1
      ? buildChunkedTranscriptTexts(transcript, geminiChunkCount)
      : [buildSampledTranscriptText(transcript, GEMINI_WORDS_PER_CHUNK)];

    // 1. Try Vertex AI Gemini first
    if (serviceAccountPath && fs.existsSync(serviceAccountPath)) {
      try {
        log.info({ projectId, wordCount: totalWords, geminiChunkCount, language }, 'Starting hook detection via Vertex AI (chunked)');
        let geminiHooks: Hook[] = [];
        for (let chunkIdx = 0; chunkIdx < geminiChunkTexts.length; chunkIdx++) {
          log.debug({ projectId, chunkIdx, geminiChunkCount }, 'Vertex AI: processing chunk');
          const chunkHooks = await this._detectWithGemini(
            projectId, geminiChunkTexts[chunkIdx], systemPrompt, durationMs, serviceAccountPath,
          );
          geminiHooks = geminiHooks.concat(chunkHooks);
        }

        if (geminiHooks.length >= MIN_HOOKS) {
          hooksData = geminiHooks;
          processedSuccessfully = true;
          log.info({ projectId, hookCount: hooksData.length }, 'Vertex AI hook detection complete');
        } else {
          log.warn({ projectId, hookCount: geminiHooks.length }, 'Vertex AI returned insufficient hooks');
        }
      } catch (err) {
        log.warn({ projectId, err }, 'Vertex AI failed');
      }
    }

    if (processedSuccessfully) {
      const clamped = clampHooks(hooksData, projectId);
      if (durationMs) {
        return [
          {
            id:         crypto.randomUUID(),
            projectId,
            startMs:    0,
            endMs:      durationMs,
            viralScore: 100,
            summary:    'Full video clip',
            dismissed:  false,
          },
          ...clamped,
        ];
      }
      return clamped;
    }

    // ── Fallback: Ollama (chunked + sampled for limited context window) ────
    await ensureOllamaRunning();

    log.info({ projectId, modelName, wordCount: transcript.words.length, language }, 'Starting hook detection via Ollama');

    // For long videos, split into chunks so every part of the video is covered.
    // Each chunk is sampled down to ~1200 words to fit Ollama's context window.
    const WORDS_PER_CHUNK = 1200;
    const chunkCount = Math.max(1, Math.ceil(totalWords / WORDS_PER_CHUNK));

    log.info({ projectId, totalWords, chunkCount }, 'Splitting transcript into chunks for Ollama');

    const chunkTexts = chunkCount > 1
      ? buildChunkedTranscriptTexts(transcript, chunkCount)
      : [buildSampledTranscriptText(transcript, WORDS_PER_CHUNK)];

    let allHooks: Hook[] = [];

    for (let chunkIdx = 0; chunkIdx < chunkTexts.length; chunkIdx++) {
      const chunkText = chunkTexts[chunkIdx];
      log.info({ projectId, chunkIdx, chunkCount }, 'Processing transcript chunk');

      let hooks: Hook[] = [];
      let lastParseError: Error | null = null;

      for (let attempt = 0; attempt <= MAX_PARSE_RETRIES; attempt++) {
        const userPrompt = attempt === 0
          ? buildUserPrompt(chunkText)
          : buildRetryUserPrompt(chunkText, durationMs);

        log.debug({ projectId, chunkIdx, attempt }, 'Calling Ollama chat');

        const rawResponse = await callOllamaChat(systemPrompt, userPrompt, modelName);

        log.info({ projectId, chunkIdx, attempt, rawResponseLength: rawResponse.length, rawResponsePreview: rawResponse.slice(0, 500) }, 'Ollama raw response');

        const jsonStr = extractJsonArray(rawResponse);
        log.info({ projectId, chunkIdx, attempt, jsonStr: jsonStr.slice(0, 300) }, 'Extracted JSON string');

        let parsed: unknown;
        try {
          parsed = JSON.parse(jsonStr);
        } catch (err) {
          lastParseError = err instanceof Error ? err : new Error(String(err));
          log.warn({ projectId, chunkIdx, attempt, error: lastParseError.message }, 'Failed to parse Ollama JSON response, retrying');
          continue;
        }

        hooks = parseHooks(parsed, projectId);
        log.info({ projectId, chunkIdx, attempt, parsedHookCount: hooks.length }, 'parseHooks result');

        // Sanity check: if timestamps look like seconds, convert to ms
        if (hooks.length > 0 && durationMs && durationMs > 60000) {
          const maxEnd = Math.max(...hooks.map((h) => h.endMs));
          if (maxEnd < 10000) {
            log.warn({ projectId, chunkIdx, maxEnd, durationMs }, 'Hooks appear to be in seconds, converting to ms');
            hooks = hooks.map((h) => ({
              ...h,
              startMs: h.startMs * 1000,
              endMs:   h.endMs   * 1000,
            }));
          }
        }

        if (hooks.length >= MIN_HOOKS) break;

        log.warn({ projectId, chunkIdx, attempt, hookCount: hooks.length }, 'Insufficient hooks from chunk, retrying');
        lastParseError = new Error(`Only ${hooks.length} valid hooks found`);
      }

      log.info({ projectId, chunkIdx, hookCount: hooks.length }, 'Chunk processing complete');
      allHooks = allHooks.concat(hooks);
    }

    if (allHooks.length >= MIN_HOOKS) {
      const clamped = clampHooks(allHooks, projectId);
      log.info({ projectId, hookCount: clamped.length }, 'Ollama hook detection complete');
      if (durationMs) {
        return [
          {
            id:         crypto.randomUUID(),
            projectId,
            startMs:    0,
            endMs:      durationMs,
            viralScore: 100,
            summary:    'Full video clip',
            dismissed:  false,
          },
          ...clamped,
        ];
      }
      return clamped;
    }

    const appError: AppError = {
      code: 'INSUFFICIENT_HOOKS',
      message: `Could not extract at least ${MIN_HOOKS} valid hooks from the transcript after processing ${chunkTexts.length} chunk(s)`,
      details: `Total hooks found: ${allHooks.length}`,
    };
    throw appError;
  }

  // ---------------------------------------------------------------------------
  // Private — Gemini hook detection
  // ---------------------------------------------------------------------------

  private async _detectWithGemini(
    projectId: string,
    transcriptText: string,
    systemPrompt: string,
    durationMs: number | undefined,
    serviceAccountPath?: string,
  ): Promise<Hook[]> {
    const userPrompt = buildUserPrompt(transcriptText);
    const rawResponse = await callGemini(systemPrompt, userPrompt, serviceAccountPath);

    log.info({ projectId, rawResponseLength: rawResponse.length, rawResponsePreview: rawResponse.slice(0, 500) }, 'Gemini raw response');

    const jsonStr = extractJsonArray(rawResponse);
    const parsed = JSON.parse(jsonStr);
    let hooks = parseHooks(parsed, projectId);

    // Sanity check: if timestamps look like seconds, convert to ms
    if (hooks.length > 0 && durationMs && durationMs > 60000) {
      const maxEnd = Math.max(...hooks.map((h) => h.endMs));
      if (maxEnd < 10000) {
        log.warn({ projectId, maxEnd, durationMs }, 'Gemini hooks appear to be in seconds, converting to ms');
        hooks = hooks.map((h) => ({
          ...h,
          startMs: h.startMs * 1000,
          endMs:   h.endMs   * 1000,
        }));
      }
    }

    return hooks.length > 0 ? clampHooks(hooks, projectId) : hooks;
  }
}
