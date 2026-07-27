import axios, { AxiosInstance } from 'axios';
import { getEtlConfig } from '../config/etlConfig';
import { etlLogger } from './etlLogger';

export type LoadMode = 'full' | 'incremental';
export type OutputMode = 'sql' | 'excel' | 'both';

export interface PipelineRunOptions {
  loadMode: LoadMode;
  outputMode?: OutputMode;
  /** Skip Excel/QA exports and run only the scoped SQL validations -- what every scheduled
   * incremental run has used in production (see the vendored scheduler.py this replaces). */
  fast?: boolean;
  /** Passed straight through to `python -m sales_pipeline.main` for anything not covered above
   * (e.g. --odoo-cutoff-utc, --validation-baseline). */
  extraArgs?: string[];
  /** Labels this invocation in the orchestration log (e.g. "scheduled-incremental", "customers"
   * alias, "manual"). Does not change what the pipeline actually runs -- see commands/*.ts. */
  label?: string;
  /** Aborting requests cancellation of the ETL API job (see data/etl/api/app.py's
   * POST /etl/jobs/<id>/cancel) -- used by the ETL Control Center's Cancel button, see
   * etl/queue/etlControlChannel.ts. */
  signal?: AbortSignal;
  /** Called for every non-empty stdout/stderr line, in order, as the ETL API reports them --
   * used by runPipelineJob.ts to forward stage/summary lines into BullMQ job progress/logs
   * without needing to re-parse the orchestration log file. */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
}

export interface PipelineRunResult {
  exitCode: number;
  /** True when the run ended because `signal` was aborted, not because the pipeline itself
   * failed -- callers should record this as "cancelled", not "failed" (no BullMQ retry either). */
  cancelled: boolean;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
}

interface RemoteLogLine {
  index: number;
  stream: 'stdout' | 'stderr';
  text: string;
}

type RemoteJobStatus = {
  jobId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  exitCode: number | null;
  durationMs: number | null;
  logLineCount: number;
  lines: RemoteLogLine[];
};

const TAIL_LINES = 40;
const MAX_CONSECUTIVE_POLL_FAILURES = 10;
/** Per-request bound for every call to the ETL Flask API. Without this, a single hung request
 * (Flask process wedged, network partition, etc.) waits forever -- axios has no timeout by
 * default -- and neither this loop's own MAX_CONSECUTIVE_POLL_FAILURES counter nor BullMQ's job
 * lock renewal ever sees it, because a promise that never settles never reaches the catch block
 * that increments the counter. Bounding each individual call turns a silent hang into a failure
 * that actually surfaces (see the root-cause writeup for the "queued 34 minutes, 0 log lines"
 * incident this was part of closing). Each poll only needs to return quickly -- the loop itself
 * runs for the whole pipeline duration by calling this repeatedly, not by keeping one request open. */
const REQUEST_TIMEOUT_MS = 15_000;

function tail(lines: string[], n: number): string {
  return lines.slice(-n).join('\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildClient(etlApiUrl: string, etlApiKey: string): AxiosInstance {
  return axios.create({
    baseURL: etlApiUrl,
    headers: { Authorization: `Bearer ${etlApiKey}`, 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT_MS,
  });
}

/**
 * Calls the ETL Flask API (data/etl/api/app.py) to run the real vendored pipeline
 * (data/etl/src/sales_pipeline/main.py) and polls it to completion. Same
 * PipelineRunOptions/PipelineRunResult contract this function has always had -- only the
 * transport changed, from spawning `python -m sales_pipeline.main` directly (this process's own
 * child_process.spawn) to an HTTP call against a Flask service that spawns it instead. That
 * service split is required because cPanel shared hosting can't run this API process's own
 * arbitrary Python subprocesses reliably; on cPanel, backend and the ETL Flask API are two
 * separate apps (see docs/DEPLOYMENT*.md), so the subprocess has to live on the Python side.
 *
 * Resolves (never rejects) on a completed OR cancelled run, same as before: the BullMQ job
 * processor (runPipelineJob.ts) throws on a genuine failure to trigger a retry, but not on
 * `cancelled` (a deliberate stop shouldn't be retried).
 */
export async function runPipeline(options: PipelineRunOptions): Promise<PipelineRunResult> {
  const config = getEtlConfig();
  if (!config.etlApi.url || !config.etlApi.apiKey) {
    throw new Error(
      'ETL_API_URL and ETL_API_KEY must be set -- the Node backend now calls the ETL Flask API ' +
        'over HTTP instead of spawning Python directly (see data/etl/api/app.py).',
    );
  }
  const client = buildClient(config.etlApi.url, config.etlApi.apiKey);
  const label = options.label ?? options.loadMode;
  const startedAt = Date.now();

  etlLogger.info('ETL run starting', {
    label,
    loadMode: options.loadMode,
    outputMode: options.outputMode ?? 'sql',
    fast: options.fast ?? false,
  });

  let jobId: string;
  try {
    const response = await client.post<{ jobId: string }>('/etl/run', {
      loadMode: options.loadMode,
      outputMode: options.outputMode ?? 'sql',
      fast: options.fast ?? false,
      extraArgs: options.extraArgs ?? [],
      label,
    });
    jobId = response.data.jobId;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 409) {
      throw new Error(`ETL API reports a run is already active: ${JSON.stringify(err.response.data)}`);
    }
    etlLogger.error('ETL run failed to start', { label, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }

  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  let after = 0;
  let consecutivePollFailures = 0;

  const onAbort = () => {
    client.post(`/etl/jobs/${jobId}/cancel`).catch((err) => {
      etlLogger.error('Failed to request ETL job cancellation', {
        label, jobId, error: err instanceof Error ? err.message : String(err),
      });
    });
  };
  options.signal?.addEventListener('abort', onAbort);

  try {
    for (;;) {
      let data: RemoteJobStatus;
      try {
        const response = await client.get<RemoteJobStatus>(`/etl/jobs/${jobId}`, { params: { after } });
        data = response.data;
        consecutivePollFailures = 0;
      } catch (err) {
        consecutivePollFailures += 1;
        etlLogger.error('ETL job status poll failed', {
          label, jobId, attempt: consecutivePollFailures, error: err instanceof Error ? err.message : String(err),
        });
        if (consecutivePollFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
          throw new Error(
            `Lost contact with the ETL API while polling job ${jobId} after ${consecutivePollFailures} attempts`,
          );
        }
        await sleep(config.etlApi.pollIntervalMs);
        continue;
      }

      for (const line of data.lines) {
        if (line.stream === 'stdout') stdoutLines.push(line.text);
        else stderrLines.push(line.text);
        if (line.text.trim()) etlLogger.info(line.text.trim(), { label, stream: line.stream });
        options.onLine?.(line.text, line.stream);
      }
      after = data.logLineCount;

      if (data.status === 'completed' || data.status === 'failed' || data.status === 'cancelled') {
        const durationMs = data.durationMs ?? Date.now() - startedAt;
        const result: PipelineRunResult = {
          exitCode: data.exitCode ?? -1,
          cancelled: data.status === 'cancelled',
          durationMs,
          stdoutTail: tail(stdoutLines, TAIL_LINES),
          stderrTail: tail(stderrLines, TAIL_LINES),
        };
        if (result.cancelled) {
          etlLogger.info('ETL run cancelled', { label, durationMs });
        } else if (result.exitCode === 0) {
          etlLogger.info('ETL run finished', { label, durationMs, exitCode: result.exitCode });
        } else {
          etlLogger.error('ETL run exited non-zero', {
            label, durationMs, exitCode: result.exitCode, stderrTail: result.stderrTail,
          });
        }
        return result;
      }

      await sleep(config.etlApi.pollIntervalMs);
    }
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Calls the ETL Flask API's POST /etl/reset (see data/etl/api/app.py) to clear a stuck "active
 * job" slot on job_tracker.py's in-memory tracker. Node's own force-reset (forceResetActiveEtlRuns
 * in etlRunTracker.ts) only ever touched this process's own etl_job_runs rows and BullMQ job --
 * it has no visibility into the Flask API process's in-memory state, so if THAT was what was
 * actually stuck, the Node-side reset alone freed nothing there, and the next enqueued run would
 * immediately hit a 409 from the Flask API with no obvious explanation in Node's own logs. Called
 * from POST /admin/etl/force-reset alongside the existing DB/queue reset; failures here are
 * logged but never block the rest of that reset, since the Flask API being unreachable is itself
 * useful information, not a reason to abandon the parts of the reset that already succeeded.
 */
export async function resetEtlApi(): Promise<{ ok: boolean; resetJobId: string | null } | null> {
  const config = getEtlConfig();
  if (!config.etlApi.url || !config.etlApi.apiKey) {
    etlLogger.info('ETL API reset skipped: ETL_API_URL/ETL_API_KEY not configured');
    return null;
  }
  const client = buildClient(config.etlApi.url, config.etlApi.apiKey);
  try {
    const response = await client.post<{ ok: boolean; resetJobId: string | null }>('/etl/reset');
    etlLogger.info('ETL API tracker reset', { resetJobId: response.data.resetJobId });
    return response.data;
  } catch (err) {
    etlLogger.error('ETL API tracker reset failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
