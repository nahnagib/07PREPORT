import { Request, Router } from 'express';
import { pool } from '../../db/pool';
import { requireAuth } from '../../middleware/auth';
import { requirePasswordChangeCleared, requirePermission } from '../../middleware/permission';

/**
 * Read-only view over the vendored ETL pipeline's own run history -- pipeline_run_log (one row
 * per invocation: start/end time, duration, extract/load/QA counts, status, error message) and
 * pipeline_run_audit (load_mode/output_mode, before/after order cursor, per-table row_counts_json).
 * Both tables already exist and are already populated by data/etl regardless of what invokes it
 * (Node's scheduler/CLI or, previously, the Windows Task Scheduler script) -- this route does not
 * write to them, and there is no new schema here.
 */
export const adminEtlRunsRouter = Router();

adminEtlRunsRouter.use(
  requireAuth,
  requirePasswordChangeCleared,
  requirePermission('admin_etl', 'view'),
);

function pagination(req: Request) {
  const page = Number(req.query.page ?? 1) || 1;
  const pageSize = Math.min(Number(req.query.pageSize ?? 25) || 25, 100);
  return { page, pageSize, offset: Math.max(0, (page - 1) * pageSize) };
}

adminEtlRunsRouter.get('/log', async (req, res, next) => {
  try {
    const { page, pageSize, offset } = pagination(req);
    const [rows] = await pool.query(
      `SELECT * FROM pipeline_run_log ORDER BY run_id DESC LIMIT ? OFFSET ?`,
      [pageSize, offset],
    );
    const [countRows] = await pool.query('SELECT COUNT(*) AS total FROM pipeline_run_log');
    const total = (countRows as { total: number }[])[0]?.total ?? 0;
    res.json({ rows, total, page, pageSize });
  } catch (err) {
    next(err);
  }
});

adminEtlRunsRouter.get('/audit', async (req, res, next) => {
  try {
    const { page, pageSize, offset } = pagination(req);
    const [rows] = await pool.query(
      `SELECT * FROM pipeline_run_audit ORDER BY run_id DESC LIMIT ? OFFSET ?`,
      [pageSize, offset],
    );
    const [countRows] = await pool.query('SELECT COUNT(*) AS total FROM pipeline_run_audit');
    const total = (countRows as { total: number }[])[0]?.total ?? 0;
    res.json({ rows, total, page, pageSize });
  } catch (err) {
    next(err);
  }
});
