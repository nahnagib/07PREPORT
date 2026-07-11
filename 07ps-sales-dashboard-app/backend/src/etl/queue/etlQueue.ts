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
    queue.on('error', (err) => etlLogger.error('ETL queue connection error', { error: err.message }));
  }
  return queue;
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
    const job = await getEtlQueue().add(input.label, data, {
      jobId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 200 },
    });
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
