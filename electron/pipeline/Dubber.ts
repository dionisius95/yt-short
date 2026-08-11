/**
 * Dubber — AI dubbing pipeline.
 *
 * Replaces speech with TTS in target language while preserving background audio.
 * Uses edge-tts (Microsoft Neural TTS) + FFmpeg volume ducking.
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createLogger } from '../utils/logger';
import type { TranscriptWord } from '../../shared/types';

const log = createLogger('Dubber');

// Available TTS voices for Indonesian, English, and other languages (including Google Speech & Gemini)
export const TTS_VOICES: Record<string, { name: string; voices: Array<{ id: string; label: string; provider?: string }> }> = {
  en: {
    name: 'English (US/UK)',
    voices: [
      { id: 'google-en-US-Journey-F', label: 'Google Journey (Female - US Recommended)', provider: 'google' },
      { id: 'google-en-US-Journey-D', label: 'Google Journey (Male - US Recommended)', provider: 'google' },
      { id: 'google-en-US-Journey-O', label: 'Google Journey (Female Conversational - US)', provider: 'google' },
      { id: 'google-en-US-Studio-O',  label: 'Google Studio (Female - US Premium)', provider: 'google' },
      { id: 'google-en-US-Studio-Q',  label: 'Google Studio (Male - US Premium)', provider: 'google' },
      { id: 'gemini-Puck',            label: 'Gemini Voice (Puck - Energetic Male)', provider: 'gemini' },
      { id: 'gemini-Kore',            label: 'Gemini Voice (Kore - Natural Female)', provider: 'gemini' },
      { id: 'xtts-colab-custom',      label: '★ My Cloned Voice (Google Colab XTTS v2)', provider: 'colab' },
      { id: 'en-US-GuyNeural',        label: 'EdgeTTS Guy (Male Free)', provider: 'edge' },
      { id: 'en-US-JennyNeural',      label: 'EdgeTTS Jenny (Female Free)', provider: 'edge' },
    ],
  },
  id: {
    name: 'Indonesian',
    voices: [
      { id: 'google-id-ID-Neural2-B', label: 'Google Neural Ardi (Male)', provider: 'google' },
      { id: 'google-id-ID-Neural2-A', label: 'Google Neural Gadis (Female)', provider: 'google' },
      { id: 'id-ID-ArdiNeural',       label: 'EdgeTTS Ardi (Male)', provider: 'edge' },
      { id: 'id-ID-GadisNeural',      label: 'EdgeTTS Gadis (Female)', provider: 'edge' },
    ],
  },
  ms: {
    name: 'Malay',
    voices: [
      { id: 'ms-MY-OsmanNeural',   label: 'Osman (Male)', provider: 'edge' },
      { id: 'ms-MY-YasminNeural',  label: 'Yasmin (Female)', provider: 'edge' },
    ],
  },
  ja: {
    name: 'Japanese',
    voices: [
      { id: 'google-ja-JP-Neural2-C', label: 'Google Neural Keita (Male)', provider: 'google' },
      { id: 'google-ja-JP-Neural2-B', label: 'Google Neural Nanami (Female)', provider: 'google' },
      { id: 'ja-JP-KeitaNeural',   label: 'EdgeTTS Keita (Male)', provider: 'edge' },
      { id: 'ja-JP-NanamiNeural',  label: 'EdgeTTS Nanami (Female)', provider: 'edge' },
    ],
  },
  zh: {
    name: 'Chinese',
    voices: [
      { id: 'zh-CN-YunxiNeural',   label: 'Yunxi (Male)', provider: 'edge' },
      { id: 'zh-CN-XiaoxiaoNeural', label: 'Xiaoxiao (Female)', provider: 'edge' },
    ],
  },
};


export interface DubOptions {
  sourceFile:   string;
  outputPath:   string;
  words:        TranscriptWord[];
  startMs:      number;
  endMs:        number;
  voice:        string;
  duckDb:       number;
  googleTtsApiKey?: string;
  googleServiceAccountPath?: string;
}

export interface GenerateTtsOptions {
  words:        TranscriptWord[];
  startMs:      number;
  endMs:        number;
  voice:        string;
  googleTtsApiKey?: string;
  googleServiceAccountPath?: string;
  sourceFile:   string;
  xttsColabUrl?: string;
  speakerAudioPath?: string;
}

export class Dubber {
  async generateTts(opts: GenerateTtsOptions): Promise<{ ttsTrackPath: string; alignedTranscriptPath: string }> {
    const { words, startMs, endMs, voice, googleTtsApiKey, googleServiceAccountPath, sourceFile } = opts;

    log.info({ voice, wordCount: words.length, startMs, endMs }, 'Generating and aligning TTS track');

    const python = this._findPython();
    const scriptCandidates = [
      path.join(process.resourcesPath ?? '', 'resources', 'dub.py'),
      path.join(__dirname, '..', '..', '..', 'resources', 'dub.py'),
      path.join(__dirname, '..', '..', 'resources', 'dub.py'),
    ];
    const scriptPath = scriptCandidates.find((p) => fs.existsSync(p));
    if (!scriptPath) throw new Error('dub.py not found. Reinstall the application.');

    const transcriptJson = path.join(os.tmpdir(), `dub-transcript-${Date.now()}.json`);
    fs.writeFileSync(transcriptJson, JSON.stringify(words), 'utf-8');

    const alignedTranscriptPath = path.join(os.tmpdir(), `aligned-transcript-${Date.now()}.json`);
    const ttsTrackPath = path.join(os.tmpdir(), `tts-track-${Date.now()}.wav`);

    const args = [
      scriptPath,
      '--file',       sourceFile,
      '--transcript', transcriptJson,
      '--output',     path.join(os.tmpdir(), `dummy-${Date.now()}.mp4`),
      '--voice',      voice,
      '--start',      String(startMs / 1000),
      '--end',        String(endMs / 1000),
      '--only-tts',
      '--output-transcript', alignedTranscriptPath,
      '--output-tts-track',   ttsTrackPath,
    ];

    if (googleTtsApiKey && googleTtsApiKey.trim()) {
      args.push('--google-tts-key', googleTtsApiKey.trim());
    }

    if (googleServiceAccountPath && fs.existsSync(googleServiceAccountPath)) {
      try {
        const { accessToken, projectId } = await this._getGoogleAccessToken(googleServiceAccountPath);
        args.push('--vertex-access-token', accessToken);
        args.push('--vertex-project-id', projectId);
      } catch (err) {
        log.warn({ googleServiceAccountPath, err }, 'Failed to fetch Vertex access token for dubbing');
      }
    }

    if (voice === 'xtts-colab-custom') {
      if (!opts.xttsColabUrl || !opts.xttsColabUrl.trim()) {
        throw new Error('Google Colab Server URL is required for Cloned Voice! Please enter it in Settings.');
      }
      if (!opts.speakerAudioPath || !fs.existsSync(opts.speakerAudioPath)) {
        throw new Error('Reference Voice Sample (.mp3/.wav) is required for Cloned Voice! Please upload a 15–30s voice sample in Commentator Modal.');
      }
      log.info({ xttsColabUrl: opts.xttsColabUrl, speakerAudioPath: opts.speakerAudioPath }, 'Generating voice clone via Google Colab VoxCPM Server');
      const textToSpeech = words.map((w) => w.word).join(' ');
      await this._callXttsColabApi({
        text: textToSpeech,
        xttsColabUrl: opts.xttsColabUrl.trim(),
        speakerAudioPath: opts.speakerAudioPath,
        outputPath: ttsTrackPath,
      });
      try { fs.unlinkSync(alignedTranscriptPath); } catch {}
      return { ttsTrackPath, alignedTranscriptPath };
    }

    try {
      await this._runProcess(python, args);
      return { ttsTrackPath, alignedTranscriptPath };
    } finally {
      try { fs.unlinkSync(transcriptJson); } catch { /* ignore */ }
    }
  }

  async dub(opts: DubOptions & { ttsTrack?: string }): Promise<void> {
    const { sourceFile, outputPath, words, startMs, endMs, voice, duckDb, googleTtsApiKey, googleServiceAccountPath, ttsTrack } = opts;

    log.info({ voice, wordCount: words.length, startMs, endMs, hasGoogleKey: !!googleTtsApiKey, hasTtsTrack: !!ttsTrack }, 'Starting dubbing');

    const python = this._findPython();
    const scriptCandidates = [
      path.join(process.resourcesPath ?? '', 'resources', 'dub.py'),
      path.join(__dirname, '..', '..', '..', 'resources', 'dub.py'),
      path.join(__dirname, '..', '..', 'resources', 'dub.py'),
    ];
    const scriptPath = scriptCandidates.find((p) => fs.existsSync(p));
    if (!scriptPath) throw new Error('dub.py not found. Reinstall the application.');

    const transcriptJson = path.join(os.tmpdir(), `dub-transcript-${Date.now()}.json`);
    fs.writeFileSync(transcriptJson, JSON.stringify(words), 'utf-8');
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    const args = [
      scriptPath,
      '--file',       sourceFile,
      '--transcript', transcriptJson,
      '--output',     outputPath,
      '--voice',      voice,
      '--duck-db',    String(duckDb),
      '--start',      String(startMs / 1000),
      '--end',        String(endMs / 1000),
    ];

    if (ttsTrack) {
      args.push('--tts-track', ttsTrack);
    }

    if (googleTtsApiKey && googleTtsApiKey.trim()) {
      args.push('--google-tts-key', googleTtsApiKey.trim());
    }

    if (googleServiceAccountPath && fs.existsSync(googleServiceAccountPath)) {
      try {
        const { accessToken, projectId } = await this._getGoogleAccessToken(googleServiceAccountPath);
        args.push('--vertex-access-token', accessToken);
        args.push('--vertex-project-id', projectId);
      } catch (err) {
        log.warn({ googleServiceAccountPath, err }, 'Failed to fetch Vertex access token for dubbing');
      }
    }

    try {
      await this._runProcess(python, args);
      log.info({ outputPath }, 'Dubbing complete');
    } finally {
      try { fs.unlinkSync(transcriptJson); } catch { /* ignore */ }
    }
  }

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

    if (!tokenResponse.ok) throw new Error(`Token exchange failed: ${tokenResponse.status}`);
    const tokenData = await tokenResponse.json() as { access_token: string };
    return { accessToken: tokenData.access_token, projectId: keyData.project_id };
  }

  private _runProcess(command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const modelDir = path.join(os.homedir(), '.audio-separator-models');
      fs.mkdirSync(modelDir, { recursive: true });
      const env = {
        ...process.env,
        AUDIO_SEPARATOR_MODEL_DIR: modelDir,
      };
      const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
      let stderr = '';
      proc.stderr?.on('data', (c: Buffer) => {
        const line = c.toString();
        stderr += line;
        
        const trimmed = line.trim();
        if (
          trimmed.includes('Loading model') ||
          trimmed.includes('Separation') ||
          trimmed.includes('successful') ||
          trimmed.includes('failed') ||
          trimmed.includes('%') ||
          trimmed.includes('Download')
        ) {
          log.info({ line: trimmed }, 'dub.py progress');
        } else {
          log.debug({ line: trimmed }, 'dub.py');
        }
      });
      proc.on('error', (e) => reject(new Error(`${command}: ${e.message}`)));
      proc.on('close', (code) => {
        if (code !== 0) reject(new Error(`dub.py exited ${code}: ${stderr.slice(-500)}`));
        else resolve();
      });
      // 10 minute timeout for long videos
      setTimeout(() => { proc.kill(); reject(new Error('Dubbing timed out after 10 minutes')); }, 600_000);
    });
  }

  private async _callXttsColabApi(opts: {
    text: string;
    xttsColabUrl: string;
    speakerAudioPath?: string;
    outputPath: string;
    language?: string;
  }): Promise<void> {
    const { text, xttsColabUrl, speakerAudioPath, outputPath } = opts;
    const language = opts.language || 'en';
    let speakerWavB64 = '';
    if (speakerAudioPath && fs.existsSync(speakerAudioPath)) {
      try {
        const buf = fs.readFileSync(speakerAudioPath);
        speakerWavB64 = buf.toString('base64');
      } catch (err) {
        log.warn({ err, speakerAudioPath }, 'Failed to read reference speaker audio file');
      }
    }

    const rawUrl = xttsColabUrl.trim();
    // Normalize URL: handle if user inputs https://domain.com/tts, https://domain.com/clone, or base domain
    const baseHostUrl = rawUrl.replace(/\/+(clone|tts)?\/*$/i, '');
    const candidateUrls = [
      rawUrl,
      `${baseHostUrl}/clone`,
    ].filter((v, i, a) => v && a.indexOf(v) === i);

    const https = await import('https');
    const http = await import('http');

    const payload = JSON.stringify({
      text,
      language,
      speaker_wav_b64: speakerWavB64,
    });

    let lastErr: Error | null = null;
    for (const urlStr of candidateUrls) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          log.info({ urlStr, attempt, language, textLen: text.length }, 'Attempting Colab VoxCPM Voice Clone request');
          const parsedUrl = new URL(urlStr);
          const transport = parsedUrl.protocol === 'https:' ? https : http;

          await new Promise<void>((resolve, reject) => {
            const req = transport.request(parsedUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Bypass-Tunnel-Remainder': 'true',
                'ngrok-skip-browser-warning': 'true',
              },
              timeout: 180_000,
            }, (res) => {
              if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                const fileStream = fs.createWriteStream(outputPath);
                // Body timeout: abort if no data received for 120 seconds
                let bodyTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
                  res.destroy(new Error('Colab response body timed out after 120s'));
                }, 120_000);
                res.on('data', () => {
                  if (bodyTimer) { clearTimeout(bodyTimer); }
                  bodyTimer = setTimeout(() => {
                    res.destroy(new Error('Colab response body stalled for 120s'));
                  }, 120_000);
                });
                res.pipe(fileStream);
                fileStream.on('finish', () => {
                  if (bodyTimer) clearTimeout(bodyTimer);
                  fileStream.close();
                  resolve();
                });
                fileStream.on('error', (err) => {
                  if (bodyTimer) clearTimeout(bodyTimer);
                  try { fs.unlinkSync(outputPath); } catch {}
                  reject(err);
                });
              } else {
                let errText = '';
                res.on('data', (c) => errText += c.toString());
                res.on('end', () => reject(new Error(`Colab VoxCPM HTTP ${res.statusCode}: ${errText}`)));
              }
            });

            req.on('error', reject);
            req.write(payload);
            req.end();
          });

          // Validate output is actual audio (check WAV/RIFF or MP3 magic bytes), not an HTML error page
          if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 100) {
            const header = fs.readFileSync(outputPath).subarray(0, 12);
            const isWav = header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WAVE';
            const isMp3 = header[0] === 0xFF && (header[1] & 0xE0) === 0xE0;
            const isOgg = header.toString('ascii', 0, 4) === 'OggS';
            const isFlac = header.toString('ascii', 0, 4) === 'fLaC';
            if (!isWav && !isMp3 && !isOgg && !isFlac) {
              const preview = fs.readFileSync(outputPath, 'utf-8').slice(0, 200);
              fs.unlinkSync(outputPath);
              throw new Error(`Colab returned non-audio response: ${preview}`);
            }
            log.info({ outputPath, size: fs.statSync(outputPath).size }, 'Successfully generated voice clone audio track from Colab');
            return;
          }
        } catch (err: any) {
          lastErr = err;
          log.warn({ urlStr, attempt, err: err?.message }, 'Colab endpoint attempt failed, retrying...');
          if (attempt < 2) {
            await new Promise((r) => setTimeout(r, 2000));
          }
        }
      }
    }

    throw lastErr || new Error('Failed to connect to Google Colab Voice Clone server');
  }

  private _findPython(): string {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execSync } = require('child_process') as typeof import('child_process');
    for (const py of ['python', 'python3']) {
      try { execSync(`${py} --version`, { stdio: 'pipe' }); return py; } catch { /* try next */ }
    }
    return 'python';
  }
}
