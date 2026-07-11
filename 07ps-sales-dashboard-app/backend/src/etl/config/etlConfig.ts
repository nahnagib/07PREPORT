import path from 'path';

/**
 * Single place the ETL module reads process.env from -- every other file under src/etl imports
 * from here instead of touching process.env directly, mirroring how src/db/pool.ts centralizes
 * the MySQL connection config. Values are read lazily (not at module-load time) so tests and the
 * create-admin-style one-off scripts don't need every var set just to import this module.
 */
export interface EtlConfig {
  odoo: {
    url: string;
    db: string;
    user: string;
    apiKey: string;
    timeoutSeconds: number;
    maxRetries: number;
  };
  batchSize: number;
  dbChunkSize: number;
  pythonBin: string;
  pythonDir: string;
  inputDir: string;
  outputDir: string;
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
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * Resolves relative to backend/ (the cwd every etl command/worker/server process runs from), so
 * ETL_PYTHON_DIR=../data/etl in .env means exactly what it looks like regardless of how the
 * process was launched.
 */
function resolveFromBackend(relativeOrAbsolute: string): string {
  return path.isAbsolute(relativeOrAbsolute)
    ? relativeOrAbsolute
    : path.resolve(process.cwd(), relativeOrAbsolute);
}

/**
 * Node's child_process.spawn resolves a relative executable path against the *parent* process's
 * cwd, not the `cwd` option passed to spawn (which only affects the child's own working
 * directory) -- so a bare relative ETL_PYTHON_BIN like "../data/etl/.venv/Scripts/python.exe"
 * would fail with ENOENT once pythonRunner.ts sets cwd to the pipeline directory. Bare commands
 * like "python" (meant to be resolved via PATH) are left untouched; anything containing a path
 * separator is resolved to an absolute path up front.
 */
function resolvePythonBin(value: string): string {
  if (!/[\\/]/.test(value)) return value;
  return resolveFromBackend(value);
}

export function getEtlConfig(): EtlConfig {
  return {
    odoo: {
      url: process.env.ODOO_URL ?? '',
      db: process.env.ODOO_DB ?? '',
      user: process.env.ODOO_USER ?? '',
      apiKey: process.env.ODOO_API_KEY ?? '',
      timeoutSeconds: Number(process.env.ODOO_TIMEOUT_SECONDS ?? 60),
      maxRetries: Number(process.env.ODOO_MAX_RETRIES ?? 5),
    },
    batchSize: Number(process.env.ETL_BATCH_SIZE ?? 500),
    dbChunkSize: Number(process.env.ETL_DB_CHUNKSIZE ?? 5000),
    pythonBin: resolvePythonBin(process.env.ETL_PYTHON_BIN || 'python'),
    pythonDir: resolveFromBackend(process.env.ETL_PYTHON_DIR || '../data/etl'),
    inputDir: resolveFromBackend(process.env.ETL_INPUT_DIR || '../data/etl/Input'),
    outputDir: resolveFromBackend(process.env.ETL_OUTPUT_DIR || '../data/etl/Exports'),
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
  };
}

/**
 * Env vars forwarded into the vendored pipeline's subprocess, translated from this app's
 * ETL_, ODOO_, and DB_ prefixed names into the exact names data/etl/config/settings.py's
 * Settings.from_env() expects. Reuses the same DB_ values backend/.env already has for MySQL --
 * there is exactly one place credentials live; nothing is duplicated into a second .env on disk.
 */
export function buildPythonEnv(config: EtlConfig): Record<string, string | undefined> {
  return {
    ...process.env,
    // Without this, the child's stdout/stderr defaults to the Windows console codepage (often
    // cp1252), which mangles the pipeline's own UTF-8 log messages (e.g. arrows/non-ASCII product
    // names) once Node re-encodes the captured bytes as UTF-8 for the orchestration log.
    PYTHONIOENCODING: 'utf-8',
    ODOO_URL: config.odoo.url,
    ODOO_DB: config.odoo.db,
    ODOO_USER: config.odoo.user,
    ODOO_API_KEY: config.odoo.apiKey,
    ODOO_TIMEOUT_SECONDS: String(config.odoo.timeoutSeconds),
    ODOO_MAX_RETRIES: String(config.odoo.maxRetries),
    BATCH_SIZE: String(config.batchSize),
    DB_CHUNKSIZE: String(config.dbChunkSize),
    INPUT_DIR: config.inputDir,
    OUTPUT_DIR: config.outputDir,
    // DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD are already present in process.env from
    // backend/.env (loaded via dotenv in server.ts/commands) and match the names settings.py
    // expects verbatim, so they pass through via the `...process.env` spread above unchanged.
    DB_TYPE: 'mysql',
  };
}
