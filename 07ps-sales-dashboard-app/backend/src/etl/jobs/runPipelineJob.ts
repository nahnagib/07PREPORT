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

const STAGE_PATTERN = /Pipeline step (\S+) (started|completed|failed)/;

async function processEtlJob(job: Job<EtlJobData>): Promise<void> {
  const { loadMode, outputMode, fast, extraArgs, label, runId } = job.data;
  etlLogger.info('Job picked up by worker', { jobId: job.id, runId, label, attempt: job.attemptsMade + 1 });

  await markRunStarted(runId);
  await job.updateProgress({ stage: 'starting', stageStatus: 'started' });
  const pipelineRunLogBaseline = await getMaxPipelineRunLogId();

  const controller = new AbortController();
  activeControllers.set(String(job.id), controller);

  // Set right before/with each of the three finishRun() calls below (cancelled / exitCode!==0 /
  // success) -- lets the catch block tell "a terminal status was already recorded" apart from "we
  // never got that far", without which it would either double-finish a row that already has a good
  // error message (clobbering result.stderrTail with a generic rethrown message) or -- the actual
  // bug this closes -- leave a row stuck at markRunStarted's 'running' forever whenever
  // runPipeline() itself throws before ever producing a result (ETL API unreachable, DNS failure,
  // a stale 409 from a stuck Flask-side tracker). That gap is exactly how run ids 59/60 ended up
  // wedged at status='running' with hasActiveEtlRun() blocking every subsequent run.
  let recordedTerminalStatus = false;

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
        // Every line is persisted (previously only stage boundaries/summaries/errors survived an
        // isSignificantLine() filter) -- the Control Center's log view is meant to match the full
        // detail of a raw run_pipeline.py log file (per-batch fetch progress, warnings, validation
        // tables, tracebacks included), not a curated summary. See docs/commands.md for the raw log
        // file's format this now mirrors.
        void job.log(line);
      },
    });

    // Only sql/both runs ever touch MySQL (see data/etl/config/settings.py's require_database
    // logic) -- attempted for both success and failure so a failed run still surfaces whatever
    // partial counts the pipeline itself recorded before it failed.
    const correlated =
      outputMode !== 'excel' ? await correlateLatestPipelineRunLog(pipelineRunLogBaseline) : null;

    if (result.cancelled) {
      recordedTerminalStatus = true;
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
      recordedTerminalStatus = true;
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

    recordedTerminalStatus = true;
    await finishRun(runId, {
      status: 'success',
      exitCode: result.exitCode,
      pipelineRunLogId: correlated?.pipelineRunLogId,
      odooExtractCount: correlated?.odooExtractCount,
      dbLoadedCount: correlated?.dbLoadedCount,
      qaIssuesCount: correlated?.qaIssuesCount,
    });
  } catch (err) {
    // Only reached for (a) the exitCode!==0 rethrow above, which already recorded its own more
    // detailed finishRun and just needs to keep propagating for BullMQ's retry/backoff, or (b)
    // something that escaped all three of the explicit finishRun calls above entirely -- most
    // notably runPipeline() itself throwing before ever producing a result. Guarding on
    // recordedTerminalStatus is what tells those apart: without it, case (a) would get finished
    // twice, clobbering result.stderrTail with this generic message.
    if (!recordedTerminalStatus) {
      await finishRun(runId, {
        status: 'failed',
        exitCode: null,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
    throw err;
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
