'use client';

/**
 * TranscriptPanel — scrollable transcript with inline editing, transcription progress,
 * and speaker detection labels.
 * Requirements: 4.1, 4.2, 4.7, 4.8, 9.2
 */

import { useState } from 'react';
import { TranscriptWordSpan } from './TranscriptWord';
import { ProgressBar } from '../ui/ProgressBar';
import { ipc } from '../../lib/ipc-client';
import { useIpcEvent } from '../../hooks/useIpcEvent';
import { usePipeline } from '../../hooks/usePipeline';
import type { Transcript, SpeakerSegment } from '../../../shared/types';
import { cn } from '../../lib/utils';

// Speaker colors — cycle through these for each unique speaker
const SPEAKER_COLORS: Record<string, string> = {
  SPEAKER_00: 'text-blue-400',
  SPEAKER_01: 'text-emerald-400',
  SPEAKER_02: 'text-amber-400',
  SPEAKER_03: 'text-rose-400',
};

function getSpeakerColor(speakerId: string): string {
  return SPEAKER_COLORS[speakerId] ?? 'text-purple-400';
}

function getSpeakerLabel(_speakerId: string, index: number): string {
  return `Speaker ${index + 1}`;
}

interface TranscriptPanelProps {
  projectId: string;
  transcript: Transcript | null;
  projectDurationMs?: number;
  onTranscriptReady?: (transcript: Transcript) => void;
  /** Called when pipeline finishes so parent can refresh hooks/clips */
  onPipelineDone?: () => void;
}

export function TranscriptPanel({ projectId, transcript: initialTranscript, projectDurationMs, onTranscriptReady, onPipelineDone }: TranscriptPanelProps) {
  const [transcript, setTranscript] = useState<Transcript | null>(initialTranscript);
  const [transcribing, setTranscribing] = useState(false);
  const [transcribePercent, setTranscribePercent] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [speakerSegments, setSpeakerSegments] = useState<SpeakerSegment[]>([]);
  const [detectingSpeakers, setDetectingSpeakers] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [translateError, setTranslateError] = useState<string | null>(null);
  const [showTranslateMenu, setShowTranslateMenu] = useState(false);

  // Derive speaker IDs from transcript words (Deepgram diarization) or from
  // manually-detected speaker segments — whichever is available.
  const speakerIdsFromWords = (() => {
    if (!transcript) return [];
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const w of transcript.words) {
      if (w.speakerId && !seen.has(w.speakerId)) {
        seen.add(w.speakerId);
        ordered.push(w.speakerId);
      }
    }
    return ordered;
  })();

  // Prefer per-word speaker IDs (from Deepgram diarize) over segment-based detection
  const speakerIds = speakerIdsFromWords.length > 0
    ? speakerIdsFromWords
    : (() => {
        const seen = new Set<string>();
        const ordered: string[] = [];
        for (const seg of speakerSegments.sort((a, b) => a.startMs - b.startMs)) {
          if (!seen.has(seg.speakerId)) { seen.add(seg.speakerId); ordered.push(seg.speakerId); }
        }
        return ordered;
      })();

  const pipeline = usePipeline(projectId);

  // Sync transcribing state with pipeline stage
  // When pipeline is running, it owns the UI — don't show the standalone transcribe bar
  const isTranscribingViaPipeline = pipeline.running && pipeline.stage === 'transcribe';
  const effectiveTranscribing = transcribing && !pipeline.running;
  const effectivePercent = transcribePercent;

  // When pipeline reaches 'done', refresh transcript and notify parent
  useIpcEvent<{ projectId: string; stage: string; stageProgress: number; overallProgress: number }>(
    'pipeline:progress',
    async (data) => {
      if (data.projectId !== projectId) return;
      if (data.stage === 'done') {
        try {
          const tx = await ipc.transcribe.getTranscript(projectId);
          if (tx) { setTranscript(tx); onTranscriptReady?.(tx); }
        } catch { /* ignore */ }
        onPipelineDone?.();
      }
    },
    [projectId]
  );

  // Live transcription progress events
  useIpcEvent<{ projectId: string; percent: number }>(
    'transcribe:progress',
    (data) => {
      if (data.projectId !== projectId) return;
      setTranscribePercent(data.percent);
      if (data.percent >= 100) {
        setTranscribing(false);
      }
    },
    [projectId]
  );

  const startTranscription = async () => {
    setTranscribing(true);
    setTranscribePercent(0);
    setError(null);
    try {
      await ipc.transcribe.start(projectId);
      const tx = await ipc.transcribe.getTranscript(projectId);
      if (tx) {
        setTranscript(tx);
        onTranscriptReady?.(tx);
      }
    } catch (err) {
      setTranscribing(false);
      setError(err instanceof Error ? err.message : 'Transcription failed.');
    }
  };

  const handleDetectSpeakers = async () => {    if (!transcript) return;
    setDetectingSpeakers(true);
    try {
      const result = await ipc.speaker.detect(projectId);
      setSpeakerSegments(result.segments);
    } catch { /* ignore — speaker detection is optional */ }
    finally { setDetectingSpeakers(false); }
  };

  const TRANSLATE_LANGS = [
    { code: 'id', label: '🇮🇩 Indonesian' },
    { code: 'en', label: '🇺🇸 English' },
    { code: 'es', label: '🇪🇸 Spanish' },
    { code: 'fr', label: '🇫🇷 French' },
    { code: 'de', label: '🇩🇪 German' },
    { code: 'ja', label: '🇯🇵 Japanese' },
    { code: 'ko', label: '🇰🇷 Korean' },
    { code: 'zh', label: '🇨🇳 Chinese' },
    { code: 'pt', label: '🇧🇷 Portuguese' },
    { code: 'ms', label: '🇲🇾 Malay' },
  ];

  const handleTranslate = async (targetLang: string) => {
    setShowTranslateMenu(false);
    setTranslating(true);
    setTranslateError(null);
    try {
      await ipc.translate.start(projectId, targetLang);
      const tx = await ipc.transcribe.getTranscript(projectId);
      if (tx) { setTranscript(tx); onTranscriptReady?.(tx); }
    } catch (err) {
      setTranslateError(err instanceof Error ? err.message : 'Translation failed.');
    } finally {
      setTranslating(false);
    }
  };

  /** Get speaker ID for a word — prefer per-word speakerId (Deepgram diarize),
   *  fall back to segment-based lookup (manual detection). */
  const getSpeakerForWord = (word: import('../../../shared/types').TranscriptWord): string | null => {
    // Fast path: Deepgram already tagged this word
    if (word.speakerId) return word.speakerId;
    // Fallback: segment-based lookup
    if (speakerSegments.length === 0) return null;
    const mid = (word.startMs + word.endMs) / 2;
    const seg = speakerSegments.find((s) => s.startMs <= mid && s.endMs >= mid);
    return seg?.speakerId ?? null;
  };

  return (
    <section
      aria-label="Transcript"
      className="flex h-full flex-col overflow-hidden border-r border-border"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-text-secondary">
          Transcript
        </h2>
        <div className="flex items-center gap-2">
          {transcript && (
            <span className="text-[10px] text-text-secondary font-mono">
              {transcript.words.length} words · {transcript.language.toUpperCase()}
            </span>
          )}
          {transcript && (
            <button
              type="button"
              title={speakerIdsFromWords.length > 0
                ? `${speakerIdsFromWords.length} speakers detected by Deepgram`
                : 'Detect speakers (energy-based fallback)'}
              disabled={detectingSpeakers}
              onClick={() => {
                // If Deepgram already provided speaker labels, no need to re-detect
                if (speakerIdsFromWords.length > 0) return;
                void handleDetectSpeakers();
              }}
              className={cn(
                'rounded border border-border px-2 py-0.5 text-[10px] text-text-secondary',
                'hover:border-accent/40 hover:text-text-primary transition-micro',
                'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                'disabled:opacity-40 disabled:cursor-not-allowed',
                speakerIds.length > 0 && 'border-accent/40 text-accent'
              )}
            >
              {detectingSpeakers ? '…' : speakerIds.length > 0 ? `${speakerIds.length} speakers` : '👥'}
            </button>
          )}

          {/* Translate button */}
          {transcript && (
            <div className="relative">
              <button
                type="button"
                title="Translate transcript"
                disabled={translating}
                onClick={() => setShowTranslateMenu((v) => !v)}
                className={cn(
                  'rounded border border-border px-2 py-0.5 text-[10px] text-text-secondary',
                  'hover:border-accent/40 hover:text-text-primary transition-micro',
                  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                  'disabled:opacity-40 disabled:cursor-not-allowed',
                  translating && 'border-accent/40 text-accent'
                )}
              >
                {translating ? '⏳' : '🌐'}
              </button>

              {showTranslateMenu && (
                <div
                  className="absolute right-0 top-full z-50 mt-1 w-44 rounded-md border border-border bg-surface shadow-lg"
                  onMouseLeave={() => setShowTranslateMenu(false)}
                >
                  <p className="border-b border-border px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
                    Translate to
                  </p>
                  {TRANSLATE_LANGS.map(({ code, label }) => (
                    <button
                      key={code}
                      type="button"
                      onClick={() => void handleTranslate(code)}
                      className={cn(
                        'w-full px-3 py-1.5 text-left text-[11px] text-text-primary',
                        'hover:bg-accent/10 transition-micro',
                        transcript.language === code && 'text-accent font-semibold'
                      )}
                    >
                      {label}{transcript.language === code && ' ✓'}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Translation error/progress */}
      {translateError && (
        <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-[10px] text-destructive">
          {translateError}
        </div>
      )}
      {translating && (
        <div className="flex items-center gap-2 border-b border-border px-4 py-2">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-border border-t-accent" />
          <span className="text-[10px] text-text-secondary animate-pulse">Translating via Ollama…</span>
        </div>
      )}

      {speakerIds.length > 0 && (
        <div className="flex flex-wrap gap-2 border-b border-border px-4 py-2">
          {speakerIds.map((id, i) => (
            <span key={id} className={cn('text-[10px] font-medium', getSpeakerColor(id))}>
              ● {getSpeakerLabel(id, i)}
            </span>
          ))}
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4">
        {/* Transcribing progress state */}
        {effectiveTranscribing && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <p className="text-sm text-text-secondary animate-pulse">
                {isTranscribingViaPipeline ? 'Pipeline: transcribing audio…' : 'Transcribing audio…'}
              </p>
              {isTranscribingViaPipeline && (
                <button
                  type="button"
                  onClick={() => void pipeline.cancel()}
                  className="text-[10px] text-text-secondary underline underline-offset-2 hover:text-destructive"
                >
                  Cancel
                </button>
              )}
            </div>
            <ProgressBar
              value={effectivePercent}
              label={`${Math.round(effectivePercent)}%`}
              indeterminate={effectivePercent === 0}
            />
            <p className="text-[10px] text-text-secondary">
              {effectivePercent === 0 && 'Loading model… this may take a moment.'}
              {effectivePercent > 0 && effectivePercent < 25 && 'Loading model…'}
              {effectivePercent >= 25 && effectivePercent < 95 && 'Processing speech…'}
              {effectivePercent >= 95 && 'Finalizing…'}
              {projectDurationMs && effectivePercent < 5 && (
                <span className="ml-1">
                  Est. {Math.ceil(projectDurationMs / 60000)} min video — may take a few minutes on CPU.
                </span>
              )}
            </p>
          </div>
        )}

        {/* Error state */}
        {error && !transcribing && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
            <button
              type="button"
              onClick={() => void startTranscription()}
              className="mt-2 block text-xs underline underline-offset-2 hover:no-underline"
            >
              Retry
            </button>
          </div>
        )}

        {/* Pending state — no transcript yet */}
        {!effectiveTranscribing && !pipeline.running && !error && !transcript && (
          <div className="flex flex-col items-center gap-4 py-10 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 ring-1 ring-accent/20">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                className="text-accent" aria-hidden="true">
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
                <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                <line x1="12" y1="19" x2="12" y2="22"/>
              </svg>
            </div>
            <div>
              <p className="text-sm font-medium text-text-primary">Transcription pending</p>
              <p className="mt-1 text-xs text-text-secondary">
                AI-powered speech-to-text using Whisper.cpp
              </p>
            </div>

            {/* One-click full pipeline */}
            <button
              type="button"
              id="run-pipeline-btn"
              onClick={() => void pipeline.run()}
              className={cn(
                'w-full rounded-md bg-accent px-4 py-2.5 text-sm font-semibold text-accent-foreground',
                'hover:bg-accent-hover transition-micro',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'
              )}
            >
              ▶ Run Full Pipeline
              <span className="ml-1.5 text-[10px] font-normal opacity-70">
                Transcribe → Analyze → Generate Clips
              </span>
            </button>

            {/* Manual transcribe only */}
            <button
              type="button"
              id="start-transcription-btn"
              onClick={() => void startTranscription()}
              className={cn(
                'w-full rounded-md border border-border px-4 py-2 text-xs font-medium text-text-secondary',
                'hover:border-accent/40 hover:text-text-primary transition-micro',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'
              )}
            >
              Transcribe Only
            </button>
          </div>
        )}

        {/* Pipeline running state */}
        {pipeline.running && (
          <div className="flex flex-col gap-3 py-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-text-primary capitalize">
                {pipeline.stage === 'transcribe' && 'Transcribing…'}
                {pipeline.stage === 'analyze'    && 'Analyzing hooks…'}
                {pipeline.stage === 'process'    && 'Generating clips…'}
              </p>
              <button
                type="button"
                onClick={() => void pipeline.cancel()}
                className="text-[10px] text-text-secondary underline underline-offset-2 hover:text-destructive"
              >
                Cancel
              </button>
            </div>
            <ProgressBar
              value={pipeline.overallProgress}
              label={`${Math.round(pipeline.overallProgress)}% overall`}
              indeterminate={pipeline.stageProgress === 0}
            />
            {/* Per-stage sub-bar */}
            <div className="flex flex-col gap-1">
              <span className="text-[10px] text-text-secondary">
                Stage: {Math.round(pipeline.stageProgress)}%
              </span>
              <ProgressBar
                value={pipeline.stageProgress}
                indeterminate={pipeline.stageProgress === 0}
              />
            </div>
            {/* Stage indicators */}
            <div className="flex items-center gap-2 text-[10px]">
              {(['transcribe', 'analyze', 'process'] as const).map((s) => (
                <span
                  key={s}
                  className={cn(
                    'rounded px-1.5 py-0.5 capitalize',
                    pipeline.stage === s
                      ? 'bg-accent/20 text-accent font-semibold'
                      : pipeline.overallProgress > (s === 'transcribe' ? 30 : s === 'analyze' ? 50 : 100)
                        ? 'text-success'
                        : 'text-text-secondary opacity-40'
                  )}
                >
                  {s}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Pipeline error */}
        {pipeline.stage === 'failed' && pipeline.error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {pipeline.error}
            <button
              type="button"
              onClick={() => void pipeline.run()}
              className="mt-2 block text-xs underline underline-offset-2 hover:no-underline"
            >
              Retry Pipeline
            </button>
          </div>
        )}

        {/* Transcript words */}
        {!effectiveTranscribing && transcript && transcript.words.length > 0 && (
          <p className="leading-relaxed text-sm select-text">
            {transcript.words.map((w, i) => {
              const speakerId = getSpeakerForWord(w);
              const colorClass = speakerId ? getSpeakerColor(speakerId) : undefined;
              return (
                <span key={`${w.startMs}-${i}`} className={colorClass}>
                  <TranscriptWordSpan word={w} />
                </span>
              );
            })}
          </p>
        )}
      </div>
    </section>
  );
}
