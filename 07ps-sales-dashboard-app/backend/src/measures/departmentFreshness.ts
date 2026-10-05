/**
 * Freshness per ETL department (etl_run_log.department), so each page shows its own "Last Refresh": a finance run
 * never moves the sales footer and vice versa. Sales keeps its richer check in refreshStatus.ts (it also compares
 * the log with the loaded orders); this is the generic per-department answer used by finance and the Control Center.
 *
 *   lastSuccessUtc   finished_at_utc of the newest successful top-level run of the department
 *   lastFailureUtc   the newest failed one, when it is newer than the last success (else null)
 *   dataAsOf         finance: the newest receivable snapshot date (yyyy-mm-dd); null for other departments
 */
import type { Pool } from 'mysql2/promise';

export const ETL_DEPARTMENTS = ['sales', 'finance', 'core'] as const;
export type EtlDepartment = (typeof ETL_DEPARTMENTS)[number];

export interface DepartmentFreshness {
  department: EtlDepartment;
  lastSuccessUtc: string | null;
  lastSuccessJob: string | null;
  lastFailureUtc: string | null;
  lastFailureJob: string | null;
  dataAsOf: string | null;
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(`${String(value).replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function isEtlDepartment(value: unknown): value is EtlDepartment {
  return typeof value === 'string' && (ETL_DEPARTMENTS as readonly string[]).includes(value);
}

export async function fetchDepartmentFreshness(pool: Pool, department: EtlDepartment): Promise<DepartmentFreshness> {
  const [ok] = await pool.query(
    `SELECT finished_at_utc AS at, job_name AS job FROM etl_run_log
      WHERE department = ? AND status = 'success' AND parent_run_uid IS NULL AND finished_at_utc IS NOT NULL
      ORDER BY finished_at_utc DESC LIMIT 1`,
    [department],
  );
  const [bad] = await pool.query(
    `SELECT finished_at_utc AS at, job_name AS job FROM etl_run_log
      WHERE department = ? AND status = 'failed' AND parent_run_uid IS NULL AND finished_at_utc IS NOT NULL
      ORDER BY finished_at_utc DESC LIMIT 1`,
    [department],
  );
  const success = (ok as any[])[0];
  const failure = (bad as any[])[0];
  const failureIsNewer = failure && (!success || new Date(failure.at) > new Date(success.at));
  let dataAsOf: string | null = null;
  if (department === 'finance') {
    const [rows] = await pool.query('SELECT MAX(SnapshotDateKey) AS k FROM fact_finance_receivable_snapshot');
    const k = (rows as any[])[0]?.k;
    if (k) {
      const s = String(k);
      dataAsOf = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
    }
  }
  return {
    department,
    lastSuccessUtc: iso(success?.at),
    lastSuccessJob: success?.job ?? null,
    lastFailureUtc: failureIsNewer ? iso(failure.at) : null,
    lastFailureJob: failureIsNewer ? failure.job ?? null : null,
    dataAsOf,
  };
}
