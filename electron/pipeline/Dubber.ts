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

// Available edge-tts voices for Indonesian and other languages
export const TTS_VOICES: Record<string, { name: string; voices: Array<{ id: string; label: string }> }> = {
  id: {
    name: 'Indonesian',
    voices: [
      { id: 'id-ID-ArdiNeural',    label: 'Ardi (Male)'   },
      { id: 'id-ID-GadisNeural',   label: 'Gadis (Female)' },
    ],
  },
  en: {
    name: 'English',
    voices: [
      { id: 'en-US-GuyNeural',     label: 'Guy (Male)'    },
      { id: 'en-US-JennyNeural',   label: 'Jenny (Female)' },
    ],
  },
  ms: {
    name: 'Malay',
    voices: [
      { id: 'ms-MY-OsmanNeural',   label: 'Osman (Male)'  },
      { id: 'ms-MY-YasminNeural',  label: 'Yasmin (Female)' },
    ],
  },
  ja: {
    name: 'Japanese',
    voices: [
      { id: 'ja-JP-KeitaNeural',   label: 'Keita (Male)'  },
      { id: 'ja-JP-NanamiNeural',  label: 'Nanami (Female)' },
    ],
  },
  zh: {
    name: 'Chinese',
    voices: [
      { id: 'zh-CN-YunxiNeural',   label: 'Yunxi (Male)'  },
      { id: 'zh-CN-XiaoxiaoNeural', label: 'Xiaoxiao (Female)' },
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
}

export class Dubber {
  async dub(opts: DubOptions): Promise<void> {
    const { sourceFile, outputPath, words, startMs, endMs, voice, duckDb, googleTtsApiKey } = opts;

    log.info({ voice, wordCount: words.length, startMs, endMs, hasGoogleKey: !!googleTtsApiKey }, 'Starting dubbing');

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

    if (googleTtsApiKey && googleTtsApiKey.trim()) {
      args.push('--google-tts-key', googleTtsApiKey.trim());
    }

    try {
      await this._runProcess(python, args);
      log.info({ outputPath }, 'Dubbing complete');
    } finally {
      try { fs.unlinkSync(transcriptJson); } catch { /* ignore */ }
    }
  }

  private _runProcess(command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      proc.stderr?.on('data', (c: Buffer) => {
        const line = c.toString();
        stderr += line;
        log.debug({ line: line.trim() }, 'dub.py');
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

  private _findPython(): string {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execSync } = require('child_process') as typeof import('child_process');
    for (const py of ['python', 'python3']) {
      try { execSync(`${py} --version`, { stdio: 'pipe' }); return py; } catch { /* try next */ }
    }
    return 'python';
  }
}
