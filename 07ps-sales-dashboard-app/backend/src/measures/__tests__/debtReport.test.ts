import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_DEBT_QUERY, DebtQueryError, dateKeyOf, isoOfKey, linesSource, parseDebtQuery } from '../debtReport';
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
