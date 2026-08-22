/**
 * BrollManager — Automatic B-Roll & Visual Cutaway Engine.
 * 
 * Intercuts relevant B-roll footage (gameplay, minecraft, satisfying loops, custom videos)
 * during video replay segments to:
 * 1. Destroy visual video hash fingerprints (Anti-Reused Content compliance for YPP).
 * 2. Elevate audience retention rate with dynamic 4-6 second visual pattern interrupts.
 * 3. Preserve continuous dialog audio flow (J-Cut / L-Cut).
 */

import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { createLogger } from '../utils/logger';
import { BrollDownloader, type BrollDownloadOptions } from './BrollDownloader';
import type { TranscriptWord, BrollConfig, BrollCategory } from '../../shared/types';

const log = createLogger('BrollManager');

export interface BrollCut {
  startMs: number;
  endMs: number;
  videoPath: string;
  inputIndex?: number;
}

export interface BrollPlan {
  cuts: BrollCut[];
  uniqueVideos: string[];
}

export class BrollManager {
  private static instance: BrollManager;

  // High-salience visual vocabulary (nouns, emotions, concrete objects in EN & ID)
  private static readonly VISUAL_KEYWORDS: Record<string, string> = {
    // Vehicles & Travel
    car: 'car', mobil: 'car', drive: 'driving', driving: 'driving', truck: 'truck', truk: 'truck',
    plane: 'airplane', airplane: 'airplane', pesawat: 'airplane', fly: 'flying', terbang: 'flying',
    ship: 'ship', kapal: 'ship', boat: 'boat', train: 'train', kereta: 'train', bike: 'bicycle', motor: 'motorcycle',
    // Wealth & Economy
    money: 'money', uang: 'money', duit: 'money', cash: 'cash', rich: 'luxury', kaya: 'luxury',
    gold: 'gold', emas: 'gold', diamond: 'diamond', berlian: 'diamond', crypto: 'bitcoin', bitcoin: 'bitcoin',
    dollar: 'money', rupiah: 'money', bank: 'bank', expensive: 'luxury', mahal: 'luxury',
    // City, Nature & Places
    city: 'city', kota: 'city', street: 'street', jalan: 'street', house: 'house', rumah: 'house',
    building: 'building', gedung: 'building', ocean: 'ocean', laut: 'ocean', beach: 'beach', pantai: 'beach',
    mountain: 'mountain', gunung: 'mountain', forest: 'forest', hutan: 'forest', space: 'galaxy', universe: 'galaxy',
    sky: 'sky', langit: 'sky', sunset: 'sunset', sunrise: 'sunrise', rain: 'rain', hujan: 'rain',
    fire: 'fire', api: 'fire', water: 'water', air: 'water', night: 'night city', malam: 'night city',
    // Action & Drama
    fight: 'fighting', berantem: 'fighting', run: 'running', lari: 'running', chase: 'chase', kejar: 'chase',
    crying: 'crying', menangis: 'crying', laugh: 'laughing', tertawa: 'laughing', shock: 'shocked', kaget: 'shocked',
    police: 'police', polisi: 'police', explosion: 'explosion', ledakan: 'explosion', crash: 'car crash',
    dance: 'dancing', joget: 'dancing', sleep: 'sleeping', tidur: 'sleeping', angry: 'angry', marah: 'angry',
    talk: 'people talking', bicara: 'people talking', look: 'people looking', lihat: 'people looking',
    win: 'success celebration', menang: 'success celebration', lose: 'defeat', kalah: 'defeat',
    // Tech & Media
    phone: 'smartphone', hp: 'smartphone', laptop: 'laptop', computer: 'computer', komputer: 'computer',
    game: 'gaming', gaming: 'gaming', camera: 'camera', kamera: 'camera', robot: 'robot', code: 'coding',
    // Food & Lifestyle
    food: 'food', makanan: 'food', coffee: 'coffee', kopi: 'coffee', pizza: 'pizza', burger: 'burger',
    party: 'party', pesta: 'party', gym: 'fitness', workout: 'fitness', music: 'music', gitar: 'guitar',
    cat: 'cat', kucing: 'cat', dog: 'dog', anjing: 'dog', baby: 'baby', bayi: 'baby',
    person: 'person', people: 'people', man: 'man', woman: 'woman', friend: 'friends',
  };

  public static getInstance(): BrollManager {
    if (!BrollManager.instance) {
      BrollManager.instance = new BrollManager();
    }
    return BrollManager.instance;
  }

  /**
   * Scan and retrieve all available B-roll video files based on requested category and directories.
   */
  public getAvailableVideos(category: BrollCategory = 'all', customDir?: string): string[] {
    const candidateDirs: string[] = [];

    if (customDir && fs.existsSync(customDir)) {
      candidateDirs.push(customDir);
    }

    // Default built-in resources directory
    const resourcesBroll = path.join(process.cwd(), 'resources', 'broll');
    if (!fs.existsSync(resourcesBroll)) {
      try { fs.mkdirSync(resourcesBroll, { recursive: true }); } catch {}
    }
    candidateDirs.push(resourcesBroll);

    // AppData storage directory
    try {
      const appDataBroll = path.join(app.getPath('userData'), 'broll');
      if (fs.existsSync(appDataBroll)) candidateDirs.push(appDataBroll);
    } catch {}

    // Optional custom directory
    if (customDir && fs.existsSync(customDir)) {
      candidateDirs.push(customDir);
    }

    const foundFiles: string[] = [];
    const seen = new Set<string>();

    for (const dir of candidateDirs) {
      try {
        if (!fs.existsSync(dir)) continue;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (['.mp4', '.mov', '.mkv', '.webm'].includes(ext)) {
              const fullPath = path.join(dir, entry.name);
              if (!seen.has(fullPath)) {
                seen.add(fullPath);
                foundFiles.push(fullPath);
              }
            }
          }
        }
      } catch (err) {
        log.warn({ err, dir }, 'Failed reading directory for B-roll files');
      }
    }

    // Filter by category
    if (category === 'all' || foundFiles.length <= 1) {
      return foundFiles;
    }

    if (category === 'minecraft') {
      const mc = foundFiles.filter(f => /minecraft|voxel|mining|redstone|craft/i.test(path.basename(f)));
      return mc.length > 0 ? mc : foundFiles;
    }

    if (category === 'gameplay') {
      const gp = foundFiles.filter(f => /game|gamer|minecraft|gta|story|lofi/i.test(path.basename(f)));
      return gp.length > 0 ? gp : foundFiles;
    }

    if (category === 'satisfying') {
      const sat = foundFiles.filter(f => /relax|piano|wave|ocean|coffee|window|sunset/i.test(path.basename(f)));
      return sat.length > 0 ? sat : foundFiles;
    }

    if (category === 'custom' && customDir) {
      const customFiles = foundFiles.filter(f => f.startsWith(customDir));
      return customFiles.length > 0 ? customFiles : foundFiles;
    }

    return foundFiles;
  }

  /**
   * Plan B-roll cutaway timestamps across a given segment duration.
   * Ensures natural pacing: leaves initial 3.5s for establishing context,
   * leaves final 3.5s for punchline, and spaces cuts evenly.
   */
  public planBroll(durationMs: number, config: BrollConfig): BrollPlan {
    const frequencySec = config.frequencySec && config.frequencySec >= 3 ? config.frequencySec : 6;
    const cutDurationSec = config.durationSec && config.durationSec >= 1.0 ? config.durationSec : 2.5;
    const category = config.category || 'all';

    const pool = this.getAvailableVideos(category, config.customDir);
    if (pool.length === 0) {
      log.warn('No B-roll video assets available in pool');
      return { cuts: [], uniqueVideos: [] };
    }

    const durationSec = durationMs / 1000;
    const cuts: BrollCut[] = [];
    const usedVideos = new Set<string>();

    // Safety margins: do not cut in first 3.5s or last 3.5s
    const minStartSec = 3.5;
    const maxEndSec = durationSec - 3.5;

    let currentCursorSec = minStartSec + 1.5;
    let poolIndex = Math.floor(Math.random() * pool.length);

    while (currentCursorSec + cutDurationSec <= maxEndSec) {
      const startMs = Math.round(currentCursorSec * 1000);
      const endMs = Math.round((currentCursorSec + cutDurationSec) * 1000);
      
      const chosenVideo = pool[poolIndex % pool.length];
      poolIndex++;

      cuts.push({
        startMs,
        endMs,
        videoPath: chosenVideo,
      });
      usedVideos.add(chosenVideo);

      currentCursorSec += cutDurationSec + frequencySec;
    }

    log.info({ durationSec, cutsPlanned: cuts.length, videosCount: usedVideos.size }, 'B-Roll cutaways planned');
    return {
      cuts,
      uniqueVideos: Array.from(usedVideos),
    };
  }

  /**
   * Asynchronously plan B-roll cuts, automatically downloading stock footage if pool is empty.
   */
  public async planBrollAsync(
    durationMs: number,
    config: BrollConfig,
    apiOptions?: BrollDownloadOptions
  ): Promise<BrollPlan> {
    const category = config.category || 'all';
    let pool = this.getAvailableVideos(category, config.customDir);

    // If local pool is empty, auto-fetch matching category clips via downloader
    if (pool.length === 0) {
      const categoryQueries: Record<string, string[]> = {
        minecraft: ['minecraft parkour', 'minecraft gameplay', 'minecraft building'],
        gameplay: ['subway surfers gameplay', 'gta gameplay', 'gaming clip'],
        satisfying: ['satisfying kinetic sand', 'satisfying slime', 'satisfying ASMR'],
        contextual: ['cinematic drone', 'nature aerial', 'city street'],
        custom: ['cinematic', 'lifestyle'],
        all: ['minecraft parkour', 'satisfying kinetic sand', 'city drone'],
      };
      const queries = categoryQueries[category] || ['cinematic drone', 'nature'];
      const downloader = BrollDownloader.getInstance();
      for (const q of queries) {
        try {
          const dl = await downloader.getOrDownloadBroll(q, apiOptions);
          if (dl && fs.existsSync(dl)) {
            pool.push(dl);
          }
        } catch {}
      }
    }

    if (pool.length === 0) {
      log.warn({ category }, 'No B-roll video assets available in pool or downloaded');
      return { cuts: [], uniqueVideos: [] };
    }

    const frequencySec = config.frequencySec && config.frequencySec >= 3 ? config.frequencySec : 6;
    const cutDurationSec = config.durationSec && config.durationSec >= 1.0 ? config.durationSec : 2.5;
    const durationSec = durationMs / 1000;
    const cuts: BrollCut[] = [];
    const usedVideos = new Set<string>();

    const minStartSec = 2.0;
    const maxEndSec = durationSec - 2.0;
    let currentCursorSec = minStartSec + 1.0;
    let poolIndex = Math.floor(Math.random() * pool.length);

    while (currentCursorSec + cutDurationSec <= maxEndSec) {
      const startMs = Math.round(currentCursorSec * 1000);
      const endMs = Math.round((currentCursorSec + cutDurationSec) * 1000);
      const chosenVideo = pool[poolIndex % pool.length];
      poolIndex++;

      cuts.push({
        startMs,
        endMs,
        videoPath: chosenVideo,
      });
      usedVideos.add(chosenVideo);
      currentCursorSec += cutDurationSec + frequencySec;
    }

    log.info({ durationSec, cutsPlanned: cuts.length, videosCount: usedVideos.size }, 'B-Roll async cutaways planned');
    return {
      cuts,
      uniqueVideos: Array.from(usedVideos),
    };
  }

  /**
   * Extract high-salience visual keywords and timestamps dynamically from transcript words.
   */
  public extractScriptKeywords(words: TranscriptWord[]): { keyword: string; query: string; timestampMs: number }[] {
    const results: { keyword: string; query: string; timestampMs: number }[] = [];
    if (!words || words.length === 0) return results;

    const stopWords = new Set([
      // English stop words & fillers
      'the', 'and', 'that', 'this', 'with', 'from', 'they', 'what', 'have', 'there',
      'is', 'are', 'was', 'were', 'been', 'being', 'has', 'had', 'will', 'would', 'should',
      'could', 'can', 'may', 'might', 'must', 'about', 'above', 'after', 'again', 'all',
      'also', 'because', 'before', 'below', 'between', 'both', 'but', 'down', 'during',
      'each', 'few', 'for', 'further', 'here', 'how', 'into', 'more', 'most', 'other',
      'out', 'over', 'same', 'some', 'such', 'than', 'then', 'their', 'these', 'those',
      'through', 'too', 'under', 'until', 'very', 'well', 'when', 'where', 'which', 'while',
      'who', 'whom', 'why', 'you', 'your', 'yourself', 'really', 'actually', 'just',
      'like', 'know', 'think', 'mean', 'said', 'says', 'want', 'going', 'gonna', 'got',
      'get', 'need', 'let', 'make', 'take', 'come', 'try', 'use', 'good', 'bad', 'much',
      'many', 'even', 'back', 'still', 'way', 'thing', 'things', 'tell', 'told', 'look',
      // Indonesian stop words & fillers
      'yang', 'dan', 'dari', 'untuk', 'pada', 'dengan', 'adalah', 'ini', 'itu', 'saya',
      'kamu', 'dia', 'mereka', 'kita', 'kami', 'akan', 'sudah', 'belum', 'telah', 'sedang',
      'bisa', 'dapat', 'harus', 'ingin', 'mau', 'menjadi', 'membuat', 'ada', 'tidak',
      'bukan', 'hanya', 'juga', 'lagi', 'selalu', 'sangat', 'lebih', 'paling', 'atau',
      'tetapi', 'tapi', 'jika', 'kalau', 'karena', 'maka', 'sehingga', 'agar', 'supaya',
      'seperti', 'sebagai', 'saat', 'ketika', 'waktu', 'tentang', 'kepada', 'oleh', 'secara',
      'serta', 'pun', 'kok', 'sih', 'deh', 'dong', 'dong', 'banget', 'bener', 'begini',
      'begitu', 'gitu', 'gimana', 'kenapa', 'mengapa', 'bagaimana', 'apa', 'siapa'
    ]);

    for (const w of words) {
      if (!w.word) continue;
      const clean = w.word.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (clean.length < 3 || stopWords.has(clean)) continue;

      // 1. Check if word has translated/refined query in visual vocabulary
      const mappedQuery = BrollManager.VISUAL_KEYWORDS[clean] || clean;

      results.push({
        keyword: clean,
        query: mappedQuery,
        timestampMs: w.startMs,
      });
    }
    return results;
  }

  /**
   * Plan contextual B-roll cuts matched to dialogue timestamps.
   * Auto-downloads from Pexels/Pixabay or picks from local matching files.
   */
  public async planContextualBroll(
    words: TranscriptWord[],
    durationMs: number,
    config: BrollConfig,
    apiOptions?: BrollDownloadOptions
  ): Promise<BrollPlan> {
    const cutDurationSec = config.durationSec && config.durationSec >= 1.0 ? config.durationSec : 2.5;
    const cutDurMs = Math.round(cutDurationSec * 1000);

    const minStartMs = 3500;
    const maxEndMs = durationMs - 3500;

    const cuts: BrollCut[] = [];
    const usedVideos = new Set<string>();
    let lastCutEndMs = -99999;

    // Ensure word timestamps are relative to 0 .. durationMs
    const minWordStart = words.length > 0 ? Math.min(...words.map(w => w.startMs)) : 0;
    const offsetMs = (minWordStart > 5000) ? minWordStart : 0;
    const relWords = words.map(w => ({
      ...w,
      startMs: Math.max(0, w.startMs - offsetMs),
      endMs: Math.max(0, w.endMs - offsetMs),
    }));

    const extracted = this.extractScriptKeywords(relWords);
    log.info({ extractedCount: extracted.length, totalWords: words.length, offsetMs }, 'Extracted contextual visual keywords from transcript');

    const downloader = BrollDownloader.getInstance();

    for (const item of extracted) {
      // Don't cut during intro 3.5s or outro 3.5s
      if (item.timestampMs < minStartMs || item.timestampMs + cutDurMs > maxEndMs) continue;

      // Maintain at least 4.0s gap between B-roll cutaways
      if (item.timestampMs - lastCutEndMs < 4000) continue;

      try {
        const videoPath = await downloader.getOrDownloadBroll(item.query, apiOptions);
        if (videoPath && fs.existsSync(videoPath)) {
          const cutStartMs = Math.max(minStartMs, item.timestampMs - 200);
          const cutEndMs = cutStartMs + cutDurMs;

          cuts.push({
            startMs: cutStartMs,
            endMs: cutEndMs,
            videoPath,
          });
          usedVideos.add(videoPath);
          lastCutEndMs = cutEndMs;
        }
      } catch (err) {
        log.warn({ err, keyword: item.keyword }, 'Failed resolving contextual B-roll for keyword');
      }
    }

    // Fill remaining gaps across entire video duration with dynamic aesthetic pacing B-roll from Pexels
    const frequencySec = config.frequencySec && config.frequencySec >= 3 ? config.frequencySec : 6;
    const fallbackQueries = ['cinematic', 'lifestyle', 'city', 'drone', 'nature', 'aerial', 'driving'];
    let cursorSec = (minStartMs / 1000) + 1.0;
    const maxEndSec = maxEndMs / 1000;
    let qIdx = 0;

    while (cursorSec + cutDurationSec <= maxEndSec) {
      const curStartMs = Math.round(cursorSec * 1000);
      const curEndMs = Math.round((cursorSec + cutDurationSec) * 1000);

      // Check if there is already an existing cut overlapping with this window
      const hasOverlap = cuts.some(c => (curStartMs < c.endMs + 2500) && (curEndMs > c.startMs - 2500));
      if (!hasOverlap) {
        const query = fallbackQueries[qIdx % fallbackQueries.length];
        qIdx++;
        try {
          const videoPath = await downloader.getOrDownloadBroll(query, apiOptions);
          if (videoPath && fs.existsSync(videoPath)) {
            cuts.push({
              startMs: curStartMs,
              endMs: curEndMs,
              videoPath,
            });
            usedVideos.add(videoPath);
          }
        } catch (err) {
          log.warn({ err, query }, 'Failed to download pacing B-roll');
        }
      }
      cursorSec += cutDurationSec + frequencySec;
    }

    // Sort cuts chronologically by startMs
    cuts.sort((a, b) => a.startMs - b.startMs);

    log.info({ cutsPlanned: cuts.length, videosCount: usedVideos.size }, 'Contextual B-Roll cutaways planned');
    return {
      cuts,
      uniqueVideos: Array.from(usedVideos),
    };
  }

  /**
   * Build FFmpeg filter_complex segments for B-roll overlays.
   * Supports full-bleed vertical 9:16 and Letterbox layout matching.
   */
  public buildFfmpegFilter(
    baseLabel: string,
    cuts: BrollCut[],
    videoInputMap: Map<string, number>,
    width = 1080,
    height = 1920,
    layoutConfig?: {
      isLetterbox?: boolean;
      crop?: '1:1' | '4:3' | '16:9' | 'fit';
    }
  ): { filterString: string; outputLabel: string } {
    if (cuts.length === 0) {
      return { filterString: '', outputLabel: baseLabel };
    }

    const filterParts: string[] = [];
    let currentVLabel = baseLabel;

    cuts.forEach((cut, idx) => {
      const inputIdx = videoInputMap.get(cut.videoPath);
      if (inputIdx === undefined) return;

      const brollTrimLabel = `broll_trim_${idx}`;
      const brollScaledLabel = `broll_scaled_${idx}`;
      const nextVLabel = `broll_out_${idx}`;

      const startSec = (cut.startMs / 1000).toFixed(3);
      const endSec = (cut.endMs / 1000).toFixed(3);
      const cutDurSec = ((cut.endMs - cut.startMs) / 1000).toFixed(3);

      // 1. Trim B-roll video to cut duration and sync PTS timestamp to timeline
      filterParts.push(
        `[${inputIdx}:v]trim=start=0:duration=${cutDurSec},setpts=PTS-STARTPTS+${startSec}/TB[${brollTrimLabel}]`
      );

      // 2. Scale & Crop based on letterbox / frame layout
      if (layoutConfig?.isLetterbox) {
        let fgPrep = '';
        if (layoutConfig.crop === '4:3') {
          fgPrep = `crop='min(iw,ih*4/3)':'min(ih,iw*3/4)',`;
        } else if (layoutConfig.crop === '1:1') {
          fgPrep = `crop='min(iw,ih)':'min(iw,ih)',`;
        }
        filterParts.push(
          `[${brollTrimLabel}]${fgPrep}scale=1080:1920:force_original_aspect_ratio=decrease:flags=lanczos,setsar=1[${brollScaledLabel}]`
        );
        filterParts.push(
          `[${currentVLabel}][${brollScaledLabel}]overlay=(W-w)/2:(H-h)/2:enable='between(t,${startSec},${endSec})':eof_action=pass[${nextVLabel}]`
        );
      } else {
        filterParts.push(
          `[${brollTrimLabel}]scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height},setsar=1[${brollScaledLabel}]`
        );
        filterParts.push(
          `[${currentVLabel}][${brollScaledLabel}]overlay=0:0:enable='between(t,${startSec},${endSec})':eof_action=pass[${nextVLabel}]`
        );
      }

      currentVLabel = nextVLabel;
    });

    return {
      filterString: filterParts.join(';'),
      outputLabel: currentVLabel,
    };
  }
}
