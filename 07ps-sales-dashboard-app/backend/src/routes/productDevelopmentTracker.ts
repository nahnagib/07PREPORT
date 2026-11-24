import { NextFunction, Request, Response, Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/auth';
import { requireAdminRole, requirePasswordChangeCleared, requirePermission } from '../middleware/permission';
import { ValidationError } from '../lib/errors';
import { allows, getRequestPermissions } from '../services/permissionService';
import type { PermissionAction } from '../config/permissionRegistry';
import { PdpError } from '../services/pdp/errors';
import { BLOCKER_KINDS, BLOCKER_STATUSES, HEALTHS, NOT_SET, PRIORITIES, STAGES, isValidIsoDate, type Filters } from '../services/pdt/rules';
import * as svc from '../services/pdt/trackerService';
import { exportDashboard, exportFollowup } from '../services/pdt/exportService';
import { confirmImport, exportWorkbook, importHistory, previewImport } from '../services/pdt/importService';

/**
 * Product Development Plan: the dashboard and its data entry & follow-up (the "tracker", pdt_* tables, migration 0080;
 * docs/product-development-standalone.md). Mounted at /product-development/tracker, before the TIKA gate module's router.
 * Permission pages (config/permissionRegistry.ts, both created by 0077 and shared with the gate module):
 *   product_development_plan   View = dashboard and read-only product details; Export = the dashboard Excel
 *   product_development_entry  View = the entry screens and the follow-up board; Create / Edit / Delete = the forms;
 *                              Export = the dashboard and follow-up Excel
 * The drop-down lists and the follow-up settings are Admin-role only (like the Kaizen drop-downs).
 *
 *   GET    /options                         lists, settings, owner pickers, today
 *   GET    /dashboard?<filters>             KPIs, pipeline, tracker, roadmap, open blockers & decisions
 *   GET    /dashboard/export?<filters>      .xlsx
 *   GET    /products?<filters>              the register
 *   GET    /products/:code                  details, stage timeline, updates, blockers, last updated by
 *   POST   /products                        create (stage may be set on creation only)
 *   PATCH  /products/:code                  edit (not the stage)
 *   DELETE /products/:code                  soft delete
 *   POST   /products/:code/stage            { toStage, comment, actualLaunch? }
 *   POST   /products/:code/updates          status update (copies health / readiness onto the product)
 *   PATCH  /updates/:id   DELETE /updates/:id   (PATCH { nextStepDone } marks the next step done)
 *   GET    /blockers?<filters>&status=&kind=  POST /blockers   PATCH /blockers/:id   POST /blockers/:id/resolve   DELETE /blockers/:id
 *   GET    /followup?<filters>   GET /followup/export?<filters>
 *   POST   /import/preview   POST /import/confirm (file + sha256)   GET /import/history   GET /import/export
 *   GET/POST /admin/dropdowns   PATCH/DELETE /admin/dropdowns/:id   PUT /admin/settings
 * Filters: familyIds, subfamilies, brands, stages, health, owners, priorities (comma lists; NONE = not set), launchFrom, launchTo,
 * search.
 */
export const productDevelopmentTrackerRouter = Router();

productDevelopmentTrackerRouter.use(requireAuth, requirePasswordChangeCleared);

const PLAN = 'product_development_plan';
const ENTRY = 'product_development_entry';

function sendError(err: unknown, res: Response, next: NextFunction): void {
  if (err instanceof PdpError) {
    res.status(err.status).json({ error: err.message, code: err.code, field: err.field });
    return;
  }
  if (err instanceof ValidationError) {
    res.status(400).json({ error: err.message });
    return;
  }
  next(err);
}

// eslint-disable-next-line no-unused-vars -- parameter names of a function type (the base rule misreads them)
type Handler = (req: Request, res: Response) => Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  // Through a promise, so a synchronous throw (e.g. a bad :id) gets the same error handling as a rejected call.
  Promise.resolve()
    .then(() => fn(req, res))
    .then((body) => {
      if (body !== undefined && !res.headersSent) res.json(body);
    })
    .catch((err) => sendError(err, res, next));
};

function requireAny(...pairs: [string, PermissionAction][]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const perms = await getRequestPermissions(req);
      if (!pairs.some(([p, a]) => allows(perms, p, a))) {
        res.status(403).json({ error: 'You do not have permission to access this resource.' });
        return;
      }
    } catch (err) {
      next(err);
      return;
    }
    next();
  };
}

const canRead = requireAny([PLAN, 'view'], [ENTRY, 'view']);
const canExport = requireAny([PLAN, 'export'], [ENTRY, 'export']);

const uid = (req: Request): number => req.user!.id;

function list(v: unknown): string[] {
  const parts = (Array.isArray(v) ? v : v === undefined ? [] : [v]).flatMap((x) => String(x).split(','));
  return parts.map((s) => s.trim()).filter(Boolean);
}

function pick<T extends string>(v: unknown, allowed: readonly T[]): T[] {
  return list(v).filter((s): s is T => (allowed as readonly string[]).includes(s));
}

export function parseFilters(q: Request['query']): Filters {
  const date = (v: unknown) => (isValidIsoDate(v) ? v : undefined);
  return {
    familyIds: list(q.familyIds).map(Number).filter((n) => Number.isInteger(n) && n > 0),
    subfamilies: list(q.subfamilies),
    brands: list(q.brands),
    stages: pick(q.stages, STAGES),
    owners: list(q.owners),
    // NONE = "not set" (blank in the Excel file)
    priorities: pick(q.priorities, [...PRIORITIES, NOT_SET]),
    health: pick(q.health, [...HEALTHS, NOT_SET]),
    launchFrom: date(q.launchFrom),
    launchTo: date(q.launchTo),
    search: typeof q.search === 'string' && q.search.trim() ? q.search.trim().slice(0, 100) : undefined,
  };
}

function idParam(req: Request, what: string): number {
  const n = Number(req.params.id);
  if (!Number.isInteger(n) || n <= 0) throw new PdpError(`${what}.notFound`, `${what.charAt(0).toUpperCase()}${what.slice(1)} not found.`);
  return n;
}

const codeParam = (req: Request): string => String(req.params.code).toUpperCase();

function sendXlsx(res: Response, buffer: Buffer, name: string): undefined {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(buffer);
  return undefined;
}

const r = productDevelopmentTrackerRouter;

r.get('/options', canRead, h(async (req) => {
  const o = await svc.getOptions();
  // The app-user picker is for the entry forms only.
  const canEnter = allows(await getRequestPermissions(req), ENTRY, 'view');
  return { ...o, users: canEnter ? o.users : [] };
}));

r.get('/dashboard', canRead, h((req) => svc.getDashboard(parseFilters(req.query))));
r.get('/dashboard/export', canExport, h(async (req, res) => sendXlsx(res, await exportDashboard(parseFilters(req.query)), 'product-development-dashboard.xlsx')));

r.get('/products', canRead, h(async (req) => ({ rows: await svc.listProducts(parseFilters(req.query)) })));
r.get('/products/:code', canRead, h((req) => svc.getProduct(codeParam(req))));
r.post('/products', requirePermission(ENTRY, 'create'), h(async (req, res) => {
  res.status(201);
  return svc.createProduct(req.body ?? {}, uid(req));
}));
r.patch('/products/:code', requirePermission(ENTRY, 'edit'), h((req) => svc.updateProduct(codeParam(req), req.body ?? {}, uid(req))));
r.delete('/products/:code', requirePermission(ENTRY, 'delete'), h(async (req) => {
  await svc.deleteProduct(codeParam(req), uid(req));
  return { success: true };
}));
r.post('/products/:code/stage', requirePermission(ENTRY, 'edit'), h((req) => svc.changeStage(codeParam(req), req.body ?? {}, uid(req))));

r.post('/products/:code/updates', requirePermission(ENTRY, 'create'), h(async (req, res) => {
  res.status(201);
  return svc.postUpdate(codeParam(req), req.body ?? {}, uid(req));
}));
r.patch('/updates/:id', requirePermission(ENTRY, 'edit'), h((req) => svc.editUpdate(idParam(req, 'update'), req.body ?? {}, uid(req))));
r.delete('/updates/:id', requirePermission(ENTRY, 'delete'), h((req) => svc.deleteUpdate(idParam(req, 'update'), uid(req))));

r.get('/blockers', requirePermission(ENTRY, 'view'), h(async (req) => ({
  rows: await svc.listBlockers(parseFilters(req.query), { status: pick(req.query.status, BLOCKER_STATUSES), kind: pick(req.query.kind, BLOCKER_KINDS) }),
})));
r.post('/blockers', requirePermission(ENTRY, 'create'), h(async (req, res) => {
  res.status(201);
  return svc.createBlocker(req.body ?? {}, uid(req));
}));
r.patch('/blockers/:id', requirePermission(ENTRY, 'edit'), h((req) => svc.updateBlocker(idParam(req, 'blocker'), req.body ?? {}, uid(req))));
r.post('/blockers/:id/resolve', requirePermission(ENTRY, 'edit'), h((req) => svc.resolveBlocker(idParam(req, 'blocker'), req.body ?? {}, uid(req))));
r.delete('/blockers/:id', requirePermission(ENTRY, 'delete'), h(async (req) => ({ success: true, ...(await svc.deleteBlocker(idParam(req, 'blocker'), uid(req))) })));

r.get('/followup', requirePermission(ENTRY, 'view'), h((req) => svc.getFollowup(parseFilters(req.query))));
r.get('/followup/export', requirePermission(ENTRY, 'export'), h(async (req, res) => sendXlsx(res, await exportFollowup(parseFilters(req.query)), 'product-development-followup.xlsx')));

// ---- Excel file (Input/product_development/Product_Development_Input.xlsx) -------------------------------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/\.xlsx$/i.test(file.originalname)) cb(null, true);
    else cb(new PdpError('import.fileType', 'Only .xlsx files are accepted.', 'file'));
  },
});

type UploadedFile = NonNullable<Request['file']>;

/** multer -> the uploaded file (max 10 MB, .xlsx), or a { code, field } error. */
// eslint-disable-next-line no-unused-vars -- parameter names of a function type (the base rule misreads them)
function withFile(fn: (file: UploadedFile, req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    upload.single('file')(req, res, (uploadErr: unknown) => {
      if (uploadErr) {
        sendError(uploadErr instanceof PdpError ? uploadErr : new PdpError('import.upload', 'The file could not be uploaded (max 10 MB, .xlsx).', 'file'), res, next);
        return;
      }
      if (!req.file) {
        sendError(new PdpError('import.noFile', 'Choose the Excel file to upload.', 'file'), res, next);
        return;
      }
      h((rq, rs) => fn(req.file!, rq, rs))(req, res, next);
    });
  };
}

// Original file names arrive as latin1 from busboy.
const fileName = (f: UploadedFile) => Buffer.from(f.originalname, 'latin1').toString('utf8');

/** Preview: counts, row errors, what changes. Writes nothing. */
r.post('/import/preview', requireAny([ENTRY, 'create'], [ENTRY, 'edit']), withFile((f) => previewImport(f.buffer, fileName(f))));
/** Confirm: the same file again (checked by the preview's sha256), applied in one transaction. Needs Create and Edit. */
r.post('/import/confirm', requirePermission(ENTRY, 'create'), requirePermission(ENTRY, 'edit'), withFile((f, req) => confirmImport(f.buffer, fileName(f), req.body?.sha256, uid(req))));
r.get('/import/history', requirePermission(ENTRY, 'view'), h(async () => ({ rows: await importHistory() })));
/** The register in the input file's format, to edit and import again. */
r.get('/import/export', requireAny([ENTRY, 'export'], [PLAN, 'export']), h(async (_req, res) => sendXlsx(res, await exportWorkbook(), 'Product_Development_Input.xlsx')));

r.get('/admin/dropdowns', requireAdminRole, h(async () => ({ rows: await svc.listDropdowns(undefined, true), settings: await svc.getSettings() })));
r.post('/admin/dropdowns', requireAdminRole, h(async (req, res) => {
  res.status(201);
  return { row: await svc.createDropdown(req.body ?? {}, uid(req)) };
}));
r.patch('/admin/dropdowns/:id', requireAdminRole, h(async (req) => ({ row: await svc.updateDropdown(idParam(req, 'dropdown'), req.body ?? {}, uid(req)) })));
r.delete('/admin/dropdowns/:id', requireAdminRole, h(async (req) => {
  await svc.deleteDropdown(idParam(req, 'dropdown'), uid(req));
  return { success: true };
}));
r.put('/admin/settings', requireAdminRole, h(async (req) => ({ settings: await svc.updateSettings(req.body ?? {}, uid(req)) })));
