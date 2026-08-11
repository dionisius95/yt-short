/**
 * Database connection and migration runner.
 * Uses better-sqlite3 for synchronous SQLite access.
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

let _db: Database.Database | null = null;

/**
 * Opens (or creates) the SQLite database at the given path, enables WAL mode,
 * enforces foreign keys, and runs the schema migrations on first run.
 */
export function initDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');

  // Enforce foreign key constraints (SQLite disables them by default)
  db.pragma('foreign_keys = ON');

  // Run schema migrations
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf-8');
  db.exec(schemaSql);

  // Migration: add original_words_json + original_language columns (v0.1.1)
  // ALTER TABLE ADD COLUMN is a no-op if the column already exists → safe to re-run.
  try { db.exec('ALTER TABLE transcripts ADD COLUMN original_words_json TEXT'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE transcripts ADD COLUMN original_language TEXT'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE clips ADD COLUMN options_json TEXT'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE clips ADD COLUMN tiktok_url TEXT'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE clips ADD COLUMN facebook_url TEXT'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE clips ADD COLUMN telegram_url TEXT'); } catch { /* already exists */ }

  _db = db;
  return db;
}

/**
 * Returns the singleton database instance.
 * Throws if initDatabase() has not been called yet.
 */
export function getDatabase(): Database.Database {
  if (!_db) {
    throw new Error(
      'Database has not been initialised. Call initDatabase() first.'
    );
  }
  return _db;
}
