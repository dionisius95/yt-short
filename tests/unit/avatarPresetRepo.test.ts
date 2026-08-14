import { describe, it, expect, beforeEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { AvatarPresetRepo } from '../../electron/db/repositories/AvatarPresetRepo';
import type { AvatarPreset } from '../../shared/avatarTypes';

describe('AvatarPresetRepo', () => {
  let rows: Array<{ id: string; name: string; data_json: string; created_at: number }>;
  let mockDb: Database.Database;
  let repo: AvatarPresetRepo;

  beforeEach(() => {
    rows = [];
    mockDb = {
      prepare: vi.fn((sql: string) => {
        if (sql.includes('SELECT') && sql.includes('WHERE id = ?')) {
          return {
            get: (id: string) => rows.find((r) => r.id === id),
          };
        }
        if (sql.includes('SELECT')) {
          return {
            all: () => [...rows].sort((a, b) => b.created_at - a.created_at),
          };
        }
        if (sql.includes('INSERT INTO avatar_presets')) {
          return {
            run: (id: string, name: string, dataJson: string, createdAt: number) => {
              const existingIdx = rows.findIndex((r) => r.id === id);
              if (existingIdx >= 0) {
                rows[existingIdx] = { id, name, data_json: dataJson, created_at: rows[existingIdx].created_at };
              } else {
                rows.push({ id, name, data_json: dataJson, created_at: createdAt });
              }
            },
          };
        }
        if (sql.includes('DELETE FROM avatar_presets')) {
          return {
            run: (id: string) => {
              rows = rows.filter((r) => r.id !== id);
            },
          };
        }
        return { run: vi.fn(), get: vi.fn(), all: vi.fn() };
      }),
    } as unknown as Database.Database;

    repo = new AvatarPresetRepo(mockDb);
  });

  it('should save and retrieve all avatar presets', () => {
    const preset1: AvatarPreset = {
      id: 'preset-1',
      name: 'Host Kiri Bawah',
      settings: {
        position: 'bottom-left',
        scale: 0.3,
        margin: 48,
        shape: 'circle',
        removeBackground: true,
      },
      createdAt: 1000,
    };

    const preset2: AvatarPreset = {
      id: 'preset-2',
      name: 'Host Kanan Atas Kotak',
      settings: {
        position: 'top-right',
        x: 100,
        y: 200,
        scale: 0.25,
        margin: 32,
        shape: 'rect',
        removeBackground: false,
      },
      createdAt: 2000,
    };

    repo.save(preset1);
    repo.save(preset2);

    const list = repo.getAll();
    expect(list).toHaveLength(2);
    // Newest first
    expect(list[0].id).toBe('preset-2');
    expect(list[0].name).toBe('Host Kanan Atas Kotak');
    expect(list[0].settings.position).toBe('top-right');
    expect(list[0].settings.x).toBe(100);
    expect(list[0].settings.y).toBe(200);

    expect(list[1].id).toBe('preset-1');
    expect(list[1].name).toBe('Host Kiri Bawah');
    expect(list[1].settings.removeBackground).toBe(true);
  });

  it('should find preset by id', () => {
    const preset: AvatarPreset = {
      id: 'preset-find',
      name: 'Gaming Mode',
      settings: {
        position: 'center',
        scale: 0.4,
        margin: 40,
        shape: 'circle',
      },
      createdAt: 5000,
    };
    repo.save(preset);

    const found = repo.findById('preset-find');
    expect(found).not.toBeNull();
    expect(found?.name).toBe('Gaming Mode');
    expect(found?.settings.position).toBe('center');

    const notFound = repo.findById('non-existent');
    expect(notFound).toBeNull();
  });

  it('should update an existing preset on conflict', () => {
    const preset: AvatarPreset = {
      id: 'preset-update',
      name: 'Original Name',
      settings: {
        position: 'top-left',
        scale: 0.2,
        margin: 20,
        shape: 'rect',
      },
      createdAt: 1000,
    };
    repo.save(preset);

    const updated: AvatarPreset = {
      id: 'preset-update',
      name: 'Updated Name',
      settings: {
        position: 'bottom-right',
        scale: 0.35,
        margin: 50,
        shape: 'circle',
      },
      createdAt: 1000,
    };
    repo.save(updated);

    const retrieved = repo.findById('preset-update');
    expect(retrieved?.name).toBe('Updated Name');
    expect(retrieved?.settings.position).toBe('bottom-right');
    expect(retrieved?.settings.scale).toBe(0.35);
  });

  it('should delete a preset by id', () => {
    const preset: AvatarPreset = {
      id: 'preset-del',
      name: 'To Delete',
      settings: {
        position: 'center',
        scale: 0.28,
        margin: 48,
        shape: 'circle',
      },
      createdAt: 1000,
    };
    repo.save(preset);
    expect(repo.getAll()).toHaveLength(1);

    repo.delete('preset-del');
    expect(repo.getAll()).toHaveLength(0);
    expect(repo.findById('preset-del')).toBeNull();
  });
});
