'use client';

import { useRouter } from 'next/navigation';
import { ProjectCard } from './ProjectCard';
import { ProjectCardSkeleton } from './ProjectCardSkeleton';
import { electronNavigate } from '../../lib/isElectron';
import type { ProjectDashboardItem } from '../../../shared/types';

interface ProjectGridProps {
  projects: ProjectDashboardItem[];
  loading: boolean;
  onDeleted: (id: string) => void;
  emptyState: React.ReactNode;
}

export function ProjectGrid({ projects, loading, onDeleted, emptyState }: ProjectGridProps) {
  const router = useRouter();

  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <ProjectCardSkeleton key={i} />
        ))}
      </div>
    );
  }

  if (projects.length === 0) {
    return emptyState;
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {projects.map((project) => (
        <ProjectCard
          key={project.id}
          project={project}
          onSelect={(id) =>
            electronNavigate(router, `/project/${id}`, {
              key: 'pendingProjectId',
              value: id,
            })
          }
          onDeleted={onDeleted}
        />
      ))}
    </div>
  );
}
