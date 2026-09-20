import { Rat, pct } from './rat';
import { Bound, RAG_RULES, RagRuleKey } from './thresholds';

export type Status = 'green' | 'yellow' | 'red' | 'neutral' | 'na';
export type Unit = 'ratio' | 'percent' | 'lyd' | 'minutes' | 'count' | 'days';
export type Direction = 'higher_better' | 'lower_better';

/**
 * The one KPI shape every number in the payloads uses. Values are RAW (never formatted strings):
 * `percent` KPIs are in percentage points (5.28 = 5.28%), `ratio` is X of "1 : X", `lyd` is LYD.
 * `previous`/`delta` appear only where a comparison is defined (documented per payload).
 */
export interface Kpi {
  value: number | null;
  status: Status;
  unit: Unit;
  previous?: number | null;
  delta?: number | null;
  direction?: Direction;
}

function holds(v: Rat, b: Bound): boolean {
  const c = v.cmp(Rat.parse(b.value));
  switch (b.op) {
    case 'gt': return c > 0;
    case 'gte': return c >= 0;
    case 'lt': return c < 0;
    case 'lte': return c <= 0;
  }
}

/** Exact classification: green if it meets the green bound, else red if it meets the red bound, else yellow. */
export function classify(rule: RagRuleKey, v: Rat | null): Status {
  if (v === null) return 'na';
  const r = RAG_RULES[rule];
  if (holds(v, r.green)) return 'green';
  if (holds(v, r.red)) return 'red';
  return 'yellow';
}

export interface KpiOptions {
  /** Threshold rule (compared against `value` in its native unit: fractions for percentages). */
  rule?: RagRuleKey;
  direction?: Direction;
  /** Comparison values are in the same native unit as `value`. */
  previous?: Rat | null;
}

/**
 * Builds a KPI from an exact native value. For unit 'percent' the native value is a FRACTION and is
 * emitted as percentage points; classification always happens on the exact native value first.
 */
export function makeKpi(unit: Unit, value: Rat | null, opts: KpiOptions = {}): Kpi {
  const out = (r: Rat | null): number | null => {
    if (r === null) return null;
    return (unit === 'percent' ? pct(r)! : r).toNumber();
  };
  const status: Status = value === null ? 'na' : opts.rule ? classify(opts.rule, value) : 'neutral';
  const k: Kpi = { value: out(value), status, unit };
  if (opts.direction) k.direction = opts.direction;
  if ('previous' in opts) {
    k.previous = out(opts.previous ?? null);
    k.delta = value !== null && opts.previous ? out(value.sub(opts.previous)) : null;
  }
  return k;
}

/** A `na` KPI (zero/missing denominator). */
export const naKpi = (unit: Unit, direction?: Direction): Kpi => makeKpi(unit, null, { direction });

/**
 * Adds the month-over-month comparison used on pages 3 and 4: `previous` is the value in the
 * previous month that has data, and `delta` is (last month in range) - (that previous month), in
 * the KPI's output unit (percentage points for percent KPIs). `value` itself stays the range
 * aggregate. Omitted (returns the KPI unchanged) when fewer than two months have data.
 */
export function withMonthlyTrend(k: Kpi, unit: Unit, last: Rat | null, prev: Rat | null): Kpi {
  if (last === null || prev === null) return k;
  const out = (r: Rat) => (unit === 'percent' ? pct(r)! : r).toNumber();
  return { ...k, previous: out(prev), delta: out(last.sub(prev)) };
}
