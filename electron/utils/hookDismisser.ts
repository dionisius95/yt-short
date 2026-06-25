import type { Hook } from '../../shared/types';

/**
 * Returns a new array where the hook with the given id has dismissed set to true.
 * Does not mutate the original array. All other hooks are returned unchanged.
 * If no hook with the given id exists, the original array is returned unchanged.
 */
export function dismissHook(hooks: Hook[], id: string): Hook[] {
  const index = hooks.findIndex((h) => h.id === id);
  if (index === -1) {
    return hooks;
  }
  return hooks.map((h) => (h.id === id ? { ...h, dismissed: true } : h));
}
