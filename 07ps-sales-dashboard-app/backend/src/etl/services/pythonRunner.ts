import { spawn } from 'child_process';
import { buildPythonEnv, getEtlConfig } from '../config/etlConfig';
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
  /** Aborting kills the subprocess (Node's child_process.spawn supports this natively) -- used
   * by the ETL Control Center's Cancel button, see etl/queue/etlControlChannel.ts. */
  signal?: AbortSignal;
  /** Called for every non-empty stdout/stderr line, in order, as the subprocess produces them --
   * used by runPipelineJob.ts to forward stage/summary lines into BullMQ job progress/logs
   * without needing to re-parse the orchestration log file. (Same pre-existing ESLint
   * type-signature gap as etlControlChannel.ts's subscribeToCancelRequests.) */
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

const TAIL_LINES = 40;

function tail(lines: string[], n: number): string {
  return lines.slice(-n).join('\n');
}

/**
 * The one place that knows how to invoke the vendored pipeline. Invocation shape (cwd = pipeline
 * root, `python -m sales_pipeline.main ...`) matches exactly what the original `scheduler.py` (the
 * Windows Task Scheduler-launched script this replaces, not vendored here) used in production,
 * including `--output sql --load-mode incremental --fast` as the default scheduled-run args.
 *
 * Resolves (never rejects) on a completed OR cancelled process -- callers decide what a failed
 * run means for them: the BullMQ job processor throws on a genuine failure to trigger a retry,
 * but not on `cancelled` (a deliberate stop shouldn't be retried).
 */
export async function runPipeline(options: PipelineRunOptions): Promise<PipelineRunResult> {
  const config = getEtlConfig();
  const args = [
    '-m',
    'sales_pipeline.main',
    '--output',
    options.outputMode ?? 'sql',
    '--load-mode',
    options.loadMode,
  ];
  if (options.fast) args.push('--fast');
  if (options.extraArgs?.length) args.push(...options.extraArgs);

  const label = options.label ?? options.loadMode;
  const startedAt = Date.now();
  etlLogger.info('ETL run starting', { label, args, cwd: config.pythonDir });

  return new Promise((resolve, reject) => {
    const child = spawn(config.pythonBin, args, {
      cwd: config.pythonDir,
      env: buildPythonEnv(config),
      signal: options.signal,
    });

    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      const lines = text.split(/\r?\n/).filter(Boolean);
      stdoutLines.push(...lines);
      if (text.trim()) etlLogger.info(text.trim(), { label, stream: 'stdout' });
      for (const line of lines) options.onLine?.(line, 'stdout');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      const lines = text.split(/\r?\n/).filter(Boolean);
      stderrLines.push(...lines);
      // Not necessarily a warning: the pipeline's own `logging.basicConfig` (Python's default)
      // sends every level, including plain INFO, to stderr -- exit code is the real failure
      // signal (handled below via etlLogger.error with the full stderr tail), not this stream.
      if (text.trim()) etlLogger.info(text.trim(), { label, stream: 'stderr' });
      for (const line of lines) options.onLine?.(line, 'stderr');
    });

    child.on('error', (err) => {
      const durationMs = Date.now() - startedAt;
      if (err.name === 'AbortError') {
        etlLogger.info('ETL run cancelled', { label, durationMs });
        resolve({
          exitCode: -1,
          cancelled: true,
          durationMs,
          stdoutTail: tail(stdoutLines, TAIL_LINES),
          stderrTail: tail(stderrLines, TAIL_LINES),
        });
        return;
      }
      etlLogger.error('ETL run failed to start', { label, error: err.message });
      reject(err);
    });

    child.on('close', (code) => {
      const durationMs = Date.now() - startedAt;
      const exitCode = code ?? 1;
      const result: PipelineRunResult = {
        exitCode,
        cancelled: false,
        durationMs,
        stdoutTail: tail(stdoutLines, TAIL_LINES),
        stderrTail: tail(stderrLines, TAIL_LINES),
      };
      if (exitCode === 0) {
        etlLogger.info('ETL run finished', { label, durationMs, exitCode });
      } else {
        etlLogger.error('ETL run exited non-zero', {
          label,
          durationMs,
          exitCode,
          stderrTail: result.stderrTail,
        });
      }
      resolve(result);
    });
  });
}
