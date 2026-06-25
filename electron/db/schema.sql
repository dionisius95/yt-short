-- AI Shorts Generator — SQLite Schema
-- Implemented in task 3.1

-- Projects
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  source_url  TEXT NOT NULL,
  title       TEXT NOT NULL,
  file_path   TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  thumbnail   TEXT,
  language    TEXT NOT NULL DEFAULT 'en',
  quality     TEXT NOT NULL DEFAULT '1080p',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Transcripts (one per project)
CREATE TABLE IF NOT EXISTS transcripts (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  language    TEXT NOT NULL,
  words_json  TEXT NOT NULL,
  is_empty    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

-- Hooks
CREATE TABLE IF NOT EXISTS hooks (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  start_ms     INTEGER NOT NULL,
  end_ms       INTEGER NOT NULL,
  viral_score  INTEGER NOT NULL,
  summary      TEXT NOT NULL,
  dismissed    INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

-- Clips
CREATE TABLE IF NOT EXISTS clips (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  hook_id           TEXT NOT NULL REFERENCES hooks(id) ON DELETE CASCADE,
  status            TEXT NOT NULL DEFAULT 'pending',
  output_path       TEXT,
  subtitle_style    TEXT NOT NULL DEFAULT 'bold-white',
  subtitle_position TEXT NOT NULL DEFAULT 'lower-third',
  zoom_enabled      INTEGER NOT NULL DEFAULT 1,
  error_message     TEXT,
  youtube_url       TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

-- Settings (single-row key-value store)
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_hooks_project      ON hooks(project_id);
CREATE INDEX IF NOT EXISTS idx_clips_project      ON clips(project_id);
CREATE INDEX IF NOT EXISTS idx_clips_hook         ON clips(hook_id);
CREATE INDEX IF NOT EXISTS idx_transcripts_project ON transcripts(project_id);
