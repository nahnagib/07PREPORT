import { Router, type NextFunction, type Request, type Response } from 'express';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { requirePasswordChangeCleared, requirePermission } from '../middleware/permission';
import { attachUserContext, resolveScopedFilters } from '../middleware/scopeContext';
import { allows, getRequestPermissions } from '../services/permissionService';
import type { Filters } from '../measures/filters';
import {
  FollowupConflictError,
  FollowupValidationError,
  createReason,
  deleteReason,
  fetchBoard,
  fetchCase,
  fetchCases,
  fetchOptions,
  listReasons,
  parseFollowupQuery,
  updateCase,
  updateReason,
} from '../services/npsFollowupService';
import { buildFollowupExport } from '../services/npsFollowupExportService';

/**
 * NPS Detractor Follow-up (Process department; services/npsFollowupService.ts; docs/nps-followup.md). Permission pages:
 *   nps_followup          View = board, list, case details; Edit = change a case; Export = the Excel download
 *   nps_followup_reasons  View / Create / Edit / Delete on the reason list
 * The customers' comments are shown only with View on nps_comments (exported only with Export on nps_comments).
 * Every case read goes through resolveScopedFilters (the role's data scope + the salesperson lock), like the NPS page.
 *
 *   GET    /nps-followup/options                   statuses, reasons, owners
 *   GET    /nps-followup/board?<filters>            the board (no Historical; Solved of the last 30 days) + KPIs
 *   GET    /nps-followup/cases?<filters>&page=&pageSize=   the List view (every case)
 *   GET    /nps-followup/cases/export?<filters>     .xlsx
 *   GET    /nps-followup/cases/:id                  details, comment, history
 *   PATCH  /nps-followup/cases/:id                  { version, status?, reasonId?, ownerUserId?, contactedAt?, solvedAt?,
 *                                                     rootCause?, actionTaken?, notes? } -> 409 when version is stale
 *   GET/POST/PATCH/DELETE /nps-followup/reasons[/:id]
 */
export const npsFollowupRouter = Router();

npsFollowupRouter.use(requireAuth, requirePasswordChangeCleared, attachUserContext, resolveScopedFilters);

const scoped = (req: Request): Filters => req.scopedFilters ?? {};

function sendError(err: unknown, res: Response, next: NextFunction): void {
  if (err instanceof FollowupConflictError) {
    res.status(409).json({ error: err.message, code: 'case.conflict', current: err.current });
    return;
  }
  if (err instanceof FollowupValidationError) {
    res.status(err.code.endsWith('notFound') ? 404 : 400).json({ error: err.message, code: err.code, field: err.field });
    return;
  }
  next(err);
}

type Handler = (req: Request, res: Response) => Promise<unknown>;

function handle(fn: Handler) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = await fn(req, res);
      if (body !== undefined) res.json(body);
    } catch (err) {
      sendError(err, res, next);
    }
  };
}

function idParam(req: Request, what: string): number {
  const n = Number(String(req.params.id).replace(/^#/, ''));
  if (!Number.isInteger(n) || n <= 0) throw new FollowupValidationError(`${what}.notFound`, `${what === 'case' ? 'Case' : 'Reason'} not found.`);
  return n;
}

const query = (req: Request) => parseFollowupQuery(req.query as Record<string, unknown>);

npsFollowupRouter.get('/options', requirePermission('nps_followup', 'view'), handle(() => fetchOptions(pool)));

npsFollowupRouter.get('/board', requirePermission('nps_followup', 'view'), handle((req) => fetchBoard(pool, query(req), scoped(req))));

npsFollowupRouter.get('/cases', requirePermission('nps_followup', 'view'), handle((req) => fetchCases(pool, query(req), scoped(req))));

// Before /cases/:id so "export" isn't read as a case number.
npsFollowupRouter.get(
  '/cases/export',
  requirePermission('nps_followup', 'export'),
  handle(async (req, res) => {
    const withComments = allows(await getRequestPermissions(req), 'nps_comments', 'export');
    const buffer = await buildFollowupExport(pool, query(req), scoped(req), withComments);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="nps-detractor-followup.xlsx"');
    res.send(buffer);
    return undefined;
  }),
);

npsFollowupRouter.get(
  '/cases/:id',
  requirePermission('nps_followup', 'view'),
  handle(async (req) => {
    const canSeeComments = allows(await getRequestPermissions(req), 'nps_comments', 'view');
    const found = await fetchCase(pool, idParam(req, 'case'), scoped(req), canSeeComments);
    if (!found) throw new FollowupValidationError('case.notFound', 'Case not found.');
    return { case: found };
  }),
);

npsFollowupRouter.patch(
  '/cases/:id',
  requirePermission('nps_followup', 'edit'),
  handle(async (req) => ({ case: await updateCase(pool, idParam(req, 'case'), req.body ?? {}, scoped(req), req.user!.id) })),
);

npsFollowupRouter.get('/reasons', requirePermission('nps_followup_reasons', 'view'), handle(async () => ({ rows: await listReasons(pool) })));

npsFollowupRouter.post(
  '/reasons',
  requirePermission('nps_followup_reasons', 'create'),
  handle(async (req, res) => {
    res.status(201);
    return { row: await createReason(pool, req.body ?? {}, req.user!.id) };
  }),
);

npsFollowupRouter.patch(
  '/reasons/:id',
  requirePermission('nps_followup_reasons', 'edit'),
  handle(async (req) => ({ row: await updateReason(pool, idParam(req, 'reason'), req.body ?? {}, req.user!.id) })),
);

npsFollowupRouter.delete(
  '/reasons/:id',
  requirePermission('nps_followup_reasons', 'delete'),
  handle(async (req) => {
    await deleteReason(pool, idParam(req, 'reason'));
    return { success: true };
  }),
);
