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
import { spawn } from 'child_process';
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

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    proc.on('error', (e) => reject(new Error(`ffmpeg spawn error: ${e.message}`)));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-300)}`));
    });
  });
}

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
      pexelsApiKey?: string;
      pixabayApiKey?: string;
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

    const sttLang = req.targetAudience === 'ID' ? 'id' : 'en';
    const sttModelSize = 'base';

    try {
      log.info({ sttLang, sttModelSize }, 'Transcribing Hook TTS track with high-accuracy STT engine');
      const sttResult = await this.transcriber.transcribe('commentary-tts', ttsTrackPath, sttLang, sttModelSize, undefined, undefined, undefined, apiKeys.googleServiceAccountPath);
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
          const sttTakeaway = await this.transcriber.transcribe('takeaway-tts', takeawayTtsPath, sttLang, sttModelSize, undefined, undefined, undefined, apiKeys.googleServiceAccountPath);
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

    // 5c. For hook_only and hook_replay_outro modes, generate reaction / mid-scene commentary TTS for Segment B
    let reactionTtsPath = '';
    let actualReactionDurMs = 0;
    let reactionAlignedWords: TranscriptWord[] = [];
    const interjectionText = (scriptResult.middleInterjectionText || '').trim();
    const shouldGenReaction = (req.commentaryMode === 'hook_only' && scriptResult.scriptText && scriptResult.scriptText.trim()) ||
      (req.commentaryMode === 'hook_replay_outro' && !!interjectionText);

    if (shouldGenReaction) {
      this._emitProgress(78, 'reaction', 'Generating mid-scene commentary & voice interjection for Segment B...');
      log.info({ mode: req.commentaryMode }, 'Generating Segment B reaction commentary TTS');
      let reactionText = (req.commentaryMode === 'hook_replay_outro' && interjectionText)
        ? interjectionText
        : scriptResult.scriptText.trim();
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
          actualReactionDurMs = durationMs;
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
            const sttReaction = await this.transcriber.transcribe('reaction-tts', reactionTtsPath, sttLang, sttModelSize, undefined, undefined, undefined, apiKeys.googleServiceAccountPath);
            if (sttReaction?.words && sttReaction.words.length > 0) {
              reactionAlignedWords = sttReaction.words;
              log.info({ wordCount: reactionAlignedWords.length }, 'Reaction TTS subtitles aligned via STT engine');
            }
          } catch (sttErr) {
            log.warn({ sttErr }, 'Reaction STT fallback to character-weighted timings');
          }

          log.info({ reactionTtsPath, actualReactionDurMs }, 'Successfully generated reaction commentary TTS for Segment B');
        } catch (reactionErr) {
          log.warn({ reactionErr }, 'Failed to generate reaction commentary TTS, Segment B will have no AI narration');
        }
      }
    }

    // 5d. Talking Avatar generation (ADDITIVE, guarded).
    let avatarErrorMsg = '';
    let avatarClips: AvatarClips | undefined;
    if (req.avatar?.enabled && req.avatar.imagePath && fs.existsSync(req.avatar.imagePath)) {
      try {
        const baseUrl = AvatarGenerator.resolveBaseUrl(req.avatar, apiKeys.xttsColabUrl);
        if (!baseUrl) throw new Error('avatar base URL empty (set avatarColabUrl / xttsColabUrl)');
        this._emitProgress(84, 'avatar', 'Generating talking avatar clips...');
        const dir = outputDir || path.dirname(videoPath);
        const ext = req.avatar.removeBackground ? 'mov' : 'mp4';
        const clips: AvatarClips = {};

        if (is3Segment) {
          // Segment A (hook) -> talk: Match exact video audio (1.15x tempo + 1.2s J-Cut delay)
          let segAAudioPath = ttsTrackPath;
          try {
            const transformedAudioA = path.join(dir, `avatar_audio_segA_${Date.now()}.wav`);
            await runFfmpeg([
              '-y',
              '-i', ttsTrackPath,
              '-af', 'atempo=1.15,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=1200|1200',
              '-c:a', 'pcm_s16le', '-ar', '16000', '-ac', '1',
              transformedAudioA,
            ]);
            if (fs.existsSync(transformedAudioA) && fs.statSync(transformedAudioA).size > 1000) {
              segAAudioPath = transformedAudioA;
            }
          } catch (errTransA) {
            log.warn({ errTransA }, 'Failed to transform Segment A avatar driving audio; using raw TTS');
          }

          try {
            this._emitProgress(84, 'avatar', 'Generating Segment A avatar clip...');
            clips.segmentA = await this.avatarGen.generate({
              imagePath: req.avatar.imagePath,
              audioPath: segAAudioPath,
              mode: 'talk',
              baseUrl,
              outputPath: path.join(dir, `avatar_segA.${ext}`),
              removeBackground: req.avatar.removeBackground,
            });
            log.info({ path: clips.segmentA }, 'Segment A avatar generated successfully');
          } catch (errA) {
            log.warn({ errA }, 'Failed to generate Segment A avatar clip');
          } finally {
            if (segAAudioPath !== ttsTrackPath) {
              try { fs.unlinkSync(segAAudioPath); } catch {}
            }
          }

          // Segment C (takeaway) -> talk: Match exact video audio (1.15x tempo)
          if (takeawayTtsPath) {
            let segCAudioPath = takeawayTtsPath;
            try {
              const transformedAudioC = path.join(dir, `avatar_audio_segC_${Date.now()}.wav`);
              await runFfmpeg([
                '-y',
                '-i', takeawayTtsPath,
                '-af', 'atempo=1.15,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo',
                '-c:a', 'pcm_s16le', '-ar', '16000', '-ac', '1',
                transformedAudioC,
              ]);
              if (fs.existsSync(transformedAudioC) && fs.statSync(transformedAudioC).size > 1000) {
                segCAudioPath = transformedAudioC;
              }
            } catch (errTransC) {
              log.warn({ errTransC }, 'Failed to transform Segment C avatar driving audio; using raw TTS');
            }

            try {
              this._emitProgress(85, 'avatar', 'Generating Segment C avatar clip...');
              clips.segmentC = await this.avatarGen.generate({
                imagePath: req.avatar.imagePath,
                audioPath: segCAudioPath,
                mode: 'talk',
                baseUrl,
                outputPath: path.join(dir, `avatar_segC.${ext}`),
                removeBackground: req.avatar.removeBackground,
              });
              log.info({ path: clips.segmentC }, 'Segment C avatar generated successfully');
            } catch (errC) {
              log.warn({ errC }, 'Failed to generate Segment C avatar clip');
            } finally {
              if (segCAudioPath !== takeawayTtsPath) {
                try { fs.unlinkSync(segCAudioPath); } catch {}
              }
            }
          }

          // Segment B (replay idle watch, capped to max 10s for fast render & looped by compositor)
          try {
            this._emitProgress(85, 'avatar', 'Generating Segment B idle avatar clip...');
            clips.segmentB = await this.avatarGen.generate({
              imagePath: req.avatar.imagePath,
              audioPath: null,
              mode: 'idle',
              baseUrl,
              outputPath: path.join(dir, `avatar_segB_idle.${ext}`),
              durationSec: Math.min(10, Math.max(1, Math.round(durationMs / 1000))),
              removeBackground: req.avatar.removeBackground,
            });
            log.info({ path: clips.segmentB }, 'Segment B idle avatar generated successfully');
          } catch (errB) {
            log.warn({ errB }, 'Failed to generate Segment B idle avatar clip (will hold static frame or skip)');
          }

          // Segment Jeda (mid-scene vocal interruption -> talk: 1.15x tempo)
          if (reactionTtsPath && fs.existsSync(reactionTtsPath)) {
            let segJedaAudioPath = reactionTtsPath;
            try {
              const transformedAudioJeda = path.join(dir, `avatar_audio_jeda_${Date.now()}.wav`);
              await runFfmpeg([
                '-y',
                '-i', reactionTtsPath,
                '-af', 'atempo=1.15,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo',
                '-c:a', 'pcm_s16le', '-ar', '16000', '-ac', '1',
                transformedAudioJeda,
              ]);
              if (fs.existsSync(transformedAudioJeda) && fs.statSync(transformedAudioJeda).size > 1000) {
                segJedaAudioPath = transformedAudioJeda;
              }
            } catch (errTransJeda) {
              log.warn({ errTransJeda }, 'Failed to transform Segment Jeda avatar driving audio; using raw TTS');
            }

            try {
              this._emitProgress(86, 'avatar', 'Generating Segment Jeda avatar clip...');
              clips.segmentJeda = await this.avatarGen.generate({
                imagePath: req.avatar.imagePath,
                audioPath: segJedaAudioPath,
                mode: 'talk',
                baseUrl,
                outputPath: path.join(dir, `avatar_segB_jeda.${ext}`),
                durationSec: Math.max(1, Math.round((actualReactionDurMs || 2800) / 1000)),
                removeBackground: req.avatar.removeBackground,
              });
              log.info({ path: clips.segmentJeda }, 'Segment Jeda avatar generated successfully');
            } catch (errJ) {
              log.warn({ errJ }, 'Failed to generate Segment Jeda avatar clip');
            } finally {
              if (segJedaAudioPath !== reactionTtsPath) {
                try { fs.unlinkSync(segJedaAudioPath); } catch {}
              }
            }
          }
        } else {
          // Full Commentary Mode -> single continuous talking avatar across the video
          let fullAudioPath = ttsTrackPath;
          try {
            const transformedAudioFull = path.join(dir, `avatar_audio_full_${Date.now()}.wav`);
            await runFfmpeg([
              '-y',
              '-i', ttsTrackPath,
              '-af', 'aresample=16000,aformat=sample_fmts=s16:channel_layouts=mono',
              '-c:a', 'pcm_s16le', '-ar', '16000', '-ac', '1',
              transformedAudioFull,
            ]);
            if (fs.existsSync(transformedAudioFull) && fs.statSync(transformedAudioFull).size > 1000) {
              fullAudioPath = transformedAudioFull;
            }
          } catch (errTransFull) {
            log.warn({ errTransFull }, 'Failed to transform Full commentary avatar driving audio; using raw TTS');
          }

          try {
            this._emitProgress(84, 'avatar', 'Generating Full commentary avatar clip...');
            clips.segmentA = await this.avatarGen.generate({
              imagePath: req.avatar.imagePath,
              audioPath: fullAudioPath,
              mode: 'talk',
              baseUrl,
              outputPath: path.join(dir, `avatar_full.${ext}`),
              durationSec: Math.max(1, Math.round(durationMs / 1000)),
              removeBackground: req.avatar.removeBackground,
            });
            log.info({ path: clips.segmentA }, 'Full commentary avatar generated successfully');
          } catch (errFull) {
            avatarErrorMsg = errFull instanceof Error ? errFull.message : String(errFull);
            log.warn({ errFull }, 'Failed to generate Full commentary avatar clip');
          } finally {
            if (fullAudioPath !== ttsTrackPath) {
              try { fs.unlinkSync(fullAudioPath); } catch {}
            }
          }
        }

        const hasAnyClip = !!(clips.segmentA || clips.segmentB || clips.segmentC || clips.segmentJeda);
        if (hasAnyClip) {
          avatarClips = clips;
          log.info({ clips: Object.keys(clips).filter(k => (clips as any)[k]) }, 'Avatar clips available for compositing');
        } else {
          if (!avatarErrorMsg) {
            avatarErrorMsg = 'All avatar segment clips failed to generate';
          }
          avatarClips = undefined;
        }
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
      reactionDurationMs: actualReactionDurMs || undefined,
      interruptionTimestampSec: scriptResult.interruptionTimestampSec,
      takeawayTtsPath: takeawayTtsPath || undefined,
      takeawayWords: takeawayAlignedWords.length > 0 ? takeawayAlignedWords : undefined,
      customThumbnailPath: req.customThumbnailPath,
      brandingLogoPath: req.brandingLogoPath,
      brollConfig: req.brollConfig,
      originalTranscriptWords: segBOriginalWords,
      pexelsApiKey: apiKeys.pexelsApiKey,
      pixabayApiKey: apiKeys.pixabayApiKey,
      hookHeadline: scriptResult.hookText,
    });

    log.info({ outputPath }, 'Successfully generated commentary video');

    // 7b. Overlay talking-avatar clips onto the rendered video (ADDITIVE, guarded).
    //     Composites to a temp file and only replaces the original on success,
    //     so any failure keeps the standard commentary output intact.
    if (avatarClips && req.avatar) {
      try {
        this._emitProgress(96, 'avatar', 'Compositing talking avatar overlay...');
        const segments: Array<{ clipPath: string; startSec: number; endSec: number }> = [];

        if (is3Segment) {
          const hasSegC = !!avatarClips.segmentC;
          const durA = Math.max(3000, Math.ceil((actualTtsDurMs || ttsDurationMs) / 1.15) + 1200 + 450) / 1000;
          const durC = Math.min(4500, Math.max(2500, Math.ceil((takeawayDurationMs || 0) / 1.15) + 300)) / 1000;
          const useXfade = (req.transitionEffect || 'fade') !== 'none';
          const tDur = useXfade
            ? Math.min(0.35, ...(hasSegC ? [durA, durationMs / 1000, durC] : [durA, durationMs / 1000]).map((d) => d * 0.25))
            : 0;

          let cursor = 0;
          if (avatarClips.segmentA) {
            segments.push({ clipPath: avatarClips.segmentA, startSec: cursor, endSec: cursor + durA - tDur / 2 });
          }
          cursor += (durA - tDur / 2);

          const hasJeda = !!avatarClips.segmentJeda && durationMs >= 14000;
          if (hasJeda) {
            let interruptionMs = scriptResult.interruptionTimestampSec
              ? Math.round(scriptResult.interruptionTimestampSec * 1000)
              : Math.round(durationMs * 0.60);
            interruptionMs = Math.max(5000, Math.min(durationMs - 4000, interruptionMs));
            const durB1 = interruptionMs / 1000;
            const durJeda = Math.max(0.8, (Math.ceil((actualReactionDurMs || 2800) / 1.15) + 150) / 1000);
            const durB2 = (durationMs - interruptionMs) / 1000;

            // B1 (Idle)
            if (avatarClips.segmentB) {
              segments.push({ clipPath: avatarClips.segmentB, startSec: cursor, endSec: cursor + durB1 });
            }
            cursor += durB1;

            // Jeda (Talk)
            if (avatarClips.segmentJeda) {
              segments.push({ clipPath: avatarClips.segmentJeda, startSec: cursor, endSec: cursor + durJeda });
            }
            cursor += durJeda;

            // B2 (Idle)
            if (avatarClips.segmentB) {
              segments.push({ clipPath: avatarClips.segmentB, startSec: cursor, endSec: cursor + durB2 - tDur });
            }
            cursor += (durB2 - tDur);
          } else {
            if (avatarClips.segmentB) {
              segments.push({ clipPath: avatarClips.segmentB, startSec: cursor, endSec: cursor + (durationMs / 1000) - tDur });
            }
            cursor += ((durationMs / 1000) - tDur);
          }

          let totalVideoDurSec = durationMs / 1000;
          try {
            totalVideoDurSec = (await this.processor.getVideoDurationMs(outputPath)) / 1000;
          } catch {}

          if (avatarClips.segmentC) {
            // Extend Segment C avatar overlay until the video finishes completely
            segments.push({
              clipPath: avatarClips.segmentC,
              startSec: cursor,
              endSec: Math.max(cursor + 0.5, totalVideoDurSec + 5.0),
            });
          }
        } else {
          // Full Commentary Mode -> hold until end of video
          let totalVideoDurSec = durationMs / 1000;
          try {
            totalVideoDurSec = (await this.processor.getVideoDurationMs(outputPath)) / 1000;
          } catch {}
          if (avatarClips.segmentA) {
            segments.push({
              clipPath: avatarClips.segmentA,
              startSec: 0,
              endSec: Math.max(1.0, totalVideoDurSec + 5.0),
            });
          }
        }

        await this.compositor.composite({ inputVideoPath: outputPath, avatar: req.avatar, segments });
        log.info({ avatarClipsCount: segments.length }, 'Avatar overlay composited successfully with mid-scene sync');
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
