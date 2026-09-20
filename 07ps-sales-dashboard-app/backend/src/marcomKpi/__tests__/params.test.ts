import { describe, expect, it } from 'vitest';
import { KpiParamError, applyDefaults, parseBool, parseBrandIds, parseCommonRaw, parsePlatforms, parseStatuses } from '../params';
import { buildCurrentQuery, where } from '../db';

const known = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }];

describe('query parameter validation', () => {
  it('accepts valid year/month params and rejects bad ones with a clear message', () => {
    expect(parseCommonRaw({ year: '2026', fromMonth: '2', toMonth: '5' })).toEqual({ year: 2026, fromMonth: 2, toMonth: 5 });
    expect(parseCommonRaw({})).toEqual({ year: undefined, fromMonth: undefined, toMonth: undefined });
    for (const bad of [{ year: 'abc' }, { year: '2026.5' }, { year: '1999' }, { year: '2101' }, { fromMonth: '0' }, { toMonth: '13' }, { fromMonth: '-1' }, { year: ['2026', '2027'] }, { fromMonth: '1; DROP TABLE x' }]) {
      expect(() => parseCommonRaw(bad)).toThrow(KpiParamError);
    }
    expect(() => parseCommonRaw({ fromMonth: '6', toMonth: '3' })).toThrow(/fromMonth must not be after toMonth/);
  });

  it('brandIds: repeated, bracketed and comma forms; unknown / non-numeric ids are 400s', () => {
    expect(parseBrandIds({ brandIds: ['1', '2'] }, known)).toEqual([1, 2]);
    expect(parseBrandIds({ 'brandIds[]': ['2'] }, known)).toEqual([2]);
    expect(parseBrandIds({ brandIds: '1,2,1' }, known)).toEqual([1, 2]);
    expect(parseBrandIds({}, known)).toBeUndefined();
    expect(() => parseBrandIds({ brandIds: '1,9' }, known)).toThrow(/Unknown brand id\(s\): 9/);
    expect(() => parseBrandIds({ brandIds: '1 OR 1=1' }, known)).toThrow(KpiParamError);
    expect(() => parseBrandIds({ brandIds: { $ne: 1 } }, known)).toThrow(KpiParamError);
  });

  it('platforms and status are validated against the enums', () => {
    expect(parsePlatforms({ platforms: 'Facebook,TikTok' })).toEqual(['Facebook', 'TikTok']);
    expect(() => parsePlatforms({ platforms: 'Myspace' })).toThrow(/Unknown platforms/);
    expect(parseStatuses({ status: ['Ongoing', 'On Hold'] })).toEqual(['Ongoing', 'On Hold']);
    expect(() => parseStatuses({ status: 'Bogus' })).toThrow(/Unknown status/);
  });

  it('booleans', () => {
    expect(parseBool({ completedOnly: 'true' }, 'completedOnly')).toBe(true);
    expect(parseBool({ completedOnly: '0' }, 'completedOnly')).toBe(false);
    expect(parseBool({}, 'completedOnly')).toBeUndefined();
    expect(() => parseBool({ completedOnly: 'yes' }, 'completedOnly')).toThrow(KpiParamError);
  });

  it('defaults: latest uploaded period, fromMonth 1, and never toMonth < fromMonth', () => {
    expect(applyDefaults({}, { year: 2026, month: 8 }, 2030)).toEqual({ year: 2026, fromMonth: 1, toMonth: 8 });
    expect(applyDefaults({ year: 2025 }, { year: 2025, month: 12 }, 2030)).toEqual({ year: 2025, fromMonth: 1, toMonth: 12 });
    expect(applyDefaults({ fromMonth: 10 }, { year: 2026, month: 8 }, 2030)).toEqual({ year: 2026, fromMonth: 10, toMonth: 10 });
    expect(applyDefaults({}, null, 2030)).toEqual({ year: 2030, fromMonth: 1, toMonth: 12 });
  });
});

describe('query builder (is_current + parameterisation)', () => {
  it('always filters on is_current = 1 and binds every value', () => {
    const q = buildCurrentQuery('spend', {
      select: 't.spend AS spend',
      where: [where.eq('t.year', 2026), where.in('t.brand_id', [1, 2]), null, where.between('t.month', 1, 3)],
    });
    expect(q.sql).toContain('t.is_current = 1');
    expect(q.sql).toBe('SELECT t.spend AS spend FROM marcom_spend_monthly t  WHERE t.is_current = 1 AND (t.year = ?) AND (t.brand_id IN (?, ?)) AND (t.month BETWEEN ? AND ?)');
    expect(q.params).toEqual([2026, 1, 2, 1, 3]);
  });
  it('is_current is present with no other conditions, for every table', () => {
    for (const t of ['spend', 'campaigns', 'media', 'social', 'web', 'trade', 'events'] as const) {
      expect(buildCurrentQuery(t, { select: '1' }).sql).toMatch(/WHERE t\.is_current = 1$/);
    }
  });
  it('an empty IN list matches nothing instead of producing invalid SQL', () => {
    expect(where.in('t.brand_id', [])).toEqual({ sql: '1 = 0', params: [] });
  });
  it('values never appear in the SQL text (an injection attempt is just a parameter)', () => {
    const evil = "x'; DROP TABLE marcom_event; --";
    const q = buildCurrentQuery('events', { select: 't.name', where: [where.eq('t.name', evil)] });
    expect(q.sql).not.toContain('DROP');
    expect(q.params).toEqual([evil]);
  });
  it('rejects a column reference that is not a plain alias.column', () => {
    expect(() => where.eq('t.year; DROP', 1)).toThrow(/illegal column/);
    expect(() => where.eq('year', 1)).toThrow(/illegal column/);
  });
});
