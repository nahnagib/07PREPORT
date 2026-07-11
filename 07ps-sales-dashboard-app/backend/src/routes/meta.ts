import { Router } from 'express';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { requirePasswordChangeCleared, requirePermission } from '../middleware/permission';
import { attachUserContext } from '../middleware/scopeContext';
import { fetchRefreshStatus } from '../measures/refreshStatus';

/**
 * REWRITTEN 2026-07-05 (Tachometer backend port session): the previous version queried a
 * `refresh_log` table that doesn't exist in the real warehouse -- the real audit schema is
 * `pipeline_run_log`/`pipeline_run_audit` (adopted verbatim from the vendored pipeline's own
 * logging, see data/warehouse/migrations/0007_etl_and_audit_log.sql). Now backed by
 * src/measures/refreshStatus.ts (ported 1:1 from the validated Python reference).
 */

export const metaRouter = Router();

metaRouter.use(requireAuth, requirePasswordChangeCleared, requirePermission('tachometer', 'view'), attachUserContext);

metaRouter.get('/refresh-status', async (_req, res, next) => {
  try {
    const status = await fetchRefreshStatus(pool);
    res.json({
      lastUpdate: status.lastUpdate,
      lastRefreshTime: status.lastRefreshTime,
      isStale: status.isStale,
      isInverted: status.isInverted,
    });
  } catch (err) {
    next(err);
  }
});
