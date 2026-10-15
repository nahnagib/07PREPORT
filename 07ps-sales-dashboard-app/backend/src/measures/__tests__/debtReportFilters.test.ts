import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { DEFAULT_DEBT_QUERY, EXCLUDED_TEAMS_CONDITION, fetchDebtMeta } from '../debtReport';

const combinations = [
  { CompanyKey: 1, company: 'Majaal', SegmentKey: 1, segment: 'B2B', ChannelKey: 2, SalesTeamKey: 'M-East', sales_team: 'East', SalespersonKey: 10, salesperson: 'Ali', CustomerKey: 100, customer: 'Customer A', PaymentTermKey: 30, payment_term: '30 days', currency: 'LYD', n: 1 },
  { CompanyKey: 1, company: 'Majaal', SegmentKey: 2, segment: 'B2C', ChannelKey: 3, SalesTeamKey: 'M-West', sales_team: 'West', SalespersonKey: 11, salesperson: 'Salem', CustomerKey: 101, customer: 'Customer B', PaymentTermKey: 0, payment_term: 'Immediate', currency: 'USD', n: 1 },
  { CompanyKey: 3, company: 'Tika', SegmentKey: 1, segment: 'B2B', ChannelKey: 2, SalesTeamKey: 'T-East', sales_team: 'Tika East', SalespersonKey: 20, salesperson: 'Omar', CustomerKey: 200, customer: 'Customer C', PaymentTermKey: 30, payment_term: '30 days', currency: 'LYD', n: 1 },
];

function database(data = combinations) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('MAX(SnapshotDateKey) AS k')) return [[{ k: 20261015 }], []];
    if (sql.includes('GROUP BY SnapshotDateKey ORDER BY')) return [[{ k: 20261015, n: 3 }], []];
    if (sql.includes('FROM dim_channel')) return [[{ v: 2, en: 'Wholesale' }, { v: 3, en: 'Retail' }], []];
    if (sql.includes('GROUP BY l.CompanyKey')) return [data, []];
    return [[], []];
  });
  return { pool: { query } as unknown as Pool, query };
}

describe('Receivables cross-filtered options', () => {
  it('offers only a selected company’s groups, channels, branches, people and customers, keeping Company widenable', async () => {
    const { pool } = database();
    const meta = await fetchDebtMeta(pool, DEFAULT_DEBT_QUERY, { companyKeys: [3] }, {});
    expect(meta.options.companies.map((o) => o.value)).toEqual(['1', '3']);
    expect(meta.options.customerGroups.map((o) => o.value)).toEqual(['1']);
    expect(meta.options.distributionChannels.map((o) => o.labelEn)).toEqual(['Wholesale']);
    expect(meta.options.salesTeams.map((o) => o.value)).toEqual(['T-East']);
    expect(meta.options.salespersons.map((o) => o.value)).toEqual(['20']);
    expect(meta.options.customers.map((o) => o.labelEn)).toEqual(['Customer C (200)']);
  });

  it('drops incompatible child selections after a company change without dropping the company', async () => {
    const { pool } = database();
    const meta = await fetchDebtMeta(pool, DEFAULT_DEBT_QUERY, {
      companyKeys: [3], segmentKeys: [2], channelKeys: [3], salesTeamKeys: ['M-West'], salespersonKeys: [11], customerKeys: [101],
    }, {});
    expect(meta.filters).toEqual({ companyKeys: ['3'], segmentKeys: [], channelKeys: [], salesTeamKeys: [], salespersonKeys: [], customerKeys: [] });
    expect(meta.options.salespersons.map((o) => o.value)).toEqual(['20']);
  });

  it('cross-filters branches and people by group and channel; multi-select widens their union', async () => {
    const { pool } = database();
    const scoped = await fetchDebtMeta(pool, DEFAULT_DEBT_QUERY, { companyKeys: [1], segmentKeys: [1], channelKeys: [2] }, {});
    expect(scoped.options.salesTeams.map((o) => o.value)).toEqual(['M-East']);
    expect(scoped.options.salespersons.map((o) => o.value)).toEqual(['10']);
    const widened = await fetchDebtMeta(pool, DEFAULT_DEBT_QUERY, { companyKeys: [1, 3] }, {});
    expect(widened.options.salespersons.map((o) => o.value)).toEqual(['10', '20', '11']);
    const all = await fetchDebtMeta(pool, DEFAULT_DEBT_QUERY, {}, {});
    expect(all.options.customers).toHaveLength(3);
  });

  it('keeps role/salesperson scope, exclusions, snapshot and scope toggles in SQL while pruning selections', async () => {
    const { pool, query } = database([combinations[2]]);
    const meta = await fetchDebtMeta(pool, { ...DEFAULT_DEBT_QUERY, includeOther: true }, { companyKeys: [1], salespersonKeys: [20] }, { salespersonKeys: [20], segmentKeys: [1] });
    const [sql] = query.mock.calls.find(([sql]) => sql.includes('GROUP BY l.CompanyKey'))!;
    expect(sql).toContain(EXCLUDED_TEAMS_CONDITION);
    expect(sql).toContain('f.SalespersonKey IN (?)');
    expect(sql).toContain('st.SegmentKey IN (?)');
    expect(sql).toContain('f.is_intercompany = 0');
    expect(sql).not.toContain('rs.is_default = 1');
    expect(sql).not.toContain('f.CompanyKey IN');
    expect(meta.options.companies.map((o) => o.value)).toEqual(['3']);
  });

  it('returns empty lists and clears stale selections when the snapshot has no visible combinations', async () => {
    const { pool } = database([]);
    const meta = await fetchDebtMeta(pool, DEFAULT_DEBT_QUERY, { companyKeys: [1], salespersonKeys: [10] }, {});
    expect(meta.options.salespersons).toEqual([]);
    expect(meta.options.customerGroups).toEqual([]);
    expect(meta.filters.companyKeys).toEqual([]);
    expect(meta.filters.salespersonKeys).toEqual([]);
  });
});
