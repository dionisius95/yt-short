'use client';

/**
 * useIpc — generic hook for invoking IPC channels from the renderer.
 * Wraps window.electron.invoke with React state management.
 * Full implementation in the renderer UI tasks.
 */
import { useState, useCallback } from 'react';

export interface UseIpcState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

/**
 * Hook for making IPC invoke calls with loading/error state.
 */
export function useIpc<T>(channel: string) {
  const [state, setState] = useState<UseIpcState<T>>({
    data: null,
    loading: false,
    error: null,
  });

  const invoke = useCallback(
    async (...args: unknown[]): Promise<T | null> => {
      setState((prev) => ({ ...prev, loading: true, error: null }));
      try {
        const result = await window.electron.invoke(channel, ...args) as T;
        setState({ data: result, loading: false, error: null });
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setState((prev) => ({ ...prev, loading: false, error: message }));
        return null;
      }
    },
    [channel]
  );

  return { ...state, invoke };
}
