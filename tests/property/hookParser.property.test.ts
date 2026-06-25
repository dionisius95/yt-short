/**
 * Property-based tests for hookParser utilities.
 *
 * **Validates: Requirements 3.2, 3.3**
 *
 * Property 6: Hook Viral Scores Are Always in [0, 100]
 * Property 7: Hook Count Is Clamped to [0, 20]
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { parseHooks, clampHooks } from '../../electron/utils/hookParser';
import type { Hook } from '../../shared/types';

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/** Generates a valid UUID-like string for projectId. */
const projectIdArb = fc.uuid();

/** Generates a valid non-negative integer startMs. */
const startMsArb = fc.integer({ min: 0, max: 3_600_000 });

/** Generates a valid endMs strictly greater than a given startMs. */
const endMsArb = (startMs: number) =>
  fc.integer({ min: startMs + 1, max: startMs + 600_000 });

/** Generates a valid viralScore in [0, 100]. */
const validViralScoreArb = fc.integer({ min: 0, max: 100 });

/** Generates a non-empty summary string. */
const summaryArb = fc.string({ minLength: 1, maxLength: 200 }).filter(
  (s) => s.trim().length > 0
);

/**
 * Generates a fully valid raw hook candidate object that parseHooks will accept.
 */
const validRawHookArb = fc.record({
  startMs: startMsArb,
  summary: summaryArb,
  viralScore: validViralScoreArb,
}).chain(({ startMs, summary, viralScore }) =>
  endMsArb(startMs).map((endMs) => ({ startMs, endMs, summary, viralScore }))
);

/**
 * Generates a raw hook object with an arbitrary (potentially invalid) viralScore.
 * All other fields are valid so that only viralScore determines validity.
 */
const rawHookWithArbitraryScoreArb = fc.record({
  startMs: startMsArb,
  summary: summaryArb,
}).chain(({ startMs, summary }) =>
  endMsArb(startMs).chain((endMs) =>
    // viralScore can be anything: out-of-range int, float, string, null, undefined
    fc.oneof(
      fc.integer({ min: -10_000, max: 10_000 }),   // integers (includes valid range)
      fc.float({ min: -1e6, max: 1e6 }),            // floats
      fc.string(),                                   // strings
      fc.constant(null),
      fc.constant(undefined),
      fc.boolean(),
    ).map((viralScore) => ({ startMs, endMs, summary, viralScore }))
  )
);

/**
 * Generates a valid Hook object (already parsed/validated shape).
 */
const hookArb: fc.Arbitrary<Hook> = fc.record({
  id: fc.uuid(),
  projectId: fc.uuid(),
  startMs: startMsArb,
  summary: summaryArb,
  viralScore: validViralScoreArb,
  dismissed: fc.boolean(),
}).chain(({ id, projectId, startMs, summary, viralScore, dismissed }) =>
  endMsArb(startMs).map((endMs) => ({
    id,
    projectId,
    startMs,
    endMs,
    summary,
    viralScore,
    dismissed,
  }))
);

// ---------------------------------------------------------------------------
// Property 6: Hook Viral Scores Are Always in [0, 100]
// ---------------------------------------------------------------------------

describe('Property 6 — parseHooks: viralScore is always in [0, 100]', () => {
  it('all returned hooks have viralScore as an integer in [0, 100] for any raw input array', () => {
    fc.assert(
      fc.property(
        fc.array(rawHookWithArbitraryScoreArb, { minLength: 0, maxLength: 30 }),
        projectIdArb,
        (rawArray, projectId) => {
          const hooks = parseHooks(rawArray, projectId);

          for (const hook of hooks) {
            expect(Number.isInteger(hook.viralScore)).toBe(true);
            expect(hook.viralScore).toBeGreaterThanOrEqual(0);
            expect(hook.viralScore).toBeLessThanOrEqual(100);
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('parseHooks returns empty array for non-array input', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.integer(),
          fc.boolean(),
          fc.constant(null),
          fc.constant(undefined),
          fc.record({ hooks: fc.array(validRawHookArb) }),
        ),
        projectIdArb,
        (nonArray, projectId) => {
          const hooks = parseHooks(nonArray, projectId);
          expect(hooks).toEqual([]);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('hooks with out-of-range viralScore are discarded entirely', () => {
    fc.assert(
      fc.property(
        fc.record({
          startMs: startMsArb,
          summary: summaryArb,
        }).chain(({ startMs, summary }) =>
          endMsArb(startMs).chain((endMs) =>
            // Only out-of-range integers
            fc.oneof(
              fc.integer({ min: 101, max: 10_000 }),
              fc.integer({ min: -10_000, max: -1 }),
            ).map((viralScore) => ({ startMs, endMs, summary, viralScore }))
          )
        ),
        projectIdArb,
        (rawHook, projectId) => {
          const hooks = parseHooks([rawHook], projectId);
          // Out-of-range score → hook must be discarded
          expect(hooks).toHaveLength(0);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('hooks with valid viralScore in [0, 100] are always accepted', () => {
    fc.assert(
      fc.property(
        validRawHookArb,
        projectIdArb,
        (rawHook, projectId) => {
          const hooks = parseHooks([rawHook], projectId);
          expect(hooks).toHaveLength(1);
          expect(hooks[0].viralScore).toBeGreaterThanOrEqual(0);
          expect(hooks[0].viralScore).toBeLessThanOrEqual(100);
        }
      ),
      { numRuns: 200 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 7: Hook Count Is Clamped to [0, 20]
// ---------------------------------------------------------------------------

describe('Property 7 — clampHooks: result length is always in [0, 20]', () => {
  it('clampHooks always returns at most 20 hooks for any input size', () => {
    fc.assert(
      fc.property(
        fc.array(hookArb, { minLength: 0, maxLength: 30 }),
        projectIdArb,
        (hooks, projectId) => {
          const result = clampHooks(hooks, projectId);
          expect(result.length).toBeLessThanOrEqual(20);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('when input has > 20 hooks, the top 20 by viralScore are kept', () => {
    fc.assert(
      fc.property(
        fc.array(hookArb, { minLength: 21, maxLength: 30 }),
        projectIdArb,
        (hooks, projectId) => {
          const result = clampHooks(hooks, projectId);
          expect(result).toHaveLength(20);

          // The minimum viralScore in the result must be >= any score NOT in the result
          const resultIds = new Set(result.map((h) => h.id));
          const excluded = hooks.filter((h) => !resultIds.has(h.id));
          const minResultScore = Math.min(...result.map((h) => h.viralScore));

          for (const excl of excluded) {
            expect(excl.viralScore).toBeLessThanOrEqual(minResultScore);
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('when input has <= 20 hooks, the array is returned as-is', () => {
    fc.assert(
      fc.property(
        fc.array(hookArb, { minLength: 0, maxLength: 20 }),
        projectIdArb,
        (hooks, projectId) => {
          const result = clampHooks(hooks, projectId);
          expect(result).toHaveLength(hooks.length);
          // Same hook objects (identity preserved for ≤ 20 case)
          for (let i = 0; i < hooks.length; i++) {
            expect(result[i]).toBe(hooks[i]);
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('when input has < 3 hooks, the array is returned as-is (caller handles error)', () => {
    fc.assert(
      fc.property(
        fc.array(hookArb, { minLength: 0, maxLength: 2 }),
        projectIdArb,
        (hooks, projectId) => {
          const result = clampHooks(hooks, projectId);
          expect(result).toHaveLength(hooks.length);
        }
      ),
      { numRuns: 200 }
    );
  });
});
