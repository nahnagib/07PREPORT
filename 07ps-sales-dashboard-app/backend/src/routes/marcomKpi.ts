import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requirePasswordChangeCleared, requirePermission } from '../middleware/permission';
import { KpiParamError } from '../marcomKpi/params';
import { campaignsPage, digitalPage, spendingPage, tradePage } from '../marcomKpi/pages';

/**
 * Data endpoints for the four MARCOM report pages. Each route is gated by that page's own view
 * permission (registered in migration 0022) -- NOT the upload permission -- and the check happens
 * here on the server for every request. Responses are chart-ready and contain no formatted strings.
 */
export const marcomKpiRouter = Router();

function page(pageKey: string, handler: (q: Record<string, unknown>) => Promise<unknown>): RequestHandler[] {
  return [
    requireAuth,
    requirePasswordChangeCleared,
    requirePermission(pageKey, 'view'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.json(await handler(req.query as Record<string, unknown>));
      } catch (err) {
        if (err instanceof KpiParamError) {
          res.status(400).json({ error: err.message, code: 'BAD_PARAMS' });
          return;
        }
        next(err);
      }
    },
  ];
}

marcomKpiRouter.get('/spending', ...page('marcom_spending', spendingPage));
marcomKpiRouter.get('/campaigns', ...page('marcom_media_campaigns', campaignsPage));
marcomKpiRouter.get('/digital', ...page('marcom_digital', digitalPage));
marcomKpiRouter.get('/trade', ...page('marcom_trade', tradePage));
