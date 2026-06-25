'use client';

/**
 * VideoModal — fullscreen 9:16 video preview overlay.
 * Closes on Escape, backdrop click, or close button.
 */

import { useEffect, useRef } from 'react';
import { cn } from '../../lib/utils';

interface VideoModalProps {
  src: string;
  title?: string;
  onClose: () => void;
}

export function VideoModal({ src, title, onClose }: VideoModalProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Auto-play on open
  useEffect(() => {
    videoRef.current?.play().catch(() => {/* ignore autoplay block */});
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title ?? 'Clip preview'}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      {/* Stop propagation so clicking video doesn't close */}
      <div
        className="relative flex flex-col items-center gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close button */}
        <button
          type="button"
          aria-label="Close preview"
          onClick={onClose}
          className={cn(
            'absolute -top-10 right-0 rounded-full p-1.5',
            'text-white/70 hover:text-white transition-micro',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50'
          )}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>

        {/* 9:16 video — max height 85vh */}
        <div className="relative overflow-hidden rounded-xl shadow-2xl"
          style={{ height: 'min(85vh, 640px)', aspectRatio: '9/16' }}>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video
            ref={videoRef}
            src={src}
            controls
            loop
            playsInline
            className="h-full w-full object-cover"
            aria-label={title ?? 'Clip preview'}
          />
        </div>

        {title && (
          <p className="max-w-xs text-center text-sm text-white/70 line-clamp-2">{title}</p>
        )}
      </div>
    </div>
  );
}
