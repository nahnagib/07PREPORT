/**
 * `npm run etl:worker` -- the long-running process that actually executes ETL jobs (the API
 * process only enqueues them, see etl/scheduler/registerSchedules.ts). This is the one process
 * that needs Python + the vendored pipeline's dependencies on its PATH -- see docs/etl-deployment.md
 * and the `etl-worker` docker-compose service.
 */
import 'dotenv/config';
import { startEtlWorker } from '../jobs/runPipelineJob';
import { etlLogger } from '../services/etlLogger';

const worker = startEtlWorker();
etlLogger.info('ETL worker started, waiting for jobs...');

async function shutdown(signal: string) {
  etlLogger.info(`Received ${signal}, shutting down ETL worker gracefully...`);
  await worker.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
