import { describe, it, expect } from 'vitest';
import { parseTimeInput } from '../../renderer/components/project/TimelineScrubber';

describe('parseTimeInput', () => {
  it('parses MM:SS format correctly', () => {
    expect(parseTimeInput('01:23')).toBe(83000);
    expect(parseTimeInput('00:05')).toBe(5000);
  });

  it('parses MM:SS.mmm format with milliseconds correctly', () => {
    expect(parseTimeInput('01:23.456')).toBe(83456);
    expect(parseTimeInput('00:05.123')).toBe(5123);
    expect(parseTimeInput('01:23.4')).toBe(83400);
    expect(parseTimeInput('01:23.45')).toBe(83450);
  });

  it('parses plain seconds format correctly', () => {
    expect(parseTimeInput('90')).toBe(90000);
    expect(parseTimeInput('12.5')).toBe(12500);
    expect(parseTimeInput('12.523')).toBe(12523);
  });

  it('returns null for invalid inputs', () => {
    expect(parseTimeInput('')).toBeNull();
    expect(parseTimeInput('abc')).toBeNull();
    expect(parseTimeInput('01:65')).toBeNull();
  });
});
