'use client';

import { useState, useCallback, useRef } from 'react';

export interface Toast {
  id: string;
  message: string;
  variant: 'success' | 'error' | 'info';
  autoDismiss: boolean; // false for errors
}

export interface UseToastReturn {
  toasts: Toast[];
  showToast: (message: string, variant: Toast['variant'], autoDismiss?: boolean) => void;
  dismissToast: (id: string) => void;
}

/** Auto-dismiss delay for success and info toasts (ms). */
const AUTO_DISMISS_DELAY = 3000;

/**
 * useToast — manages a stack of non-blocking toast notifications.
 *
 * - Success toasts auto-dismiss after 3 seconds.
 * - Error toasts persist until manually dismissed.
 * - Info toasts auto-dismiss after 3 seconds by default.
 *
 * Requirements: 11.6, 11.7
 */
export function useToast(): UseToastReturn {
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Track active timers so we can clear them if a toast is manually dismissed
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismissToast = useCallback((id: string) => {
    // Clear any pending auto-dismiss timer for this toast
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback(
    (message: string, variant: Toast['variant'], autoDismiss?: boolean) => {
      // Default: errors persist, success/info auto-dismiss
      const shouldAutoDismiss =
        autoDismiss !== undefined ? autoDismiss : variant !== 'error';

      const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

      const toast: Toast = {
        id,
        message,
        variant,
        autoDismiss: shouldAutoDismiss,
      };

      setToasts((prev) => [...prev, toast]);

      if (shouldAutoDismiss) {
        const timer = setTimeout(() => {
          timers.current.delete(id);
          setToasts((prev) => prev.filter((t) => t.id !== id));
        }, AUTO_DISMISS_DELAY);
        timers.current.set(id, timer);
      }
    },
    []
  );

  return { toasts, showToast, dismissToast };
}
