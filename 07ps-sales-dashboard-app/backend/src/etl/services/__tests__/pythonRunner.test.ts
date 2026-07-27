import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// vitest hoists vi.mock(...) calls above this import automatically, so runPipeline still picks up
// the mocked axios/etlConfig/etlLogger declared below.
import { resetEtlApi, runPipeline } from '../pythonRunner';

const hoisted = vi.hoisted(() => ({
  postMock: vi.fn(),
  getMock: vi.fn(),
}));

vi.mock('axios', async () => {
  const actual = await vi.importActual<typeof import('axios')>('axios');
  return {
    ...actual,
    default: {
      ...actual.default,
      create: vi.fn(() => ({ post: hoisted.postMock, get: hoisted.getMock })),
    },
  };
});

vi.mock('../etlLogger', () => ({
  etlLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('../../config/etlConfig', () => ({
  getEtlConfig: vi.fn(() => ({
    logDir: '/tmp/logs',
    schedule: { incrementalCron: '', incrementalEnabled: false, fullCron: '', fullEnabled: false },
    redis: { host: 'localhost', port: 6379 },
    etlApi: { url: 'http://localhost:5001', apiKey: 'test-key', pollIntervalMs: 1 },
  })),
}));

describe('pythonRunner.runPipeline', () => {
  beforeEach(() => {
    hoisted.postMock.mockReset();
    hoisted.getMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('polls until completed and returns exitCode 0', async () => {
    hoisted.postMock.mockResolvedValueOnce({ data: { jobId: 'job-1' } });
    hoisted.getMock
      .mockResolvedValueOnce({
        data: {
          jobId: 'job-1', status: 'running', exitCode: null, durationMs: null,
          logLineCount: 1, lines: [{ index: 0, stream: 'stdout', text: 'Pipeline step extract started' }],
        },
      })
      .mockResolvedValueOnce({
        data: {
          jobId: 'job-1', status: 'completed', exitCode: 0, durationMs: 1234,
          logLineCount: 1, lines: [],
        },
      });

    const onLine = vi.fn();
    const result = await runPipeline({ loadMode: 'incremental', fast: true, onLine });

    expect(result.exitCode).toBe(0);
    expect(result.cancelled).toBe(false);
    expect(result.durationMs).toBe(1234);
    expect(onLine).toHaveBeenCalledWith('Pipeline step extract started', 'stdout');
    expect(hoisted.postMock).toHaveBeenCalledWith('/etl/run', expect.objectContaining({
      loadMode: 'incremental', outputMode: 'sql', fast: true,
    }));
  });

  it('returns a failed result with stderrTail on non-zero exit', async () => {
    hoisted.postMock.mockResolvedValueOnce({ data: { jobId: 'job-2' } });
    hoisted.getMock.mockResolvedValueOnce({
      data: {
        jobId: 'job-2', status: 'failed', exitCode: 1, durationMs: 500,
        logLineCount: 1, lines: [{ index: 0, stream: 'stderr', text: 'ValueError: boom' }],
      },
    });

    const result = await runPipeline({ loadMode: 'full' });

    expect(result.exitCode).toBe(1);
    expect(result.cancelled).toBe(false);
    expect(result.stderrTail).toContain('ValueError: boom');
  });

  it('returns cancelled: true when the job status is cancelled', async () => {
    hoisted.postMock.mockResolvedValueOnce({ data: { jobId: 'job-3' } });
    hoisted.getMock.mockResolvedValueOnce({
      data: { jobId: 'job-3', status: 'cancelled', exitCode: -1, durationMs: 200, logLineCount: 0, lines: [] },
    });

    const result = await runPipeline({ loadMode: 'incremental' });

    expect(result.cancelled).toBe(true);
  });

  it('requests cancellation via POST when the abort signal fires', async () => {
    hoisted.postMock.mockImplementation((url: string) => {
      if (url === '/etl/run') return Promise.resolve({ data: { jobId: 'job-4' } });
      return Promise.resolve({ data: {} });
    });

    const controller = new AbortController();
    let callCount = 0;
    hoisted.getMock.mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        controller.abort();
        return Promise.resolve({
          data: { jobId: 'job-4', status: 'running', exitCode: null, durationMs: null, logLineCount: 0, lines: [] },
        });
      }
      return Promise.resolve({
        data: { jobId: 'job-4', status: 'cancelled', exitCode: -1, durationMs: 300, logLineCount: 0, lines: [] },
      });
    });

    const result = await runPipeline({ loadMode: 'full', signal: controller.signal });

    expect(result.cancelled).toBe(true);
    expect(hoisted.postMock).toHaveBeenCalledWith('/etl/jobs/job-4/cancel');
  });

  it('throws a clear error when the ETL API reports 409 (run already active)', async () => {
    const axiosError = Object.assign(new Error('Conflict'), {
      isAxiosError: true,
      response: { status: 409, data: { error: 'A run is already active', activeJobId: 'other-job' } },
    });
    hoisted.postMock.mockRejectedValueOnce(axiosError);

    await expect(runPipeline({ loadMode: 'incremental' })).rejects.toThrow(/already active/);
  });

  it('throws after repeated poll failures instead of hanging forever', async () => {
    hoisted.postMock.mockResolvedValueOnce({ data: { jobId: 'job-5' } });
    hoisted.getMock.mockRejectedValue(new Error('network blip'));

    await expect(runPipeline({ loadMode: 'incremental' })).rejects.toThrow(/Lost contact/);
  });
});

describe('pythonRunner.resetEtlApi', () => {
  beforeEach(() => {
    hoisted.postMock.mockReset();
    hoisted.getMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('posts to /etl/reset and returns the resetJobId', async () => {
    hoisted.postMock.mockResolvedValueOnce({ data: { ok: true, resetJobId: 'stuck-job' } });

    const result = await resetEtlApi();

    expect(hoisted.postMock).toHaveBeenCalledWith('/etl/reset');
    expect(result).toEqual({ ok: true, resetJobId: 'stuck-job' });
  });

  it('returns resetJobId: null when nothing was active on the tracker', async () => {
    hoisted.postMock.mockResolvedValueOnce({ data: { ok: true, resetJobId: null } });

    const result = await resetEtlApi();

    expect(result?.resetJobId).toBeNull();
  });

  it('returns null (never throws) when the ETL API is unreachable', async () => {
    hoisted.postMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    const result = await resetEtlApi();

    expect(result).toBeNull();
  });
});
