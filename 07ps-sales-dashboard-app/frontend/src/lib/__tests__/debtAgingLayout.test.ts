import { describe, expect, it } from 'vitest';
import { dotRadius, layoutAgingDots, overlaps, xOfPosition, type AgingLayoutOptions, type DotInput } from '../debt/agingLayout';

const OPTS: AgingLayoutOptions = { plotLeft: 12, plotRight: 800, cap: 4.5, overflow: { left: 816, right: 950 } };

/** A deterministic pseudo-random set of customers (same every run). */
function customers(n: number, seed = 7): DotInput[] {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  return Array.from({ length: n }, (_, i) => ({
    id: String(i + 1),
    // most customers bunch near the due date, a long tail of very old debt past the cap
    position: rnd() < 0.3 ? 4.5 + rnd() * 200 : rnd() * 4.5,
    amount: Math.round(10 ** (rnd() * 6) * 100) / 100,
  }));
}

function noOverlap(dots: ReturnType<typeof layoutAgingDots>['dots']) {
  for (let i = 0; i < dots.length; i++) for (let j = i + 1; j < dots.length; j++) {
    if (overlaps(dots[i], dots[j])) throw new Error(`dots ${dots[i].id} and ${dots[j].id} overlap`);
  }
}

describe('aging map layout', () => {
  it('no dot overlaps another at 500 customers', () => {
    const layout = layoutAgingDots(customers(500), OPTS);
    expect(layout.dots).toHaveLength(500);
    noOverlap(layout.dots);
    expect(layout.top).toBeLessThan(0);
    expect(layout.bottom).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    expect(layoutAgingDots(customers(200), OPTS)).toEqual(layoutAgingDots(customers(200), OPTS));
  });

  it('places by position on the axis; past the cap into the overflow strip, oldest at the far right', () => {
    const layout = layoutAgingDots(
      [
        { id: 'a', position: 0, amount: 10 },
        { id: 'b', position: 2.25, amount: 10 },
        { id: 'c', position: 9, amount: 10 },
        { id: 'd', position: 90, amount: 10 },
      ],
      OPTS,
    );
    const by = new Map(layout.dots.map((d) => [d.id, d]));
    expect(by.get('a')!.x).toBe(12);
    expect(by.get('b')!.x).toBeCloseTo(406);
    for (const id of ['c', 'd']) {
      const d = by.get(id)!;
      expect(d.overflow).toBe(true);
      expect(d.x).toBeGreaterThanOrEqual(816);
      expect(d.x).toBeLessThanOrEqual(950);
    }
    expect(by.get('d')!.x).toBeGreaterThan(by.get('c')!.x);
    noOverlap(layout.dots);
  });

  it('without a strip, overflow dots stay at the right edge of the axis', () => {
    const layout = layoutAgingDots([{ id: 'x', position: 50, amount: 1 }], { ...OPTS, overflow: null });
    expect(layout.dots[0]).toMatchObject({ x: 800, overflow: true });
  });

  it('one customer sits on the centre line; none gives an empty layout', () => {
    expect(layoutAgingDots([{ id: '1', position: 1, amount: 5 }], OPTS).dots[0]).toMatchObject({ y: 0 });
    expect(layoutAgingDots([], OPTS)).toEqual({ dots: [], top: 0, bottom: 0 });
  });

  it('dot area follows the amount (radius ~ square root), never below the minimum', () => {
    const big = dotRadius(1_000_000, 1_000_000);
    const quarter = dotRadius(250_000, 1_000_000);
    expect(big).toBe(16);
    expect(quarter).toBeCloseTo(8); // a quarter of the amount -> a quarter of the area -> half the radius
    expect(dotRadius(0.002, 1_000_000)).toBe(3.5);
    expect(xOfPosition(-1, OPTS)).toBe(12);
    expect(xOfPosition(99, OPTS)).toBe(800);
  });
});
