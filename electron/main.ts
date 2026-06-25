import { app, BrowserWindow, shell, protocol, net } from 'electron';
import path from 'path';
import { pathToFileURL } from 'url';
import { execSync } from 'child_process';
import { randomUUID } from 'crypto';
import { registerIpcHandlers } from './ipc/handlers';
import type { IpcServices } from './ipc/handlers';
import { google } from 'googleapis';
import * as keytar from 'keytar';
import { ConfigManager } from './config/ConfigManager';
import { initDatabase } from './db/database';
import { ProjectRepo } from './db/repositories/ProjectRepo';
import { TranscriptRepo } from './db/repositories/TranscriptRepo';
import { HookRepo } from './db/repositories/HookRepo';
import { ClipRepo } from './db/repositories/ClipRepo';
import { Downloader } from './pipeline/Downloader';
import { Transcriber } from './pipeline/Transcriber';
import { Analyzer } from './pipeline/Analyzer';
import { Processor } from './pipeline/Processor';
import { Uploader } from './pipeline/Uploader';
import { PipelineManager } from './pipeline/PipelineManager';
import { SceneDetector } from './pipeline/SceneDetector';
import { SpeakerDetector } from './pipeline/SpeakerDetector';
import { Translator } from './pipeline/Translator';
import { Dubber } from './pipeline/Dubber';
import type { SubtitleStyle, SubtitlePosition } from '../shared/types';
import { createLogger } from './utils/logger';

const log = createLogger('Main');

const isDev = process.env.NODE_ENV === 'development';

let mainWindow: BrowserWindow | null = null;
const configManager = new ConfigManager();

// ---------------------------------------------------------------------------
// Database + repositories (initialised once app is ready)
// ---------------------------------------------------------------------------
let projectRepo: ProjectRepo;
let transcriptRepo: TranscriptRepo;
let hookRepo: HookRepo;
let clipRepo: ClipRepo;

// ---------------------------------------------------------------------------
// Pipeline services (singletons)
// ---------------------------------------------------------------------------
const downloader       = new Downloader();
const transcriber      = new Transcriber();
const analyzer         = new Analyzer();
const processor        = new Processor();
const uploader         = new Uploader();
const sceneDetector    = new SceneDetector();
const speakerDetector  = new SpeakerDetector();
const translator       = new Translator();
const dubber           = new Dubber();

// PipelineManager wired after repos are ready (see app.whenReady)
let pipelineManager: PipelineManager;

// ---------------------------------------------------------------------------
// YouTube OAuth helpers
// ---------------------------------------------------------------------------

const KEYTAR_SERVICE = 'ai-shorts-generator';
const KEYTAR_ACCOUNT = 'youtube-tokens';
const OAUTH_PORT     = 42813;
const OAUTH_REDIRECT = `http://localhost:${OAUTH_PORT}/oauth2callback`;

// Keep a reference to any active OAuth callback server so we can close it
// before starting a new one (prevents EADDRINUSE on repeated Connect clicks).
let activeOAuthServer: import('http').Server | null = null;

interface StoredTokens {
  access_token: string;
  refresh_token: string;
  expiry_date: number;
  email?: string;
}

function buildOAuthClient(clientId: string, clientSecret: string) {
  return new google.auth.OAuth2(clientId, clientSecret, OAUTH_REDIRECT);
}

async function loadTokens(): Promise<StoredTokens | null> {
  try {
    const raw = await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT);
    return raw ? (JSON.parse(raw) as StoredTokens) : null;
  } catch {
    return null;
  }
}

async function saveTokens(tokens: StoredTokens): Promise<void> {
  await keytar.setPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT, JSON.stringify(tokens));
}

async function deleteTokens(): Promise<void> {
  await keytar.deletePassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT);
}

/**
 * Start a local HTTP server on OAUTH_PORT to receive the OAuth callback,
 * open the Google consent page in a new incognito Chrome window so the user
 * can pick any Google account, and resolve with the authorization code.
 *
 * Any previously active OAuth server is closed before starting a new one
 * to prevent EADDRINUSE when the user clicks Connect multiple times.
 */
function waitForOAuthCode(authUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const http = require('http') as typeof import('http');

    // Close any leftover server from a previous attempt
    if (activeOAuthServer) {
      try { activeOAuthServer.close(); } catch { /* ignore */ }
      activeOAuthServer = null;
    }

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${OAUTH_PORT}`);
      const code  = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (code) {
        res.end('<html><body style="font-family:sans-serif;padding:2rem"><h2>✅ Authentication successful!</h2><p>You can close this tab and return to the app.</p></body></html>');
        activeOAuthServer = null;
        server.close();
        resolve(code);
      } else {
        res.end('<html><body style="font-family:sans-serif;padding:2rem"><h2>❌ Authentication failed.</h2><p>Please try again.</p></body></html>');
        activeOAuthServer = null;
        server.close();
        reject(new Error(error ?? 'OAuth cancelled'));
      }
    });

    activeOAuthServer = server;

    server.listen(OAUTH_PORT, '127.0.0.1', () => {
      // Open in the default browser (normal mode, not incognito) with
      // authuser=-1 which forces Google to show the account picker even
      // when the browser already has an active Google session.
      void shell.openExternal(authUrl);
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      activeOAuthServer = null;
      reject(new Error(`OAuth callback server error: ${err.message}`));
    });

    // Timeout after 5 minutes
    const timer = setTimeout(() => {
      activeOAuthServer = null;
      server.close();
      reject(new Error('OAuth timeout — user did not complete authentication in time.'));
    }, 5 * 60 * 1000);

    // Clear timeout if server closes cleanly before it fires
    server.on('close', () => clearTimeout(timer));
  });
}

/**
 * Stub service implementations used until the real pipeline classes are wired
 * in subsequent tasks. Each method returns a sensible empty/default value so
 * the app can start without crashing.
 */
const stubServices: IpcServices = {
  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------
  listProjects: async () => projectRepo.listForDashboard(),

  getProject: async (id) => projectRepo.findById(id),

  deleteProject: async (id) => { projectRepo.delete(id); },

  // -------------------------------------------------------------------------
  // Download
  // -------------------------------------------------------------------------
  startDownload: async (req) => {
    const projectId = randomUUID();
    const outputDir = configManager.get('downloadDir') || app.getPath('downloads');

    // Start download in background — progress events are emitted via IPC
    void downloader.download({ ...req, projectId, outputDir }).then(async ({ filePath, title, duration }) => {
      const now = Date.now();
      projectRepo.insert({
        sourceUrl:   req.url,
        title,
        filePath,
        durationMs:  duration * 1000,
        thumbnail:   null,
        language:    'auto',
        quality:     req.quality,
        createdAt:   now,
        updatedAt:   now,
      });

      // Auto-generate thumbnail at 10% into the video
      try {
        const thumbDir  = path.join(app.getPath('userData'), 'thumbnails');
        const thumbPath = path.join(thumbDir, `${projectId}.jpg`);
        const thumbMs   = Math.round(duration * 1000 * 0.1);
        await processor.generateThumbnail(filePath, thumbMs, thumbPath);
        projectRepo.update(projectId, { thumbnail: thumbPath, updatedAt: Date.now() });
      } catch (thumbErr) {
        log.warn({ projectId, err: thumbErr }, 'Auto-thumbnail failed, continuing');
      }

      // Emit 100% so renderer navigates to project view
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('download:progress', {
            projectId,
            percent: 100,
            speed: '',
            eta: '',
          });
        }
      }
    }).catch((err: Error) => {
      // Emit error back to renderer via a final progress event with -1 percent
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('download:progress', {
            projectId,
            percent: -1,
            speed: '',
            eta: err.message,
          });
        }
      }
    });

    return { projectId };
  },

  cancelDownload: async (projectId) => { downloader.cancel(projectId); },

  // -------------------------------------------------------------------------
  // Transcription
  // -------------------------------------------------------------------------
  startTranscribe: async (projectId, onProgress) => {
    const project = projectRepo.findById(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);

    const modelSize = configManager.get('whisperModelSize');
    // Use project language if set, otherwise 'auto' for detection.
    // Note: for Google STT, 'auto' sends multiple candidate languages for detection.
    const language = (!project.language || project.language === 'auto') ? 'auto' : project.language;
    const deepgramApiKey = configManager.get('deepgramApiKey') || '';
    const googleSttServiceAccountPath = configManager.get('googleSttServiceAccountPath') || '';

    const transcript = await transcriber.transcribe(
      projectId,
      project.filePath,
      language,
      modelSize,
      path.join(app.getPath('userData'), 'models'),
      onProgress,
      deepgramApiKey || undefined,
      googleSttServiceAccountPath || undefined,
    );

    // Persist to DB (upsert: delete existing then insert)
    const existing = transcriptRepo.findByProjectId(projectId);
    if (existing) {
      transcriptRepo.update(existing.id, {
        wordsJson: JSON.stringify(transcript.words),
        isEmpty:   transcript.words.length === 0,
      });
    } else {
      transcriptRepo.insert({
        projectId,
        language:  transcript.language,
        wordsJson: JSON.stringify(transcript.words),
        isEmpty:   transcript.words.length === 0,
      });
    }
    // Update project with detected language
    projectRepo.update(projectId, { language: transcript.language, updatedAt: Date.now() });
  },

  cancelTranscribe: async () => { /* whisper-cli does not support mid-run cancel */ },

  getTranscript: async (projectId) => {
    const row = transcriptRepo.findByProjectId(projectId);
    if (!row) return null;
    return {
      projectId,
      language: row.language,
      words: JSON.parse(row.wordsJson) as [],
    };
  },

  // -------------------------------------------------------------------------
  // Analysis
  // -------------------------------------------------------------------------
  startAnalyze: async (projectId, momentTheme) => {
    const transcriptRow = transcriptRepo.findByProjectId(projectId);
    if (!transcriptRow) throw new Error('Transcribe the video before running analysis.');

    const words = JSON.parse(transcriptRow.wordsJson) as unknown[];

    if (words.length === 0) {
      throw new Error('Transcript is empty — no words were detected. Re-run transcription.');
    }

    const transcript = {
      projectId,
      language: transcriptRow.language,
      words: words as [],
    };

    const ollamaModel = configManager.get('ollamaModel') || 'llama3';
    const geminiApiKey = configManager.get('geminiApiKey') || '';
    const serviceAccountPath = configManager.get('googleSttServiceAccountPath') || '';

    // Log transcript snippet for debugging
    const transcriptText = words.slice(0, 5).map((w: unknown) => (w as { word: string }).word).join(' ');
    log.info({ projectId, wordCount: words.length, transcriptSnippet: transcriptText, ollamaModel }, 'Starting analysis');

    const project = projectRepo.findById(projectId);
    const durationMs = project?.durationMs;

    let hooks;
    try {
      hooks = await analyzer.detectHooks(projectId, transcript, ollamaModel, durationMs, geminiApiKey || undefined, serviceAccountPath || undefined, momentTheme || undefined);
    } catch (err) {
      const appErr = err as { code?: string; message?: string; details?: string };
      log.error({ projectId, err: appErr }, 'Analysis failed');
      if (appErr.code) {
        throw new Error(`${appErr.code}: ${appErr.message ?? 'Analysis failed'}${appErr.details ? ` — ${appErr.details}` : ''}`);
      }
      throw err;
    }

    log.info({ projectId, hookCount: hooks.length }, 'Analysis complete');

    if (hooks.length === 0) {
      return [];
    }

    // Persist hooks — delete existing first to avoid duplicates
    hookRepo.deleteByProjectId(projectId);

    hookRepo.insertMany(hooks.map((h) => ({
      id:         h.id,
      projectId:  h.projectId,
      startMs:    h.startMs,
      endMs:      h.endMs,
      viralScore: h.viralScore,
      summary:    h.summary,
    })));

    return hooks;
  },

  cancelAnalyze: async () => { /* Ollama HTTP — no cancel mechanism */ },

  generateMetadata: async (summary) => {
    const serviceAccountPath = configManager.get('googleSttServiceAccountPath') || '';
    if (!serviceAccountPath || !require('fs').existsSync(serviceAccountPath)) return null;

    // Limit transcript to ~500 words to keep prompt manageable
    const clipTranscript = summary.split(/\s+/).slice(0, 500).join(' ');

    try {
      const prompt = `You are a YouTube Shorts optimization expert. Based on this video clip transcript, generate an engaging title, description, and tags optimized for YouTube Shorts virality.

Clip transcript: "${clipTranscript}"

Rules:
- Title: catchy, max 60 chars, use emoji if appropriate, in the same language as the transcript
- Description: 2-3 sentences summarizing the video content, include relevant keywords, add 3-5 relevant hashtags at the end, same language as transcript
- Tags: 8-12 relevant tags for YouTube search optimization, mix of broad and specific, same language as transcript

Return ONLY a JSON object with this exact format:
{"title":"...","description":"...","tags":["tag1","tag2","tag3"]}`;

      // Vertex AI only — uses Google Cloud credits
      const fsMod = require('fs') as typeof import('fs');
      const keyData = JSON.parse(fsMod.readFileSync(serviceAccountPath, 'utf-8')) as {
        client_email: string; private_key: string; project_id: string; token_uri?: string;
      };
      const tokenUri = keyData.token_uri || 'https://oauth2.googleapis.com/token';
      const now = Math.floor(Date.now() / 1000);
      const jwtHeader = { alg: 'RS256', typ: 'JWT' };
      const jwtClaim = { iss: keyData.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: tokenUri, iat: now, exp: now + 3600 };
      const encB64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
      const signInput = `${encB64(jwtHeader)}.${encB64(jwtClaim)}`;
      const { createSign } = await import('crypto');
      const signer = createSign('RSA-SHA256');
      signer.update(signInput);
      const sig = signer.sign(keyData.private_key, 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
      const jwtToken = `${signInput}.${sig}`;

      const tokenRes = await fetch(tokenUri, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwtToken}`,
      });
      const tokenData = await tokenRes.json() as { access_token: string };

      const url = `https://us-central1-aiplatform.googleapis.com/v1/projects/${keyData.project_id}/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenData.access_token}` },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 4096, responseMimeType: 'application/json' },
        }),
      });
      if (!response.ok) throw new Error(`Vertex AI error ${response.status}`);
      const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      const parsed = JSON.parse(responseText) as { title: string; description: string; tags: string[] };
      return parsed;
    } catch (err) {
      log.warn({ err }, 'AI metadata generation failed');
      return null;
    }
  },

  // -------------------------------------------------------------------------
  // Hooks
  // -------------------------------------------------------------------------
  listHooks: async (projectId) => hookRepo.findByProjectId(projectId),

  updateHook: async (hook) => {
    hookRepo.update(hook.id, {
      startMs:    hook.startMs,
      endMs:      hook.endMs,
      viralScore: hook.viralScore,
      summary:    hook.summary,
      dismissed:  hook.dismissed,
    });
  },

  dismissHook: async (hookId) => { hookRepo.update(hookId, { dismissed: true }); },

  generateClip: async (hookId, options) => {
    const hook = hookRepo.findById(hookId);
    if (!hook) throw new Error(`Hook ${hookId} not found`);

    const opts = options as Record<string, unknown>;
    const existingClipId = opts['existingClipId'] as string | undefined;
    const subtitleStyle    = (opts['subtitleStyle']    as string | undefined) ?? configManager.get('defaultSubtitleStyle');
    const subtitlePosition = (opts['subtitlePosition'] as string | undefined) ?? configManager.get('defaultSubtitlePosition');
    const zoomEnabled      = (opts['zoomEnabled']      as boolean | undefined) ?? true;
    const captionStyle     = opts['captionStyle'] as import('../shared/types').CaptionStyle | undefined;
    const logoOverlay      = opts['logoOverlay']  as import('../shared/types').LogoOverlay  | undefined;
    const trackingMode     = (opts['trackingMode'] as 'auto' | 'manual' | 'none' | undefined) ?? 'auto';
    const subjectBbox      = opts['subjectBbox']  as { x: number; y: number; w: number; h: number } | undefined;
    const subjectSeedMs    = opts['subjectSeedMs'] as number | undefined;
    const layoutPreset     = (opts['layoutPreset'] as import('../shared/types').LayoutPreset | undefined) ?? 'normal';
    const splitLayout      = (opts['splitLayout']  as import('../shared/types').SplitLayout  | undefined) ?? 'top-bottom';
    const gameRatio        = (opts['gameRatio']    as import('../shared/types').GameRatio    | undefined) ?? '50-50';
    const gamePosition     = (opts['gamePosition'] as import('../shared/types').GamePosition | undefined) ?? 'top';
    const thumbnailPath    = opts['thumbnailPath'] as string | undefined;

    // Reuse existing clip row if provided (prevents orphans on re-generate)
    let clipId: string;
    if (existingClipId) {
      clipId = existingClipId;
      clipRepo.updateStatus(clipId, 'pending');
    } else {
      const clip = clipRepo.insert({
        id: randomUUID(),
        hookId,
        projectId:        hook.projectId,
        status:           'pending',
        subtitleStyle:    subtitleStyle as SubtitleStyle,
        subtitlePosition: subtitlePosition as SubtitlePosition,
        zoomEnabled,
      });
      clipId = clip.id;
    }

    // Run processor in background
    void (async () => {
      try {
        const project = projectRepo.findById(hook.projectId);
        if (!project) throw new Error('Project not found');

        const transcriptRow = transcriptRepo.findByProjectId(hook.projectId);
        const words = opts['overrideWords']
          ? opts['overrideWords'] as import('../shared/types').TranscriptWord[]
          : transcriptRow ? JSON.parse(transcriptRow.wordsJson) as [] : [];

        const exportDir = configManager.get('exportDir') || app.getPath('downloads');
        const outputPath = path.join(exportDir, `clip-${clipId}.mp4`);

        clipRepo.updateStatus(clipId, 'processing');

        await processor.process({
          clipId,
          projectId:        hook.projectId,
          sourceFile:       project.filePath,
          startMs:          hook.startMs,
          endMs:            hook.endMs,
          outputPath,
          subtitleStyle:    subtitleStyle as SubtitleStyle,
          subtitlePosition: subtitlePosition as SubtitlePosition,
          zoomEnabled,
          words,
          captionStyle,
          logoOverlay,
          trackingMode,
          subjectBbox,
          subjectSeedMs,
          layoutPreset,
          splitLayout,
          gameRatio,
          gamePosition,
          thumbnailPath,
        });

        clipRepo.updateOutputPath(clipId, outputPath);
        clipRepo.updateStatus(clipId, 'complete');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        clipRepo.updateStatus(clipId, 'failed', msg);
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('clip:progress', { clipId, percent: -1, eta: msg });
          }
        }
      }
    })();

    return { clipId };
  },

  cancelClip: async (clipId) => {
    processor.cancel(clipId);
  },

  listClips: async (projectId) => clipRepo.findByProjectId(projectId),

  getClip: async (clipId) => clipRepo.findById(clipId),

  deleteClip: async (clipId) => { clipRepo.delete(clipId); },
  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------
  startExport: async (clipId, outputPath) => {
    const clip = clipRepo.findById(clipId);
    if (!clip) throw new Error(`Clip ${clipId} not found`);
    if (!clip.outputPath) throw new Error('Clip has no output file to export');

    // Copy the clip file to the chosen output path
    const fs2 = await import('fs');
    fs2.copyFileSync(clip.outputPath, outputPath);
    clipRepo.updateOutputPath(clipId, outputPath);
  },

  cancelExport: async () => { /* stub */ },

  // -------------------------------------------------------------------------
  // Pipeline (orchestrated)
  // -------------------------------------------------------------------------
  runPipeline: async (projectId, opts) => {
    // Build PipelineManager lazily (repos available by now)
    if (!pipelineManager) {
      pipelineManager = new PipelineManager({
        startTranscribe: (id, onProgress) => stubServices.startTranscribe(id, onProgress),
        startAnalyze:    (id) => stubServices.startAnalyze(id) as Promise<unknown[]>,
        generateClip:    (hookId, options) => stubServices.generateClip(hookId, options),
      });
    }

    // Run in background — caller gets immediate resolve, progress via IPC
    void pipelineManager.run(projectId, {
      autoTranscribe: opts?.['autoTranscribe'] ?? true,
      autoAnalyze:    opts?.['autoAnalyze']    ?? true,
      autoProcess:    opts?.['autoProcess']    ?? true,
    }).catch((err: Error) => {
      log.error({ projectId, err: err.message }, 'Pipeline run failed');
    });
  },

  cancelPipeline: async (projectId) => {
    pipelineManager?.cancel(projectId);
  },

  getPipelineStatus: async (projectId) => {
    return { running: pipelineManager?.isRunning(projectId) ?? false };
  },

  generateThumbnail: async (projectId, timestampMs) => {
    const project = projectRepo.findById(projectId);
    if (!project) return null;

    const thumbDir  = path.join(app.getPath('userData'), 'thumbnails');
    const thumbPath = path.join(thumbDir, `${projectId}.jpg`);

    try {
      await processor.generateThumbnail(project.filePath, timestampMs, thumbPath);
      // Persist thumbnail path to project row
      projectRepo.update(projectId, { thumbnail: thumbPath, updatedAt: Date.now() });
      return thumbPath;
    } catch (err) {
      log.warn({ projectId, err }, 'Thumbnail generation failed');
      return null;
    }
  },

  openFilePicker: async () => null, // handled directly in IPC handler via dialog

  detectScenes: async (projectId, threshold = 0.3) => {
    const project = projectRepo.findById(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);
    return sceneDetector.detect(project.filePath, threshold);
  },

  detectSpeakers: async (projectId, hfToken) => {
    const project = projectRepo.findById(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);
    const settings = configManager.getAll();
    const token = hfToken ?? (settings as unknown as Record<string, string>)['huggingfaceToken'];
    return speakerDetector.detect(project.filePath, token);
  },

  extractFrame: async (projectId, timestampMs) => {
    const project = projectRepo.findById(projectId);
    if (!project) return null;
    return processor.extractFrame(project.filePath, timestampMs);
  },

  detectBoxesAtFrame: async (projectId, timestampMs) => {
    const project = projectRepo.findById(projectId);
    if (!project) return [];
    return processor.detectBoxesAtFrame(project.filePath, timestampMs);
  },

  translateTranscript: async (projectId, targetLanguage) => {
    const row = transcriptRepo.findByProjectId(projectId);
    if (!row) throw new Error('No transcript found. Transcribe first.');

    const words = JSON.parse(row.wordsJson) as import('../shared/types').TranscriptWord[];
    if (!words.length) throw new Error('Transcript is empty.');

    const ollamaModel = configManager.get('ollamaModel') || 'llama3';
    const deeplApiKey = configManager.get('deeplApiKey') || '';
    log.info({ projectId, targetLanguage, wordCount: words.length }, 'Starting translation');

    const translated = await translator.translate(words, targetLanguage, ollamaModel, deeplApiKey);

    transcriptRepo.update(row.id, {
      wordsJson: JSON.stringify(translated),
      language:  targetLanguage,
    });
    projectRepo.update(projectId, { language: targetLanguage, updatedAt: Date.now() });

    log.info({ projectId, targetLanguage }, 'Translation saved');
  },

  dubClip: async (clipId, voice, duckDb) => {
    const clip = clipRepo.findById(clipId);
    if (!clip) throw new Error(`Clip ${clipId} not found`);
    if (!clip.outputPath) throw new Error('Clip has no output file to dub');

    const hook = hookRepo.findById(clip.hookId);
    if (!hook) throw new Error('Hook not found');

    const transcriptRow = transcriptRepo.findByProjectId(clip.projectId);
    if (!transcriptRow) throw new Error('No transcript found. Transcribe first.');

    let words = JSON.parse(transcriptRow.wordsJson) as import('../shared/types').TranscriptWord[];
    const project = projectRepo.findById(clip.projectId);
    if (!project) throw new Error('Project not found');

    // Detect target language from voice ID (e.g. 'id-ID-ArdiNeural' → 'id')
    const voiceLangCode = voice.split('-')[0].toLowerCase(); // 'id', 'en', 'ms', 'ja', 'zh'
    const transcriptLang = (transcriptRow.language || 'en').toLowerCase().split('-')[0];

    // Translate words if voice language differs from transcript language
    if (voiceLangCode && voiceLangCode !== transcriptLang) {
      log.info({ clipId, from: transcriptLang, to: voiceLangCode }, 'Translating transcript for dubbing');
      const ollamaModel = configManager.get('ollamaModel') || 'llama3';
      const deeplApiKey = configManager.get('deeplApiKey') || '';
      try {
        words = await translator.translate(words, voiceLangCode, ollamaModel, deeplApiKey);
        log.info({ clipId, wordCount: words.length }, 'Translation for dubbing complete');
      } catch (err) {
        log.warn({ clipId, err }, 'Translation failed, dubbing with original words');
      }
    }

    const exportDir = configManager.get('exportDir') || app.getPath('downloads');
    const dubbedPath = clip.outputPath.replace(/\.mp4$/i, '_dubbed.mp4');
    const googleTtsApiKey = configManager.get('googleTtsApiKey') || '';

    log.info({ clipId, voice, duckDb, voiceLangCode }, 'Starting dubbing');

    // clip output starts at 0 — offset words to clip-relative time, then pass start=0
    const clipDurationMs = hook.endMs - hook.startMs;
    const clipRelativeWords = words
      .filter((w) => w.startMs >= hook.startMs && w.endMs <= hook.endMs)
      .map((w) => ({ ...w, startMs: w.startMs - hook.startMs, endMs: w.endMs - hook.startMs }));

    await dubber.dub({
      sourceFile:      clip.outputPath,
      outputPath:      dubbedPath,
      words:           clipRelativeWords,
      startMs:         0,
      endMs:           clipDurationMs,
      voice,
      duckDb,
      googleTtsApiKey: googleTtsApiKey || undefined,
    });

    clipRepo.updateOutputPath(clipId, dubbedPath);
    log.info({ clipId, dubbedPath }, 'Dubbing saved');
    void exportDir;
  },

  importLocalFile: async (filePath, quality) => {
    const projectId = randomUUID();
    const now = Date.now();

    // Get video metadata via ffprobe
    let title = path.basename(filePath, path.extname(filePath));
    let duration = 0;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { execSync } = require('child_process') as typeof import('child_process');
      const raw = execSync(
        `ffprobe -v quiet -print_format json -show_format "${filePath}"`,
        { stdio: 'pipe' }
      ).toString();
      const meta = JSON.parse(raw) as { format?: { duration?: string } };
      duration = Math.round(parseFloat(meta.format?.duration ?? '0') * 1000);
      title = title.replace(/[_\-.]+/g, ' ').trim() || title;
    } catch {
      log.warn({ filePath }, 'ffprobe failed for local import, using defaults');
    }

    projectRepo.insert({
      sourceUrl:  `file://${filePath}`,
      title,
      filePath,
      durationMs: duration,
      thumbnail:  null,
      language:   'auto',
      quality:    (quality as '1080p' | '720p' | '480p' | '360p') || '1080p',
      createdAt:  now,
      updatedAt:  now,
    });

    // Auto-generate thumbnail at 10%
    try {
      const thumbDir  = path.join(app.getPath('userData'), 'thumbnails');
      const thumbPath = path.join(thumbDir, `${projectId}.jpg`);
      const thumbMs   = Math.round(duration * 0.1);
      await processor.generateThumbnail(filePath, thumbMs, thumbPath);
      projectRepo.update(projectId, { thumbnail: thumbPath, updatedAt: Date.now() });
    } catch { /* non-fatal */ }

    // Emit 100% progress so renderer navigates to project view
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('download:progress', {
          projectId,
          percent: 100,
          speed: '',
          eta: '',
        });
      }
    }

    return { projectId };
  },
  startAuthFlow: async () => {
    // If already authenticated, this call acts as disconnect — clear tokens
    const existing = await loadTokens();
    if (existing?.access_token) {
      await deleteTokens();
      return;
    }

    // Read client credentials from saved settings
    const clientId     = configManager.get('youtubeClientId');
    const clientSecret = configManager.get('youtubeClientSecret');

    if (!clientId || !clientSecret) {
      throw new Error('YouTube Client ID and Client Secret must be set in Settings before connecting.');
    }

    const oauth2Client = buildOAuthClient(clientId, clientSecret);

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: [
        'https://www.googleapis.com/auth/youtube.upload',
        'https://www.googleapis.com/auth/youtube.readonly',
        'https://www.googleapis.com/auth/userinfo.email',
      ],
      prompt: 'select_account consent',
    });

    // Append authuser=-1 to force Google's account picker regardless of
    // which accounts are already signed in to the browser.
    const urlWithPicker = `${authUrl}&authuser=-1`;

    const code = await waitForOAuthCode(urlWithPicker);
    const { tokens } = await oauth2Client.getToken(code);

    // Fetch user email
    oauth2Client.setCredentials(tokens);
    let email: string | undefined;
    try {
      const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
      const info = await oauth2.userinfo.get();
      email = info.data.email ?? undefined;
    } catch { /* email is optional */ }

    await saveTokens({
      access_token:  tokens.access_token  ?? '',
      refresh_token: tokens.refresh_token ?? '',
      expiry_date:   tokens.expiry_date   ?? 0,
      email,
    });
  },

  getAuthStatus: async () => {
    const tokens = await loadTokens();
    if (!tokens?.access_token) return { authenticated: false };
    return { authenticated: true, email: tokens.email };
  },

  startUpload: async (req) => {
    const clip = clipRepo.findById(req.clipId);
    if (!clip) throw new Error(`Clip ${req.clipId} not found`);
    if (!clip.outputPath) throw new Error('Clip has no output file to upload');

    const tokens = await loadTokens();
    if (!tokens?.access_token) throw new Error('Not authenticated. Connect your YouTube account in Settings first.');

    const clientId     = configManager.get('youtubeClientId');
    const clientSecret = configManager.get('youtubeClientSecret');

    if (!clientId || !clientSecret) {
      throw new Error('YouTube Client ID and Client Secret must be set in Settings before uploading.');
    }

    if (!tokens.refresh_token) {
      // No refresh token — force re-auth
      await deleteTokens();
      throw new Error('Session expired. Please reconnect your YouTube account in Settings.');
    }

    // Always try to refresh the access token before uploading.
    // This handles: expired tokens, revoked tokens, credentials changed, etc.
    let accessToken = tokens.access_token;
    try {
      const oauth2Client = buildOAuthClient(clientId, clientSecret);
      oauth2Client.setCredentials({
        access_token:  tokens.access_token,
        refresh_token: tokens.refresh_token,
      });
      const { credentials } = await oauth2Client.refreshAccessToken();
      accessToken = credentials.access_token ?? tokens.access_token;
      await saveTokens({
        access_token:  accessToken,
        refresh_token: credentials.refresh_token ?? tokens.refresh_token,
        expiry_date:   credentials.expiry_date   ?? tokens.expiry_date,
        email:         tokens.email,
      });
      log.info({ clipId: req.clipId }, 'Access token refreshed before upload');
    } catch (refreshErr) {
      // Refresh failed — credentials likely invalid or revoked
      log.error({ err: refreshErr }, 'Token refresh failed before upload');
      await deleteTokens();
      throw new Error('YouTube credentials are invalid or expired. Please reconnect your account in Settings.');
    }

    const youtubeUrl = await uploader.upload(
      req,
      clip.outputPath,
      accessToken,
      tokens.refresh_token,
      clientId,
      clientSecret,
    );

    clipRepo.updateYouTubeUrl(req.clipId, youtubeUrl);
  },

  cancelUpload: async () => { /* YouTube resumable upload cancel not yet implemented */ },
  getSettings: async () => configManager.getAll(),
  setSettings: async (settings) => {
    for (const [key, value] of Object.entries(settings)) {
      configManager.set(key as keyof typeof settings, value as never);
    }
  },
  checkDeps: async () => {
    const detect = (cmd: string, versionFlag = '--version'): { detected: boolean; version?: string; name: string } => {
      try {
        const whichCmd = process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`;
        execSync(whichCmd, { stdio: 'pipe' });
        try {
          const ver = execSync(`${cmd} ${versionFlag}`, { stdio: 'pipe' }).toString().split('\n')[0].trim();
          return { detected: true, version: ver.slice(0, 40), name: cmd };
        } catch {
          return { detected: true, name: cmd };
        }
      } catch {
        return { detected: false, name: cmd };
      }
    };

    // whisper.cpp / openai-whisper / faster-whisper — accept any variant
    const detectWhisper = (): { detected: boolean; version?: string; name: string } => {
      // 1. Native CLI binaries (whisper.cpp)
      for (const name of ['whisper-cli', 'whisper', 'main']) {
        const result = detect(name, '--version');
        if (result.detected) return { ...result, name: 'whisper-cli' };
      }
      // 2. Python packages: openai-whisper, faster-whisper
      for (const py of ['python', 'python3']) {
        for (const [mod, attr] of [['whisper', '__version__'], ['faster_whisper', '__version__']]) {
          try {
            const ver = execSync(`${py} -c "import ${mod}; print(${mod}.${attr})"`, { stdio: 'pipe' })
              .toString().trim();
            return { detected: true, version: `${mod} ${ver}`, name: 'whisper-cli' };
          } catch { /* try next */ }
        }
      }
      return { detected: false, name: 'whisper-cli' };
    };

    // MediaPipe is a Python package, not a CLI tool
    const detectMediaPipe = (): { detected: boolean; version?: string; name: string } => {
      try {
        const ver = execSync('python -c "import mediapipe; print(mediapipe.__version__)"', { stdio: 'pipe' })
          .toString().trim();
        return { detected: true, version: ver, name: 'mediapipe' };
      } catch {
        try {
          const ver = execSync('python3 -c "import mediapipe; print(mediapipe.__version__)"', { stdio: 'pipe' })
            .toString().trim();
          return { detected: true, version: ver, name: 'mediapipe' };
        } catch {
          return { detected: false, name: 'mediapipe' };
        }
      }
    };

    return {
      ytDlp:      detect('yt-dlp',  '--version'),
      ffmpeg:     detect('ffmpeg',  '-version'),
      whisperCli: detectWhisper(),
      ollama:     await (async () => {
        // First check if the binary exists
        const binary = detect('ollama', '--version');
        if (!binary.detected) return binary;
        // Then check if the service is actually running
        try {
          const http = require('http') as typeof import('http');
          const running = await new Promise<boolean>((resolve) => {
            const req = http.request(
              { hostname: '127.0.0.1', port: 11434, path: '/', method: 'GET', timeout: 3000 },
              (res: import('http').IncomingMessage) => { res.resume(); resolve(res.statusCode === 200); },
            );
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
            req.end();
          });
          if (!running) {
            return { ...binary, version: (binary.version ?? '') + ' (not running)' };
          }
        } catch { /* ignore, treat as running */ }
        return binary;
      })(),
      mediaPipe:  detectMediaPipe(),
    };
  },
};

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 768,
    backgroundColor: '#0A0A0A',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  });

  // Load the Next.js app
  if (isDev) {
    void mainWindow.loadURL('http://localhost:3000');
    mainWindow.webContents.openDevTools();
  } else {
    // Open DevTools in production temporarily for debugging
    mainWindow.webContents.openDevTools();
    void mainWindow.loadURL('app://./index.html');
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // Open external links in the default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// Custom protocol — serves the Next.js static export via app://./
// This ensures all /_next/static/... asset paths resolve correctly when
// running from an asar archive (file:// cannot handle absolute-looking paths).
// ---------------------------------------------------------------------------
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
  {
    scheme: 'localfile',
    privileges: {
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

app.whenReady().then(() => {
  // Initialise SQLite database
  const dbPath = path.join(app.getPath('userData'), 'app.db');
  const db = initDatabase(dbPath);
  projectRepo   = new ProjectRepo(db);
  transcriptRepo = new TranscriptRepo(db);
  hookRepo      = new HookRepo(db);
  clipRepo      = new ClipRepo(db);

  // Initialise PipelineManager now that repos are ready
  pipelineManager = new PipelineManager({
    startTranscribe: (id, onProgress) => stubServices.startTranscribe(id, onProgress),
    startAnalyze:    (id) => stubServices.startAnalyze(id) as Promise<unknown[]>,
    generateClip:    (hookId, options) => stubServices.generateClip(hookId, options),
  });

  // Resolve the renderer/out root.
  // In a packaged app, __dirname is inside app.asar (dist/electron/).
  // Files unpacked via asarUnpack live in app.asar.unpacked at the same
  // relative path, so we replace app.asar with app.asar.unpacked.
  const rawRoot = path.join(__dirname, '..', '..', 'renderer', 'out');
  const rendererRoot = rawRoot.replace('app.asar', 'app.asar.unpacked');

  // Register localfile:// protocol to serve local media files (clips, videos)
  // without CSP restrictions that block file:// URLs in the app:// context.
  protocol.handle('localfile', (request) => {
    const url = new URL(request.url);
    // localfile:///C:/path/to/file.mp4  →  C:\path\to\file.mp4
    const filePath = decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, '$1');
    return net.fetch(pathToFileURL(filePath).toString());
  });

  // Register app:// protocol
  // All /_next/static/... asset paths resolve correctly because the handler
  // maps every request pathname to a file under rendererRoot.
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    // Decode percent-encoded characters (e.g. %5Bid%5D → [id])
    // then normalise [id] → _ to match the renamed chunk directories.
    let filePath = decodeURIComponent(url.pathname)
      .replace(/\[id\]/g, '_');

    // Map "/" and extension-less paths to their index.html
    if (filePath === '/' || filePath.endsWith('/')) {
      filePath += 'index.html';
    } else if (!path.extname(filePath)) {
      filePath += '/index.html';
    }

    // Split on '/' and join with OS separator, filtering empty segments
    const absPath = path.join(rendererRoot, ...filePath.split('/').filter(Boolean));
    return net.fetch(pathToFileURL(absPath).toString());
  });

  // Register all IPC handlers before creating the window
  registerIpcHandlers(stubServices);

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
