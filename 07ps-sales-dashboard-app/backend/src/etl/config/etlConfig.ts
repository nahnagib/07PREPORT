import path from 'path';

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
  schedule: {
    incrementalCron: string;
    incrementalEnabled: boolean;
    fullCron: string;
    fullEnabled: boolean;
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

export function getEtlConfig(): EtlConfig {
  return {
    logDir: resolveFromBackend(process.env.ETL_LOG_DIR || './logs/etl'),
    schedule: {
      incrementalCron: process.env.ETL_SCHEDULE_INCREMENTAL_CRON || '50 8,11,14,17,20 * * *',
      incrementalEnabled: bool('ETL_SCHEDULE_INCREMENTAL_ENABLED', true),
      fullCron: process.env.ETL_SCHEDULE_FULL_CRON || '0 2 * * *',
      fullEnabled: bool('ETL_SCHEDULE_FULL_ENABLED', true),
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
