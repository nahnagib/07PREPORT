import { Router } from 'express';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { requireAnyDashboardView, requirePasswordChangeCleared } from '../middleware/permission';
import { attachUserContext } from '../middleware/scopeContext';
import { fetchRefreshStatus, redactRefreshStatusForNonAdmin } from '../measures/refreshStatus';

/**
 * Refresh metadata for the dashboard footer/sidebar and the "Refresh log looks wrong" banner.
 * Backed by src/measures/refreshStatus.ts: "Last Refresh" is etl_run_log's last SUCCESSFUL run
 * (UTC), and `refreshCheck` says whether that log agrees with the data actually in the tables.
 * The post-deploy smoke check (scripts/post_deploy_check.py) fails the deployment when
 * `refreshCheck.inconsistent` is true.
 */

export const metaRouter = Router();

// Shared by every report page's filter bar/footer: open to anyone who can View at least one dashboard
// (was Tachometer only, which broke the filters on every other page for a role without Tachometer).
metaRouter.use(requireAuth, requirePasswordChangeCleared, requireAnyDashboardView, attachUserContext);

metaRouter.get('/refresh-status', async (req, res, next) => {
  try {
    // Last Update / Last Order Created are admin-only data-validation timestamps: withheld from
    // everyone else (the frontend hides them too), who get only Last Refresh Time.
    const full = await fetchRefreshStatus(pool);
    const status = req.user?.isAdmin ? full : redactRefreshStatusForNonAdmin(full);
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
