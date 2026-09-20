import { Router } from 'express';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { requirePasswordChangeCleared, requirePermission } from '../middleware/permission';
import { attachUserContext } from '../middleware/scopeContext';
import { fetchRefreshStatus } from '../measures/refreshStatus';

/**
 * Refresh metadata for the dashboard footer/sidebar and the "Refresh log looks wrong" banner.
 * Backed by src/measures/refreshStatus.ts: "Last Refresh" is etl_run_log's last SUCCESSFUL run
 * (UTC), and `refreshCheck` says whether that log agrees with the data actually in the tables.
 * The post-deploy smoke check (scripts/post_deploy_check.py) fails the deployment when
 * `refreshCheck.inconsistent` is true.
 */

export const metaRouter = Router();

metaRouter.use(requireAuth, requirePasswordChangeCleared, requirePermission('tachometer', 'view'), attachUserContext);

metaRouter.get('/refresh-status', async (_req, res, next) => {
  try {
    const status = await fetchRefreshStatus(pool);
    res.json({
      lastUpdate: status.lastUpdate,
      lastOrderCreated: status.lastOrderCreated,
      lastRefreshTime: status.lastRefreshTime,
      isStale: status.isStale,
      isInverted: status.isInverted,
      refreshCheck: status.refreshCheck,
      displayTimezone: status.displayTimezone,
    });
  } catch (err) {
    next(err);
  }
});
