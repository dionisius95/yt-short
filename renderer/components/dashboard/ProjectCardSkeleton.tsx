'use client';

/**
 * ProjectCardSkeleton — animated pulse placeholder matching ProjectCard dimensions.
 * Requirements: 2.1, 2.2
 */

import { cn } from '../../lib/utils';

function SkeletonLine({ className }: { className?: string }) {
  return (
    <div className={cn('animate-pulse rounded bg-border', className)} />
  );
}

export function ProjectCardSkeleton() {
  return (
    <div className="surface flex flex-col overflow-hidden" aria-hidden="true">
      {/* Thumbnail placeholder */}
      <div className="aspect-video w-full animate-pulse bg-border" />

      {/* Body */}
      <div className="flex flex-col gap-2 p-4">
        <SkeletonLine className="h-4 w-3/4" />
        <SkeletonLine className="h-3 w-1/2" />
        <div className="mt-1 flex items-center justify-between">
          <SkeletonLine className="h-5 w-16 rounded-sm" />
          <SkeletonLine className="h-3 w-20" />
        </div>
      </div>
    </div>
  );
}
