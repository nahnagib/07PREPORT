/**
 * Geometry of the Debt Report Aging Map (components/debt/DebtAgingMap.tsx): where each customer's dot goes. Pure and
 * deterministic, so it is tested on its own. No zone rule lives here -- the position (invoice age / W) and the zone
 * come from GET /debt-report/aging; this only turns them into pixels.
 *
 *   x       position on a linear axis from 0 to `cap` (the server's settings.axisCap, 4.5 by default). Dots past the cap
 *           go into the overflow strip at the right edge, spread across it in position order (worst at the far right),
 *           so a long tail of very old debts stays at the edge without piling up into one tall column.
 *   radius  proportional to the square root of the amount (dot AREA proportional to the amount), the largest amount
 *           at `maxR`; never below `minR` so a tiny balance stays visible and clickable.
 *   y       beeswarm: biggest dots first, each at the first vertical offset (0, +s, -s, +2s, ...) where it touches no
 *           dot already placed. Dots never overlap.
 */

export interface DotInput {
  id: string;
  position: number;
  amount: number;
}

export interface PlacedDot {
  id: string;
  x: number;
  /** vertical offset from the track's centre line */
  y: number;
  r: number;
  /** past the axis cap: drawn in the overflow strip */
  overflow: boolean;
}

export interface AgingLayoutOptions {
  /** x of position 0 and of the cap */
  plotLeft: number;
  plotRight: number;
  cap: number;
  /** the overflow strip, right of plotRight; null = clamp overflow dots to plotRight */
  overflow: { left: number; right: number } | null;
  minR?: number;
  maxR?: number;
  /** free space kept between two dots */
  gap?: number;
  /** vertical search step */
  step?: number;
}

export interface AgingLayout {
  dots: PlacedDot[];
  /** extent of the dots above (negative) and below the centre line, outer edges included */
  top: number;
  bottom: number;
}

export const DEFAULT_MIN_R = 3.5;
export const DEFAULT_MAX_R = 16;

export function xOfPosition(position: number, o: Pick<AgingLayoutOptions, 'plotLeft' | 'plotRight' | 'cap'>): number {
  const p = Math.min(Math.max(position, 0), o.cap);
  return o.plotLeft + (p / o.cap) * (o.plotRight - o.plotLeft);
}

export function dotRadius(amount: number, maxAmount: number, minR = DEFAULT_MIN_R, maxR = DEFAULT_MAX_R): number {
  if (!(maxAmount > 0) || !(amount > 0)) return minR;
  return Math.max(minR, maxR * Math.sqrt(amount / maxAmount));
}

export function layoutAgingDots(input: DotInput[], o: AgingLayoutOptions): AgingLayout {
  const minR = o.minR ?? DEFAULT_MIN_R;
  const maxR = o.maxR ?? DEFAULT_MAX_R;
  const gap = o.gap ?? 1.5;
  const step = o.step ?? 1;
  const maxAmount = input.reduce((m, d) => Math.max(m, d.amount), 0);

  // x: on the axis, or spread across the overflow strip by rank
  const over = input.filter((d) => d.position > o.cap).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  const rank = new Map(over.map((d, i) => [d.id, i]));
  const xOf = (d: DotInput): number => {
    const i = rank.get(d.id);
    if (i === undefined) return xOfPosition(d.position, o);
    if (!o.overflow) return o.plotRight;
    const { left, right } = o.overflow;
    return over.length === 1 ? (left + right) / 2 : left + ((i + 0.5) / over.length) * (right - left);
  };

  const todo = input
    .map((d) => ({ id: d.id, x: xOf(d), r: dotRadius(d.amount, maxAmount, minR, maxR), overflow: rank.has(d.id) }))
    .sort((a, b) => b.r - a.r || a.x - b.x || a.id.localeCompare(b.id));

  const placed: PlacedDot[] = [];
  for (const d of todo) {
    const reach = d.r + maxR + gap;
    const near = placed.filter((p) => Math.abs(p.x - d.x) < reach);
    const free = (y: number) => near.every((p) => Math.hypot(p.x - d.x, p.y - y) >= p.r + d.r + gap);
    let y = 0;
    // alternate below / above the centre line; a free offset always exists (the neighbours are finite)
    for (let k = 1; !free(y); k++) y = (k % 2 === 1 ? 1 : -1) * Math.ceil(k / 2) * step;
    placed.push({ ...d, y });
  }
  return {
    dots: placed,
    top: placed.reduce((m, p) => Math.min(m, p.y - p.r), 0),
    bottom: placed.reduce((m, p) => Math.max(m, p.y + p.r), 0),
  };
}

/** True when two placed dots overlap (the tests' check). */
export function overlaps(a: PlacedDot, b: PlacedDot): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r - 1e-9;
}
