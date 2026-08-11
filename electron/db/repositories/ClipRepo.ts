/**
 * ClipRepo — CRUD operations for the clips table.
 */

import Database from 'better-sqlite3';
import type { Clip } from '../../../shared/types';

// The caller supplies everything except the nullable output fields.
type InsertInput = Omit<Clip, 'outputPath' | 'errorMessage' | 'youtubeUrl' | 'tiktokUrl' | 'facebookUrl' | 'telegramUrl'>;

export class ClipRepo {
  constructor(private readonly db: Database.Database) {}

  /**
   * Insert a new clip row and return the full Clip record.
   */
  insert(clip: InsertInput): Clip {
    const now = Date.now();

    this.db
      .prepare<[
        string, string, string, string, string, string, number, string | null, number, number
      ]>(`
        INSERT INTO clips
          (id, project_id, hook_id, status,
           subtitle_style, subtitle_position, zoom_enabled, options_json,
           created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        clip.id,
        clip.projectId,
        clip.hookId,
        clip.status,
        clip.subtitleStyle,
        clip.subtitlePosition,
        clip.zoomEnabled ? 1 : 0,
        clip.optionsJson ?? null,
        now,
        now
      );

    return {
      ...clip,
      outputPath: null,
      errorMessage: null,
      youtubeUrl: null,
      tiktokUrl: null,
      facebookUrl: null,
      telegramUrl: null,
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
               zoom_enabled, error_message, youtube_url, tiktok_url, facebook_url, telegram_url, options_json
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
               zoom_enabled, error_message, youtube_url, tiktok_url, facebook_url, telegram_url, options_json
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
   * Record the TikTok URL after a successful upload.
   */
  updateTikTokUrl(id: string, tiktokUrl: string): void {
    const now = Date.now();
    this.db
      .prepare<[string, number, string]>(`
        UPDATE clips SET tiktok_url = ?, updated_at = ? WHERE id = ?
      `)
      .run(tiktokUrl, now, id);
  }

  /**
   * Record the Facebook URL after a successful upload.
   */
  updateFacebookUrl(id: string, facebookUrl: string): void {
    const now = Date.now();
    this.db
      .prepare<[string, number, string]>(`
        UPDATE clips SET facebook_url = ?, updated_at = ? WHERE id = ?
      `)
      .run(facebookUrl, now, id);
  }

  /**
   * Record the Telegram URL after a successful upload.
   */
  updateTelegramUrl(id: string, telegramUrl: string): void {
    const now = Date.now();
    this.db
      .prepare<[string, number, string]>(`
        UPDATE clips SET telegram_url = ?, updated_at = ? WHERE id = ?
      `)
      .run(telegramUrl, now, id);
  }

  /**
   * Update the options json of a clip.
   */
  updateOptions(id: string, optionsJson: string): void {
    const now = Date.now();
    this.db
      .prepare<[string, number, string]>(`
        UPDATE clips SET options_json = ?, updated_at = ? WHERE id = ?
      `)
      .run(optionsJson, now, id);
  }

  /**
   * Update the subtitle style of a clip.
   */
  updateSubtitleStyle(id: string, subtitleStyle: string): void {
    const now = Date.now();
    this.db
      .prepare<[string, number, string]>(`
        UPDATE clips SET subtitle_style = ?, updated_at = ? WHERE id = ?
      `)
      .run(subtitleStyle, now, id);
  }

  /**
   * Reset any clips that were left in 'processing' or 'pending' status
   * when the app starts.
   */
  resetStuckClips(): void {
    const now = Date.now();
    this.db
      .prepare(`
        UPDATE clips
        SET status = 'failed', error_message = 'Interrupted due to application restart', updated_at = ?
        WHERE status IN ('processing', 'pending')
      `)
      .run(now);
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
  tiktok_url: string | null;
  facebook_url: string | null;
  telegram_url: string | null;
  options_json: string | null;
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
    tiktokUrl: r.tiktok_url,
    facebookUrl: r.facebook_url,
    telegramUrl: r.telegram_url,
    optionsJson: r.options_json,
  };
}
