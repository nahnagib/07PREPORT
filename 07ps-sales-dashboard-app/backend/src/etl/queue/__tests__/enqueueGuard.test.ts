import { beforeEach, describe, expect, it, vi } from 'vitest';

const { conn, tracker, queueAdd, queueNames } = vi.hoisted(() => ({
  conn: { query: vi.fn(), release: vi.fn() },
  tracker: { hasActiveEtlRun: vi.fn(), activeEtlRunJobTypes: vi.fn(), createQueuedRun: vi.fn(), setRunJobId: vi.fn(), finishRun: vi.fn() },
  queueAdd: vi.fn(),
  queueNames: [] as string[],
}));

vi.mock('../../../db/pool', () => ({ pool: { getConnection: vi.fn(async () => conn) } }));
vi.mock('../../services/etlRunTracker', () => tracker);
vi.mock('bullmq', () => ({
  Queue: class {
    name: string;
    on = vi.fn();
    constructor(name: string) { this.name = name; }
    add = (...args: unknown[]) => { queueNames.push(this.name); return queueAdd(...args); };
  },
}));

import { EtlAlreadyRunningError, enqueuePipelineRun } from '../etlQueue';

const input = { mode: 'incremental', loadMode: 'incremental', outputMode: 'sql', label: 'manual-incremental', triggerSource: 'manual' } as const;

beforeEach(() => {
  vi.clearAllMocks();
  conn.query.mockImplementation(async (sql: string) => (sql.includes('GET_LOCK') ? [[{ got: 1 }]] : [[{}]]));
  tracker.hasActiveEtlRun.mockResolvedValue(false);
  tracker.activeEtlRunJobTypes.mockResolvedValue([]);
  queueNames.length = 0;
  tracker.createQueuedRun.mockResolvedValue(7);
  queueAdd.mockResolvedValue({ id: 'etl-7' });
});

describe('enqueuePipelineRun concurrency guard', () => {
  it('creates the run and queues the job when nothing is active, releasing the lock', async () => {
    const { runId } = await enqueuePipelineRun(input);
    expect(runId).toBe(7);
    expect(tracker.createQueuedRun).toHaveBeenCalledTimes(1);
    expect(conn.query.mock.calls.some(([sql]) => String(sql).includes('RELEASE_LOCK'))).toBe(true);
    expect(conn.release).toHaveBeenCalled();
  });

  it('refuses (and inserts nothing) when a run is already queued/running', async () => {
    tracker.activeEtlRunJobTypes.mockResolvedValue(['main']);
    await expect(enqueuePipelineRun(input)).rejects.toBeInstanceOf(EtlAlreadyRunningError);
    expect(tracker.createQueuedRun).not.toHaveBeenCalled();
    expect(queueAdd).not.toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalled();
  });

  it('refuses when another start holds the enqueue lock', async () => {
    conn.query.mockImplementation(async (sql: string) => (sql.includes('GET_LOCK') ? [[{ got: 0 }]] : [[{}]]));
    await expect(enqueuePipelineRun(input)).rejects.toBeInstanceOf(EtlAlreadyRunningError);
    expect(tracker.createQueuedRun).not.toHaveBeenCalled();
  });

  it('marks the run failed if the job cannot be queued (no orphaned lock-holding row)', async () => {
    queueAdd.mockRejectedValue(new Error('redis down'));
    await expect(enqueuePipelineRun(input)).rejects.toThrow('redis down');
    expect(tracker.finishRun).toHaveBeenCalledWith(7, expect.objectContaining({ status: 'failed' }));
  });

  it('queues a scheduled full / sales run behind a 30-minute refresh (queueBehindRefresh) instead of dropping it', async () => {
    tracker.hasActiveEtlRun.mockResolvedValue(true);
    tracker.activeEtlRunJobTypes.mockResolvedValue(['refresh_30m']);
    const { runId } = await enqueuePipelineRun({ ...input, job: 'full_all', mode: 'full', loadMode: 'full', queueBehindRefresh: true });
    expect(runId).toBe(7);
    expect(queueAdd).toHaveBeenCalledTimes(1);
  });

  it('still refuses when anything other than a refresh is active (no second full or sales run queued)', async () => {
    tracker.activeEtlRunJobTypes.mockResolvedValue(['refresh_30m', 'full_all']);
    await expect(enqueuePipelineRun({ ...input, job: 'main', queueBehindRefresh: true })).rejects.toBeInstanceOf(EtlAlreadyRunningError);
    expect(tracker.createQueuedRun).not.toHaveBeenCalled();
  });

  it('a refresh never queues behind anything, and runs with one BullMQ attempt when asked', async () => {
    tracker.hasActiveEtlRun.mockResolvedValue(true);
    tracker.activeEtlRunJobTypes.mockResolvedValue(['refresh_30m']);
    await expect(enqueuePipelineRun({ ...input, job: 'refresh_30m', mode: 'refresh', attempts: 1 })).rejects.toBeInstanceOf(EtlAlreadyRunningError);
    tracker.activeEtlRunJobTypes.mockResolvedValue([]);
    await enqueuePipelineRun({ ...input, job: 'refresh_30m', mode: 'refresh', attempts: 1 });
    expect(queueAdd.mock.calls[0][2]).toMatchObject({ attempts: 1 });
  });

  it('keeps three attempts for the other jobs', async () => {
    await enqueuePipelineRun(input);
    expect(queueAdd.mock.calls[0][2]).toMatchObject({ attempts: 3 });
    expect(queueNames).toEqual(['etl']);
  });

  const build = { ...input, job: 'sales_build', mode: 'sales_build', label: 'scheduled-sales-build', attempts: 1 } as const;

  it('a sales build goes to the second queue and starts while the refresh or a sales run is active', async () => {
    tracker.activeEtlRunJobTypes.mockResolvedValue(['refresh_30m', 'main']);
    await enqueuePipelineRun(build);
    expect(queueNames).toEqual(['etl-long']);
  });

  it('never two sales builds at once', async () => {
    tracker.activeEtlRunJobTypes.mockResolvedValue(['sales_build']);
    await expect(enqueuePipelineRun(build)).rejects.toBeInstanceOf(EtlAlreadyRunningError);
  });

  it('a running sales build never blocks the main queue (refresh, sales, full)', async () => {
    tracker.activeEtlRunJobTypes.mockResolvedValue(['sales_build']);
    await enqueuePipelineRun({ ...input, job: 'refresh_30m', mode: 'refresh', attempts: 1 });
    await enqueuePipelineRun({ ...input, job: 'full_all', mode: 'full', loadMode: 'full' });
    expect(queueNames).toEqual(['etl', 'etl']);
  });
});
