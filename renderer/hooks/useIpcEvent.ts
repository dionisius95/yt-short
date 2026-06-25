'use client';

/**
 * useIpcEvent — generic hook for subscribing to IPC push events from the main process.
 *
 * Wraps `window.electron.on()` in a `useEffect`, stores the returned unsubscribe
 * function, and calls it during cleanup to prevent memory leaks.
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6
 */
import { useEffect, useRef } from 'react';

/**
 * Subscribe to an IPC push-event channel and invoke `handler` whenever the
 * main process emits on that channel.
 *
 * The subscription is established on mount (or whenever `channel` or `deps`
 * change) and torn down on unmount / before the next effect run, satisfying
 * Requirement 9.6: the unsubscribe function returned by `window.electron.on`
 * is always called during the React cleanup phase.
 *
 * @param channel - The IPC channel name to subscribe to (must be in the
 *                  preload SUBSCRIBE_ALLOWLIST, e.g. `'download:progress'`).
 * @param handler - Callback invoked with the typed event payload each time
 *                  the main process emits on `channel`.
 * @param deps    - Optional additional dependency array. When any value in
 *                  this array changes the subscription is torn down and
 *                  re-established with the latest `handler`. Defaults to `[]`.
 */
export function useIpcEvent<T>(
  channel: string,
  handler: (data: T) => void,
  deps: React.DependencyList = []
): void {
  // Keep a stable ref to the latest handler so the effect does not need to
  // re-subscribe every time the handler identity changes (e.g. inline arrow
  // functions defined in the component body).
  const handlerRef = useRef<(data: T) => void>(handler);
  handlerRef.current = handler;

  useEffect(() => {
    // Guard: window.electron may not be available in non-Electron environments
    // (e.g. during SSR or unit tests that don't mock the bridge).
    if (typeof window === 'undefined' || !window.electron) {
      return;
    }

    const listener = (data: T) => {
      handlerRef.current(data);
    };

    const unsubscribe = window.electron.on(
      channel,
      listener as (...args: unknown[]) => void
    );

    // Cleanup: call the unsubscribe function returned by window.electron.on
    // so the IPC listener is removed when the component unmounts or the
    // channel / deps change (Requirement 9.6).
    return () => {
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, ...deps]);
}
