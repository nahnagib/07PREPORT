import { describe, expect, it } from 'vitest';
import { apiQuery, EMPTY_FILTERS, hasFilterParams, isDefaultFilters, MarcomFilters, parseFilters, restoreFilters, serializeForStorage, toSearchParams } from '../filters';

const f = (o: Partial<MarcomFilters> = {}): MarcomFilters => ({ ...EMPTY_FILTERS, ...o });

describe('filter <-> URL round trip (shareable links)', () => {
  it('a default view has a clean URL', () => {
    expect(toSearchParams(f()).toString()).toBe('');
    expect(isDefaultFilters(f())).toBe(true);
  });

  it('every filter survives serialise -> parse', () => {
    const full = f({ year: 2026, fromMonth: 2, toMonth: 8, brandIds: [3, 1], platforms: ['TikTok', 'Facebook'], statuses: ['Ongoing', 'On Hold'], completedOnly: true });
    const qs = toSearchParams(full).toString();
    expect(qs).toBe('year=2026&fromMonth=2&toMonth=8&brandIds=1%2C3&platforms=TikTok%2CFacebook&status=Ongoing%2COn+Hold&completedOnly=true');
    expect(parseFilters(qs)).toEqual(f({ year: 2026, fromMonth: 2, toMonth: 8, brandIds: [1, 3], platforms: ['TikTok', 'Facebook'], statuses: ['Ongoing', 'On Hold'], completedOnly: true }));
  });

  it('a pasted URL restores the same view', () => {
    expect(parseFilters('?year=2025&fromMonth=1&toMonth=6&brandIds=2')).toEqual(f({ year: 2025, fromMonth: 1, toMonth: 6, brandIds: [2] }));
  });

  it('tolerates garbage instead of throwing', () => {
    expect(parseFilters('year=abc&fromMonth=0&toMonth=13&brandIds=1,x,2&completedOnly=maybe')).toEqual(f({ brandIds: [1, 2] }));
    expect(parseFilters('year=1999')).toEqual(f());
    expect(parseFilters('fromMonth=9&toMonth=3')).toEqual(f()); // inverted range dropped
    expect(parseFilters('brandIds=1,1,1').brandIds).toEqual([1]);
  });

  it('detects whether the URL carries any filter', () => {
    expect(hasFilterParams('')).toBe(false);
    expect(hasFilterParams('foo=bar')).toBe(false);
    expect(hasFilterParams('year=2026')).toBe(true);
  });
});

describe('persistence while moving between the four pages', () => {
  const stored = serializeForStorage(f({ year: 2026, brandIds: [2], fromMonth: 3, toMonth: 5 }));

  it('with no filters in the URL, the session-stored filters are restored', () => {
    expect(restoreFilters('', stored)).toEqual(f({ year: 2026, brandIds: [2], fromMonth: 3, toMonth: 5 }));
  });
  it('URL filters win over stored ones (a shared link is not overridden by your session)', () => {
    expect(restoreFilters('year=2025', stored)).toEqual(f({ year: 2025 }));
  });
  it('nothing stored and nothing in the URL means defaults', () => {
    expect(restoreFilters('', null)).toEqual(f());
  });
  it('corrupt storage is ignored', () => {
    expect(restoreFilters('', '{not json')).toEqual(f());
    expect(restoreFilters('', '123')).toEqual(f());
  });
  it('Reset = defaults again', () => {
    expect(isDefaultFilters(restoreFilters('', null))).toBe(true);
  });
});

describe('API query per page (only params that page understands)', () => {
  const all = f({ year: 2026, fromMonth: 2, toMonth: 8, brandIds: [2, 1], platforms: ['TikTok'], statuses: ['Ongoing'], completedOnly: true });

  it('spending: year, months, brands', () => {
    expect(apiQuery('spending', all)).toBe('year=2026&fromMonth=2&toMonth=8&brandIds=1%2C2');
  });
  it('digital: year, months, platforms', () => {
    expect(apiQuery('digital', all)).toBe('year=2026&fromMonth=2&toMonth=8&platforms=TikTok');
  });
  it('trade: year, months, brands, completedOnly (only when on)', () => {
    expect(apiQuery('trade', all)).toBe('year=2026&fromMonth=2&toMonth=8&brandIds=1%2C2&completedOnly=true');
    expect(apiQuery('trade', f({ year: 2026 }))).toBe('year=2026');
  });
  it('campaigns: the whole year (no month filter on that page), brands and status', () => {
    expect(apiQuery('campaigns', all)).toBe('year=2026&fromMonth=1&toMonth=12&brandIds=1%2C2&status=Ongoing');
  });
  it('with no filters, only what the page must send: the API picks its defaults', () => {
    expect(apiQuery('spending', f())).toBe('');
    expect(apiQuery('digital', f())).toBe('');
    expect(apiQuery('campaigns', f())).toBe('fromMonth=1&toMonth=12');
  });
});
