import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';
import {
  evaluateRefreshConsistency,
  fetchFailedAfterLoad,
  fetchLastSuccessfulRun,
  fetchRefreshStatus,
  getToleranceMinutes,
  type LastSuccessfulRun,
} from '../refreshStatus';
import { getAppTimezone, tripoliSqlDateTimeToDate, utcSqlDateTimeToDate } from '../../lib/timezone';

const TRIPOLI = 'Africa/Tripoli';
const utc = (s: string) => new Date(`${s}Z`);

function run(over: Partial<LastSuccessfulRun> = {}): LastSuccessfulRun {
  return {
    runUid: 'uid-1',
    finishedAtUtc: utc('2026-09-20T12:45:00'),
    watermarkOrderDateUtc: utc('2026-09-20T12:42:00'),
    watermarkOrderCreatedUtc: utc('2026-09-20T12:40:00'),
    businessTimezone: TRIPOLI,
    legacyBackfill: false,
    ...over,
  };
}

const check = (over: Partial<Parameters<typeof evaluateRefreshConsistency>[0]> = {}) =>
  evaluateRefreshConsistency({
    lastRun: run(),
    targetOrderCreatedUtc: utc('2026-09-20T12:40:00'),
    targetOrderDateUtc: utc('2026-09-20T12:42:00'),
    toleranceMinutes: 5,
    appTimezone: TRIPOLI,
    ...over,
  });

afterEach(() => {
  delete process.env.APP_TIMEZONE;
  delete process.env.REFRESH_CHECK_TOLERANCE_MINUTES;
  vi.useRealTimers();
});

describe('timestamp normalisation', () => {
  it('reads a naive Tripoli wall-clock and a UTC wall-clock of the same instant as the same Date', () => {
    const fromBusiness = tripoliSqlDateTimeToDate('2026-09-20 14:42:00'); // UTC+2
    const fromUtc = utcSqlDateTimeToDate('2026-09-20 12:42:00');
    expect(fromBusiness?.toISOString()).toBe('2026-09-20T12:42:00.000Z');
    expect(fromUtc?.getTime()).toBe(fromBusiness?.getTime());
  });

  it('follows APP_TIMEZONE, and falls back to Africa/Tripoli for an invalid value', () => {
    process.env.APP_TIMEZONE = 'Europe/Berlin';
    expect(getAppTimezone()).toBe('Europe/Berlin');
    expect(tripoliSqlDateTimeToDate('2026-09-20 14:42:00')?.toISOString()).toBe('2026-09-20T12:42:00.000Z'); // Berlin is UTC+2 in September too
    process.env.APP_TIMEZONE = 'Not/AZone';
    expect(getAppTimezone()).toBe(TRIPOLI);
  });

  it('handles DST offsets: the same wall-clock hour maps to different UTC instants across the change', () => {
    process.env.APP_TIMEZONE = 'Europe/Berlin';
    expect(tripoliSqlDateTimeToDate('2026-03-29 03:30:00')?.toISOString()).toBe('2026-03-29T01:30:00.000Z'); // CEST, +02:00
    expect(tripoliSqlDateTimeToDate('2026-03-28 03:30:00')?.toISOString()).toBe('2026-03-28T02:30:00.000Z'); // CET, +01:00
    // An ambiguous (fall-back) and a non-existent (spring-forward) wall-clock time never yield an invalid Date.
    expect(tripoliSqlDateTimeToDate('2026-10-25 02:30:00')).toBeInstanceOf(Date);
    expect(tripoliSqlDateTimeToDate('2026-03-29 02:30:00')).toBeInstanceOf(Date);
  });
});

describe('evaluateRefreshConsistency', () => {
  it('is ok when the refresh finished after the newest loaded order, and the message is specific', () => {
    const res = check();
    expect(res.status).toBe('ok');
    expect(res.inconsistent).toBe(false);
    expect(res.message).toContain('Last refresh 2026-09-20 14:45 Africa/Tripoli');
    expect(res.message).toContain('latest loaded order 2026-09-20 14:40 Africa/Tripoli');
    expect(res.message).toContain('difference 5 min');
    expect(res.message).toContain('timezone Africa/Tripoli');
  });

  it('REGRESSION (the incident): a UTC refresh time is no longer misread as Libya time', () => {
    // ETL logged 13:15 UTC; the newest order was created 14:42 Libya = 12:42 UTC.
    const order = tripoliSqlDateTimeToDate('2026-09-20 14:42:00');
    // Old behaviour: naive 13:15 was read as Tripoli => 11:15Z, "earlier than the most recent order".
    const misread = tripoliSqlDateTimeToDate('2026-09-20 13:15:00');
    expect(misread!.getTime()).toBeLessThan(order!.getTime());
    // Now the value is UTC-typed and compared as an instant.
    const fixed = check({
      lastRun: run({ finishedAtUtc: utcSqlDateTimeToDate('2026-09-20 13:15:00')!, watermarkOrderCreatedUtc: order }),
      targetOrderCreatedUtc: order,
    });
    expect(fixed.status).toBe('ok');
    expect(fixed.differenceMinutes).toBeLessThan(0);
  });

  it('tolerates an order created just after the refresh, within the tolerance', () => {
    const order = utc('2026-09-20T12:48:00'); // 3 min after the 12:45 refresh
    expect(check({ targetOrderCreatedUtc: order, lastRun: run({ watermarkOrderCreatedUtc: order }) }).status).toBe('ok');
  });

  it('flags refresh_before_data once the order is newer than refresh + tolerance', () => {
    const order = utc('2026-09-20T12:52:00'); // 7 min after
    const res = check({ targetOrderCreatedUtc: order, lastRun: run({ watermarkOrderCreatedUtc: order }) });
    expect(res.status).toBe('refresh_before_data');
    expect(res.inconsistent).toBe(true);
    expect(res.differenceMinutes).toBe(7);
    expect(res.message).toContain('difference 7 min');
    expect(res.action).toMatch(/TIMEZONE/);
  });

  it('honours a configurable tolerance', () => {
    const order = utc('2026-09-20T12:52:00');
    const lastRun = run({ watermarkOrderCreatedUtc: order });
    expect(check({ targetOrderCreatedUtc: order, lastRun, toleranceMinutes: 10 }).status).toBe('ok');
    process.env.REFRESH_CHECK_TOLERANCE_MINUTES = '15';
    expect(getToleranceMinutes()).toBe(15);
    process.env.REFRESH_CHECK_TOLERANCE_MINUTES = 'abc';
    expect(getToleranceMinutes()).toBe(5);
  });

  it('flags data_ahead_of_watermark when the tables hold orders newer than the last successful run loaded', () => {
    // Watermark 12:40Z; a failed later run left an order created 12:44Z in the table, refresh (12:59Z) is later.
    const res = check({
      lastRun: run({ finishedAtUtc: utc('2026-09-20T12:59:00') }),
      targetOrderCreatedUtc: utc('2026-09-20T12:50:00'),
    });
    expect(res.status).toBe('data_ahead_of_watermark');
    expect(res.inconsistent).toBe(true);
    expect(res.action).toMatch(/ETL Runs/);
  });

  it('a run that failed after loading EXPLAINS newer data: informational status, not an inconsistency', () => {
    // A later run loaded orders created up to 12:52Z and then failed validation; the last success is older.
    const failed = { runUid: 'f1', finishedAtUtc: utc('2026-09-20T13:20:00'), watermarkOrderCreatedUtc: utc('2026-09-20T12:52:00') };
    const res = check({ failedAfterLoad: failed, targetOrderCreatedUtc: utc('2026-09-20T12:52:00') });
    expect(res.status).toBe('last_run_failed_after_load');
    expect(res.inconsistent).toBe(false);
    expect(res.action).toMatch(/ETL Runs/);
  });

  it("data beyond even the failed run's watermark is still flagged", () => {
    const failed = { runUid: 'f1', finishedAtUtc: utc('2026-09-20T13:20:00'), watermarkOrderCreatedUtc: utc('2026-09-20T12:52:00') };
    expect(check({ failedAfterLoad: failed, targetOrderCreatedUtc: utc('2026-09-20T13:10:00') }).status).toBe('data_ahead_of_watermark');
  });

  it('does not flag data older than the watermark (orders deleted/cancelled in the source)', () => {
    expect(check({ targetOrderCreatedUtc: utc('2026-09-20T09:00:00') }).status).toBe('ok');
  });

  it('flags a timezone mismatch between the run and the backend, without guessing', () => {
    const res = check({ lastRun: run({ businessTimezone: 'UTC' }) });
    expect(res.status).toBe('timezone_mismatch');
    expect(res.inconsistent).toBe(true);
    expect(res.message).toContain('UTC');
    expect(res.message).toContain(TRIPOLI);
  });

  it('reports no_refresh_log as a setup gap, not as an inconsistency', () => {
    const res = check({ lastRun: null });
    expect(res.status).toBe('no_refresh_log');
    expect(res.inconsistent).toBe(false);
    expect(res.action).toMatch(/backfill/);
  });

  it('skips the watermark comparison for backfilled legacy rows that have no created-at watermark', () => {
    const res = check({ lastRun: run({ legacyBackfill: true, watermarkOrderCreatedUtc: null }), targetOrderCreatedUtc: utc('2026-09-20T12:00:00') });
    expect(res.status).toBe('ok');
  });
});

describe('fetchLastSuccessfulRun / fetchRefreshStatus', () => {
  const poolFor = (handler: (sql: string) => unknown) => ({ query: vi.fn(async (sql: string) => [handler(sql)]) }) as unknown as Pool & { query: ReturnType<typeof vi.fn> };

  it('only ever selects status = success rows, latest finish first (a failed or running run cannot move Last Refresh)', async () => {
    const pool = poolFor(() => [
      {
        run_uid: 'a',
        finished_at_utc: '2026-09-20 12:45:00',
        watermark_order_date_utc: '2026-09-20 12:42:00',
        watermark_order_created_utc: '2026-09-20 12:40:00',
        business_timezone: TRIPOLI,
        legacy_backfill: 0,
      },
    ]);
    const res = await fetchLastSuccessfulRun(pool);
    const sql = pool.query.mock.calls[0][0] as string;
    expect(sql).toMatch(/status = 'success'/);
    expect(sql).toMatch(/ORDER BY finished_at_utc DESC/);
    expect(res?.finishedAtUtc.toISOString()).toBe('2026-09-20T12:45:00.000Z');
  });

  it('fetchFailedAfterLoad only returns failed runs that wrote data and finished after the last success', async () => {
    const row = { run_uid: 'f1', finished_at_utc: '2026-09-20 13:20:00', watermark_order_created_utc: '2026-09-20 12:52:00' };
    const pool = poolFor(() => [row]);
    const found = await fetchFailedAfterLoad(pool, utc('2026-09-20T12:45:00'));
    expect(pool.query.mock.calls[0][0] as string).toMatch(/status = 'failed' AND watermark_order_created_utc IS NOT NULL/);
    expect(found?.runUid).toBe('f1');
    expect(await fetchFailedAfterLoad(poolFor(() => [row]), utc('2026-09-20T13:30:00'))).toBeNull(); // older than the last success
  });

  it('returns null (not a throw) when etl_run_log does not exist yet', async () => {
    const pool = { query: vi.fn(async () => { throw new Error("Table 'etl_run_log' doesn't exist"); }) } as unknown as Pool;
    expect(await fetchLastSuccessfulRun(pool)).toBeNull();
  });

  it('assembles the status: UTC refresh, Libya-converted order times, isInverted mirrors the check', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(utc('2026-09-20T13:00:00'));
    const pool = poolFor((sql) => {
      if (sql.includes('FROM etl_run_log')) {
        return [{ run_uid: 'a', finished_at_utc: '2026-09-20 12:45:00', watermark_order_date_utc: '2026-09-20 12:42:00', watermark_order_created_utc: '2026-09-20 12:40:00', business_timezone: TRIPOLI, legacy_backfill: 0 }];
      }
      if (sql.includes('OrderDateTime')) return [{ v: '2026-09-20 14:42:00' }];
      return [{ v: '2026-09-20 14:40:00' }]; // QuotationDate
    });
    const status = await fetchRefreshStatus(pool);
    expect(status.lastRefreshTime?.toISOString()).toBe('2026-09-20T12:45:00.000Z');
    expect(status.lastUpdate?.toISOString()).toBe('2026-09-20T12:42:00.000Z');
    expect(status.lastOrderCreated?.toISOString()).toBe('2026-09-20T12:40:00.000Z');
    expect(status.isStale).toBe(false);
    expect(status.isInverted).toBe(false);
    expect(status.refreshCheck.status).toBe('ok');
    expect(status.displayTimezone).toBe(TRIPOLI);
  });

  it('treats a Fact_Orders without QuotationDate (Fact_Sales was empty) as "unknown", not as an error', async () => {
    const pool = poolFor((sql) => {
      if (sql.includes('FROM etl_run_log')) {
        return [{ run_uid: 'a', finished_at_utc: '2026-09-20 12:45:00', watermark_order_date_utc: '2026-09-20 12:42:00', watermark_order_created_utc: null, business_timezone: TRIPOLI, legacy_backfill: 0 }];
      }
      return [{ v: '2026-09-20 14:42:00' }];
    });
    (pool.query as any).mockImplementation(async (sql: string) => {
      if (sql.includes('QuotationDate')) throw Object.assign(new Error("Unknown column 'QuotationDate'"), { errno: 1054 });
      if (sql.includes('FROM etl_run_log')) {
        return [[{ run_uid: 'a', finished_at_utc: '2026-09-20 12:45:00', watermark_order_date_utc: null, watermark_order_created_utc: null, business_timezone: TRIPOLI, legacy_backfill: 0 }]];
      }
      return [[{ v: '2026-09-20 14:42:00' }]];
    });
    const status = await fetchRefreshStatus(pool);
    expect(status.lastOrderCreated).toBeNull();
    expect(status.lastUpdate?.toISOString()).toBe('2026-09-20T12:42:00.000Z');
    expect(status.refreshCheck.inconsistent).toBe(false);
  });

  it('still propagates a real database failure (connection lost) instead of hiding it', async () => {
    const pool = { query: vi.fn(async () => { throw Object.assign(new Error('connection lost'), { errno: 2013 }); }) } as unknown as Pool;
    await expect(fetchRefreshStatus(pool)).rejects.toThrow('connection lost');
  });

  it('is stale, but not "wrong", when the last successful refresh is old', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(utc('2026-09-21T12:45:00')); // 24h later
    const pool = poolFor((sql) => {
      if (sql.includes('FROM etl_run_log')) {
        return [{ run_uid: 'a', finished_at_utc: '2026-09-20 12:45:00', watermark_order_date_utc: null, watermark_order_created_utc: '2026-09-20 12:40:00', business_timezone: TRIPOLI, legacy_backfill: 0 }];
      }
      return [{ v: '2026-09-20 14:40:00' }];
    });
    const status = await fetchRefreshStatus(pool);
    expect(status.isStale).toBe(true);
    expect(status.isInverted).toBe(false);
  });
});
