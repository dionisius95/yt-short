/**
 * Property-based tests for hookSorter utilities.
 *
 * **Validates: Requirements 3.2**
 *
 * Property 8: Hook List Is Sorted by Viral Score Descending
 *
 * For any list of Hook objects with arbitrary viral scores, sortHooksByScore
 * SHALL produce an array where for every adjacent pair (hooks[i], hooks[i+1]),
 * hooks[i].viralScore >= hooks[i+1].viralScore.
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { sortHooksByScore } from '../../electron/utils/hookSorter';
// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------
const startMsArb = fc.integer({ min: 0, max: 3_600_000 });
const endMsArb = (startMs) => fc.integer({ min: startMs + 1, max: startMs + 600_000 });
const summaryArb = fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim().length > 0);
/**
 * Generates a valid Hook object with an arbitrary viralScore in [0, 100].
 */
const hookArb = fc.record({
    id: fc.uuid(),
    projectId: fc.uuid(),
    startMs: startMsArb,
    summary: summaryArb,
    viralScore: fc.integer({ min: 0, max: 100 }),
    dismissed: fc.boolean(),
}).chain(({ id, projectId, startMs, summary, viralScore, dismissed }) => endMsArb(startMs).map((endMs) => ({
    id,
    projectId,
    startMs,
    endMs,
    summary,
    viralScore,
    dismissed,
})));
// ---------------------------------------------------------------------------
// Property 8: Sorted output is in descending viralScore order
// ---------------------------------------------------------------------------
describe('Property 8 — sortHooksByScore: output is sorted descending by viralScore', () => {
    it('every adjacent pair satisfies hooks[i].viralScore >= hooks[i+1].viralScore', () => {
        fc.assert(fc.property(fc.array(hookArb, { minLength: 0, maxLength: 50 }), (hooks) => {
            const sorted = sortHooksByScore(hooks);
            for (let i = 0; i < sorted.length - 1; i++) {
                expect(sorted[i].viralScore).toBeGreaterThanOrEqual(sorted[i + 1].viralScore);
            }
        }), { numRuns: 200 });
    });
    it('sorted output has the same length as the input', () => {
        fc.assert(fc.property(fc.array(hookArb, { minLength: 0, maxLength: 50 }), (hooks) => {
            const sorted = sortHooksByScore(hooks);
            expect(sorted).toHaveLength(hooks.length);
        }), { numRuns: 200 });
    });
    it('sorted output contains exactly the same hook ids as the input', () => {
        fc.assert(fc.property(fc.array(hookArb, { minLength: 0, maxLength: 50 }), (hooks) => {
            const sorted = sortHooksByScore(hooks);
            const inputIds = hooks.map((h) => h.id).sort();
            const sortedIds = sorted.map((h) => h.id).sort();
            expect(sortedIds).toEqual(inputIds);
        }), { numRuns: 200 });
    });
    it('does not mutate the original array', () => {
        fc.assert(fc.property(fc.array(hookArb, { minLength: 1, maxLength: 50 }), (hooks) => {
            const originalIds = hooks.map((h) => h.id);
            const originalScores = hooks.map((h) => h.viralScore);
            sortHooksByScore(hooks);
            // Original array order and values must be unchanged
            expect(hooks.map((h) => h.id)).toEqual(originalIds);
            expect(hooks.map((h) => h.viralScore)).toEqual(originalScores);
        }), { numRuns: 200 });
    });
    it('sorting an already-sorted list is idempotent', () => {
        fc.assert(fc.property(fc.array(hookArb, { minLength: 0, maxLength: 50 }), (hooks) => {
            const sorted = sortHooksByScore(hooks);
            const sortedAgain = sortHooksByScore(sorted);
            expect(sortedAgain.map((h) => h.id)).toEqual(sorted.map((h) => h.id));
            expect(sortedAgain.map((h) => h.viralScore)).toEqual(sorted.map((h) => h.viralScore));
        }), { numRuns: 200 });
    });
    it('empty array returns empty array', () => {
        const result = sortHooksByScore([]);
        expect(result).toEqual([]);
    });
    it('single-element array is returned in sorted order', () => {
        fc.assert(fc.property(hookArb, (hook) => {
            const result = sortHooksByScore([hook]);
            expect(result).toHaveLength(1);
            expect(result[0].id).toBe(hook.id);
        }), { numRuns: 200 });
    });
});
