import { Request, Router } from 'express';
import { pool } from '../../db/pool';
import { requireAuth } from '../../middleware/auth';
import { requirePasswordChangeCleared, requirePermission } from '../../middleware/permission';

/**
 * Read-only view over the ETL platform's run history (migration 0028):
 *   /log    etl_run_log -- one row per job run (job, department, mode, trigger, timings, counts, status, error)
 *   /audit  per run, the task-level detail from etl_task_log (rows loaded per task, -1 key fallbacks)
 * The legacy pipeline_run_log / pipeline_run_audit are retired; their field names are kept as aliases
 * (pipeline_start_time, db_loaded_count, row_counts_json, ...) so the page's columns stay the same.
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
      `SELECT run_id, job_name, department, mode, trigger_source, parent_run_uid,
              DATE_FORMAT(started_at_utc, '%Y-%m-%d %H:%i:%s') AS pipeline_start_time,
              DATE_FORMAT(finished_at_utc, '%Y-%m-%d %H:%i:%s') AS pipeline_end_time,
              ROUND(duration_seconds / 60, 2) AS total_duration_minutes,
              status, error_message, odoo_extract_count, rows_processed AS db_loaded_count, qa_issues_count,
              DATE_FORMAT(created_at_utc, '%Y-%m-%d %H:%i:%s') AS created_at
       FROM etl_run_log ORDER BY run_id DESC LIMIT ? OFFSET ?`,
      [pageSize, offset],
    );
    const [countRows] = await pool.query('SELECT COUNT(*) AS total FROM etl_run_log');
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
      `SELECT r.run_id, r.job_name, r.department,
              DATE_FORMAT(r.started_at_utc, '%Y-%m-%d %H:%i:%s') AS started_at,
              DATE_FORMAT(r.finished_at_utc, '%Y-%m-%d %H:%i:%s') AS finished_at,
              r.mode AS load_mode, r.output_mode, r.status, r.error_message,
              (SELECT JSON_OBJECTAGG(t.task_name, t.rows_loaded) FROM etl_task_log t WHERE t.run_uid = r.run_uid) AS row_counts_json,
              (SELECT SUM(t.unknown_key_fallbacks) FROM etl_task_log t WHERE t.run_uid = r.run_uid) AS unknown_key_fallbacks,
              DATE_FORMAT(r.created_at_utc, '%Y-%m-%d %H:%i:%s') AS created_at
       FROM etl_run_log r ORDER BY r.run_id DESC LIMIT ? OFFSET ?`,
      [pageSize, offset],
    );
    const [countRows] = await pool.query('SELECT COUNT(*) AS total FROM etl_run_log');
    const total = (countRows as { total: number }[])[0]?.total ?? 0;
    res.json({ rows, total, page, pageSize });
  } catch (err) {
    next(err);
  }
});
