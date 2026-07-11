import { Job, Worker } from 'bullmq';
import { getEtlConfig } from '../config/etlConfig';
import { EtlJobData } from '../queue/etlQueue';
import { subscribeToCancelRequests } from '../queue/etlControlChannel';
import {
  correlateLatestPipelineRunLog,
  finishRun,
  getMaxPipelineRunLogId,
  markRunStarted,
} from '../services/etlRunTracker';
import { etlLogger } from '../services/etlLogger';
import { runPipeline } from '../services/pythonRunner';

/** In-flight jobs on THIS worker process, keyed by BullMQ job id (== etl_job_runs.id, see
 * etlQueue.ts). Cancellation arrives over Redis pub/sub (etlControlChannel.ts) since the API
 * process that receives the "Cancel" click is a different OS process from this one. */
const activeControllers = new Map<string, AbortController>();

/** Lines forwarded into BullMQ's persisted job log (queue.getJobLogs) for the Control Center's
 * live log tail. A 30-60 minute run produces thousands of per-batch fetch lines -- only stage
 * boundaries, summaries, and errors are kept so the stored log stays small and useful. */
function isSignificantLine(line: string): boolean {
  return /Pipeline step|ERROR|Total duration|Final run summary|Output row counts|SQL output complete|Odoo extraction \w+ rows=|CRM validation summary|Rows (loaded|transformed|exported)/i.test(
    line,
  );
}

const STAGE_PATTERN = /Pipeline step (\S+) (started|completed|failed)/;

async function processEtlJob(job: Job<EtlJobData>): Promise<void> {
  const { loadMode, outputMode, fast, extraArgs, label, runId } = job.data;
  etlLogger.info('Job picked up by worker', { jobId: job.id, runId, label, attempt: job.attemptsMade + 1 });

  await markRunStarted(runId);
  await job.updateProgress({ stage: 'starting', stageStatus: 'started' });
  const pipelineRunLogBaseline = await getMaxPipelineRunLogId();

  const controller = new AbortController();
  activeControllers.set(String(job.id), controller);

  try {
    const result = await runPipeline({
      loadMode,
      outputMode,
      fast,
      extraArgs,
      label,
      signal: controller.signal,
      onLine: (line) => {
        const stageMatch = STAGE_PATTERN.exec(line);
        if (stageMatch) {
          void job.updateProgress({ stage: stageMatch[1], stageStatus: stageMatch[2] });
        }
        if (isSignificantLine(line)) {
          void job.log(line);
        }
      },
    });

    // Only sql/both runs ever touch MySQL (see data/etl/config/settings.py's require_database
    // logic) -- attempted for both success and failure so a failed run still surfaces whatever
    // partial counts the pipeline itself recorded before it failed.
    const correlated =
      outputMode !== 'excel' ? await correlateLatestPipelineRunLog(pipelineRunLogBaseline) : null;

    if (result.cancelled) {
      await finishRun(runId, {
        status: 'cancelled',
        exitCode: result.exitCode,
        pipelineRunLogId: correlated?.pipelineRunLogId,
        odooExtractCount: correlated?.odooExtractCount,
        dbLoadedCount: correlated?.dbLoadedCount,
        qaIssuesCount: correlated?.qaIssuesCount,
      });
      etlLogger.info('Job cancelled', { jobId: job.id, runId, label });
      // No throw -- a deliberate cancellation should not trigger BullMQ's retry/backoff.
      return;
    }

    if (result.exitCode !== 0) {
      await finishRun(runId, {
        status: 'failed',
        exitCode: result.exitCode,
        errorMessage: result.stderrTail || 'Pipeline exited non-zero with no captured output.',
        pipelineRunLogId: correlated?.pipelineRunLogId,
        odooExtractCount: correlated?.odooExtractCount,
        dbLoadedCount: correlated?.dbLoadedCount,
        qaIssuesCount: correlated?.qaIssuesCount,
      });
      // Throwing is what makes BullMQ apply the queue's configured retry/backoff
      // (see enqueuePipelineRun in ../queue/etlQueue.ts) instead of silently swallowing the failure.
      throw new Error(
        `ETL run "${label}" exited with code ${result.exitCode} after ${result.durationMs}ms. ` +
          `stderr tail: ${result.stderrTail || '(empty)'}`,
      );
    }

    await finishRun(runId, {
      status: 'success',
      exitCode: result.exitCode,
      pipelineRunLogId: correlated?.pipelineRunLogId,
      odooExtractCount: correlated?.odooExtractCount,
      dbLoadedCount: correlated?.dbLoadedCount,
      qaIssuesCount: correlated?.qaIssuesCount,
    });
  } finally {
    activeControllers.delete(String(job.id));
  }
}

/** Starts the BullMQ worker that actually executes ETL jobs -- this is the process that needs
 * Python on its PATH (see data/etl and pythonRunner.ts). Call once from commands/worker.ts. */
export function startEtlWorker(): Worker<EtlJobData> {
  const config = getEtlConfig();
  const worker = new Worker<EtlJobData>('etl', processEtlJob, {
    connection: { host: config.redis.host, port: config.redis.port },
    concurrency: 1, // the pipeline is not designed for concurrent runs against the same DB
  });

  subscribeToCancelRequests((jobId) => {
    const controller = activeControllers.get(jobId);
    if (controller) {
      etlLogger.info('Cancelling active ETL job', { jobId });
      controller.abort();
    } else {
      etlLogger.info('Cancel request for a job not active on this worker (ignored)', { jobId });
    }
  });

  worker.on('completed', (job) => {
    etlLogger.info('Job completed', { jobId: job.id, label: job.data.label });
  });
  worker.on('failed', (job, err) => {
    etlLogger.error('Job failed', {
      jobId: job?.id,
      label: job?.data.label,
      attempt: job ? job.attemptsMade : undefined,
      error: err.message,
    });
  });
  // Same rationale as etlQueue.ts's listener -- an unhandled 'error' here would crash the worker
  // process outright on a transient Redis blip instead of just logging and reconnecting.
  worker.on('error', (err) => etlLogger.error('ETL worker connection error', { error: err.message }));

  return worker;
}
