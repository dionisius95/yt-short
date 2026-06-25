/**
 * Uploader — YouTube Data API v3 resumable upload client.
 *
 * Uses the googleapis library to upload a local MP4 file to YouTube,
 * emitting IPC progress events during the upload.
 */

import fs from 'fs';
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
  return p; // 'public' | 'unlisted' | 'private' — matches YouTube API values
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

    const response = await youtube.videos.insert(
      {
        part: ['snippet', 'status'],
        requestBody: {
          snippet: {
            title:       req.title       || 'AI Short',
            description: req.description || '',
            tags:        req.tags        || [],
            categoryId:  '22', // People & Blogs
          },
          status: {
            privacyStatus: privacyStatus(req.privacy),
          },
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

    const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
    log.info({ clipId: req.clipId, videoId, youtubeUrl }, 'Upload complete');
    emitProgress(req.clipId, 100);

    return youtubeUrl;
  }
}
