/**
 * `npx tsx scripts/etl-main-check.ts` (from backend/, DB_* from backend/.env): after a `main` / `full_all` run, prints
 *   1. the newest top-level pipeline run in etl_run_log and its steps (rows whose parent_run_uid is its run_uid);
 *   2. receivable snapshot rows per date;
 *   3. the Debt Report cards exactly as the page computes them for Company = Both (fetchDebtOverview, no role scope).
 * Read-only.
 */
import 'dotenv/config';
import { pool } from '../src/db/pool';
import { DEFAULT_DEBT_QUERY, fetchDebtOverview } from '../src/measures/debtReport';
import { fetchDepartmentFreshness } from '../src/measures/departmentFreshness';

const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main() {
  const [top] = await pool.query(
    `SELECT run_id, run_uid, job_name, status, trigger_source, started_at_utc, finished_at_utc, duration_seconds,
            rows_processed, error_message
       FROM etl_run_log WHERE parent_run_uid IS NULL AND job_name IN ('main', 'full_all')
      ORDER BY run_id DESC LIMIT 1`,
  );
  const parent = (top as any[])[0];
  console.log('== 1. etl_run_log: newest main/full_all run and its steps');
  if (!parent) {
    console.log('(no main / full_all run recorded yet)');
  } else {
    const [kids] = await pool.query(
      `SELECT run_id, job_name, status, parent_run_uid, started_at_utc, finished_at_utc, duration_seconds, rows_processed,
              LEFT(error_message, 300) AS error_message
         FROM etl_run_log WHERE parent_run_uid = ? ORDER BY run_id`,
      [parent.run_uid],
    );
    console.table([parent, ...(kids as any[])].map((r) => ({
      run_id: r.run_id, job: r.job_name, status: r.status, parent: r.parent_run_uid ? `-> ${String(r.parent_run_uid).slice(0, 8)}` : `TOP ${String(r.run_uid).slice(0, 8)}`,
      started_utc: r.started_at_utc, seconds: r.duration_seconds === null ? null : Math.round(Number(r.duration_seconds)),
      rows: r.rows_processed, error: r.error_message,
    })));
  }

  console.log('== 2. fact_finance_receivable_snapshot rows per date');
  const [snaps] = await pool.query(
    `SELECT SnapshotDateKey AS date, COUNT(*) AS rows_, COUNT(DISTINCT line_id) AS distinct_lines
       FROM fact_finance_receivable_snapshot GROUP BY SnapshotDateKey ORDER BY SnapshotDateKey`,
  );
  console.table(snaps as any[]);

  console.log('== 3. Debt Report cards, Company = Both (default filters)');
  const o = await fetchDebtOverview(pool, DEFAULT_DEBT_QUERY, {});
  console.log(`snapshot ${o.snapshotDate}`);
  console.table(o.currencies.map((c) => ({
    currency: c.currency, invoices: c.kpis.openDocuments, customers: c.kpis.customers, amount_due: money(c.kpis.openAmount),
    overdue: money(c.kpis.overdueAmount), not_yet_due: money(c.kpis.notDueAmount), in_LYD: money(c.kpis.openAmountCompany),
  })));
  const a = o.allCurrencies;
  console.log(`All currencies (in LYD): ${money(a.openAmount)} · invoices ${a.openDocuments} · customers ${a.customers}`);

  const fin = await fetchDepartmentFreshness(pool, 'finance');
  console.log(`Debt Report "Finance refresh": ${fin.lastSuccessUtc} UTC (${fin.lastSuccessJob}); data as of ${fin.dataAsOf}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
