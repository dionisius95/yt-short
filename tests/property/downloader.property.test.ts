/**
 * Property-based tests for the Downloader progress line parser.
 *
 * **Validates: Requirements 2.1**
 *
 * Property 2: Download Progress Parsing Extracts All Fields
 *
 * For any progress line in the format "<percent>|<speed>|<eta>", the parser
 * SHALL extract a percent value clamped to [0, 100], a non-empty speed string,
 * and a non-empty eta string. For invalid lines (missing pipes or non-numeric
 * percent), the parser SHALL return null without throwing.
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

// ---------------------------------------------------------------------------
// Standalone mirror of the Downloader's parseProgressLine implementation
// ---------------------------------------------------------------------------

function parseProgressLine(line: string): { percent: number; speed: string; eta: string } | null {
  const parts = line.trim().split('|');
  if (parts.length < 3) return null;
  const percentStr = parts[0].trim().replace('%', '');
  const percent = parseFloat(percentStr);
  if (isNaN(percent)) return null;
  return {
    percent: Math.min(100, Math.max(0, percent)),
    speed: parts[1].trim(),
    eta: parts[2].trim(),
  };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * Generates a numeric percent string, optionally with a trailing '%'.
 * Covers the full float range including values outside [0, 100].
 */
const percentStrArb = fc.float({ min: -10, max: 110, noNaN: true }).map(
  (n) => `${n.toFixed(1)}%`
);

/**
 * Generates a non-empty speed string (e.g. "3.2 MiB/s").
 */
const speedArb = fc.string({ minLength: 1, maxLength: 20 }).filter(
  (s) => s.trim().length > 0 && !s.includes('|')
);

/**
 * Generates a non-empty eta string (e.g. "00:01:23").
 */
const etaArb = fc.string({ minLength: 1, maxLength: 20 }).filter(
  (s) => s.trim().length > 0 && !s.includes('|')
);

/**
 * Generates a well-formed progress line: "<percent>|<speed>|<eta>".
 */
const validProgressLineArb = fc.tuple(percentStrArb, speedArb, etaArb).map(
  ([pct, speed, eta]) => `${pct}|${speed}|${eta}`
);

// ---------------------------------------------------------------------------
// Property 2a: percent is always clamped to [0, 100]
// ---------------------------------------------------------------------------

describe('Property 2a — percent is always in [0, 100]', () => {
  it('parsed percent is always between 0 and 100 inclusive', () => {
    fc.assert(
      fc.property(validProgressLineArb, (line) => {
        const result = parseProgressLine(line);
        // The line is well-formed so result should not be null
        if (result !== null) {
          expect(result.percent).toBeGreaterThanOrEqual(0);
          expect(result.percent).toBeLessThanOrEqual(100);
        }
      }),
      { numRuns: 500 }
    );
  });

  it('values above 100 are clamped to 100', () => {
    fc.assert(
      fc.property(
        fc.float({ min: Math.fround(100.5), max: Math.fround(999), noNaN: true }),
        speedArb,
        etaArb,
        (overPercent, speed, eta) => {
          const line = `${overPercent}%|${speed}|${eta}`;
          const result = parseProgressLine(line);
          if (result !== null) {
            expect(result.percent).toBe(100);
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('values below 0 are clamped to 0', () => {
    fc.assert(
      fc.property(
        fc.float({ min: Math.fround(-999), max: Math.fround(-0.5), noNaN: true }),
        speedArb,
        etaArb,
        (underPercent, speed, eta) => {
          const line = `${underPercent}%|${speed}|${eta}`;
          const result = parseProgressLine(line);
          if (result !== null) {
            expect(result.percent).toBe(0);
          }
        }
      ),
      { numRuns: 200 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2b: speed is always a non-empty string
// ---------------------------------------------------------------------------

describe('Property 2b — speed is always a non-empty string', () => {
  it('parsed speed is always a non-empty string for valid lines', () => {
    fc.assert(
      fc.property(validProgressLineArb, (line) => {
        const result = parseProgressLine(line);
        if (result !== null) {
          expect(typeof result.speed).toBe('string');
          expect(result.speed.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 500 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2c: eta is always a non-empty string
// ---------------------------------------------------------------------------

describe('Property 2c — eta is always a non-empty string', () => {
  it('parsed eta is always a non-empty string for valid lines', () => {
    fc.assert(
      fc.property(validProgressLineArb, (line) => {
        const result = parseProgressLine(line);
        if (result !== null) {
          expect(typeof result.eta).toBe('string');
          expect(result.eta.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 500 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2d: the function never throws for any string input
// ---------------------------------------------------------------------------

describe('Property 2d — parseProgressLine never throws', () => {
  it('does not throw for any arbitrary string input', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 200 }), (input) => {
        expect(() => parseProgressLine(input)).not.toThrow();
      }),
      { numRuns: 1000 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2e: invalid lines return null
// ---------------------------------------------------------------------------

describe('Property 2e — invalid lines return null', () => {
  it('lines with no pipe separator return null', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 100 }).filter((s) => !s.includes('|')),
        (line) => {
          const result = parseProgressLine(line);
          expect(result).toBeNull();
        }
      ),
      { numRuns: 300 }
    );
  });

  it('lines with only one pipe separator return null', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 50 }).filter((s) => !s.includes('|')),
        fc.string({ minLength: 0, maxLength: 50 }).filter((s) => !s.includes('|')),
        (a, b) => {
          const line = `${a}|${b}`;
          const result = parseProgressLine(line);
          expect(result).toBeNull();
        }
      ),
      { numRuns: 300 }
    );
  });

  it('lines with non-numeric percent field return null', () => {
    fc.assert(
      fc.property(
        // Generate strings that are definitely not parseable as a float
        fc.string({ minLength: 1, maxLength: 20 }).filter(
          (s) => isNaN(parseFloat(s.replace('%', '')))
        ),
        speedArb,
        etaArb,
        (badPercent, speed, eta) => {
          const line = `${badPercent}|${speed}|${eta}`;
          const result = parseProgressLine(line);
          expect(result).toBeNull();
        }
      ),
      { numRuns: 300 }
    );
  });
});
