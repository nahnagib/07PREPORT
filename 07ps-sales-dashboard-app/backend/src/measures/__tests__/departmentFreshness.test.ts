import { describe, expect, it, vi } from 'vitest';
import { fetchDepartmentFreshness, isEtlDepartment } from '../departmentFreshness';

function pool(results: unknown[][]) {
  const query = vi.fn();
  for (const r of results) query.mockResolvedValueOnce([r]);
  return { query } as any;
}

describe('fetchDepartmentFreshness', () => {
  it('reports the newest finance success, a newer failure and the snapshot date', async () => {
    const p = pool([
      [{ at: '2026-10-04 17:04:13', job: 'finance_receivables' }],
      [{ at: '2026-10-05 04:31:00', job: 'finance_receivables' }],
      [{ k: 20261004 }],
    ]);
    const f = await fetchDepartmentFreshness(p, 'finance');
    expect(f).toEqual({
      department: 'finance', lastSuccessUtc: '2026-10-04T17:04:13.000Z', lastSuccessJob: 'finance_receivables',
      lastFailureUtc: '2026-10-05T04:31:00.000Z', lastFailureJob: 'finance_receivables', dataAsOf: '2026-10-04',
    });
    expect(p.query.mock.calls[0][1]).toEqual(['finance']); // only this department's runs
  });

  it('counts finance runs at any level: the snapshot step of a main / full_all run is a child row', async () => {
    const p = pool([[{ at: '2026-10-07 06:02:00', job: 'finance_receivables' }], [], [{ k: 20261007 }]]);
    const f = await fetchDepartmentFreshness(p, 'finance');
    expect(f.lastSuccessUtc).toBe('2026-10-07T06:02:00.000Z');
    for (const [sql] of p.query.mock.calls.slice(0, 2)) {
      expect(sql).not.toMatch(/parent_run_uid/);
    }
    expect(p.query.mock.calls[0][0]).toMatch(/status = 'success'/);
  });

  it('hides a failure older than the last success and has no snapshot date outside finance', async () => {
    const p = pool([[{ at: '2026-10-04 11:26:34', job: 'sales_full' }], [{ at: '2026-10-04 10:00:00', job: 'sales_full' }]]);
    const f = await fetchDepartmentFreshness(p, 'sales');
    expect(f.lastFailureUtc).toBeNull();
    expect(f.dataAsOf).toBeNull();
    expect(isEtlDepartment('finance') && !isEtlDepartment('hr')).toBe(true);
  });
});
