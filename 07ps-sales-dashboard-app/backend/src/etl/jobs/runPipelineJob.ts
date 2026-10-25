import { Job, Worker } from 'bullmq';
import { getEtlConfig } from '../config/etlConfig';
import { EtlJobData } from '../queue/etlQueue';
import { subscribeToCancelRequests } from '../queue/etlControlChannel';
import {
  correlateLatestEtlRun,
  finishRun,
  getMaxEtlRunId,
  markRunRetrying,
  markRunStarted,
} from '../services/etlRunTracker';
import { etlLogger } from '../services/etlLogger';
import { ETL_EXIT_LOCKED, ETL_EXIT_PARTIAL, runPipeline } from '../services/pythonRunner';

/** In-flight jobs on THIS worker process, keyed by BullMQ job id (== etl_job_runs.id, see
 * etlQueue.ts). Cancellation arrives over Redis pub/sub (etlControlChannel.ts) since the API
 * process that receives the "Cancel" click is a different OS process from this one. */
const activeControllers = new Map<string, AbortController>();

const STAGE_PATTERN = /Pipeline step (\S+) (started|completed|failed)/;

async function processEtlJob(job: Job<EtlJobData>): Promise<void> {
  const { job: platformJob, loadMode, outputMode, fast, extraArgs, label, runId } = job.data;
  etlLogger.info('Job picked up by worker', { jobId: job.id, runId, label, attempt: job.attemptsMade + 1 });

  await markRunStarted(runId);
  await job.updateProgress({ stage: 'starting', stageStatus: 'started' });
  const pipelineRunLogBaseline = await getMaxEtlRunId();

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

  // BullMQ re-runs a failed job (attempts/backoff, see enqueuePipelineRun). While a retry is still
  // pending the run must keep holding the ETL lock instead of reading as 'failed' -- see
  // markRunRetrying's header -- so only the final attempt records a terminal 'failed'.
  const willRetry = job.attemptsMade + 1 < (job.opts.attempts ?? 1);

  try {
    const result = await runPipeline({
      job: platformJob,
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
      outputMode !== 'excel' ? await correlateLatestEtlRun(pipelineRunLogBaseline) : null;

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

    // Partial (exit 3): the run loaded but an optional step failed (finance in main/full_all). Not retried by BullMQ:
    // retrying would redo the 20-minute sales load; the next scheduled run tries finance again anyway.
    if (result.exitCode === ETL_EXIT_PARTIAL) {
      recordedTerminalStatus = true;
      await finishRun(runId, {
        status: 'partial',
        exitCode: result.exitCode,
        errorMessage: correlated?.errorMessage || result.stderrTail || 'A step of the run failed (see the run steps).',
        pipelineRunLogId: correlated?.pipelineRunLogId,
        odooExtractCount: correlated?.odooExtractCount,
        dbLoadedCount: correlated?.dbLoadedCount,
        qaIssuesCount: correlated?.qaIssuesCount,
      });
      etlLogger.warn('Job finished partially', { jobId: job.id, runId, label, error: correlated?.errorMessage });
      return;
    }

    // Lock busy (exit 4): another ETL run (shell, CLI, a second API) is writing; this trigger is dropped, not retried.
    if (result.exitCode === ETL_EXIT_LOCKED) {
      recordedTerminalStatus = true;
      await finishRun(runId, {
        status: 'skipped',
        exitCode: result.exitCode,
        errorMessage: 'Skipped: another ETL run was already running (it holds the ETL lock). Nothing was written.',
      });
      etlLogger.info('Job skipped -- another ETL run holds the lock', { jobId: job.id, runId, label });
      return;
    }

    if (result.exitCode !== 0) {
      recordedTerminalStatus = true;
      // The platform logger can write failures to stdout (including disabled jobs).
      const errorMessage = result.stderrTail || result.stdoutTail || correlated?.errorMessage ||
        'Pipeline exited non-zero with no captured output.';
      if (willRetry) {
        await markRunRetrying(runId, errorMessage);
      } else {
        await finishRun(runId, {
          status: 'failed',
          exitCode: result.exitCode,
          errorMessage,
          pipelineRunLogId: correlated?.pipelineRunLogId,
          odooExtractCount: correlated?.odooExtractCount,
          dbLoadedCount: correlated?.dbLoadedCount,
          qaIssuesCount: correlated?.qaIssuesCount,
        });
      }
      // Throwing is what makes BullMQ apply the queue's configured retry/backoff
      // (see enqueuePipelineRun in ../queue/etlQueue.ts) instead of silently swallowing the failure.
      throw new Error(
        `ETL run "${label}" exited with code ${result.exitCode} after ${result.durationMs}ms. ` +
          `error: ${errorMessage}`,
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
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (willRetry) {
        await markRunRetrying(runId, errorMessage);
      } else {
        await finishRun(runId, { status: 'failed', exitCode: null, errorMessage });
      }
    }
    throw err;
  } finally {
    activeControllers.delete(String(job.id));
  }
}

let cancelSubscribed = false;

/** Starts a BullMQ worker that actually executes ETL jobs -- this is the process that needs
 * Python on its PATH (see data/etl and pythonRunner.ts). commands/worker.ts starts one per queue: 'etl' (every job but
 * the sales build) and 'etl-long' (the sales build, LONG_QUEUE_JOBS), each one job at a time. */
export function startEtlWorker(queueName: string = 'etl'): Worker<EtlJobData> {
  const config = getEtlConfig();
  const worker = new Worker<EtlJobData>(queueName, processEtlJob, {
    connection: { host: config.redis.host, port: config.redis.port },
    concurrency: 1, // one job at a time per queue; the platform's per-module locks guard the shared tables
  });

  if (!cancelSubscribed) {
    cancelSubscribed = true; // one subscription serves every worker of this process (activeControllers is shared)
    subscribeToCancelRequests((jobId) => {
      const controller = activeControllers.get(jobId);
      if (controller) {
        etlLogger.info('Cancelling active ETL job', { jobId });
        controller.abort();
      } else {
        etlLogger.info('Cancel request for a job not active on this worker (ignored)', { jobId });
      }
    });
  }

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
