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
import { TikTokUploader } from './pipeline/TikTokUploader';
import { FacebookUploader } from './pipeline/FacebookUploader';
import { TelegramUploader } from './pipeline/TelegramUploader';
import { PipelineManager } from './pipeline/PipelineManager';
import { SceneDetector } from './pipeline/SceneDetector';
import { SpeakerDetector } from './pipeline/SpeakerDetector';
import { Translator } from './pipeline/Translator';
import { Dubber } from './pipeline/Dubber';
import { TelegramUserbotUploader } from './pipeline/TelegramUserbotUploader';
import type { SubtitleStyle, SubtitlePosition } from '../shared/types';
import { createLogger } from './utils/logger';
import fs from 'fs';
import os from 'os';
import { searchYouTube, getTrending } from './services/YouTubeDiscovery';
import { analyzeTrend, optimizeGistScript } from './services/TrendAnalyzer';
import { ClipCafeService } from './services/ClipCafeService';

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
const downloader       = new Downloader(configManager);
const transcriber      = new Transcriber();
const analyzer         = new Analyzer();
const processor        = new Processor();
const uploader         = new Uploader();
const tiktokUploader   = new TikTokUploader();
const facebookUploader = new FacebookUploader();
const telegramUploader = new TelegramUploader();
const telegramUserbotUploader = new TelegramUserbotUploader();
const sceneDetector    = new SceneDetector();
const speakerDetector  = new SpeakerDetector();
const translator       = new Translator();
const dubber           = new Dubber();
const clipCafeService  = new ClipCafeService();

let cachedDepsResult: unknown = null;
let lastDepsCheckTime = 0;

// PipelineManager wired after repos are ready (see app.whenReady)
let pipelineManager: PipelineManager;

// ---------------------------------------------------------------------------
// YouTube OAuth helpers
// ---------------------------------------------------------------------------

const KEYTAR_SERVICE = 'shorts-editor';
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

function resolveProjectFilePath(project: import('../shared/types').Project): string {
  if (fs.existsSync(project.filePath)) return project.filePath;
  const basename = path.basename(project.filePath);
  const currentDownloadDir = configManager.get('downloadDir') || app.getPath('downloads');
  const candidate = path.join(currentDownloadDir, basename);
  if (fs.existsSync(candidate)) {
    projectRepo.update(project.id, { filePath: candidate, updatedAt: Date.now() });
    return candidate;
  }
  return project.filePath;
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

async function ensureAccountsMigrated(): Promise<import('../shared/types').UploadAccount[]> {
  const accounts = configManager.getAccounts();
  const migrated = [...accounts];
  let changed = false;

  try {
    const tokens = await loadTokens();
    if (tokens?.access_token) {
      const email = tokens.email ?? '';
      const exists = migrated.some(a => a.platform === 'youtube' && (a.youtubeTokens?.email === email || (!email && a.youtubeTokens?.access_token === tokens.access_token)));
      if (!exists) {
        migrated.push({
          id: `yt-main-${Date.now()}`,
          platform: 'youtube',
          name: email ? `YouTube (${email})` : 'YouTube Channel',
          youtubeTokens: { access_token: tokens.access_token, refresh_token: tokens.refresh_token, expiry_date: tokens.expiry_date, email },
          createdAt: Date.now(),
        });
        changed = true;
      }
    }
  } catch {}

  const ttSession = configManager.get('tiktokSessionId');
  if (ttSession) {
    const exists = migrated.some(a => a.platform === 'tiktok' && a.tiktokSessionId === ttSession);
    if (!exists) {
      migrated.push({
        id: `tt-main-${Date.now()}`,
        platform: 'tiktok',
        name: 'TikTok Account',
        tiktokSessionId: ttSession,
        createdAt: Date.now(),
      });
      changed = true;
    }
  }

  const fbPageId = configManager.get('facebookPageId');
  const fbToken = configManager.get('facebookAccessToken');
  if (fbPageId && fbToken) {
    const exists = migrated.some(a => a.platform === 'facebook' && a.facebookPageId === fbPageId);
    if (!exists) {
      migrated.push({
        id: `fb-main-${Date.now()}`,
        platform: 'facebook',
        name: 'Facebook Fanpage',
        facebookPageId: fbPageId,
        facebookAccessToken: fbToken,
        createdAt: Date.now(),
      });
      changed = true;
    }
  }

  const tgBotToken = configManager.get('telegramBotToken');
  const tgChatId = configManager.get('telegramChatId');
  if (tgBotToken && tgChatId) {
    const exists = migrated.some(a => a.platform === 'telegram' && a.telegramBotToken === tgBotToken && a.telegramChatId === tgChatId);
    if (!exists) {
      migrated.push({
        id: `tg-main-${Date.now()}`,
        platform: 'telegram',
        name: 'Telegram Bot',
        telegramBotToken: tgBotToken,
        telegramChatId: tgChatId,
        telegramUseUserbot: configManager.get('telegramUseUserbot'),
        telegramApiId: configManager.get('telegramApiId'),
        telegramApiHash: configManager.get('telegramApiHash'),
        telegramPhone: configManager.get('telegramPhone'),
        telegramSession: configManager.get('telegramSession'),
        createdAt: Date.now(),
      });
      changed = true;
    }
  }

  if (changed) {
    configManager.saveAccounts(migrated);
  }

  return migrated;
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
    const serviceAccountPath = configManager.get('googleSttServiceAccountPath') || '';

    // Log transcript snippet for debugging
    const transcriptText = words.slice(0, 5).map((w: unknown) => (w as { word: string }).word).join(' ');
    log.info({ projectId, wordCount: words.length, transcriptSnippet: transcriptText, ollamaModel }, 'Starting analysis');

    const project = projectRepo.findById(projectId);
    const durationMs = project?.durationMs;

    let hooks;
    try {
      hooks = await analyzer.detectHooks(projectId, transcript, ollamaModel, durationMs, serviceAccountPath || undefined, momentTheme || undefined);
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
  getHook: async (hookId) => hookRepo.findById(hookId),

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
    const letterboxBg      = opts['letterboxBg']   as import('../shared/types').LetterboxBackground | undefined;
    const titleOverlay     = opts['titleOverlay']  as import('../shared/types').TitleOverlay | undefined;
    const thumbnailPath    = opts['thumbnailPath'] as string | undefined;
    const audioMode        = (opts['audioMode'] as 'keep' | 'mute' | 'replace' | undefined)
      ?? configManager.get('defaultAudioMode') ?? 'keep';
    const replacementAudioPath = (opts['replacementAudioPath'] as string | undefined)
      ?? (configManager.get('backgroundMusicPath') || undefined);
    const musicVolume      = (opts['musicVolume'] as number | undefined)
      ?? configManager.get('musicVolume') ?? 0.8;

    const optionsObj = {
      subtitleStyle,
      subtitlePosition,
      zoomEnabled,
      captionStyle,
      logoOverlay,
      trackingMode,
      subjectBbox,
      subjectSeedMs,
      layoutPreset,
      splitLayout,
      gameRatio,
      gamePosition,
      letterboxBg,
      titleOverlay,
      thumbnailPath,
    };

    // Reuse existing clip row if provided (prevents orphans on re-generate)
    let clipId: string;
    if (existingClipId) {
      clipId = existingClipId;
      clipRepo.updateStatus(clipId, 'pending');
      clipRepo.updateOptions(clipId, JSON.stringify(optionsObj));
    } else {
      const clip = clipRepo.insert({
        id: randomUUID(),
        hookId,
        projectId:        hook.projectId,
        status:           'pending',
        subtitleStyle:    subtitleStyle as SubtitleStyle,
        subtitlePosition: subtitlePosition as SubtitlePosition,
        zoomEnabled,
        optionsJson:      JSON.stringify(optionsObj),
      });
      clipId = clip.id;
    }

    // Run processor in background with a 100ms delay to prevent race conditions with IPC response
    setTimeout(() => {
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
            letterboxBg,
            titleOverlay,
            thumbnailPath,
            audioMode,
            replacementAudioPath,
            musicVolume,
          });

          clipRepo.updateOutputPath(clipId, outputPath);
          clipRepo.updateStatus(clipId, 'complete');
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) {
              win.webContents.send('clip:progress', { clipId, percent: 100, eta: '' });
            }
          }
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
    }, 100);

    return { clipId };
  },

  cancelClip: async (clipId) => {
    processor.cancel(clipId);
  },

  listClips: async (projectId) => clipRepo.findByProjectId(projectId),

  getClip: async (clipId) => clipRepo.findById(clipId),

  insertClip: async (data: any) => clipRepo.insert(data),

  updateClipOutputPath: async (clipId: string, outputPath: string) => {
    clipRepo.updateOutputPath(clipId, outputPath);
    clipRepo.updateStatus(clipId, 'complete');
  },

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

  translateTranscript: async (projectId, targetLanguage, startMs, endMs) => {
    const row = transcriptRepo.findByProjectId(projectId);
    if (!row) throw new Error('No transcript found. Transcribe first.');

    const words = JSON.parse(row.wordsJson) as import('../shared/types').TranscriptWord[];
    if (!words.length) throw new Error('Transcript is empty.');

    const ollamaModel = configManager.get('ollamaModel') || 'llama3';
    const deeplApiKey = configManager.get('deeplApiKey') || '';
    
    if (!row.originalWordsJson) {
      transcriptRepo.update(row.id, {
        originalWordsJson: row.wordsJson,
        originalLanguage: row.language || 'en',
      });
    }

    log.info({ projectId, targetLanguage, wordCount: words.length }, 'Starting translation');

    let translated: import('../shared/types').TranscriptWord[];
    if (startMs !== undefined && endMs !== undefined) {
      const rangeWords = words.filter(w => w.startMs >= startMs && w.endMs <= endMs);
      const otherWords = words.filter(w => w.startMs < startMs || w.endMs > endMs);
      const translatedRange = await translator.translate(rangeWords, targetLanguage, ollamaModel, deeplApiKey);
      translated = [...otherWords, ...translatedRange].sort((a, b) => a.startMs - b.startMs);
    } else {
      translated = await translator.translate(words, targetLanguage, ollamaModel, deeplApiKey);
    }

    transcriptRepo.update(row.id, {
      wordsJson: JSON.stringify(translated),
      language:  targetLanguage,
    });
    projectRepo.update(projectId, { language: targetLanguage, updatedAt: Date.now() });

    log.info({ projectId, targetLanguage }, 'Translation saved');
  },

  resetTranscript: async (projectId: string): Promise<void> => {
    const row = transcriptRepo.findByProjectId(projectId);
    if (!row) throw new Error('No transcript found.');
    if (!row.originalWordsJson) return;
    
    transcriptRepo.update(row.id, {
      wordsJson: row.originalWordsJson,
      language: row.originalLanguage || 'en',
      originalWordsJson: null,
      originalLanguage: null,
    });
    projectRepo.update(projectId, { language: row.originalLanguage || 'en', updatedAt: Date.now() });
  },

  dubClip: async (clipId, voice, duckDb, customScript) => {
    const clip = clipRepo.findById(clipId);
    if (!clip) throw new Error(`Clip ${clipId} not found`);
    if (!clip.outputPath) throw new Error('Clip has no output file to dub');

    const hook = hookRepo.findById(clip.hookId);
    if (!hook) throw new Error('Hook not found');

    const transcriptRow = transcriptRepo.findByProjectId(clip.projectId);
    if (!transcriptRow) throw new Error('No transcript found. Transcribe first.');

    const project = projectRepo.findById(clip.projectId);
    if (!project) throw new Error('Project not found');

    // Set database status to processing so progress bar appears in UI
    clipRepo.updateStatus(clipId, 'processing');
    const sendProgress = (percent: number, eta: string) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('clip:progress', { clipId, percent, eta });
        }
      }
    };
    sendProgress(5, 'Starting dubbing...');

    try {
      let words = JSON.parse(transcriptRow.wordsJson) as import('../shared/types').TranscriptWord[];

      const voiceLangCode = voice.split('-')[0].toLowerCase();
      const transcriptLang = (transcriptRow.language || 'en').toLowerCase().split('-')[0];

      if (!customScript && voiceLangCode && voiceLangCode !== transcriptLang) {
        log.info({ clipId, from: transcriptLang, to: voiceLangCode }, 'Translating transcript for dubbing');
        sendProgress(10, 'Translating transcript...');
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
      const googleSttServiceAccountPath = configManager.get('googleSttServiceAccountPath') || '';
      const deepgramApiKey = configManager.get('deepgramApiKey') || '';

      const isGeminiVoice = voice.startsWith('gemini-');

      if (isGeminiVoice) {
        const clipOpts = clip.optionsJson ? JSON.parse(clip.optionsJson) : {};
        const finalScript = customScript || clipOpts.customScript || hook.summary;
        const clipDurationMs = hook.endMs - hook.startMs;

        let ttsWords: import('../shared/types').TranscriptWord[];
        if (finalScript) {
          const sentences = finalScript
            .split(/(?<=[.!?])\s+/)
            .map((s: string) => s.trim())
            .filter(Boolean);

          ttsWords = sentences.map((sentence: string, idx: number) => {
            const startMs = Math.round((idx / sentences.length) * clipDurationMs);
            const estDurationMs = Math.max(1500, sentence.length * 90); // 90ms per character, min 1.5s
            let endMs = startMs + estDurationMs;
            const nextStartMs = idx < sentences.length - 1 
              ? Math.round(((idx + 1) / sentences.length) * clipDurationMs)
              : clipDurationMs;
            if (endMs > nextStartMs - 500) {
              endMs = nextStartMs - 500;
            }
            if (endMs <= startMs) {
              endMs = startMs + 1000;
            }
            return {
              word: sentence,
              startMs,
              endMs,
              confidence: 1.0,
            };
          });
        } else {
          ttsWords = words
            .filter((w) => w.startMs >= hook.startMs && w.endMs <= hook.endMs)
            .map((w) => ({ ...w, startMs: w.startMs - hook.startMs, endMs: w.endMs - hook.startMs }));
        }

        log.info({ clipId, voice }, 'Generating raw Gemini TTS track');
        sendProgress(20, 'Generating Gemini voice...');
        const { ttsTrackPath } = await dubber.generateTts({
          words: ttsWords,
          startMs: 0,
          endMs: clipDurationMs,
          voice,
          googleTtsApiKey: googleTtsApiKey || undefined,
          googleServiceAccountPath: googleSttServiceAccountPath || undefined,
          sourceFile: project.filePath
        });

        const getAudioDurationMs = (filePath: string): number => {
          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { execSync } = require('child_process') as typeof import('child_process');
            const raw = execSync(
              `ffprobe -v quiet -print_format json -show_format "${filePath}"`,
              { stdio: 'pipe' }
            ).toString();
            const meta = JSON.parse(raw) as { format?: { duration?: string } };
            return Math.round(parseFloat(meta.format?.duration ?? '0') * 1000);
          } catch {
            return clipDurationMs;
          }
        };

        const actualDurationMs = getAudioDurationMs(ttsTrackPath);
        const finalDurationMs = Math.max(clipDurationMs, actualDurationMs);
        log.info({ clipId, ttsTrackPath, actualDurationMs, finalDurationMs }, 'Transcribing Gemini TTS track for caption alignment');
        sendProgress(40, 'Aligning voice script...');

        const modelSize = configManager.get('whisperModelSize') || 'base';
        let newWords: import('../shared/types').TranscriptWord[];
        try {
          const transcript = await transcriber.transcribe(
            clip.projectId,
            ttsTrackPath,
            transcriptRow.language || 'en',
            modelSize,
            path.join(app.getPath('userData'), 'models'),
            undefined,
            deepgramApiKey || undefined,
            googleSttServiceAccountPath || undefined,
          );
          newWords = transcript.words;
        } catch (transcribeErr) {
          log.warn({ clipId, transcribeErr }, 'Failed to transcribe TTS track for alignment, falling back to original script timestamps');
          newWords = ttsWords;
        }

        const tempMixedVideo = path.join(os.tmpdir(), `mixed-video-${Date.now()}.mp4`);
        log.info({ clipId, tempMixedVideo }, 'Mixing raw TTS with background audio via dub.py');
        sendProgress(60, 'Mixing dubbed audio...');
        await dubber.dub({
          sourceFile:      project.filePath,
          outputPath:      tempMixedVideo,
          words:           ttsWords,
          startMs:         hook.startMs,
          endMs:           hook.startMs + finalDurationMs,
          voice,
          duckDb,
          googleTtsApiKey: googleTtsApiKey || undefined,
          googleServiceAccountPath: googleSttServiceAccountPath || undefined,
          ttsTrack:        ttsTrackPath,
        });

        const tempMixedAudioWav = path.join(os.tmpdir(), `mixed-audio-${Date.now()}.wav`);
        log.info({ clipId, tempMixedAudioWav }, 'Extracting mixed audio stream');
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { execSync } = require('child_process') as typeof import('child_process');
          execSync(`ffmpeg -y -i "${tempMixedVideo}" -vn -c:a pcm_s16le "${tempMixedAudioWav}"`, { stdio: 'ignore' });
        } catch (err) {
          log.error({ err }, 'Failed to extract mixed audio stream from temp mixed video');
          throw new Error('Failed to extract mixed audio stream');
        }

        const options = clip.optionsJson ? JSON.parse(clip.optionsJson) : {};
        const subtitleStyle    = (options.subtitleStyle as SubtitleStyle | undefined) ?? configManager.get('defaultSubtitleStyle') ?? 'bold-white';
        const subtitlePosition = (options.subtitlePosition as SubtitlePosition | undefined) ?? configManager.get('defaultSubtitlePosition') ?? 'lower-third';
        const zoomEnabled      = options.zoomEnabled ?? true;
        const captionStyle     = options.captionStyle;
        const logoOverlay      = options.logoOverlay;
        const trackingMode     = options.trackingMode ?? 'auto';
        const subjectBbox      = options.subjectBbox;
        const subjectSeedMs    = options.subjectSeedMs;
        const layoutPreset     = options.layoutPreset ?? 'normal';
        const splitLayout      = options.splitLayout  ?? 'top-bottom';
        const gameRatio        = options.gameRatio    ?? '50-50';
        const gamePosition     = options.gamePosition ?? 'top';
        const letterboxBg      = options.letterboxBg;
        const titleOverlay     = options.titleOverlay;
        const thumbnailPath    = options.thumbnailPath;

        options.customWords = newWords;
        clipRepo.updateOptions(clipId, JSON.stringify(options));

        log.info({ clipId, outputPath: dubbedPath }, 'Running processor to burn subtitles on dubbed video');
        sendProgress(70, 'Burning subtitles...');
        await processor.process({
          clipId,
          projectId:        hook.projectId,
          sourceFile:       project.filePath,
          startMs:          hook.startMs,
          endMs:            hook.startMs + finalDurationMs,
          outputPath:       dubbedPath,
          subtitleStyle:    subtitleStyle as SubtitleStyle,
          subtitlePosition: subtitlePosition as SubtitlePosition,
          zoomEnabled,
          words:            newWords,
          captionStyle,
          logoOverlay,
          trackingMode,
          subjectBbox,
          subjectSeedMs,
          layoutPreset,
          splitLayout,
          gameRatio,
          gamePosition,
          letterboxBg,
          titleOverlay,
          thumbnailPath,
          audioMode:        'replace',
          replacementAudioPath: tempMixedAudioWav,
        });

        try { fs.unlinkSync(ttsTrackPath); } catch {}
        try { fs.unlinkSync(tempMixedVideo); } catch {}
        try { fs.unlinkSync(tempMixedAudioWav); } catch {}

        clipRepo.updateOutputPath(clipId, dubbedPath);
        clipRepo.updateStatus(clipId, 'complete');
        sendProgress(100, '');
        log.info({ clipId, dubbedPath }, 'Gemini AI Dubbing complete');
      } else {
        const clipDurationMs = hook.endMs - hook.startMs;
        let clipRelativeWords: import('../shared/types').TranscriptWord[];

        if (customScript) {
          clipRelativeWords = [{
            word: customScript,
            startMs: 0,
            endMs: clipDurationMs,
            confidence: 1.0,
          }];
        } else {
          clipRelativeWords = words
            .filter((w) => w.startMs >= hook.startMs && w.endMs <= hook.endMs)
            .map((w) => ({ ...w, startMs: w.startMs - hook.startMs, endMs: w.endMs - hook.startMs }));
        }

        sendProgress(30, 'Dubbing audio track...');
        await dubber.dub({
          sourceFile:      clip.outputPath,
          outputPath:      dubbedPath,
          words:           clipRelativeWords,
          startMs:         0,
          endMs:           clipDurationMs,
          voice,
          duckDb,
          googleTtsApiKey: googleTtsApiKey || undefined,
          googleServiceAccountPath: googleSttServiceAccountPath || undefined,
        });

        clipRepo.updateOutputPath(clipId, dubbedPath);
        clipRepo.updateStatus(clipId, 'complete');
        sendProgress(100, '');
        log.info({ clipId, dubbedPath }, 'Dubbing saved');
      }
      void exportDir;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      clipRepo.updateStatus(clipId, 'failed', msg);
      sendProgress(-1, msg);
      throw err;
    }
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
    } catch {}
    await saveTokens({
      access_token:  tokens.access_token  ?? '',
      refresh_token: tokens.refresh_token ?? '',
      expiry_date:   tokens.expiry_date   ?? 0,
      email,
    });

    const newAcc: import('../shared/types').UploadAccount = {
      id: `yt-${Date.now()}`,
      platform: 'youtube',
      name: email ? `YouTube (${email})` : `YouTube Account ${configManager.getAccounts().filter(a => a.platform === 'youtube').length + 1}`,
      youtubeTokens: {
        access_token:  tokens.access_token  ?? '',
        refresh_token: tokens.refresh_token ?? '',
        expiry_date:   tokens.expiry_date   ?? 0,
        email,
      },
      createdAt: Date.now(),
    };
    const current = await ensureAccountsMigrated();
    configManager.saveAccounts([...current.filter(a => a.youtubeTokens?.email !== email || !email), newAcc]);
  },

  getAuthStatus: async () => {
    const accounts = await ensureAccountsMigrated();
    const ytAcc = accounts.find(a => a.platform === 'youtube');
    if (!ytAcc) return { authenticated: false };
    return { authenticated: true, email: ytAcc.youtubeTokens?.email };
  },

  disconnectAuth: async () => {
    await deleteTokens();
  },

  startUpload: async (req) => {
    const clip = clipRepo.findById(req.clipId);
    if (!clip) throw new Error(`Clip ${req.clipId} not found`);
    if (!clip.outputPath) throw new Error('Clip has no output file to upload');

    const platforms = req.platforms || ['youtube'];
    const errors: string[] = [];
    const allAccounts = await ensureAccountsMigrated();
    const selectedAccountIds = Array.isArray(req.accountIds) ? req.accountIds : [];

    // STRICT CHECK: Upload ONLY to accounts whose ID is explicitly in selectedAccountIds

    // 1. YouTube Upload
    if (platforms.includes('youtube')) {
      const clientId     = configManager.get('youtubeClientId');
      const clientSecret = configManager.get('youtubeClientSecret');
      const targetYtAccounts = allAccounts.filter((a) => a.platform === 'youtube' && selectedAccountIds.includes(a.id));
      if (targetYtAccounts.length === 0) {
        errors.push('YouTube: Tidak ada akun target YouTube yang dipilih.');
      }

      for (const acc of targetYtAccounts) {
        try {
          if (!acc.youtubeTokens?.access_token || !clientId || !clientSecret) continue;
          let accessToken = acc.youtubeTokens.access_token;
          const refreshToken = acc.youtubeTokens.refresh_token;
          if (refreshToken) {
            try {
              const oauth2Client = buildOAuthClient(clientId, clientSecret);
              oauth2Client.setCredentials({ access_token: accessToken, refresh_token: refreshToken });
              const { credentials } = await oauth2Client.refreshAccessToken();
              accessToken = credentials.access_token ?? accessToken;
              acc.youtubeTokens.access_token = accessToken;
              if (credentials.refresh_token) acc.youtubeTokens.refresh_token = credentials.refresh_token;
              configManager.saveAccounts(allAccounts);
            } catch (refreshErr) {
              log.error({ err: refreshErr, account: acc.name }, 'Token refresh failed');
            }
          }
          let uploadReq = req;
          let ytTitle = uploadReq.title || 'AI Short';
          if (!/#shorts/i.test(ytTitle)) {
            const suffix = ' #Shorts';
            ytTitle = ytTitle.length + suffix.length > 100 ? ytTitle.substring(0, 100 - suffix.length) + suffix : ytTitle + suffix;
          }
          uploadReq = { ...uploadReq, title: ytTitle };

          const youtubeUrl = await uploader.upload(uploadReq, clip.outputPath, accessToken, refreshToken, clientId, clientSecret);
          clipRepo.updateYouTubeUrl(req.clipId, youtubeUrl);
        } catch (err: any) {
          errors.push(`YouTube (${acc.name}): ${err.message}`);
        }
      }
    }

    // 2. TikTok Upload
    if (platforms.includes('tiktok')) {
      const targetTiktokAccounts = allAccounts.filter((a) => a.platform === 'tiktok' && selectedAccountIds.includes(a.id));
      if (targetTiktokAccounts.length === 0) {
        errors.push('TikTok: Tidak ada akun target TikTok yang dipilih.');
      }

      for (const item of targetTiktokAccounts) {
        if (!item.tiktokSessionId) {
          errors.push(`TikTok (${item.name}): Session ID must be set in Settings.`);
          continue;
        }
        try {
          const tiktokUrl = await tiktokUploader.upload(req.clipId, clip.outputPath, item.tiktokSessionId, req.title, req.description, req.tags || [], configManager);
          clipRepo.updateTikTokUrl(req.clipId, tiktokUrl);
        } catch (err: any) {
          errors.push(`TikTok (${item.name}): ${err.message}`);
        }
      }
    }

    // 3. Facebook Upload
    if (platforms.includes('facebook')) {
      const targetFbAccounts = allAccounts.filter((a) => a.platform === 'facebook' && selectedAccountIds.includes(a.id));
      if (targetFbAccounts.length === 0) {
        errors.push('Facebook: Tidak ada akun target Facebook yang dipilih.');
      }

      for (const item of targetFbAccounts) {
        if (!item.facebookPageId || !item.facebookAccessToken) {
          errors.push(`Facebook (${item.name}): Page ID and Access Token must be set in Settings.`);
          continue;
        }
        try {
          const hashtagString = (req.tags || []).map((t: string) => `#${t.replace(/\s+/g, '')}`).join(' ');
          const fbDescParts = [req.title, req.description, hashtagString, '#shorts #reels'].filter(Boolean);
          let fbDesc = fbDescParts.join('\n\n');
          if (fbDesc.length > 2000) fbDesc = fbDesc.substring(0, 1997) + '...';

          const facebookUrl = await facebookUploader.upload(req.clipId, clip.outputPath, item.facebookPageId, item.facebookAccessToken, req.title, fbDesc, req.publishAt);
          clipRepo.updateFacebookUrl(req.clipId, facebookUrl);
        } catch (err: any) {
          errors.push(`Facebook (${item.name}): ${err.message}`);
        }
      }
    }

    // 4. Telegram Upload
    if (platforms.includes('telegram')) {
      const targetTgAccounts = allAccounts.filter((a) => a.platform === 'telegram' && selectedAccountIds.includes(a.id));
      if (targetTgAccounts.length === 0) {
        errors.push('Telegram: Tidak ada akun target Telegram yang dipilih.');
      }

      for (const item of targetTgAccounts) {
        try {
          if (item.telegramUseUserbot) {
            const apiId = item.telegramApiId || configManager.get('telegramApiId');
            const apiHash = item.telegramApiHash || configManager.get('telegramApiHash');
            const session = item.telegramSession || configManager.get('telegramSession');
            const targetChat = item.telegramChatId || configManager.get('telegramChatId') || 'me';

            if (!apiId || !apiHash || !session) {
              throw new Error('Telegram Userbot credentials not fully configured.');
            }
            const telegramUrl = await telegramUserbotUploader.upload(req.clipId, clip.outputPath, apiId, apiHash, session, targetChat, req.title, req.description, req.tags || []);
            clipRepo.updateTelegramUrl(req.clipId, telegramUrl);
          } else {
            const botToken = item.telegramBotToken || configManager.get('telegramBotToken');
            const chatId = item.telegramChatId || configManager.get('telegramChatId');
            const apiServer = configManager.get('telegramApiServer');
            if (!botToken || !chatId) {
              throw new Error('Telegram Bot Token and Chat ID must be set in Settings.');
            }
            const telegramUrl = await telegramUploader.upload(req.clipId, clip.outputPath, botToken, chatId, req.title, req.description, req.tags || [], apiServer);
            clipRepo.updateTelegramUrl(req.clipId, telegramUrl);
          }
        } catch (err: any) {
          errors.push(`Telegram (${item.name}): ${err.message}`);
        }
      }
    }

    if (errors.length > 0) throw new Error(errors.join(' | '));
  },

  cancelUpload: async () => { /* YouTube resumable upload cancel not yet implemented */ },
  telegramSendCode: async (req: { apiId: number; apiHash: string; phoneNumber: string }) => {
    return telegramUserbotUploader.sendCode(req.apiId, req.apiHash, req.phoneNumber);
  },
  telegramSignIn: async (req: { apiId: number; apiHash: string; phoneNumber: string; phoneCodeHash: string; phoneCode: string; tempSession: string; password?: string }) => {
    return telegramUserbotUploader.signIn(req.apiId, req.apiHash, req.phoneNumber, req.phoneCodeHash, req.phoneCode, req.tempSession, req.password);
  },
  getSettings: async () => configManager.getAll(),
  setSettings: async (settings) => {
    for (const [key, value] of Object.entries(settings)) {
      configManager.set(key as keyof typeof settings, value as never);
    }
  },
  checkDeps: async () => {
    const now = Date.now();
    if (cachedDepsResult && (now - lastDepsCheckTime < 300000)) {
      return cachedDepsResult;
    }

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

    const res = {
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

    cachedDepsResult = res;
    lastDepsCheckTime = Date.now();
    return res;
  },

  saveCustomThumbnail: async (_projectId: string, clipId: string, base64Data: string): Promise<string> => {
    const thumbDir = path.join(app.getPath('userData'), 'thumbnails');
    if (!fs.existsSync(thumbDir)) {
      fs.mkdirSync(thumbDir, { recursive: true });
    }
    const cleanBase64 = base64Data.replace(/^data:image\/[^;]+;base64,/, '');
    const thumbPath = path.join(thumbDir, `${clipId}_custom.jpg`);
    fs.writeFileSync(thumbPath, Buffer.from(cleanBase64, 'base64') as any);
    
    const clip = clipRepo.findById(clipId);
    if (clip) {
      const options = clip.optionsJson ? JSON.parse(clip.optionsJson) : {};
      options.customThumbnail = thumbPath;
      clipRepo.updateOptions(clipId, JSON.stringify(options));
    }
    return thumbPath;
  },

  generateAiThumbnail: async (_projectId: string, frameBase64: string, title: string): Promise<string | null> => {
    const serviceAccountPath = configManager.get('googleSttServiceAccountPath') || '';
    if (!serviceAccountPath || !require('fs').existsSync(serviceAccountPath)) {
      throw new Error('Service account JSON path is not configured. Go to Settings and configure Google STT Service Account JSON file path first.');
    }

    try {
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
      if (!tokenRes.ok) throw new Error(`OAuth token exchange failed with status ${tokenRes.status}`);
      const tokenData = await tokenRes.json() as { access_token: string };

      // Step 1: Use Gemini 1.5 Flash to generate a prompt for Imagen
      const geminiUrl = `https://us-central1-aiplatform.googleapis.com/v1/projects/${keyData.project_id}/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent`;
      
      const cleanBase64Frame = frameBase64.replace(/^data:image\/[^;]+;base64,/, '');

      const geminiResponse = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenData.access_token}` },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [
              {
                inlineData: {
                  mimeType: 'image/jpeg',
                  data: cleanBase64Frame
                }
              },
              {
                text: `Analyze this video frame (image) and the hook text: "${title}". Generate a single highly detailed image generation prompt for Google's Imagen 3.0 model that will generate a highly engaging, clickbait, professional, viral 9:16 vertical thumbnail background image matching the style and content of the frame, but optimized to make users want to click. 

CRITICAL SAFETY RULES:
- Do NOT include any trademarked names, copyrighted character names, franchise names, or show titles (like 'Family Guy', 'Stewie Griffin', 'Disney', 'Star Wars', etc.). 
- Instead, describe the style and characters generically (e.g. use 'American adult animated sitcom style', 'a cartoon baby with a football-shaped head in red overalls').
- Do NOT include any text or words in the prompt description (we will overlay the text separately).

The prompt should describe the scene, the central subject, the color palette, lighting (e.g. dramatic, studio, neon), and mood. Return ONLY the prompt text, no JSON, no formatting, no markdown.`
              }
            ]
          }],
          generationConfig: { temperature: 0.5, maxOutputTokens: 1000 },
        }),
      });

      if (!geminiResponse.ok) {
        const errText = await geminiResponse.text();
        throw new Error(`Gemini prompt generation failed: ${errText}`);
      }

      const geminiData = await geminiResponse.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      const rawPrompt = geminiData.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      const promptText = rawPrompt.trim() || `A cinematic vertical 9:16 vertical background thumbnail for video topic: ${title}`;
      log.info({ promptText }, 'Generated prompt for Imagen');

      // Step 2: Call Imagen API to generate the image
      const imagenUrl = `https://us-central1-aiplatform.googleapis.com/v1/projects/${keyData.project_id}/locations/us-central1/publishers/google/models/imagen-3.0-generate-002:predict`;
      const imagenResponse = await fetch(imagenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenData.access_token}` },
        body: JSON.stringify({
          instances: [
            {
              prompt: promptText
            }
          ],
          parameters: {
            numberOfImages: 1,
            aspectRatio: "9:16",
            outputMimeType: "image/jpeg"
          }
        }),
      });

      if (!imagenResponse.ok) {
        const errText = await imagenResponse.text();
        throw new Error(`Imagen prediction failed: ${errText}`);
      }

      const rawText = await imagenResponse.text();
      let imagenData: any = {};
      try {
        imagenData = JSON.parse(rawText);
      } catch (parseErr) {
        throw new Error(`Failed to parse Imagen JSON response. Status: ${imagenResponse.status}. Body: ${rawText.slice(0, 1000)}`);
      }

      const generatedBase64 = imagenData.predictions?.[0]?.bytesBase64Encoded ?? null;

      if (!generatedBase64) {
        throw new Error(`No image was returned from Vertex AI Imagen. Status: ${imagenResponse.status}. Prompt: "${promptText}". Response: ${rawText.slice(0, 1000)}`);
      }

      return `data:image/jpeg;base64,${generatedBase64}`;
    } catch (err) {
      log.error({ err }, 'Failed to generate AI thumbnail using Vertex AI Imagen');
      throw err;
    }
  },

  searchYouTube: async (params) => {
    const apiKey = configManager.get('youtubeApiKey') || '';
    return searchYouTube(params, apiKey);
  },

  searchClipCafe: async (query) => {
    return clipCafeService.search(query);
  },

  getClipCafeGenreMovies: async (genre, page) => {
    return clipCafeService.getGenreMovies(genre, page);
  },

  getClipCafeMovieClips: async (movieUrl, page) => {
    return clipCafeService.getMovieClips(movieUrl, page);
  },

  getTrendingYouTube: async (params) => {
    const apiKey = configManager.get('youtubeApiKey') || '';
    return getTrending(params, apiKey);
  },

  analyzeTrendYouTube: async (params) => {
    return analyzeTrend(params, configManager);
  },

  optimizeGistScript: async (params) => {
    let images: string[] = [];
    if (params.analyzeVisual && params.clipId) {
      try {
        const clip = clipRepo.findById(params.clipId);
        if (clip) {
          const project = projectRepo.findById(clip.projectId);
          const hook = hookRepo.findById(clip.hookId);

          let videoPath = '';
          let startMs = 0;
          let endMs = 30000;

          if (clip.outputPath && fs.existsSync(clip.outputPath)) {
            videoPath = clip.outputPath;
            startMs = 0;
            endMs = hook ? (hook.endMs - hook.startMs) : 30000;
          } else if (project) {
            videoPath = resolveProjectFilePath(project);
            startMs = hook ? hook.startMs : 0;
            endMs = hook ? hook.endMs : 30000;
          }

          if (videoPath && fs.existsSync(videoPath)) {
            const count = 5;
            const duration = endMs - startMs;
            for (let i = 0; i < count; i++) {
              const timeMs = startMs + Math.round((i / (count - 1)) * duration);
              log.info({ videoPath, timeMs }, 'Extracting frame for multimodal commentary audit');
              const frameB64 = await processor.extractFrame(videoPath, timeMs);
              if (frameB64) {
                images.push(frameB64);
              }
            }
            log.info({ count: images.length }, 'Extracted frames for G.I.S.T. optimize');
          }
        }
      } catch (err) {
        log.error({ err }, 'Failed to extract frames for visual analysis');
      }
    }
    return optimizeGistScript(params, configManager, images);
  },

  saveClipScript: async (clipId: string, customScript: string): Promise<void> => {
    const clip = clipRepo.findById(clipId);
    if (!clip) throw new Error(`Clip ${clipId} not found`);
    const options = clip.optionsJson ? JSON.parse(clip.optionsJson) : {};
    options.customScript = customScript;
    clipRepo.updateOptions(clipId, JSON.stringify(options));
  },

  saveClipCaptionVisibility: async (clipId: string, visible: boolean, customStyle?: any): Promise<void> => {
    const clip = clipRepo.findById(clipId);
    if (!clip) throw new Error(`Clip ${clipId} not found`);
    const options = clip.optionsJson ? JSON.parse(clip.optionsJson) : {};
    options.captionVisible = visible;
    if (customStyle) {
      options.captionStyle = customStyle;
    }
    clipRepo.updateOptions(clipId, JSON.stringify(options));
  },

  saveClipMetadata: async (clipId: string, metadata: { title: string; description: string; tags: string[] }): Promise<void> => {
    const clip = clipRepo.findById(clipId);
    if (!clip) throw new Error(`Clip ${clipId} not found`);
    const options = clip.optionsJson ? JSON.parse(clip.optionsJson) : {};
    options.aiTitle = metadata.title;
    options.aiDescription = metadata.description;
    options.aiTags = metadata.tags;
    clipRepo.updateOptions(clipId, JSON.stringify(options));
  },

  renderPreviewFrame: async (opts) => {
    if (opts.hookId) {
      const hook = hookRepo.findById(opts.hookId as string);
      if (hook) {
        const project = projectRepo.findById(hook.projectId);
        if (project) {
          const transcriptRow = transcriptRepo.findByProjectId(hook.projectId);
          const words = transcriptRow ? JSON.parse(transcriptRow.wordsJson) : [];
          
          opts.sourceFile = resolveProjectFilePath(project);
          opts.startMs = hook.startMs;
          opts.endMs = hook.endMs;
          opts.words = opts.overrideWords || words;
        }
      }
    } else {
      if (opts.overrideWords && !opts.words) {
        opts.words = opts.overrideWords;
      }
    }
    return processor.renderPreviewFrame(opts as any);
  },
  getAccounts: async () => configManager.getAccounts(),
  saveAccounts: async (accounts: any) => configManager.saveAccounts(accounts),
  getPresets: async () => configManager.getPreviewPresets(),
  savePresets: async (presets: any) => configManager.savePreviewPresets(presets),
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

function migrateLegacyAppData(): void {
  try {
    const currentUserData = app.getPath('userData');
    const appDataParent   = app.getPath('appData');
    const legacyDirs = [
      path.join(appDataParent, 'ai-shorts-generator'),
      path.join(appDataParent, 'AI Shorts Generator'),
    ];

    for (const legacyDir of legacyDirs) {
      if (fs.existsSync(legacyDir) && legacyDir !== currentUserData) {
        const itemsToMigrate = ['app.db', 'app-settings.json', 'thumbnails', 'custom_thumbnails', 'models'];
        for (const item of itemsToMigrate) {
          const srcPath = path.join(legacyDir, item);
          const dstPath = path.join(currentUserData, item);
          if (fs.existsSync(srcPath)) {
            const shouldCopy = !fs.existsSync(dstPath) || (item === 'app.db' && fs.statSync(srcPath).size > fs.statSync(dstPath).size);
            if (shouldCopy) {
              const stat = fs.statSync(srcPath);
              if (stat.isDirectory()) {
                fs.cpSync(srcPath, dstPath, { recursive: true });
              } else {
                fs.copyFileSync(srcPath, dstPath);
              }
            }
          }
        }
      }
    }
  } catch {
    /* ignore migration errors */
  }
}

app.whenReady().then(() => {
  // Auto-migrate database & files from legacy folder if changing app name
  migrateLegacyAppData();

  // Initialise SQLite database
  const dbPath = path.join(app.getPath('userData'), 'app.db');
  const db = initDatabase(dbPath);
  projectRepo   = new ProjectRepo(db);
  transcriptRepo = new TranscriptRepo(db);
  hookRepo      = new HookRepo(db);
  clipRepo      = new ClipRepo(db);

  try {
    clipRepo.resetStuckClips();
    log.info('Reset stuck clips on startup');
  } catch (err) {
    log.error({ err }, 'Failed to reset stuck clips');
  }


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

  protocol.handle('localfile', (request) => {
    const url = new URL(request.url);
    // localfile:///C:/path/to/file.mp4  →  C:\path\to\file.mp4
    const filePath = decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, '$1');
    return net.fetch(pathToFileURL(filePath).toString(), {
      method: request.method,
      headers: request.headers,
    });
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
