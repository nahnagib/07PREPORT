import { afterEach, describe, expect, it } from 'vitest';
import type { Pool } from 'mysql2/promise';
import {
  DEFAULT_DEBT_QUERY,
  DebtQueryError,
  EXCLUDED_TEAMS_CONDITION,
  dateKeyOf,
  fetchDebtCustomers,
  fetchDebtOverview,
  fetchDebtTrend,
  isoOfKey,
  linesSource,
  parseDebtQuery,
  parseDrill,
} from '../debtReport';
import { odooWebBaseUrl, sizeTiers, tierCaseSql } from '../../config/finance';

describe('parseDebtQuery', () => {
  it('defaults to the latest snapshot, customer debt only, inter-company excluded, no filter', () => {
    expect(DEFAULT_DEBT_QUERY).toEqual({
      snapshotDateKey: null,
      includeOther: false,
      includeIntercompany: false,
      customerSearch: null,
      overdueStatus: 'all',
      agingBucketKeys: [],
      deliveryStatuses: [],
      paymentTermKeys: [],
      documentTypeKeys: [],
      invoiceTiers: [],
      customerTiers: [],
    });
  });

  it('parses every page parameter, repeated or comma-separated', () => {
    const q = parseDebtQuery({
      snapshotDate: '2026-10-04',
      includeOther: 'true',
      includeIntercompany: '1',
      customerSearch: '  ACME ',
      overdueStatus: 'overdue',
      agingBucketKeys: ['5', '8'],
      deliveryStatuses: 'full,none',
      paymentTermKeys: '7',
      documentTypeKeys: ['move:out_invoice', 'payment:inbound:customer'],
      invoiceTiers: 'large',
      customerTiers: ['medium', 'small'],
    });
    expect(q).toMatchObject({
      snapshotDateKey: 20261004,
      includeOther: true,
      includeIntercompany: true,
      customerSearch: 'ACME',
      overdueStatus: 'overdue',
      agingBucketKeys: [5, 8],
      deliveryStatuses: ['full', 'none'],
      paymentTermKeys: [7],
      documentTypeKeys: ['move:out_invoice', 'payment:inbound:customer'],
      invoiceTiers: ['large'],
      customerTiers: ['medium', 'small'],
    });
  });

  it.each([
    [{ snapshotDate: '04/10/2026' }],
    [{ overdueStatus: 'late' }],
    [{ agingBucketKeys: 'x' }],
    [{ invoiceTiers: 'huge' }],
    [{ documentTypeKeys: "move:x'; DROP TABLE t" }],
  ])('rejects a bad value: %j', (raw) => {
    expect(() => parseDebtQuery(raw)).toThrow(DebtQueryError);
  });

  it('converts snapshot keys both ways', () => {
    expect(dateKeyOf('2026-10-04')).toBe(20261004);
    expect(isoOfKey(20261004)).toBe('2026-10-04');
    expect(isoOfKey(null)).toBeNull();
  });
});

describe('linesSource', () => {
  const inner = (sql: string) => sql.slice(sql.indexOf('FROM fact_finance_receivable_snapshot f'), sql.indexOf(') m'));
  const outer = (sql: string) => sql.slice(sql.indexOf(') l'));

  it('reads customer debt without inter-company by default, in one pass over the snapshot', () => {
    const s = linesSource(20261004, DEFAULT_DEBT_QUERY, {});
    expect(inner(s.sql)).toContain('f.SnapshotDateKey = ?');
    expect(inner(s.sql)).toContain('rs.is_default = 1');
    expect(inner(s.sql)).toContain('f.is_intercompany = 0');
    expect(s.sql.match(/FROM fact_finance_receivable_snapshot/g)).toHaveLength(1);
    expect(s.params.filter((p) => p === 20261004)).toHaveLength(1);
  });

  it('drops the scope conditions when the toggles are on', () => {
    const s = linesSource(20261004, { ...DEFAULT_DEBT_QUERY, includeOther: true, includeIntercompany: true }, {});
    expect(s.sql).not.toContain('rs.is_default = 1');
    expect(s.sql).not.toContain('f.is_intercompany = 0');
  });

  it('always leaves out the excluded segments and teams: defaults, both toggles on, every filter, the trend', () => {
    expect(EXCLUDED_TEAMS_CONDITION).toBe('f.SalesTeamKey NOT IN (SELECT x.SalesTeamKey FROM v_finance_excluded_sales_team x)');
    const all = { ...DEFAULT_DEBT_QUERY, includeOther: true, includeIntercompany: true };
    const sources = [
      linesSource(20261004, DEFAULT_DEBT_QUERY, {}),
      linesSource(20261004, all, {}),
      linesSource(20261004, all, { salesTeamKeys: ['BMH-ALL-00'], segmentKeys: [3, 4] }), // asking for them changes nothing
      linesSource({ from: 0 }, all, {}),
    ];
    // in the inner WHERE, i.e. before the tier window sums and every aggregation
    for (const s of sources) expect(inner(s.sql)).toContain(EXCLUDED_TEAMS_CONDITION);
  });

  it("reads amounts in the line's own currency, keeping the LYD residual only for the tiers", () => {
    const s = linesSource(20261004, DEFAULT_DEBT_QUERY, {});
    expect(s.sql).toContain('f.residual_doc_ccy');
    expect(s.sql).toContain('cur.currency');
    expect(s.sql).toContain('SUM(f.residual_company_ccy) OVER (PARTITION BY f.SnapshotDateKey, f.move_id) AS doc_amount');
  });

  it('applies the scoped filters (salesperson lock, role scope) before the tier window sums, so tiers stay within scope', () => {
    const s = linesSource(20261004, DEFAULT_DEBT_QUERY, { salespersonKeys: [49], segmentKeys: [1], companyKeys: [3], channelKeys: [3] });
    const where = inner(s.sql);
    expect(where).toContain('f.SalespersonKey IN (?)');
    expect(where).toContain('st.SegmentKey IN (?)'); // segment of the line's sales team, as on the sales lines
    expect(where).toContain('sp.ChannelKey IN (?)'); // channel of the line's salesperson
    expect(where).toContain('f.CompanyKey IN (?)');
    expect(outer(s.sql)).not.toContain('SalespersonKey IN');
    expect(s.params.filter((p) => p === 49)).toHaveLength(1);
  });

  it('applies page filters after the tiers (a page filter never changes a tier)', () => {
    const q = parseDebtQuery({ overdueStatus: 'not_due', agingBucketKeys: '4', deliveryStatuses: 'partial,none', invoiceTiers: 'large', customerSearch: '50%_x' });
    const s = linesSource(20261004, q, {});
    const out = outer(s.sql);
    expect(out).toContain('l.days_past_due <= 0');
    expect(out).toContain('(l.delivery_status IN (?) OR l.delivery_status IS NULL)');
    expect(out).toContain('l.doc_tier IN (?)');
    expect(out).toContain('l.AgingBucketKey IN (?)');
    expect(inner(s.sql)).not.toContain('AgingBucketKey IN');
    expect(s.params).toContain('%50\\%\\_x%'); // LIKE wildcards in the search text are escaped
  });

  it('covers every snapshot from a date for the trend (tiers partitioned by snapshot)', () => {
    const s = linesSource({ from: 0 }, DEFAULT_DEBT_QUERY, {});
    expect(s.sql).toContain('f.SnapshotDateKey >= ?');
    expect(s.sql).toContain('PARTITION BY f.SnapshotDateKey, f.move_id');
  });
});

describe('parseDrill', () => {
  it('accepts every chart / table drill-down', () => {
    expect(parseDrill({ kind: 'customer', key: '3575', currency: 'lyd' })).toEqual({ kind: 'customer', key: '3575', currency: 'LYD' });
    expect(parseDrill({ kind: 'aging', key: '8', currency: 'USD' }).key).toBe('8');
    expect(parseDrill({ kind: 'salesperson', key: '-1', currency: 'EUR' }).key).toBe('-1');
    expect(parseDrill({ kind: 'team', key: 'MJ-EST-BB', currency: 'LYD' }).key).toBe('MJ-EST-BB');
    expect(parseDrill({ kind: 'account', key: '1:3575', currency: 'LYD' }).key).toBe('1:3575');
  });

  it.each([
    [{ key: '1', currency: 'LYD' }],
    [{ kind: 'invoice', key: '1', currency: 'LYD' }],
    [{ kind: 'customer', key: 'x', currency: 'LYD' }],
    [{ kind: 'account', key: '1', currency: 'LYD' }],
    [{ kind: 'team', key: "x' OR 1=1", currency: 'LYD' }],
    [{ kind: 'aging', key: '5' }],
    [{ kind: 'aging', key: '5', currency: 'DOLLARS' }],
  ])('rejects %j', (raw) => {
    expect(() => parseDrill(raw)).toThrow(DebtQueryError);
  });
});

/** A pool answering the line queries with the given rows (the SQL itself is covered above and by the DB test). */
function fakePool(lines: Record<string, unknown>[]): Pool {
  return {
    query: async (sql: string) => {
      if (/MAX\(SnapshotDateKey\) AS k/.test(sql)) return [[{ k: 20261004 }], []];
      if (/GROUP BY SnapshotDateKey ORDER BY SnapshotDateKey/.test(sql)) return [[{ k: 20261004, n: lines.length }], []];
      if (sql.includes('FROM dim_finance_aging_bucket'))
        return [[1, 2, 3, 4, 5, 6, 7, 8].map((k) => ({ k, label: `B${k}`, is_overdue: k >= 5 ? 1 : 0 })), []];
      if (sql.includes('GROUP BY l.SnapshotDateKey, l.currency')) {
        const g = new Map<string, { k: number; currency: string; n: number; open_amount: number; overdue: number }>();
        for (const l of lines) {
          const x = g.get(String(l.currency)) ?? { k: 20261004, currency: String(l.currency), n: 0, open_amount: 0, overdue: 0 };
          x.n += 1;
          x.open_amount += Number(l.residual_doc_ccy);
          x.overdue += Number(l.days_past_due) > 0 ? Number(l.residual_doc_ccy) : 0;
          g.set(x.currency, x);
        }
        return [[...g.values()], []];
      }
      if (sql.includes('FROM fact_finance_receivable_snapshot f')) return [lines, []];
      return [[], []];
    },
  } as unknown as Pool;
}

const line = (o: Record<string, unknown>) => ({
  line_id: 1, move_id: 1, CompanyKey: 1, company: 'Majaal', CustomerKey: 10, customer: 'A', SalespersonKey: 5, salesperson: 'S1',
  SalesTeamKey: 'MJ-EST-BB', sales_team: 'T1', segment: 'B2B', AgingBucketKey: 5, days_past_due: 10, currency: 'LYD',
  residual_doc_ccy: 0, invoice_total_signed: 0, ...o,
});
// LYD: an invoice 600 overdue, one 400 not due, a credit note -50 overdue (customer B); USD: one invoice in two
// instalments, 70 overdue + 30 due today (not overdue)
const LINES = [
  line({ line_id: 1, move_id: 1, residual_doc_ccy: 600, invoice_total_signed: 1000, days_past_due: 40, AgingBucketKey: 6 }),
  line({ line_id: 2, move_id: 2, residual_doc_ccy: 400, invoice_total_signed: 400, days_past_due: -5, AgingBucketKey: 4 }),
  line({ line_id: 3, move_id: 3, residual_doc_ccy: -50, invoice_total_signed: -50, days_past_due: 3, CustomerKey: 11, customer: 'B', SalespersonKey: 6, salesperson: 'S2' }),
  line({ line_id: 4, move_id: 4, currency: 'USD', residual_doc_ccy: 70, invoice_total_signed: 100, days_past_due: 1 }),
  line({ line_id: 5, move_id: 4, currency: 'USD', residual_doc_ccy: 30, invoice_total_signed: 100, days_past_due: 0, AgingBucketKey: 4 }),
];

describe('per-currency aggregation', () => {
  it('never adds currencies together; overdue + not due = open in each', async () => {
    const o = await fetchDebtOverview(fakePool(LINES), DEFAULT_DEBT_QUERY, {});
    expect(o.currencies.map((c) => c.currency)).toEqual(['LYD', 'USD']);
    const [lyd, usd] = o.currencies;
    expect(lyd.kpis).toMatchObject({ openAmount: 950, overdueAmount: 550, notDueAmount: 400, openDocuments: 3, customers: 2, lineCount: 3 });
    expect(usd.kpis).toMatchObject({ openAmount: 100, overdueAmount: 70, notDueAmount: 30, openDocuments: 1, customers: 1, lineCount: 2 });
    for (const c of o.currencies) {
      expect(c.kpis.overdueAmount + c.kpis.notDueAmount).toBeCloseTo(c.kpis.openAmount, 9);
      expect(c.aging.reduce((t, a) => t + a.amount, 0)).toBeCloseTo(c.kpis.openAmount, 9);
      expect(c.bySalesperson.reduce((t, a) => t + a.overdue, 0)).toBeCloseTo(c.kpis.overdueAmount, 9);
      expect(c.byTeam.reduce((t, a) => t + a.overdue, 0)).toBeCloseTo(c.kpis.overdueAmount, 9);
    }
    expect(lyd.kpis.overduePctOfOpen).toBeCloseTo(550 / 950, 9);
  });

  it('customer rows are per company + customer + currency, counting each document once', async () => {
    const c = await fetchDebtCustomers(fakePool(LINES), DEFAULT_DEBT_QUERY, {});
    expect(c.currencies).toEqual(['LYD', 'USD']);
    const usd = c.rows.find((r) => r.currency === 'USD');
    expect(usd).toMatchObject({ customerKey: 10, openDocuments: 1, invoiceAmount: 100, open: 100, overdue: 70, notDue: 30, lineCount: 2 });
    const a = c.rows.find((r) => r.currency === 'LYD' && r.customerKey === 10);
    expect(a).toMatchObject({ openDocuments: 2, invoiceAmount: 1400, open: 1000, overdue: 600, salespersons: ['S1'], salesTeams: ['T1'], segments: ['B2B'] });
    expect(c.rows.map((r) => r.currency)).toEqual(['LYD', 'LYD', 'USD']);
  });

  it('trend: one point per snapshot and currency, overdue + not due = open', async () => {
    const t = await fetchDebtTrend(fakePool(LINES), DEFAULT_DEBT_QUERY, {});
    expect(t.currencies).toEqual(['LYD', 'USD']);
    expect(t.points).toEqual([
      { snapshotDate: '2026-10-04', currency: 'LYD', open: 950, overdue: 550, notDue: 400 },
      { snapshotDate: '2026-10-04', currency: 'USD', open: 100, overdue: 70, notDue: 30 },
    ]);
  });
});

describe('finance config', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('has the agreed default thresholds: Large >= 100k, Medium 10k-100k, Small < 10k', () => {
    delete process.env.FINANCE_TIER_LARGE_MIN;
    delete process.env.FINANCE_TIER_MEDIUM_MIN;
    expect(sizeTiers().map((t) => [t.key, t.min, t.max])).toEqual([
      ['large', 100000, null],
      ['medium', 10000, 100000],
      ['small', null, 10000],
    ]);
    expect(tierCaseSql('x').params).toEqual([100000, 10000]);
  });

  it('takes thresholds and the Odoo link base from the environment', () => {
    process.env.FINANCE_TIER_LARGE_MIN = '250000';
    process.env.FINANCE_TIER_MEDIUM_MIN = '5000';
    process.env.ODOO_WEB_BASE_URL = 'https://example.odoo.com/';
    expect(tierCaseSql('x').params).toEqual([250000, 5000]);
    expect(odooWebBaseUrl()).toBe('https://example.odoo.com');
    process.env.FINANCE_TIER_MEDIUM_MIN = '300000';
    expect(() => sizeTiers()).toThrow(/below/);
  });
});
