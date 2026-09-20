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
  brandIds: number[];
  platforms: string[];
  statuses: string[];
  completedOnly: boolean;
}

export const EMPTY_FILTERS: MarcomFilters = { brandIds: [], platforms: [], statuses: [], completedOnly: false };
export const STORAGE_KEY = 'marcom.filters.v1';

/** Which controls each page shows. */
export const PAGE_CONTROLS: Record<PageKey, { months: boolean; brand: boolean; platform: boolean; status: boolean }> = {
  spending: { months: true, brand: true, platform: false, status: false },
  campaigns: { months: false, brand: true, platform: false, status: true },
  digital: { months: true, brand: false, platform: true, status: false },
  trade: { months: true, brand: true, platform: false, status: false },
};

const FILTER_KEYS = ['year', 'fromMonth', 'toMonth', 'brandIds', 'platforms', 'status', 'completedOnly'] as const;

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
  if (f.brandIds.length) p.set('brandIds', [...f.brandIds].sort((a, b) => a - b).join(','));
  if (f.platforms.length) p.set('platforms', [...f.platforms].join(','));
  if (f.statuses.length) p.set('status', [...f.statuses].join(','));
  if (f.completedOnly) p.set('completedOnly', 'true');
  return p;
}

export const isDefaultFilters = (f: MarcomFilters): boolean => toSearchParams(f).toString() === '';

/**
 * The query string sent to the API for a page: only the params that page understands. Campaigns
 * are date ranges, so that page always asks for the whole year (its own filter bar has no month range).
 */
export function apiQuery(page: PageKey, f: MarcomFilters): string {
  const p = new URLSearchParams();
  if (f.year !== undefined) p.set('year', String(f.year));
  if (page === 'campaigns') {
    p.set('fromMonth', '1');
    p.set('toMonth', '12');
  } else {
    if (f.fromMonth !== undefined) p.set('fromMonth', String(f.fromMonth));
    if (f.toMonth !== undefined) p.set('toMonth', String(f.toMonth));
  }
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
