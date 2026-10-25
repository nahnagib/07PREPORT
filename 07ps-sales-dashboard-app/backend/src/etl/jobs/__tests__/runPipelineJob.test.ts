import { beforeEach, describe, expect, it, vi } from 'vitest';

const { tracker, runner, captured } = vi.hoisted(() => ({
  tracker: {
    correlateLatestEtlRun: vi.fn(),
    finishRun: vi.fn(),
    getMaxEtlRunId: vi.fn(),
    markRunRetrying: vi.fn(),
    markRunStarted: vi.fn(),
  },
  runner: { runPipeline: vi.fn() },
  captured: { processor: null as any },
}));

vi.mock('../../services/etlRunTracker', () => tracker);
vi.mock('../../services/pythonRunner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/pythonRunner')>()),
  runPipeline: runner.runPipeline,
}));
vi.mock('../../queue/etlControlChannel', () => ({ subscribeToCancelRequests: vi.fn() }));
vi.mock('bullmq', () => ({
  Worker: class {
    constructor(_name: string, processor: any) {
      captured.processor = processor;
    }
    on = vi.fn();
  },
}));

import { startEtlWorker } from '../runPipelineJob';

function bullJob(attemptsMade = 0) {
  return {
    id: 'etl-9', attemptsMade, opts: { attempts: 3 }, updateProgress: vi.fn(), log: vi.fn(),
    data: { job: 'full_all', mode: 'full', loadMode: 'full', outputMode: 'sql', label: 'scheduled-full', runId: 9 },
  };
}

function result(exitCode: number) {
  return { exitCode, cancelled: false, durationMs: 1000, stdoutTail: '', stderrTail: 'tail of stderr' };
}

beforeEach(() => {
  vi.clearAllMocks();
  tracker.getMaxEtlRunId.mockResolvedValue(100);
  tracker.correlateLatestEtlRun.mockResolvedValue({
    pipelineRunLogId: 101, odooExtractCount: 5, dbLoadedCount: 7, qaIssuesCount: 1,
    errorMessage: 'finance failed: RuntimeError: Odoo read of account.move.line timed out',
  });
  startEtlWorker();
});

describe('ETL worker exit-code mapping', () => {
  it('records exit 3 as partial with the platform message, and does not retry', async () => {
    runner.runPipeline.mockResolvedValue(result(3));
    await expect(captured.processor!(bullJob())).resolves.toBeUndefined();
    expect(tracker.finishRun).toHaveBeenCalledWith(9, expect.objectContaining({
      status: 'partial', exitCode: 3, pipelineRunLogId: 101,
      errorMessage: 'finance failed: RuntimeError: Odoo read of account.move.line timed out',
    }));
    expect(tracker.markRunRetrying).not.toHaveBeenCalled();
  });

  it('records exit 4 (lock held by another run) as skipped, and does not retry', async () => {
    runner.runPipeline.mockResolvedValue(result(4));
    await expect(captured.processor!(bullJob())).resolves.toBeUndefined();
    expect(tracker.finishRun).toHaveBeenCalledWith(9, expect.objectContaining({ status: 'skipped', exitCode: 4 }));
    expect(tracker.finishRun.mock.calls[0][1].errorMessage).toMatch(/already running/);
  });

  it('still fails (and lets BullMQ retry) on exit 1', async () => {
    runner.runPipeline.mockResolvedValue(result(1));
    await expect(captured.processor!(bullJob())).rejects.toThrow(/exited with code 1/);
    expect(tracker.markRunRetrying).toHaveBeenCalledWith(9, 'tail of stderr');
    expect(tracker.finishRun).not.toHaveBeenCalled();
  });

  it('records success on exit 0', async () => {
    runner.runPipeline.mockResolvedValue(result(0));
    await captured.processor!(bullJob());
    expect(tracker.finishRun).toHaveBeenCalledWith(9, expect.objectContaining({ status: 'success', exitCode: 0 }));
  });

  it.each([0, 2])('surfaces stdout-only NPS failures on attempt %i', async (attemptsMade) => {
    const errorMessage = "Job 'process_nps' is disabled in this environment: NPS_ENABLED is not true";
    tracker.correlateLatestEtlRun.mockResolvedValue(null);
    runner.runPipeline.mockResolvedValue({ ...result(1), stderrTail: '', stdoutTail: errorMessage });
    const job = bullJob(attemptsMade);
    job.data.job = 'process_nps';
    await expect(captured.processor!(job)).rejects.toThrow(errorMessage);
    if (attemptsMade === 0) {
      expect(tracker.markRunRetrying).toHaveBeenCalledWith(9, errorMessage);
    } else {
      expect(tracker.finishRun).toHaveBeenCalledWith(9, expect.objectContaining({
        status: 'failed', errorMessage,
      }));
    }
  });

  it('uses the correlated platform failure when both output streams are empty', async () => {
    runner.runPipeline.mockResolvedValue({ ...result(1), stderrTail: '' });
    await expect(captured.processor!(bullJob(2))).rejects.toThrow('finance failed');
    expect(tracker.finishRun).toHaveBeenCalledWith(9, expect.objectContaining({
      status: 'failed', errorMessage: 'finance failed: RuntimeError: Odoo read of account.move.line timed out',
    }));
  });
});
