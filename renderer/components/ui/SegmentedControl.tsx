'use client';

/**
 * SegmentedControl — multi-option selector with keyboard navigation.
 * Requirements: 3.5, 8.3, 6.4, 6.5
 */

import { useRef } from 'react';
import { cn } from '../../lib/utils';

export interface SegmentedOption {
  value: string;
  label: string;
}

interface SegmentedControlProps {
  options: SegmentedOption[];
  value: string;
  onChange: (value: string) => void;
  id?: string;
  className?: string;
  'aria-label'?: string;
}

export function SegmentedControl({
  options,
  value,
  onChange,
  id,
  className,
  'aria-label': ariaLabel,
}: SegmentedControlProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const handleKeyDown = (e: React.KeyboardEvent, optionValue: string) => {
    const idx = options.findIndex((o) => o.value === optionValue);
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      const next = options[(idx + 1) % options.length];
      onChange(next.value);
      // Focus the next button
      const btns = containerRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
      btns?.[(idx + 1) % options.length]?.focus();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = options[(idx - 1 + options.length) % options.length];
      onChange(prev.value);
      const btns = containerRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
      btns?.[(idx - 1 + options.length) % options.length]?.focus();
    }
  };

  return (
    <div
      ref={containerRef}
      id={id}
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        'inline-flex rounded-md border border-border bg-background p-0.5',
        className
      )}
    >
      {options.map((option) => {
        const isSelected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={isSelected}
            tabIndex={isSelected ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(e) => handleKeyDown(e, option.value)}
            className={cn(
              'rounded px-3 py-1.5 text-xs font-medium transition-micro',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              isSelected
                ? 'bg-accent text-accent-foreground shadow-sm'
                : 'text-text-secondary hover:text-text-primary'
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
