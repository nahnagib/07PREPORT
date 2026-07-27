import { Queue } from 'bullmq';
import { getEtlConfig } from '../config/etlConfig';
import { etlLogger } from '../services/etlLogger';
import {
  createQueuedRun,
  EtlLoadMode,
  EtlMode,
  EtlOutputMode,
  EtlTriggerSource,
  finishRun,
  hasActiveEtlRun,
  setRunJobId,
} from '../services/etlRunTracker';

/**
 * One BullMQ queue for every ETL job type (full run, and the today-aliased per-module commands --
 * see commands/*.ts). Future sources (SAP, CSV, API imports, ...) reuse this same queue with a new
 * job `name` rather than needing their own queue/connection plumbing.
 */
let queue: Queue | null = null;

function connection() {
  const config = getEtlConfig();
  return { host: config.redis.host, port: config.redis.port };
}

export function getEtlQueue(): Queue {
  if (!queue) {
    queue = new Queue('etl', { connection: connection() });
    // An unhandled 'error' event on a Node EventEmitter is fatal (crashes the process) -- without
    // this listener, Redis being unreachable (e.g. not started yet in local dev) would take down
    // the whole API process, not just the ETL scheduling feature.
    // err.code/err.stack are logged alongside err.message -- some ioredis/BullMQ error types carry
    // no useful message, and message-only logging then looks like a silently-swallowed error.
    queue.on('error', (err) =>
      etlLogger.error('ETL queue connection error', { error: err.message, code: (err as NodeJS.ErrnoException).code, stack: err.stack }),
    );
  }
  return queue;
}

/** BullMQ's underlying ioredis connection retries forever with no effective per-command cap
 * (tested: neither a bounded `maxRetriesPerRequest` nor the default retry strategy makes a
 * command reject on its own), so `queue.add()` against an unreachable Redis never resolves *or*
 * rejects -- it just hangs. Left unguarded, that leaves the caller's tracking row (created by
 * `createQueuedRun` before this is called) stuck in 'queued' forever, since the code that marks
 * it 'failed' below never runs. This timeout is purely an application-level escape hatch around
 * that one call; it doesn't touch the Queue's own (intentionally unbounded) reconnect behavior,
 * so the connection still recovers on its own once Redis comes back for the *next* enqueue.
 */
const ENQUEUE_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms (queue unreachable)`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

const WORKER_PROBE_TIMEOUT_MS = 5_000;

/**
 * Is there actually an `etl:worker` process (etl/commands/worker.ts) connected and consuming this
 * queue right now? Redis being reachable and a job being enqueued don't imply this -- the worker
 * is a separate long-running process from the API server (see worker.ts's header), started
 * separately, and nothing before this restarted it or noticed it was gone. If it's crashed, never
 * deployed, or still starting up, jobs queue in Redis exactly as if everything were fine and just
 * sit there: `hasActiveEtlRun()` only checks the DB row's status, not whether anything will ever
 * pick the job up, so a run can go "Queued" and never progress with no error anywhere -- the
 * "queued 34 minutes, 0 log lines" failure mode this closes off. `getWorkers()` is BullMQ's own
 * CLIENT LIST-backed API for "which worker processes are currently connected to this queue" and
 * is the only source of truth for this that isn't guessing from job state.
 */
export async function hasActiveWorker(): Promise<boolean> {
  try {
    const workers = await withTimeout(getEtlQueue().getWorkers(), WORKER_PROBE_TIMEOUT_MS, 'getWorkers()');
    return workers.length > 0;
  } catch (err) {
    etlLogger.error('ETL worker liveness check failed; assuming no worker is available', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export interface EtlJobData {
  mode: EtlMode;
  loadMode: EtlLoadMode;
  outputMode: EtlOutputMode;
  fast?: boolean;
  extraArgs?: string[];
  label: string;
  triggerSource: EtlTriggerSource;
  triggeredByUserId?: number | null;
  triggeredByUserName?: string | null;
  /** The etl_job_runs.id this job corresponds to -- also used as the BullMQ job id itself, so
   * the two are always the same value and trivially correlatable (see runPipelineJob.ts). */
  runId: number;
}

export { hasActiveEtlRun };

export interface EnqueuePipelineRunInput {
  mode: EtlMode;
  loadMode: EtlLoadMode;
  outputMode: EtlOutputMode;
  fast?: boolean;
  extraArgs?: string[];
  label: string;
  triggerSource: EtlTriggerSource;
  triggeredByUserId?: number | null;
  triggeredByUserName?: string | null;
}

/**
 * The one place a run gets both (a) its etl_job_runs tracking row and (b) its BullMQ job --
 * called by the scheduler, the CLI commands, and the Control Center's start-* endpoints alike, so
 * every run is tracked uniformly regardless of who triggered it. The tracking row is created
 * *before* the job is queued, so the concurrency guard (`hasActiveEtlRun`) is correct even for a
 * job that's still waiting because no worker is running yet -- there's no gap a second start
 * request could slip through.
 *
 * Two retries with backoff on the BullMQ side -- covers the subprocess dying outright (network
 * down for the whole run, Python crash) on top of the vendored pipeline's own per-RPC-call retry
 * logic. A deliberately *cancelled* run is not retried (see runPipelineJob.ts).
 */
/** BullMQ rejects a custom jobId that parses as a plain integer ("Custom Id cannot be
 * integers") -- etl_job_runs.id is an AUTO_INCREMENT int, so it needs a non-numeric prefix to be
 * usable as a job id. */
function toBullJobId(runId: number): string {
  return `etl-${runId}`;
}

export async function enqueuePipelineRun(input: EnqueuePipelineRunInput) {
  const runId = await createQueuedRun({
    mode: input.mode,
    loadMode: input.loadMode,
    outputMode: input.outputMode,
    triggerSource: input.triggerSource,
    triggeredByUserId: input.triggeredByUserId,
    triggeredByUserName: input.triggeredByUserName,
  });
  const jobId = toBullJobId(runId);
  // Persisted now, not after `queue.add`, so /admin/etl/cancel can always find the job id even if
  // it's called in the brief window before the job is actually added.
  await setRunJobId(runId, jobId);

  const data: EtlJobData = {
    mode: input.mode,
    loadMode: input.loadMode,
    outputMode: input.outputMode,
    fast: input.fast,
    extraArgs: input.extraArgs,
    label: input.label,
    triggerSource: input.triggerSource,
    triggeredByUserId: input.triggeredByUserId,
    triggeredByUserName: input.triggeredByUserName,
    runId,
  };

  try {
    const job = await withTimeout(
      getEtlQueue().add(input.label, data, {
        jobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 200 },
      }),
      ENQUEUE_TIMEOUT_MS,
      'ETL queue add()',
    );
    return { job, runId };
  } catch (err) {
    // Without this, a BullMQ/Redis failure here (e.g. Redis unreachable) would leave the row
    // permanently stuck as 'queued' -- no worker will ever pick up a job that was never added,
    // so hasActiveEtlRun() would wrongly block every future run from then on.
    const message = err instanceof Error ? err.message : String(err);
    await finishRun(runId, { status: 'failed', exitCode: null, errorMessage: `Failed to queue job: ${message}` });
    throw err;
  }
}
