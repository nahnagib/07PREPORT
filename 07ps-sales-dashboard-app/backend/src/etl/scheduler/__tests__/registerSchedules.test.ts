import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { cron, enqueue } = vi.hoisted(() => ({
  cron: { schedule: vi.fn(), validate: vi.fn(() => true) },
  enqueue: vi.fn(async () => ({ runId: 1 })),
}));

vi.mock('node-cron', () => ({ default: cron }));
vi.mock('../../queue/etlQueue', () => ({ enqueuePipelineRun: enqueue, EtlAlreadyRunningError: class extends Error {} }));
vi.mock('../../services/etlLogger', () => ({ etlLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { getEtlConfig } from '../../config/etlConfig';
import { computeNextRunTime } from '../nextRunTime';
import { registerEtlSchedules } from '../registerSchedules';

const SCHEDULE_VARS = [
  'ETL_SCHEDULE_INCREMENTAL_CRON', 'ETL_SCHEDULE_INCREMENTAL_ENABLED', 'ETL_SCHEDULE_FULL_CRON', 'ETL_SCHEDULE_FULL_ENABLED',
  'ETL_SCHEDULE_FINANCE_CRON', 'ETL_SCHEDULE_FINANCE_ENABLED', 'ETL_SCHEDULE_PROCESS_NPS_CRON', 'ETL_SCHEDULE_PROCESS_NPS_ENABLED',
  'ETL_SCHEDULE_TIMEZONE', 'APP_TIMEZONE',
];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  vi.clearAllMocks();
  saved = Object.fromEntries(SCHEDULE_VARS.map((k) => [k, process.env[k]]));
  for (const k of SCHEDULE_VARS) delete process.env[k];
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Registers the schedules and fires each tick once: cron expression, zone and the ETL job it enqueues. */
async function registered() {
  registerEtlSchedules();
  const out: { cron: string; timezone: string; job: string; mode: string }[] = [];
  for (const [expr, tick, opts] of cron.schedule.mock.calls as unknown as [string, () => void, { timezone: string }][]) {
    tick();
    const input = (enqueue.mock.calls.at(-1) as unknown as [{ job: string; mode: string }])[0];
    out.push({ cron: expr, timezone: opts.timezone, job: input.job, mode: input.mode });
  }
  return out;
}

describe('ETL schedules', () => {
  it('3-hourly main without finance, 02:00 full_all with finance, 15:00 finance_receivables -- all in Africa/Tripoli', async () => {
    process.env.ETL_SCHEDULE_INCREMENTAL_CRON = '0 */3 * * *';
    expect(await registered()).toEqual([
      { cron: '0 */3 * * *', timezone: 'Africa/Tripoli', job: 'main', mode: 'incremental' },
      { cron: '0 2 * * *', timezone: 'Africa/Tripoli', job: 'full_all', mode: 'full' },
      { cron: '0 15 * * *', timezone: 'Africa/Tripoli', job: 'finance_receivables', mode: 'finance' },
    ]);
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

  it('the finance schedule can be switched off on its own', async () => {
    process.env.ETL_SCHEDULE_FINANCE_ENABLED = 'false';
    expect((await registered()).map((s) => s.job)).toEqual(['main', 'full_all']);
  });

  it('NPS Score (process_nps alone) is off unless enabled; then every 3 hours at :30 in Africa/Tripoli', async () => {
    expect((await registered()).map((s) => s.job)).not.toContain('process_nps');
    vi.clearAllMocks();
    process.env.ETL_SCHEDULE_PROCESS_NPS_ENABLED = 'true';
    expect((await registered()).at(-1)).toEqual({ cron: '30 */3 * * *', timezone: 'Africa/Tripoli', job: 'process_nps', mode: 'nps' });
    expect(getEtlConfig().schedule.processNpsCron).toBe('30 */3 * * *');
  });
});
