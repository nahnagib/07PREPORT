import { NextFunction, Request, Response, Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/auth';
import { requireAdminRole, requirePasswordChangeCleared, requirePermission } from '../middleware/permission';
import { ValidationError } from '../lib/errors';
import { allows, getRequestPermissions } from '../services/permissionService';
import type { PermissionAction } from '../config/permissionRegistry';
import { PdpError } from '../services/pdp/errors';
import { assertCompanyAllowed, tikaCompanyKey } from '../services/pdp/company';
import * as cfg from '../services/pdp/configService';
import * as tree from '../services/pdp/treeService';
import * as proj from '../services/pdp/projectService';
import * as mon from '../services/pdp/monitorService';
import * as att from '../services/pdp/attachmentService';
import * as exp from '../services/pdp/exportService';
import { IMPORT_FILES, importFolder, readImportFolder, runImport, type ImportFiles } from '../services/pdp/importService';
import { CLASSIFICATIONS, GATES, STATES } from '../services/pdp/rules';

/**
 * Product Development Plan (Product department, TIKA only). Three permission pages (config/permissionRegistry.ts):
 *   product_development_plan      View = the read-only views; Export = the Excel downloads
 *   product_development_entry     View/Create/Edit/Delete/Export = every form (Export = the same downloads)
 *   product_development_approval  Edit = approve / reject / revise a gate -- AND the user must hold the governance role
 *                                 the gate's sign-off needs (checked in services/pdp/rules.ts evaluateDecision)
 * Configuration that decides who approves what (governance members, gate rules, scoring criteria, settings, KPI
 * targets) and the one-time import are Admin-role only. Every request runs against TIKA's company key; a request naming
 * any other company (Majaal) is refused with company.notAllowed.
 */
export const productDevelopmentRouter = Router();

productDevelopmentRouter.use(requireAuth, requirePasswordChangeCleared);

const PLAN = 'product_development_plan';
const ENTRY = 'product_development_entry';
const APPROVAL = 'product_development_approval';

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

/** Wraps a handler: PdpError -> `{ error, code, field }`, anything else -> the generic 500 handler. */
type Handler = (req: Request, res: Response) => Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch((err) => sendError(err, res, next));
};

/** Any of the listed page/action pairs (e.g. plan View or entry View). */
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

const canRead = requireAny([PLAN, 'view'], [ENTRY, 'view'], [APPROVAL, 'view']);
const canExport = requireAny([PLAN, 'export'], [ENTRY, 'export']);

/** TIKA's key on res.locals.ck; a body/query naming another company is refused. */
productDevelopmentRouter.use((req: Request, res: Response, next: NextFunction) => {
  tikaCompanyKey()
    .then((tika) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      for (const v of [body.companyKey, body.company_key, req.query.companyKey, req.query.company_key]) assertCompanyAllowed(v, tika);
      res.locals.ck = tika;
      next();
    })
    .catch((err) => sendError(err, res, next));
});

const ck = (res: Response): number => res.locals.ck as number;
const uid = (req: Request): number => req.user!.id;
const isAdmin = (req: Request): boolean => req.user!.isAdmin === true;
const roles = (req: Request, res: Response) => cfg.userGovernanceRoles(ck(res), uid(req));
const num = (v: unknown): number | undefined => (v === undefined || v === '' ? undefined : Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
function pid(req: Request, name = 'id'): number {
  const n = Number(req.params[name]);
  if (!Number.isInteger(n) || n <= 0) throw new PdpError('record.notFound', 'Record not found.');
  return n;
}

// ---------------------------------------------------------------------------- reads

/** Drop-downs, tree pickers, governance and the viewer's own roles/permissions for this module. */
productDevelopmentRouter.get('/options', canRead, h(async (req, res) => {
  const perms = await getRequestPermissions(req);
  const entry = allows(perms, ENTRY, 'view') || allows(perms, APPROVAL, 'view');
  const [dropdowns, governance, criteria, settings, t, myRoles, users, templates, rules, warnings] = await Promise.all([
    cfg.listDropdowns(ck(res)), cfg.listGovernance(ck(res)), cfg.listCriteria(ck(res), true), cfg.getSettings(ck(res)), tree.getTree(ck(res)),
    roles(req, res), entry ? cfg.listActiveUsers() : Promise.resolve([]), cfg.listChecklistTemplates(ck(res)), cfg.listGateRules(ck(res)), cfg.approverWarnings(ck(res)),
  ]);
  res.json({
    dropdowns, governance, criteria, settings, myRoles, users, checklistTemplates: templates, gateRules: rules, noApprover: warnings,
    families: t.flatMap((b) => b.families.map((f) => ({ family_id: f.family_id, brand_id: b.brand_id, brand: b.name, name: f.name, subfamilies: f.subfamilies.map((s) => ({ subfamily_id: s.subfamily_id, name: s.name })) }))),
    products: t.flatMap((b) => b.families.flatMap((f) => f.subfamilies.flatMap((s) => s.products.map((p) => ({ product_id: p.product_id, name: p.name, status: p.status, family: f.name, subfamily: s.name }))))),
    brands: t.map((b) => ({ brand_id: b.brand_id, name: b.name })),
    importFolder: isAdmin(req) && importFolder() !== null,
    enums: { classifications: CLASSIFICATIONS, gates: GATES, states: STATES },
  });
}));

productDevelopmentRouter.get('/overview', canRead, h(async (req, res) => {
  res.json(await mon.getOverview(ck(res), str(req.query.quarter), { userId: uid(req), roles: await roles(req, res) }));
}));
productDevelopmentRouter.get('/tree', canRead, h(async (_req, res) => { res.json({ tree: await tree.getTree(ck(res)) }); }));
productDevelopmentRouter.get('/roadmap', canRead, h(async (_req, res) => { res.json(await mon.getRoadmap(ck(res))); }));
productDevelopmentRouter.get('/products/:id', canRead, h(async (req, res) => { res.json(await mon.getProductPanel(ck(res), pid(req))); }));
productDevelopmentRouter.get('/products/:id/sales', canRead, h(async (req, res) => { res.json(await mon.launchSales(ck(res), pid(req))); }));

function projectFilters(q: Request['query']) {
  const ids = typeof q.ids === 'string' ? q.ids.split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0) : undefined;
  return {
    classification: str(q.classification), projectTypeId: num(q.projectTypeId), familyId: num(q.familyId), ownerUserId: num(q.ownerUserId),
    fastTrack: q.fastTrack === '1' || q.fastTrack === 'true', state: str(q.state), gate: str(q.gate), search: str(q.search), ids,
  };
}

productDevelopmentRouter.get('/projects', canRead, h(async (req, res) => { res.json({ projects: await proj.listProjects(ck(res), projectFilters(req.query)) }); }));
productDevelopmentRouter.get('/projects/export', canExport, h(async (req, res) => {
  const buf = await exp.exportProjects(ck(res), projectFilters(req.query));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="rd-projects.xlsx"');
  res.send(buf);
}));
productDevelopmentRouter.get('/projects/:code', canRead, h(async (req, res) => {
  res.json(await proj.getProject(ck(res), String(req.params.code), { userId: uid(req), roles: await roles(req, res) }));
}));
productDevelopmentRouter.get('/tree/export', canExport, h(async (_req, res) => {
  const buf = await exp.exportTree(ck(res));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="xtreme-product-tree.xlsx"');
  res.send(buf);
}));
productDevelopmentRouter.get('/launches', canRead, h(async (_req, res) => { res.json(await mon.listLaunches(ck(res))); }));
productDevelopmentRouter.get('/feedback', canRead, h(async (req, res) => {
  res.json(await mon.listFeedback(ck(res), { productId: num(req.query.productId), status: str(req.query.status) }));
}));
productDevelopmentRouter.get('/feedback/export', canExport, h(async (req, res) => {
  const buf = await exp.exportFeedback(ck(res), { productId: num(req.query.productId), status: str(req.query.status) });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="customer-feedback.xlsx"');
  res.send(buf);
}));
productDevelopmentRouter.get('/feedback/:id/history', canRead, h(async (req, res) => { res.json({ history: await mon.feedbackHistoryList(ck(res), pid(req)) }); }));
productDevelopmentRouter.get('/policy', canRead, h(async (req, res) => { res.json(await cfg.getPolicy(ck(res), num(req.query.version) ?? null)); }));
productDevelopmentRouter.get('/reference', canRead, h(async (_req, res) => {
  const [criteria, governance, gaps, kpiTargets, settings, rules, templates, years, warnings] = await Promise.all([
    cfg.listCriteria(ck(res), false), cfg.listGovernance(ck(res)), cfg.listGapItems(ck(res)), cfg.listKpiTargets(ck(res)), cfg.getSettings(ck(res)),
    cfg.listGateRules(ck(res)), cfg.listChecklistTemplates(ck(res)), cfg.listRoadmapYears(ck(res)), cfg.approverWarnings(ck(res)),
  ]);
  res.json({ criteria, governance, gaps, kpiTargets, settings, gateRules: rules, checklistTemplates: templates, roadmapYears: years, noApprover: warnings });
}));
productDevelopmentRouter.get('/attachments/:id', canRead, h(async (req, res) => {
  const a = await att.getAttachment(ck(res), pid(req));
  res.setHeader('Content-Type', a.mime_type);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(a.file_name)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(a.content);
}));

// Pickers (entry forms)
productDevelopmentRouter.get('/odoo-products', requireAny([ENTRY, 'view'], [APPROVAL, 'view']), h(async (req, res) => {
  res.json({ products: await tree.searchOdooProducts(ck(res), String(req.query.q ?? '')) });
}));
productDevelopmentRouter.get('/customers', requirePermission(ENTRY, 'view'), h(async (req, res) => {
  res.json({ customers: await tree.searchTikaCustomers(ck(res), String(req.query.q ?? '')) });
}));

// ---------------------------------------------------------------------------- product tree entry

productDevelopmentRouter.post('/families', requirePermission(ENTRY, 'create'), h(async (req, res) => { res.status(201).json(await tree.saveFamily(ck(res), null, req.body ?? {}, uid(req))); }));
productDevelopmentRouter.patch('/families/:id', requirePermission(ENTRY, 'edit'), h(async (req, res) => { res.json(await tree.saveFamily(ck(res), pid(req), req.body ?? {}, uid(req))); }));
productDevelopmentRouter.delete('/families/:id', requirePermission(ENTRY, 'delete'), h(async (req, res) => { await tree.retireFamily(ck(res), pid(req), uid(req)); res.json({ success: true }); }));
productDevelopmentRouter.post('/subfamilies', requirePermission(ENTRY, 'create'), h(async (req, res) => { res.status(201).json(await tree.saveSubfamily(ck(res), null, req.body ?? {}, uid(req))); }));
productDevelopmentRouter.patch('/subfamilies/:id', requirePermission(ENTRY, 'edit'), h(async (req, res) => { res.json(await tree.saveSubfamily(ck(res), pid(req), req.body ?? {}, uid(req))); }));
productDevelopmentRouter.delete('/subfamilies/:id', requirePermission(ENTRY, 'delete'), h(async (req, res) => { await tree.retireSubfamily(ck(res), pid(req), uid(req)); res.json({ success: true }); }));
productDevelopmentRouter.post('/products', requirePermission(ENTRY, 'create'), h(async (req, res) => { res.status(201).json(await tree.createProduct(ck(res), req.body ?? {}, uid(req))); }));
productDevelopmentRouter.patch('/products/:id', requirePermission(ENTRY, 'edit'), h(async (req, res) => { res.json(await tree.updateProduct(ck(res), pid(req), req.body ?? {}, uid(req))); }));
productDevelopmentRouter.delete('/products/:id', requirePermission(ENTRY, 'delete'), h(async (req, res) => { await tree.deleteProduct(ck(res), pid(req), uid(req)); res.json({ success: true }); }));

// ---------------------------------------------------------------------------- projects entry

const code = (req: Request) => String(req.params.code);
productDevelopmentRouter.post('/projects', requirePermission(ENTRY, 'create'), h(async (req, res) => { res.status(201).json(await proj.createProject(ck(res), req.body ?? {}, uid(req))); }));
productDevelopmentRouter.patch('/projects/:code', requirePermission(ENTRY, 'edit'), h(async (req, res) => { res.json(await proj.updateProject(ck(res), code(req), req.body ?? {}, uid(req), isAdmin(req))); }));
productDevelopmentRouter.delete('/projects/:code', requirePermission(ENTRY, 'delete'), h(async (req, res) => { await proj.deleteProject(ck(res), code(req), uid(req)); res.json({ success: true }); }));
productDevelopmentRouter.post('/projects/:code/submit', requirePermission(ENTRY, 'edit'), h(async (req, res) => { res.json(await proj.submitProject(ck(res), code(req), req.body ?? {}, uid(req), await roles(req, res))); }));
productDevelopmentRouter.post('/projects/:code/scores', requirePermission(ENTRY, 'edit'), h(async (req, res) => { res.status(201).json(await proj.addScoreRound(ck(res), code(req), req.body ?? {}, uid(req), isAdmin(req))); }));
productDevelopmentRouter.post('/projects/:code/members', requirePermission(ENTRY, 'edit'), h(async (req, res) => { res.status(201).json(await proj.addMember(ck(res), code(req), req.body ?? {}, uid(req), isAdmin(req))); }));
productDevelopmentRouter.delete('/projects/:code/members/:id', requirePermission(ENTRY, 'edit'), h(async (req, res) => { await proj.removeMember(ck(res), code(req), pid(req), uid(req), isAdmin(req)); res.json({ success: true }); }));
productDevelopmentRouter.patch('/projects/:code/checklist/:id', requirePermission(ENTRY, 'edit'), h(async (req, res) => { await proj.updateChecklistItem(ck(res), code(req), pid(req), req.body ?? {}, uid(req), isAdmin(req)); res.json({ success: true }); }));
productDevelopmentRouter.post('/projects/:code/lab-tests', requirePermission(ENTRY, 'create'), h(async (req, res) => { res.status(201).json(await proj.saveLabTest(ck(res), code(req), null, req.body ?? {}, uid(req), isAdmin(req))); }));
productDevelopmentRouter.patch('/projects/:code/lab-tests/:id', requirePermission(ENTRY, 'edit'), h(async (req, res) => { res.json(await proj.saveLabTest(ck(res), code(req), pid(req), req.body ?? {}, uid(req), isAdmin(req))); }));
productDevelopmentRouter.post('/projects/:code/field-trials', requirePermission(ENTRY, 'create'), h(async (req, res) => { res.status(201).json(await proj.saveFieldTrial(ck(res), code(req), null, req.body ?? {}, uid(req), isAdmin(req))); }));
productDevelopmentRouter.patch('/projects/:code/field-trials/:id', requirePermission(ENTRY, 'edit'), h(async (req, res) => { res.json(await proj.saveFieldTrial(ck(res), code(req), pid(req), req.body ?? {}, uid(req), isAdmin(req))); }));
productDevelopmentRouter.post('/projects/:code/pilot-batches', requirePermission(ENTRY, 'create'), h(async (req, res) => { res.status(201).json(await proj.savePilotBatch(ck(res), code(req), null, req.body ?? {}, uid(req), isAdmin(req))); }));
productDevelopmentRouter.patch('/projects/:code/pilot-batches/:id', requirePermission(ENTRY, 'edit'), h(async (req, res) => { res.json(await proj.savePilotBatch(ck(res), code(req), pid(req), req.body ?? {}, uid(req), isAdmin(req))); }));
productDevelopmentRouter.post('/projects/:code/pilot-batches/:id/confirm', requirePermission(ENTRY, 'edit'), h(async (req, res) => {
  await proj.confirmPilotBatch(ck(res), code(req), pid(req), String(req.body?.kind ?? ''), uid(req), await roles(req, res), isAdmin(req));
  res.json({ success: true });
}));
productDevelopmentRouter.post('/projects/:code/doc-errors', requirePermission(ENTRY, 'create'), h(async (req, res) => { res.status(201).json(await proj.saveDocError(ck(res), code(req), null, req.body ?? {}, uid(req), await roles(req, res), isAdmin(req))); }));
productDevelopmentRouter.patch('/projects/:code/doc-errors/:id', requirePermission(ENTRY, 'edit'), h(async (req, res) => { res.json(await proj.saveDocError(ck(res), code(req), pid(req), req.body ?? {}, uid(req), await roles(req, res), isAdmin(req))); }));
productDevelopmentRouter.delete('/projects/:code/:kind(lab-tests|field-trials|pilot-batches|doc-errors)/:id', requirePermission(ENTRY, 'delete'), h(async (req, res) => {
  await proj.deleteChild(ck(res), code(req), String(req.params.kind), pid(req), uid(req), isAdmin(req), await roles(req, res));
  res.json({ success: true });
}));
productDevelopmentRouter.post('/projects/:code/hold', requirePermission(ENTRY, 'edit'), h(async (req, res) => { await proj.holdProject(ck(res), code(req), req.body ?? {}, uid(req)); res.json({ success: true }); }));
productDevelopmentRouter.post('/projects/:code/resume', requirePermission(ENTRY, 'edit'), h(async (req, res) => { await proj.resumeProject(ck(res), code(req), req.body ?? {}, uid(req), await roles(req, res)); res.json({ success: true }); }));
productDevelopmentRouter.post('/projects/:code/close', requirePermission(ENTRY, 'edit'), h(async (req, res) => { await proj.closeProject(ck(res), code(req), req.body ?? {}, uid(req), await roles(req, res), isAdmin(req)); res.json({ success: true }); }));

/** Gate decision: the approval permission here, the governance role in the service (holding the permission alone is not enough). */
productDevelopmentRouter.post('/projects/:code/decisions', requirePermission(APPROVAL, 'edit'), h(async (req, res) => {
  res.json(await proj.decide(ck(res), code(req), req.body ?? {}, uid(req), await roles(req, res)));
}));

// ---------------------------------------------------------------------------- attachments

const attachmentUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: att.MAX_ATTACHMENT_BYTES, files: 1, fields: 5 } });
productDevelopmentRouter.post('/attachments', requirePermission(ENTRY, 'create'), (req, res, next) => {
  attachmentUpload.single('file')(req, res, (uploadErr: unknown) => {
    if (uploadErr) {
      const tooBig = (uploadErr as { code?: string }).code === 'LIMIT_FILE_SIZE';
      sendError(new PdpError(tooBig ? 'attachment.size' : 'attachment.upload', tooBig ? 'Files are limited to 10 MB.' : 'The file could not be uploaded.', 'file', tooBig ? 413 : 400), res, next);
      return;
    }
    if (!req.file) {
      sendError(new PdpError('attachment.noFile', 'No file uploaded.', 'file'), res, next);
      return;
    }
    att.uploadAttachment(ck(res), req.body?.ownerType, req.body?.ownerId, req.file, uid(req), isAdmin(req))
      .then((r) => res.status(201).json(r))
      .catch((err) => sendError(err, res, next));
  });
});
productDevelopmentRouter.delete('/attachments/:id', requirePermission(ENTRY, 'delete'), h(async (req, res) => { await att.deleteAttachment(ck(res), pid(req), uid(req), isAdmin(req)); res.json({ success: true }); }));

// ---------------------------------------------------------------------------- launches + feedback entry

productDevelopmentRouter.post('/launches', requirePermission(ENTRY, 'create'), h(async (req, res) => { res.status(201).json(await mon.createLaunch(ck(res), req.body ?? {}, uid(req))); }));
productDevelopmentRouter.patch('/launches/:id', requirePermission(ENTRY, 'edit'), h(async (req, res) => { await mon.updateLaunch(ck(res), pid(req), req.body ?? {}, uid(req)); res.json({ success: true }); }));
productDevelopmentRouter.post('/feedback', requirePermission(ENTRY, 'create'), h(async (req, res) => { res.status(201).json(await mon.createFeedback(ck(res), req.body ?? {}, uid(req))); }));
productDevelopmentRouter.patch('/feedback/:id', requirePermission(ENTRY, 'edit'), h(async (req, res) => { await mon.updateFeedback(ck(res), pid(req), req.body ?? {}, uid(req)); res.json({ success: true }); }));
productDevelopmentRouter.delete('/feedback/:id', requirePermission(ENTRY, 'delete'), h(async (req, res) => { await mon.deleteFeedback(ck(res), pid(req), uid(req)); res.json({ success: true }); }));

// ---------------------------------------------------------------------------- admin

// Who approves what: Admin role only.
productDevelopmentRouter.put('/admin/settings', requireAdminRole, h(async (req, res) => { res.json({ settings: await cfg.updateSettings(ck(res), req.body ?? {}, uid(req)) }); }));
productDevelopmentRouter.put('/admin/criteria', requireAdminRole, h(async (req, res) => { res.json({ criteria: await cfg.saveCriteria(ck(res), req.body?.criteria, uid(req)) }); }));
productDevelopmentRouter.patch('/admin/gate-rules/:id', requireAdminRole, h(async (req, res) => { await cfg.updateGateRule(ck(res), pid(req), req.body ?? {}, uid(req)); res.json({ success: true }); }));
productDevelopmentRouter.patch('/admin/checklist-templates/:id', requireAdminRole, h(async (req, res) => { await cfg.updateChecklistTemplate(ck(res), pid(req), req.body ?? {}, uid(req)); res.json({ success: true }); }));
productDevelopmentRouter.patch('/admin/kpi-targets/:code', requireAdminRole, h(async (req, res) => { await cfg.updateKpiTarget(ck(res), String(req.params.code), req.body ?? {}, uid(req)); res.json({ success: true }); }));
productDevelopmentRouter.post('/admin/governance', requireAdminRole, h(async (req, res) => { res.status(201).json(await cfg.addGovernanceMember(ck(res), req.body ?? {}, uid(req))); }));
productDevelopmentRouter.delete('/admin/governance/:id', requireAdminRole, h(async (req, res) => { await cfg.removeGovernanceMember(ck(res), pid(req), uid(req)); res.json({ success: true }); }));

// Reference content: entry Edit.
productDevelopmentRouter.post('/admin/dropdowns', requirePermission(ENTRY, 'edit'), h(async (req, res) => { res.status(201).json(await cfg.createDropdown(ck(res), req.body ?? {}, uid(req))); }));
productDevelopmentRouter.patch('/admin/dropdowns/:id', requirePermission(ENTRY, 'edit'), h(async (req, res) => { await cfg.updateDropdown(ck(res), pid(req), req.body ?? {}, uid(req)); res.json({ success: true }); }));
productDevelopmentRouter.post('/admin/roadmap-years', requirePermission(ENTRY, 'edit'), h(async (req, res) => { res.status(201).json(await cfg.saveRoadmapYear(ck(res), null, req.body ?? {}, uid(req))); }));
productDevelopmentRouter.patch('/admin/roadmap-years/:id', requirePermission(ENTRY, 'edit'), h(async (req, res) => { res.json(await cfg.saveRoadmapYear(ck(res), pid(req), req.body ?? {}, uid(req))); }));
productDevelopmentRouter.delete('/admin/roadmap-years/:id', requirePermission(ENTRY, 'edit'), h(async (req, res) => { await cfg.deleteRoadmapYear(ck(res), pid(req), uid(req)); res.json({ success: true }); }));
productDevelopmentRouter.post('/admin/gaps', requirePermission(ENTRY, 'edit'), h(async (req, res) => { res.status(201).json(await cfg.saveGapItem(ck(res), null, req.body ?? {}, uid(req))); }));
productDevelopmentRouter.patch('/admin/gaps/:id', requirePermission(ENTRY, 'edit'), h(async (req, res) => { res.json(await cfg.saveGapItem(ck(res), pid(req), req.body ?? {}, uid(req))); }));
productDevelopmentRouter.delete('/admin/gaps/:id', requirePermission(ENTRY, 'edit'), h(async (req, res) => { await cfg.deleteGapItem(ck(res), pid(req), uid(req)); res.json({ success: true }); }));
productDevelopmentRouter.post('/admin/policy-versions', requirePermission(ENTRY, 'edit'), h(async (req, res) => { res.status(201).json(await cfg.createPolicyDraft(ck(res), req.body ?? {}, uid(req))); }));
productDevelopmentRouter.post('/admin/policy-versions/:id/sections', requirePermission(ENTRY, 'edit'), h(async (req, res) => { res.status(201).json(await cfg.saveSection(ck(res), pid(req), null, req.body ?? {}, uid(req))); }));
productDevelopmentRouter.patch('/admin/policy-versions/:id/sections/:sid', requirePermission(ENTRY, 'edit'), h(async (req, res) => { res.json(await cfg.saveSection(ck(res), pid(req), pid(req, 'sid'), req.body ?? {}, uid(req))); }));
productDevelopmentRouter.delete('/admin/policy-versions/:id/sections/:sid', requirePermission(ENTRY, 'edit'), h(async (req, res) => { await cfg.deleteSection(ck(res), pid(req), pid(req, 'sid'), uid(req)); res.json({ success: true }); }));
productDevelopmentRouter.post('/admin/policy-versions/:id/publish', requirePermission(ENTRY, 'edit'), h(async (req, res) => { await cfg.publishPolicyDraft(ck(res), pid(req), uid(req)); res.json({ success: true }); }));
productDevelopmentRouter.delete('/admin/policy-versions/:id', requirePermission(ENTRY, 'edit'), h(async (req, res) => { await cfg.discardPolicyDraft(ck(res), pid(req), uid(req)); res.json({ success: true }); }));

// One-time import (Admin role). ?commit=1 imports; without it a dry run (same transaction, rolled back).
const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 3 },
  fileFilter: (_req, file, cb) => {
    const ok = (file.fieldname === 'productTree' && /\.xlsm$|\.xlsx$/i.test(file.originalname))
      || (file.fieldname === 'scoringMatrix' && /\.xlsx$/i.test(file.originalname))
      || (file.fieldname === 'policy' && /\.docx$/i.test(file.originalname));
    if (ok) cb(null, true);
    else cb(new PdpError('import.fileType', `Unexpected file "${file.originalname}": Product tree .xlsm, scoring matrix .xlsx, policy .docx.`, file.fieldname));
  },
});
productDevelopmentRouter.post('/import', requireAdminRole, (req, res, next) => {
  importUpload.fields([{ name: 'productTree', maxCount: 1 }, { name: 'scoringMatrix', maxCount: 1 }, { name: 'policy', maxCount: 1 }])(req, res, (uploadErr: unknown) => {
    if (uploadErr) {
      sendError(uploadErr instanceof PdpError ? uploadErr : new PdpError('import.upload', 'The files could not be uploaded (10 MB each).', 'file'), res, next);
      return;
    }
    (async () => {
      const commit = req.query.commit === '1' || req.query.commit === 'true';
      let files: ImportFiles;
      let sources: Record<string, string>;
      if (req.query.source === 'folder') {
        files = await readImportFolder();
        sources = Object.fromEntries(Object.entries(IMPORT_FILES).filter(([k]) => files[k as keyof ImportFiles]).map(([k, n]) => [k, `server folder: ${n}`]));
      } else {
        const up = (req.files ?? {}) as Record<string, { buffer: Buffer; originalname: string }[]>;
        files = { productTree: up.productTree?.[0]?.buffer, scoringMatrix: up.scoringMatrix?.[0]?.buffer, policy: up.policy?.[0]?.buffer };
        sources = Object.fromEntries(Object.entries(up).map(([k, v]) => [k, `upload: ${v[0]?.originalname}`]));
      }
      res.json(await runImport(files, { commit, actorUserId: uid(req), sources }));
    })().catch((err) => sendError(err instanceof Error && !(err instanceof ValidationError) && /Product_Tree|R_D_Policy|ZIP|zip/.test(err.message) ? new PdpError('import.parse', err.message, 'file') : err, res, next));
  });
});
