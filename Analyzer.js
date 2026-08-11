"use strict";
/**
 * Analyzer — Ollama HTTP client + hook detection prompt logic.
 *
 * Sends the transcript to a local Ollama instance, parses the JSON response
 * into validated Hook objects, and retries with a stricter prompt on parse
 * failures. Throws typed AppErrors for unreachable Ollama or insufficient hooks.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Analyzer = void 0;
exports._setHttpRequest = _setHttpRequest;
const hookParser_1 = require("../utils/hookParser");
const logger_1 = require("../utils/logger");
const log = (0, logger_1.createLogger)('Analyzer');
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MAX_PARSE_RETRIES = 2;
const MIN_HOOKS = 1;
// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------
/**
 * Build the transcript text with approximate timestamps embedded.
 * Truncates to max ~2000 words to prevent timeout.
 * Groups into lines of ~12 words for better LLM readability.
 */
function buildTranscriptText(transcript) {
    const MAX_WORDS = 2000;
    const words = transcript.words.slice(0, MAX_WORDS);
    const lines = [];
    const LINE_SIZE = 12;
    for (let i = 0; i < words.length; i += LINE_SIZE) {
        const group = words.slice(i, i + LINE_SIZE);
        const timeSec = Math.round(group[0].startMs / 1000);
        const text = group.map((w) => w.word).join(' ');
        lines.push(`[${timeSec}s] ${text}`);
    }
    return lines.join('\n');
}
/**
 * Detect the dominant language from transcript words.
 * Returns ISO code or 'unknown'.
 */
function detectLanguage(transcript) {
    return transcript.language && transcript.language !== 'auto' && transcript.language !== 'und'
        ? transcript.language
        : 'the same language as the transcript';
}
/**
 * Build the main hook-detection prompt.
 * Improved: explicit viral scoring criteria, language instruction,
 * segment quality rules, and structured output format.
 */ function buildPrompt(transcriptText, durationMs, language) {
    const durationSec = durationMs ? Math.round(durationMs / 1000) : null;
    const maxMs = durationMs ?? 600000;
    const langInstruction = language && language !== 'auto' && language !== 'unknown'
        ? `Write all summaries in ${language}.`
        : 'Write summaries in the SAME LANGUAGE as the transcript.';
    return `IMPORTANT: Your response must be ONLY a valid JSON array. Do not write any text before or after the JSON. Do not explain anything. Do not use ellipsis (...). Output the complete JSON only.

You are a viral short-form video expert. Find the 3-5 best segments from this transcript.
${durationSec ? `Video duration: ${durationSec}s (${maxMs}ms total).` : ''}

RULES:
1. Each segment must be 25000ms to 58000ms long
2. Use MILLISECONDS for startMs and endMs (multiply seconds by 1000)
3. Max timestamp: ${maxMs}ms
4. ${langInstruction}

OUTPUT FORMAT — return ONLY this, no other text:
[
  {"startMs":25000,"endMs":55000,"viralScore":85,"summary":"Why this segment is engaging"}
]

TRANSCRIPT:
${transcriptText}`;
}
/**
 * Stricter retry prompt — minimal, forces JSON output.
 */
function buildStrictPrompt(transcriptText, attempt) {
    return `ATTEMPT ${attempt}. Output ONLY a valid JSON array. Zero prose. Zero markdown. Zero ellipsis.

Format:
[
  {"startMs": NUMBER, "endMs": NUMBER, "viralScore": NUMBER, "summary": "string"}
]

Rules:
- startMs and endMs are in MILLISECONDS
- Each segment: endMs - startMs must be between 25000 and 58000
- Pick 3-5 most engaging moments from the transcript
- Do NOT use ... or ellipsis anywhere in the output

TRANSCRIPT:
${transcriptText}`;
}
let _httpRequest = null;
/** Override the http.request implementation (for testing). */
function _setHttpRequest(fn) {
    _httpRequest = fn;
}
function getHttpRequest() {
    if (_httpRequest)
        return _httpRequest;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('http').request;
}
/**
 * Call the Ollama /api/generate endpoint and return the full response text.
 * Uses Node.js https module (not global fetch) for compatibility with Electron.
 */
async function callOllama(prompt, modelName) {
    return new Promise((resolve, reject) => {
        const httpRequest = getHttpRequest();
        const body = JSON.stringify({
            model: modelName,
            prompt,
            stream: false,
            options: {
                num_predict: 512, // max tokens in response — hooks JSON is short
                num_ctx: 4096, // context window — enough for 800-word transcript
                temperature: 0.1, // low temp = deterministic JSON output
            },
        });
        const req = httpRequest({
            hostname: '127.0.0.1',
            port: 11434,
            path: '/api/generate',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
        }, (res) => {
            if (res.statusCode !== 200) {
                const appError = {
                    code: 'OLLAMA_UNAVAILABLE',
                    message: `Ollama returned HTTP ${res.statusCode}`,
                };
                reject(appError);
                return;
            }
            let data = '';
            res.on('data', (chunk) => { data += chunk.toString(); });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve(parsed.response ?? '');
                }
                catch {
                    reject(new Error('Failed to parse Ollama response JSON'));
                }
            });
        });
        req.on('error', (err) => {
            const appError = {
                code: 'OLLAMA_UNAVAILABLE',
                message: 'Ollama is not running or unreachable at http://localhost:11434',
                details: err.message,
            };
            reject(appError);
        });
        req.setTimeout(300_000, () => {
            req.destroy();
            reject(new Error('Ollama request timed out after 300s. Try a shorter video or a faster model.'));
        });
        req.write(body);
        req.end();
    });
}
/**
 * Extract a JSON array from a raw LLM response string.
 * Strips markdown code fences and leading/trailing prose if present.
 */
function extractJsonArray(raw) {
    let trimmed = raw.trim();
    // Strip markdown code fences (```json ... ``` or ``` ... ```)
    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch) {
        trimmed = fenceMatch[1].trim();
    }
    // Find the first '[' and last ']' to extract the array
    const start = trimmed.indexOf('[');
    const end = trimmed.lastIndexOf(']');
    if (start !== -1 && end !== -1 && end > start) {
        trimmed = trimmed.slice(start, end + 1);
    }
    // Remove ellipsis lines that LLMs sometimes inject (e.g. "  ..." between objects)
    trimmed = trimmed
        .split('\n')
        .filter((line) => !/^\s*\.{2,}\s*,?\s*$/.test(line))
        .join('\n');
    // Remove inline ellipsis patterns like ",  ..." or ", ..." between objects
    trimmed = trimmed.replace(/,\s*\.\.\./g, '').replace(/\.\.\.\s*,/g, '');
    // Remove trailing commas before ] or } (invalid JSON but common LLM output)
    // e.g. {"a":1}, ]  →  {"a":1} ]
    trimmed = trimmed.replace(/,\s*([}\]])/g, '$1');
    return trimmed;
}
// ---------------------------------------------------------------------------
// Analyzer
// ---------------------------------------------------------------------------
class Analyzer {
    /**
     * Detect viral hooks in a transcript using Ollama.
     *
     * @param projectId  - Used to assign projectId to each returned Hook.
     * @param transcript - The transcript to analyze.
     * @param modelName  - Ollama model to use (default: 'llama3').
     * @returns          Array of validated Hook objects (3–20 items).
     * @throws           AppError with code OLLAMA_UNAVAILABLE or INSUFFICIENT_HOOKS.
     */
    async detectHooks(projectId, transcript, modelName = 'llama3', durationMs) {
        // Short video bypass: ≤60s → return single hook covering full video, skip Ollama
        const SHORT_VIDEO_THRESHOLD_MS = 60_000;
        if (durationMs && durationMs <= SHORT_VIDEO_THRESHOLD_MS) {
            log.info({ projectId, durationMs }, 'Short video (≤60s) — skipping analysis, using full video as single hook');
            const { randomUUID } = await Promise.resolve().then(() => __importStar(require('crypto')));
            const language = detectLanguage(transcript);
            const summary = language === 'the same language as the transcript'
                ? 'Full video clip'
                : `Full video clip`;
            return [{
                    id: randomUUID(),
                    projectId,
                    startMs: 0,
                    endMs: durationMs,
                    viralScore: 85,
                    summary,
                    dismissed: false,
                }];
        }
        const transcriptText = buildTranscriptText(transcript);
        const language = detectLanguage(transcript);
        log.info({ projectId, modelName, wordCount: transcript.words.length, truncatedTo: Math.min(transcript.words.length, 2000), language }, 'Starting hook detection');
        let hooks = [];
        let lastParseError = null;
        for (let attempt = 0; attempt <= MAX_PARSE_RETRIES; attempt++) {
            const prompt = attempt === 0
                ? buildPrompt(transcriptText, durationMs, language)
                : buildStrictPrompt(transcriptText, attempt);
            log.debug({ projectId, attempt }, 'Calling Ollama');
            // callOllama throws AppError on network failure — let it propagate
            const rawResponse = await callOllama(prompt, modelName);
            // Log full raw response for debugging
            log.info({ projectId, attempt, rawResponseLength: rawResponse.length, rawResponsePreview: rawResponse.slice(0, 500) }, 'Ollama raw response');
            const jsonStr = extractJsonArray(rawResponse);
            log.info({ projectId, attempt, jsonStr: jsonStr.slice(0, 300) }, 'Extracted JSON string');
            let parsed;
            try {
                parsed = JSON.parse(jsonStr);
            }
            catch (err) {
                lastParseError = err instanceof Error ? err : new Error(String(err));
                log.warn({ projectId, attempt, error: lastParseError.message }, 'Failed to parse Ollama JSON response, retrying with stricter prompt');
                continue;
            }
            hooks = (0, hookParser_1.parseHooks)(parsed, projectId);
            log.info({ projectId, attempt, parsedHookCount: hooks.length, parsedRaw: JSON.stringify(parsed).slice(0, 300) }, 'parseHooks result');
            // Sanity check: if all hooks have endMs < 10000 but durationMs > 60000,
            // Ollama likely returned seconds instead of milliseconds — multiply by 1000
            if (hooks.length > 0 && durationMs && durationMs > 60000) {
                const maxEnd = Math.max(...hooks.map((h) => h.endMs));
                if (maxEnd < 10000) {
                    log.warn({ projectId, maxEnd, durationMs }, 'Hooks appear to be in seconds, converting to ms');
                    hooks = hooks.map((h) => ({
                        ...h,
                        startMs: h.startMs * 1000,
                        endMs: h.endMs * 1000,
                    }));
                }
            }
            if (hooks.length >= MIN_HOOKS) {
                // Success — clamp to [3, 20] and return
                const clamped = (0, hookParser_1.clampHooks)(hooks, projectId);
                log.info({ projectId, hookCount: clamped.length }, 'Hook detection complete');
                return clamped;
            }
            log.warn({ projectId, attempt, hookCount: hooks.length }, 'Insufficient hooks parsed, retrying');
            lastParseError = new Error(`Only ${hooks.length} valid hooks found`);
        }
        // All attempts exhausted
        const appError = {
            code: 'INSUFFICIENT_HOOKS',
            message: `Could not extract at least ${MIN_HOOKS} valid hooks from the transcript after ${MAX_PARSE_RETRIES + 1} attempts`,
            details: lastParseError?.message,
        };
        throw appError;
    }
}
exports.Analyzer = Analyzer;
//# sourceMappingURL=Analyzer.js.map