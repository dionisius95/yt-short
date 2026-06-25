'use client';

/**
 * ConfirmDialog — modal confirmation dialog for destructive actions.
 *
 * Behaviour:
 *   - Traps keyboard focus within the dialog while open (Requirement 12.8).
 *   - Returns focus to the element that triggered the dialog when closed (Requirement 12.8).
 *   - Closes on Escape key press (cancels the action).
 *   - Uses the native HTML <dialog> element for built-in accessibility semantics.
 *
 * Requirements: 11.8, 12.8
 */

import React, {
  useEffect,
  useRef,
  useCallback,
} from 'react';
import { cn } from '../../lib/utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConfirmDialogOptions {
  /** Dialog heading text. */
  title: string;
  /** Descriptive body text explaining the consequences of the action. */
  description: string;
  /** Label for the confirm button. Defaults to "Confirm". */
  confirmLabel?: string;
  /** Label for the cancel button. Defaults to "Cancel". */
  cancelLabel?: string;
  /** When true the confirm button uses destructive (red) styling. Defaults to true. */
  destructive?: boolean;
}

interface ConfirmDialogProps {
  open: boolean;
  options: ConfirmDialogOptions;
  onConfirm: () => void;
  onCancel: () => void;
}

// ---------------------------------------------------------------------------
// Focusable element selector used for focus trapping
// ---------------------------------------------------------------------------

const FOCUSABLE_SELECTORS = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ConfirmDialog({
  open,
  options,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const {
    title,
    description,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    destructive = true,
  } = options;

  const dialogRef = useRef<HTMLDialogElement>(null);
  // Remember which element had focus before the dialog opened so we can
  // restore it when the dialog closes (Requirement 12.8).
  const previousFocusRef = useRef<Element | null>(null);

  // Open / close the native <dialog> element and manage focus.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      previousFocusRef.current = document.activeElement;
      if (!dialog.open) {
        dialog.showModal();
      }
      // Move focus to the cancel button (safe default for destructive dialogs).
      const cancelBtn = dialog.querySelector<HTMLButtonElement>(
        '[data-confirm-cancel]'
      );
      cancelBtn?.focus();
    } else {
      if (dialog.open) {
        dialog.close();
      }
      // Restore focus to the triggering element.
      if (
        previousFocusRef.current &&
        previousFocusRef.current instanceof HTMLElement
      ) {
        previousFocusRef.current.focus();
        previousFocusRef.current = null;
      }
    }
  }, [open]);

  // Trap focus inside the dialog (Requirement 12.8).
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDialogElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
        return;
      }

      if (e.key !== 'Tab') return;

      const dialog = dialogRef.current;
      if (!dialog) return;

      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS)
      ).filter((el) => !el.closest('[hidden]'));

      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey) {
        // Shift+Tab — wrap from first to last.
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        // Tab — wrap from last to first.
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    [onCancel]
  );

  // Clicking the backdrop (the <dialog> element itself, outside the panel)
  // cancels the dialog.
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent<HTMLDialogElement>) => {
      if (e.target === dialogRef.current) {
        onCancel();
      }
    },
    [onCancel]
  );

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="confirm-dialog-title"
      aria-describedby="confirm-dialog-description"
      aria-modal="true"
      onKeyDown={handleKeyDown}
      onClick={handleBackdropClick}
      className={cn(
        // Reset browser default <dialog> styles
        'p-0 bg-transparent border-0 outline-none',
        // Backdrop overlay
        'backdrop:bg-black/60 backdrop:backdrop-blur-sm',
        // Ensure it sits above everything
        'z-50'
      )}
    >
      {/* Dialog panel */}
      <div
        className={cn(
          'surface',                          // bg-surface + border + rounded-lg
          'w-full max-w-md mx-auto',
          'p-6',
          'flex flex-col gap-4',
          'animate-fade-in'
        )}
      >
        {/* Title */}
        <h2
          id="confirm-dialog-title"
          className="text-text-primary text-lg font-semibold leading-tight"
        >
          {title}
        </h2>

        {/* Description */}
        {description && (
          <p
            id="confirm-dialog-description"
            className="text-text-secondary text-sm leading-relaxed"
          >
            {description}
          </p>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-3 pt-2">
          {/* Cancel button — focused by default */}
          <button
            type="button"
            data-confirm-cancel
            onClick={onCancel}
            className={cn(
              'px-4 py-2 rounded-md text-sm font-medium',
              'bg-surface border border-border text-text-primary',
              'hover:bg-border',
              'transition-micro duration-micro',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'
            )}
          >
            {cancelLabel}
          </button>

          {/* Confirm button */}
          <button
            type="button"
            data-confirm-action
            onClick={onConfirm}
            className={cn(
              'px-4 py-2 rounded-md text-sm font-medium',
              destructive
                ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                : 'bg-accent text-accent-foreground hover:bg-accent-hover',
              'transition-micro duration-micro',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'
            )}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
