/**
 * HookRepo — CRUD operations for the hooks table.
 */

import Database from 'better-sqlite3';
import type { Hook } from '../../../shared/types';

type InsertInput = {
  id: string;
  projectId: string;
  startMs: number;
  endMs: number;
  viralScore: number;
  summary: string;
};

export class HookRepo {
  constructor(private readonly db: Database.Database) {}

  /**
   * Delete all hooks for a project (used before re-inserting from analysis).
   */
  deleteByProjectId(projectId: string): void {
    this.db.prepare<[string]>('DELETE FROM hooks WHERE project_id = ?').run(projectId);
  }
  insertMany(hooks: InsertInput[]): void {
    const stmt = this.db.prepare<[
      string, string, number, number, number, string, number
    ]>(`
      INSERT INTO hooks
        (id, project_id, start_ms, end_ms, viral_score, summary, dismissed, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?)
    `);

    const insertAll = this.db.transaction((items: InsertInput[]) => {
      const now = Date.now();
      for (const h of items) {
        stmt.run(
          h.id,
          h.projectId,
          h.startMs,
          h.endMs,
          h.viralScore,
          h.summary,
          now
        );
      }
    });

    insertAll(hooks);
  }

  /**
   * Return all hooks for a project, ordered by viral score descending.
   */
  findByProjectId(projectId: string): Hook[] {
    const rows = this.db
      .prepare<[string]>(`
        SELECT id, project_id, start_ms, end_ms, viral_score, summary, dismissed
        FROM hooks
        WHERE project_id = ?
        ORDER BY viral_score DESC
      `)
      .all(projectId) as RawHook[];

    return rows.map(mapRow);
  }

  /**
   * Find a single hook by its UUID. Returns null when not found.
   */
  findById(id: string): Hook | null {
    const row = this.db
      .prepare<[string]>(`
        SELECT id, project_id, start_ms, end_ms, viral_score, summary, dismissed
        FROM hooks
        WHERE id = ?
      `)
      .get(id) as RawHook | undefined;

    return row ? mapRow(row) : null;
  }

  /**
   * Partially update a hook row (timestamps, viral score, summary, or dismissed flag).
   */
  update(
    id: string,
    data: { startMs?: number; endMs?: number; viralScore?: number; summary?: string; dismissed?: boolean }
  ): void {
    const setClauses: string[] = [];
    const values: unknown[] = [];

    if (data.startMs !== undefined) {
      setClauses.push('start_ms = ?');
      values.push(data.startMs);
    }

    if (data.endMs !== undefined) {
      setClauses.push('end_ms = ?');
      values.push(data.endMs);
    }

    if (data.viralScore !== undefined) {
      setClauses.push('viral_score = ?');
      values.push(data.viralScore);
    }

    if (data.summary !== undefined) {
      setClauses.push('summary = ?');
      values.push(data.summary);
    }

    if (data.dismissed !== undefined) {
      setClauses.push('dismissed = ?');
      values.push(data.dismissed ? 1 : 0);
    }

    if (setClauses.length === 0) return;

    values.push(id);
    this.db
      .prepare(`UPDATE hooks SET ${setClauses.join(', ')} WHERE id = ?`)
      .run(...values);
  }
}

// ---------------------------------------------------------------------------
// Internal row shape
// ---------------------------------------------------------------------------

interface RawHook {
  id: string;
  project_id: string;
  start_ms: number;
  end_ms: number;
  viral_score: number;
  summary: string;
  dismissed: number; // 0 | 1
}

function mapRow(r: RawHook): Hook {
  return {
    id: r.id,
    projectId: r.project_id,
    startMs: r.start_ms,
    endMs: r.end_ms,
    viralScore: r.viral_score,
    summary: r.summary,
    dismissed: r.dismissed !== 0,
  };
}
