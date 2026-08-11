/**
 * Property-based tests for hookDismisser utilities.
 *
 * **Validates: Requirements 3.2**
 *
 * Property 9: Dismissing a Hook Does Not Affect Other Hooks
 *
 * For any list of hooks and any single hook selected for dismissal, after
 * dismissHook, all other hooks SHALL have their id, startMs, endMs,
 * viralScore, summary, and dismissed fields unchanged.
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { dismissHook } from '../../electron/utils/hookDismisser';
// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------
const startMsArb = fc.integer({ min: 0, max: 3_600_000 });
const endMsArb = (startMs) => fc.integer({ min: startMs + 1, max: startMs + 600_000 });
const summaryArb = fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim().length > 0);
/**
 * Generates a valid Hook object.
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
/**
 * Generates a non-empty array of hooks with unique ids, plus an index
 * pointing to the hook to dismiss.
 */
const hooksWithTargetArb = fc
    .array(hookArb, { minLength: 1, maxLength: 30 })
    .chain((hooks) => {
    // Ensure unique ids to avoid ambiguity
    const uniqueHooks = hooks.filter((h, i, arr) => arr.findIndex((x) => x.id === h.id) === i);
    if (uniqueHooks.length === 0) {
        // Fallback: generate a single fresh hook
        return hookArb.map((h) => ({ hooks: [h], targetIndex: 0 }));
    }
    return fc
        .integer({ min: 0, max: uniqueHooks.length - 1 })
        .map((targetIndex) => ({ hooks: uniqueHooks, targetIndex }));
});
// ---------------------------------------------------------------------------
// Property 9: Dismissing a hook does not affect other hooks
// ---------------------------------------------------------------------------
describe('Property 9 — dismissHook: other hooks are unchanged', () => {
    it('all hooks except the dismissed one have identical field values after dismissal', () => {
        fc.assert(fc.property(hooksWithTargetArb, ({ hooks, targetIndex }) => {
            const targetId = hooks[targetIndex].id;
            const result = dismissHook(hooks, targetId);
            // Check every hook that is NOT the dismissed one
            for (const original of hooks) {
                if (original.id === targetId)
                    continue;
                const updated = result.find((h) => h.id === original.id);
                expect(updated).toBeDefined();
                if (!updated)
                    continue;
                expect(updated.id).toBe(original.id);
                expect(updated.startMs).toBe(original.startMs);
                expect(updated.endMs).toBe(original.endMs);
                expect(updated.viralScore).toBe(original.viralScore);
                expect(updated.summary).toBe(original.summary);
                expect(updated.dismissed).toBe(original.dismissed);
            }
        }), { numRuns: 200 });
    });
    it('the dismissed hook has dismissed set to true', () => {
        fc.assert(fc.property(hooksWithTargetArb, ({ hooks, targetIndex }) => {
            const targetId = hooks[targetIndex].id;
            const result = dismissHook(hooks, targetId);
            const dismissed = result.find((h) => h.id === targetId);
            expect(dismissed).toBeDefined();
            expect(dismissed?.dismissed).toBe(true);
        }), { numRuns: 200 });
    });
    it('result has the same length as the input', () => {
        fc.assert(fc.property(hooksWithTargetArb, ({ hooks, targetIndex }) => {
            const targetId = hooks[targetIndex].id;
            const result = dismissHook(hooks, targetId);
            expect(result).toHaveLength(hooks.length);
        }), { numRuns: 200 });
    });
    it('does not mutate the original array', () => {
        fc.assert(fc.property(hooksWithTargetArb, ({ hooks, targetIndex }) => {
            const targetId = hooks[targetIndex].id;
            const originalDismissed = hooks.map((h) => h.dismissed);
            dismissHook(hooks, targetId);
            // Original array dismissed values must be unchanged
            hooks.forEach((h, i) => {
                expect(h.dismissed).toBe(originalDismissed[i]);
            });
        }), { numRuns: 200 });
    });
    it('dismissing a non-existent id returns the original array unchanged', () => {
        fc.assert(fc.property(fc.array(hookArb, { minLength: 0, maxLength: 20 }), fc.uuid(), (hooks, nonExistentId) => {
            // Ensure the generated id is not in the array
            fc.pre(!hooks.some((h) => h.id === nonExistentId));
            const result = dismissHook(hooks, nonExistentId);
            // Should return the exact same array reference
            expect(result).toBe(hooks);
        }), { numRuns: 200 });
    });
    it('dismissing a hook twice is idempotent', () => {
        fc.assert(fc.property(hooksWithTargetArb, ({ hooks, targetIndex }) => {
            const targetId = hooks[targetIndex].id;
            const once = dismissHook(hooks, targetId);
            const twice = dismissHook(once, targetId);
            // Both results should have the same dismissed values
            expect(twice.map((h) => h.dismissed)).toEqual(once.map((h) => h.dismissed));
            expect(twice.map((h) => h.id)).toEqual(once.map((h) => h.id));
        }), { numRuns: 200 });
    });
});
