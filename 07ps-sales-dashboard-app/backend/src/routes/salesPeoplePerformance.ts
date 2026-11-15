import { Router, type Request } from 'express';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { requirePasswordChangeCleared, requirePermission } from '../middleware/permission';
import { attachUserContext, resolveScopedFilters } from '../middleware/scopeContext';
import { applyRoleDataScope, applySalespersonLock, type Filters } from '../measures/filters';
import { computePersonContributions, computeSalesPeoplePerformance, DIRECTOR_CHANNELS, type DirectorChannel } from '../measures/salesPeoplePerformance';

export const salesPeoplePerformanceRouter = Router();
salesPeoplePerformanceRouter.use(requireAuth, requirePasswordChangeCleared,
  requirePermission('sales_people_performance', 'view'), attachUserContext, resolveScopedFilters);

salesPeoplePerformanceRouter.use((req, res, next) => {
  const raw = req.query.anchorDate;
  const anchor = typeof raw === 'string' ? new Date(`${raw}T00:00:00.000Z`) : null;
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || !anchor ||
      !Number.isFinite(anchor.getTime()) || anchor.toISOString().slice(0, 10) !== raw) {
    res.status(400).json({ error: 'A valid anchorDate (YYYY-MM-DD) is required.' });
    return;
  }
  res.locals.anchor = anchor;
  next();
});

/**
 * The director cards (2026-11-15): each is the page's filters with Customer Group = that channel, then the caller's own
 * role scope and salesperson lock, exactly as for any request -- a B2B Director (role scope Customer Group B2B) never
 * gets the B2C card (applyRoleDataScope refuses it), and a salesperson gets no director card at all.
 */
export function directorFiltersFor(scoped: Filters, context: NonNullable<Request['userContext']>):
  Partial<Record<DirectorChannel, Filters | null>> {
  const out: Partial<Record<DirectorChannel, Filters | null>> = {};
  for (const d of DIRECTOR_CHANNELS) {
    if (context.roleCode === 'SALESPERSON') { out[d.channel] = null; continue; }
    try {
      out[d.channel] = applySalespersonLock(applyRoleDataScope({ ...scoped, segmentKeys: [d.segmentKey] }, context.dataScopeRules ?? []), context);
    } catch {
      out[d.channel] = null;
    }
  }
  return out;
}

salesPeoplePerformanceRouter.get('/overview', async (req, res, next) => {
  try {
    res.json(await computeSalesPeoplePerformance(pool, res.locals.anchor, req.scopedFilters!, {
      directorFilters: directorFiltersFor(req.scopedFilters!, req.userContext!),
      // why the people do not add up to the company total: admins only
      withReconciliation: req.user?.isAdmin === true,
    }));
  } catch (err) { next(err); }
});

salesPeoplePerformanceRouter.get('/contributions/:personKey', async (req, res, next) => {
  try {
    const personKey = Number(req.params.personKey);
    if (!Number.isSafeInteger(personKey) || personKey <= 0) {
      res.status(400).json({ error: 'A valid salesperson is required.' });
      return;
    }
    const context = req.userContext!;
    // Denominators may remove UI filters, but never the caller's role or salesperson restrictions.
    const authorized = applySalespersonLock(applyRoleDataScope({}, context.dataScopeRules ?? []), context);
    if (authorized.salespersonKeys?.length && !authorized.salespersonKeys.includes(personKey)) {
      res.status(403).json({ error: 'Forbidden: request is outside your assigned scope.' });
      return;
    }
    res.json(await computePersonContributions(pool, res.locals.anchor, authorized, personKey));
  } catch (err) { next(err); }
});
