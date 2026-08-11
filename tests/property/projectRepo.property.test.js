/**
 * Property-based tests for ProjectRepo database operations.
 *
 * **Validates: Requirements 1.6, 9.1, 9.2, 9.4, 7.4**
 *
 * Property 3:  Project Record Round-Trip Persistence
 * Property 22: Dashboard Query Returns All Required Fields for Every Project
 * Property 23: Project Deletion Removes All Associated Records
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { ProjectRepo } from '../../electron/db/repositories/ProjectRepo';
import { HookRepo } from '../../electron/db/repositories/HookRepo';
import { ClipRepo } from '../../electron/db/repositories/ClipRepo';
// ---------------------------------------------------------------------------
// Test DB factory
// ---------------------------------------------------------------------------
function createTestDb() {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    const schema = readFileSync(join(process.cwd(), 'electron/db/schema.sql'), 'utf-8');
    db.exec(schema);
    return db;
}
// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------
const qualityArb = fc.constantFrom('1080p', '720p', '480p', '360p');
const languageArb = fc.constantFrom('en', 'es', 'fr', 'de', 'ja', 'zh', 'pt', 'ru');
/** Generates a valid Project without an id (as required by ProjectRepo.insert). */
const projectInputArb = fc.record({
    sourceUrl: fc.webUrl(),
    title: fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim().length > 0),
    filePath: fc.string({ minLength: 1, maxLength: 500 }).filter((s) => s.trim().length > 0),
    durationMs: fc.integer({ min: 1, max: 7_200_000 }),
    thumbnail: fc.option(fc.string({ minLength: 1, maxLength: 500 }).filter((s) => s.trim().length > 0), { nil: null }),
    language: languageArb,
    quality: qualityArb,
    createdAt: fc.integer({ min: 1_000_000_000_000, max: 9_999_999_999_999 }),
    updatedAt: fc.integer({ min: 1_000_000_000_000, max: 9_999_999_999_999 }),
});
// ---------------------------------------------------------------------------
// Property 3: Project Record Round-Trip Persistence
// ---------------------------------------------------------------------------
describe('Property 3 — ProjectRepo: insert then findById returns equivalent object', () => {
    let db;
    let repo;
    beforeEach(() => {
        db = createTestDb();
        repo = new ProjectRepo(db);
    });
    it('all fields are preserved after insert and findById for any valid project input', () => {
        fc.assert(fc.property(projectInputArb, (input) => {
            const inserted = repo.insert(input);
            // insert must return the full project with a generated id
            expect(inserted.id).toBeTruthy();
            expect(typeof inserted.id).toBe('string');
            const retrieved = repo.findById(inserted.id);
            expect(retrieved).not.toBeNull();
            expect(retrieved.id).toBe(inserted.id);
            expect(retrieved.sourceUrl).toBe(input.sourceUrl);
            expect(retrieved.title).toBe(input.title);
            expect(retrieved.filePath).toBe(input.filePath);
            expect(retrieved.durationMs).toBe(input.durationMs);
            expect(retrieved.thumbnail).toBe(input.thumbnail ?? null);
            expect(retrieved.language).toBe(input.language);
            expect(retrieved.quality).toBe(input.quality);
            expect(retrieved.createdAt).toBe(input.createdAt);
            expect(retrieved.updatedAt).toBe(input.updatedAt);
        }), { numRuns: 200 });
    });
    it('findById returns null for a non-existent id', () => {
        fc.assert(fc.property(fc.uuid(), (id) => {
            const result = repo.findById(id);
            expect(result).toBeNull();
        }), { numRuns: 50 });
    });
    it('each inserted project gets a unique id', () => {
        fc.assert(fc.property(fc.array(projectInputArb, { minLength: 2, maxLength: 10 }), (inputs) => {
            // Fresh DB per run to avoid cross-run contamination
            const freshDb = createTestDb();
            const freshRepo = new ProjectRepo(freshDb);
            const ids = inputs.map((input) => freshRepo.insert(input).id);
            const uniqueIds = new Set(ids);
            expect(uniqueIds.size).toBe(ids.length);
            freshDb.close();
        }), { numRuns: 100 });
    });
});
// ---------------------------------------------------------------------------
// Property 22: Dashboard Query Returns All Required Fields for Every Project
// ---------------------------------------------------------------------------
describe('Property 22 — ProjectRepo: listForDashboard returns all required fields for every project', () => {
    it('listForDashboard returns exactly N records with all required fields for N inserted projects', () => {
        fc.assert(fc.property(fc.array(projectInputArb, { minLength: 1, maxLength: 10 }), (inputs) => {
            const db = createTestDb();
            const repo = new ProjectRepo(db);
            for (const input of inputs) {
                repo.insert(input);
            }
            const dashboard = repo.listForDashboard();
            // Must return exactly as many records as were inserted
            expect(dashboard).toHaveLength(inputs.length);
            for (const item of dashboard) {
                // All required fields must be present
                expect(item).toHaveProperty('id');
                expect(item).toHaveProperty('title');
                expect(item).toHaveProperty('thumbnail');
                expect(item).toHaveProperty('createdAt');
                expect(item).toHaveProperty('clipCount');
                expect(item).toHaveProperty('exportCount');
                // Type checks
                expect(typeof item.id).toBe('string');
                expect(item.id.length).toBeGreaterThan(0);
                expect(typeof item.title).toBe('string');
                expect(typeof item.createdAt).toBe('number');
                expect(typeof item.clipCount).toBe('number');
                expect(typeof item.exportCount).toBe('number');
                // Counts must be non-negative integers
                expect(item.clipCount).toBeGreaterThanOrEqual(0);
                expect(item.exportCount).toBeGreaterThanOrEqual(0);
                expect(Number.isInteger(item.clipCount)).toBe(true);
                expect(Number.isInteger(item.exportCount)).toBe(true);
            }
            db.close();
        }), { numRuns: 100 });
    });
    it('listForDashboard returns empty array when no projects exist', () => {
        const db = createTestDb();
        const repo = new ProjectRepo(db);
        expect(repo.listForDashboard()).toEqual([]);
        db.close();
    });
    it('dashboard ids match the ids of inserted projects', () => {
        fc.assert(fc.property(fc.array(projectInputArb, { minLength: 1, maxLength: 10 }), (inputs) => {
            const db = createTestDb();
            const repo = new ProjectRepo(db);
            const insertedIds = new Set(inputs.map((input) => repo.insert(input).id));
            const dashboardIds = new Set(repo.listForDashboard().map((item) => item.id));
            expect(dashboardIds).toEqual(insertedIds);
            db.close();
        }), { numRuns: 100 });
    });
});
// ---------------------------------------------------------------------------
// Property 23: Project Deletion Removes All Associated Records
// ---------------------------------------------------------------------------
describe('Property 23 — ProjectRepo: deleting a project removes it and all associated records', () => {
    it('after delete, project is gone and all associated hooks and clips are removed', () => {
        fc.assert(fc.property(projectInputArb, fc.integer({ min: 0, max: 5 }), // number of hooks
        fc.integer({ min: 0, max: 5 }), // number of clips per hook
        (projectInput, hookCount, clipsPerHook) => {
            const db = createTestDb();
            const projectRepo = new ProjectRepo(db);
            const hookRepo = new HookRepo(db);
            const clipRepo = new ClipRepo(db);
            // Insert project
            const project = projectRepo.insert(projectInput);
            // Insert hooks
            const hookInputs = Array.from({ length: hookCount }, (_, i) => ({
                id: randomUUID(),
                projectId: project.id,
                startMs: i * 10_000,
                endMs: i * 10_000 + 5_000,
                viralScore: Math.floor(Math.random() * 101),
                summary: `Hook summary ${i}`,
            }));
            if (hookInputs.length > 0) {
                hookRepo.insertMany(hookInputs);
            }
            // Insert clips (one per hook)
            for (const hook of hookInputs) {
                for (let c = 0; c < clipsPerHook; c++) {
                    clipRepo.insert({
                        id: randomUUID(),
                        projectId: project.id,
                        hookId: hook.id,
                        status: 'pending',
                        subtitleStyle: 'bold-white',
                        subtitlePosition: 'lower-third',
                        zoomEnabled: true,
                    });
                }
            }
            // Verify records exist before deletion
            expect(projectRepo.findById(project.id)).not.toBeNull();
            // Delete the project
            projectRepo.delete(project.id);
            // Project must no longer exist
            expect(projectRepo.findById(project.id)).toBeNull();
            // All associated hooks must be gone
            const remainingHooks = db
                .prepare('SELECT id FROM hooks WHERE project_id = ?')
                .all(project.id);
            expect(remainingHooks).toHaveLength(0);
            // All associated clips must be gone
            const remainingClips = db
                .prepare('SELECT id FROM clips WHERE project_id = ?')
                .all(project.id);
            expect(remainingClips).toHaveLength(0);
            db.close();
        }), { numRuns: 100 });
    });
    it('deleting one project does not affect other projects', () => {
        fc.assert(fc.property(fc.array(projectInputArb, { minLength: 2, maxLength: 5 }), (inputs) => {
            const db = createTestDb();
            const repo = new ProjectRepo(db);
            const projects = inputs.map((input) => repo.insert(input));
            // Delete the first project
            repo.delete(projects[0].id);
            // All other projects must still exist
            for (let i = 1; i < projects.length; i++) {
                expect(repo.findById(projects[i].id)).not.toBeNull();
            }
            db.close();
        }), { numRuns: 100 });
    });
    it('deleting a non-existent project is a no-op', () => {
        fc.assert(fc.property(fc.uuid(), (id) => {
            const db = createTestDb();
            const repo = new ProjectRepo(db);
            // Should not throw
            expect(() => repo.delete(id)).not.toThrow();
            db.close();
        }), { numRuns: 50 });
    });
});
