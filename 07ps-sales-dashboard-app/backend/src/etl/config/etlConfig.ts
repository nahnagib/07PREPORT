import path from 'path';
import { getAppTimezone } from '../../lib/timezone';

/**
 * Single place the ETL module reads process.env from -- every other file under src/etl imports
 * from here instead of touching process.env directly, mirroring how src/db/pool.ts centralizes
 * the MySQL connection config. Values are read lazily (not at module-load time) so tests and the
 * create-admin-style one-off scripts don't need every var set just to import this module.
 *
 * odoo/batchSize/dbChunkSize/pythonBin/pythonDir/inputDir/outputDir/buildPythonEnv were removed
 * when pythonRunner.ts stopped spawning `python -m sales_pipeline.main` directly and started
 * calling the ETL Flask API (data/etl/api/app.py) over HTTP instead -- cPanel shared hosting can't
 * run this API process's own Python subprocesses reliably, so the Flask API spawns them itself,
 * reading its own env for those values (see data/etl/api/.env.example). This process no longer
 * needs Odoo credentials or pipeline tuning knobs at all, only the ETL_API_URL/ETL_API_KEY to call
 * that service.
 */
export interface EtlConfig {
  logDir: string;
  /** ETL_SCHEDULER_ENABLED (default false): this API process registers the cron schedules. True ONLY in the production
   * server's backend/.env -- a laptop or any other copy of the app never starts an ETL run by itself. */
  schedulerEnabled: boolean;
  /** ETL_WORKER_ENABLED (default false): `npm run etl:worker` consumes the queue and runs jobs. Off, it stays up idle
   * (no restart loop in Docker) and runs nothing. True ONLY on the production server. */
  workerEnabled: boolean;
  /** ETL_SCHEDULER_OFF_OK=true: this machine (a laptop, staging) runs no ETL ON PURPOSE. Without it, a production build
   * (NODE_ENV=production) with either switch off warns loudly -- see etlScheduleWarning. Never set on the server. */
  schedulerOffAcknowledged: boolean;
  schedule: {
    /** The 30-minute refresh (ETL job refresh_30m: the modules in data/etl ETL_REFRESH_MODULES). Every
     * ETL_REFRESH_INTERVAL_MINUTES (default 30; a divisor of 60, so the ticks fall on :00 / :30), or the explicit
     * ETL_SCHEDULE_REFRESH_CRON. A tick that falls in the same minute as the full refresh or the sales schedule yields
     * to it. */
    refreshCron: string;
    refreshEnabled: boolean;
    refreshIntervalMinutes: number;
    incrementalCron: string;
    incrementalEnabled: boolean;
    fullCron: string;
    fullEnabled: boolean;
    /** Daily receivables snapshot (job finance_receivables alone): 15:00. OFF by default since the 30-minute refresh
     * runs receivables + collections; turn it back on (ETL_SCHEDULE_FINANCE_ENABLED=true) only if finance is taken out of
     * ETL_REFRESH_MODULES, or to roll back. The nightly full refresh (full_all) takes a snapshot too. */
    financeCron: string;
    financeEnabled: boolean;
    /** NPS Score refresh, once a night as a full reload (decision 2026-10-19): 02:00 by default. The nightly full_all
     * already ends with process_nps, so this own schedule is registered ONLY when the full schedule is off (see
     * npsRefresh) -- process_nps never runs twice a night. Off unless ETL_SCHEDULE_PROCESS_NPS_ENABLED=true -- set it
     * together with the ETL's NPS_ENABLED. */
    processNpsCron: string;
    processNpsEnabled: boolean;
    /** Phase B: the sales build from the Odoo mirror (job sales_build, queue etl-long). Seconds when nothing changed. */
    salesBuildCron: string;
    salesBuildEnabled: boolean;
    /** IANA zone every cron expression is read in: ETL_SCHEDULE_TIMEZONE, else APP_TIMEZONE (default
     * Africa/Tripoli) -- never the process's own zone, which is UTC in a container without TZ. The displayed
     * "next run" uses the same zone, so the two always agree. */
    timezone: string;
  };
  redis: {
    host: string;
    port: number;
  };
  etlApi: {
    url: string;
    apiKey: string;
    pollIntervalMs: number;
  };
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * Resolves relative to backend/ (the cwd every etl command/worker/server process runs from), so
 * ETL_LOG_DIR=./logs/etl in .env means exactly what it looks like regardless of how the process
 * was launched.
 */
function resolveFromBackend(relativeOrAbsolute: string): string {
  return path.isAbsolute(relativeOrAbsolute)
    ? relativeOrAbsolute
    : path.resolve(process.cwd(), relativeOrAbsolute);
}

/** The refresh interval in minutes: a divisor of 60 between 5 and 60 (so `*\/N` ticks at fixed minutes every hour),
 * else the 30-minute default. */
export function refreshIntervalMinutes(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 5 && n <= 60 && 60 % n === 0 ? n : 30;
}

export function cronForInterval(minutes: number): string {
  return minutes === 60 ? '0 * * * *' : `*/${minutes} * * * *`;
}

export function getEtlConfig(): EtlConfig {
  const interval = refreshIntervalMinutes(process.env.ETL_REFRESH_INTERVAL_MINUTES);
  return {
    logDir: resolveFromBackend(process.env.ETL_LOG_DIR || './logs/etl'),
    schedulerEnabled: bool('ETL_SCHEDULER_ENABLED', false),
    workerEnabled: bool('ETL_WORKER_ENABLED', false),
    schedulerOffAcknowledged: bool('ETL_SCHEDULER_OFF_OK', false),
    schedule: {
      refreshCron: process.env.ETL_SCHEDULE_REFRESH_CRON?.trim() || cronForInterval(interval),
      refreshEnabled: bool('ETL_SCHEDULE_REFRESH_ENABLED', true),
      refreshIntervalMinutes: interval,
      incrementalCron: process.env.ETL_SCHEDULE_INCREMENTAL_CRON || '50 8,11,14,17,20 * * *',
      incrementalEnabled: bool('ETL_SCHEDULE_INCREMENTAL_ENABLED', true),
      fullCron: process.env.ETL_SCHEDULE_FULL_CRON || '0 2 * * *',
      fullEnabled: bool('ETL_SCHEDULE_FULL_ENABLED', true),
      financeCron: process.env.ETL_SCHEDULE_FINANCE_CRON || '0 15 * * *',
      financeEnabled: bool('ETL_SCHEDULE_FINANCE_ENABLED', false),
      processNpsCron: process.env.ETL_SCHEDULE_PROCESS_NPS_CRON || '0 2 * * *',
      processNpsEnabled: bool('ETL_SCHEDULE_PROCESS_NPS_ENABLED', false),
      // 10 minutes after each 30-minute refresh tick (which brings the Odoo mirror up to date). Off by default: set true
      // with ETL_SALES_MODE=shadow or incremental (data/etl/.env); in legacy mode the job ends at once ("skipped").
      salesBuildCron: process.env.ETL_SCHEDULE_SALES_BUILD_CRON || '10,40 * * * *',
      salesBuildEnabled: bool('ETL_SCHEDULE_SALES_BUILD_ENABLED', false),
      timezone: process.env.ETL_SCHEDULE_TIMEZONE?.trim() || getAppTimezone(),
    },
    redis: {
      host: process.env.REDIS_HOST || 'localhost',
      port: Number(process.env.REDIS_PORT ?? 6379),
    },
    etlApi: {
      url: process.env.ETL_API_URL || '',
      apiKey: process.env.ETL_API_KEY || '',
      pollIntervalMs: Number(process.env.ETL_API_POLL_INTERVAL_MS ?? 1000),
    },
  };
}

/**
 * How the nightly NPS Score refresh (process_nps, a full reload) runs -- exactly once a night:
 *   full_all  the full schedule is on: process_nps is the last step of the nightly full_all (after sales, under the
 *             same ETL lock, so it never competes with sales or finance); its own schedule is not registered
 *   own       the full schedule is off and ETL_SCHEDULE_PROCESS_NPS_ENABLED=true: process_nps alone at processNpsCron
 *   off       neither
 * The ETL Control Center "NPS Score" run-now button works in every case.
 */
export function npsRefresh(schedule: EtlConfig['schedule']): { via: 'full_all' | 'own' | 'off'; cron: string | null } {
  if (schedule.fullEnabled) return { via: 'full_all', cron: schedule.fullCron };
  if (schedule.processNpsEnabled) return { via: 'own', cron: schedule.processNpsCron };
  return { via: 'off', cron: null };
}

/**
 * Fail-safe for the server-only switches: a production build (NODE_ENV=production) where the scheduler or the worker is
 * off, and that has not said so on purpose (ETL_SCHEDULER_OFF_OK=true), gets this message -- logged as an error at
 * startup and shown as a red banner in the ETL Control Center -- so a forgotten .env line on the server can never drop
 * the 02:00 full refresh silently. null = nothing to warn about.
 */
export function etlScheduleWarning(config: EtlConfig = getEtlConfig(), nodeEnv = process.env.NODE_ENV): string | null {
  if (nodeEnv !== 'production' || config.schedulerOffAcknowledged) return null;
  const off = [
    !config.schedulerEnabled && 'ETL_SCHEDULER_ENABLED',
    !config.workerEnabled && 'ETL_WORKER_ENABLED',
  ].filter(Boolean);
  if (!off.length) return null;
  return `No ETL schedule is running on this server: ${off.join(' and ')} ${off.length > 1 ? 'are' : 'is'} not true in backend/.env, `
    + 'so the 30-minute, sales and 02:00 full refreshes do not run. Add the line(s), then recreate backend and etl-worker '
    + '(docker compose up -d backend etl-worker). On a laptop or staging copy that must not run ETL, set ETL_SCHEDULER_OFF_OK=true.';
}
