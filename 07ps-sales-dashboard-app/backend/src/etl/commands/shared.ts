import 'dotenv/config';
import { enqueuePipelineRun, getEtlQueue } from '../queue/etlQueue';
import { EtlMode } from '../services/etlRunTracker';
import { etlLogger } from '../services/etlLogger';
import { LoadMode, OutputMode, runPipeline } from '../services/pythonRunner';

export interface CommandOptions {
  /** CLI label distinguishing which artisan-style command triggered this run (etl:run vs.
   * etl:customers/etl:sales/etl:inventory/etl:products) for logging -- see the module-level
   * comment in customers.ts for why these are aliases today, not independent sub-pipelines. */
  label: string;
}

function parseArgv(argv: string[]) {
  return {
    sync: argv.includes('--sync'),
    full: argv.includes('--full'),
  };
}

/**
 * Shared entry point every etl:* command (except etl:worker) calls. Default behavior enqueues a
 * BullMQ job (consistent with "the scheduler should dispatch jobs instead of blocking" -- a
 * manually-run command gets the same treatment). `--sync` runs inline instead, for local
 * development without Redis/a worker running. Queued (non-sync) CLI runs are tracked in
 * etl_job_runs with trigger_source='development', visible in the ETL Control Center's history
 * alongside scheduled and admin-UI-triggered runs; `--sync` runs bypass the queue entirely and
 * are NOT tracked there (same as always -- only in the pipeline's own pipeline_run_log).
 */
export async function runCommand({ label }: CommandOptions): Promise<void> {
  const { sync, full } = parseArgv(process.argv.slice(2));
  const loadMode: LoadMode = full ? 'full' : 'incremental';
  const mode: EtlMode = full ? 'full' : 'incremental';

  if (sync) {
    etlLogger.info(`Running ETL synchronously (--sync)`, { label, loadMode });
    const result = await runPipeline({
      loadMode,
      outputMode: 'sql',
      fast: !full,
      label: `${label}-sync`,
    });
    if (result.exitCode !== 0) {
      // eslint-disable-next-line no-console
      console.error(`ETL run failed (exit code ${result.exitCode}). See logs/etl/etl.log for details.`);
      process.exitCode = 1;
    }
    return;
  }

  const { job, runId } = await enqueuePipelineRun({
    mode,
    loadMode,
    outputMode: 'sql',
    fast: !full,
    label,
    triggerSource: 'development',
  });
  etlLogger.info(`Enqueued ETL job`, { label, jobId: job.id, runId, loadMode });
  // eslint-disable-next-line no-console
  console.log(`Enqueued job ${job.id} (${label}). Run "npm run etl:worker" to process it, or pass --sync to run inline.`);

  // Without this, the open Redis connection keeps the CLI process alive indefinitely instead of
  // exiting once the job is queued (the worker process is the one meant to stay alive/connected).
  await getEtlQueue().close();
}

export interface ModeCommandOptions {
  /** Distinguishes this invocation in the orchestration log (see runCommand's label doc). */
  label: string;
  mode: EtlMode;
  loadMode: LoadMode;
  outputMode: OutputMode;
  /** Skips Excel/QA exports and runs only scoped SQL validations -- never set this for
   * outputMode 'excel'/'both', it would suppress the very output being asked for. */
  fast?: boolean;
}

/**
 * Used by the explicit-mode commands (full.ts/incremental.ts/sql.ts/excel.ts) -- unlike
 * runCommand above, loadMode/outputMode/fast are fixed by the caller rather than derived from
 * argv, so each command represents one specific, predictable combination someone can read off
 * the command's own file. Still supports `--sync` for an inline run without Redis/a worker.
 */
export async function runModeCommand({ label, mode, loadMode, outputMode, fast }: ModeCommandOptions): Promise<void> {
  const { sync } = parseArgv(process.argv.slice(2));

  if (sync) {
    etlLogger.info(`Running ETL synchronously (--sync)`, { label, loadMode, outputMode });
    const result = await runPipeline({ loadMode, outputMode, fast, label: `${label}-sync` });
    if (result.exitCode !== 0) {
      // eslint-disable-next-line no-console
      console.error(`ETL run failed (exit code ${result.exitCode}). See logs/etl/etl.log for details.`);
      process.exitCode = 1;
    }
    return;
  }

  const { job, runId } = await enqueuePipelineRun({
    mode,
    loadMode,
    outputMode,
    fast,
    label,
    triggerSource: 'development',
  });
  etlLogger.info(`Enqueued ETL job`, { label, jobId: job.id, runId, loadMode, outputMode });
  // eslint-disable-next-line no-console
  console.log(`Enqueued job ${job.id} (${label}). Run "npm run etl:worker" to process it, or pass --sync to run inline.`);
  await getEtlQueue().close();
}
