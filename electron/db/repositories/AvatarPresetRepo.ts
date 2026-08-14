/**
 * AvatarPresetRepo — CRUD operations for the avatar_presets table.
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type { AvatarPreset } from '../../../shared/avatarTypes';

interface RawAvatarPreset {
  id: string;
  name: string;
  data_json: string;
  created_at: number;
}

export class AvatarPresetRepo {
  constructor(private readonly db: Database.Database) {}

  /**
   * Return all saved avatar presets, sorted by newest first.
   */
  getAll(): AvatarPreset[] {
    const rows = this.db
      .prepare(`
        SELECT id, name, data_json, created_at
        FROM avatar_presets
        ORDER BY created_at DESC
      `)
      .all() as RawAvatarPreset[];

    return rows.map((r) => {
      let settings: AvatarPreset['settings'] = {
        position: 'bottom-right',
        scale: 0.28,
        margin: 48,
        shape: 'circle',
      };
      try {
        settings = JSON.parse(r.data_json);
      } catch {
        /* fallback default */
      }
      return {
        id: r.id,
        name: r.name,
        settings,
        createdAt: r.created_at,
      };
    });
  }

  /**
   * Find a single avatar preset by id.
   */
  findById(id: string): AvatarPreset | null {
    const row = this.db
      .prepare<[string]>(`
        SELECT id, name, data_json, created_at
        FROM avatar_presets
        WHERE id = ?
      `)
      .get(id) as RawAvatarPreset | undefined;

    if (!row) return null;

    let settings: AvatarPreset['settings'] = {
      position: 'bottom-right',
      scale: 0.28,
      margin: 48,
      shape: 'circle',
    };
    try {
      settings = JSON.parse(row.data_json);
    } catch {
      /* fallback default */
    }

    return {
      id: row.id,
      name: row.name,
      settings,
      createdAt: row.created_at,
    };
  }

  /**
   * Insert or update an avatar preset.
   */
  save(preset: AvatarPreset): AvatarPreset {
    const id = preset.id || `avatar_preset_${randomUUID()}`;
    const createdAt = preset.createdAt || Date.now();
    const dataJson = JSON.stringify(preset.settings || {});

    const stmt = this.db.prepare<[string, string, string, number]>(`
      INSERT INTO avatar_presets (id, name, data_json, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        data_json = excluded.data_json
    `);

    stmt.run(id, preset.name, dataJson, createdAt);

    return {
      id,
      name: preset.name,
      settings: preset.settings,
      createdAt,
    };
  }

  /**
   * Delete an avatar preset by id.
   */
  delete(id: string): void {
    this.db.prepare<[string]>('DELETE FROM avatar_presets WHERE id = ?').run(id);
  }
}
