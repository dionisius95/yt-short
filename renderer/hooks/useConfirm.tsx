'use client';

/**
 * useConfirm — hook that provides a promise-based confirmation dialog.
 *
 * Returns:
 *   - `confirm(options)` — opens the dialog and returns a Promise<boolean>
 *     that resolves to `true` when the user confirms, `false` when they cancel.
 *   - `ConfirmDialogNode` — the React node to render in the component tree
 *     (typically placed near the root of the component that uses this hook).
 *
 * Requirements: 11.8, 12.8
 */

import React, { useState, useCallback, useRef } from 'react';
import type { ReactNode } from 'react';
import { ConfirmDialog, type ConfirmDialogOptions } from '../components/ui/ConfirmDialog';

export interface UseConfirmReturn {
  /** Open the confirmation dialog. Resolves true on confirm, false on cancel. */
  confirm: (options: ConfirmDialogOptions) => Promise<boolean>;
  /** Render this node in your JSX to mount the dialog. */
  ConfirmDialogNode: ReactNode;
}

export function useConfirm(): UseConfirmReturn {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<ConfirmDialogOptions>({
    title: 'Are you sure?',
    description: '',
  });

  // Holds the resolve function of the currently pending promise.
  const resolveRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback((opts: ConfirmDialogOptions): Promise<boolean> => {
    setOptions(opts);
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
    });
  }, []);

  const handleConfirm = useCallback(() => {
    setOpen(false);
    resolveRef.current?.(true);
    resolveRef.current = null;
  }, []);

  const handleCancel = useCallback(() => {
    setOpen(false);
    resolveRef.current?.(false);
    resolveRef.current = null;
  }, []);

  const ConfirmDialogNode: ReactNode = (
    <ConfirmDialog
      open={open}
      options={options}
      onConfirm={handleConfirm}
      onCancel={handleCancel}
    />
  );

  return { confirm, ConfirmDialogNode };
}
