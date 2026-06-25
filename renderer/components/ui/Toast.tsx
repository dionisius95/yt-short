'use client';

import { useEffect, useRef } from 'react';
import { cn } from '../../lib/utils';
import type { Toast as ToastItem } from '../../hooks/useToast';

// ---------------------------------------------------------------------------
// Individual Toast item
// ---------------------------------------------------------------------------

interface ToastProps {
  toast: ToastItem;
  onDismiss: (id: string) => void;
}

const variantStyles: Record<ToastItem['variant'], string> = {
  success: 'border-success/40 bg-surface text-text-primary',
  error: 'border-destructive/40 bg-surface text-text-primary',
  info: 'border-accent/40 bg-surface text-text-primary',
};

const iconMap: Record<ToastItem['variant'], string> = {
  success: '✓',
  error: '✕',
  info: 'ℹ',
};

const iconColorMap: Record<ToastItem['variant'], string> = {
  success: 'text-success',
  error: 'text-destructive',
  info: 'text-accent',
};

function ToastItem({ toast, onDismiss }: ToastProps) {
  const dismissRef = useRef<HTMLButtonElement>(null);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={cn(
        'flex items-start gap-3 rounded-lg border px-4 py-3 shadow-lg',
        'animate-fade-in transition-micro',
        'min-w-[280px] max-w-[420px]',
        variantStyles[toast.variant]
      )}
    >
      {/* Variant icon */}
      <span
        className={cn('mt-0.5 shrink-0 text-sm font-bold', iconColorMap[toast.variant])}
        aria-hidden="true"
      >
        {iconMap[toast.variant]}
      </span>

      {/* Message */}
      <p className="flex-1 text-sm leading-snug text-text-primary">{toast.message}</p>

      {/* Dismiss button */}
      <button
        ref={dismissRef}
        type="button"
        aria-label="Dismiss notification"
        onClick={() => onDismiss(toast.id)}
        className={cn(
          'ml-1 shrink-0 rounded-sm p-0.5 text-text-secondary',
          'hover:text-text-primary',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          'transition-micro'
        )}
      >
        {/* Close × */}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toast container — fixed-position stack
// ---------------------------------------------------------------------------

interface ToastContainerProps {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}

/**
 * Toast — renders a fixed-position stack of toast notifications in the
 * bottom-right corner of the viewport.
 *
 * Usage: render once at the root layout level and pass `toasts` / `onDismiss`
 * from `useToast()`.
 *
 * Requirements: 11.6, 11.7
 */
export function Toast({ toasts, onDismiss }: ToastContainerProps) {
  // Announce to screen readers when new toasts arrive
  const regionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Nothing extra needed — each ToastItem already has role="status" + aria-live
  }, [toasts]);

  if (toasts.length === 0) return null;

  return (
    <div
      ref={regionRef}
      aria-label="Notifications"
      className={cn(
        'fixed bottom-4 right-4 z-50',
        'flex flex-col gap-2',
        'pointer-events-none' // container itself is not interactive
      )}
    >
      {toasts.map((toast) => (
        // Each item re-enables pointer events
        <div key={toast.id} className="pointer-events-auto">
          <ToastItem toast={toast} onDismiss={onDismiss} />
        </div>
      ))}
    </div>
  );
}
