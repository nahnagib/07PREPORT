import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requirePasswordChangeCleared } from '../middleware/permission';
import { isRegisteredAction } from '../config/permissionRegistry';
import { allows, getRequestPermissions } from '../services/permissionService';

/**
 * Server-side Export check for the dashboards' client-side exports.
 *
 * Every image/PDF/Excel/CSV a report page produces is built in the browser from data the page has
 * already loaded (View), so there is no file endpoint to guard. Instead, every export helper in
 * @07ps/ui asks this endpoint first (see packages/ui/src/exportPermission.ts) and produces no file
 * unless it answers 200 -- a user without Export on the page gets a 403 here, not a download.
 * Server-generated downloads (MARCOM error report / original file) check Export on their own routes.
 */
export const exportsRouter = Router();

exportsRouter.use(requireAuth, requirePasswordChangeCleared);

const FORMATS = new Set(['image', 'pdf', 'xlsx', 'csv']);

exportsRouter.post('/authorize', async (req, res, next) => {
  try {
    const { pageKey, format } = req.body ?? {};
    if (typeof pageKey !== 'string' || !isRegisteredAction(pageKey, 'export')) {
      res.status(400).json({ error: 'pageKey must be a page that supports export.' });
      return;
    }
    if (typeof format !== 'string' || !FORMATS.has(format)) {
      res.status(400).json({ error: `format must be one of: ${[...FORMATS].join(', ')}` });
      return;
    }
    if (!allows(await getRequestPermissions(req), pageKey, 'export')) {
      res.status(403).json({ error: 'You do not have permission to export from this page.' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
