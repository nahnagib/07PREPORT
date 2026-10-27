import type { PageKey } from './types';

/**
 * Filter state for the MARCOM pages: one model shared by all four, round-tripped through the URL
 * (shareable) and sessionStorage (kept while moving between the four pages). `undefined` year /
 * months mean "let the API pick its default (latest uploaded period)".
 */
export interface MarcomFilters {
  year?: number;
  fromMonth?: number;
  toMonth?: number;
  /** Dim_Company keys (migration 0057: brands belong to companies). Narrows the Brand options. */
  companyKeys: number[];
  brandIds: number[];
  platforms: string[];
  statuses: string[];
  completedOnly: boolean;
}

export const EMPTY_FILTERS: MarcomFilters = { companyKeys: [], brandIds: [], platforms: [], statuses: [], completedOnly: false };
export const STORAGE_KEY = 'marcom.filters.v1';

/** Which controls each page shows. */
/**
 * Which controls each page shows. `futureMonths`: months after the latest upload stay selectable and the
 * default To is December -- campaigns are planned ahead, so that page keeps showing the whole year by default.
 */
export const PAGE_CONTROLS: Record<PageKey, { months: boolean; futureMonths: boolean; company: boolean; brand: boolean; platform: boolean; status: boolean }> = {
  spending: { months: true, futureMonths: false, company: true, brand: true, platform: false, status: false },
  // Campaigns are date ranges: the API returns every campaign overlapping From..To.
  campaigns: { months: true, futureMonths: true, company: true, brand: true, platform: false, status: true },
  digital: { months: true, futureMonths: false, company: false, brand: false, platform: true, status: false },
  trade: { months: true, futureMonths: false, company: true, brand: true, platform: false, status: false },
};

const FILTER_KEYS = ['year', 'fromMonth', 'toMonth', 'companyKeys', 'brandIds', 'platforms', 'status', 'completedOnly'] as const;

const intIn = (v: string | null | undefined, min: number, max: number): number | undefined => {
  if (v === null || v === undefined || !/^\d{1,4}$/.test(v.trim())) return undefined;
  const n = Number(v);
  return n >= min && n <= max ? n : undefined;
};

const list = (v: string | null): string[] =>
  v ? [...new Set(v.split(',').map((s) => s.trim()).filter(Boolean))] : [];

/** Tolerant parse: anything invalid is dropped rather than throwing. */
export function parseFilters(search: string | URLSearchParams): MarcomFilters {
  const p = typeof search === 'string' ? new URLSearchParams(search) : search;
  let fromMonth = intIn(p.get('fromMonth'), 1, 12);
  let toMonth = intIn(p.get('toMonth'), 1, 12);
  if (fromMonth !== undefined && toMonth !== undefined && fromMonth > toMonth) { fromMonth = undefined; toMonth = undefined; }
  return {
    year: intIn(p.get('year'), 2020, 2100),
    fromMonth,
    toMonth,
    companyKeys: list(p.get('companyKeys')).filter((s) => /^\d+$/.test(s)).map(Number),
    brandIds: list(p.get('brandIds')).filter((s) => /^\d+$/.test(s)).map(Number),
    platforms: list(p.get('platforms')),
    statuses: list(p.get('status')),
    completedOnly: p.get('completedOnly') === 'true',
  };
}

export function hasFilterParams(search: string | URLSearchParams): boolean {
  const p = typeof search === 'string' ? new URLSearchParams(search) : search;
  return FILTER_KEYS.some((k) => p.has(k));
}

/** Only non-default values are written, so a default view has a clean URL. */
export function toSearchParams(f: MarcomFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.year !== undefined) p.set('year', String(f.year));
  if (f.fromMonth !== undefined) p.set('fromMonth', String(f.fromMonth));
  if (f.toMonth !== undefined) p.set('toMonth', String(f.toMonth));
  if (f.companyKeys.length) p.set('companyKeys', [...f.companyKeys].sort((a, b) => a - b).join(','));
  if (f.brandIds.length) p.set('brandIds', [...f.brandIds].sort((a, b) => a - b).join(','));
  if (f.platforms.length) p.set('platforms', [...f.platforms].join(','));
  if (f.statuses.length) p.set('status', [...f.statuses].join(','));
  if (f.completedOnly) p.set('completedOnly', 'true');
  return p;
}

export const isDefaultFilters = (f: MarcomFilters): boolean => toSearchParams(f).toString() === '';

/** The query string sent to the API for a page: only the params that page understands. */
export function apiQuery(page: PageKey, f: MarcomFilters): string {
  const p = new URLSearchParams();
  if (f.year !== undefined) p.set('year', String(f.year));
  if (PAGE_CONTROLS[page].futureMonths && f.toMonth === undefined) {
    // Default view of the campaigns page: the whole year (planned campaigns included).
    p.set('fromMonth', String(f.fromMonth ?? 1));
    p.set('toMonth', '12');
  } else {
    if (f.fromMonth !== undefined) p.set('fromMonth', String(f.fromMonth));
    if (f.toMonth !== undefined) p.set('toMonth', String(f.toMonth));
  }
  if (PAGE_CONTROLS[page].company && f.companyKeys.length) p.set('companyKeys', [...f.companyKeys].sort((a, b) => a - b).join(','));
  if ((page === 'spending' || page === 'campaigns' || page === 'trade') && f.brandIds.length) p.set('brandIds', [...f.brandIds].sort((a, b) => a - b).join(','));
  if (page === 'digital' && f.platforms.length) p.set('platforms', f.platforms.join(','));
  if (page === 'campaigns' && f.statuses.length) p.set('status', f.statuses.join(','));
  if (page === 'trade' && f.completedOnly) p.set('completedOnly', 'true');
  return p.toString();
}

/** URL params win; with none in the URL, fall back to the session-stored filters. */
export function restoreFilters(urlSearch: string, stored: string | null): MarcomFilters {
  if (hasFilterParams(urlSearch)) return parseFilters(urlSearch);
  if (stored) {
    try { return parseFilters(String(JSON.parse(stored))); } catch { /* corrupt storage: ignore */ }
  }
  return { ...EMPTY_FILTERS };
}

/**
 * Brands offered for the current Company selection (all brands when no company is selected). The
 * cascade: picking a company narrows the Brand options to that company's brands.
 */
export function brandsForCompanies<B extends { id: number; companyKey?: number | null }>(brands: B[], companyKeys: number[]): B[] {
  return companyKeys.length ? brands.filter((b) => b.companyKey !== null && b.companyKey !== undefined && companyKeys.includes(b.companyKey)) : brands;
}

/** Applies a new Company selection and drops selected brands that no longer belong to it. */
export function withCompanies<B extends { id: number; companyKey?: number | null }>(f: MarcomFilters, companyKeys: number[], brands: B[]): MarcomFilters {
  const allowed = new Set(brandsForCompanies(brands, companyKeys).map((b) => b.id));
  return { ...f, companyKeys, brandIds: f.brandIds.filter((id) => allowed.has(id)) };
}

export const serializeForStorage = (f: MarcomFilters): string => JSON.stringify(toSearchParams(f).toString());

// ---- storage access that never throws (private windows, blocked storage) --------------------

export function readStored(): string | null {
  try { return typeof window === 'undefined' ? null : window.sessionStorage.getItem(STORAGE_KEY); } catch { return null; }
}
export function writeStored(f: MarcomFilters): void {
  try { if (typeof window !== 'undefined') window.sessionStorage.setItem(STORAGE_KEY, serializeForStorage(f)); } catch { /* ignore */ }
}
export function clearStored(): void {
  try { if (typeof window !== 'undefined') window.sessionStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}
