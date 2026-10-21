import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { cron, enqueue } = vi.hoisted(() => ({
  cron: { schedule: vi.fn(), validate: vi.fn(() => true) },
  enqueue: vi.fn(async () => ({ runId: 1 })),
}));

vi.mock('node-cron', () => ({ default: cron }));
vi.mock('../../queue/etlQueue', () => ({ enqueuePipelineRun: enqueue, EtlAlreadyRunningError: class extends Error {} }));
vi.mock('../../services/etlLogger', () => ({ etlLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { cronForInterval, etlScheduleWarning, getEtlConfig, npsRefresh, refreshIntervalMinutes } from '../../config/etlConfig';
import { computeNextRunTime, cronFiresInMinute } from '../nextRunTime';
import { registerEtlSchedules } from '../registerSchedules';

const SCHEDULE_VARS = [
  'ETL_SCHEDULER_ENABLED', 'ETL_SCHEDULE_REFRESH_CRON', 'ETL_SCHEDULE_REFRESH_ENABLED', 'ETL_REFRESH_INTERVAL_MINUTES',
  'ETL_SCHEDULE_INCREMENTAL_CRON', 'ETL_SCHEDULE_INCREMENTAL_ENABLED', 'ETL_SCHEDULE_FULL_CRON', 'ETL_SCHEDULE_FULL_ENABLED',
  'ETL_SCHEDULE_FINANCE_CRON', 'ETL_SCHEDULE_FINANCE_ENABLED', 'ETL_SCHEDULE_PROCESS_NPS_CRON', 'ETL_SCHEDULE_PROCESS_NPS_ENABLED',
  'ETL_SCHEDULE_TIMEZONE', 'APP_TIMEZONE', 'ETL_WORKER_ENABLED', 'ETL_SCHEDULER_OFF_OK',
  'ETL_SCHEDULE_SALES_BUILD_CRON', 'ETL_SCHEDULE_SALES_BUILD_ENABLED',
];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  vi.clearAllMocks();
  saved = Object.fromEntries(SCHEDULE_VARS.map((k) => [k, process.env[k]]));
  for (const k of SCHEDULE_VARS) delete process.env[k];
  process.env.ETL_SCHEDULER_ENABLED = 'true'; // the server; the default (off) has its own test
});
afterEach(() => {
  vi.useRealTimers();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

type Enqueued = { job: string; mode: string; attempts?: number; queueBehindRefresh?: boolean };

/** Registers the schedules and fires each tick once: cron expression, zone and the ETL job it enqueues. */
async function registered() {
  registerEtlSchedules();
  const out: ({ cron: string; timezone: string } & Enqueued)[] = [];
  for (const [expr, tick, opts] of cron.schedule.mock.calls as unknown as [string, () => void, { timezone: string }][]) {
    tick();
    const input = (enqueue.mock.calls.at(-1) as unknown as [Enqueued])[0];
    out.push({
      cron: expr, timezone: opts.timezone, job: input.job, mode: input.mode, attempts: input.attempts,
      queueBehindRefresh: input.queueBehindRefresh,
    });
  }
  return out;
}

/** Fires the registered refresh tick at a given instant; returns the enqueued job, or null when the tick yielded. */
function refreshTickAt(utcIso: string): Enqueued | null {
  cron.schedule.mockClear();
  registerEtlSchedules();
  const refreshCron = getEtlConfig().schedule.refreshCron;
  const call = (cron.schedule.mock.calls as unknown as [string, () => void][]).find(([expr]) => expr === refreshCron);
  expect(call).toBeTruthy();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(utcIso));
  enqueue.mockClear();
  call![1]();
  vi.useRealTimers();
  return enqueue.mock.calls.length ? (enqueue.mock.calls[0] as unknown as [Enqueued])[0] : null;
}

describe('ETL schedules', () => {
  it('registers nothing unless ETL_SCHEDULER_ENABLED=true (a laptop never starts an ETL run)', () => {
    delete process.env.ETL_SCHEDULER_ENABLED;
    registerEtlSchedules();
    expect(cron.schedule).not.toHaveBeenCalled();
    process.env.ETL_SCHEDULER_ENABLED = 'false';
    registerEtlSchedules();
    expect(cron.schedule).not.toHaveBeenCalled();
    expect(getEtlConfig().workerEnabled).toBe(false); // the worker is off by default too
  });

  it('defaults: 30-minute refresh, sales at 08:50 11:50 14:50 17:50 20:50, full 02:00, no 15:00 -- all in Africa/Tripoli', async () => {
    expect(await registered()).toEqual([
      { cron: '*/30 * * * *', timezone: 'Africa/Tripoli', job: 'refresh_30m', mode: 'refresh', attempts: 1, queueBehindRefresh: undefined },
      { cron: '50 8,11,14,17,20 * * *', timezone: 'Africa/Tripoli', job: 'main', mode: 'incremental', attempts: undefined, queueBehindRefresh: true },
      { cron: '0 2 * * *', timezone: 'Africa/Tripoli', job: 'full_all', mode: 'full', attempts: undefined, queueBehindRefresh: true },
    ]);
  });

  it('rollback: refresh off and the 15:00 receivables schedule back on', async () => {
    process.env.ETL_SCHEDULE_FINANCE_ENABLED = 'true';
    process.env.ETL_SCHEDULE_REFRESH_ENABLED = 'false';
    expect((await registered()).map((s) => [s.cron, s.job])).toEqual([
      ['50 8,11,14,17,20 * * *', 'main'], ['0 2 * * *', 'full_all'], ['0 15 * * *', 'finance_receivables'],
    ]);
  });

  it('the interval comes from ETL_REFRESH_INTERVAL_MINUTES (a divisor of 60) or an explicit cron', () => {
    expect(refreshIntervalMinutes('15')).toBe(15);
    expect(refreshIntervalMinutes('60')).toBe(60);
    for (const bad of ['7', '0', '90', 'x', undefined]) expect(refreshIntervalMinutes(bad)).toBe(30);
    expect(cronForInterval(15)).toBe('*/15 * * * *');
    expect(cronForInterval(60)).toBe('0 * * * *');
    process.env.ETL_REFRESH_INTERVAL_MINUTES = '20';
    expect(getEtlConfig().schedule.refreshCron).toBe('*/20 * * * *');
    process.env.ETL_SCHEDULE_REFRESH_CRON = '5,35 * * * *';
    expect(getEtlConfig().schedule.refreshCron).toBe('5,35 * * * *');
  });

  it('the 02:00 refresh tick yields to the full refresh; 02:30 runs', () => {
    expect(refreshTickAt('2026-10-21T00:00:00.300Z')).toBeNull(); // 02:00 Tripoli
    expect(refreshTickAt('2026-10-21T00:30:00.300Z')).toMatchObject({ job: 'refresh_30m' });
  });

  it('a refresh tick in the same minute as the sales schedule yields to it', () => {
    process.env.ETL_REFRESH_INTERVAL_MINUTES = '10';
    expect(refreshTickAt('2026-10-21T06:50:00.100Z')).toBeNull(); // 08:50 Tripoli = sales
    expect(refreshTickAt('2026-10-21T06:40:00.100Z')).toMatchObject({ job: 'refresh_30m' });
    process.env.ETL_SCHEDULE_INCREMENTAL_ENABLED = 'false'; // no sales schedule -> nothing to yield to
    expect(refreshTickAt('2026-10-21T06:50:00.100Z')).toMatchObject({ job: 'refresh_30m' });
  });

  it('reads the crons in APP_TIMEZONE when ETL_SCHEDULE_TIMEZONE is unset, never the process zone', async () => {
    process.env.APP_TIMEZONE = 'Africa/Cairo';
    expect(getEtlConfig().schedule.timezone).toBe('Africa/Cairo');
    process.env.ETL_SCHEDULE_TIMEZONE = 'Africa/Tripoli';
    expect(getEtlConfig().schedule.timezone).toBe('Africa/Tripoli');
  });

  it('15:00 Tripoli is 13:00 UTC (Libya is UTC+2 all year)', () => {
    const next = computeNextRunTime('0 15 * * *', getEtlConfig().schedule.timezone);
    expect(next?.getUTCHours()).toBe(13);
    expect(next?.getUTCMinutes()).toBe(0);
  });

  it('cronFiresInMinute matches the whole minute of a tick, in the schedule zone', () => {
    expect(cronFiresInMinute('0 2 * * *', new Date('2026-10-21T00:00:59Z'), 'Africa/Tripoli')).toBe(true);
    expect(cronFiresInMinute('0 2 * * *', new Date('2026-10-21T00:01:00Z'), 'Africa/Tripoli')).toBe(false);
    expect(cronFiresInMinute('0 2 * * *', new Date('2026-10-21T02:00:00Z'), 'Africa/Tripoli')).toBe(false); // 04:00 local
    expect(cronFiresInMinute('not a cron', new Date(), 'Africa/Tripoli')).toBe(false);
  });

  it('NPS Score runs once a night: inside the 02:00 full_all, never also on its own schedule', async () => {
    process.env.ETL_SCHEDULE_PROCESS_NPS_ENABLED = 'true';
    const jobs = (await registered()).map((s) => s.job);
    expect(jobs).not.toContain('process_nps');
    expect(jobs.filter((j) => j === 'full_all')).toHaveLength(1);
    expect(npsRefresh(getEtlConfig().schedule)).toEqual({ via: 'full_all', cron: '0 2 * * *' });
  });

  it('with the full schedule off, process_nps alone at 02:00 Africa/Tripoli as a full reload', async () => {
    process.env.ETL_SCHEDULE_FULL_ENABLED = 'false';
    process.env.ETL_SCHEDULE_PROCESS_NPS_ENABLED = 'true';
    const all = await registered();
    expect(all.at(-1)).toEqual({ cron: '0 2 * * *', timezone: 'Africa/Tripoli', job: 'process_nps', mode: 'nps', attempts: undefined, queueBehindRefresh: true });
    expect((enqueue.mock.calls.at(-1) as unknown as [{ loadMode: string }])[0].loadMode).toBe('full');
    expect(all.map((s) => s.job)).not.toContain('full_all');
    expect(npsRefresh(getEtlConfig().schedule)).toEqual({ via: 'own', cron: '0 2 * * *' });
  });

  it('the sales build (Phase B) is off by default; on, it runs 10 minutes after each refresh tick, one attempt', async () => {
    expect((await registered()).map((s) => s.job)).not.toContain('sales_build');
    vi.clearAllMocks();
    process.env.ETL_SCHEDULE_SALES_BUILD_ENABLED = 'true';
    const build = (await registered()).find((s) => s.job === 'sales_build');
    expect(build).toEqual({ cron: '10,40 * * * *', timezone: 'Africa/Tripoli', job: 'sales_build', mode: 'sales_build', attempts: 1,
      queueBehindRefresh: undefined });
  });

  it('NPS is off when its own schedule is off and there is no nightly full_all', async () => {
    process.env.ETL_SCHEDULE_FULL_ENABLED = 'false';
    expect((await registered()).map((s) => s.job)).not.toContain('process_nps');
    expect(npsRefresh(getEtlConfig().schedule)).toEqual({ via: 'off', cron: null });
    expect(getEtlConfig().schedule.processNpsCron).toBe('0 2 * * *');
  });
});

describe('fail-safe: a production build with the ETL switches off warns', () => {
  const base = () => getEtlConfig();

  it('warns on NODE_ENV=production when the scheduler or the worker is off, naming the missing line(s)', () => {
    delete process.env.ETL_SCHEDULER_ENABLED;
    delete process.env.ETL_WORKER_ENABLED;
    const both = etlScheduleWarning(base(), 'production');
    expect(both).toMatch(/^No ETL schedule is running on this server: ETL_SCHEDULER_ENABLED and ETL_WORKER_ENABLED are not true/);
    process.env.ETL_SCHEDULER_ENABLED = 'true';
    expect(etlScheduleWarning(base(), 'production')).toMatch(/ETL_WORKER_ENABLED is not true/);
  });

  it('is silent on the configured server, in development, and where the machine is off on purpose', () => {
    process.env.ETL_SCHEDULER_ENABLED = 'true';
    process.env.ETL_WORKER_ENABLED = 'true';
    expect(etlScheduleWarning(base(), 'production')).toBeNull();
    delete process.env.ETL_SCHEDULER_ENABLED;
    expect(etlScheduleWarning(base(), 'development')).toBeNull();
    process.env.ETL_SCHEDULER_OFF_OK = 'true';
    expect(etlScheduleWarning(base(), 'production')).toBeNull();
    delete process.env.ETL_SCHEDULER_OFF_OK;
  });
});
