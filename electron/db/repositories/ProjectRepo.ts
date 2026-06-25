/**
 * ProjectRepo — CRUD operations for the projects table.
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type { Project, ProjectDashboardItem } from '../../../shared/types';

export class ProjectRepo {
  constructor(private readonly db: Database.Database) {}

  /**
   * Insert a new project row and return the full record with its generated id.
   */
  insert(project: Omit<Project, 'id'>): Project {
    const id = randomUUID();
    const stmt = this.db.prepare<[
      string, string, string, string, number,
      string | null, string, string, number, number
    ]>(`
      INSERT INTO projects
        (id, source_url, title, file_path, duration_ms,
         thumbnail, language, quality, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      project.sourceUrl,
      project.title,
      project.filePath,
      project.durationMs,
      project.thumbnail ?? null,
      project.language,
      project.quality,
      project.createdAt,
      project.updatedAt
    );

    return { id, ...project };
  }

  /**
   * Find a single project by its UUID. Returns null when not found.
   */
  findById(id: string): Project | null {
    const row = this.db
      .prepare<[string]>(`
        SELECT id, source_url, title, file_path, duration_ms,
               thumbnail, language, quality, created_at, updated_at
        FROM projects
        WHERE id = ?
      `)
      .get(id) as RawProject | undefined;

    return row ? mapRow(row) : null;
  }

  /**
   * Returns a lightweight list of projects for the dashboard, including
   * clip count and export count (clips with a non-null youtube_url).
   */
  listForDashboard(): ProjectDashboardItem[] {
    const rows = this.db
      .prepare(`
        SELECT
          p.id,
          p.title,
          p.thumbnail,
          p.created_at,
          COUNT(DISTINCT c.id)                                        AS clip_count,
          COUNT(DISTINCT CASE WHEN c.youtube_url IS NOT NULL THEN c.id END) AS export_count
        FROM projects p
        LEFT JOIN clips c ON c.project_id = p.id
        GROUP BY p.id
        ORDER BY p.created_at DESC
      `)
      .all() as RawDashboard[];

    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      thumbnail: r.thumbnail ?? null,
      createdAt: r.created_at,
      clipCount: r.clip_count,
      exportCount: r.export_count,
    }));
  }

  /**
   * Partially update a project row. Only the supplied fields are changed.
   */
  update(id: string, data: Partial<Project>): void {
    const fieldMap: Record<string, string> = {
      sourceUrl: 'source_url',
      title: 'title',
      filePath: 'file_path',
      durationMs: 'duration_ms',
      thumbnail: 'thumbnail',
      language: 'language',
      quality: 'quality',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    };

    const setClauses: string[] = [];
    const values: unknown[] = [];

    for (const [key, col] of Object.entries(fieldMap)) {
      if (key in data) {
        setClauses.push(`${col} = ?`);
        values.push((data as Record<string, unknown>)[key] ?? null);
      }
    }

    if (setClauses.length === 0) return;

    values.push(id);
    this.db
      .prepare(`UPDATE projects SET ${setClauses.join(', ')} WHERE id = ?`)
      .run(...values);
  }

  /**
   * Delete a project by id. Cascade deletes transcripts, hooks, and clips
   * via the ON DELETE CASCADE foreign keys defined in the schema.
   */
  delete(id: string): void {
    this.db.prepare<[string]>('DELETE FROM projects WHERE id = ?').run(id);
  }
}

// ---------------------------------------------------------------------------
// Internal row shapes returned by better-sqlite3
// ---------------------------------------------------------------------------

interface RawProject {
  id: string;
  source_url: string;
  title: string;
  file_path: string;
  duration_ms: number;
  thumbnail: string | null;
  language: string;
  quality: string;
  created_at: number;
  updated_at: number;
}

interface RawDashboard {
  id: string;
  title: string;
  thumbnail: string | null;
  created_at: number;
  clip_count: number;
  export_count: number;
}

function mapRow(r: RawProject): Project {
  return {
    id: r.id,
    sourceUrl: r.source_url,
    title: r.title,
    filePath: r.file_path,
    durationMs: r.duration_ms,
    thumbnail: r.thumbnail,
    language: r.language,
    quality: r.quality as Project['quality'],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
