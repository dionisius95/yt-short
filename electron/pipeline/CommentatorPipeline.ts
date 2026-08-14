/**
 * CommentatorPipeline — Orchestrates full AI Video Commentator generation.
 *
 * Flow:
 * 1. Analyzes video via CommentatorAnalyzer (Gemini Multimodal Vision).
 * 2. Generates voiceover dubbing audio via Dubber (Google Speech / Gemini / EdgeTTS).
 * 3. Applies preset subtitles & mixes audio/video via Processor (FFmpeg).
 */

import path from 'path';
import fs from 'fs';
import { CommentatorAnalyzer } from './CommentatorAnalyzer';
import { Dubber } from './Dubber';
import { Processor } from './Processor';
import { Transcriber } from './Transcriber';
import { AvatarGenerator } from './AvatarGenerator';
import { AvatarCompositor } from './AvatarCompositor';
import { createLogger } from '../utils/logger';
import type { CommentatorRequest, CommentatorResult, TranscriptWord, WhisperModelSize } from '../../shared/types';
import type { AvatarClips } from '../../shared/avatarTypes';

const log = createLogger('CommentatorPipeline');

export class CommentatorPipeline {
  private analyzer = new CommentatorAnalyzer();
  private dubber = new Dubber();
  private processor = new Processor();
  private transcriber = new Transcriber();
  private avatarGen = new AvatarGenerator();
  private compositor = new AvatarCompositor();

  async processCommentary(
    req: CommentatorRequest,
    apiKeys: {
      googleTtsApiKey?: string;
      googleServiceAccountPath?: string;
      xttsColabUrl?: string;
      speakerAudioPath?: string;
      whisperModelSize?: string;
    }
  ): Promise<CommentatorResult> {
    const {
      videoPath,
      voiceId,
      captionPresetId = 'tiktok',
      targetAudience = 'US',
      duckingVolume = 0.2,
      outputDir,
    } = req;

    if (!fs.existsSync(videoPath)) {
      throw new Error(`Video file not found at path: ${videoPath}`);
    }

    log.info({ videoPath, voiceId, captionPresetId, targetAudience }, 'Starting AI Commentator Pipeline');
    this._emitProgress(5, 'start', 'Initializing commentary generation...');

    // 1. Get video duration
    const durationMs = await this.processor.getVideoDurationMs(videoPath);

    // 2. Generate Commentary Script via Gemini Multimodal Vision (Vertex AI)
    this._emitProgress(15, 'analyzer', 'Analyzing video frames & writing commentary script with Vertex AI Gemini...');
    const scriptResult = await this.analyzer.generateScript({
      videoPath,
      durationMs,
      targetAudience,
      serviceAccountPath: apiKeys.googleServiceAccountPath,
    });

    log.info({ hookText: scriptResult.hookText, wordCount: scriptResult.scriptText.split(' ').length, commentaryMode: req.commentaryMode }, 'Generated commentary script');
    this._emitProgress(35, 'script', 'Script generated! Preparing voice dubbing track...');
    const isHookOnly = req.commentaryMode === 'hook_only' || req.commentaryMode === 'hook_replay_outro';
    const is3Segment = req.commentaryMode === 'hook_replay_outro';
    const textForTts = isHookOnly ? scriptResult.hookText : scriptResult.scriptText;

    // Calculate natural speech duration: ~460ms per word (~130 WPM) for natural human pacing
    const wordCount = textForTts.trim().split(/\s+/).filter(Boolean).length;
    const naturalHookDurationMs = Math.max(3000, wordCount * 460 + 500);
    const ttsDurationMs = isHookOnly ? naturalHookDurationMs : durationMs;

    // 3. Convert script text segments into TranscriptWords for TTS timing alignment
    const words = this._textToTranscriptWords(textForTts, ttsDurationMs);

    // 4. Generate TTS Dubbing Audio Track (Hook or Full)
    this._emitProgress(50, 'tts', 'Synthesizing voice dubbing via TTS / Google Colab VoxCPM...');
    const { ttsTrackPath, alignedTranscriptPath } = await this.dubber.generateTts({
      words,
      startMs: 0,
      endMs: ttsDurationMs,
      voice: voiceId || 'google-en-US-Journey-F',
      googleTtsApiKey: apiKeys.googleTtsApiKey,
      googleServiceAccountPath: apiKeys.googleServiceAccountPath,
      xttsColabUrl: apiKeys.xttsColabUrl,
      speakerAudioPath: req.speakerAudioPath || apiKeys.speakerAudioPath,
      sourceFile: videoPath,
    });

    // 5. Read aligned transcript words & run STT alignment engine for 100% exact sync
    this._emitProgress(68, 'align', 'Aligning subtitle timings & phonemes...');
    let actualTtsDurMs = ttsDurationMs;
    try {
      actualTtsDurMs = await this.processor.getVideoDurationMs(ttsTrackPath);
    } catch {}

    // Rescale fallback words to match the EXACT duration of the generated TTS audio track
    let alignedWords: TranscriptWord[] = (actualTtsDurMs > 0 && actualTtsDurMs !== ttsDurationMs)
      ? this._textToTranscriptWords(textForTts, actualTtsDurMs)
      : words;

    if (fs.existsSync(alignedTranscriptPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(alignedTranscriptPath, 'utf-8'));
        if (Array.isArray(parsed) && parsed.length > 0) {
          alignedWords = parsed;
        }
      } catch (err) {
        log.warn({ err }, 'Failed to parse aligned transcript JSON, using default word timings');
      }
    }

    try {
      log.info('Transcribing TTS track with STT engine for 100% exact word synchronization');
      const sttResult = await this.transcriber.transcribe('commentary-tts', ttsTrackPath, 'en', 'tiny', undefined, undefined, undefined, apiKeys.googleServiceAccountPath);
      if (sttResult?.words && sttResult.words.length > 0) {
        alignedWords = sttResult.words;
        log.info({ wordCount: alignedWords.length }, 'Successfully aligned TTS subtitles via STT engine');
      }
    } catch (sttErr) {
      log.warn({ sttErr }, 'STT engine on TTS track fallback to character-weighted aligned transcript');
    }

    // 5b. For Mode 3 (hook_replay_outro), generate educational takeaway TTS for Segment C
    let takeawayTtsPath = '';
    let takeawayAlignedWords: TranscriptWord[] = [];
    let takeawayDurationMs = 0;
    if (is3Segment) {
      this._emitProgress(78, 'takeaway', 'Generating Segment C educational takeaway TTS outro...');
      const takeawayText = (scriptResult.takeawayText || 'Remember, every challenge in life is an opportunity to learn and grow!').trim();
      const takeawayWordCount = takeawayText.split(/\s+/).filter(Boolean).length;
      const takeawayDurMs = Math.max(3500, takeawayWordCount * 460 + 500);
      const takeawayWords = this._textToTranscriptWords(takeawayText, takeawayDurMs);

      try {
        const takeawayResult = await this.dubber.generateTts({
          words: takeawayWords,
          startMs: 0,
          endMs: takeawayDurMs,
          voice: voiceId || 'google-en-US-Journey-F',
          googleTtsApiKey: apiKeys.googleTtsApiKey,
          googleServiceAccountPath: apiKeys.googleServiceAccountPath,
          xttsColabUrl: apiKeys.xttsColabUrl,
          speakerAudioPath: req.speakerAudioPath || apiKeys.speakerAudioPath,
          sourceFile: videoPath,
        });

        takeawayTtsPath = takeawayResult.ttsTrackPath;
        let actualTakeawayDurMs = takeawayDurMs;
        try { actualTakeawayDurMs = await this.processor.getVideoDurationMs(takeawayTtsPath); } catch {}
        takeawayDurationMs = actualTakeawayDurMs;

        takeawayAlignedWords = (actualTakeawayDurMs > 0 && actualTakeawayDurMs !== takeawayDurMs)
          ? this._textToTranscriptWords(takeawayText, actualTakeawayDurMs)
          : takeawayWords;

        if (fs.existsSync(takeawayResult.alignedTranscriptPath)) {
          try { takeawayAlignedWords = JSON.parse(fs.readFileSync(takeawayResult.alignedTranscriptPath, 'utf-8')); } catch {}
        }

        try {
          const sttTakeaway = await this.transcriber.transcribe('takeaway-tts', takeawayTtsPath, 'en', 'tiny', undefined, undefined, undefined, apiKeys.googleServiceAccountPath);
          if (sttTakeaway?.words && sttTakeaway.words.length > 0) {
            takeawayAlignedWords = sttTakeaway.words;
            log.info({ wordCount: takeawayAlignedWords.length }, 'Takeaway TTS subtitles aligned via STT engine');
          }
        } catch (sttErr) {
          log.warn({ sttErr }, 'Takeaway STT fallback to character-weighted timings');
        }
      } catch (tkErr) {
        log.warn({ tkErr }, 'Failed to generate takeaway TTS for Segment C');
      }
    }

    // 5c. For hook_only mode (Mode 2), generate reaction commentary TTS for Segment B
    let reactionTtsPath = '';
    let reactionAlignedWords: TranscriptWord[] = [];
    if (req.commentaryMode === 'hook_only' && scriptResult.scriptText && scriptResult.scriptText.trim()) {
      this._emitProgress(78, 'reaction', 'Generating reaction commentary track for Segment B...');
      log.info('Generating Segment B reaction commentary TTS from script');
      let reactionText = scriptResult.scriptText.trim();
      const hookTextClean = (scriptResult.hookText || '').trim();

      // Strip hookText if reactionText starts with hookText to prevent repeating the hook sentence twice!
      if (hookTextClean && reactionText.toLowerCase().startsWith(hookTextClean.toLowerCase())) {
        reactionText = reactionText.substring(hookTextClean.length).trim();
      }

      if (reactionText) {
        const reactionWords = this._textToTranscriptWords(reactionText, durationMs);

        try {
          const reactionResult = await this.dubber.generateTts({
            words: reactionWords,
            startMs: 0,
            endMs: durationMs,
            voice: voiceId || 'google-en-US-Journey-F',
            googleTtsApiKey: apiKeys.googleTtsApiKey,
            googleServiceAccountPath: apiKeys.googleServiceAccountPath,
            xttsColabUrl: apiKeys.xttsColabUrl,
            speakerAudioPath: req.speakerAudioPath || apiKeys.speakerAudioPath,
            sourceFile: videoPath,
          });

          reactionTtsPath = reactionResult.ttsTrackPath;
          let actualReactionDurMs = durationMs;
          try { actualReactionDurMs = await this.processor.getVideoDurationMs(reactionTtsPath); } catch {}

          reactionAlignedWords = (actualReactionDurMs > 0 && actualReactionDurMs !== durationMs)
            ? this._textToTranscriptWords(reactionText, actualReactionDurMs)
            : reactionWords;

          if (fs.existsSync(reactionResult.alignedTranscriptPath)) {
            try {
              reactionAlignedWords = JSON.parse(fs.readFileSync(reactionResult.alignedTranscriptPath, 'utf-8'));
            } catch {}
          }

          try {
            const sttReaction = await this.transcriber.transcribe('reaction-tts', reactionTtsPath, 'en', 'tiny', undefined, undefined, undefined, apiKeys.googleServiceAccountPath);
            if (sttReaction?.words && sttReaction.words.length > 0) {
              reactionAlignedWords = sttReaction.words;
              log.info({ wordCount: reactionAlignedWords.length }, 'Reaction TTS subtitles aligned via STT engine');
            }
          } catch (sttErr) {
            log.warn({ sttErr }, 'Reaction STT fallback to character-weighted timings');
          }

          log.info({ reactionTtsPath }, 'Successfully generated reaction commentary TTS for Segment B');
        } catch (reactionErr) {
          log.warn({ reactionErr }, 'Failed to generate reaction commentary TTS, Segment B will have no AI narration');
        }
      }
    }

    // 5d. Talking-avatar clips (ADDITIVE, guarded). Only for 3-segment mode.
    //     A/C = talk (lip-sync from TTS), B = idle (silent, blinking). Any
    //     failure leaves avatarClips undefined so the render is unchanged.
    let avatarErrorMsg = '';
    let avatarClips: AvatarClips | undefined;
    let avatarSegASec = 0;
    let avatarSegBSec = 0;
    let avatarSegCSec = 0;
    if (is3Segment && req.avatar?.enabled && req.avatar.imagePath && fs.existsSync(req.avatar.imagePath)) {
      try {
        const baseUrl = AvatarGenerator.resolveBaseUrl(req.avatar, apiKeys.xttsColabUrl);
        if (!baseUrl) throw new Error('avatar base URL empty (set avatarColabUrl / xttsColabUrl)');
        this._emitProgress(84, 'avatar', 'Generating talking avatar clips...');
        const dir = outputDir || path.dirname(videoPath);
        const clips: AvatarClips = {};

        // Segment A (hook) -> talk
        clips.segmentA = await this.avatarGen.generate({
          imagePath: req.avatar.imagePath,
          audioPath: ttsTrackPath,
          mode: 'talk',
          baseUrl,
          outputPath: path.join(dir, 'avatar_segA.mp4'),
          removeBackground: req.avatar.removeBackground,
        });
        avatarSegASec = (actualTtsDurMs || ttsDurationMs) / 1000;

        // Segment C (takeaway) -> talk
        if (takeawayTtsPath) {
          clips.segmentC = await this.avatarGen.generate({
            imagePath: req.avatar.imagePath,
            audioPath: takeawayTtsPath,
            mode: 'talk',
            baseUrl,
            outputPath: path.join(dir, 'avatar_segC.mp4'),
            removeBackground: req.avatar.removeBackground,
          });
          avatarSegCSec = (takeawayDurationMs || 0) / 1000;
        }

        // Segment B (replay) -> idle (silent but blinking/expressive)
        clips.segmentB = await this.avatarGen.generate({
          imagePath: req.avatar.imagePath,
          audioPath: null,
          mode: 'idle',
          baseUrl,
          outputPath: path.join(dir, 'avatar_segB.mp4'),
          durationSec: Math.max(1, Math.round(durationMs / 1000)),
          removeBackground: req.avatar.removeBackground,
        });
        avatarSegBSec = durationMs / 1000;

        avatarClips = clips;
      } catch (avErr) {
        avatarErrorMsg = avErr instanceof Error ? avErr.message : String(avErr);
        log.error({ avErr, avatarColabUrl: AvatarGenerator.resolveBaseUrl(req.avatar, apiKeys.xttsColabUrl) }, 'Avatar generation failed; rendering without avatar');
        avatarClips = undefined;
      }
    }

    // 5e. Segment B raw-dialogue subtitles fallback (ADDITIVE, guarded).
    //     If no original transcript words were supplied (e.g. the source was
    //     never transcribed), transcribe the raw clip so Segment B still shows
    //     the original conversation subtitles. Non-fatal on failure.
    let segBOriginalWords: TranscriptWord[] = Array.isArray(req.originalTranscriptWords)
      ? req.originalTranscriptWords
      : [];
    if (is3Segment && segBOriginalWords.length === 0 && fs.existsSync(videoPath)) {
      try {
        this._emitProgress(86, 'subtitle', 'Transcribing raw clip for Segment B conversation subtitles...');
        const rawStt = await this.transcriber.transcribe(
          'segmentb-raw',
          videoPath,
          'en',
          (apiKeys.whisperModelSize || 'small') as WhisperModelSize,
          undefined,
          undefined,
          undefined,
          apiKeys.googleServiceAccountPath,
        );
        if (rawStt?.words && rawStt.words.length > 0) {
          segBOriginalWords = rawStt.words;
          log.info({ wordCount: segBOriginalWords.length }, 'Transcribed raw clip for Segment B conversation subtitles');
        } else {
          log.warn('Segment B raw transcription returned no words');
        }
      } catch (bErr) {
        log.warn({ bErr }, 'Segment B raw transcription failed; replay will have no original subtitles');
      }
    }

    // 6. Define output file path
    const targetDir = outputDir || path.dirname(videoPath);
    const basename = path.basename(videoPath, path.extname(videoPath));
    const modeSuffix = is3Segment ? '_commentary_3seg.mp4' : isHookOnly ? '_commentary_hook.mp4' : '_commentary_full.mp4';
    const outputPath = path.join(targetDir, `${basename}${modeSuffix}`);

    // 7. Render Subtitles & Mix Audio in Processor
    this._emitProgress(88, 'render', 'Rendering 9:16 video with Ass subtitles, transitions & SFX...');
    await this.processor.renderCommentaryVideo({
      sourceVideoPath: videoPath,
      ttsAudioPath: ttsTrackPath,
      words: alignedWords,
      outputPath,
      presetId: captionPresetId,
      captionStyle: req.captionStyle,
      duckingVolume,
      durationMs,
      commentaryMode: req.commentaryMode || 'full',
      transitionEffect: req.transitionEffect,
      transitionSfx: req.transitionSfx,
      bgMusicPath: req.bgMusicPath,
      bgMusicVolume: req.bgMusicVolume ?? 0.20,
      clipId: req.clipId,
      sourceFile: req.sourceFile,
      startMs: req.startMs,
      endMs: req.endMs,
      optionsJson: req.optionsJson,
      reactionTtsPath: reactionTtsPath || undefined,
      reactionWords: reactionAlignedWords.length > 0 ? reactionAlignedWords : undefined,
      takeawayTtsPath: takeawayTtsPath || undefined,
      takeawayWords: takeawayAlignedWords.length > 0 ? takeawayAlignedWords : undefined,
      customThumbnailPath: req.customThumbnailPath,
      brandingLogoPath: req.brandingLogoPath,
      originalTranscriptWords: segBOriginalWords,
    });

    log.info({ outputPath }, 'Successfully generated commentary video');

    // 7b. Overlay talking-avatar clips onto the rendered video (ADDITIVE, guarded).
    //     Composites to a temp file and only replaces the original on success,
    //     so any failure keeps the standard commentary output intact.
    if (avatarClips && req.avatar) {
      try {
        this._emitProgress(96, 'avatar', 'Compositing talking avatar overlay...');
        // Re-derive avatar segment offsets to match Processor's REAL 3-seg
        // timeline. Processor pads Segment A video to hookAudio + 650ms and
        // Segment C to takeawayAudio + 300ms, then joins the three segments
        // with an xfade of tDur that pulls every later segment earlier. The
        // raw TTS/clip durations set in step 5d made Segment C start ~0.5-1s
        // too early and out of sync with its dubbed audio/video, so recompute
        // the offsets here to mirror the Processor timeline exactly.
        {
          const hasSegC = !!avatarClips.segmentC;
          const durA = Math.max(2000, Math.ceil(actualTtsDurMs || ttsDurationMs) + 650) / 1000;
          const durB = durationMs / 1000;
          const durC = Math.max(3000, Math.ceil(takeawayDurationMs || 0) + 300) / 1000;
          const useXfade = (req.transitionEffect || 'fade') !== 'none';
          const tDur = useXfade
            ? Math.min(0.35, ...(hasSegC ? [durA, durB, durC] : [durA, durB]).map((d) => d * 0.25))
            : 0;
          avatarSegASec = durA - tDur / 2;
          avatarSegBSec = durB - tDur;
          avatarSegCSec = durC - tDur / 2;
        }
        const segments: Array<{ clipPath: string; startSec: number; endSec: number }> = [];
        let cursor = 0;
        if (avatarClips.segmentA) {
          segments.push({ clipPath: avatarClips.segmentA, startSec: cursor, endSec: cursor + avatarSegASec });
        }
        cursor += avatarSegASec;
        if (avatarClips.segmentB) {
          segments.push({ clipPath: avatarClips.segmentB, startSec: cursor, endSec: cursor + avatarSegBSec });
        }
        cursor += avatarSegBSec;
        if (avatarClips.segmentC) {
          segments.push({ clipPath: avatarClips.segmentC, startSec: cursor, endSec: cursor + avatarSegCSec });
        }
        await this.compositor.composite({ inputVideoPath: outputPath, avatar: req.avatar, segments });
        log.info({ avatarSegASec, avatarSegBSec, avatarSegCSec }, 'Avatar overlay composited successfully');
      } catch (compErr) {
        avatarErrorMsg = compErr instanceof Error ? compErr.message : String(compErr);
        log.error({ compErr }, 'Avatar compositing failed; keeping original commentary video');
      }
    }

    // 8. Write a diagnostics sidecar next to the output so avatar/subtitle
    //    issues can be inspected without reading console logs. Non-fatal.
    try {
      const debugInfo = {
        timestamp: new Date().toISOString(),
        commentaryMode: req.commentaryMode || 'full',
        is3Segment,
        avatar: {
          requested: !!req.avatar,
          enabled: !!req.avatar?.enabled,
          imagePath: req.avatar?.imagePath || null,
          imageExists: req.avatar?.imagePath ? fs.existsSync(req.avatar.imagePath) : false,
          resolvedBaseUrl: req.avatar ? AvatarGenerator.resolveBaseUrl(req.avatar, apiKeys.xttsColabUrl) : null,
          generated: !!avatarClips,
          segmentAExists: avatarClips?.segmentA ? fs.existsSync(avatarClips.segmentA) : false,
          segmentBExists: avatarClips?.segmentB ? fs.existsSync(avatarClips.segmentB) : false,
          segmentCExists: avatarClips?.segmentC ? fs.existsSync(avatarClips.segmentC) : false,
          error: avatarErrorMsg || null,
        },
        segmentBSubtitles: {
          providedWordCount: Array.isArray(req.originalTranscriptWords) ? req.originalTranscriptWords.length : 0,
          finalWordCount: segBOriginalWords.length,
          usedTranscriptionFallback: !(Array.isArray(req.originalTranscriptWords) && req.originalTranscriptWords.length > 0) && segBOriginalWords.length > 0,
        },
        outputPath,
      };
      fs.writeFileSync(`${outputPath}.debug.json`, JSON.stringify(debugInfo, null, 2), 'utf-8');
      log.info({ debugInfo }, 'Commentary debug diagnostics written');
    } catch (dbgErr) {
      log.warn({ dbgErr }, 'Failed to write commentary debug sidecar');
    }

    this._emitProgress(
      100,
      'done',
      avatarErrorMsg
        ? `Selesai — namun avatar gagal dibuat (${avatarErrorMsg}). Video tetap dibuat tanpa avatar.`
        : 'Commentary video generation complete!',
    );

    return {
      outputPath,
      scriptText: scriptResult.scriptText,
      hookText: scriptResult.hookText,
      takeawayText: scriptResult.takeawayText,
      durationMs,
    };
  }

  private _emitProgress(percent: number, stage: string, message: string) {
    try {
      const { BrowserWindow } = require('electron');
      const wins = BrowserWindow.getAllWindows();
      for (const win of wins) {
        if (!win.isDestroyed()) {
          win.webContents.send('commentator:progress', { percent, stage, message });
        }
      }
    } catch {}
  }

  private _textToTranscriptWords(text: string, totalDurationMs: number): TranscriptWord[] {
    const cleanText = text.trim();
    if (!cleanText) return [];

    // Reserve 350ms buffer for short hook audio or 2.5s for long full commentary scripts
    const endBufferMs = totalDurationMs <= 10000 ? 350 : 2500;
    const usableDurationMs = Math.max(1000, totalDurationMs - endBufferMs);

    // Split script only at full sentence ends (. ! ?)
    const sentenceRegex = /[^.!?]+[.!?]+/g;
    const sentences = cleanText.match(sentenceRegex) || [cleanText];

    const totalWords = cleanText.split(/\s+/).filter(Boolean).length;
    if (totalWords === 0) return [];

    // Subtle 150ms natural pause between full sentences (no mid-sentence chopping)
    const pauseDurationMs = 150;
    const totalPausesMs = Math.max(0, (sentences.length - 1) * pauseDurationMs);
    const speechTimeMs = Math.max(1000, usableDurationMs - totalPausesMs);
    const msPerWord = speechTimeMs / totalWords;

    const result: TranscriptWord[] = [];
    let currentMs = 0;

    for (let sIdx = 0; sIdx < sentences.length; sIdx++) {
      const sentence = sentences[sIdx].trim();
      const words = sentence.split(/\s+/).filter(Boolean);
      if (words.length === 0) continue;

      for (let wIdx = 0; wIdx < words.length; wIdx++) {
        const word = words[wIdx];
        const startMs = Math.round(currentMs);
        const endMs = Math.round(currentMs + msPerWord);
        result.push({ word, startMs, endMs, confidence: 1.0 });
        currentMs = endMs;
      }

      // Add a subtle 150ms gap only between distinct full sentences
      if (sIdx < sentences.length - 1) {
        currentMs += pauseDurationMs;
      }
    }

    return result;
  }
}
