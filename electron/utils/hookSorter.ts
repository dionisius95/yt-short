import type { Hook } from '../../shared/types';

/**
 * Returns a new array of hooks sorted by viralScore descending (highest first).
 * Does not mutate the original array. For equal scores, original order is preserved
 * (stable sort).
 */
export function sortHooksByScore(hooks: Hook[]): Hook[] {
  return [...hooks].sort((a, b) => b.viralScore - a.viralScore);
}
