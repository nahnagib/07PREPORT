import { Router } from 'express';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { requirePasswordChangeCleared, requirePermission } from '../middleware/permission';
import { attachUserContext, resolveScopedFilters } from '../middleware/scopeContext';
import { applyRoleDataScope, applySalespersonLock } from '../measures/filters';
import { computePersonContributions, computeSalesPeoplePerformance } from '../measures/salesPeoplePerformance';

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

salesPeoplePerformanceRouter.get('/overview', async (req, res, next) => {
  try {
    res.json(await computeSalesPeoplePerformance(pool, res.locals.anchor, req.scopedFilters!));
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
