import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLatestGate, debounce } from '../requestGate';

describe('latest-request-wins gate', () => {
  it('only the newest ticket may publish', () => {
    const g = createLatestGate();
    const a = g.next();
    const b = g.next();
    expect(g.isLatest(a)).toBe(false);
    expect(g.isLatest(b)).toBe(true);
  });

  it('a slow response to an earlier filter change never overwrites a newer one', async () => {
    const g = createLatestGate();
    let shown = '';
    const load = (label: string, ms: number) => {
      const ticket = g.next();
      return new Promise<void>((resolve) => setTimeout(() => { if (g.isLatest(ticket)) shown = label; resolve(); }, ms));
    };
    vi.useFakeTimers();
    const slowFirst = load('filter A (slow)', 500);
    const fastSecond = load('filter B (fast)', 50);
    await vi.advanceTimersByTimeAsync(600);
    await Promise.all([slowFirst, fastSecond]);
    vi.useRealTimers();
    expect(shown).toBe('filter B (fast)');
  });

  it('cancelAll invalidates everything in flight (unmount)', () => {
    const g = createLatestGate();
    const t = g.next();
    g.cancelAll();
    expect(g.isLatest(t)).toBe(false);
  });
});

describe('debounce', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('collapses a burst of filter changes into one call with the last value', () => {
    const fn = vi.fn();
    const d = debounce(fn, 250);
    d('a'); d('b'); d('c');
    vi.advanceTimersByTime(249);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('c');
  });
  it('cancel drops the pending call', () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d(1);
    d.cancel();
    vi.advanceTimersByTime(500);
    expect(fn).not.toHaveBeenCalled();
  });
});
