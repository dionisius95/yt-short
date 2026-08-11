import fs from 'fs';
import { BrowserWindow } from 'electron';
import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { computeCheck } from 'telegram/Password';
import { CHANNELS } from '../ipc/channels';
import { createLogger } from '../utils/logger';

const log = createLogger('TelegramUserbotUploader');

function emitProgress(clipId: string, percent: number): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(CHANNELS.UPLOAD_PROGRESS, { clipId, percent });
    }
  }
}

export class TelegramUserbotUploader {
  /**
   * Send uncompressed video file (up to 2 GB) directly to personal Telegram (Saved Messages 'me' or target chat).
   */
  async upload(
    clipId: string,
    filePath: string,
    apiId: number,
    apiHash: string,
    sessionString: string,
    targetChat: string,
    title: string,
    description: string,
    tags: string[]
  ): Promise<string> {
    log.info({ clipId, filePath, apiId }, 'Starting Telegram Userbot MTProto upload');
    emitProgress(clipId, 0);

    if (!apiId || !apiHash) {
      throw new Error('Telegram API ID and API Hash must be set in Settings.');
    }
    if (!sessionString) {
      throw new Error('Telegram personal account is not connected. Please connect your account in Settings.');
    }

    // Check 2 GB limit
    const stats = fs.statSync(filePath);
    const maxBytes = 2000 * 1024 * 1024; // 2 GB
    if (stats.size > maxBytes) {
      const sizeMb = (stats.size / (1024 * 1024)).toFixed(1);
      throw new Error(`Ukuran file video (${sizeMb} MB) melebihi batas 2 GB Telegram.`);
    }

    emitProgress(clipId, 15);

    // Format caption
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

    if (caption.length > 1024) {
      caption = caption.substring(0, 1021) + '...';
    }

    emitProgress(clipId, 30);

    const stringSession = new StringSession(sessionString);
    const client = new TelegramClient(stringSession, Number(apiId), apiHash, {
      connectionRetries: 5,
    });

    try {
      await client.connect();
      log.info('GramJS client connected successfully');
      emitProgress(clipId, 50);

      const entity = (targetChat && targetChat.trim()) ? targetChat.trim() : 'me';

      // Send file with forceDocument: true for 0% compression
      await client.sendFile(entity, {
        file: filePath,
        caption: caption,
        forceDocument: true,
        progressCallback: (progress: number) => {
          const percent = 50 + Math.round(progress * 45);
          emitProgress(clipId, percent);
        },
      });

      emitProgress(clipId, 100);
      log.info({ clipId }, 'Telegram Userbot upload completed successfully');

      return `https://t.me/ (Sent to Saved Messages)`;
    } catch (err: any) {
      log.error({ err }, 'Telegram Userbot upload error');
      throw new Error(`Telegram Userbot error: ${err.message}`);
    } finally {
      try {
        await client.disconnect();
      } catch {}
    }
  }

  /**
   * Helper function to send OTP code during authentication setup
   */
  async sendCode(apiId: number, apiHash: string, phoneNumber: string): Promise<{ phoneCodeHash: string; tempSession: string }> {
    const stringSession = new StringSession('');
    const client = new TelegramClient(stringSession, Number(apiId), apiHash, {
      connectionRetries: 3,
    });

    await client.connect();
    const res = await client.sendCode(
      {
        apiId: Number(apiId),
        apiHash,
      },
      phoneNumber
    );

    const tempSession = client.session.save() as unknown as string;
    await client.disconnect();

    return {
      phoneCodeHash: res.phoneCodeHash,
      tempSession,
    };
  }

  /**
   * Helper function to complete sign in with OTP code
   */
  async signIn(
    apiId: number,
    apiHash: string,
    phoneNumber: string,
    phoneCodeHash: string,
    phoneCode: string,
    tempSession: string,
    password?: string
  ): Promise<string> {
    const stringSession = new StringSession(tempSession);
    const client = new TelegramClient(stringSession, Number(apiId), apiHash, {
      connectionRetries: 3,
    });

    await client.connect();

    try {
      await client.invoke(
        new Api.auth.SignIn({
          phoneNumber,
          phoneCodeHash,
          phoneCode,
        })
      );
    } catch (err: any) {
      if (err.message?.includes('SESSION_PASSWORD_NEEDED') && password) {
        const pwd = await client.invoke(new Api.account.GetPassword());
        const passwordCheck = await computeCheck(pwd, password);
        await client.invoke(
          new Api.auth.CheckPassword({
            password: passwordCheck,
          })
        );
      } else {
        throw err;
      }
    }

    const sessionString = client.session.save() as unknown as string;
    await client.disconnect();
    return sessionString;
  }
}
