/**
 * ClipRepo — CRUD operations for the clips table.
 */

import Database from 'better-sqlite3';
import type { Clip } from '../../../shared/types';

// The caller supplies everything except the three nullable output fields.
type InsertInput = Omit<Clip, 'outputPath' | 'errorMessage' | 'youtubeUrl'>;

export class ClipRepo {
  constructor(private readonly db: Database.Database) {}

  /**
   * Insert a new clip row and return the full Clip record.
   */
  insert(clip: InsertInput): Clip {
    const now = Date.now();

    this.db
      .prepare<[
        string, string, string, string, string, string, number, number, number
      ]>(`
        INSERT INTO clips
          (id, project_id, hook_id, status,
           subtitle_style, subtitle_position, zoom_enabled,
           created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        clip.id,
        clip.projectId,
        clip.hookId,
        clip.status,
        clip.subtitleStyle,
        clip.subtitlePosition,
        clip.zoomEnabled ? 1 : 0,
        now,
        now
      );

    return {
      ...clip,
      outputPath: null,
      errorMessage: null,
      youtubeUrl: null,
    };
  }

  /**
   * Return all clips for a project, ordered by creation time ascending.
   */
  findByProjectId(projectId: string): Clip[] {
    const rows = this.db
      .prepare<[string]>(`
        SELECT id, project_id, hook_id, status,
               output_path, subtitle_style, subtitle_position,
               zoom_enabled, error_message, youtube_url
        FROM clips
        WHERE project_id = ?
        ORDER BY created_at ASC
      `)
      .all(projectId) as RawClip[];

    return rows.map(mapRow);
  }

  /**
   * Find a single clip by its UUID. Returns null when not found.
   */
  findById(id: string): Clip | null {
    const row = this.db
      .prepare<[string]>(`
        SELECT id, project_id, hook_id, status,
               output_path, subtitle_style, subtitle_position,
               zoom_enabled, error_message, youtube_url
        FROM clips
        WHERE id = ?
      `)
      .get(id) as RawClip | undefined;

    return row ? mapRow(row) : null;
  }

  /**
   * Update the processing status of a clip, optionally recording an error message.
   */
  updateStatus(
    id: string,
    status: Clip['status'],
    errorMessage?: string
  ): void {
    const now = Date.now();
    this.db
      .prepare<[string, string | null, number, string]>(`
        UPDATE clips
        SET status = ?, error_message = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(status, errorMessage ?? null, now, id);
  }

  /**
   * Set the local output file path once a clip has been exported.
   */
  updateOutputPath(id: string, outputPath: string): void {
    const now = Date.now();
    this.db
      .prepare<[string, number, string]>(`
        UPDATE clips SET output_path = ?, updated_at = ? WHERE id = ?
      `)
      .run(outputPath, now, id);
  }

  /**
   * Record the YouTube URL after a successful upload.
   */
  updateYouTubeUrl(id: string, youtubeUrl: string): void {
    const now = Date.now();
    this.db
      .prepare<[string, number, string]>(`
        UPDATE clips SET youtube_url = ?, updated_at = ? WHERE id = ?
      `)
      .run(youtubeUrl, now, id);
  }

  /**
   * Delete a clip by id.
   */
  delete(id: string): void {
    this.db.prepare<[string]>('DELETE FROM clips WHERE id = ?').run(id);
  }
}

// ---------------------------------------------------------------------------
// Internal row shape
// ---------------------------------------------------------------------------

interface RawClip {
  id: string;
  project_id: string;
  hook_id: string;
  status: string;
  output_path: string | null;
  subtitle_style: string;
  subtitle_position: string;
  zoom_enabled: number; // 0 | 1
  error_message: string | null;
  youtube_url: string | null;
}

function mapRow(r: RawClip): Clip {
  return {
    id: r.id,
    projectId: r.project_id,
    hookId: r.hook_id,
    status: r.status as Clip['status'],
    outputPath: r.output_path,
    subtitleStyle: r.subtitle_style as Clip['subtitleStyle'],
    subtitlePosition: r.subtitle_position as Clip['subtitlePosition'],
    zoomEnabled: r.zoom_enabled !== 0,
    errorMessage: r.error_message,
    youtubeUrl: r.youtube_url,
  };
}
