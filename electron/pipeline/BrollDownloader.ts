/**
 * BrollDownloader — Automatic Contextual B-Roll Search and Download Engine.
 * 
 * Fetches vertical / portrait royalty-free stock footage matching keywords
 * (e.g. "car", "money", "diamond", "crying", "city") from Pexels or Pixabay,
 * and caches them locally for instant reuse.
 */

import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { createLogger } from '../utils/logger';

const log = createLogger('BrollDownloader');

export interface BrollDownloadOptions {
  pexelsApiKey?: string;
  pixabayApiKey?: string;
  orientation?: 'portrait' | 'landscape';
}

export class BrollDownloader {
  private static instance: BrollDownloader;

  public static getInstance(): BrollDownloader {
    if (!BrollDownloader.instance) {
      BrollDownloader.instance = new BrollDownloader();
    }
    return BrollDownloader.instance;
  }

  /**
   * Get the directory where contextual B-roll downloads are cached.
   */
  public getCacheDir(): string {
    let baseDir = path.join(process.cwd(), 'resources', 'broll', 'contextual');
    try {
      if (!fs.existsSync(baseDir)) {
        fs.mkdirSync(baseDir, { recursive: true });
      }
    } catch {
      try {
        baseDir = path.join(app.getPath('userData'), 'broll', 'contextual');
        if (!fs.existsSync(baseDir)) {
          fs.mkdirSync(baseDir, { recursive: true });
        }
      } catch {}
    }
    return baseDir;
  }

  /**
   * Search local cache first, then Pexels / Pixabay if API key is present.
   */
  public async getOrDownloadBroll(
    query: string,
    options?: BrollDownloadOptions
  ): Promise<string | null> {
    const cleanQuery = query.toLowerCase().replace(/[^a-z0-9]/g, '_').trim();
    if (!cleanQuery) return null;

    const cacheDir = this.getCacheDir();
    const cachedFilePath = path.join(cacheDir, `${cleanQuery}.mp4`);

    // 1. Check local cached file
    if (fs.existsSync(cachedFilePath) && fs.statSync(cachedFilePath).size > 50000) {
      log.info({ cleanQuery, cachedFilePath }, 'Found cached contextual B-roll video');
      return cachedFilePath;
    }

    // 2. Check general resources/broll for any file matching keyword
    const generalDir = path.join(process.cwd(), 'resources', 'broll');
    if (fs.existsSync(generalDir)) {
      try {
        const files = fs.readdirSync(generalDir);
        for (const file of files) {
          if (file.toLowerCase().includes(cleanQuery) && ['.mp4', '.mov', '.webm'].includes(path.extname(file).toLowerCase())) {
            const hit = path.join(generalDir, file);
            log.info({ cleanQuery, hit }, 'Found matching B-roll in general resources directory');
            return hit;
          }
        }
      } catch {}
    }

    // 3. Try Pexels Video Search API
    let pexelsKey = options?.pexelsApiKey || process.env.PEXELS_API_KEY;
    if (!pexelsKey) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { ConfigManager } = require('../config/ConfigManager');
        const cm = new ConfigManager();
        pexelsKey = cm.get('pexelsApiKey') || undefined;
      } catch {}
    }
    if (pexelsKey && pexelsKey.trim()) {
      try {
        const pexelsUrl = await this._fetchFromPexels(cleanQuery, pexelsKey.trim());
        if (pexelsUrl) {
          const downloaded = await this._downloadToFile(pexelsUrl, cachedFilePath);
          if (downloaded) {
            log.info({ cleanQuery, cachedFilePath }, 'Successfully downloaded B-roll from Pexels');
            return cachedFilePath;
          }
        }
      } catch (pexErr) {
        log.warn({ pexErr, cleanQuery }, 'Failed to fetch from Pexels API');
      }
    }

    // 4. Try Pixabay Video Search API
    let pixabayKey = options?.pixabayApiKey || process.env.PIXABAY_API_KEY;
    if (!pixabayKey) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { ConfigManager } = require('../config/ConfigManager');
        const cm = new ConfigManager();
        pixabayKey = cm.get('pixabayApiKey') || undefined;
      } catch {}
    }
    if (pixabayKey && pixabayKey.trim()) {
      try {
        const pixabayUrl = await this._fetchFromPixabay(cleanQuery, pixabayKey.trim());
        if (pixabayUrl) {
          const downloaded = await this._downloadToFile(pixabayUrl, cachedFilePath);
          if (downloaded) {
            log.info({ cleanQuery, cachedFilePath }, 'Successfully downloaded B-roll from Pixabay');
            return cachedFilePath;
          }
        }
      } catch (pixErr) {
        log.warn({ pixErr, cleanQuery }, 'Failed to fetch from Pixabay API');
      }
    }

    log.warn({ cleanQuery }, 'No contextual B-roll found or downloaded for keyword');
    return null;
  }

  /**
   * Query Pexels Video Search API for vertical 9:16 videos.
   */
  private async _fetchFromPexels(query: string, apiKey: string): Promise<string | null> {
    const searchQuery = query.replace(/_/g, ' ').trim();
    const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(searchQuery)}&orientation=portrait&per_page=5`;
    log.info({ searchQuery, url }, 'Querying Pexels Video Search API');
    const res = await fetch(url, {
      headers: {
        Authorization: apiKey,
      },
    });

    if (!res.ok) {
      log.warn({ status: res.status, statusText: res.statusText, searchQuery }, 'Pexels API response not OK');
      return null;
    }

    const data = (await res.json()) as any;
    log.info({ searchQuery, totalResults: data.total_results || 0, returned: data.videos?.length || 0 }, 'Pexels API response received');
    if (!data.videos || data.videos.length === 0) return null;

    // Pick highest quality vertical MP4 video file under 1080p
    const firstVideo = data.videos[0];
    if (!firstVideo.video_files || firstVideo.video_files.length === 0) return null;

    const files = firstVideo.video_files.filter((f: any) => f.file_type === 'video/mp4' || f.link?.includes('.mp4'));
    if (files.length === 0) return firstVideo.video_files[0].link;

    // Find 720p or 1080p vertical
    const preferred = files.find((f: any) => f.height === 1920 || f.width === 1080) ||
                      files.find((f: any) => f.height >= 720) ||
                      files[0];

    return preferred.link;
  }

  /**
   * Query Pixabay Video Search API.
   */
  private async _fetchFromPixabay(query: string, apiKey: string): Promise<string | null> {
    const url = `https://pixabay.com/api/videos/?key=${encodeURIComponent(apiKey)}&q=${encodeURIComponent(query)}&video_type=all&per_page=3`;
    const res = await fetch(url);

    if (!res.ok) {
      log.warn({ status: res.status }, 'Pixabay API response not OK');
      return null;
    }

    const data = (await res.json()) as any;
    if (!data.hits || data.hits.length === 0) return null;

    const hit = data.hits[0];
    if (!hit.videos) return null;

    // Pixabay provides medium, small, large, tiny
    const videoObj = hit.videos.medium || hit.videos.small || hit.videos.large;
    return videoObj?.url || null;
  }

  /**
   * Stream download remote video URL directly to disk.
   */
  private async _downloadToFile(remoteUrl: string, destPath: string): Promise<boolean> {
    const tempDest = `${destPath}.tmp_${Date.now()}`;
    try {
      const res = await fetch(remoteUrl);
      if (!res.ok || !res.body) return false;

      const arrayBuffer = await res.arrayBuffer();
      fs.writeFileSync(tempDest, new Uint8Array(arrayBuffer));

      if (fs.existsSync(tempDest) && fs.statSync(tempDest).size > 10000) {
        fs.renameSync(tempDest, destPath);
        return true;
      }
      return false;
    } catch (err) {
      log.warn({ err, remoteUrl }, 'Failed streaming video download');
      try { if (fs.existsSync(tempDest)) fs.unlinkSync(tempDest); } catch {}
      return false;
    }
  }
}
