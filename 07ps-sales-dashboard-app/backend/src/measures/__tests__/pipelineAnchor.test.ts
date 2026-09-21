import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parsePipelineAnchor } from '../filters';

describe('parsePipelineAnchor -- Pipeline pages are current-year YTD only', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-03-15T10:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('defaults to today (derived from the clock, not a hardcoded year)', () => {
    expect(parsePipelineAnchor(undefined).toISOString().slice(0, 10)).toBe('2027-03-15');
    expect(parsePipelineAnchor('not-a-date').toISOString().slice(0, 10)).toBe('2027-03-15');
  });

  it('keeps an anchor that falls inside the current year', () => {
    expect(parsePipelineAnchor('2027-02-01').toISOString().slice(0, 10)).toBe('2027-02-01');
  });

  it('falls back to today for an anchor in a previous year', () => {
    expect(parsePipelineAnchor('2026-12-31').toISOString().slice(0, 10)).toBe('2027-03-15');
  });

  it('falls back to today for a future anchor', () => {
    expect(parsePipelineAnchor('2027-12-31').toISOString().slice(0, 10)).toBe('2027-03-15');
  });
});
