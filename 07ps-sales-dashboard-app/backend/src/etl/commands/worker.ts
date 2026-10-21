/**
 * `npm run etl:worker` -- the long-running process that actually executes ETL jobs (the API
 * process only enqueues them, see etl/scheduler/registerSchedules.ts). This is the one process
 * that needs Python + the vendored pipeline's dependencies on its PATH -- see docs/etl-deployment.md
 * and the `etl-worker` docker-compose service.
 */
import 'dotenv/config';
import { etlScheduleWarning, getEtlConfig } from '../config/etlConfig';
import { startEtlWorker } from '../jobs/runPipelineJob';
import { LONG_QUEUE_NAME } from '../queue/etlQueue';
import { etlLogger } from '../services/etlLogger';

// ETL_WORKER_ENABLED=true only on the production server. Anywhere else the process stays up but idle -- it never
// consumes the queue -- so `docker compose up` on a laptop cannot run an ETL job, and Docker does not restart-loop it.
// Two queues, one worker each: 'etl' and 'etl-long' (the sales build from the Odoo mirror, which must not hold up the
// 30-minute refresh).
const workers = getEtlConfig().workerEnabled ? [startEtlWorker('etl'), startEtlWorker(LONG_QUEUE_NAME)] : [];
if (workers.length) {
  etlLogger.info('ETL worker started (queues etl and etl-long), waiting for jobs...');
} else {
  const warning = etlScheduleWarning();
  if (warning) etlLogger.error(`ETL worker idle -- ${warning}`);
  else etlLogger.info('ETL worker idle: ETL_WORKER_ENABLED is not true on this machine (only the production server runs ETL jobs)');
  setInterval(() => undefined, 60 * 60 * 1000);
}

async function shutdown(signal: string) {
  etlLogger.info(`Received ${signal}, shutting down ETL worker gracefully...`);
  await Promise.all(workers.map((w) => w.close()));
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
