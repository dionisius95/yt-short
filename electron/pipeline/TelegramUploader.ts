import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
import { BrowserWindow } from 'electron';
import { CHANNELS } from '../ipc/channels';
import { createLogger } from '../utils/logger';

const log = createLogger('TelegramUploader');

function emitProgress(clipId: string, percent: number): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(CHANNELS.UPLOAD_PROGRESS, { clipId, percent });
    }
  }
}

export class TelegramUploader {
  /**
   * Upload a clip to Telegram using the Bot API sendDocument method.
   * Supports both standard https://api.telegram.org (50MB limit) and local/custom Bot API servers (up to 2GB limit).
   *
   * @param clipId      The clip identifier.
   * @param filePath    Absolute path to the MP4 file to send.
   * @param botToken    Telegram Bot Token.
   * @param chatId      Telegram Chat ID (user ID, group ID or channel handle).
   * @param title       Title of the clip.
   * @param description Description of the clip.
   * @param tags        Tags array.
   * @param apiServer   Telegram Bot API base URL (defaults to https://api.telegram.org).
   * @returns           The link representing success.
   */
  async upload(
    clipId: string,
    filePath: string,
    botToken: string,
    chatId: string,
    title: string,
    description: string,
    tags: string[],
    apiServer?: string
  ): Promise<string> {
    log.info({ clipId, filePath, chatId, apiServer }, 'Starting Telegram sendDocument upload');
    emitProgress(clipId, 0);

    if (!botToken) {
      throw new Error('Telegram Bot Token is not set in Settings.');
    }
    if (!chatId) {
      throw new Error('Telegram Chat ID is not set in Settings.');
    }

    const serverUrl = (apiServer && apiServer.trim()) ? apiServer.trim() : 'https://api.telegram.org';
    const isCustomServer = !serverUrl.includes('api.telegram.org');

    // 1. Check file size (Official api.telegram.org = 50MB max; local bot API server = 2000MB max)
    const stats = fs.statSync(filePath);
    const maxBytes = isCustomServer ? 2000 * 1024 * 1024 : 50 * 1024 * 1024;
    if (stats.size > maxBytes) {
      const sizeMb = (stats.size / (1024 * 1024)).toFixed(1);
      const limitMb = isCustomServer ? '2000' : '50';
      throw new Error(
        `Ukuran file video (${sizeMb} MB) melebihi batas ${limitMb} MB Telegram Bot API. Silakan pilih kualitas video yang lebih rendah atau gunakan Local Bot API Server.`
      );
    }

    let fileBuffer: Buffer;
    try {
      fileBuffer = fs.readFileSync(filePath);
      log.info({ bytes: fileBuffer.length }, 'Video file read successfully');
    } catch (err: any) {
      log.error({ err }, 'Failed to read video file');
      throw new Error(`Failed to read file: ${err.message}`);
    }

    emitProgress(clipId, 30);

    // 2. Format caption to match Telegram limits (1024 characters max)
    let caption = `🎥 **${title || 'AI Short'}**\n\n`;
    if (description) {
      caption += `${description}\n\n`;
    }
    if (tags && tags.length > 0) {
      const cleanTags = tags
        .map((tag) => tag.trim().replace(/^#+/, '').trim())
        .filter(Boolean);

      if (cleanTags.length > 0) {
        caption += `${cleanTags.join(', ')}\n`;
      }
    }

    // Clip caption to maximum Telegram caption length of 1024 characters
    if (caption.length > 1024) {
      caption = caption.substring(0, 1021) + '...';
    }

    emitProgress(clipId, 45);

    // 3. Construct manual multipart/form-data payload in memory
    const boundary = `----TelegramBotBoundary${Math.random().toString(36).substring(2)}`;
    const fileName = path.basename(filePath);
    
    const parts: Buffer[] = [];

    // Chat ID field
    parts.push(
      Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="chat_id"\r\n\r\n` +
        `${chatId.trim()}\r\n`
      )
    );

    // Caption field
    parts.push(
      Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="caption"\r\n\r\n` +
        `${caption}\r\n`
      )
    );

    // Parse Mode field (use Markdown)
    parts.push(
      Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="parse_mode"\r\n\r\n` +
        `Markdown\r\n`
      )
    );

    // Document file field header
    parts.push(
      Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="document"; filename="${fileName}"\r\n` +
        `Content-Type: video/mp4\r\n\r\n`
      )
    );

    // Document file binary content
    parts.push(fileBuffer);

    // Footer closing boundary
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    // Combine all chunks into a single request payload buffer
    const payload = Buffer.concat(parts as any);
    log.info({ payloadBytes: payload.length }, 'Multipart payload built successfully');

    emitProgress(clipId, 60);

    return new Promise<string>((resolve, reject) => {
      // Simulate progress up to 90% during transmission
      let currentProgress = 60;
      const progressInterval = setInterval(() => {
        if (currentProgress < 90) {
          currentProgress += 5;
          emitProgress(clipId, currentProgress);
        }
      }, 800);

      const parsedUrl = new URL(serverUrl);
      const isHttps = parsedUrl.protocol === 'https:';
      const httpModule = isHttps ? https : http;

      const basePath = parsedUrl.pathname.endsWith('/')
        ? parsedUrl.pathname.slice(0, -1)
        : parsedUrl.pathname;

      const options: any = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port ? parseInt(parsedUrl.port, 10) : (isHttps ? 443 : 80),
        path: `${basePath}/bot${botToken}/sendDocument`,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': payload.length.toString()
        }
      };

      log.info({ options }, 'Initiating HTTP/HTTPS request to Telegram Bot API...');

      const req = httpModule.request(options, (res) => {
        let responseBody = '';
        res.on('data', (chunk) => {
          responseBody += chunk;
        });

        res.on('end', () => {
          clearInterval(progressInterval);
          log.info({ statusCode: res.statusCode }, 'Received Telegram Bot API response');

          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const resJson = JSON.parse(responseBody);
              if (!resJson.ok) {
                reject(new Error(resJson.description || 'Unknown Telegram error'));
                return;
              }

              emitProgress(clipId, 100);
              const messageId = resJson.result?.message_id;
              const cleanChatId = chatId.startsWith('-100') ? chatId.replace('-100', '') : '';
              if (cleanChatId && !isNaN(Number(cleanChatId))) {
                resolve(`https://t.me/c/${cleanChatId}/${messageId}`);
              } else {
                resolve(`https://t.me/ (Sent to chat ID: ${chatId})`);
              }
            } catch (err: any) {
              reject(new Error(`Failed to parse Telegram response: ${err.message}. Response: ${responseBody}`));
            }
          } else {
            reject(new Error(`Telegram API returned HTTP ${res.statusCode}: ${responseBody}`));
          }
        });
      });

      req.on('error', (err) => {
        clearInterval(progressInterval);
        log.error({ err: err.message }, 'Telegram HTTP/HTTPS socket error');
        reject(new Error(`Telegram socket error: ${err.message}`));
      });

      // Write payload buffer to TCP socket
      req.write(payload);
      req.end();
    });
  }
}
