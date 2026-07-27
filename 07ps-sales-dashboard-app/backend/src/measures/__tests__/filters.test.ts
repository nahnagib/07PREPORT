import { describe, expect, it } from 'vitest';
import {
  DataScopeError,
  EMPTY_FILTERS,
  SalespersonLockError,
  applyRoleDataScope,
  applySalespersonLock,
  buildWhereClause,
  dateOnlyUTC,
  flmWindow,
  flyWindow,
  lmtdWindow,
  lytdWindow,
  monthElapsedFraction,
  mtdWindow,
  prorateMtdTarget,
  prorateYtdTarget,
  ytdWindow,
  type DataScopeRule,
  type Filters,
  type UserContext,
} from '../filters';

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

describe('date windows', () => {
  it('mtdWindow', () => {
    const w = mtdWindow(dateOnlyUTC(2026, 7, 5));
    expect(iso(w.start)).toBe('2026-07-01');
    expect(iso(w.end)).toBe('2026-07-05');
  });

  it('ytdWindow', () => {
    const w = ytdWindow(dateOnlyUTC(2026, 7, 5));
    expect(iso(w.start)).toBe('2026-01-01');
    expect(iso(w.end)).toBe('2026-07-05');
  });

  it('lmtdWindow shifts one year back', () => {
    const w = lmtdWindow(dateOnlyUTC(2026, 7, 5));
    expect(iso(w.start)).toBe('2025-07-01');
    expect(iso(w.end)).toBe('2025-07-05');
  });

  it('lytdWindow shifts one year back', () => {
    const w = lytdWindow(dateOnlyUTC(2026, 7, 5));
    expect(iso(w.start)).toBe('2025-01-01');
    expect(iso(w.end)).toBe('2025-07-05');
  });

  it('leap day anchor shifts to feb 28', () => {
    const w = lmtdWindow(dateOnlyUTC(2024, 2, 29));
    expect(iso(w.end)).toBe('2023-02-28');
  });

  it('flyWindow is full prior calendar year', () => {
    const w = flyWindow(dateOnlyUTC(2026, 3, 15));
    expect(iso(w.start)).toBe('2025-01-01');
    expect(iso(w.end)).toBe('2025-12-31');
  });

  it('flmWindow is full prior calendar month', () => {
    const w = flmWindow(dateOnlyUTC(2026, 7, 5));
    expect(iso(w.start)).toBe('2026-06-01');
    expect(iso(w.end)).toBe('2026-06-30');
  });

  it('flmWindow handles january year wraparound', () => {
    const w = flmWindow(dateOnlyUTC(2026, 1, 15));
    expect(iso(w.start)).toBe('2025-12-01');
    expect(iso(w.end)).toBe('2025-12-31');
  });
});

describe('proration', () => {
  it('monthElapsedFraction mid-month', () => {
    expect(monthElapsedFraction(dateOnlyUTC(2026, 7, 5))).toBeCloseTo(5 / 31, 10);
  });

  it('monthElapsedFraction last day is one', () => {
    expect(monthElapsedFraction(dateOnlyUTC(2026, 6, 30))).toBeCloseTo(1.0, 10);
  });

  it('prorateMtdTarget', () => {
    expect(prorateMtdTarget(310000, dateOnlyUTC(2026, 7, 5))).toBeCloseTo((310000 * 5) / 31, 5);
  });

  it('prorateMtdTarget null target', () => {
    expect(prorateMtdTarget(null, dateOnlyUTC(2026, 7, 5))).toBeNull();
  });

  it('prorateYtdTarget sums completed months plus partial', () => {
    const result = prorateYtdTarget(3_000_000, 310_000, dateOnlyUTC(2026, 7, 5));
    expect(result).toBeCloseTo(3_000_000 + (310_000 * 5) / 31, 5);
  });

  it('prorateYtdTarget both null is null', () => {
    expect(prorateYtdTarget(null, null, dateOnlyUTC(2026, 7, 5))).toBeNull();
  });
});

describe('buildWhereClause', () => {
  it('no filters is always true', () => {
    const { clause, params } = buildWhereClause(EMPTY_FILTERS);
    expect(clause).toBe('1=1');
    expect(params).toEqual([]);
  });

  it('single filter, single value', () => {
    const { clause, params } = buildWhereClause({ companyKeys: [1] }, 'fo');
    expect(clause).toBe('fo.CompanyKey IN (?)');
    expect(params).toEqual([1]);
  });

  it('single filter, multiple values (OR via IN)', () => {
    const { clause, params } = buildWhereClause({ channelKeys: [1, 2] }, 'fo');
    expect(clause).toBe('fo.ChannelKey IN (?, ?)');
    expect(params).toEqual([1, 2]);
  });

  it('multiple filters AND-joined', () => {
    const filters: Filters = { companyKeys: [1], segmentKeys: [2, 5], salespersonKeys: [40] };
    const { clause, params } = buildWhereClause(filters);
    expect(clause).toContain('CompanyKey IN (?)');
    expect(clause).toContain('SegmentKey IN (?, ?)');
    expect(clause).toContain('SalespersonKey IN (?)');
    expect(params).toEqual([1, 2, 5, 40]);
  });

  it('empty arrays are treated as no restriction', () => {
    const { clause, params } = buildWhereClause({ companyKeys: [], segmentKeys: [2] });
    expect(clause).toBe('SegmentKey IN (?)');
    expect(params).toEqual([2]);
  });
});

describe('Salesperson RBAC lock', () => {
  it('non-salesperson role passes through unchanged', () => {
    const filters: Filters = { companyKeys: [1], segmentKeys: [2] };
    const user: UserContext = { roleCode: 'BI00_EXECUTIVE' };
    expect(applySalespersonLock(filters, user)).toEqual(filters);
  });

  it('salesperson role locks all other filters and forces own key', () => {
    const filters: Filters = {
      companyKeys: [1],
      segmentKeys: [2],
      channelKeys: [3],
      salesTeamKeys: ['TK-X'],
    };
    const user: UserContext = { roleCode: 'SALESPERSON', salespersonKey: 40 };
    const locked = applySalespersonLock(filters, user);
    expect(locked).toEqual({
      companyKeys: [],
      segmentKeys: [],
      channelKeys: [],
      salesTeamKeys: [],
      salespersonKeys: [40],
    });
  });

  it('salesperson role with matching explicit key is fine', () => {
    const filters: Filters = { salespersonKeys: [40] };
    const user: UserContext = { roleCode: 'SALESPERSON', salespersonKey: 40 };
    const locked = applySalespersonLock(filters, user);
    expect(locked.salespersonKeys).toEqual([40]);
  });

  it('salesperson role requesting a different salesperson throws', () => {
    const filters: Filters = { salespersonKeys: [99] };
    const user: UserContext = { roleCode: 'SALESPERSON', salespersonKey: 40 };
    expect(() => applySalespersonLock(filters, user)).toThrow(SalespersonLockError);
  });

  it('salesperson role without own key throws', () => {
    const filters: Filters = {};
    const user: UserContext = { roleCode: 'SALESPERSON', salespersonKey: null };
    expect(() => applySalespersonLock(filters, user)).toThrow(SalespersonLockError);
  });
});

describe('Role data scope (generic role_data_scope rules)', () => {
  it('no rules leaves filters unchanged', () => {
    const filters: Filters = { companyKeys: [1], segmentKeys: [2] };
    expect(applyRoleDataScope(filters, [])).toEqual(filters);
  });

  it('a restricted dimension not requested is forced to the allowed set (B2B Director case)', () => {
    const filters: Filters = { companyKeys: [1] };
    const rules: DataScopeRule[] = [{ dimension: 'segmentKeys', value: '1' }];
    const scoped = applyRoleDataScope(filters, rules);
    expect(scoped).toEqual({ companyKeys: [1], segmentKeys: [1] });
  });

  it('a requested value inside the allowed set is intersected, not force-replaced', () => {
    const filters: Filters = { segmentKeys: [1] };
    const rules: DataScopeRule[] = [
      { dimension: 'segmentKeys', value: '1' },
      { dimension: 'segmentKeys', value: '2' },
    ];
    const scoped = applyRoleDataScope(filters, rules);
    expect(scoped.segmentKeys).toEqual([1]);
  });

  it('a requested value outside the allowed set throws DataScopeError', () => {
    const filters: Filters = { segmentKeys: [2] };
    const rules: DataScopeRule[] = [{ dimension: 'segmentKeys', value: '1' }];
    expect(() => applyRoleDataScope(filters, rules)).toThrow(DataScopeError);
  });

  it('a multi-value dimension (Branch IN [X, Y]) with nothing requested is forced to both', () => {
    const filters: Filters = {};
    const rules: DataScopeRule[] = [
      { dimension: 'salesTeamKeys', value: 'TK-X' },
      { dimension: 'salesTeamKeys', value: 'TK-Y' },
    ];
    const scoped = applyRoleDataScope(filters, rules);
    expect(scoped.salesTeamKeys).toEqual(['TK-X', 'TK-Y']);
  });

  it('dimensions with no rules pass through untouched alongside a restricted one', () => {
    const filters: Filters = { companyKeys: [1], channelKeys: [3] };
    const rules: DataScopeRule[] = [{ dimension: 'segmentKeys', value: '1' }];
    const scoped = applyRoleDataScope(filters, rules);
    expect(scoped).toEqual({ companyKeys: [1], channelKeys: [3], segmentKeys: [1] });
  });
});
