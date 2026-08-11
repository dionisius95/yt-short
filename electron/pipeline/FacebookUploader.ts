import fs from 'fs';
import { BrowserWindow } from 'electron';
import { CHANNELS } from '../ipc/channels';
import { createLogger } from '../utils/logger';

const log = createLogger('FacebookUploader');

function emitProgress(clipId: string, percent: number): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(CHANNELS.UPLOAD_PROGRESS, { clipId, percent });
    }
  }
}

export class FacebookUploader {
  async upload(
    clipId: string,
    filePath: string,
    pageId: string,
    accessToken: string,
    title: string,
    description: string,
    publishAt?: string
  ): Promise<string> {
    log.info({ clipId, filePath, pageId }, 'Starting Facebook Page Reels upload');
    emitProgress(clipId, 0);

    const stats = fs.statSync(filePath);
    const fileSize = stats.size;

    emitProgress(clipId, 5);

    // Step 1: Start Phase (Initialize Reels upload session)
    log.info('Facebook Reels: Initializing upload session...');
    const startForm = new FormData();
    startForm.append('upload_phase', 'start');
    startForm.append('access_token', accessToken);

    const startResponse = await fetch(`https://graph.facebook.com/v19.0/${pageId}/video_reels`, {
      method: 'POST',
      body: startForm
    });

    if (!startResponse.ok) {
      const errorText = await startResponse.text();
      log.error({ status: startResponse.status, errorText }, 'Facebook Reels Start phase failed');
      throw new Error(`Facebook Reels Start failed: ${errorText || startResponse.statusText}`);
    }

    const startData = await startResponse.json() as any;
    const videoId = startData.video_id;

    if (!videoId) {
      throw new Error('Failed to obtain Facebook Reels video_id.');
    }

    emitProgress(clipId, 15);

    // Step 2: Upload Phase (Send binary data to rupload)
    log.info({ videoId, fileSize }, 'Facebook Reels: Uploading binary data to rupload...');
    const fileBuffer = fs.readFileSync(filePath);

    // Simulate progress during upload since fetch does not have onUploadProgress by default in node-fetch
    let percent = 20;
    const progressInterval = setInterval(() => {
      if (percent < 85) {
        percent += 5;
        emitProgress(clipId, percent);
      }
    }, 1000);

    try {
      const uploadResponse = await fetch(`https://rupload.facebook.com/video-upload/${videoId}`, {
        method: 'POST',
        headers: {
          'Authorization': `OAuth ${accessToken}`,
          'offset': '0',
          'file_size': fileSize.toString(),
          'Content-Type': 'application/octet-stream'
        },
        body: fileBuffer as any
      });

      clearInterval(progressInterval);

      if (!uploadResponse.ok) {
        const errorText = await uploadResponse.text();
        log.error({ status: uploadResponse.status, errorText }, 'Facebook Reels binary upload failed');
        throw new Error(`Facebook Reels binary upload failed: ${errorText || uploadResponse.statusText}`);
      }
      log.info('Facebook Reels: Binary data uploaded successfully.');
    } catch (uploadErr) {
      clearInterval(progressInterval);
      throw uploadErr;
    }

    emitProgress(clipId, 90);

    // Step 3: Finish and Publish Phase
    log.info('Facebook Reels: Finalizing publish (finish phase)...');
    const finishForm = new FormData();
    finishForm.append('upload_phase', 'finish');
    finishForm.append('video_id', videoId);
    finishForm.append('access_token', accessToken);
    
    // Combine title and description for Reels caption
    const caption = `${title || ''}\n\n${description || ''}`.trim();
    finishForm.append('description', caption);

    if (publishAt) {
      const unixTime = Math.floor(new Date(publishAt).getTime() / 1000);
      finishForm.append('video_state', 'SCHEDULED');
      finishForm.append('scheduled_publish_time', unixTime.toString());
      log.info({ unixTime }, 'Facebook Reels: Scheduling Reel');
    } else {
      finishForm.append('video_state', 'PUBLISHED');
    }

    const finishResponse = await fetch(`https://graph.facebook.com/v19.0/${pageId}/video_reels`, {
      method: 'POST',
      body: finishForm
    });

    if (!finishResponse.ok) {
      const errorText = await finishResponse.text();
      log.error({ status: finishResponse.status, errorText }, 'Facebook Reels Finish phase failed');
      throw new Error(`Facebook Reels Finish failed: ${errorText || finishResponse.statusText}`);
    }

    log.info({ clipId, videoId }, 'Facebook Reels upload complete');
    emitProgress(clipId, 100);

    return `https://www.facebook.com/watch/?v=${videoId}`;
  }
}
