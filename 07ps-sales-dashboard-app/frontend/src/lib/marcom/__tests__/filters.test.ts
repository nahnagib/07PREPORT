import { describe, expect, it } from 'vitest';
import { apiQuery, brandsForCompanies, withCompanies, EMPTY_FILTERS, hasFilterParams, isDefaultFilters, MarcomFilters, parseFilters, restoreFilters, serializeForStorage, toSearchParams } from '../filters';

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
  it('campaigns: the chosen From..To (campaigns overlapping it), brands and status; the whole year by default', () => {
    expect(apiQuery('campaigns', all)).toBe('year=2026&fromMonth=2&toMonth=8&brandIds=1%2C2&status=Ongoing');
    expect(apiQuery('campaigns', f({ year: 2026 }))).toBe('year=2026&fromMonth=1&toMonth=12');
  });
  it('companyKeys go to the pages with a Company filter only', () => {
    const c = f({ companyKeys: [2, 1] });
    expect(apiQuery('spending', c)).toBe('companyKeys=1%2C2');
    expect(apiQuery('trade', c)).toBe('companyKeys=1%2C2');
    expect(apiQuery('digital', c)).toBe('');
  });
  it('company -> brand cascade: brand options narrow to the company, and brands outside it are dropped', () => {
    const brands = [{ id: 1, companyKey: 10 }, { id: 2, companyKey: 10 }, { id: 3, companyKey: 20 }, { id: 4, companyKey: null }];
    expect(brandsForCompanies(brands, []).map((b) => b.id)).toEqual([1, 2, 3, 4]);
    expect(brandsForCompanies(brands, [10]).map((b) => b.id)).toEqual([1, 2]);
    expect(withCompanies(f({ brandIds: [1, 3, 4] }), [10], brands)).toMatchObject({ companyKeys: [10], brandIds: [1] });
    expect(withCompanies(f({ brandIds: [1, 3] }), [], brands).brandIds).toEqual([1, 3]);
  });
  it('companyKeys round-trip through the URL', () => {
    expect(parseFilters(toSearchParams(f({ companyKeys: [3, 1] }))).companyKeys).toEqual([1, 3]);
  });
  it('with no filters, only what the page must send: the API picks its defaults', () => {
    expect(apiQuery('spending', f())).toBe('');
    expect(apiQuery('digital', f())).toBe('');
    expect(apiQuery('campaigns', f())).toBe('fromMonth=1&toMonth=12');
  });
});
