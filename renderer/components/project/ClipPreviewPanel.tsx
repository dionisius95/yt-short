'use client';

/**
 * ClipPreviewPanel — 9:16 video preview with caption preset picker, live preview, and controls.
 */

import { useState, useEffect, useRef } from 'react';
import { ProgressBar } from '../ui/ProgressBar';
import { useIpcEvent } from '../../hooks/useIpcEvent';
import { ipc } from '../../lib/ipc-client';
import {
  CAPTION_PRESETS,
  type Clip,
  type AppSettings,
  type CaptionPresetId,
  type CaptionStyle,
  type CaptionFont,
  type CaptionAnimation,
  type CaptionLines,
  type SubtitlePosition,
  type LogoOverlay,
  type LogoPosition,
  type LayoutPreset,
  type SplitLayout,
  type GameRatio,
  type GamePosition,
} from '../../../shared/types';
import { cn } from '../../lib/utils';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PRESET_OPTIONS: { id: CaptionPresetId; label: string; description: string }[] = [
  { id: 'karaoke',    label: 'Karaoke',    description: 'Word-by-word highlight' },
  { id: 'simple',     label: 'Simple',     description: 'Clean white text' },
  { id: 'thinkmedia', label: 'ThinkMedia', description: 'Yellow bold uppercase' },
  { id: 'hormozi',    label: 'Hormozi',    description: 'Large centered impact' },
  { id: 'reels',      label: 'Reels',      description: 'Multi-line cyan accent' },
  { id: 'custom',     label: 'Custom',     description: 'Your own settings' },
];

const FONT_OPTIONS: CaptionFont[] = ['Arial', 'Impact', 'Montserrat', 'Oswald', 'Roboto', 'Anton'];
const ANIMATION_OPTIONS: { value: CaptionAnimation; label: string }[] = [
  { value: 'none',     label: 'None'     },
  { value: 'fade',     label: 'Fade'     },
  { value: 'pop',      label: 'Pop'      },
  { value: 'slide-up', label: 'Slide Up' },
];
const POSITION_OPTIONS: { value: SubtitlePosition; label: string }[] = [
  { value: 'lower-third', label: 'Bottom' },
  { value: 'center',      label: 'Center' },
  { value: 'upper-third', label: 'Top'    },
];
const LINES_OPTIONS: { value: CaptionLines; label: string }[] = [
  { value: 1, label: '1 word'  },
  { value: 2, label: '2 words' },
  { value: 3, label: '3 words' },
];

// Canvas reference size (matches ASS PlayResX/Y)
const CANVAS_W = 1080;
const CANVAS_H = 1920;

// ---------------------------------------------------------------------------
// Live caption preview overlay
// ---------------------------------------------------------------------------

/**
 * Renders a CSS-based caption overlay that mirrors the ASS subtitle style.
 * Shows real transcript words when available, falls back to sample text.
 */
function CaptionLivePreview({
  caption,
  containerWidth,
  containerHeight,
  words,
  startMs,
  endMs,
}: {
  caption: CaptionStyle;
  containerWidth: number;
  containerHeight: number;
  words?: import('../../../shared/types').TranscriptWord[];
  startMs?: number;
  endMs?: number;
}) {
  const scaleX = containerWidth  / CANVAS_W;
  const scaleY = containerHeight / CANVAS_H;
  const scale  = Math.min(scaleX, scaleY);

  const scaledFontSize = Math.round(caption.fontSize    * scale);
  const scaledOutline  = Math.max(1, Math.round(caption.outlineSize * scale));
  const scaledShadow   = Math.max(0, Math.round(caption.shadowSize  * scale));
  const scaledMarginV  = Math.round(120 * scale);

  // Build word groups from real transcript or fall back to sample
  let displayGroups: string[][];
  if (words && words.length > 0 && startMs !== undefined && endMs !== undefined) {
    const clipWords = words
      .filter((w) => w.startMs >= startMs && w.endMs <= endMs)
      .map((w) => style_uppercase(w.word.trim(), caption.uppercase));
    // Take first 2 groups of `lines` words for preview
    displayGroups = [];
    for (let i = 0; i < Math.min(clipWords.length, caption.lines * 2); i += caption.lines) {
      displayGroups.push(clipWords.slice(i, i + caption.lines));
    }
    if (displayGroups.length === 0) {
      displayGroups = [['No', 'words'].slice(0, caption.lines)];
    }
  } else {
    displayGroups = [
      ['Sample', 'Caption', 'Text'].slice(0, caption.lines),
      ['Preview', 'Style', 'Here'].slice(0, caption.lines),
    ];
  }

  const positionStyle: React.CSSProperties =
    caption.position === 'lower-third'
      ? { bottom: scaledMarginV, left: 0, right: 0, textAlign: 'center' }
      : caption.position === 'upper-third'
      ? { top: scaledMarginV, left: 0, right: 0, textAlign: 'center' }
      : { top: '50%', left: 0, right: 0, textAlign: 'center', transform: 'translateY(-50%)' };

  const outlineColor = caption.outlineColor;
  const textShadow = scaledOutline > 0
    ? [
        `${scaledOutline}px 0 0 ${outlineColor}`,
        `-${scaledOutline}px 0 0 ${outlineColor}`,
        `0 ${scaledOutline}px 0 ${outlineColor}`,
        `0 -${scaledOutline}px 0 ${outlineColor}`,
        `${scaledOutline}px ${scaledOutline}px 0 ${outlineColor}`,
        `-${scaledOutline}px -${scaledOutline}px 0 ${outlineColor}`,
        `${scaledOutline}px -${scaledOutline}px 0 ${outlineColor}`,
        `-${scaledOutline}px ${scaledOutline}px 0 ${outlineColor}`,
        scaledShadow > 0 ? `${scaledShadow * 2}px ${scaledShadow * 2}px ${scaledShadow * 3}px rgba(0,0,0,0.8)` : '',
      ].filter(Boolean).join(', ')
    : undefined;

  const animClass =
    caption.animation === 'fade'     ? 'animate-fade-in' :
    caption.animation === 'pop'      ? 'animate-bounce'  :
    caption.animation === 'slide-up' ? 'animate-slide-up-caption' :
    '';

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className={cn('absolute px-2', animClass)} style={positionStyle}>
        {displayGroups.map((group, gi) => (
          <div key={gi} className="leading-tight">
            {caption.presetId === 'karaoke' ? (
              <span>
                {group.map((word, wi) => (
                  <span
                    key={wi}
                    style={{
                      fontFamily:  caption.font,
                      fontSize:    scaledFontSize,
                      fontWeight:  caption.bold ? 'bold' : 'normal',
                      color:       wi === 0 ? caption.highlightColor : caption.primaryColor,
                      textShadow,
                      display:     'inline',
                      marginRight: wi < group.length - 1 ? `${Math.round(4 * scale)}px` : 0,
                    }}
                  >
                    {word}
                  </span>
                ))}
              </span>
            ) : (
              <span
                style={{
                  fontFamily: caption.font,
                  fontSize:   scaledFontSize,
                  fontWeight: caption.bold ? 'bold' : 'normal',
                  color:      caption.primaryColor,
                  textShadow,
                }}
              >
                {group.join(' ')}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function style_uppercase(text: string, upper: boolean): string {
  return upper ? text.toUpperCase() : text;
}

// ---------------------------------------------------------------------------
// Logo live preview overlay
// ---------------------------------------------------------------------------

function LogoLivePreview({
  logo,
  containerWidth,
  containerHeight,
}: {
  logo: LogoOverlay;
  containerWidth: number;
  containerHeight: number;
}) {
  const scaleX = containerWidth  / CANVAS_W;
  const scaleY = containerHeight / CANVAS_H;
  const scale  = Math.min(scaleX, scaleY);

  const logoW  = Math.round(CANVAS_W * logo.scale * scale);
  const margin = Math.round(logo.margin * scale);

  const posStyle: React.CSSProperties = { position: 'absolute', width: logoW };
  switch (logo.position) {
    case 'top-left':     posStyle.top    = margin; posStyle.left   = margin; break;
    case 'top-right':    posStyle.top    = margin; posStyle.right  = margin; break;
    case 'bottom-left':  posStyle.bottom = margin; posStyle.left   = margin; break;
    case 'bottom-right': posStyle.bottom = margin; posStyle.right  = margin; break;
    case 'center':
      posStyle.top  = '50%';
      posStyle.left = '50%';
      posStyle.transform = 'translate(-50%, -50%)';
      break;
  }

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`localfile:///${logo.filePath.replace(/\\/g, '/')}`}
        alt=""
        style={{ ...posStyle, opacity: logo.opacity }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ClipPreviewPanelProps {
  clip: Clip | null;
  hookId: string | null;
  defaultSettings: Pick<AppSettings, 'defaultSubtitleStyle' | 'defaultSubtitlePosition'>;
  words?: import('../../../shared/types').TranscriptWord[];
  hookStartMs?: number;
  hookEndMs?: number;
}

// ---------------------------------------------------------------------------
// Small UI helpers
// ---------------------------------------------------------------------------

function Label({ children }: { children: React.ReactNode }) {
  return <span className="text-[10px] font-medium uppercase tracking-wider text-text-secondary">{children}</span>;
}

function ColorSwatch({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <div className="flex flex-col gap-1">
      <Label>{label}</Label>
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        className="h-7 w-full cursor-pointer rounded border border-border bg-transparent p-0.5"
      />
    </div>
  );
}

function Select<T extends string | number>({
  value, onChange, options, label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  label: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label>{label}</Label>
      <select
        value={String(value)}
        onChange={(e) => onChange(e.target.value as T)}
        aria-label={label}
        className={cn(
          'rounded border border-border bg-background px-2 py-1 text-xs text-text-primary',
          'focus:outline-none focus:ring-1 focus:ring-accent'
        )}
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

function NumberInput({ value, onChange, min, max, label }: {
  value: number; onChange: (v: number) => void; min: number; max: number; label: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label>{label}</Label>
      <div className="flex items-center gap-1.5">
        <input
          type="range"
          min={min}
          max={max}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label={label}
          className="flex-1 accent-accent"
        />
        <span className="w-8 text-right text-[10px] font-mono text-text-secondary">{value}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ClipPreviewPanel({ clip, hookId, words, hookStartMs, hookEndMs }: ClipPreviewPanelProps) {
  // ── Persistent preview settings (saved to localStorage) ──────────────
  const STORAGE_KEY = 'clip-preview-settings';

  const loadSavedSettings = () => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch { /* ignore */ }
    return null;
  };

  const saved = loadSavedSettings();

  const [presetId, setPresetId]   = useState<CaptionPresetId>(saved?.presetId ?? 'karaoke');
  const [caption, setCaption]     = useState<CaptionStyle>(saved?.caption ?? { ...CAPTION_PRESETS['karaoke'], presetId: 'karaoke' });
  const [zoomEnabled, setZoomEnabled] = useState(saved?.zoomEnabled ?? clip?.zoomEnabled ?? true);
  const [trackingMode, setTrackingMode] = useState<'auto' | 'manual' | 'none' | 'speaker'>(saved?.trackingMode ?? 'auto');
  const [layoutPreset, setLayoutPreset] = useState<LayoutPreset>(saved?.layoutPreset ?? 'normal');
  const [splitLayout, setSplitLayout]   = useState<SplitLayout>(saved?.splitLayout ?? 'top-bottom');
  const [gameRatio, setGameRatio]       = useState<GameRatio>(saved?.gameRatio ?? '50-50');
  const [gamePosition, setGamePosition] = useState<GamePosition>(saved?.gamePosition ?? 'top');
  const [logo, setLogo] = useState<LogoOverlay | null>(saved?.logo ?? null);
  const [progress, setProgress]   = useState(0);
  const [generating, setGenerating] = useState(false);

  // Thumbnail state
  const [thumbnailMode, setThumbnailMode] = useState<'auto' | 'custom'>(saved?.thumbnailMode ?? 'auto');
  const [customThumbnailPath, setCustomThumbnailPath] = useState<string | null>(saved?.customThumbnailPath ?? null);
  const [thumbnailPreview, setThumbnailPreview] = useState<string | null>(null); // base64 or file path

  // Save settings to localStorage whenever they change
  useEffect(() => {
    const settings = {
      presetId, caption, zoomEnabled, trackingMode,
      layoutPreset, splitLayout, gameRatio, gamePosition,
      logo, thumbnailMode, customThumbnailPath,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch { /* ignore quota errors */ }
  }, [presetId, caption, zoomEnabled, trackingMode, layoutPreset, splitLayout, gameRatio, gamePosition, logo, thumbnailMode, customThumbnailPath]);

  // Live preview background frame (extracted from source video)
  const [liveFrameBase64, setLiveFrameBase64] = useState<string | null>(null);
  const [liveFrameLoading, setLiveFrameLoading] = useState(false);

  // Transcript editor state — null means use original words from DB
  const [editedTranscript, setEditedTranscript] = useState<string | null>(null);
  const [transcriptEditorOpen, setTranscriptEditorOpen] = useState(false);

  // Manual tracking state
  const [subjectPickerOpen, setSubjectPickerOpen] = useState(false);
  const [pickerFrame, setPickerFrame] = useState<string | null>(null);   // base64 JPEG
  const [pickerBoxes, setPickerBoxes] = useState<Array<{x:number;y:number;w:number;h:number}>>([]);
  const [pickerTimestampMs, setPickerTimestampMs] = useState<number>(hookStartMs ?? 0);
  const [selectedBbox, setSelectedBbox] = useState<{x:number;y:number;w:number;h:number} | null>(null);
  const [pickerLoading, setPickerLoading] = useState(false);
  const pickerImgRef = useRef<HTMLImageElement>(null);
  const [pickerImgSize, setPickerImgSize] = useState({ w: 1920, h: 1080 });

  // Measure container for live preview scaling
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ w: 180, h: 320 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setContainerSize({ w: Math.round(r.width), h: Math.round(r.height) });
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Sync zoom when clip changes
  useEffect(() => {
    if (clip) setZoomEnabled(clip.zoomEnabled);
  }, [clip?.id]);

  // Auto-extract frame from source video for live preview background
  useEffect(() => {
    if (!hookId || !hookStartMs || !clip?.projectId) {
      setLiveFrameBase64(null);
      return;
    }
    let cancelled = false;
    setLiveFrameLoading(true);
    // Extract frame at hook start + 1s (or start if too short)
    const frameTs = hookStartMs + 1000;
    ipc.tracking.extractFrame(clip.projectId, frameTs).then((data) => {
      if (!cancelled) {
        setLiveFrameBase64(data);
        setLiveFrameLoading(false);
      }
    }).catch(() => {
      if (!cancelled) setLiveFrameLoading(false);
    });
    return () => { cancelled = true; };
  }, [hookId, hookStartMs, clip?.projectId]);

  // Auto-generate thumbnail preview (frame at 1st second of clip)
  useEffect(() => {
    if (!hookId || !hookStartMs || !clip?.projectId) {
      setThumbnailPreview(null);
      return;
    }
    if (thumbnailMode === 'custom' && customThumbnailPath) return; // custom overrides
    let cancelled = false;
    // Extract frame at hook start (1st second = thumbnail)
    ipc.tracking.extractFrame(clip.projectId, hookStartMs).then((data) => {
      if (!cancelled && thumbnailMode === 'auto') {
        setThumbnailPreview(data);
      }
    }).catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, [hookId, hookStartMs, clip?.projectId, thumbnailMode, customThumbnailPath]);

  // Live clip progress events
  useIpcEvent<{ clipId: string; percent: number; eta: string }>(
    'clip:progress',
    (data) => {
      if (!clip || data.clipId !== clip.id) return;
      if (data.percent >= 0) setProgress(data.percent);
      if (data.percent >= 100) setGenerating(false);
      else if (data.percent > 0) setGenerating(true);
    },
    [clip?.id]
  );

  const isProcessing = generating || clip?.status === 'processing' || clip?.status === 'pending';

  // Build override words from edited transcript text.
  // Preserves original timing — only replaces word text.
  const buildOverrideWords = (): import('../../../shared/types').TranscriptWord[] | undefined => {
    if (editedTranscript === null || !words || !hookStartMs || !hookEndMs) return undefined;
    const clipWords = words.filter((w) => w.startMs >= hookStartMs && w.endMs <= hookEndMs);
    const editedTokens = editedTranscript.trim().split(/\s+/).filter(Boolean);
    if (editedTokens.length === 0) return undefined;
    // Map edited tokens onto original timing slots; pad/trim as needed
    return editedTokens.map((token, i) => {
      const orig = clipWords[i] ?? clipWords[clipWords.length - 1];
      return orig
        ? { ...orig, word: token }
        : { word: token, startMs: hookStartMs, endMs: hookEndMs, confidence: 1 };
    });
  };

  const applyPreset = (id: CaptionPresetId) => {
    if (id === 'custom') {
      // Custom = copy current caption as-is, just flip presetId to 'custom'
      // so user can tweak without losing the current preset's values
      setPresetId('custom');
      setCaption((prev) => ({ ...prev, presetId: 'custom' }));
    } else {
      setPresetId(id);
      setCaption({ ...CAPTION_PRESETS[id], presetId: id });
    }
  };

  const updateCaption = (patch: Partial<CaptionStyle>) => {
    setCaption((prev) => ({ ...prev, ...patch, presetId: 'custom' }));
    setPresetId('custom');
  };

  const regenerate = async (zoom: boolean, cap: CaptionStyle) => {
    if (!hookId) return;
    setGenerating(true);
    setProgress(0);
    try {
      await ipc.clips.generate(hookId, {
        subtitleStyle:    'bold-white',
        subtitlePosition: cap.position,
        zoomEnabled:      zoom,
        existingClipId:   clip?.id,
        captionStyle:     cap,
        logoOverlay:      logo ?? undefined,
        trackingMode:     zoom ? trackingMode : 'none',
        subjectBbox:      trackingMode === 'manual' && selectedBbox ? selectedBbox : undefined,
        subjectSeedMs:    trackingMode === 'manual' && selectedBbox ? pickerTimestampMs : undefined,
        layoutPreset,
        splitLayout:      layoutPreset === 'split' ? splitLayout : undefined,
        gameRatio:        layoutPreset === 'game'  ? gameRatio    : undefined,
        gamePosition:     layoutPreset === 'game'  ? gamePosition : undefined,
        overrideWords:    buildOverrideWords(),
        thumbnailPath:    thumbnailMode === 'custom' && customThumbnailPath ? customThumbnailPath : undefined,
      });
    } catch {
      setGenerating(false);
    }
  };

  // Open subject picker: extract frame + detect boxes
  const openSubjectPicker = async () => {
    if (!hookId) return;
    setSubjectPickerOpen(true);
    setPickerLoading(true);
    setPickerFrame(null);
    setPickerBoxes([]);
    const ts = pickerTimestampMs;
    // Need projectId — get from clip or hookId context via parent
    // We use hookStartMs as seed timestamp if available
    try {
      // Extract frame image
      // Note: we need projectId — stored on clip or passed via prop
      // For now use clip.projectId if available
      const projectId = clip?.projectId ?? '';
      if (!projectId) { setPickerLoading(false); return; }
      const [frameData, boxes] = await Promise.all([
        ipc.tracking.extractFrame(projectId, ts),
        ipc.tracking.detectBoxes(projectId, ts),
      ]);
      setPickerFrame(frameData);
      setPickerBoxes(boxes);
    } catch { /* ignore */ }
    setPickerLoading(false);
  };

  // Handle click on picker image to select subject by click position
  const handlePickerClick = (e: React.MouseEvent<HTMLImageElement>) => {
    const img = pickerImgRef.current;
    if (!img) return;
    const rect = img.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / rect.width;
    const relY = (e.clientY - rect.top)  / rect.height;
    const clickX = Math.round(relX * pickerImgSize.w);
    const clickY = Math.round(relY * pickerImgSize.h);

    // Find box that contains click, or create a default bbox around click
    const hit = pickerBoxes.find(
      (b) => clickX >= b.x && clickX <= b.x + b.w && clickY >= b.y && clickY <= b.y + b.h
    );
    if (hit) {
      setSelectedBbox(hit);
    } else {
      // No box hit — create 200×300 bbox centered on click
      const bw = Math.round(pickerImgSize.w * 0.15);
      const bh = Math.round(pickerImgSize.h * 0.25);
      setSelectedBbox({
        x: Math.max(0, clickX - bw / 2),
        y: Math.max(0, clickY - bh / 2),
        w: bw, h: bh,
      });
    }
  };

  return (
    <section aria-label="Clip preview" className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-text-secondary">Preview</h2>
      </div>

      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-3">
        {/* 9:16 video container */}
        <div className="mx-auto w-full max-w-[180px]">
          <div
            ref={containerRef}
            className="relative aspect-[9/16] w-full overflow-hidden rounded-lg bg-border"
          >
            {/* No hook */}
            {!hookId && (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                  className="text-text-secondary" aria-hidden="true">
                  <polygon points="5 3 19 12 5 21 5 3"/>
                </svg>
                <p className="text-xs text-text-secondary">Select a hook</p>
              </div>
            )}

            {/* Processing */}
            {hookId && isProcessing && (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-4">
                <span className="h-7 w-7 animate-spin rounded-full border-2 border-border border-t-accent" />
                <ProgressBar value={progress} className="w-full" />
                <p className="text-[10px] text-text-secondary">Processing…</p>
              </div>
            )}

            {/* No clip yet — show live preview with frame background */}
            {hookId && !isProcessing && !clip?.outputPath && (
              <div className="relative flex h-full items-center justify-center bg-zinc-900 overflow-hidden">
                {liveFrameLoading && (
                  <span className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-accent" />
                )}
                {!liveFrameLoading && liveFrameBase64 && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={liveFrameBase64}
                    alt=""
                    className="absolute inset-0 h-full w-full object-cover"
                    aria-hidden="true"
                  />
                )}
                {!liveFrameLoading && !liveFrameBase64 && (
                  <p className="text-[9px] text-zinc-500">Live preview</p>
                )}
              </div>
            )}

            {/* Clip ready — video + live preview overlay */}
            {hookId && !isProcessing && clip?.outputPath && (
              // eslint-disable-next-line jsx-a11y/media-has-caption
              <video
                src={`localfile:///${clip.outputPath.replace(/\\/g, '/')}`}
                controls loop playsInline
                className="h-full w-full object-cover"
                aria-label="Clip preview"
              />
            )}

            {/* Failed */}
            {hookId && !isProcessing && clip?.status === 'failed' && (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
                <p className="text-[10px] text-destructive">{clip.errorMessage ?? 'Failed'}</p>
              </div>
            )}

            {/* Live caption overlay — always shown when hook selected and not processing */}
            {hookId && !isProcessing && (
              <CaptionLivePreview
                caption={caption}
                containerWidth={containerSize.w}
                containerHeight={containerSize.h}
                words={words}
                startMs={hookStartMs}
                endMs={hookEndMs}
              />
            )}

            {/* Live logo overlay preview */}
            {hookId && !isProcessing && logo && (
              <LogoLivePreview
                logo={logo}
                containerWidth={containerSize.w}
                containerHeight={containerSize.h}
              />
            )}
          </div>
        </div>

        {hookId && (
          <>
            {/* Preset picker */}
            <div className="flex flex-col gap-1.5">
              <Label>Caption Style</Label>
              <div className="grid grid-cols-3 gap-1">
                {PRESET_OPTIONS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => applyPreset(p.id)}
                    title={p.description}
                    className={cn(
                      'rounded border px-1.5 py-1.5 text-center transition-micro',
                      'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                      presetId === p.id
                        ? 'border-accent bg-accent/10 text-accent'
                        : 'border-border text-text-secondary hover:border-accent/40 hover:text-text-primary'
                    )}
                  >
                    <span className="block text-[10px] font-semibold leading-tight">{p.label}</span>
                    <span className="block text-[8px] leading-tight opacity-60">{p.description}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Controls */}
            <div className="flex flex-col gap-2.5 rounded-md border border-border p-2.5">
              <div className="grid grid-cols-2 gap-2">
                <Select
                  label="Font"
                  value={caption.font}
                  onChange={(v) => updateCaption({ font: v as CaptionFont })}
                  options={FONT_OPTIONS.map((f) => ({ value: f, label: f }))}
                />
                <Select
                  label="Position"
                  value={caption.position}
                  onChange={(v) => updateCaption({ position: v as SubtitlePosition })}
                  options={POSITION_OPTIONS}
                />
              </div>

              <NumberInput
                label={`Font Size (${caption.fontSize}px)`}
                value={caption.fontSize}
                onChange={(v) => updateCaption({ fontSize: v })}
                min={40} max={120}
              />

              <div className="grid grid-cols-2 gap-2">
                <Select
                  label="Animation"
                  value={caption.animation}
                  onChange={(v) => updateCaption({ animation: v as CaptionAnimation })}
                  options={ANIMATION_OPTIONS}
                />
                <Select
                  label="Words/Line"
                  value={caption.lines}
                  onChange={(v) => updateCaption({ lines: Number(v) as CaptionLines })}
                  options={LINES_OPTIONS}
                />
              </div>

              <div className="grid grid-cols-3 gap-2">
                <ColorSwatch label="Text"      value={caption.primaryColor}   onChange={(v) => updateCaption({ primaryColor: v })} />
                <ColorSwatch label="Outline"   value={caption.outlineColor}   onChange={(v) => updateCaption({ outlineColor: v })} />
                <ColorSwatch label="Highlight" value={caption.highlightColor} onChange={(v) => updateCaption({ highlightColor: v })} />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <NumberInput label={`Outline (${caption.outlineSize}px)`} value={caption.outlineSize} onChange={(v) => updateCaption({ outlineSize: v })} min={0} max={12} />
                <NumberInput label={`Shadow (${caption.shadowSize}px)`}   value={caption.shadowSize}  onChange={(v) => updateCaption({ shadowSize: v })}  min={0} max={8}  />
              </div>

              <div className="flex items-center justify-between">
                <Label>Uppercase</Label>
                <button
                  type="button"
                  role="switch"
                  aria-checked={caption.uppercase}
                  onClick={() => updateCaption({ uppercase: !caption.uppercase })}
                  className={cn(
                    'relative h-4 w-8 rounded-full border transition-micro',
                    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                    caption.uppercase ? 'border-accent bg-accent' : 'border-border bg-border'
                  )}
                >
                  <span className={cn(
                    'absolute top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-micro',
                    caption.uppercase ? 'left-4' : 'left-0.5'
                  )} />
                </button>
              </div>

              <div className="flex items-center justify-between">
                <Label>Shake Effect</Label>
                <button
                  type="button"
                  role="switch"
                  aria-checked={caption.shakeEffect ?? true}
                  onClick={() => updateCaption({ shakeEffect: !(caption.shakeEffect ?? true) })}
                  className={cn(
                    'relative h-4 w-8 rounded-full border transition-micro',
                    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                    (caption.shakeEffect ?? true) ? 'border-accent bg-accent' : 'border-border bg-border'
                  )}
                >
                  <span className={cn(
                    'absolute top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-micro',
                    (caption.shakeEffect ?? true) ? 'left-4' : 'left-0.5'
                  )} />
                </button>
              </div>

              <div className="flex items-center justify-between">
                <Label>Karaoke Highlight</Label>
                <button
                  type="button"
                  role="switch"
                  aria-checked={caption.karaokeHighlight ?? false}
                  onClick={() => updateCaption({ karaokeHighlight: !(caption.karaokeHighlight ?? false) })}
                  className={cn(
                    'relative h-4 w-8 rounded-full border transition-micro',
                    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                    (caption.karaokeHighlight ?? false) ? 'border-accent bg-accent' : 'border-border bg-border'
                  )}
                >
                  <span className={cn(
                    'absolute top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-micro',
                    (caption.karaokeHighlight ?? false) ? 'left-4' : 'left-0.5'
                  )} />
                </button>
              </div>
            </div>

            {/* Subject Tracking */}
            <div className="flex flex-col gap-2 rounded-md border border-border p-2.5">
              <Label>Subject Tracking</Label>

              {/* Mode selector */}
              <div className="grid grid-cols-2 gap-1">
                {([
                  { mode: 'auto',    label: 'Auto',    desc: 'AI detects' },
                  { mode: 'speaker', label: 'Speaker', desc: 'Follow talker' },
                  { mode: 'manual',  label: 'Manual',  desc: 'You pick' },
                  { mode: 'none',    label: 'None',    desc: 'Center crop' },
                ] as const).map(({ mode, label, desc }) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => {
                      setTrackingMode(mode);
                      if (mode !== 'manual') setSelectedBbox(null);
                    }}
                    className={cn(
                      'rounded border px-1.5 py-1.5 text-center transition-micro',
                      'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                      trackingMode === mode
                        ? 'border-accent bg-accent/10 text-accent'
                        : 'border-border text-text-secondary hover:border-accent/40 hover:text-text-primary'
                    )}
                  >
                    <span className="block text-[10px] font-semibold leading-tight">{label}</span>
                    <span className="block text-[8px] leading-tight opacity-60">{desc}</span>
                  </button>
                ))}
              </div>

              {/* Speaker mode info */}
              {trackingMode === 'speaker' && (
                <p className="text-[10px] text-text-secondary">
                  Detects who is speaking each moment and follows their face. Works best with 1–2 speakers.
                </p>
              )}

              {/* Auto mode: zoom toggle */}
              {trackingMode === 'auto' && (
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-text-secondary">Face/body tracking</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={zoomEnabled}
                    id="auto-zoom-toggle"
                    onClick={() => setZoomEnabled((z) => !z)}
                    className={cn(
                      'relative h-4 w-8 rounded-full border transition-micro',
                      'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                      zoomEnabled ? 'border-accent bg-accent' : 'border-border bg-border'
                    )}
                  >
                    <span className={cn(
                      'absolute top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-micro',
                      zoomEnabled ? 'left-4' : 'left-0.5'
                    )} />
                  </button>
                </div>
              )}

              {/* Manual mode: subject picker */}
              {trackingMode === 'manual' && (
                <div className="flex flex-col gap-2">
                  {selectedBbox ? (
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] text-success">✓ Subject selected</span>
                      <button
                        type="button"
                        onClick={() => { setSelectedBbox(null); setSubjectPickerOpen(false); }}
                        className="text-[10px] text-text-secondary hover:text-destructive"
                      >
                        Clear
                      </button>
                    </div>
                  ) : (
                    <p className="text-[10px] text-text-secondary">No subject selected. Pick one below.</p>
                  )}
                  <button
                    type="button"
                    onClick={() => void openSubjectPicker()}
                    className={cn(
                      'rounded border border-border px-2 py-1.5 text-[10px] text-text-secondary',
                      'hover:border-accent/40 hover:text-text-primary transition-micro'
                    )}
                  >
                    {selectedBbox ? '↺ Change Subject' : '🎯 Pick Subject'}
                  </button>
                </div>
              )}
            </div>

            {/* Subject Picker Modal */}
            {subjectPickerOpen && trackingMode === 'manual' && (
              <div
                role="dialog"
                aria-modal="true"
                aria-label="Pick subject to track"
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
                onClick={(e) => { if (e.target === e.currentTarget) setSubjectPickerOpen(false); }}
              >
                <div className="flex w-full max-w-2xl flex-col gap-4 rounded-xl border border-border bg-surface p-5 shadow-2xl">
                  <div className="flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-text-primary">Pick Subject to Track</h2>
                    <button
                      type="button"
                      aria-label="Close"
                      onClick={() => setSubjectPickerOpen(false)}
                      className="text-text-secondary hover:text-text-primary"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                      </svg>
                    </button>
                  </div>

                  <p className="text-[11px] text-text-secondary">
                    Click on the subject you want to track. Detected subjects are highlighted with boxes.
                    Click anywhere to create a custom selection.
                  </p>

                  {/* Timestamp scrubber */}
                  <div className="flex flex-col gap-1">
                    <Label>Frame timestamp: {Math.round(pickerTimestampMs / 1000)}s</Label>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min={hookStartMs ?? 0}
                        max={hookEndMs ?? 60000}
                        step={500}
                        value={pickerTimestampMs}
                        onChange={(e) => setPickerTimestampMs(Number(e.target.value))}
                        className="flex-1 accent-accent"
                        aria-label="Frame timestamp"
                      />
                      <button
                        type="button"
                        onClick={() => void openSubjectPicker()}
                        className={cn(
                          'rounded border border-border px-2 py-1 text-[10px] text-text-secondary',
                          'hover:border-accent/40 hover:text-text-primary transition-micro'
                        )}
                      >
                        Load Frame
                      </button>
                    </div>
                  </div>

                  {/* Frame display */}
                  <div className="relative overflow-hidden rounded-md bg-zinc-900" style={{ minHeight: 200 }}>
                    {pickerLoading && (
                      <div className="flex h-48 items-center justify-center">
                        <span className="h-6 w-6 animate-spin rounded-full border-2 border-border border-t-accent" />
                      </div>
                    )}
                    {!pickerLoading && !pickerFrame && (
                      <div className="flex h-48 items-center justify-center">
                        <p className="text-xs text-text-secondary">Click "Load Frame" to extract a frame</p>
                      </div>
                    )}
                    {!pickerLoading && pickerFrame && (
                      <div className="relative inline-block w-full">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          ref={pickerImgRef}
                          src={pickerFrame}
                          alt="Frame for subject selection"
                          className="w-full cursor-crosshair rounded-md"
                          onClick={handlePickerClick}
                          onLoad={(e) => {
                            const img = e.currentTarget;
                            setPickerImgSize({ w: img.naturalWidth, h: img.naturalHeight });
                          }}
                        />
                        {/* Draw detected boxes */}
                        {pickerBoxes.map((box, i) => {
                          const img = pickerImgRef.current;
                          if (!img) return null;
                          const scaleX = img.clientWidth  / pickerImgSize.w;
                          const scaleY = img.clientHeight / pickerImgSize.h;
                          const isSelected = selectedBbox &&
                            selectedBbox.x === box.x && selectedBbox.y === box.y;
                          return (
                            <div
                              key={i}
                              onClick={(e) => { e.stopPropagation(); setSelectedBbox(box); }}
                              style={{
                                position: 'absolute',
                                left:   box.x * scaleX,
                                top:    box.y * scaleY,
                                width:  box.w * scaleX,
                                height: box.h * scaleY,
                                border: `2px solid ${isSelected ? '#22c55e' : '#f59e0b'}`,
                                cursor: 'pointer',
                                boxSizing: 'border-box',
                              }}
                            />
                          );
                        })}
                        {/* Draw custom selected bbox if not from detected boxes */}
                        {selectedBbox && !pickerBoxes.some(
                          (b) => b.x === selectedBbox.x && b.y === selectedBbox.y
                        ) && (() => {
                          const img = pickerImgRef.current;
                          if (!img) return null;
                          const scaleX = img.clientWidth  / pickerImgSize.w;
                          const scaleY = img.clientHeight / pickerImgSize.h;
                          return (
                            <div style={{
                              position: 'absolute',
                              left:   selectedBbox.x * scaleX,
                              top:    selectedBbox.y * scaleY,
                              width:  selectedBbox.w * scaleX,
                              height: selectedBbox.h * scaleY,
                              border: '2px solid #22c55e',
                              boxSizing: 'border-box',
                            }} />
                          );
                        })()}
                      </div>
                    )}
                  </div>

                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setSubjectPickerOpen(false)}
                      className={cn(
                        'rounded-md border border-border px-4 py-2 text-xs text-text-secondary',
                        'hover:border-accent/40 hover:text-text-primary transition-micro'
                      )}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={!selectedBbox}
                      onClick={() => setSubjectPickerOpen(false)}
                      className={cn(
                        'rounded-md bg-accent px-4 py-2 text-xs font-semibold text-accent-foreground',
                        'hover:bg-accent-hover transition-micro',
                        'disabled:opacity-40 disabled:cursor-not-allowed'
                      )}
                    >
                      Confirm Subject
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Layout Preset */}
            <div className="flex flex-col gap-2 rounded-md border border-border p-2.5">
              <Label>Layout Preset</Label>

              <div className="grid grid-cols-3 gap-1">
                {([
                  { preset: 'normal' as LayoutPreset, label: 'Normal',  desc: 'Standard crop' },
                  { preset: 'split'  as LayoutPreset, label: 'Split',   desc: 'Multi-speaker' },
                  { preset: 'game'   as LayoutPreset, label: 'Game',    desc: 'Gameplay+cam' },
                ] as const).map(({ preset, label, desc }) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setLayoutPreset(preset)}
                    className={cn(
                      'rounded border px-1.5 py-1.5 text-center transition-micro',
                      'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                      layoutPreset === preset
                        ? 'border-accent bg-accent/10 text-accent'
                        : 'border-border text-text-secondary hover:border-accent/40 hover:text-text-primary'
                    )}
                  >
                    <span className="block text-[10px] font-semibold leading-tight">{label}</span>
                    <span className="block text-[8px] leading-tight opacity-60">{desc}</span>
                  </button>
                ))}
              </div>

              {/* Normal description */}
              {layoutPreset === 'normal' && (
                <p className="text-[10px] text-text-secondary">
                  Standard 9:16 crop with subject tracking. Best for single-speaker videos.
                </p>
              )}

              {/* Split: layout direction picker */}
              {layoutPreset === 'split' && (
                <div className="flex flex-col gap-1.5">
                  <p className="text-[10px] text-text-secondary">
                    Splits screen for 2+ speakers. Each speaker gets their own panel.
                  </p>
                  <Label>Split Direction</Label>
                  <div className="grid grid-cols-3 gap-1">
                    {([
                      { layout: 'top-bottom' as SplitLayout, label: 'Top/Bot', icon: '⬆⬇' },
                      { layout: 'left-right' as SplitLayout, label: 'L/R',     icon: '⬅➡' },
                      { layout: 'quad'       as SplitLayout, label: '2×2',     icon: '⊞'  },
                    ] as const).map(({ layout, label, icon }) => (
                      <button
                        key={layout}
                        type="button"
                        onClick={() => setSplitLayout(layout)}
                        className={cn(
                          'rounded border px-1.5 py-1.5 text-center transition-micro',
                          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                          splitLayout === layout
                            ? 'border-accent bg-accent/10 text-accent'
                            : 'border-border text-text-secondary hover:border-accent/40 hover:text-text-primary'
                        )}
                      >
                        <span className="block text-[11px] leading-tight">{icon}</span>
                        <span className="block text-[8px] leading-tight opacity-60">{label}</span>
                      </button>
                    ))}
                  </div>
                  <p className="text-[9px] text-text-secondary opacity-70">
                    {splitLayout === 'top-bottom' && 'Speaker A top half · Speaker B bottom half'}
                    {splitLayout === 'left-right' && 'Speaker A left · Speaker B right'}
                    {splitLayout === 'quad'       && '4-panel grid for 3–4 speakers'}
                  </p>
                </div>
              )}

              {/* Game: PiP size picker */}
              {layoutPreset === 'game' && (
                <div className="flex flex-col gap-1.5">
                  <p className="text-[10px] text-text-secondary">
                    Streamer fills the full screen (face-tracked). Gameplay overlays at selected position.
                  </p>
                  <Label>Gameplay Height</Label>
                  <div className="grid grid-cols-2 gap-1">
                    {([
                      { ratio: '50-50' as GameRatio, label: '50%',  desc: 'Half screen' },
                      { ratio: '70-30' as GameRatio, label: '70%',  desc: 'Larger gameplay' },
                    ] as const).map(({ ratio, label, desc }) => (
                      <button
                        key={ratio}
                        type="button"
                        onClick={() => setGameRatio(ratio)}
                        className={cn(
                          'rounded border px-1.5 py-1.5 text-center transition-micro',
                          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                          gameRatio === ratio
                            ? 'border-accent bg-accent/10 text-accent'
                            : 'border-border text-text-secondary hover:border-accent/40 hover:text-text-primary'
                        )}
                      >
                        <span className="block text-[11px] font-medium leading-tight">{label}</span>
                        <span className="block text-[8px] leading-tight opacity-60">{desc}</span>
                      </button>
                    ))}
                  </div>
                  <p className="text-[9px] text-text-secondary opacity-70">
                    {gameRatio === '50-50' && gamePosition === 'top' && 'Gameplay · 1080×960 px · top of screen'}
                    {gameRatio === '50-50' && gamePosition === 'bottom' && 'Gameplay · 1080×960 px · bottom of screen'}
                    {gameRatio === '70-30' && gamePosition === 'top' && 'Gameplay · 1080×1344 px · top of screen'}
                    {gameRatio === '70-30' && gamePosition === 'bottom' && 'Gameplay · 1080×1344 px · bottom of screen'}
                  </p>
                  <Label>Gameplay Position</Label>
                  <div className="grid grid-cols-2 gap-1">
                    {([
                      { pos: 'top' as GamePosition, label: 'Top', desc: 'Gameplay on top' },
                      { pos: 'bottom' as GamePosition, label: 'Bottom', desc: 'Gameplay on bottom' },
                    ] as const).map(({ pos, label, desc }) => (
                      <button
                        key={pos}
                        type="button"
                        onClick={() => setGamePosition(pos)}
                        className={cn(
                          'rounded border px-1.5 py-1.5 text-center transition-micro',
                          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                          gamePosition === pos
                            ? 'border-accent bg-accent/10 text-accent'
                            : 'border-border text-text-secondary hover:border-accent/40 hover:text-text-primary'
                        )}
                      >
                        <span className="block text-[11px] font-medium leading-tight">{label}</span>
                        <span className="block text-[8px] leading-tight opacity-60">{desc}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Logo Overlay */}
            <div className="flex flex-col gap-2 rounded-md border border-border p-2.5">
              <div className="flex items-center justify-between">
                <Label>Logo Watermark</Label>
                <div className="flex items-center gap-1.5">
                  {logo && (
                    <button
                      type="button"
                      aria-label="Remove logo"
                      onClick={() => setLogo(null)}
                      className="text-[10px] text-destructive hover:underline"
                    >
                      Remove
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={async () => {
                      const filePath = await ipc.dialog.openFile();
                      if (!filePath) return;
                      setLogo((prev) => ({
                        filePath,
                        position:  prev?.position  ?? 'top-right',
                        opacity:   prev?.opacity   ?? 0.8,
                        scale:     prev?.scale     ?? 0.15,
                        margin:    prev?.margin    ?? 40,
                      }));
                    }}
                    className={cn(
                      'rounded border border-border px-2 py-0.5 text-[10px] text-text-secondary',
                      'hover:border-accent/40 hover:text-text-primary transition-micro'
                    )}
                  >
                    {logo ? '↺ Change' : '+ Pick Image'}
                  </button>
                </div>
              </div>

              {logo && (
                <>
                  <p className="truncate text-[9px] text-text-secondary font-mono">
                    {logo.filePath.split(/[\\/]/).pop()}
                  </p>
                  <Select<LogoPosition>
                    label="Position"
                    value={logo.position}
                    onChange={(v) => setLogo((l) => l ? { ...l, position: v } : l)}
                    options={[
                      { value: 'top-left',     label: 'Top Left'     },
                      { value: 'top-right',    label: 'Top Right'    },
                      { value: 'bottom-left',  label: 'Bottom Left'  },
                      { value: 'bottom-right', label: 'Bottom Right' },
                      { value: 'center',       label: 'Center'       },
                    ]}
                  />
                  <NumberInput
                    label={`Opacity (${Math.round((logo.opacity) * 100)}%)`}
                    value={Math.round(logo.opacity * 100)}
                    onChange={(v) => setLogo((l) => l ? { ...l, opacity: v / 100 } : l)}
                    min={10} max={100}
                  />
                  <NumberInput
                    label={`Size (${Math.round(logo.scale * 100)}% width)`}
                    value={Math.round(logo.scale * 100)}
                    onChange={(v) => setLogo((l) => l ? { ...l, scale: v / 100 } : l)}
                    min={5} max={50}
                  />
                  <NumberInput
                    label={`Margin (${logo.margin}px)`}
                    value={logo.margin}
                    onChange={(v) => setLogo((l) => l ? { ...l, margin: v } : l)}
                    min={0} max={200}
                  />
                </>
              )}
            </div>

            {/* Transcript Editor */}
            <div className="flex flex-col gap-1.5 rounded-md border border-border p-2.5">
              <div className="flex items-center justify-between">
                <Label>Caption Text</Label>
                <div className="flex items-center gap-1.5">
                  {editedTranscript !== null && (
                    <button
                      type="button"
                      onClick={() => setEditedTranscript(null)}
                      className="text-[10px] text-destructive hover:underline"
                    >
                      Reset
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      if (!transcriptEditorOpen) {
                        // Open editor — populate with current words if not yet edited
                        if (editedTranscript === null && words && hookStartMs !== undefined && hookEndMs !== undefined) {
                          const clipWords = words
                            .filter((w) => w.startMs >= hookStartMs && w.endMs <= hookEndMs)
                            .map((w) => w.word.trim())
                            .join(' ');
                          setEditedTranscript(clipWords);
                        }
                      }
                      setTranscriptEditorOpen((v) => !v);
                    }}
                    className={cn(
                      'rounded border px-2 py-0.5 text-[10px] transition-micro',
                      transcriptEditorOpen
                        ? 'border-accent bg-accent/10 text-accent'
                        : 'border-border text-text-secondary hover:border-accent/40 hover:text-text-primary'
                    )}
                  >
                    {transcriptEditorOpen ? 'Done' : 'Edit'}
                  </button>
                </div>
              </div>

              {transcriptEditorOpen && (
                <div className="flex flex-col gap-1">
                  <textarea
                    value={editedTranscript ?? ''}
                    onChange={(e) => setEditedTranscript(e.target.value)}
                    rows={5}
                    spellCheck
                    placeholder="Edit caption text here…"
                    className={cn(
                      'w-full resize-y rounded border border-border bg-surface px-2 py-1.5',
                      'text-[11px] leading-relaxed text-text-primary',
                      'focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent',
                      'placeholder:text-text-secondary'
                    )}
                  />
                  <p className="text-[9px] text-text-secondary opacity-70">
                    {editedTranscript !== null
                      ? `${editedTranscript.trim().split(/\s+/).filter(Boolean).length} words · timing preserved from original`
                      : 'Using original transcript'}
                  </p>
                </div>
              )}

              {!transcriptEditorOpen && editedTranscript !== null && (
                <p className="text-[9px] text-accent">
                  ✎ Custom text active — {editedTranscript.trim().split(/\s+/).filter(Boolean).length} words
                </p>
              )}
            </div>

            {/* Thumbnail */}
            <div className="flex flex-col gap-2 rounded-md border border-border p-2.5">
              <div className="flex items-center justify-between">
                <Label>Thumbnail (1st second)</Label>
                {thumbnailMode === 'custom' && customThumbnailPath && (
                  <button
                    type="button"
                    onClick={() => {
                      setThumbnailMode('auto');
                      setCustomThumbnailPath(null);
                      setThumbnailPreview(null);
                    }}
                    className="text-[10px] text-destructive hover:underline"
                  >
                    Reset
                  </button>
                )}
              </div>

              {/* Thumbnail preview */}
              <div className="relative mx-auto w-full max-w-[140px] aspect-[9/16] overflow-hidden rounded-md bg-zinc-900 border border-border">
                {thumbnailPreview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={thumbnailMode === 'custom' && customThumbnailPath
                      ? `localfile:///${customThumbnailPath.replace(/\\/g, '/')}`
                      : thumbnailPreview}
                    alt="Thumbnail preview"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center">
                    <p className="text-[9px] text-zinc-500">No thumbnail</p>
                  </div>
                )}
                {/* Caption overlay on thumbnail */}
                {thumbnailPreview && (
                  <CaptionLivePreview
                    caption={caption}
                    containerWidth={140}
                    containerHeight={249}
                    words={words}
                    startMs={hookStartMs}
                    endMs={hookStartMs ? hookStartMs + 2000 : undefined}
                  />
                )}
                {/* Logo overlay on thumbnail */}
                {thumbnailPreview && logo && (
                  <LogoLivePreview
                    logo={logo}
                    containerWidth={140}
                    containerHeight={249}
                  />
                )}
              </div>

              {/* Mode selector */}
              <div className="grid grid-cols-2 gap-1">
                <button
                  type="button"
                  onClick={() => setThumbnailMode('auto')}
                  className={cn(
                    'rounded border px-1.5 py-1.5 text-center transition-micro',
                    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                    thumbnailMode === 'auto'
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-border text-text-secondary hover:border-accent/40 hover:text-text-primary'
                  )}
                >
                  <span className="block text-[10px] font-semibold leading-tight">Auto</span>
                  <span className="block text-[8px] leading-tight opacity-60">1st second frame</span>
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    const filePath = await ipc.dialog.openFile();
                    if (!filePath) return;
                    setThumbnailMode('custom');
                    setCustomThumbnailPath(filePath);
                    setThumbnailPreview(filePath); // will use localfile:// protocol
                  }}
                  className={cn(
                    'rounded border px-1.5 py-1.5 text-center transition-micro',
                    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                    thumbnailMode === 'custom'
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-border text-text-secondary hover:border-accent/40 hover:text-text-primary'
                  )}
                >
                  <span className="block text-[10px] font-semibold leading-tight">Custom</span>
                  <span className="block text-[8px] leading-tight opacity-60">Upload image</span>
                </button>
              </div>

              {thumbnailMode === 'custom' && customThumbnailPath && (
                <p className="truncate text-[9px] text-text-secondary font-mono">
                  {customThumbnailPath.split(/[\\/]/).pop()}
                </p>
              )}
            </div>

            {/* Generate */}
            <button
              type="button"
              disabled={isProcessing || (trackingMode === 'manual' && !selectedBbox)}
              onClick={() => void regenerate(trackingMode !== 'none', caption)}
              title={trackingMode === 'manual' && !selectedBbox ? 'Pick a subject first' : undefined}
              className={cn(
                'w-full rounded-md bg-accent py-2 text-xs font-semibold text-accent-foreground',
                'hover:bg-accent-hover transition-micro',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                'disabled:opacity-40 disabled:cursor-not-allowed'
              )}
            >
              {isProcessing ? 'Processing…' : 'Generate Clip'}
            </button>
          </>
        )}
      </div>
    </section>
  );
}
