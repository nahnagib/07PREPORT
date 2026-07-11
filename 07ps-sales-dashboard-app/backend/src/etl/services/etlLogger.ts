import fs from 'fs';
import path from 'path';
import winston from 'winston';
import { getEtlConfig } from '../config/etlConfig';

/**
 * Orchestration-level ETL log -- job queued/started/finished/failed/retrying, subprocess exit
 * codes, stdout/stderr tails. This is deliberately NOT a duplicate of the vendored pipeline's own
 * run history: detailed per-run metrics (start/end time, duration, records extracted/loaded,
 * per-table row counts) already live in MySQL via pipeline_run_log/pipeline_run_audit, written by
 * the pipeline itself regardless of what invokes it. This log answers a different question --
 * "what did the Node scheduler/queue/worker do" -- for troubleshooting the orchestration layer.
 */
const config = getEtlConfig();
fs.mkdirSync(config.logDir, { recursive: true });

export const etlLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const metaKeys = Object.keys(meta).filter((k) => k !== 'service');
      const metaStr = metaKeys.length
        ? ' ' + JSON.stringify(Object.fromEntries(metaKeys.map((k) => [k, meta[k]])))
        : '';
      return `${timestamp} | ${String(level).toUpperCase()} | ${message}${metaStr}`;
    }),
  ),
  transports: [
    new winston.transports.File({ filename: path.join(config.logDir, 'etl.log'), maxsize: 10 * 1024 * 1024, maxFiles: 5 }),
    new winston.transports.Console(),
  ],
});
