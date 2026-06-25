'use client';

/**
 * ProjectCard — displays a single project in the Dashboard grid.
 * Requirements: 2.5, 2.6, 2.8, 2.9, 12.1, 12.3
 */

import Image from 'next/image';
import { useConfirm } from '../../hooks/useConfirm';
import { StatusBadge } from '../ui/StatusBadge';
import { formatRelativeTime } from '../../lib/formatters';
import { ipc } from '../../lib/ipc-client';
import type { ProjectDashboardItem } from '../../../shared/types';
import { cn } from '../../lib/utils';

interface ProjectCardProps {
  project: ProjectDashboardItem;
  onSelect: (id: string) => void;
  onDeleted: (id: string) => void;
}

function FilmIcon() {
  return (
    <svg
      width="32" height="32" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      className="text-text-secondary" aria-hidden="true"
    >
      <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/>
      <line x1="7" y1="2" x2="7" y2="22"/>
      <line x1="17" y1="2" x2="17" y2="22"/>
      <line x1="2" y1="12" x2="22" y2="12"/>
      <line x1="2" y1="7" x2="7" y2="7"/>
      <line x1="2" y1="17" x2="7" y2="17"/>
      <line x1="17" y1="17" x2="22" y2="17"/>
      <line x1="17" y1="7" x2="22" y2="7"/>
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="3 6 5 6 21 6"/>
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
      <path d="M10 11v6"/>
      <path d="M14 11v6"/>
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
    </svg>
  );
}

export function ProjectCard({ project, onSelect, onDeleted }: ProjectCardProps) {
  const { confirm, ConfirmDialogNode } = useConfirm();

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = await confirm({
      title: 'Delete project?',
      description: `"${project.title}" and all its clips will be permanently removed. This action cannot be undone.`,
      confirmLabel: 'Delete',
      cancelLabel: 'Keep',
      destructive: true,
    });
    if (!ok) return;
    try {
      await ipc.projects.delete(project.id);
      onDeleted(project.id);
    } catch {
      // silently ignore — parent can re-fetch
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(project.id);
    }
  };

  return (
    <>
      {ConfirmDialogNode}
      <div
        role="button"
        tabIndex={0}
        aria-label={`Open project: ${project.title}`}
        onClick={() => onSelect(project.id)}
        onKeyDown={handleKeyDown}
        className={cn(
          'surface group relative flex cursor-pointer flex-col overflow-hidden',
          'transition-micro hover:border-accent/40 hover:shadow-lg',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'
        )}
      >
        {/* Thumbnail */}
        <div className="relative aspect-video w-full overflow-hidden bg-border">
          {project.thumbnail ? (
            <Image
              src={project.thumbnail}
              alt={`Thumbnail for ${project.title}`}
              fill
              className="object-cover transition-micro group-hover:scale-[1.02]"
              sizes="(max-width: 768px) 100vw, 33vw"
            />
          ) : (
            <div className="flex h-full items-center justify-center">
              <FilmIcon />
            </div>
          )}

          {/* Clip count badge overlay */}
          <div className="absolute bottom-2 right-2 rounded-sm bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">
            {project.clipCount} clip{project.clipCount !== 1 ? 's' : ''}
          </div>
        </div>

        {/* Body */}
        <div className="flex flex-1 flex-col gap-1.5 p-4">
          <p
            className="line-clamp-2 text-sm font-medium leading-snug text-text-primary"
            title={project.title}
          >
            {project.title}
          </p>

          <div className="mt-auto flex items-center justify-between pt-2">
            <StatusBadge
              variant={project.exportCount > 0 ? 'complete' : 'pending'}
              label={project.exportCount > 0 ? `${project.exportCount} exported` : 'No exports'}
            />
            <span className="text-[11px] text-text-secondary font-mono">
              {formatRelativeTime(project.createdAt)}
            </span>
          </div>
        </div>

        {/* Delete button — appears on hover */}
        <button
          type="button"
          aria-label={`Delete project: ${project.title}`}
          onClick={handleDelete}
          className={cn(
            'absolute right-2 top-2 rounded-md p-1.5',
            'bg-black/60 text-white backdrop-blur-sm',
            'opacity-0 transition-micro group-hover:opacity-100',
            'hover:bg-destructive focus-visible:opacity-100',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'
          )}
        >
          <TrashIcon />
        </button>
      </div>
    </>
  );
}
