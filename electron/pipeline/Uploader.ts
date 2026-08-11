/**
 * Uploader — YouTube Data API v3 resumable upload client.
 *
 * Uses the googleapis library to upload a local MP4 file to YouTube,
 * emitting IPC progress events during the upload.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { BrowserWindow } from 'electron';
import { google } from 'googleapis';
import { CHANNELS } from '../ipc/channels';
import { createLogger } from '../utils/logger';
import type { UploadRequest, PrivacySetting } from '../../shared/types';

const log = createLogger('Uploader');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emitProgress(clipId: string, percent: number): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(CHANNELS.UPLOAD_PROGRESS, { clipId, percent });
    }
  }
}

function privacyStatus(p: PrivacySetting): string {
  if (p === 'private_scheduled') return 'private';
  return p;
}

// ---------------------------------------------------------------------------
// Uploader
// ---------------------------------------------------------------------------

export class Uploader {
  /**
   * Upload a clip to YouTube using the Data API v3.
   *
   * @param req         Upload metadata (title, description, tags, privacy).
   * @param filePath    Absolute path to the MP4 file to upload.
   * @param accessToken Valid OAuth2 access token.
   * @param refreshToken OAuth2 refresh token (used to auto-refresh if expired).
   * @param clientId    OAuth2 client ID.
   * @param clientSecret OAuth2 client secret.
   * @returns           The YouTube video URL after successful upload.
   */
  async upload(
    req: UploadRequest,
    filePath: string,
    accessToken: string,
    refreshToken: string,
    clientId: string,
    clientSecret: string,
  ): Promise<string> {
    log.info({ clipId: req.clipId, filePath }, 'Starting YouTube upload');
    emitProgress(req.clipId, 0);

    const oauth2Client = new google.auth.OAuth2(
      clientId,
      clientSecret,
      'http://localhost:42813/oauth2callback',
    );

    oauth2Client.setCredentials({
      access_token:  accessToken,
      refresh_token: refreshToken,
    });

    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

    const fileSize = fs.statSync(filePath).size;
    const fileStream = fs.createReadStream(filePath);

    emitProgress(req.clipId, 5);

    const statusObj: { privacyStatus: string; publishAt?: string } = {
      privacyStatus: privacyStatus(req.privacy),
    };

    if (req.privacy === 'private_scheduled' && req.publishAt) {
      statusObj.publishAt = req.publishAt;
    }

    const snippetObj: any = {
      title:       req.title       || 'AI Short',
      description: req.description || '',
      tags:        req.tags        || [],
      categoryId:  req.categoryId  || '22',
    };

    if (req.defaultLanguage) {
      snippetObj.defaultLanguage = req.defaultLanguage;
    }
    if (req.defaultAudioLanguage) {
      snippetObj.defaultAudioLanguage = req.defaultAudioLanguage;
    }

    const response = await youtube.videos.insert(
      {
        part: ['snippet', 'status'],
        requestBody: {
          snippet: snippetObj,
          status: statusObj,
        },
        media: {
          mimeType: 'video/mp4',
          body:     fileStream,
        },
      },
      {
        // Track upload progress
        onUploadProgress: (evt: { bytesRead: number }) => {
          const pct = Math.round((evt.bytesRead / fileSize) * 90) + 5;
          emitProgress(req.clipId, Math.min(pct, 95));
        },
      }
    );

    const videoId = response.data.id;
    if (!videoId) throw new Error('YouTube upload succeeded but no video ID returned');

    // Upload custom thumbnail if requested
    if (req.customThumbnailPath && fs.existsSync(req.customThumbnailPath)) {
      let tempJpg: string | null = null;
      try {
        log.info({ videoId, thumbnailPath: req.customThumbnailPath }, 'Uploading custom thumbnail to YouTube');

        // Convert image to guaranteed 100% valid YouTube JPEG via FFmpeg
        const tempPath = path.join(os.tmpdir(), `yt_thumb_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.jpg`);
        try {
          execSync(`ffmpeg -y -i "${req.customThumbnailPath}" -q:v 2 "${tempPath}"`, { stdio: 'ignore' });
          if (fs.existsSync(tempPath)) {
            tempJpg = tempPath;
          }
        } catch {
          // If ffmpeg conversion fails, fallback to original file
        }

        const uploadPath = tempJpg || req.customThumbnailPath;
        const mimeType = uploadPath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';

        await youtube.thumbnails.set({
          videoId,
          media: {
            mimeType,
            body: fs.createReadStream(uploadPath),
          },
        });
        log.info({ videoId }, 'Custom thumbnail uploaded successfully');
      } catch (thumbErr: any) {
        log.warn({ videoId, err: thumbErr?.message }, 'Custom thumbnail upload failed (channel may not be phone-verified for custom thumbnails)');
      } finally {
        if (tempJpg && fs.existsSync(tempJpg)) {
          try { fs.unlinkSync(tempJpg); } catch {}
        }
      }
    }

    const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
    log.info({ clipId: req.clipId, videoId, youtubeUrl }, 'Upload complete');
    emitProgress(req.clipId, 100);

    return youtubeUrl;
  }
}
