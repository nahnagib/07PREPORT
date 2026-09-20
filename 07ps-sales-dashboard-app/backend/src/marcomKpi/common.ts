import { Rat, R, sum } from './rat';

export type Num = string | number;

export const MONTH_KEYS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;

export function monthRange(from: number, to: number): number[] {
  const out: number[] = [];
  for (let m = from; m <= to; m++) out.push(m);
  return out;
}

export function groupBy<T, K>(rows: T[], key: (r: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = m.get(k);
    if (list) list.push(r); else m.set(k, [r]);
  }
  return m;
}

/** Exact sum of a numeric field across rows. */
export const total = <T>(rows: T[], pick: (r: T) => Num): Rat => sum(rows.map((r) => R(pick(r))));

export interface BrandRef { id: number; name: string }

/** Common echo of the filters that were actually applied (after defaults). */
export interface AppliedPeriod { year: number; fromMonth: number; toMonth: number }
