/**
 * TranscriptRepo — CRUD operations for the transcripts table.
 * One transcript row per project (one-to-one relationship).
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

export interface TranscriptRow {
  id: string;
  projectId: string;
  language: string;
  wordsJson: string;
  isEmpty: boolean;
  createdAt: number;
  originalWordsJson: string | null;
  originalLanguage: string | null;
}

type InsertInput = {
  projectId: string;
  language: string;
  wordsJson: string;
  isEmpty: boolean;
};

export class TranscriptRepo {
  constructor(private readonly db: Database.Database) {}

  /**
   * Insert a new transcript for a project.
   */
  insert(transcript: InsertInput): void {
    const id = randomUUID();
    const now = Date.now();

    this.db
      .prepare<[string, string, string, string, number, number]>(`
        INSERT INTO transcripts (id, project_id, language, words_json, is_empty, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        transcript.projectId,
        transcript.language,
        transcript.wordsJson,
        transcript.isEmpty ? 1 : 0,
        now
      );
  }

  /**
   * Find the transcript for a given project. Returns null when not found.
   */
  findByProjectId(projectId: string): TranscriptRow | null {
    const row = this.db
      .prepare<[string]>(`
        SELECT id, project_id, language, words_json, is_empty, created_at,
               original_words_json, original_language
        FROM transcripts
        WHERE project_id = ?
      `)
      .get(projectId) as RawTranscript | undefined;

    return row ? mapRow(row) : null;
  }

  /**
   * Partially update a transcript row by its id.
   */
  update(id: string, data: { wordsJson?: string; isEmpty?: boolean; language?: string; originalWordsJson?: string | null; originalLanguage?: string | null }): void {
    const setClauses: string[] = [];
    const values: unknown[] = [];

    if (data.wordsJson !== undefined) {
      setClauses.push('words_json = ?');
      values.push(data.wordsJson);
    }
    if (data.isEmpty !== undefined) {
      setClauses.push('is_empty = ?');
      values.push(data.isEmpty ? 1 : 0);
    }
    if (data.language !== undefined) {
      setClauses.push('language = ?');
      values.push(data.language);
    }
    if (data.originalWordsJson !== undefined) {
      setClauses.push('original_words_json = ?');
      values.push(data.originalWordsJson);
    }
    if (data.originalLanguage !== undefined) {
      setClauses.push('original_language = ?');
      values.push(data.originalLanguage);
    }

    if (setClauses.length === 0) return;

    values.push(id);
    this.db
      .prepare(`UPDATE transcripts SET ${setClauses.join(', ')} WHERE id = ?`)
      .run(...values);
  }
}

// ---------------------------------------------------------------------------
// Internal row shape
// ---------------------------------------------------------------------------

interface RawTranscript {
  id: string;
  project_id: string;
  language: string;
  words_json: string;
  is_empty: number;
  created_at: number;
  original_words_json: string | null;
  original_language: string | null;
}

function mapRow(r: RawTranscript): TranscriptRow {
  return {
    id: r.id,
    projectId: r.project_id,
    language: r.language,
    wordsJson: r.words_json,
    isEmpty: r.is_empty !== 0,
    createdAt: r.created_at,
    originalWordsJson: r.original_words_json,
    originalLanguage: r.original_language,
  };
}
