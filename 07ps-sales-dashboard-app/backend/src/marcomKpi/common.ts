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

export interface BrandRef {
  id: number; name: string;
  /** Dim_Company.CompanyKey (= admin_company.etl_company_key) the brand belongs to; null = not assigned (migration 0057). */
  companyKey?: number | null;
  company?: string | null;
}

export interface CompanyRef { key: number; name: string }

/** Label used for brands that have no company assigned yet. */
export const UNASSIGNED_COMPANY = 'Unassigned';

/**
 * The companies the given brands belong to, in name order, with "Unassigned" (key null) last when any
 * brand has no company. Each entry lists its brand ids -- the By Company views sum those brands first.
 */
export function companiesOf(brands: BrandRef[]): { key: number | null; name: string; brandIds: number[] }[] {
  const map = new Map<number | null, { key: number | null; name: string; brandIds: number[] }>();
  for (const b of brands) {
    const key = b.companyKey ?? null;
    const name = key === null ? UNASSIGNED_COMPANY : (b.company ?? `#${key}`);
    const e = map.get(key) ?? { key, name, brandIds: [] };
    e.brandIds.push(b.id);
    map.set(key, e);
  }
  return [...map.values()].sort((a, b) => (a.key === null ? 1 : 0) - (b.key === null ? 1 : 0) || a.name.localeCompare(b.name));
}

/** Common echo of the filters that were actually applied (after defaults). */
export interface AppliedPeriod { year: number; fromMonth: number; toMonth: number }
