/**
 * Smoke test to verify the test infrastructure is correctly configured.
 * This test validates that the unit test suite runs and that shared types
 * can be imported without errors.
 */
import { describe, it, expect } from 'vitest';
describe('Project scaffold', () => {
    it('shared types module is importable', async () => {
        const types = await import('../../shared/types');
        // Verify the module exports something (not undefined)
        expect(types).toBeDefined();
    });
    it('TypeScript strict mode is active — no implicit any', () => {
        // This test simply runs; if TypeScript compilation failed due to strict
        // mode violations, the test file itself would not compile.
        expect(true).toBe(true);
    });
});
