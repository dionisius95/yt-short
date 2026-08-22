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
  type LetterboxBackground,
  type LetterboxBgType,
  type LetterboxCrop,
  type TitleOverlay,
} from '../../../shared/types';
import { cn } from '../../lib/utils';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PRESET_OPTIONS: { id: CaptionPresetId; label: string; description: string }[] = [
  { id: 'none',       label: 'None (Hidden)', description: 'Do not show captions on screen' },
  { id: 'karaoke',    label: 'Karaoke',    description: 'Word-by-word highlight' },
  { id: 'simple',     label: 'Simple',     description: 'Clean white text' },
  { id: 'thinkmedia', label: 'ThinkMedia', description: 'Yellow bold uppercase' },
  { id: 'hormozi',    label: 'Hormozi',    description: 'Large centered impact' },
  { id: 'reels',      label: 'Reels',      description: 'Multi-line cyan accent' },
  { id: 'tiktok',     label: 'TikTok Pop',  description: 'Lilita One bold pop' },
  { id: 'bangers',    label: 'Bangers Out', description: 'Comic style heavy border' },
  { id: 'custom',     label: 'Custom',     description: 'Your own settings' },
];

const FONT_OPTIONS: CaptionFont[] = [
  'Arial',
  'Impact',
  'Montserrat',
  'Oswald',
  'Roboto',
  'Anton',
  'Lilita One',
  'Bangers',
  'Bebas Neue',
  'Fredoka One',
  'System'
];

export function getFontFamily(font: CaptionFont | string): string {
  if (font === 'System' || font === 'system') {
    return 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  }
  return font;
}
const ANIMATION_OPTIONS: { value: CaptionAnimation; label: string }[] = [
  { value: 'none',     label: 'None'     },
  { value: 'fade',     label: 'Fade'     },
  { value: 'pop',      label: 'Pop'      },
  { value: 'slide-up', label: 'Slide Up' },
];
export const POSITION_OPTIONS: { value: SubtitlePosition; label: string }[] = [
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
  captionY,
}: {
  caption: CaptionStyle;
  containerWidth: number;
  containerHeight: number;
  words?: import('../../../shared/types').TranscriptWord[];
  startMs?: number;
  endMs?: number;
  captionY?: number | null;
}) {
  if (caption.presetId === 'none') {
    return null;
  }

  const scaleX = containerWidth  / CANVAS_W;
  const scaleY = containerHeight / CANVAS_H;
  const scale  = Math.min(scaleX, scaleY);

  // ASS font size is measured in em-units by libass, which renders ~37% larger
  // than CSS px font-size (CSS uses cap-height, ASS uses em-height).
  // Multiply by 0.73 to match visual size of generated video.
  const scaledFontSize = Math.round(caption.fontSize * scale * 0.73);
  const scaledOutline  = Math.max(1, Math.round(caption.outlineSize * scale));
  const scaledShadow   = Math.max(0, Math.round(caption.shadowSize  * scale));
  // MarginV=120 in ASS canvas space → scale to container
  const scaledMarginV  = Math.round(120 * scaleY);

  // captionY is in ASS canvas space (0=top, 1920=bottom), anchor = bottom of text (an2).
  // CSS `bottom` = distance from bottom of container = containerH - captionY*scaleY
  const positionStyle: React.CSSProperties = captionY != null
    ? {
        bottom: containerHeight - Math.round(captionY * scaleY),
        left: 0, right: 0, textAlign: 'center',
      }
    : caption.position === 'lower-third'
      ? { bottom: scaledMarginV, left: 0, right: 0, textAlign: 'center' }
      : caption.position === 'upper-third'
      ? { top: scaledMarginV, left: 0, right: 0, textAlign: 'center' }
      : { top: '50%', left: 0, right: 0, textAlign: 'center', transform: 'translateY(-50%)' };
  let displayGroups: string[][];
  if (words && words.length > 0 && startMs !== undefined && endMs !== undefined) {
    const clipWords = words
      .filter((w) => w.startMs >= startMs && w.endMs <= endMs)
      .map((w) => style_uppercase(w.word.trim(), caption.uppercase));
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

  const isShake = caption.shakeEffect ?? true;

  const animClass =
    caption.animation === 'fade'     ? 'animate-fade-in' :
    caption.animation === 'pop'      ? (!isShake ? 'animate-bounce' : '') :
    caption.animation === 'slide-up' ? 'animate-slide-up-caption' :
    '';

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className={cn('absolute px-2', animClass)} style={positionStyle}>
        {displayGroups.map((group, gi) => (
          <div key={gi} className="leading-tight">
            {caption.karaokeHighlight || caption.presetId === 'karaoke' || caption.presetId === 'tiktok' ? (
              <span>
                {group.map((word, wi) => {
                  const isHighlighted = wi === 0;
                  return (
                    <span
                      key={wi}
                      className={cn('inline-block', isHighlighted && isShake && 'animate-caption-shake')}
                      style={{
                        fontFamily:  getFontFamily(caption.font),
                        fontSize:    scaledFontSize,
                        fontWeight:  caption.bold ? 'bold' : 'normal',
                        color:       isHighlighted ? caption.highlightColor : caption.primaryColor,
                        textShadow,
                        marginRight: wi < group.length - 1 ? `${Math.round(4 * scale)}px` : 0,
                      }}
                    >
                      {word}
                    </span>
                  );
                })}
              </span>
            ) : (
              <span
                className={cn('inline-block', isShake && 'animate-caption-shake')}
                style={{
                  fontFamily: getFontFamily(caption.font),
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

  if (logo.y !== undefined) {
    posStyle.top = Math.round(logo.y * scaleY);
    if (logo.x !== undefined) {
      posStyle.left = Math.round(logo.x * scaleX);
    } else {
      if (logo.position.includes('left')) posStyle.left = margin;
      else if (logo.position.includes('right')) posStyle.right = margin;
      else { posStyle.left = '50%'; posStyle.transform = 'translateX(-50%)'; }
    }
  } else {
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
// Title live preview overlay
// ---------------------------------------------------------------------------

function TitleLivePreview({
  titleOverlay,
  containerWidth,
  containerHeight,
}: {
  titleOverlay: TitleOverlay;
  containerWidth: number;
  containerHeight: number;
}) {
  if (!titleOverlay || !titleOverlay.text.trim()) return null;

  const scaleX = containerWidth  / CANVAS_W;
  const scaleY = containerHeight / CANVAS_H;
  const scale  = Math.min(scaleX, scaleY);

  const scaledFontSize = Math.round(titleOverlay.fontSize * scale * 0.73);
  const scaledOutline  = Math.max(0, Math.round(titleOverlay.outlineSize * scale));
  const outlineColor   = titleOverlay.outlineColor;

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
      ].join(', ')
    : undefined;

  const text = titleOverlay.uppercase ? titleOverlay.text.toUpperCase() : titleOverlay.text;
  const topPx = Math.round(titleOverlay.y * scaleY);

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <div
        className="absolute left-0 right-0 px-4 text-center leading-tight whitespace-pre-wrap"
        style={{
          top: topPx,
          transform: 'translateY(-100%)', // ASS \an2 anchor (bottom-center)
          fontFamily: getFontFamily(titleOverlay.font),
          fontSize: scaledFontSize,
          fontWeight: titleOverlay.bold ? 'bold' : 'normal',
          color: titleOverlay.color,
          textShadow,
        }}
      >
        {text}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// YouTube Shorts frame overlay
// ---------------------------------------------------------------------------

function YouTubeShortsOverlay({ showSafeZone }: { showSafeZone: boolean }) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-30 flex flex-col justify-between p-2 select-none overflow-hidden"
    >
      {/* Safe Zone Grid Guide Overlay */}
      {showSafeZone && (
        <>
          {/* Top Unsafe Zone (Search / Top UI) */}
          <div className="absolute top-0 left-0 right-0 h-[10%] bg-red-500/20 border-b border-dashed border-red-400 flex items-center justify-center">
            <span className="text-[8px] font-mono text-red-200 font-bold bg-black/70 px-1 py-0.5 rounded backdrop-blur-xs">
              Top UI Safe Margin (10%)
            </span>
          </div>

          {/* Right Unsafe Zone (Actions Column) */}
          <div className="absolute top-[10%] right-0 bottom-[22%] w-[18%] bg-red-500/20 border-l border-dashed border-red-400 flex items-center justify-center">
            <span className="text-[7px] font-mono text-red-200 font-bold bg-black/70 px-1 py-0.5 rounded rotate-90 whitespace-nowrap backdrop-blur-xs">
              Action Buttons (18%)
            </span>
          </div>

          {/* Bottom Unsafe Zone (Title & Channel) */}
          <div className="absolute bottom-0 left-0 right-0 h-[22%] bg-red-500/20 border-t border-dashed border-red-400 flex items-center justify-center">
            <span className="text-[8px] font-mono text-red-200 font-bold bg-black/70 px-1 py-0.5 rounded backdrop-blur-xs">
              Title & Channel Overlay (22%)
            </span>
          </div>

          {/* Inner Safe Content Zone Line */}
          <div className="absolute top-[10%] left-0 right-[18%] bottom-[22%] border-2 border-dashed border-emerald-400/80 rounded pointer-events-none">
            <span className="absolute top-1 left-1 text-[7px] font-mono font-bold text-emerald-300 bg-black/80 px-1 py-0.5 rounded backdrop-blur-xs">
              ✅ SAFE CONTENT AREA
            </span>
          </div>
        </>
      )}

      {/* Top Header Bar */}
      <div className="relative z-10 flex items-center justify-between text-white drop-shadow-md pt-0.5 px-0.5">
        <div className="flex items-center gap-1">
          <svg className="w-3.5 h-3.5 text-red-600 fill-current" viewBox="0 0 24 24">
            <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
          </svg>
          <span className="text-[10px] font-bold tracking-tight text-white drop-shadow">Shorts</span>
        </div>
        <div className="flex items-center gap-2 text-white/90">
          <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>
          </svg>
          <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
            <circle cx="12" cy="13" r="4"/>
          </svg>
          <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
            <circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/>
          </svg>
        </div>
      </div>

      {/* Main Content Overlay: Right Action Bar & Bottom Info */}
      <div className="relative z-10 flex items-end justify-between pb-0.5 px-0.5">
        {/* Bottom Left Info */}
        <div className="flex flex-col gap-1 max-w-[76%] drop-shadow-md">
          {/* Channel Avatar & Subscribe */}
          <div className="flex items-center gap-1">
            <div className="w-4 h-4 rounded-full bg-red-600 flex items-center justify-center text-[8px] font-bold text-white border border-white/40 shrink-0">
              YT
            </div>
            <span className="text-[9px] font-bold text-white drop-shadow truncate">@channel</span>
            <span className="bg-white text-black text-[7px] font-bold px-1.5 py-0.5 rounded-full shadow shrink-0">
              Subscribe
            </span>
          </div>

          {/* Video Title / Caption */}
          <p className="text-[8px] text-white/95 line-clamp-2 leading-tight drop-shadow font-medium">
            YouTube Shorts Live Preview Border #shorts
          </p>

          {/* Sound / Music track */}
          <div className="flex items-center gap-1 text-[7px] text-white/80">
            <svg className="w-2 h-2 animate-pulse" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
            </svg>
            <span className="truncate max-w-[100px]">Suara asli - Channel</span>
          </div>
        </div>

        {/* Right Action Icons Column */}
        <div className="flex flex-col items-center gap-2 text-white drop-shadow-md pb-0.5">
          {/* Like */}
          <div className="flex flex-col items-center gap-0.5">
            <div className="w-5.5 h-5.5 rounded-full bg-black/40 backdrop-blur-xs flex items-center justify-center text-white">
              <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                <path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.58 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"/>
              </svg>
            </div>
            <span className="text-[7px] font-semibold">12K</span>
          </div>

          {/* Dislike */}
          <div className="flex flex-col items-center gap-0.5">
            <div className="w-5.5 h-5.5 rounded-full bg-black/40 backdrop-blur-xs flex items-center justify-center text-white">
              <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                <path d="M15 3H6c-.83 0-1.54.5-1.84 1.22l-3.02 7.05c-.09.23-.14.47-.14.73v2c0 1.1.9 2 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L9.83 23l6.59-6.59c.36-.36.58-.86.58-1.41V5c0-1.1-.9-2-2-2zm4 0v12h4V3h-4z"/>
              </svg>
            </div>
            <span className="text-[7px] font-semibold">Dislike</span>
          </div>

          {/* Comments */}
          <div className="flex flex-col items-center gap-0.5">
            <div className="w-5.5 h-5.5 rounded-full bg-black/40 backdrop-blur-xs flex items-center justify-center text-white">
              <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                <path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z"/>
              </svg>
            </div>
            <span className="text-[7px] font-semibold">348</span>
          </div>

          {/* Share */}
          <div className="flex flex-col items-center gap-0.5">
            <div className="w-5.5 h-5.5 rounded-full bg-black/40 backdrop-blur-xs flex items-center justify-center text-white">
              <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                <path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92c0-1.61-1.31-2.92-2.92-2.92z"/>
              </svg>
            </div>
            <span className="text-[7px] font-semibold">Share</span>
          </div>

          {/* Sound Disc */}
          <div className="w-5 h-5 rounded-full border border-white/60 overflow-hidden bg-zinc-800 animate-spin flex items-center justify-center shrink-0">
            <div className="w-1.5 h-1.5 rounded-full bg-white/80" />
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ClipPreviewPanelProps {
  clip: Clip | null;
  hookId: string | null;
  /** Project ID — needed for frame extraction even before a clip exists. */
  projectId: string;
  defaultSettings: Pick<AppSettings, 'defaultSubtitleStyle' | 'defaultSubtitlePosition'>;
  words?: import('../../../shared/types').TranscriptWord[];
  hookStartMs?: number;
  hookEndMs?: number;
  /** Called after a successful translate so parent can refresh transcript state */
  onTranscriptChanged?: (words: import('../../../shared/types').TranscriptWord[]) => void;
  onRefresh?: (hookId: string | null) => void;
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

export function ClipPreviewPanel({ clip, hookId, projectId, words: initialWords, hookStartMs, hookEndMs, onTranscriptChanged, onRefresh }: ClipPreviewPanelProps) {
  // ── Persistent preview settings (saved to localStorage) ──────────────
  const STORAGE_KEY = 'clip-preview-settings';
  const [activeClipId, setActiveClipId] = useState<string | null>(null);

  // Local translated words — overrides the prop after a translate
  const [localWords, setLocalWords] = useState<import('../../../shared/types').TranscriptWord[] | undefined>(undefined);
  // Effective words: local (post-translate) takes priority over prop
  const words = localWords ?? initialWords;

  // Sync back to prop when initialWords changes from parent (e.g. pipeline re-run)
  useEffect(() => { setLocalWords(undefined); }, [initialWords]);

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
  const [letterboxBg, setLetterboxBg]   = useState<LetterboxBackground>(saved?.letterboxBg ?? { type: 'blur', blurRadius: 30 });
  // captionY: 0–1920 canvas px. null = use preset position (legacy).
  const [captionY, setCaptionY] = useState<number | null>(saved?.captionY ?? null);
  const [lastCaptionY, setLastCaptionY] = useState<number | null>(saved?.lastCaptionY ?? saved?.captionY ?? null);
  const [logo, setLogo] = useState<LogoOverlay | null>(saved?.logo ?? null);
  const [titleOverlay, setTitleOverlay] = useState<TitleOverlay | null>(saved?.titleOverlay ?? null);
  const [lastCustomCaption, setLastCustomCaption] = useState<CaptionStyle | null>(
    saved?.lastCustomCaption ?? (saved?.caption && saved.presetId === 'custom' ? saved.caption : null)
  );
  const [lastTitleOverlay, setLastTitleOverlay] = useState<TitleOverlay | null>(
    saved?.titleOverlay ?? null
  );
  const [showYtFrame, setShowYtFrame]   = useState<boolean>(saved?.showYtFrame ?? false);
  const [showSafeZone, setShowSafeZone] = useState<boolean>(saved?.showSafeZone ?? false);

  // Save preview frame settings to localStorage
  useEffect(() => {
    try {
      const dataToSave = {
        presetId,
        caption,
        zoomEnabled,
        trackingMode,
        layoutPreset,
        splitLayout,
        gameRatio,
        gamePosition,
        letterboxBg,
        captionY,
        lastCaptionY,
        logo,
        titleOverlay,
        lastCustomCaption,
        showYtFrame,
        showSafeZone,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(dataToSave));
    } catch { /* ignore */ }
  }, [
    presetId,
    caption,
    zoomEnabled,
    trackingMode,
    layoutPreset,
    splitLayout,
    gameRatio,
    gamePosition,
    letterboxBg,
    captionY,
    lastCaptionY,
    logo,
    titleOverlay,
    lastCustomCaption,
    showYtFrame,
    showSafeZone,
  ]);

  const [progress, setProgress]   = useState(0);
  const [generating, setGenerating] = useState(false);

  // Custom Named Presets state
  const [customPresets, setCustomPresets] = useState<import('../../../shared/types').PreviewPreset[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [showSavePresetModal, setShowSavePresetModal] = useState(false);
  const [presetNameInput, setPresetNameInput] = useState('');

  useEffect(() => {
    ipc.presets.get().then((list) => {
      if (Array.isArray(list)) setCustomPresets(list);
    }).catch(() => { /* ignore */ });
  }, []);

  const applyCustomPreset = (preset: import('../../../shared/types').PreviewPreset) => {
    const s = preset.settings;
    if (!s) return;
    if (s.presetId) setPresetId(s.presetId);
    if (s.caption) setCaption(s.caption);
    if (typeof s.zoomEnabled === 'boolean') setZoomEnabled(s.zoomEnabled);
    if (s.trackingMode) setTrackingMode(s.trackingMode);
    if (s.layoutPreset) setLayoutPreset(s.layoutPreset);
    if (s.splitLayout) setSplitLayout(s.splitLayout);
    if (s.gameRatio) setGameRatio(s.gameRatio);
    if (s.gamePosition) setGamePosition(s.gamePosition);
    if (s.letterboxBg) setLetterboxBg(s.letterboxBg);
    if (s.captionY !== undefined) setCaptionY(s.captionY);
    if (s.logo !== undefined) setLogo(s.logo);
    if (s.titleOverlay !== undefined) setTitleOverlay(s.titleOverlay);
  };

  const handleSavePresetSubmit = async () => {
    if (!presetNameInput.trim()) return;
    const newPreset: import('../../../shared/types').PreviewPreset = {
      id: `preset_${Date.now()}`,
      name: presetNameInput.trim(),
      settings: {
        presetId,
        caption,
        zoomEnabled,
        trackingMode,
        layoutPreset,
        splitLayout,
        gameRatio,
        gamePosition,
        letterboxBg,
        captionY,
        logo,
        titleOverlay,
      },
      createdAt: Date.now(),
    };
    const updated = [...customPresets, newPreset];
    setCustomPresets(updated);
    setSelectedPresetId(newPreset.id);
    setShowSavePresetModal(false);
    setPresetNameInput('');
    try {
      await ipc.presets.save(updated);
    } catch (err) {
      console.error('Failed to save preset:', err);
    }
  };

  const handleDeletePreset = async () => {
    if (!selectedPresetId) return;
    const updated = customPresets.filter((p) => p.id !== selectedPresetId);
    setCustomPresets(updated);
    setSelectedPresetId(null);
    try {
      await ipc.presets.save(updated);
    } catch (err) {
      console.error('Failed to delete preset:', err);
    }
  };

  // Translate caption state
  const [translateLang, setTranslateLang] = useState('id');
  const [translating, setTranslating] = useState(false);
  const [translateStatus, setTranslateStatus] = useState<'idle' | 'done' | 'error'>('idle');
  const [translateMsg, setTranslateMsg] = useState('');

  const handleTranslate = async () => {
    const projectId = clip?.projectId ?? '';
    if (!projectId) return;
    setTranslating(true);
    setTranslateStatus('idle');
    setTranslateMsg('');
    try {
      // Only translate words within the selected hook's time range — much faster
      await ipc.translate.start(projectId, translateLang, hookStartMs, hookEndMs);
      // Fetch updated transcript so live preview & generate use new words immediately
      const updated = await ipc.transcribe.getTranscript(projectId);
      if (updated?.words) {
        setLocalWords(updated.words);
        onTranscriptChanged?.(updated.words);
      }
      setTranslateStatus('done');
      const langLabel = TRANSLATE_LANGS.find((l) => l.code === translateLang)?.label ?? translateLang.toUpperCase();
      setTranslateMsg(`Translated to ${langLabel}`);
    } catch (err) {
      setTranslateStatus('error');
      setTranslateMsg(err instanceof Error ? err.message : 'Translation failed');
    } finally {
      setTranslating(false);
    }
  };

  const handleResetTranslation = async () => {
    const pid = clip?.projectId ?? projectId;
    if (!pid) return;
    setTranslating(true);
    setTranslateStatus('idle');
    setTranslateMsg('');
    try {
      await ipc.translate.reset(pid);
      const updated = await ipc.transcribe.getTranscript(pid);
      if (updated?.words) {
        setLocalWords(updated.words);
        onTranscriptChanged?.(updated.words);
      }
      setTranslateStatus('done');
      setTranslateMsg('Reset to original language');
    } catch (err) {
      setTranslateStatus('error');
      setTranslateMsg(err instanceof Error ? err.message : 'Reset failed');
    } finally {
      setTranslating(false);
    }
  };

  // Thumbnail state
  const [thumbnailMode, setThumbnailMode] = useState<'auto' | 'custom' | 'off'>(saved?.thumbnailMode ?? 'auto');
  const [customThumbnailPath, setCustomThumbnailPath] = useState<string | null>(saved?.customThumbnailPath ?? null);
  const [thumbnailPreview, setThumbnailPreview] = useState<string | null>(null); // base64 or file path

  // Thumbnail Designer state
  const [designerOpen, setDesignerOpen] = useState(false);
  const [designerOffsetSec, setDesignerOffsetSec] = useState(1);
  const [designerText, setDesignerText] = useState('HOOK MENARIK DISINI');
  const [designerColor, setDesignerColor] = useState('#FFFF00');
  const [designerOutlineColor, _setDesignerOutlineColor] = useState('#000000');
  const [designerFont, setDesignerFont] = useState<CaptionFont>('Impact');
  const [designerFontSize, setDesignerFontSize] = useState(90);
  const [designerOutlineSize, setDesignerOutlineSize] = useState(8);
  const [designerBold, _setDesignerBold] = useState(true);
  const [designerY, setDesignerY] = useState(960);
  const [designerFrame, setDesignerFrame] = useState<string | null>(null);
  const [designerLoadingFrame, setDesignerLoadingFrame] = useState(false);
  const [suggestedHooks, setSuggestedHooks] = useState<string[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const [savingThumbnail, setSavingThumbnail] = useState(false);
  const [videoNonce, setVideoNonce] = useState(0);
  const [generatingAiThumbnail, setGeneratingAiThumbnail] = useState(false);
  const [aiThumbnailError, setAiThumbnailError] = useState<string | null>(null);

  // Save settings to localStorage whenever they change
  useEffect(() => {
    const settings = {
      presetId, caption, zoomEnabled, trackingMode,
      layoutPreset, splitLayout, gameRatio, gamePosition,
      letterboxBg, captionY, logo, titleOverlay, thumbnailMode, customThumbnailPath,
      lastCaptionY, lastCustomCaption,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch { /* ignore quota errors */ }
  }, [presetId, caption, zoomEnabled, trackingMode, layoutPreset, splitLayout, gameRatio, gamePosition, letterboxBg, captionY, logo, titleOverlay, thumbnailMode, customThumbnailPath, lastCaptionY, lastCustomCaption]);

  // Live preview background frame (extracted from source video)
  const [liveFrameBase64, setLiveFrameBase64] = useState<string | null>(null);
  const [_liveFrameLoading, setLiveFrameLoading] = useState(false);

  // Rendered preview frame — FFmpeg-rendered frame with full filter stack
  // Replaces CSS caption overlay for pixel-accurate preview
  const [renderedPreview, setRenderedPreview] = useState<string | null>(null);
  const [renderedPreviewLoading, setRenderedPreviewLoading] = useState(false);
  const renderDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  const [pickerMode, setPickerMode] = useState<'tracking' | 'letterbox'>('tracking');
  const pickerImgRef = useRef<HTMLImageElement>(null);
  const [pickerImgSize, setPickerImgSize] = useState({ w: 1920, h: 1080 });
  const [tempCropBox, setTempCropBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [interaction, setInteraction] = useState<{
    type: 'move' | 'resize';
    handle?: 'tl' | 'tr' | 'bl' | 'br';
    startX: number;
    startY: number;
    startBox: { x: number; y: number; w: number; h: number };
  } | null>(null);

  const startInteraction = (
    e: React.MouseEvent,
    type: 'move' | 'resize',
    handle?: 'tl' | 'tr' | 'bl' | 'br'
  ) => {
    e.preventDefault();
    e.stopPropagation();
    let currentBox = tempCropBox;
    if (!currentBox) {
      currentBox = { x: 0, y: 0, w: pickerImgSize.w, h: pickerImgSize.h };
    }
    setInteraction({
      type,
      handle,
      startX: e.clientX,
      startY: e.clientY,
      startBox: { ...currentBox }
    });
  };

  useEffect(() => {
    if (!interaction) return;

    const handleGlobalMouseMove = (e: MouseEvent) => {
      const img = pickerImgRef.current;
      if (!img) return;
      const rect = img.getBoundingClientRect();
      const scaleX = pickerImgSize.w / rect.width;
      const scaleY = pickerImgSize.h / rect.height;

      const deltaX = Math.round((e.clientX - interaction.startX) * scaleX);
      const deltaY = Math.round((e.clientY - interaction.startY) * scaleY);

      let newBox = { ...interaction.startBox };

      if (interaction.type === 'move') {
        newBox.x = Math.max(0, Math.min(pickerImgSize.w - newBox.w, interaction.startBox.x + deltaX));
        newBox.y = Math.max(0, Math.min(pickerImgSize.h - newBox.h, interaction.startBox.y + deltaY));
      } else if (interaction.type === 'resize') {
        const h = interaction.handle;
        if (h === 'tl') {
          const newX = Math.max(0, Math.min(interaction.startBox.x + interaction.startBox.w - 10, interaction.startBox.x + deltaX));
          newBox.w = interaction.startBox.w + (interaction.startBox.x - newX);
          newBox.x = newX;
          const newY = Math.max(0, Math.min(interaction.startBox.y + interaction.startBox.h - 10, interaction.startBox.y + deltaY));
          newBox.h = interaction.startBox.h + (interaction.startBox.y - newY);
          newBox.y = newY;
        } else if (h === 'tr') {
          newBox.w = Math.max(10, Math.min(pickerImgSize.w - interaction.startBox.x, interaction.startBox.w + deltaX));
          const newY = Math.max(0, Math.min(interaction.startBox.y + interaction.startBox.h - 10, interaction.startBox.y + deltaY));
          newBox.h = interaction.startBox.h + (interaction.startBox.y - newY);
          newBox.y = newY;
        } else if (h === 'bl') {
          const newX = Math.max(0, Math.min(interaction.startBox.x + interaction.startBox.w - 10, interaction.startBox.x + deltaX));
          newBox.w = interaction.startBox.w + (interaction.startBox.x - newX);
          newBox.x = newX;
          newBox.h = Math.max(10, Math.min(pickerImgSize.h - interaction.startBox.y, interaction.startBox.h + deltaY));
        } else if (h === 'br') {
          newBox.w = Math.max(10, Math.min(pickerImgSize.w - interaction.startBox.x, interaction.startBox.w + deltaX));
          newBox.h = Math.max(10, Math.min(pickerImgSize.h - interaction.startBox.y, interaction.startBox.h + deltaY));
        }
      }

      setTempCropBox(newBox);
    };

    const handleGlobalMouseUp = () => {
      setInteraction(null);
    };

    window.addEventListener('mousemove', handleGlobalMouseMove);
    window.addEventListener('mouseup', handleGlobalMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleGlobalMouseMove);
      window.removeEventListener('mouseup', handleGlobalMouseUp);
    };
  }, [interaction, pickerImgSize]);

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

  // Reset rendered preview when hook changes so it re-renders immediately
  useEffect(() => {
    setRenderedPreview(null);
    setRenderedPreviewLoading(true);
  }, [hookId]);

  // Auto-extract frame from source video for live preview background
  useEffect(() => {
    if (!hookId || hookStartMs == null || !projectId) {
      setLiveFrameBase64(null);
      return;
    }
    let cancelled = false;
    setLiveFrameLoading(true);
    // Extract frame at hook start + 1s (or start if too short)
    const frameTs = hookStartMs + 1000;
    ipc.tracking.extractFrame(projectId, frameTs).then((data) => {
      if (!cancelled) {
        setLiveFrameBase64(data);
        setLiveFrameLoading(false);
      }
    }).catch(() => {
      if (!cancelled) setLiveFrameLoading(false);
    });
    return () => { cancelled = true; };
  }, [hookId, hookStartMs, projectId]);

  // Debounced rendered preview — re-render via FFmpeg whenever any visual setting changes
  useEffect(() => {
    if (!hookId || hookStartMs == null || hookEndMs == null) {
      setRenderedPreview(null);
      setRenderedPreviewLoading(false);
      return;
    }
    if (renderDebounceRef.current) clearTimeout(renderDebounceRef.current);
    setRenderedPreviewLoading(true);

    // Snapshot current values so async callback uses correct values
    const effectiveCaption = { ...caption, captionY: captionY ?? undefined };
    const overrideWords = (() => {
      if (editedTranscript === null || !words || !hookStartMs || !hookEndMs) return undefined;
      const clipWords = words.filter((w) => w.startMs >= hookStartMs && w.endMs <= hookEndMs);
      const tokens = editedTranscript.trim().split(/\s+/).filter(Boolean);
      if (tokens.length === 0) return undefined;
      return tokens.map((token, i) => {
        const orig = clipWords[i] ?? clipWords[clipWords.length - 1];
        return orig ? { ...orig, word: token } : { word: token, startMs: hookStartMs, endMs: hookEndMs, confidence: 1 };
      });
    })();

    let cancelled = false;

    renderDebounceRef.current = setTimeout(() => {
      ipc.preview.renderFrame({
        hookId,
        captionStyle:        effectiveCaption,
        layoutPreset,
        splitLayout:         layoutPreset === 'split'     ? splitLayout   : undefined,
        gameRatio:           layoutPreset === 'game'      ? gameRatio     : undefined,
        gamePosition:        layoutPreset === 'game'      ? gamePosition  : undefined,
        letterboxBg:         layoutPreset === 'letterbox' ? letterboxBg   : undefined,
        logoOverlay:         logo ?? undefined,
        titleOverlay:        titleOverlay ?? undefined,
        zoomEnabled:         trackingMode !== 'none' ? zoomEnabled : false,
        trackingMode:        trackingMode !== 'none' && (trackingMode !== 'auto' || zoomEnabled) ? trackingMode : 'none',
        subjectBbox:         trackingMode === 'manual' && selectedBbox ? selectedBbox : undefined,
        subjectSeedMs:       trackingMode === 'manual' && selectedBbox ? pickerTimestampMs : undefined,
        overrideWords,
      }).then((data) => {
        if (!cancelled) {
          setRenderedPreview(data);
          setRenderedPreviewLoading(false);
        }
      }).catch((err) => {
        if (!cancelled) {
          console.error('[preview:render] failed:', err);
          setRenderedPreviewLoading(false);
        }
      });
    }, 600);

    return () => {
      cancelled = true;
      if (renderDebounceRef.current) clearTimeout(renderDebounceRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    hookId, hookStartMs, hookEndMs,
    caption, captionY,
    layoutPreset, splitLayout, gameRatio, gamePosition, letterboxBg,
    logo, titleOverlay,
    words, editedTranscript,
    zoomEnabled, trackingMode, selectedBbox, pickerTimestampMs,
  ]);

  // Auto-generate thumbnail preview (frame at 1st second of clip)
  useEffect(() => {
    if (!hookId || hookStartMs == null || !projectId || thumbnailMode === 'off') {
      setThumbnailPreview(null);
      return;
    }
    if (thumbnailMode === 'custom' && customThumbnailPath) return; // custom overrides
    let cancelled = false;
    // Extract frame at hook start (1st second = thumbnail)
    ipc.tracking.extractFrame(projectId, hookStartMs).then((data) => {
      if (!cancelled && thumbnailMode === 'auto') {
        setThumbnailPreview(data);
      }
    }).catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, [hookId, hookStartMs, projectId, thumbnailMode, customThumbnailPath]);

  // Thumbnail Designer: Extract frame based on selected offset second
  useEffect(() => {
    if (!designerOpen || !projectId || hookStartMs == null) return;

    setDesignerLoadingFrame(true);
    const targetMs = hookStartMs + designerOffsetSec * 1000;

    let cancelled = false;
    ipc.tracking.extractFrame(projectId, targetMs).then((data) => {
      if (!cancelled) {
        setDesignerFrame(data);
        setDesignerLoadingFrame(false);
      }
    }).catch(() => {
      if (!cancelled) setDesignerLoadingFrame(false);
    });

    return () => {
      cancelled = true;
    };
  }, [designerOpen, designerOffsetSec, projectId, hookStartMs]);

  // Thumbnail Designer Canvas Drawing logic
  const designerCanvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!designerOpen || !designerFrame || !designerCanvasRef.current) return;
    const canvas = designerCanvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const img = new Image();
    img.src = designerFrame.startsWith('data:') ? designerFrame : `data:image/jpeg;base64,${designerFrame}`;
    img.onload = () => {
      // Clear canvas and draw base frame with center crop to 9:16
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const canvasRatio = canvas.width / canvas.height;
      const imgRatio = img.width / img.height;
      let sx = 0, sy = 0, sw = img.width, sh = img.height;
      if (imgRatio > canvasRatio) {
        sw = img.height * canvasRatio;
        sx = (img.width - sw) / 2;
      } else {
        sh = img.width / canvasRatio;
        sy = (img.height - sh) / 2;
      }
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

      // Draw custom hook text overlay
      if (designerText.trim()) {
        ctx.save();
        const fontName = getFontFamily(designerFont);
        ctx.font = `${designerBold ? 'bold ' : ''}${designerFontSize}px ${fontName}`;
        ctx.fillStyle = designerColor;
        ctx.strokeStyle = designerOutlineColor;
        ctx.lineWidth = designerOutlineSize * 2;
        ctx.lineJoin = 'round';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        const lines = designerText.split('\n');
        const lineHeight = designerFontSize * 1.25;
        const startY = designerY - ((lines.length - 1) * lineHeight) / 2;

        lines.forEach((line, index) => {
          const y = startY + index * lineHeight;
          if (designerOutlineSize > 0) {
            ctx.strokeText(line, canvas.width / 2, y);
          }
          ctx.fillText(line, canvas.width / 2, y);
        });

        ctx.restore();
      }
    };
  }, [designerOpen, designerFrame, designerText, designerColor, designerOutlineColor, designerFont, designerFontSize, designerOutlineSize, designerY, designerBold]);

  const handleSaveThumbnail = async () => {
    if (!designerCanvasRef.current || !projectId) return;
    setSavingThumbnail(true);
    try {
      const base64Data = designerCanvasRef.current.toDataURL('image/jpeg', 0.95);
      const identifier = clip ? clip.id : `hook_${hookId}`;
      const filePath = await ipc.thumbnail.saveCustom(projectId, identifier, base64Data);
      setThumbnailMode('custom');
      setCustomThumbnailPath(filePath);
      setThumbnailPreview(base64Data);
      setDesignerOpen(false);
      setVideoNonce((n) => n + 1);
    } catch (err) {
      console.error('Failed to save custom thumbnail:', err);
    } finally {
      setSavingThumbnail(false);
    }
  };

  const handleGenerateAiThumbnail = async () => {
    if (!projectId || !designerFrame) return;
    setGeneratingAiThumbnail(true);
    setAiThumbnailError(null);
    try {
      const base64Data = await ipc.thumbnail.generateAi(projectId, designerFrame, designerText);
      if (base64Data) {
        setDesignerFrame(base64Data);
      }
    } catch (err) {
      console.error('Failed to generate thumbnail:', err);
      setAiThumbnailError(err instanceof Error ? err.message : 'Failed to generate thumbnail.');
    } finally {
      setGeneratingAiThumbnail(false);
    }
  };

  const handleGenerateHookSuggestions = async () => {
    if (!projectId) return;
    setSuggesting(true);
    try {
      const project = await ipc.projects.get(projectId);
      const title = project.title || 'Video';
      const list = [
        `TIPS JITU\n${title.toUpperCase()}!`,
        `INI RAHASIA\n${title.toUpperCase()}!`,
        `JANGAN LAKUKAN INI!`,
        `1 DETIK PAHAM\n${title.toUpperCase()}`,
        `TRICK RAHASIA 2026`,
      ];
      setSuggestedHooks(list);
    } catch {
      setSuggestedHooks([
        'TIPS JITU TERBARU!',
        'RAHASIA TERBONGKAR!',
        'JANGAN LAKUKAN INI!',
      ]);
    } finally {
      setSuggesting(false);
    }
  };

  // Live clip progress events
  useIpcEvent<{ clipId: string; percent: number; eta: string }>(
    'clip:progress',
    (data) => {
      if (data.clipId !== activeClipId && (!clip || data.clipId !== clip.id)) return;
      if (data.percent >= 0) setProgress(data.percent);
      if (data.percent >= 100) {
        setGenerating(false);
        setActiveClipId(null);
        setVideoNonce((n) => n + 1);
        if (onRefresh) onRefresh(hookId);
      } else if (data.percent > 0) {
        setGenerating(true);
      }
    },
    [clip?.id, activeClipId, onRefresh, hookId]
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
      setPresetId('custom');
      setCaption(lastCustomCaption || { ...CAPTION_PRESETS['custom'], presetId: 'custom' });
      setCaptionY(lastCaptionY);
    } else {
      if (presetId === 'custom') {
        setLastCustomCaption(caption);
        setLastCaptionY(captionY);
      }
      setPresetId(id);
      setCaption({ ...CAPTION_PRESETS[id], presetId: id });
      setCaptionY(null); // reset custom Y when switching preset
    }
  };

  const updateCaption = (patch: Partial<CaptionStyle>) => {
    setCaption((prev) => {
      const next = { ...prev, ...patch, presetId: 'custom' as const };
      setLastCustomCaption(next);
      return next;
    });
    setPresetId('custom');
  };

  const changeCaptionY = (y: number | null) => {
    setCaptionY(y);
    if (y !== null) {
      setLastCaptionY(y);
      if (presetId !== 'custom') {
        setPresetId('custom');
        setCaption((prev) => {
          const next = { ...prev, presetId: 'custom' as const };
          setLastCustomCaption(next);
          return next;
        });
      }
    }
  };

  const regenerate = async (zoom: boolean, cap: CaptionStyle) => {
    if (!hookId) return;
    setGenerating(true);
    setProgress(0);
    try {
      const res = await ipc.clips.generate(hookId, {
        subtitleStyle:    'bold-white',
        subtitlePosition: cap.position,
        zoomEnabled:      zoom,
        existingClipId:   clip?.id,
        captionStyle:     { ...cap, captionY: captionY ?? undefined },
        logoOverlay:      logo ?? undefined,
        titleOverlay:     titleOverlay ?? undefined,
        trackingMode:     zoom ? trackingMode : 'none',
        subjectBbox:      trackingMode === 'manual' && selectedBbox ? selectedBbox : undefined,
        subjectSeedMs:    trackingMode === 'manual' && selectedBbox ? pickerTimestampMs : undefined,
        layoutPreset,
        splitLayout:      layoutPreset === 'split'     ? splitLayout : undefined,
        gameRatio:        layoutPreset === 'game'       ? gameRatio    : undefined,
        gamePosition:     layoutPreset === 'game'       ? gamePosition : undefined,
        letterboxBg:      layoutPreset === 'letterbox'  ? letterboxBg  : undefined,
        overrideWords:    buildOverrideWords(),
        thumbnailPath:    thumbnailMode === 'custom' && customThumbnailPath ? customThumbnailPath : undefined,
      });
      if (res && res.clipId) {
        setActiveClipId(res.clipId);
      }
    } catch {
      setGenerating(false);
    }
  };

  // Open subject picker: extract frame + detect boxes
  const openSubjectPicker = async (mode: 'tracking' | 'letterbox' = 'tracking') => {
    if (!hookId) return;
    setPickerMode(mode);
    setSubjectPickerOpen(true);
    setPickerLoading(true);
    setPickerFrame(null);
    setPickerBoxes([]);

    // Initialize transactional crop box state
    if (mode === 'letterbox') {
      setTempCropBox(letterboxBg.cropBox || null);
    } else {
      setTempCropBox(selectedBbox || null);
    }

    const ts = pickerTimestampMs;
    // Need projectId — get from clip or hookId context via parent
    // We use hookStartMs as seed timestamp if available
    try {
      // Extract frame image
      // Note: we need projectId — stored on clip or passed via prop
      // For now use clip.projectId if available
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

  const renderCropOverlay = () => {
    const box = tempCropBox;
    if (!box) return null;
    const img = pickerImgRef.current;
    if (!img) return null;

    const scaleX = img.clientWidth  / pickerImgSize.w;
    const scaleY = img.clientHeight / pickerImgSize.h;

    const left   = box.x * scaleX;
    const top    = box.y * scaleY;
    const width  = box.w * scaleX;
    const height = box.h * scaleY;

    return (
      <div
        style={{
          position: 'absolute',
          left,
          top,
          width,
          height,
          border: '2.5px dashed #22c55e',
          boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.6)',
          boxSizing: 'border-box',
        }}
      >
        {/* Drag area to move box */}
        <div
          onMouseDown={(e) => startInteraction(e, 'move')}
          className="absolute inset-0 cursor-move"
          style={{ backgroundColor: 'rgba(34, 197, 94, 0.03)' }}
        />

        {/* Corner Resize Handles */}
        <div
          onMouseDown={(e) => startInteraction(e, 'resize', 'tl')}
          className="absolute -top-2 -left-2 h-4 w-4 bg-white border-2 border-[#22c55e] cursor-nwse-resize rounded-full z-10 shadow-md"
        />
        <div
          onMouseDown={(e) => startInteraction(e, 'resize', 'tr')}
          className="absolute -top-2 -right-2 h-4 w-4 bg-white border-2 border-[#22c55e] cursor-nesw-resize rounded-full z-10 shadow-md"
        />
        <div
          onMouseDown={(e) => startInteraction(e, 'resize', 'bl')}
          className="absolute -bottom-2 -left-2 h-4 w-4 bg-white border-2 border-[#22c55e] cursor-nesw-resize rounded-full z-10 shadow-md"
        />
        <div
          onMouseDown={(e) => startInteraction(e, 'resize', 'br')}
          className="absolute -bottom-2 -right-2 h-4 w-4 bg-white border-2 border-[#22c55e] cursor-nwse-resize rounded-full z-10 shadow-md"
        />
      </div>
    );
  };

  return (
    <section aria-label="Clip preview" className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="border-b border-border px-4 py-3 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-text-secondary">Preview</h2>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setShowYtFrame(!showYtFrame)}
            className={cn(
              "rounded px-2 py-0.5 text-[10px] font-medium transition-colors flex items-center gap-1 border cursor-pointer",
              showYtFrame
                ? "bg-red-600 border-red-600 text-white shadow-xs font-semibold"
                : "bg-background border-border text-text-secondary hover:text-text-primary hover:border-text-secondary"
            )}
            title="Tampilkan / Sembunyikan Frame YouTube Shorts"
          >
            <svg className="w-3 h-3 fill-current" viewBox="0 0 24 24">
              <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
            </svg>
            YT Frame
          </button>
          {showYtFrame && (
            <button
              type="button"
              onClick={() => setShowSafeZone(!showSafeZone)}
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors border cursor-pointer",
                showSafeZone
                  ? "bg-emerald-600 border-emerald-600 text-white font-semibold"
                  : "bg-background border-border text-text-secondary hover:text-text-primary hover:border-text-secondary"
              )}
              title="Tampilkan Garis Area Aman (Safe Zone)"
            >
              🎯 Batas
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-3">
        {/* 9:16 video container */}
        <div className="mx-auto w-full max-w-[240px]">
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

            {/* No clip yet — show live frame fallback */}
            {hookId && !isProcessing && (!clip?.outputPath || renderedPreviewLoading) && !renderedPreview && (
              <div
                className="relative flex h-full items-center justify-center overflow-hidden"
                style={{ background: '#18181b' }}
              >
                {renderedPreviewLoading && (
                  <div className="absolute inset-0 bg-black/50 z-10 flex items-center justify-center">
                    <span className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-accent" />
                  </div>
                )}
                {liveFrameBase64 && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={liveFrameBase64} alt="" aria-hidden="true"
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                )}
                {!liveFrameBase64 && !renderedPreviewLoading && (
                  <p className="text-[9px] text-zinc-500">Live preview</p>
                )}
              </div>
            )}

            {/* Clip ready — video player (shown only when no rendered preview) */}
            {hookId && !isProcessing && clip?.outputPath && !renderedPreview && !renderedPreviewLoading && (
              // eslint-disable-next-line jsx-a11y/media-has-caption
              <video
                src={`localfile:///${clip.outputPath.replace(/\\/g, '/')}?v=${videoNonce}`}
                controls loop playsInline
                className="h-full w-full object-cover"
                aria-label="Clip preview"
              />
            )}

            {/* Rendered preview — pixel-accurate FFmpeg frame, shown over everything */}
            {hookId && !isProcessing && renderedPreview && (
              <div className="relative h-full w-full">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={renderedPreview}
                  alt="Preview"
                  className="absolute inset-0 h-full w-full object-fill"
                  style={{ opacity: renderedPreviewLoading ? 0.6 : 1, transition: 'opacity 0.2s' }}
                />
                {/* Spinner while re-rendering */}
                {renderedPreviewLoading && (
                  <div className="absolute bottom-1 right-1">
                    <span className="h-3 w-3 animate-spin rounded-full border border-border border-t-accent block" />
                  </div>
                )}
                {/* Button to switch back to video player */}
                {clip?.outputPath && (
                  <button
                    type="button"
                    title="Show generated video"
                    onClick={() => setRenderedPreview(null)}
                    className="absolute top-1 right-1 rounded bg-black/50 px-1.5 py-0.5 text-[8px] text-white/70 hover:bg-black/80"
                  >
                    ▶ Video
                  </button>
                )}
              </div>
            )}

            {/* Failed */}
            {hookId && !isProcessing && clip?.status === 'failed' && (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
                <p className="text-[10px] text-destructive">{clip.errorMessage ?? 'Failed'}</p>
              </div>
            )}

            {/* Live caption overlay — only shown when no rendered preview available yet */}
            {hookId && !isProcessing && !renderedPreview && (
              <CaptionLivePreview
                caption={caption}
                containerWidth={containerSize.w}
                containerHeight={containerSize.h}
                words={words}
                startMs={hookStartMs}
                endMs={hookEndMs}
                captionY={captionY}
              />
            )}

            {/* Live logo overlay preview — only shown when no rendered preview available yet */}
            {hookId && !isProcessing && !renderedPreview && logo && (
              <LogoLivePreview
                logo={logo}
                containerWidth={containerSize.w}
                containerHeight={containerSize.h}
              />
            )}

            {/* Live title overlay preview — only shown when no rendered preview available yet */}
            {hookId && !isProcessing && !renderedPreview && titleOverlay && (
              <TitleLivePreview
                titleOverlay={titleOverlay}
                containerWidth={containerSize.w}
                containerHeight={containerSize.h}
              />
            )}

            {/* YouTube Shorts Frame & Safe Zone Overlay */}
            {hookId && !isProcessing && showYtFrame && (
              <YouTubeShortsOverlay showSafeZone={showSafeZone} />
            )}
          </div>
        </div>

        {hookId && (
          <>
            {/* Custom Preset Bar */}
            <div className="flex flex-col gap-2 rounded-md border border-accent/40 bg-accent/5 p-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-accent flex items-center gap-1">
                  ✨ Preset Tampilan Custom
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setShowSavePresetModal(true)}
                    className="rounded bg-accent px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-accent/90 transition-micro"
                  >
                    + Simpan Preset
                  </button>
                  {selectedPresetId && (
                    <button
                      type="button"
                      onClick={handleDeletePreset}
                      className="rounded border border-destructive/40 bg-destructive/10 px-1.5 py-0.5 text-[10px] text-destructive hover:bg-destructive/20 transition-micro"
                    >
                      Hapus
                    </button>
                  )}
                </div>
              </div>
              <select
                value={selectedPresetId || ''}
                onChange={(e) => {
                  const val = e.target.value;
                  setSelectedPresetId(val || null);
                  if (val) {
                    const found = customPresets.find((p) => p.id === val);
                    if (found) applyCustomPreset(found);
                  }
                }}
                className="w-full rounded border border-border bg-background px-2.5 py-1.5 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
              >
                <option value="">-- Pilih Preset Custom --</option>
                {customPresets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Title Overlay */}
            <div className="flex flex-col gap-2 rounded-md border border-border p-2.5">
              <div className="flex items-center justify-between">
                <Label>Title Overlay</Label>
                <div className="flex items-center gap-1.5">
                  {titleOverlay && (
                    <button type="button" onClick={() => {
                      setLastTitleOverlay(titleOverlay);
                      setTitleOverlay(null);
                    }}
                      className="text-[10px] text-destructive hover:underline">
                      Remove
                    </button>
                  )}
                  {!titleOverlay && (
                    <button type="button"
                      onClick={() => setTitleOverlay(lastTitleOverlay || {
                        text: '', font: 'Montserrat', fontSize: 72,
                        color: '#FFFFFF', outlineColor: '#000000', outlineSize: 4,
                        bold: true, uppercase: false, y: 200,
                      })}
                      className={cn(
                        'rounded border border-border px-2 py-0.5 text-[10px] text-text-secondary',
                        'hover:border-accent/40 hover:text-text-primary transition-micro'
                      )}>
                      + Add Title
                    </button>
                  )}
                </div>
              </div>
              {titleOverlay && (
                <div className="flex flex-col gap-2">
                  <div className="flex flex-col gap-1">
                    <Label>Text</Label>
                    <textarea
                      value={titleOverlay.text}
                      onChange={(e) => setTitleOverlay((t) => t ? { ...t, text: e.target.value } : t)}
                      rows={2} placeholder="Enter title text…"
                      className={cn(
                        'rounded border border-border bg-background px-2 py-1.5 text-xs text-text-primary',
                        'focus:outline-none focus:ring-1 focus:ring-accent resize-none'
                      )}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Select label="Font" value={titleOverlay.font}
                      onChange={(v) => setTitleOverlay((t) => t ? { ...t, font: v as CaptionFont } : t)}
                      options={FONT_OPTIONS.map((f) => ({ value: f, label: f }))} />
                    <NumberInput label={`Size (${titleOverlay.fontSize}px)`} value={titleOverlay.fontSize}
                      onChange={(v) => setTitleOverlay((t) => t ? { ...t, fontSize: v } : t)} min={30} max={200} />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <ColorSwatch label="Color"   value={titleOverlay.color}        onChange={(v) => setTitleOverlay((t) => t ? { ...t, color: v } : t)} />
                    <ColorSwatch label="Outline" value={titleOverlay.outlineColor} onChange={(v) => setTitleOverlay((t) => t ? { ...t, outlineColor: v } : t)} />
                  </div>
                  <NumberInput label={`Outline (${titleOverlay.outlineSize}px)`} value={titleOverlay.outlineSize}
                    onChange={(v) => setTitleOverlay((t) => t ? { ...t, outlineSize: v } : t)} min={0} max={12} />
                  <div className="grid grid-cols-2 gap-2">
                    {(['bold', 'uppercase'] as const).map((prop) => (
                      <div key={prop} className="flex items-center justify-between">
                        <Label>{prop === 'bold' ? 'Bold' : 'Uppercase'}</Label>
                        <button type="button" role="switch" aria-checked={titleOverlay[prop]}
                          onClick={() => setTitleOverlay((t) => t ? { ...t, [prop]: !t[prop] } : t)}
                          className={cn('relative h-4 w-8 rounded-full border transition-micro',
                            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                            titleOverlay[prop] ? 'border-accent bg-accent' : 'border-border bg-border')}>
                          <span className={cn('absolute top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-micro',
                            titleOverlay[prop] ? 'left-4' : 'left-0.5')} />
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label>Position</Label>
                    <div className="flex gap-1 mb-1">
                      {([{ label: 'Top', y: 200 }, { label: 'Mid', y: 960 }, { label: 'Bot', y: 1750 }] as const).map(({ label, y }) => (
                        <button key={label} type="button" onClick={() => setTitleOverlay((t) => t ? { ...t, y } : t)}
                          className={cn('flex-1 rounded border px-1 py-1 text-[9px] transition-micro',
                            titleOverlay.y === y ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:border-accent/40'
                          )}>{label}</button>
                      ))}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <input type="range" min={50} max={1900} value={titleOverlay.y}
                        onChange={(e) => setTitleOverlay((t) => t ? { ...t, y: Number(e.target.value) } : t)}
                        aria-label="Title Y position" className="flex-1 accent-accent" />
                      <span className="w-8 text-right text-[10px] font-mono text-text-secondary">{titleOverlay.y}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>

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
                <div className="flex flex-col gap-1">
                  <Label>Position</Label>
                  {/* Quick presets */}
                  <div className="flex gap-1">
                    {([
                      { label: 'Top', y: 170 },
                      { label: 'Mid', y: 960 },
                      { label: 'Bot', y: 1750 },
                    ] as const).map(({ label, y }) => (
                      <button
                        key={label}
                        type="button"
                        onClick={() => changeCaptionY(y)}
                        className={cn(
                          'flex-1 rounded border px-1 py-1 text-[9px] transition-micro',
                          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                          captionY === y
                            ? 'border-accent bg-accent/10 text-accent'
                            : 'border-border text-text-secondary hover:border-accent/40 hover:text-text-primary'
                        )}
                      >{label}</button>
                    ))}
                  </div>
                  {/* Fine-tune slider */}
                  <div className="flex items-center gap-1.5">
                    <input
                      type="range"
                      min={50} max={1900}
                      value={captionY ?? (caption.position === 'lower-third' ? 1750 : caption.position === 'upper-third' ? 170 : 960)}
                      onChange={(e) => changeCaptionY(Number(e.target.value))}
                      aria-label="Caption Y position"
                      className="flex-1 accent-accent"
                    />
                    <span className="w-8 text-right text-[10px] font-mono text-text-secondary">
                      {captionY ?? (caption.position === 'lower-third' ? 1750 : caption.position === 'upper-third' ? 170 : 960)}
                    </span>
                  </div>
                </div>
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
              <Label>Auto Reframe / Motion Focus</Label>

              {/* Mode selector */}
              <div className="grid grid-cols-2 gap-1">
                {([
                  { mode: 'auto',    label: 'Auto',    desc: 'Auto detects' },
                  { mode: 'speaker', label: 'Speaker', desc: 'Follow talker' },
                  { mode: 'manual',  label: 'Manual',  desc: 'You pick' },
                  { mode: 'none',    label: 'None',    desc: 'Center crop' },
                ] as const).map(({ mode, label, desc }) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => {
                      setTrackingMode(mode);
                      if (mode !== 'none') {
                        setZoomEnabled(true);
                      } else {
                        setZoomEnabled(false);
                      }
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
                    onClick={() => setZoomEnabled((z: boolean) => !z)}
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
                    onClick={() => void openSubjectPicker('tracking')}
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
            {subjectPickerOpen && (
              <div
                role="dialog"
                aria-modal="true"
                aria-label={pickerMode === 'letterbox' ? 'Pilih Area Crop Video' : 'Pick subject to track'}
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
                onClick={(e) => { if (e.target === e.currentTarget) setSubjectPickerOpen(false); }}
              >
                <div className="flex w-full max-w-2xl max-h-[90vh] flex-col gap-4 rounded-xl border border-border bg-surface p-5 shadow-2xl overflow-hidden">
                  <div className="flex items-center justify-between flex-shrink-0">
                    <h2 className="text-sm font-semibold text-text-primary">
                      {pickerMode === 'letterbox' ? 'Pilih Area Crop Video' : 'Pick Subject to Track'}
                    </h2>
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

                  {/* Scrollable Modal Content */}
                  <div className="flex-1 overflow-y-auto flex flex-col gap-4 pr-1">
                    <p className="text-[11px] text-text-secondary">
                      {pickerMode === 'letterbox'
                        ? 'Klik pada layar video untuk menentukan batas crop kustom. Bagian di luar kotak tidak akan dirender.'
                        : 'Click on the subject you want to track. Detected subjects are highlighted with boxes. Click anywhere to create a custom selection.'}
                    </p>

                    {/* Timestamp scrubber */}
                    <div className="flex flex-col gap-1 flex-shrink-0">
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
                          onClick={() => void openSubjectPicker(pickerMode)}
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
                    <div className="relative overflow-hidden rounded-md bg-zinc-900 flex-shrink-0" style={{ minHeight: 200 }}>
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
                        <div className="relative inline-block w-full select-none overflow-hidden rounded-md">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            ref={pickerImgRef}
                            src={pickerFrame}
                            alt="Frame for subject selection"
                            className="w-full"
                            draggable={false}
                            onLoad={(e) => {
                              const img = e.currentTarget;
                              const w = img.naturalWidth;
                              const h = img.naturalHeight;
                              setPickerImgSize({ w, h });
                              if (!tempCropBox) {
                                setTempCropBox({ x: 0, y: 0, w, h });
                              }
                            }}
                          />
                          {/* Only show detected face boxes in tracking mode */}
                          {pickerMode === 'tracking' && pickerBoxes.map((box, i) => {
                            const img = pickerImgRef.current;
                            if (!img) return null;
                            const scaleX = img.clientWidth  / pickerImgSize.w;
                            const scaleY = img.clientHeight / pickerImgSize.h;
                            const isSelected = selectedBbox && selectedBbox.x === box.x && selectedBbox.y === box.y;
                            return (
                              <div
                                key={i}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSelectedBbox(box);
                                }}
                                style={{
                                  position: 'absolute',
                                  left:   box.x * scaleX,
                                  top:    box.y * scaleY,
                                  width:  box.w * scaleX,
                                  height: box.h * scaleY,
                                  border: `2px solid ${isSelected ? '#22c55e' : '#f59e0b'}`,
                                  cursor: 'pointer',
                                  boxSizing: 'border-box',
                                  zIndex: 5,
                                }}
                              />
                            );
                          })}
                          {/* Draggable/Resizable Crop Overlay */}
                          {renderCropOverlay()}
                        </div>
                      )}
                    </div>
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
                      disabled={!tempCropBox}
                      onClick={() => {
                        if (pickerMode === 'letterbox') {
                          setLetterboxBg((b) => ({ ...b, crop: 'custom', cropBox: tempCropBox || undefined }));
                        } else {
                          setSelectedBbox(tempCropBox);
                        }
                        setSubjectPickerOpen(false);
                      }}
                      className={cn(
                        'rounded-md bg-accent px-4 py-2 text-xs font-semibold text-accent-foreground',
                        'hover:bg-accent-hover transition-micro',
                        'disabled:opacity-40 disabled:cursor-not-allowed'
                      )}
                    >
                      {pickerMode === 'letterbox' ? 'Confirm Crop' : 'Confirm Subject'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Layout Preset */}
            <div className="flex flex-col gap-2 rounded-md border border-border p-2.5">
              <Label>Layout Preset</Label>

              <div className="grid grid-cols-2 gap-1">
                {([
                  { preset: 'normal'    as LayoutPreset, label: 'Normal',    desc: 'Standard crop' },
                  { preset: 'split'     as LayoutPreset, label: 'Split',     desc: 'Multi-speaker' },
                  { preset: 'game'      as LayoutPreset, label: 'Game',      desc: 'Gameplay+cam'  },
                  { preset: 'letterbox' as LayoutPreset, label: 'Letterbox', desc: 'Fit+bg fill'   },
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

            {/* Letterbox background options */}
            {layoutPreset === 'letterbox' && (
              <div className="flex flex-col gap-2 rounded-md border border-border p-2.5">
                <Label>Letterbox Background</Label>
                <p className="text-[10px] text-text-secondary">
                  Source video fits inside 9:16 canvas. Empty space filled with chosen background.
                </p>

                {/* Video crop ratio */}
                <div className="flex flex-col gap-1">
                  <Label>Video Crop</Label>
                  <div className="grid grid-cols-4 gap-1">
                    {([
                      { crop: 'original' as LetterboxCrop, label: 'Original', desc: '16:9' },
                      { crop: '4:3'      as LetterboxCrop, label: '4:3',      desc: 'Center crop' },
                      { crop: '1:1'      as LetterboxCrop, label: '1:1',      desc: 'Square' },
                      { crop: 'custom'   as LetterboxCrop, label: 'Custom',   desc: 'Your crop' },
                    ] as const).map(({ crop, label, desc }) => (
                      <button
                        key={crop}
                        type="button"
                        onClick={() => {
                          setLetterboxBg((b) => ({ ...b, crop }));
                        }}
                        className={cn(
                          'rounded border px-1 py-1 text-center transition-micro',
                          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                          (letterboxBg.crop ?? 'original') === crop
                            ? 'border-accent bg-accent/10 text-accent'
                            : 'border-border text-text-secondary hover:border-accent/40 hover:text-text-primary'
                        )}
                      >
                        <span className="block text-[10px] font-semibold leading-tight">{label}</span>
                        <span className="block text-[8px] leading-tight opacity-60">{desc}</span>
                      </button>
                    ))}
                  </div>
                  {letterboxBg.crop === 'custom' && (
                    <div className="flex flex-col gap-2 mt-2 border-t border-border/20 pt-2">
                      <div className="flex items-center justify-between">
                        {letterboxBg.cropBox ? (
                          <span className="text-[10px] text-success font-medium">
                            ✓ Crop: {letterboxBg.cropBox.w}x{letterboxBg.cropBox.h} at ({letterboxBg.cropBox.x}, {letterboxBg.cropBox.y})
                          </span>
                        ) : (
                          <span className="text-[10px] text-accent font-medium">Belum ada area crop</span>
                        )}
                        {letterboxBg.cropBox && (
                          <button
                            type="button"
                            onClick={() => setLetterboxBg((b) => ({ ...b, cropBox: undefined }))}
                            className="text-[9px] text-text-secondary hover:text-destructive"
                          >
                            Clear
                          </button>
                        )}
                      </div>

                      <button
                        type="button"
                        onClick={() => void openSubjectPicker('letterbox')}
                        className={cn(
                          'rounded border border-border px-2 py-1.5 text-[10px] text-text-secondary text-center',
                          'hover:border-accent/40 hover:text-text-primary transition-micro'
                        )}
                      >
                        {letterboxBg.cropBox ? '↺ Ubah Area Crop' : '🎯 Pilih Area Crop'}
                      </button>

                      {letterboxBg.cropBox && (
                        <div className="grid grid-cols-4 gap-1 text-[9px] mt-1 text-text-secondary">
                          <div className="flex flex-col">
                            <span>X</span>
                            <input
                              type="number"
                              value={letterboxBg.cropBox.x}
                              onChange={(e) => {
                                const val = Math.max(0, Math.min(pickerImgSize.w, Number(e.target.value)));
                                setLetterboxBg((b) => b.cropBox ? ({ ...b, cropBox: { ...b.cropBox, x: val } }) : b);
                              }}
                              className="rounded border border-border bg-background px-1 py-0.5 text-center text-text-primary focus:outline-none"
                            />
                          </div>
                          <div className="flex flex-col">
                            <span>Y</span>
                            <input
                              type="number"
                              value={letterboxBg.cropBox.y}
                              onChange={(e) => {
                                const val = Math.max(0, Math.min(pickerImgSize.h, Number(e.target.value)));
                                setLetterboxBg((b) => b.cropBox ? ({ ...b, cropBox: { ...b.cropBox, y: val } }) : b);
                              }}
                              className="rounded border border-border bg-background px-1 py-0.5 text-center text-text-primary focus:outline-none"
                            />
                          </div>
                          <div className="flex flex-col">
                            <span>Lebar</span>
                            <input
                              type="number"
                              value={letterboxBg.cropBox.w}
                              onChange={(e) => {
                                const val = Math.max(10, Math.min(pickerImgSize.w, Number(e.target.value)));
                                setLetterboxBg((b) => b.cropBox ? ({ ...b, cropBox: { ...b.cropBox, w: val } }) : b);
                              }}
                              className="rounded border border-border bg-background px-1 py-0.5 text-center text-text-primary focus:outline-none"
                            />
                          </div>
                          <div className="flex flex-col">
                            <span>Tinggi</span>
                            <input
                              type="number"
                              value={letterboxBg.cropBox.h}
                              onChange={(e) => {
                                const val = Math.max(10, Math.min(pickerImgSize.h, Number(e.target.value)));
                                setLetterboxBg((b) => b.cropBox ? ({ ...b, cropBox: { ...b.cropBox, h: val } }) : b);
                              }}
                              className="rounded border border-border bg-background px-1 py-0.5 text-center text-text-primary focus:outline-none"
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* BG type selector */}
                <div className="grid grid-cols-3 gap-1">
                  {([
                    { type: 'blur'  as LetterboxBgType, label: 'Blur',  desc: 'Blurred video' },
                    { type: 'color' as LetterboxBgType, label: 'Color', desc: 'Solid color'   },
                    { type: 'image' as LetterboxBgType, label: 'Image', desc: 'Custom image'  },
                  ] as const).map(({ type, label, desc }) => (
                    <button
                      key={type}
                      type="button"
                      onClick={() => setLetterboxBg((b) => ({ ...b, type }))}
                      className={cn(
                        'rounded border px-1.5 py-1.5 text-center transition-micro',
                        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                        letterboxBg.type === type
                          ? 'border-accent bg-accent/10 text-accent'
                          : 'border-border text-text-secondary hover:border-accent/40 hover:text-text-primary'
                      )}
                    >
                      <span className="block text-[10px] font-semibold leading-tight">{label}</span>
                      <span className="block text-[8px] leading-tight opacity-60">{desc}</span>
                    </button>
                  ))}
                </div>

                {/* Blur: radius slider */}
                {letterboxBg.type === 'blur' && (
                  <NumberInput
                    label={`Blur Radius (${letterboxBg.blurRadius ?? 30})`}
                    value={letterboxBg.blurRadius ?? 30}
                    onChange={(v) => setLetterboxBg((b) => ({ ...b, blurRadius: v }))}
                    min={5} max={100}
                  />
                )}

                {/* Color: color picker */}
                {letterboxBg.type === 'color' && (
                  <ColorSwatch
                    label="Background Color"
                    value={letterboxBg.color ?? '#000000'}
                    onChange={(v) => setLetterboxBg((b) => ({ ...b, color: v }))}
                  />
                )}

                {/* Image: file picker */}
                {letterboxBg.type === 'image' && (
                  <div className="flex flex-col gap-1.5">
                    {letterboxBg.imagePath && (
                      <p className="truncate text-[9px] font-mono text-text-secondary">
                        {letterboxBg.imagePath.split(/[\\/]/).pop()}
                      </p>
                    )}
                    <button
                      type="button"
                      onClick={async () => {
                        const filePath = await ipc.dialog.openFile();
                        if (!filePath) return;
                        setLetterboxBg((b) => ({ ...b, imagePath: filePath }));
                      }}
                      className={cn(
                        'rounded border border-border px-2 py-1.5 text-[10px] text-text-secondary',
                        'hover:border-accent/40 hover:text-text-primary transition-micro'
                      )}
                    >
                      {letterboxBg.imagePath ? '↺ Change Image' : '+ Pick Image'}
                    </button>
                    {!letterboxBg.imagePath && (
                      <p className="text-[9px] text-text-secondary opacity-70">
                        No image selected — will use blur fallback.
                      </p>
                    )}
                  </div>
                )}

              </div>
            )}

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
                  <div className="flex flex-col gap-1">
                    <Label>Anchor Position</Label>
                    <div className="flex gap-1 mb-1">
                      {([
                        { label: 'Top-L',  value: 'top-left' as LogoPosition },
                        { label: 'Top-R',  value: 'top-right' as LogoPosition },
                        { label: 'Center', value: 'center' as LogoPosition },
                        { label: 'Bot-L',  value: 'bottom-left' as LogoPosition },
                        { label: 'Bot-R',  value: 'bottom-right' as LogoPosition },
                      ] as const).map(({ label, value }) => (
                        <button
                          key={value}
                          type="button"
                          onClick={() => setLogo((l) => l ? { ...l, position: value, y: undefined } : l)}
                          className={cn(
                            'flex-1 rounded border px-1 py-1 text-[9px] transition-micro text-center',
                            logo.position === value && logo.y === undefined
                              ? 'border-accent bg-accent/10 text-accent font-semibold'
                              : 'border-border text-text-secondary hover:border-accent/40'
                          )}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="flex flex-col gap-1 border-t border-border/40 pt-1.5">
                    <div className="flex items-center justify-between">
                      <Label>Posisi Y / Tinggi Logo</Label>
                      {logo.y !== undefined && (
                        <button
                          type="button"
                          onClick={() => setLogo((l) => l ? { ...l, y: undefined } : l)}
                          className="text-[9px] text-accent hover:underline"
                        >
                          Reset Auto
                        </button>
                      )}
                    </div>
                    <div className="flex gap-1 mb-1">
                      {([
                        { label: 'Top', y: 40 },
                        { label: 'Mid', y: 960 },
                        { label: 'Bot', y: 1800 },
                      ] as const).map(({ label, y }) => (
                        <button
                          key={label}
                          type="button"
                          onClick={() => setLogo((l) => l ? { ...l, y } : l)}
                          className={cn(
                            'flex-1 rounded border px-1 py-1 text-[9px] transition-micro text-center',
                            logo.y === y
                              ? 'border-accent bg-accent/10 text-accent font-semibold'
                              : 'border-border text-text-secondary hover:border-accent/40'
                          )}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="range"
                        min={0}
                        max={1920}
                        value={
                          logo.y !== undefined
                            ? logo.y
                            : logo.position.includes('bottom')
                            ? 1920 - logo.margin - Math.round(1080 * logo.scale)
                            : logo.position === 'center'
                            ? 960
                            : logo.margin
                        }
                        onChange={(e) => setLogo((l) => l ? { ...l, y: Number(e.target.value) } : l)}
                        aria-label="Logo Y position"
                        className="flex-1 accent-accent"
                      />
                      <span className="w-8 text-right text-[10px] font-mono text-text-secondary">
                        {
                          logo.y !== undefined
                            ? logo.y
                            : Math.round(
                                logo.position.includes('bottom')
                                  ? 1920 - logo.margin - Math.round(1080 * logo.scale)
                                  : logo.position === 'center'
                                  ? 960
                                  : logo.margin
                              )
                        }
                      </span>
                    </div>
                  </div>
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
              <div className="relative mx-auto w-full max-w-[180px] aspect-[9/16] overflow-hidden rounded-md bg-zinc-900 border border-border">
                {thumbnailMode !== 'off' && thumbnailPreview ? (
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
                    <p className="text-[9px] text-zinc-500">
                      {thumbnailMode === 'off' ? 'Thumbnail Off' : 'No thumbnail'}
                    </p>
                  </div>
                )}
                {/* Caption overlay on thumbnail */}
                {thumbnailMode !== 'off' && thumbnailPreview && (
                  <CaptionLivePreview
                    caption={caption}
                    containerWidth={140}
                    containerHeight={249}
                    words={words}
                    startMs={hookStartMs}
                    endMs={hookStartMs ? hookStartMs + 2000 : undefined}
                    captionY={captionY}
                  />
                )}
                {/* Logo overlay on thumbnail */}
                {thumbnailMode !== 'off' && thumbnailPreview && logo && (
                  <LogoLivePreview
                    logo={logo}
                    containerWidth={140}
                    containerHeight={249}
                  />
                )}
              </div>

              {/* Mode selector */}
              <div className="grid grid-cols-3 gap-1">
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
                  <span className="block text-[8px] leading-tight opacity-60">1st sec</span>
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
                  <span className="block text-[8px] leading-tight opacity-60">Upload</span>
                </button>
                <button
                  type="button"
                  onClick={() => setThumbnailMode('off')}
                  className={cn(
                    'rounded border px-1.5 py-1.5 text-center transition-micro',
                    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                    thumbnailMode === 'off'
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-border text-text-secondary hover:border-accent/40 hover:text-text-primary'
                  )}
                >
                  <span className="block text-[10px] font-semibold leading-tight">Off</span>
                  <span className="block text-[8px] leading-tight opacity-60">Disabled</span>
                </button>
              </div>

              {thumbnailMode === 'custom' && customThumbnailPath && (
                <p className="truncate text-[9px] text-text-secondary font-mono">
                  {customThumbnailPath.split(/[\\/]/).pop()}
                </p>
              )}

              {/* Thumbnail Designer Button */}
              <button
                type="button"
                onClick={() => {
                  setDesignerOpen(!designerOpen);
                  if (!designerOpen) {
                    setDesignerOffsetSec(1);
                  }
                }}
                className="mt-1 w-full rounded bg-zinc-800 border border-zinc-700 hover:border-accent/40 text-[10px] font-semibold py-1.5 text-text-primary hover:text-accent transition-micro flex items-center justify-center gap-1"
              >
                <span>🎨</span> {designerOpen ? 'Close Thumbnail Designer' : 'Edit / Generate Hook Thumbnail'}
              </button>

              {/* Thumbnail Designer Panel */}
              {designerOpen && (
                <div className="mt-2 rounded-md border border-border bg-background/50 p-2.5 space-y-3 text-left">
                  <div className="flex items-center justify-between border-b border-border/40 pb-1.5">
                    <span className="text-[9px] font-bold text-accent uppercase tracking-wider">
                      Thumbnail Designer (9:16 Canvas)
                    </span>
                    <button
                      type="button"
                      onClick={() => setDesignerOpen(false)}
                      className="text-[9px] text-text-secondary hover:text-text-primary"
                    >
                      Batal
                    </button>
                  </div>

                  {/* Frame preview and canvas drawing area */}
                  <div className="relative mx-auto w-full max-w-[150px] aspect-[9/16] overflow-hidden rounded bg-black border border-border">
                    {designerLoadingFrame && (
                      <div className="absolute inset-0 bg-black/60 z-10 flex items-center justify-center">
                        <span className="h-4 w-4 animate-spin rounded-full border border-accent border-t-transparent" />
                      </div>
                    )}
                    <canvas
                      ref={designerCanvasRef}
                      width={1080}
                      height={1920}
                      className="h-full w-full object-cover animate-fade-in"
                    />
                  </div>

                  {/* Slider to choose frame seconds */}
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center justify-between text-[9px] text-text-secondary">
                      <span>Pilih Frame Video:</span>
                      <span className="font-mono text-accent">{designerOffsetSec}s</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={Math.max(1, Math.round(((hookEndMs ?? 0) - (hookStartMs ?? 0)) / 1000))}
                      step={0.5}
                      value={designerOffsetSec}
                      onChange={(e) => setDesignerOffsetSec(Number(e.target.value))}
                      className="w-full accent-accent h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
                    />
                  </div>

                  {/* AI Hook Title suggestions */}
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[9px] font-semibold text-text-primary">Judul / Hook Thumbnail:</span>
                      <button
                        type="button"
                        disabled={suggesting}
                        onClick={() => void handleGenerateHookSuggestions()}
                        className="text-[9px] text-accent hover:underline flex items-center gap-1"
                      >
                        {suggesting ? 'Generating…' : '✨ Hook Suggestions'}
                      </button>
                    </div>

                    <textarea
                      value={designerText}
                      onChange={(e) => setDesignerText(e.target.value)}
                      rows={2}
                      placeholder="Masukkan hook judul menarik untuk thumbnail (bisa multi-line)..."
                      className="w-full rounded border border-border bg-background px-2 py-1.5 text-[10px] text-text-primary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent leading-normal"
                    />

                    <div className="flex flex-col gap-1">
                      <button
                        type="button"
                        disabled={generatingAiThumbnail || !designerFrame || !designerText.trim()}
                        onClick={() => void handleGenerateAiThumbnail()}
                        className={cn(
                          "w-full rounded py-1.5 text-[10px] font-bold flex items-center justify-center gap-1.5 transition-micro",
                          "bg-purple-600 hover:bg-purple-700 text-white disabled:opacity-40"
                        )}
                        title={!designerText.trim() ? "Ketik judul/hook terlebih dahulu" : "Generate background"}
                      >
                        {generatingAiThumbnail ? (
                          <>
                            <span className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
                            Generating Background…
                          </>
                        ) : '✨ Generate Background (Imagen)'}
                      </button>
                      {aiThumbnailError && (
                        <p className="text-[9px] text-destructive leading-normal mt-0.5">{aiThumbnailError}</p>
                      )}
                    </div>

                    {suggestedHooks.length > 0 && (
                      <div className="flex flex-col gap-1">
                        <span className="text-[8px] text-text-secondary uppercase tracking-wider font-bold">Rekomendasi:</span>
                        <div className="flex flex-wrap gap-1">
                          {suggestedHooks.map((h, i) => (
                            <button
                              key={i}
                              type="button"
                              onClick={() => setDesignerText(h)}
                              className="text-[9px] text-left border border-border/80 hover:border-accent/40 rounded px-1.5 py-0.5 bg-zinc-800 hover:bg-zinc-800/80 text-text-secondary hover:text-text-primary transition-micro font-mono"
                            >
                              {h.replace('\n', ' ')}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Text Style Controls */}
                  <div className="grid grid-cols-2 gap-2 text-[9px] border-t border-border/20 pt-2.5">
                    <div className="flex flex-col gap-1">
                      <span>Font Style:</span>
                      <select
                        value={designerFont}
                        onChange={(e) => setDesignerFont(e.target.value as CaptionFont)}
                        className="rounded border border-border bg-background px-1 py-1 text-[9px] text-text-primary focus:outline-none"
                      >
                        {FONT_OPTIONS.map((f) => (
                          <option key={f} value={f}>{f}</option>
                        ))}
                      </select>
                    </div>

                    <div className="flex flex-col gap-1">
                      <span>Text Position (Y):</span>
                      <input
                        type="range"
                        min={100}
                        max={1800}
                        value={designerY}
                        onChange={(e) => setDesignerY(Number(e.target.value))}
                        className="w-full accent-accent h-1"
                      />
                    </div>

                    <div className="flex flex-col gap-1">
                      <span>Warna Teks:</span>
                      <div className="flex gap-1.5 items-center">
                        {(['#FFFF00', '#FFFFFF', '#FF0000', '#00FFFF'] as const).map((color) => (
                          <button
                            key={color}
                            type="button"
                            onClick={() => setDesignerColor(color)}
                            style={{ backgroundColor: color }}
                            className={cn(
                              'h-3.5 w-3.5 rounded border transition-micro',
                              designerColor === color ? 'border-accent scale-110 ring-1 ring-accent' : 'border-zinc-600'
                            )}
                          />
                        ))}
                      </div>
                    </div>

                    <div className="flex flex-col gap-1">
                      <span>Ukuran Teks / Outline:</span>
                      <div className="flex items-center gap-1.5">
                        <input
                          type="range"
                          min={40}
                          max={160}
                          value={designerFontSize}
                          onChange={(e) => setDesignerFontSize(Number(e.target.value))}
                          className="w-16 accent-accent h-1"
                          title="Font Size"
                        />
                        <input
                          type="range"
                          min={0}
                          max={12}
                          value={designerOutlineSize}
                          onChange={(e) => setDesignerOutlineSize(Number(e.target.value))}
                          className="w-12 accent-accent h-1"
                          title="Outline size"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex justify-end gap-1.5 border-t border-border/20 pt-2.5">
                    <button
                      type="button"
                      onClick={() => setDesignerOpen(false)}
                      className="rounded border border-border px-2.5 py-1 text-[9px] text-text-secondary hover:border-accent/40 hover:text-text-primary"
                    >
                      Batal
                    </button>
                    <button
                      type="button"
                      disabled={savingThumbnail || !designerFrame}
                      onClick={() => void handleSaveThumbnail()}
                      className="rounded bg-accent px-2.5 py-1 text-[9px] font-semibold text-accent-foreground hover:bg-accent/90 flex items-center gap-1"
                    >
                      {savingThumbnail && <span className="h-2 w-2 animate-spin rounded-full border border-accent-foreground border-t-transparent" />}
                      Simpan & Terapkan
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Translate Caption */}
            <div className="flex flex-col gap-2 rounded-md border border-border p-2.5">
              <div className="flex items-center justify-between">
                <Label>Translate Caption</Label>
                {translateStatus === 'done' && (
                  <span className="text-[9px] text-success">✓ Done</span>
                )}
                {translateStatus === 'error' && (
                  <span className="text-[9px] text-destructive">✗ Failed</span>
                )}
              </div>

              <div className="flex gap-1.5">
                <select
                  value={translateLang}
                  onChange={(e) => { setTranslateLang(e.target.value); setTranslateStatus('idle'); }}
                  aria-label="Target language"
                  disabled={translating}
                  className={cn(
                    'flex-1 rounded border border-border bg-background px-2 py-1 text-[11px] text-text-primary',
                    'focus:outline-none focus:ring-1 focus:ring-accent',
                    'disabled:opacity-40'
                  )}
                >
                  {TRANSLATE_LANGS.map(({ code, label }) => (
                    <option key={code} value={code}>{label}</option>
                  ))}
                </select>

                <button
                  type="button"
                  disabled={translating || !clip?.projectId}
                  onClick={() => void handleTranslate()}
                  className={cn(
                    'rounded border px-2.5 py-1 text-[10px] font-semibold transition-micro',
                    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                    translating
                      ? 'border-accent/40 bg-accent/10 text-accent cursor-wait'
                      : 'border-accent bg-accent text-accent-foreground hover:bg-accent-hover',
                    'disabled:opacity-40 disabled:cursor-not-allowed'
                  )}
                >
                  {translating ? (
                    <span className="flex items-center gap-1">
                      <span className="h-2.5 w-2.5 animate-spin rounded-full border border-accent/40 border-t-accent" />
                      …
                    </span>
                  ) : '🌐 Go'}
                </button>

                <button
                  type="button"
                  disabled={translating}
                  onClick={() => void handleResetTranslation()}
                  title="Reset caption to original language"
                  className={cn(
                    'rounded border border-border px-2 py-1 text-[10px] font-medium transition-micro',
                    'text-text-secondary hover:border-accent/40 hover:text-text-primary',
                    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                    'disabled:opacity-40 disabled:cursor-not-allowed'
                  )}
                >
                  ↩ Reset
                </button>
              </div>

              {translateMsg && (
                <p className={cn(
                  'text-[9px]',
                  translateStatus === 'done'  ? 'text-success' : 'text-destructive'
                )}>
                  {translateMsg}
                </p>
              )}

              <p className="text-[9px] text-text-secondary opacity-70">
                Translates words in clip duration. Reset restores original language.
              </p>
            </div>

            {/* Generate */}
            <button
              type="button"
              disabled={isProcessing || (trackingMode === 'manual' && !selectedBbox)}
              onClick={() => void regenerate(trackingMode !== 'none' && (trackingMode !== 'auto' || zoomEnabled), caption)}
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
      {/* Save Preset Modal */}
      {showSavePresetModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-xs rounded-xl border border-border bg-[#18181b] p-4 shadow-2xl flex flex-col gap-3">
            <h3 className="text-xs font-bold text-text-primary">✨ Simpan Preset Tampilan</h3>
            <p className="text-[11px] text-text-secondary">
              Simpan 15+ pengaturan tampilan saat ini (caption, font, posisi, layout, logo, background, dll) dengan nama pilihan Anda.
            </p>
            <input
              type="text"
              value={presetNameInput}
              onChange={(e) => setPresetNameInput(e.target.value)}
              placeholder="Contoh: Podcast Cyan, Gaming Split..."
              className="w-full rounded border border-border bg-background px-2.5 py-1.5 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
              autoFocus
            />
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => { setShowSavePresetModal(false); setPresetNameInput(''); }}
                className="rounded border border-border px-3 py-1 text-xs text-text-secondary hover:bg-border/40"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={handleSavePresetSubmit}
                disabled={!presetNameInput.trim()}
                className="rounded bg-accent px-3.5 py-1 text-xs font-semibold text-white hover:bg-accent/90 disabled:opacity-40"
              >
                Simpan
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
