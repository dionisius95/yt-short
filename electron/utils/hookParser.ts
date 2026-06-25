/**
 * Hook parsing and clamping utilities for the Analyzer pipeline stage.
 *
 * Parses raw Ollama LLM JSON responses into validated `Hook` objects and
 * clamps the resulting list to the allowed [1, 20] range.
 */

import { randomUUID } from 'crypto';
import type { Hook } from '../../shared/types';



/**
 * Attempt to coerce a raw candidate object into a validated `Hook`.
 *
 * Lenient validation — accepts floats and coerces them to integers,
 * because LLMs sometimes return 85.5 instead of 85.
 */
function validateRawHook(raw: unknown, projectId: string): Hook | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const c = raw as Record<string, unknown>;

  // Accept numeric startMs (coerce float → int)
  const startMsRaw = c['startMs'] ?? c['start_ms'] ?? c['start'];
  if (typeof startMsRaw !== 'number' || !Number.isFinite(startMsRaw) || startMsRaw < 0) return null;
  const startMs = Math.round(startMsRaw);

  // Accept numeric endMs (coerce float → int), must be > startMs
  const endMsRaw = c['endMs'] ?? c['end_ms'] ?? c['end'];
  if (typeof endMsRaw !== 'number' || !Number.isFinite(endMsRaw) || endMsRaw <= startMsRaw) return null;
  const endMs = Math.round(endMsRaw);

  // Accept numeric viralScore in [0,100] (coerce float → int)
  const vsRaw = c['viralScore'] ?? c['viral_score'] ?? c['score'] ?? 50;
  if (typeof vsRaw !== 'number' || !Number.isFinite(vsRaw) || vsRaw < 0 || vsRaw > 100) return null;
  const viralScore = Math.round(vsRaw);

  // summary must be a string (empty is ok, use fallback)
  const summaryRaw = c['summary'] ?? c['description'] ?? c['text'] ?? '';
  const summary = typeof summaryRaw === 'string' ? summaryRaw.trim() : 'Viral segment';

  return {
    id: randomUUID(),
    projectId,
    startMs,
    endMs,
    viralScore,
    summary: summary || 'Viral segment',
    dismissed: false,
  };
}

/**
 * Parse and validate hooks from a raw Ollama LLM response.
 */
export function parseHooks(raw: unknown, projectId: string): Hook[] {
  if (!Array.isArray(raw)) return [];

  const hooks: Hook[] = [];
  for (const item of raw) {
    const hook = validateRawHook(item, projectId);
    if (hook !== null) hooks.push(hook);
  }
  return hooks;
}

/**
 * Clamp a list of hooks to max 20 (keep highest viralScore).
 */
export function clampHooks(hooks: Hook[], _projectId: string): Hook[] {
  if (hooks.length <= 20) return hooks;
  return [...hooks].sort((a, b) => b.viralScore - a.viralScore).slice(0, 20);
}
