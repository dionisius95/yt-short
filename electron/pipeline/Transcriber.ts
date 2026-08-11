/**
 * Transcriber — multi-backend speech-to-text wrapper.
 *
 * Supports three backends in priority order:
 *   1. whisper-cli  (whisper.cpp native binary)
 *   2. whisper      (older whisper.cpp binary name)
 *   3. faster-whisper via Python (pip install faster-whisper)
 *
 * Optionally extracts audio from an MP4 via FFmpeg before transcribing.
 * Emits IPC progress events to the renderer during processing.
 */

import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { BrowserWindow } from 'electron';
import { CHANNELS } from '../ipc/channels';
import { createLogger } from '../utils/logger';
import { parseWhisperOutput, parseWhisperLanguage } from '../utils/transcriptParser';
import type { Transcript, WhisperModelSize } from '../../shared/types';

const log = createLogger('Transcriber');

// ---------------------------------------------------------------------------
// Backend detection
// ---------------------------------------------------------------------------

type Backend = 'whisper-cli' | 'whisper' | 'faster-whisper';

function detectBackend(): Backend {
  for (const name of ['whisper-cli', 'whisper']) {
    try {
      const cmd = process.platform === 'win32' ? `where ${name}` : `which ${name}`;
      execSync(cmd, { stdio: 'pipe' });
      return name as Backend;
    } catch { /* not found */ }
  }
  // Check faster-whisper via Python
  for (const py of ['python', 'python3']) {
    try {
      execSync(`${py} -c "import faster_whisper"`, { stdio: 'pipe' });
      return 'faster-whisper';
    } catch { /* not found */ }
  }
  throw new Error(
    'No Whisper backend found. Install whisper-cli (whisper.cpp) or run: pip install faster-whisper'
  );
}

function detectPython(): string {
  for (const py of ['python', 'python3']) {
    try {
      execSync(`${py} --version`, { stdio: 'pipe' });
      return py;
    } catch { /* try next */ }
  }
  throw new Error('Python not found. Install Python 3.8+ to use faster-whisper.');
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Emit a transcription progress event to all renderer windows.
 */
function emitProgress(projectId: string, percent: number): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(CHANNELS.TRANSCRIBE_PROGRESS, { projectId, percent });
    }
  }
}

/**
 * Run a child process and collect its stdout/stderr.
 * Resolves with stdout on exit code 0, rejects otherwise.
 */
function runProcess(
  command: string,
  args: string[],
  onStderr?: (line: string) => void,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: env || process.env });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      // faster-whisper may print progress to stdout
      if (onStderr) {
        for (const line of chunk.toString().split('\n')) {
          if (line.trim()) onStderr(line.trim());
        }
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      if (onStderr) {
        for (const line of text.split('\n')) {
          if (line.trim()) onStderr(line.trim());
        }
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`${command} spawn error: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `${command} exited with code ${code}. stderr: ${stderr.slice(-500)}`,
          ),
        );
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * Extract a mono 16 kHz WAV from an MP4 using FFmpeg.
 * Returns the path to the temporary WAV file.
 */
async function extractAudio(mp4Path: string): Promise<string> {
  const wavPath = path.join(
    os.tmpdir(),
    `whisper-audio-${Date.now()}.wav`,
  );

  await runProcess('ffmpeg', [
    '-y',           // overwrite output
    '-i', mp4Path,
    '-vn',          // no video
    '-ar', '16000', // 16 kHz sample rate (required by Whisper)
    '-ac', '1',     // mono
    '-f', 'wav',
    wavPath,
  ]);

  return wavPath;
}

/**
 * Extract high-quality FLAC audio from an MP4 for Google Cloud STT.
 * Uses original sample rate (capped at 48kHz) and mono channel.
 * FLAC is lossless and smaller than WAV — better for upload to Google.
 */
async function extractAudioHQ(mp4Path: string): Promise<string> {
  const flacPath = path.join(
    os.tmpdir(),
    `google-stt-audio-${Date.now()}.flac`,
  );

  await runProcess('ffmpeg', [
    '-y',
    '-i', mp4Path,
    '-vn',            // no video
    '-ac', '1',       // mono (better for speech recognition)
    '-ar', '48000',   // 48kHz (high quality, auto-decoded by Chirp 3)
    '-f', 'flac',
    flacPath,
  ]);

  return flacPath;
}

// ---------------------------------------------------------------------------
// Transcriber
// ---------------------------------------------------------------------------

export class Transcriber {
  /**
   * Transcribe an audio or video file using the best available Whisper backend.
   */
  async transcribe(
    projectId: string,
    audioPath: string,
    language: string,
    modelSize: WhisperModelSize,
    modelsDir?: string,
    onProgress?: (percent: number) => void,
    deepgramApiKey?: string,
    googleSttServiceAccountPath?: string,
  ): Promise<Transcript> {
    let currentPct = 0;

    const emitPct = (pct: number) => {
      // Only ever move forward — never regress the bar
      if (pct > currentPct) currentPct = pct;
      emitProgress(projectId, currentPct);
      onProgress?.(currentPct);
    };

    emitPct(0);

    // ── Heartbeat ticker ────────────────────────────────────────────────────
    // While the model is loading (before Whisper emits its first real progress
    // line) we slowly advance the bar so it never appears frozen.
    // Stops as soon as a real progress value arrives or transcription finishes.
    let tickerStopped = false;
    let tickCount = 0;
    const TICKER_MAX_PCT   = 18;   // cap: stop ticking here
    const TICKER_INTERVAL  = 1500; // ms between ticks
    const ticker = setInterval(() => {
      if (tickerStopped || currentPct >= TICKER_MAX_PCT) {
        clearInterval(ticker);
        return;
      }
      // Each tick adds between 1–3% up to the cap
      const step = Math.max(1, Math.round((TICKER_MAX_PCT - currentPct) / 6));
      tickCount++;
      emitPct(Math.min(currentPct + step, TICKER_MAX_PCT));
    }, TICKER_INTERVAL);

    const stopTicker = () => { tickerStopped = true; clearInterval(ticker); };

    let wavPath: string | null = null;
    let inputPath = audioPath;

    // Extract audio from MP4 if necessary
    if (audioPath.toLowerCase().endsWith('.mp4')) {
      log.info({ projectId, audioPath }, 'Extracting audio from MP4');
      emitPct(5);
      wavPath = await extractAudio(audioPath);
      inputPath = wavPath;
      emitPct(15);
    }

    try {
      // ── Google Cloud Speech-to-Text V2 (preferred — same tech as YouTube) ───
      if (googleSttServiceAccountPath && googleSttServiceAccountPath.trim()) {
        log.info({ projectId }, 'Using Google Cloud Speech-to-Text V2 (Chirp 3) backend');
        emitPct(20);
        try {
          // Use high-quality audio extraction for Google STT (48kHz FLAC)
          let googleInputPath = audioPath;
          let googleTempPath: string | null = null;
          if (audioPath.toLowerCase().endsWith('.mp4') || audioPath.toLowerCase().endsWith('.webm') || audioPath.toLowerCase().endsWith('.mkv')) {
            googleTempPath = await extractAudioHQ(audioPath);
            googleInputPath = googleTempPath;
          }
          try {
            const result = await this._runGoogleStt(projectId, googleInputPath, language, googleSttServiceAccountPath.trim(), emitPct);
            stopTicker();
            emitPct(100);
            return result;
          } finally {
            if (googleTempPath) {
              try { fs.unlinkSync(googleTempPath); } catch { /* ignore */ }
            }
          }
        } catch (err) {
          log.warn({ projectId, err }, 'Google Cloud STT failed, trying Deepgram fallback');
        }
      }

      // ── Deepgram (preferred if API key set) ──────────────────────────────
      if (deepgramApiKey && deepgramApiKey.trim()) {
        log.info({ projectId }, 'Using Deepgram Nova-2 backend');
        emitPct(20);
        try {
          const result = await this._runDeepgram(projectId, inputPath, language, deepgramApiKey.trim(), emitPct);
          stopTicker();
          emitPct(100);
          return result;
        } catch (err) {
          log.warn({ projectId, err }, 'Deepgram failed, falling back to Whisper');
        }
      }

      // ── Whisper fallback ─────────────────────────────────────────────────
      const backend = detectBackend();
      log.info({ projectId, backend }, 'Using transcription backend');
      emitPct(20);

      const jsonOutputPath = path.join(os.tmpdir(), `whisper-out-${Date.now()}.json`);

      // Wrap the real-progress callback so it also stops the ticker
      const withTicker = (realPct: number) => {
        stopTicker();
        // Map real whisper progress (0–100) to our 20–95 range
        const mapped = 20 + Math.round((realPct / 100) * 75);
        emitPct(mapped);
      };

      if (backend === 'faster-whisper') {
        await this._runFasterWhisper(projectId, inputPath, language, modelSize, jsonOutputPath, withTicker);
      } else {
        await this._runWhisperCli(projectId, inputPath, language, modelSize, modelsDir, jsonOutputPath, backend, withTicker);
      }

      stopTicker();
      emitPct(95);

      let parsedJson: unknown = {};
      if (fs.existsSync(jsonOutputPath)) {
        try {
          parsedJson = JSON.parse(fs.readFileSync(jsonOutputPath, 'utf-8'));
        } catch {
          log.warn({ projectId }, 'Failed to parse Whisper JSON output');
        }
        try { fs.unlinkSync(jsonOutputPath); } catch { /* ignore */ }
      }

      const words = parseWhisperOutput(parsedJson);
      const detectedLanguage = parseWhisperLanguage(parsedJson);
      emitPct(100);

      return {
        projectId,
        language: detectedLanguage !== 'auto' ? detectedLanguage : language,
        words,
        ...(words.length === 0 ? { isEmpty: true } : {}),
      };
    } finally {
      stopTicker();
      if (wavPath) {
        try { fs.unlinkSync(wavPath); } catch { /* ignore */ }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private — whisper.cpp CLI
  // ---------------------------------------------------------------------------

  private async _runWhisperCli(
    projectId: string,
    inputPath: string,
    language: string,
    modelSize: WhisperModelSize,
    modelsDir: string | undefined,
    jsonOutputPath: string,
    binaryName: string,
    onProgress?: (pct: number) => void,
  ): Promise<void> {
    const modelPath = path.join(
      modelsDir ?? path.join(os.homedir(), '.cache', 'whisper'),
      `ggml-${modelSize}.bin`
    );

    const args = [
      '--output-json',
      '--word-timestamps', 'true',
      '--model', modelPath,
      '--language', language,
      '--output-file', jsonOutputPath.replace(/\.json$/, ''),
      '--file', inputPath,
    ];

    log.debug({ projectId, args }, 'Spawning whisper-cli');

    await runProcess(binaryName, args, (line) => {
      // whisper.cpp format: "whisper_print_progress_callback: progress = 42"
      const match = line.match(/progress\s*=\s*(\d+)/i);
      if (match) {
        onProgress?.(parseInt(match[1], 10));
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Private — faster-whisper via Python script
  // ---------------------------------------------------------------------------

  private async _runFasterWhisper(
    projectId: string,
    inputPath: string,
    language: string,
    modelSize: WhisperModelSize,
    jsonOutputPath: string,
    onProgress?: (pct: number) => void,
  ): Promise<void> {
    const python = detectPython();

    // Resolve the transcribe.py script — works both in dev and packaged app
    const scriptCandidates = [
      path.join(process.resourcesPath ?? '', 'resources', 'transcribe.py'),
      path.join(__dirname, '..', '..', '..', 'resources', 'transcribe.py'),
      path.join(__dirname, '..', '..', 'resources', 'transcribe.py'),
    ];

    let scriptPath = scriptCandidates.find((p) => fs.existsSync(p));
    if (!scriptPath) {
      throw new Error('transcribe.py not found. Reinstall the application.');
    }

    const args = [
      scriptPath,
      '--model',       modelSize,
      '--language',    language,
      '--file',        inputPath,
      '--output-json', jsonOutputPath,
    ];

    log.debug({ projectId, python, args }, 'Spawning faster-whisper');

    const env = {
      ...process.env,
      MKL_NUM_THREADS: '1',
      OMP_NUM_THREADS: '1',
      MKL_DOMAIN_NUM_THREADS: '1',
    };

    await runProcess(python, args, (line) => {
      // faster-whisper prints e.g. "Transcribing: 42%" or "progress = 42"
      const matchPct  = line.match(/(\d+)\s*%/);
      const matchProg = line.match(/progress\s*=\s*(\d+)/i);
      const raw = matchPct ? matchPct[1] : matchProg ? matchProg[1] : null;
      if (raw !== null) {
        onProgress?.(parseInt(raw, 10));
      }
    }, env);
  }

  // ---------------------------------------------------------------------------
  // Private — Google Cloud Speech-to-Text V2 (Chirp — same as YouTube)
  // Uses Service Account JSON key file for OAuth2 authentication.
  // ---------------------------------------------------------------------------

  /**
   * Generate an OAuth2 access token from a Service Account JSON key file
   * using JWT (RS256) signing — no gcloud CLI or SDK needed.
   */
  private async _getGoogleAccessToken(serviceAccountPath: string): Promise<{ accessToken: string; projectId: string }> {
    const keyFileContent = fs.readFileSync(serviceAccountPath, 'utf-8');
    const keyData = JSON.parse(keyFileContent) as {
      client_email: string;
      private_key: string;
      project_id: string;
      token_uri?: string;
    };

    if (!keyData.client_email || !keyData.private_key || !keyData.project_id) {
      throw new Error('Invalid Service Account JSON: missing client_email, private_key, or project_id');
    }

    const crypto = await import('crypto');
    const tokenUri = keyData.token_uri || 'https://oauth2.googleapis.com/token';
    const scope = 'https://www.googleapis.com/auth/cloud-platform';
    const now = Math.floor(Date.now() / 1000);

    // Build JWT header and claim set
    const header = { alg: 'RS256', typ: 'JWT' };
    const claimSet = {
      iss: keyData.client_email,
      scope,
      aud: tokenUri,
      iat: now,
      exp: now + 3600, // 1 hour
    };

    const encodeBase64Url = (obj: unknown): string => {
      return Buffer.from(JSON.stringify(obj))
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    };

    const headerEncoded = encodeBase64Url(header);
    const claimSetEncoded = encodeBase64Url(claimSet);
    const signInput = `${headerEncoded}.${claimSetEncoded}`;

    // Sign with RSA-SHA256
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(signInput);
    const signature = sign.sign(keyData.private_key, 'base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const jwt = `${signInput}.${signature}`;

    // Exchange JWT for access token
    const tokenResponse = await fetch(tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    });

    if (!tokenResponse.ok) {
      const errText = await tokenResponse.text();
      throw new Error(`Failed to get Google access token: ${tokenResponse.status} — ${errText.slice(0, 200)}`);
    }

    const tokenData = await tokenResponse.json() as { access_token: string };
    return { accessToken: tokenData.access_token, projectId: keyData.project_id };
  }

  private async _runGoogleStt(
    projectId: string,
    audioPath: string,
    language: string,
    serviceAccountPath: string,
    emitPct: (pct: number) => void,
  ): Promise<Transcript> {
    log.info({ projectId, audioPath, language }, 'Sending to Google Cloud Speech-to-Text V2 (Chirp)');
    emitPct(25);

    // Get OAuth2 access token from service account
    const { accessToken, projectId: gcpProjectId } = await this._getGoogleAccessToken(serviceAccountPath);
    log.info({ projectId, gcpProjectId }, 'Google Cloud access token obtained');

    // Google STT V2 sync recognize: max 60s / 10MB per request.
    // For longer audio, split into ~55s chunks.
    const CHUNK_DURATION_SEC = 55;
    const audioStats = fs.statSync(audioPath);
    const audioSizeMB = audioStats.size / (1024 * 1024);

    // Get audio duration via ffprobe
    let audioDurationSec = 0;
    try {
      const { execSync: execSyncLocal } = require('child_process') as typeof import('child_process');
      const durationOutput = execSyncLocal(
        `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${audioPath}"`,
        { stdio: 'pipe' },
      ).toString().trim();
      audioDurationSec = parseFloat(durationOutput) || 0;
    } catch {
      // If ffprobe fails, estimate from file size (16kHz mono WAV ≈ 32KB/s)
      audioDurationSec = audioSizeMB * 1024 / 32;
    }

    log.info({ projectId, audioDurationSec, audioSizeMB }, 'Audio info for Google STT');

    // Map language codes - Google STT uses BCP-47 codes
    const langMap: Record<string, string> = {
      id: 'id-ID', en: 'en-US', ms: 'ms-MY', zh: 'zh-CN', ja: 'ja-JP',
      ko: 'ko-KR', es: 'es-ES', fr: 'fr-FR', de: 'de-DE', pt: 'pt-BR',
      ar: 'ar-SA', hi: 'hi-IN', th: 'th-TH', vi: 'vi-VN', ru: 'ru-RU',
      it: 'it-IT', nl: 'nl-NL', tr: 'tr-TR', pl: 'pl-PL', sv: 'sv-SE',
    };

    const languageCodes = language === 'auto'
      ? ['auto'] // Chirp 3 supports language-agnostic auto-detection
      : [langMap[language.toLowerCase()] ?? langMap[language.split('-')[0]?.toLowerCase()] ?? `${language}-${language.toUpperCase()}`];

    let allWords: import('../../shared/types').TranscriptWord[] = [];
    let detectedLang = language;

    if (audioDurationSec <= 60 && audioSizeMB <= 9.5) {
      // Short audio — single request
      emitPct(30);
      const result = await this._googleSttRequest(audioPath, languageCodes, accessToken, gcpProjectId);
      allWords = result.words;
      detectedLang = result.detectedLang || detectedLang;
    } else {
      // Long audio — split into chunks using ffmpeg
      const totalChunks = Math.ceil(audioDurationSec / CHUNK_DURATION_SEC);
      log.info({ projectId, totalChunks, audioDurationSec }, 'Splitting audio for Google STT');

      for (let i = 0; i < totalChunks; i++) {
        const startSec = i * CHUNK_DURATION_SEC;
        const chunkPath = path.join(os.tmpdir(), `google-stt-chunk-${Date.now()}-${i}.flac`);

        try {
          // Extract chunk with ffmpeg — high quality FLAC for better accuracy
          await runProcess('ffmpeg', [
            '-y', '-i', audioPath,
            '-ss', String(startSec),
            '-t', String(CHUNK_DURATION_SEC + 1), // +1s buffer
            '-ac', '1', '-ar', '48000', '-f', 'flac',
            chunkPath,
          ]);

          const result = await this._googleSttRequest(chunkPath, languageCodes, accessToken, gcpProjectId);

          if (result.detectedLang) detectedLang = result.detectedLang;

          // Offset word timestamps by chunk start
          const offsetMs = startSec * 1000;
          for (const w of result.words) {
            allWords.push({
              ...w,
              startMs: w.startMs + offsetMs,
              endMs: w.endMs + offsetMs,
            });
          }
        } finally {
          try { fs.unlinkSync(chunkPath); } catch { /* ignore */ }
        }

        // Progress: 30 → 90 based on chunks processed
        emitPct(30 + Math.round(((i + 1) / totalChunks) * 60));
      }
    }

    log.info({ projectId, wordCount: allWords.length, detectedLang }, 'Google Cloud STT transcription complete');
    emitPct(95);

    return {
      projectId,
      language: detectedLang !== 'auto' ? detectedLang : language,
      words: allWords,
      ...(allWords.length === 0 ? { isEmpty: true } : {}),
    };
  }

  /**
   * Send a single audio file to Google Cloud STT V2 with Bearer token auth.
   */
  private async _googleSttRequest(
    audioPath: string,
    languageCodes: string[],
    accessToken: string,
    gcpProjectId: string,
  ): Promise<{ words: import('../../shared/types').TranscriptWord[]; detectedLang?: string }> {
    const audioBuffer = fs.readFileSync(audioPath);
    const audioBytes = audioBuffer.toString('base64');

    const requestBody = {
      config: {
        autoDecodingConfig: {},
        languageCodes,
        model: 'chirp_3',
        features: {
          enableWordTimeOffsets: true,
          enableAutomaticPunctuation: true,
        },
      },
      content: audioBytes,
    };

    const url = `https://us-speech.googleapis.com/v2/projects/${gcpProjectId}/locations/us/recognizers/_:recognize`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Google Cloud STT error ${response.status}: ${errText.slice(0, 300)}`);
    }

    interface GcpWordInfo {
      word: string;
      startOffset?: string;
      endOffset?: string;
      confidence?: number;
    }

    interface GcpAlternative {
      transcript?: string;
      confidence?: number;
      words?: GcpWordInfo[];
    }

    interface GcpResult {
      alternatives?: GcpAlternative[];
      languageCode?: string;
    }

    interface GcpResponse {
      results?: GcpResult[];
    }

    const data = await response.json() as GcpResponse;
    const words: import('../../shared/types').TranscriptWord[] = [];
    let detectedLang: string | undefined;

    for (const result of data.results ?? []) {
      if (result.languageCode) {
        detectedLang = result.languageCode.split('-')[0];
      }
      const alternative = result.alternatives?.[0];
      if (!alternative?.words) continue;

      for (const w of alternative.words) {
        words.push({
          word: w.word,
          startMs: this._parseDuration(w.startOffset),
          endMs: this._parseDuration(w.endOffset),
          confidence: w.confidence ?? 0.9,
        });
      }
    }

    return { words, detectedLang };
  }

  /**
   * Parse Google's duration string format ("1.500s", "0.200s") into milliseconds.
   */
  private _parseDuration(duration?: string): number {
    if (!duration) return 0;
    // Remove trailing 's' and parse as float seconds
    const seconds = parseFloat(duration.replace(/s$/i, ''));
    return Math.round((isNaN(seconds) ? 0 : seconds) * 1000);
  }

  // ---------------------------------------------------------------------------
  // Private — Deepgram Nova-2
  // ---------------------------------------------------------------------------

  private async _runDeepgram(
    projectId: string,
    audioPath: string,
    language: string,
    apiKey: string,
    emitPct: (pct: number) => void,
  ): Promise<import('../../shared/types').Transcript> {
    log.info({ projectId, audioPath, language }, 'Sending to Deepgram Nova-2');
    emitPct(25);

    const audioBuffer = fs.readFileSync(audioPath);
    const ext = path.extname(audioPath).toLowerCase().replace('.', '');
    const mimeMap: Record<string, string> = {
      wav: 'audio/wav', mp3: 'audio/mpeg', mp4: 'audio/mp4',
      m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac',
      webm: 'audio/webm',
    };
    const mimeType = mimeMap[ext] ?? 'audio/wav';

    // Build query params
    const params = new URLSearchParams({
      model:           'nova-2',
      smart_format:    'true',
      punctuate:       'true',
      utterances:      'false',
      words:           'true',
      diarize:         'true',   // enable per-word speaker labels
    });

    // Language: 'auto' → let Deepgram detect; otherwise pass ISO code
    if (language && language !== 'auto') {
      params.set('language', language);
      params.set('detect_language', 'false');
    } else {
      params.set('detect_language', 'true');
    }

    const url = `https://api.deepgram.com/v1/listen?${params.toString()}`;

    emitPct(30);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Token ${apiKey}`,
        'Content-Type': mimeType,
      },
      body: audioBuffer as any,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Deepgram API error ${response.status}: ${errText.slice(0, 300)}`);
    }

    emitPct(80);

    const data = await response.json() as {
      results?: {
        channels?: Array<{
          alternatives?: Array<{
            words?: Array<{
              word: string;
              start: number;
              end: number;
              confidence: number;
              speaker?: number;
            }>;
          }>;
          detected_language?: string;
        }>;
      };
      metadata?: { detected_language?: string };
    };

    const channel = data.results?.channels?.[0];
    const alternative = channel?.alternatives?.[0];
    const rawWords = alternative?.words ?? [];
    const detectedLang = channel?.detected_language
      ?? data.metadata?.detected_language
      ?? language;

    const words: import('../../shared/types').TranscriptWord[] = rawWords.map((w) => ({
      word:       w.word,
      startMs:    Math.round(w.start * 1000),
      endMs:      Math.round(w.end   * 1000),
      confidence: w.confidence,
      ...(w.speaker !== undefined ? { speakerId: `SPEAKER_${String(w.speaker).padStart(2, '0')}` } : {}),
    }));

    const speakerCount = new Set(rawWords.map((w) => w.speaker).filter((s) => s !== undefined)).size;
    log.info({ projectId, wordCount: words.length, detectedLang, speakerCount }, 'Deepgram transcription complete');
    emitPct(95);

    return {
      projectId,
      language: detectedLang !== 'auto' ? detectedLang : language,
      words,
      ...(words.length === 0 ? { isEmpty: true } : {}),
    };
  }
}
