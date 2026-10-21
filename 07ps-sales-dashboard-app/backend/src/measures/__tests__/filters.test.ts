import { describe, expect, it } from 'vitest';
import {
  DataScopeError,
  EMPTY_FILTERS,
  SalespersonLockError,
  applyRoleDataScope,
  applySalespersonLock,
  buildCrmWhereClause,
  buildWhereClause,
  dateOnlyUTC,
  effectiveChannelExpr,
  excludeCancelledDocumentsClause,
  effectiveSalesTeamExpr,
  effectiveSegmentExpr,
  flmWindow,
  flyWindow,
  combineDimensionRules,
  dimensionsNeedingDomain,
  groupScopeRows,
  resolveRoleScope,
  scopeNoMatchValue,
  lastYearMonthWindows,
  lmtdWindow,
  lytdWindow,
  monthElapsedFraction,
  mtdWindow,
  prorateMtdTarget,
  prorateYtdTarget,
  ytdWindow,
  type DataScopeRule,
  type Filters,
  type RoleScopeRule,
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

  it('flmWindow is the full SAME month LAST YEAR (not the previous month)', () => {
    const w = flmWindow(dateOnlyUTC(2026, 7, 5));
    expect(iso(w.start)).toBe('2025-07-01');
    expect(iso(w.end)).toBe('2025-07-31');
  });

  it('flmWindow in January is January last year', () => {
    const w = flmWindow(dateOnlyUTC(2026, 1, 15));
    expect(iso(w.start)).toBe('2025-01-01');
    expect(iso(w.end)).toBe('2025-01-31');
  });
});

describe('lastYearMonthWindows (LMTD + LFM)', () => {
  const ranges = (y: number, m: number, d: number) => {
    const { lmtd, lfm } = lastYearMonthWindows(dateOnlyUTC(y, m, d));
    return { lmtd: [iso(lmtd.start), iso(lmtd.end)], lfm: [iso(lfm.start), iso(lfm.end)] };
  };

  it('normal day: 13 Oct 2026', () => {
    expect(ranges(2026, 10, 13)).toEqual({ lmtd: ['2025-10-01', '2025-10-13'], lfm: ['2025-10-01', '2025-10-31'] });
  });

  it('month end: 30 Apr 2026 and 31 Dec 2026 (real last day of the month)', () => {
    expect(ranges(2026, 4, 30)).toEqual({ lmtd: ['2025-04-01', '2025-04-30'], lfm: ['2025-04-01', '2025-04-30'] });
    expect(ranges(2026, 12, 31)).toEqual({ lmtd: ['2025-12-01', '2025-12-31'], lfm: ['2025-12-01', '2025-12-31'] });
  });

  it('29 Feb with no 29 Feb last year: LMTD ends 28 Feb, LFM is all of February', () => {
    expect(ranges(2028, 2, 29)).toEqual({ lmtd: ['2027-02-01', '2027-02-28'], lfm: ['2027-02-01', '2027-02-28'] });
  });

  it('February into a leap year: LFM ends on 29 Feb', () => {
    expect(ranges(2029, 2, 10)).toEqual({ lmtd: ['2028-02-01', '2028-02-10'], lfm: ['2028-02-01', '2028-02-29'] });
  });

  it('lmtdWindow and flmWindow are the shared helper', () => {
    const a = dateOnlyUTC(2026, 10, 13);
    expect(lmtdWindow(a)).toEqual(lastYearMonthWindows(a).lmtd);
    expect(flmWindow(a)).toEqual(lastYearMonthWindows(a).lfm);
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
    // companyKeys is one of the two fields with no admin-override concept (see OVERRIDE_EXPR in
    // filters.ts), so this exercises the plain multi-value IN mechanic in isolation from the
    // override-aware expressions covered below.
    const { clause, params } = buildWhereClause({ companyKeys: [1, 2] }, 'fo');
    expect(clause).toBe('fo.CompanyKey IN (?, ?)');
    expect(params).toEqual([1, 2]);
  });

  it('multiple filters AND-joined', () => {
    const filters: Filters = { companyKeys: [1], segmentKeys: [2, 5], salespersonKeys: [40] };
    const { clause, params } = buildWhereClause(filters);
    expect(clause).toContain('CompanyKey IN (?)');
    expect(clause).toContain(`${effectiveSegmentExpr('')} IN (?, ?)`);
    expect(clause).toContain('SalespersonKey IN (?)');
    expect(params).toEqual([1, 2, 5, 40]);
  });

  it('empty arrays are treated as no restriction', () => {
    const { clause, params } = buildWhereClause({ companyKeys: [], segmentKeys: [2] });
    expect(clause).toBe(`${effectiveSegmentExpr('')} IN (?)`);
    expect(params).toEqual([2]);
  });

  // segmentKeys/salesTeamKeys filter against the effective (admin-override-aware) value, not the
  // raw column -- Reports/Dashboards Honor Admin Salesperson Overrides, 2026-09. Building the
  // expected string from the real effective*Expr functions (rather than a hand-typed duplicate)
  // means this test verifies buildWhereClause picked the right expression, without also having to
  // stay in sync with that expression's own internal formatting -- the describe blocks below cover
  // the internal shape of each expression on their own.
  it('segmentKeys filters through the effective (override-aware) expression', () => {
    const { clause, params } = buildWhereClause({ segmentKeys: [1, 2] }, 'fo');
    expect(clause).toBe(`${effectiveSegmentExpr('fo')} IN (?, ?)`);
    expect(params).toEqual([1, 2]);
  });

  it('salesTeamKeys filters through the effective (override-aware) expression', () => {
    const { clause, params } = buildWhereClause({ salesTeamKeys: ['TK-1'] }, 'fo');
    expect(clause).toBe(`${effectiveSalesTeamExpr('fo')} IN (?)`);
    expect(params).toEqual(['TK-1']);
  });

  // channelKeys filters against the *inferred* channel (see effectiveChannelExpr), not the raw
  // ChannelKey column -- Tasks #3/#4, "Unknown Sales" allocation.
  it('channelKeys filters against the inferred-channel expression, not the raw column', () => {
    const { clause, params } = buildWhereClause({ channelKeys: [3] }, 'fo');
    expect(clause).toBe(`${effectiveChannelExpr('fo')} IN (?)`);
    expect(params).toEqual([3]);
  });

  it('companyKeys and salespersonKeys have no override concept and stay plain columns', () => {
    const { clause } = buildWhereClause({ companyKeys: [1], salespersonKeys: [40] }, 'fo');
    expect(clause).toBe('fo.CompanyKey IN (?) AND fo.SalespersonKey IN (?)');
  });
});

describe('buildCrmWhereClause', () => {
  it('omits channelKeys but still resolves segmentKeys/salesTeamKeys through the effective expression', () => {
    const { clause, params } = buildCrmWhereClause(
      { channelKeys: [3], segmentKeys: [1], salesTeamKeys: ['TK-1'] },
      'fo',
    );
    expect(clause).not.toContain('ChannelKey');
    expect(clause).toBe(
      `${effectiveSegmentExpr('fo')} IN (?) AND ${effectiveSalesTeamExpr('fo')} IN (?)`,
    );
    expect(params).toEqual([1, 'TK-1']);
  });
});

describe('effectiveSegmentExpr', () => {
  it('prefers the admin override, falling back to the raw column', () => {
    const expr = effectiveSegmentExpr('fo');
    expect(expr).toContain('sap.segment_key_override FROM salesperson_admin_profile sap');
    expect(expr).toContain('sap.salesperson_key = fo.SalespersonKey');
    expect(expr).toContain('fo.SegmentKey');
  });

  it('has no alias prefix when none is given', () => {
    expect(effectiveSegmentExpr()).toContain('sap.salesperson_key = SalespersonKey');
  });
});

describe('effectiveSalesTeamExpr', () => {
  it('prefers the admin override, falling back to the raw column', () => {
    const expr = effectiveSalesTeamExpr('fo');
    expect(expr).toContain('sap.sales_team_key_override FROM salesperson_admin_profile sap');
    expect(expr).toContain('sap.salesperson_key = fo.SalespersonKey');
    expect(expr).toContain('fo.SalesTeamKey');
  });
});

describe('effectiveChannelExpr', () => {
  it('an explicit channel_key_override wins outright, before any inference runs', () => {
    const expr = effectiveChannelExpr('fo');
    // COALESCE short-circuits left-to-right, so the override subquery must appear before the
    // CASE-based inference in the generated SQL text for it to actually take priority.
    const overrideIdx = expr.indexOf('sap.channel_key_override');
    const caseIdx = expr.indexOf('CASE');
    expect(overrideIdx).toBeGreaterThanOrEqual(0);
    expect(caseIdx).toBeGreaterThan(overrideIdx);
  });

  it('passes through any already-known channel unchanged', () => {
    expect(effectiveChannelExpr()).toContain('WHEN ChannelKey <> -1 THEN ChannelKey');
  });

  it('maps B2C/Backoffice (segment 2/3) to Retail (3), and B2B/Inter Company (1/4) to Projects (2), using the EFFECTIVE segment', () => {
    const expr = effectiveChannelExpr();
    // The inference must branch on the effective (override-aware) segment, not the raw column --
    // otherwise a reclassified salesperson's Unknown-channel rows would disagree with their own
    // segment-grouped total. Asserting against effectiveSegmentExpr() directly (rather than a
    // hand-typed 'SegmentKey IN (2, 3)') is what actually proves that composition.
    expect(expr).toContain(`${effectiveSegmentExpr()} IN (2, 3) THEN 3`);
    expect(expr).toContain(`${effectiveSegmentExpr()} IN (1, 4) THEN 2`);
  });

  it('leaves rows with no segment signal at Unknown (-1) rather than guessing', () => {
    expect(effectiveChannelExpr()).toContain('ELSE -1');
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

describe('buildWhereClause -- customerKeys', () => {
  it('is ignored unless the caller opts in (targets / CRM tables have no CustomerKey)', () => {
    const { clause, params } = buildWhereClause({ customerKeys: [7, 8] }, 'ftp');
    expect(clause).toBe('1=1');
    expect(params).toEqual([]);
  });

  it('filters on the alias CustomerKey column when the caller opts in', () => {
    const { clause, params } = buildWhereClause({ companyKeys: [1], customerKeys: [7, 8] }, 'fsl', true);
    expect(clause).toContain('fsl.CompanyKey IN (?)');
    expect(clause).toContain('fsl.CustomerKey IN (?, ?)');
    expect(params).toEqual([1, 7, 8]);
  });
});

describe('excludeCancelledDocumentsClause', () => {
  it('leaves cancelled sale orders out of pipeline series (a missing state counts as not cancelled)', () => {
    expect(excludeCancelledDocumentsClause('fs')).toBe("COALESCE(fs.OrderState, '') <> 'cancel'");
    expect(excludeCancelledDocumentsClause('')).toBe("COALESCE(OrderState, '') <> 'cancel'");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Role data scope operators (2026-10-15): "is any of" (in) / "is none of" (not_in), resolved per request
// ---------------------------------------------------------------------------------------------------------------------
describe('role data scope: in / not_in', () => {
  // dim_company today: -1 Unknown, 1 Majaal, 3 Tika, 9 Athena, 12 X
  const companies = ['-1', '1', '3', '9', '12'];
  const allowed = (rules: DataScopeRule[], dimension: keyof Filters) => rules.filter((r) => r.dimension === dimension).map((r) => r.value);

  it('"is any of" keeps exactly the listed values', () => {
    const rules = resolveRoleScope([{ dimension: 'companyKeys', ruleNo: 1, operator: 'in', values: ['1', '3'] }], {});
    expect(allowed(rules, 'companyKeys')).toEqual(['1', '3']);
    expect(applyRoleDataScope({}, rules).companyKeys).toEqual([1, 3]);
  });

  it('"is none of" = every current value except the excluded ones -- a company added later is visible automatically', () => {
    const rule: RoleScopeRule = { dimension: 'companyKeys', ruleNo: 1, operator: 'not_in', values: ['12'] };
    expect(allowed(resolveRoleScope([rule], { companyKeys: companies }), 'companyKeys')).toEqual(['-1', '1', '3', '9']);
    // new company 14 in dim_company, the stored rule unchanged
    expect(allowed(resolveRoleScope([rule], { companyKeys: [...companies, '14'] }), 'companyKeys')).toEqual(['-1', '1', '3', '9', '14']);
    expect(rule.values).toEqual(['12']); // never turned into an allow-list
  });

  it('a request for an excluded value is refused (403); one inside the scope narrows', () => {
    const rules = resolveRoleScope([{ dimension: 'companyKeys', ruleNo: 1, operator: 'not_in', values: ['12'] }], { companyKeys: companies });
    expect(() => applyRoleDataScope({ companyKeys: [12] }, rules)).toThrow(DataScopeError);
    expect(applyRoleDataScope({ companyKeys: [12, 3] }, rules).companyKeys).toEqual([3]);
    expect(applyRoleDataScope({ companyKeys: [9] }, rules).companyKeys).toEqual([9]);
  });

  it('Unassigned / Unknown (-1) stays visible under "is none of" unless it is excluded itself', () => {
    const people = ['-1', '49', '60'];
    expect(allowed(resolveRoleScope([{ dimension: 'salespersonKeys', ruleNo: 1, operator: 'not_in', values: ['60'] }], { salespersonKeys: people }), 'salespersonKeys')).toEqual(['-1', '49']);
    expect(allowed(resolveRoleScope([{ dimension: 'salespersonKeys', ruleNo: 1, operator: 'not_in', values: ['60', '-1'] }], { salespersonKeys: people }), 'salespersonKeys')).toEqual(['49']);
    // and it can be the one value of an "is any of" rule
    expect(applyRoleDataScope({}, resolveRoleScope([{ dimension: 'salespersonKeys', ruleNo: 1, operator: 'in', values: ['-1'] }], {})).salespersonKeys).toEqual([-1]);
  });

  it('excluding every value leaves nothing visible -- never "no restriction"', () => {
    const rules = resolveRoleScope([{ dimension: 'companyKeys', ruleNo: 1, operator: 'not_in', values: companies }], { companyKeys: companies });
    expect(allowed(rules, 'companyKeys')).toEqual([scopeNoMatchValue('companyKeys')]);
    const scoped = applyRoleDataScope({}, rules);
    expect(scoped.companyKeys).toEqual([Number(scopeNoMatchValue('companyKeys'))]);
    expect(buildWhereClause(scoped).clause).toContain('CompanyKey IN (?)'); // a clause no row matches
    expect(() => applyRoleDataScope({ companyKeys: [1] }, rules)).toThrow(DataScopeError);
    // the branch dimension is string-typed: its own sentinel
    const teams = applyRoleDataScope({}, resolveRoleScope([{ dimension: 'salesTeamKeys', ruleNo: 1, operator: 'not_in', values: ['A'] }], { salesTeamKeys: ['A'] }));
    expect(teams.salesTeamKeys).toEqual(['__no_scope_match__']);
  });

  it('rules on different dimensions combine with AND; values inside a rule with OR', () => {
    const rules = resolveRoleScope(
      [
        { dimension: 'companyKeys', ruleNo: 1, operator: 'not_in', values: ['12'] },
        { dimension: 'salesTeamKeys', ruleNo: 1, operator: 'in', values: ['MJ-A', 'MJ-B'] },
      ],
      { companyKeys: companies },
    );
    const scoped = applyRoleDataScope({}, rules);
    expect(scoped.companyKeys).toEqual([-1, 1, 3, 9]);
    expect(scoped.salesTeamKeys).toEqual(['MJ-A', 'MJ-B']);
    expect(scoped.segmentKeys).toBeUndefined(); // no rule = unrestricted
    const where = buildWhereClause(scoped);
    expect(where.clause.startsWith('CompanyKey IN (?, ?, ?, ?) AND ')).toBe(true);
    expect(where.clause.endsWith('IN (?, ?)')).toBe(true);
    expect(where.params).toEqual([-1, 1, 3, 9, 'MJ-A', 'MJ-B']);
  });

  it('migration 0044: old single-value rows become one "is any of" rule per dimension (several rows merged)', () => {
    expect(
      groupScopeRows([
        { dimension: 'companyKeys', value: '1' },
        { dimension: 'segmentKeys', value: '1' },
        { dimension: 'companyKeys', value: '3' },
      ]),
    ).toEqual([
      { dimension: 'companyKeys', ruleNo: 1, operator: 'in', values: ['1', '3'] },
      { dimension: 'segmentKeys', ruleNo: 1, operator: 'in', values: ['1'] },
    ]);
    // and they resolve to exactly what applyRoleDataScope enforced before the migration
    const before: DataScopeRule[] = [{ dimension: 'companyKeys', value: '1' }, { dimension: 'companyKeys', value: '3' }];
    const after = resolveRoleScope(groupScopeRows(before), {});
    expect(applyRoleDataScope({}, after)).toEqual(applyRoleDataScope({}, before));
    expect(applyRoleDataScope({ companyKeys: [3] }, after)).toEqual(applyRoleDataScope({ companyKeys: [3] }, before));
  });

  it('rows with the operator column read as saved; unknown dimensions are ignored', () => {
    expect(
      groupScopeRows([
        { dimension: 'companyKeys', operator: 'not_in', value: '12' },
        { dimension: 'companyKeys', operator: 'not_in', value: '9' },
        { dimension: 'customerKeys', operator: 'in', value: '5' },
      ]),
    ).toEqual([{ dimension: 'companyKeys', ruleNo: 1, operator: 'not_in', values: ['12', '9'] }]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Several rules on one dimension (2026-10-21, migration 0056): every rule applies (AND)
// ---------------------------------------------------------------------------------------------------------------------
describe('role data scope: several rules on one dimension', () => {
  // dim_company: -1 Unknown, 1 Majaal, 3 Tika, 9 Athena, 12 Zeus, 13 Zeus-Retail
  const companies = ['-1', '1', '3', '9', '12', '13'];
  const allowed = (rules: DataScopeRule[], dimension: keyof Filters) => rules.filter((r) => r.dimension === dimension).map((r) => r.value);

  it('"is [A, B]" AND "is not [B]" sees only A -- on every query and every filter list', () => {
    const rules = resolveRoleScope(
      [
        { dimension: 'companyKeys', ruleNo: 1, operator: 'in', values: ['9', '12'] },
        { dimension: 'companyKeys', ruleNo: 2, operator: 'not_in', values: ['12'] },
      ],
      {},
    );
    expect(allowed(rules, 'companyKeys')).toEqual(['9']);
    expect(applyRoleDataScope({}, rules).companyKeys).toEqual([9]);
    expect(() => applyRoleDataScope({ companyKeys: [12] }, rules)).toThrow(DataScopeError);
    expect(buildWhereClause(applyRoleDataScope({}, rules)).params).toEqual([9]);
  });

  it('two "is" rules keep only the values both list', () => {
    expect(combineDimensionRules([{ operator: 'in', values: ['1', '3', '9'] }, { operator: 'in', values: ['3', '9', '12'] }], undefined)).toEqual(['3', '9']);
  });

  it('two "is not" rules exclude the values of both, from every current value', () => {
    const rules = resolveRoleScope(
      [
        { dimension: 'companyKeys', ruleNo: 1, operator: 'not_in', values: ['12'] },
        { dimension: 'companyKeys', ruleNo: 2, operator: 'not_in', values: ['13'] },
      ],
      { companyKeys: companies },
    );
    expect(allowed(rules, 'companyKeys')).toEqual(['-1', '1', '3', '9']);
  });

  it('a contradiction ("is [A]" AND "is not [A]", or two "is" with nothing shared) matches no data, never everything', () => {
    for (const pair of [
      [{ operator: 'in' as const, values: ['9'] }, { operator: 'not_in' as const, values: ['9'] }],
      [{ operator: 'in' as const, values: ['9'] }, { operator: 'in' as const, values: ['12'] }],
    ]) {
      expect(combineDimensionRules(pair, companies)).toEqual([]);
      const rules = resolveRoleScope(pair.map((r, i) => ({ ...r, dimension: 'companyKeys' as const, ruleNo: i + 1 })), { companyKeys: companies });
      expect(allowed(rules, 'companyKeys')).toEqual([scopeNoMatchValue('companyKeys')]);
    }
  });

  it('the dim table is read only for a dimension whose rules are all "is not"', () => {
    expect(
      dimensionsNeedingDomain([
        { dimension: 'companyKeys', ruleNo: 1, operator: 'in', values: ['9'] },
        { dimension: 'companyKeys', ruleNo: 2, operator: 'not_in', values: ['12'] },
        { dimension: 'segmentKeys', ruleNo: 1, operator: 'not_in', values: ['2'] },
      ]),
    ).toEqual(['segmentKeys']);
  });

  it('rows group into one rule per (dimension, rule_no), dimensions in first-appearance order', () => {
    expect(
      groupScopeRows([
        { dimension: 'segmentKeys', rule_no: 1, operator: 'in', value: '2' },
        { dimension: 'companyKeys', rule_no: 2, operator: 'not_in', value: '12' },
        { dimension: 'companyKeys', rule_no: 1, operator: 'in', value: '9' },
        { dimension: 'companyKeys', rule_no: 1, operator: 'in', value: '12' },
      ]),
    ).toEqual([
      { dimension: 'segmentKeys', ruleNo: 1, operator: 'in', values: ['2'] },
      { dimension: 'companyKeys', ruleNo: 1, operator: 'in', values: ['9', '12'] },
      { dimension: 'companyKeys', ruleNo: 2, operator: 'not_in', values: ['12'] },
    ]);
  });
});
