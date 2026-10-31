import { describe, expect, it } from 'vitest';
import type { Pool } from 'mysql2/promise';
import {
  addDays,
  collectionSource,
  fetchCollectionsDrilldown,
  fetchCollectionsTrend,
  parseCollectionsQuery,
  periodEnd,
  periodStart,
  periodsBetween,
} from '../debtCollections';
import { DEFAULT_DEBT_QUERY, DebtQueryError, fetchDebtTrend } from '../debtReport';

describe('collection periods', () => {
  it('weeks run Saturday..Friday (reporting/ar_weekly), months from the 1st', () => {
    expect(periodStart('2026-10-10', 'week')).toBe('2026-10-10'); // a Saturday
    expect(periodStart('2026-10-16', 'week')).toBe('2026-10-10'); // its Friday
    expect(periodEnd('2026-10-10', 'week')).toBe('2026-10-16');
    expect(periodStart('2026-09-30', 'month')).toBe('2026-09-01');
    expect(periodEnd('2026-02-01', 'month')).toBe('2026-02-28');
    expect(periodEnd('2026-12-01', 'month')).toBe('2026-12-31');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('lists every period of the range, empty ones included', () => {
    expect(periodsBetween('2026-09-30', '2026-10-12', 'week').map((p) => p.start)).toEqual(['2026-09-26', '2026-10-03', '2026-10-10']);
    expect(periodsBetween('2026-09-29', '2026-10-01', 'day')).toHaveLength(3);
  });

  it('defaults: week grain, the last 12 weeks ending with the current one', () => {
    const q = parseCollectionsQuery({}, '2026-10-14');
    expect([q.grain, q.from, q.to, q.currency]).toEqual(['week', '2026-07-25', '2026-10-16', null]);
    expect(periodsBetween(q.from, q.to, q.grain)).toHaveLength(12);
    const m = parseCollectionsQuery({ grain: 'month' }, '2026-10-14');
    expect([m.from, m.to]).toEqual(['2025-11-01', '2026-10-31']);
    const d = parseCollectionsQuery({ grain: 'day' }, '2026-10-14');
    expect([d.from, d.to]).toEqual(['2026-09-15', '2026-10-14']);
  });

  it('rejects bad parameters', () => {
    expect(() => parseCollectionsQuery({ grain: 'year' })).toThrow(DebtQueryError);
    expect(() => parseCollectionsQuery({ from: '11/10/2026' })).toThrow(DebtQueryError);
    expect(() => parseCollectionsQuery({ from: '2026-10-02', to: '2026-10-01' })).toThrow(DebtQueryError);
    expect(() => parseCollectionsQuery({ currency: 'lyd;' })).toThrow(DebtQueryError);
    expect(() => parseCollectionsQuery({ grain: 'day', from: '2020-01-01', to: '2026-10-01' })).toThrow(/at most/);
  });
});

describe('collectionSource', () => {
  it('filters the view on range, currency and the scoped / page filters, never on line-level filters', () => {
    const q = parseCollectionsQuery({ from: '2026-09-01', to: '2026-09-30', overdueStatus: 'overdue', customerCategories: 'A' });
    const s = collectionSource(q, { companyKeys: [1], salespersonKeys: [5], salesTeamKeys: ['T1'], segmentKeys: [2], channelKeys: [3], customerKeys: [10] }, 'LYD');
    expect(s.sql).toContain('FROM v_finance_collection_trend v');
    for (const c of ['v.payment_date BETWEEN ? AND ?', 'v.currency = ?', 'v.CompanyKey IN (?)', 'v.SalespersonKey IN (?)', 'v.SalesTeamKey IN (?)',
      'v.SegmentKey IN (?)', 'v.ChannelKey IN (?)', 'v.CustomerKey IN (?)', 'cu.']) expect(s.sql).toContain(c);
    expect(s.sql).not.toContain('days_past_due');
    expect(s.sql).toContain('i.invoice_date < c.payment_date');
    expect(s.sql).toContain("m.move_type IN ('out_invoice', 'out_receipt')");
    expect(s.sql).toContain('SUM(m.applied_doc_ccy)');
    expect(s.params.slice(0, 3)).toEqual(['2026-09-01', '2026-09-30', 'LYD']);
  });
});

/** Answers the trend queries: currencies, the per-period sums, the snapshot dates and the rate query. */
function fakePool(o: { periods?: Record<string, unknown>[]; snapshots?: string[]; rate?: { start_overdue: number; collected: number } }): Pool & { sqls: string[] } {
  const sqls: string[] = [];
  return {
    sqls,
    query: async (sql: string) => {
      sqls.push(sql);
      if (sql.includes('GROUP BY v.currency')) return [[{ currency: 'LYD', n: 9 }, { currency: 'USD', n: 1 }], []];
      if (sql.includes('MIN(payment_date)')) return [[{ first: '2021-01-03', loaded: '2026-10-10T15:00:00Z' }], []];
      if (sql.includes('GROUP BY p')) return [o.periods ?? [], []];
      if (sql.includes('SELECT DISTINCT DATE_FORMAT(STR_TO_DATE(SnapshotDateKey')) return [(o.snapshots ?? []).map((d) => ({ d })), []];
      if (sql.includes('AS start_overdue')) return [[o.rate ?? { start_overdue: 0, collected: 0 }], []];
      if (sql.includes('ORDER BY v.payment_date')) {
        return [[{ payment_id: 1, allocation_no: 1, payment_name: 'BNK1/1', payment_date: '2026-10-05', company: 'Majaal', customer: 'A', salesperson: 'S1',
          sales_team: 'T1', attribution: 'invoice', amount_doc_ccy: 600, applied_overdue_doc_ccy: 600, applied_not_due_doc_ccy: 0, applied_other_doc_ccy: 0, unapplied_doc_ccy: 0 }], []];
      }
      if (sql.includes('SELECT m.payment_id, m.allocation_no, m.document')) return [[{ payment_id: 1, allocation_no: 1, document: 'INV/1', applied_doc_ccy: 600 }], []];
      return [[], []];
    },
  } as unknown as Pool & { sqls: string[] };
}

describe('fetchCollectionsTrend', () => {
  const q = parseCollectionsQuery({ from: '2026-09-26', to: '2026-10-16' });

  it('one point per period (zeros where nothing was collected), the most used currency by default', async () => {
    const t = await fetchCollectionsTrend(fakePool({ periods: [{ p: '2026-10-03', collected: 900, overdue: 600, not_due: 300, other: 0, unapplied: 0, payments: 3 }] }), q, {});
    expect(t.currency).toBe('LYD');
    expect(t.currencies).toEqual(['LYD', 'USD']);
    expect(t.points.map((p) => [p.periodStart, p.collected, p.payments])).toEqual([['2026-09-26', 0, 0], ['2026-10-03', 900, 3], ['2026-10-10', 0, 0]]);
    const p = t.points[1];
    expect(p.appliedOverdue + p.appliedNotDue + p.appliedOther + p.unapplied).toBe(p.collected);
    expect(t.firstPaymentDate).toBe('2021-01-03');
  });

  it('collection rate = applied to the start overdue / start overdue, only where a snapshot exists the day before', async () => {
    const pool = fakePool({ snapshots: ['2026-10-02', '2026-10-08'], rate: { start_overdue: 2000, collected: 500 } });
    const t = await fetchCollectionsTrend(pool, q, {});
    const rateSql = pool.sqls.find((s) => s.includes('AS start_overdue')) ?? '';
    expect(rateSql).toContain('l.days_past_due >= 0');
    expect(rateSql).toContain('f.SnapshotDateKey = ?');
    expect(t.points.map((p) => p.collectionRate)).toEqual([null, 0.25, null]);
    expect(t.points[1]).toMatchObject({ startOverdue: 2000, collectedOnStartOverdue: 500 });
  });

  it('a start overdue of 0 gives no rate', async () => {
    const t = await fetchCollectionsTrend(fakePool({ snapshots: ['2026-10-02'], rate: { start_overdue: 0, collected: 0 } }), q, {});
    expect(t.points[1].collectionRate).toBeNull();
  });
});

describe('fetchCollectionsDrilldown', () => {
  it('lists the payments of the period with the invoices they were applied to and an Odoo link', async () => {
    const q = parseCollectionsQuery({ currency: 'LYD' });
    const pool = fakePool({});
    const d = await fetchCollectionsDrilldown(pool, q, {}, '2026-10-06');
    const invoiceList = pool.sqls.find((sql) => sql.includes('SELECT m.payment_id, m.allocation_no, m.document'))!;
    expect(invoiceList).toContain('i.invoice_date < c.payment_date');
    expect(pool.sqls.find((sql) => sql.includes('ORDER BY v.payment_date'))).toContain('e.amount_doc_ccy');
    expect(d.period).toEqual({ start: '2026-10-03', end: '2026-10-09' });
    expect(d.rows[0]).toMatchObject({ payment: 'BNK1/1', amount: 600, appliedOverdue: 600, invoices: 'INV/1 (600.00)' });
    expect(d.rows[0].odooUrl).toMatch(/model=account\.payment/);
  });

  it('needs a currency and a period date', async () => {
    await expect(fetchCollectionsDrilldown(fakePool({}), parseCollectionsQuery({}), {}, '2026-10-06')).rejects.toThrow(DebtQueryError);
    await expect(fetchCollectionsDrilldown(fakePool({}), parseCollectionsQuery({ currency: 'LYD' }), {}, 'x')).rejects.toThrow(DebtQueryError);
  });
});

describe('fetchDebtTrend gaps (Part 1, 2026-10-10)', () => {
  it('a snapshot without any line for the filters is a gap (null), not 0; one with other currencies only is 0', async () => {
    const pool = {
      query: async (sql: string) => {
        if (/GROUP BY SnapshotDateKey ORDER BY SnapshotDateKey/.test(sql)) return [[{ k: 20261004, n: 5 }, { k: 20261006, n: 5 }, { k: 20261011, n: 5 }], []];
        if (sql.includes('GROUP BY l.SnapshotDateKey, l.currency')) {
          return [[{ k: 20261006, currency: 'USD', n: 1, open_amount: 10, overdue: 0, net: 10 }, { k: 20261011, currency: 'LYD', n: 2, open_amount: 500, overdue: 200, net: 450 }], []];
        }
        return [[], []];
      },
    } as unknown as Pool;
    const t = await fetchDebtTrend(pool, DEFAULT_DEBT_QUERY, { companyKeys: [9] });
    const lyd = t.points.filter((p) => p.currency === 'LYD');
    expect(lyd.map((p) => p.open)).toEqual([null, 0, 500]);
    expect(lyd[0]).toEqual({ snapshotDate: '2026-10-04', currency: 'LYD', open: null, overdue: null, notDue: null, net: null });
  });
});
