import { ErrorRequestHandler, NextFunction, Request, Response, Router } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import path from 'node:path';
import { requireAuth } from '../middleware/auth';
import { requirePasswordChangeCleared, requirePermission } from '../middleware/permission';
import { hasPermission } from '../services/permissionService';
import { ValidationError } from '../lib/errors';
import { MAX_FILE_BYTES } from '../marcom/templateConfig';
import { issuesToCsv } from '../marcom/csv';
import { isUuid } from '../marcom/staging';
import {
  MarcomError, auditMarcom, commitUpload, getBatch, getBatchFile, getFreshness, getStagedIssues,
  listBatches, rollbackBatch, validateUpload,
} from '../marcom/service';

/**
 * MARCOM Data Upload (admin). Every route sits behind `admin_marcom_upload` -- enforced here on
 * the server, independent of whether the menu entry is shown. Auth is bearer-JWT (no cookies), so
 * there is no ambient credential for CSRF to ride on; that is the repo's existing convention.
 */
export const marcomUploadRouter = Router();

marcomUploadRouter.use(requireAuth, requirePasswordChangeCleared, requirePermission('admin_marcom_upload', 'view'));

const TEMPLATE_FILE = path.join(__dirname, '..', '..', 'assets', 'marcom', 'MARCOM_Contribution_Data_Template.xlsx');

const validateLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_MARCOM_WINDOW_MIN ?? 10) * 60_000,
  max: Number(process.env.RATE_LIMIT_MARCOM_MAX ?? 20),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `marcom-${req.user?.id ?? req.ip}`,
  message: { error: 'Too many uploads. Please wait a few minutes and try again.', code: 'RATE_LIMITED' },
});

// Multer enforces the size limit while streaming (it aborts at MAX_FILE_BYTES; the body is never
// buffered beyond it), and the .xlsx check here is only a convenience -- the ZIP signature check in
// assertSafeXlsx is authoritative.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 5, parts: 8 },
  fileFilter: (_req, file, cb) => {
    if (/\.xlsx$/i.test(file.originalname)) cb(null, true);
    else cb(new ValidationError('Only .xlsx files are accepted.'));
  },
});

/** Reject on a declared oversize body before multer reads any of it. */
function rejectOversize(req: Request, res: Response, next: NextFunction): void {
  const len = Number(req.headers['content-length'] ?? 0);
  if (len > MAX_FILE_BYTES + 64 * 1024) {
    res.status(413).json({ error: `The file is larger than the ${MAX_FILE_BYTES / 1024 / 1024} MB limit.`, code: 'FILE_TOO_LARGE' });
    return;
  }
  next();
}

const actorOf = (req: Request) => ({ id: req.user!.id });
const intParam = (v: string): number | null => (/^\d{1,12}$/.test(v) ? Number(v) : null);

// ---------------------------------------------------------------- template

marcomUploadRouter.get('/template', (_req, res, next) => {
  res.download(TEMPLATE_FILE, 'MARCOM_Contribution_Data_Template.xlsx', (err) => { if (err) next(err); });
});

// ---------------------------------------------------------------- validate (dry run)

marcomUploadRouter.post('/validate', requirePermission('admin_marcom_upload', 'create'), validateLimiter, rejectOversize, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded (expected multipart field "file").', code: 'NO_FILE' });
      return;
    }
    const preview = await validateUpload({ buffer: req.file.buffer, filename: req.file.originalname, actor: actorOf(req) });
    res.json(preview);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- commit

marcomUploadRouter.post('/commit', requirePermission('admin_marcom_upload', 'create'), async (req, res, next) => {
  try {
    const { stagedUploadId, confirmNewBrands } = req.body ?? {};
    if (typeof stagedUploadId !== 'string' || !isUuid(stagedUploadId)) {
      res.status(400).json({ error: 'stagedUploadId is required.', code: 'BAD_REQUEST' });
      return;
    }
    const result = await commitUpload({ stagedUploadId, actor: actorOf(req), confirmNewBrands: confirmNewBrands === true });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- error report

marcomUploadRouter.get('/staged/:id/errors.csv', requirePermission('admin_marcom_upload', 'export'), async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) {
      res.status(404).json({ error: 'Upload not found.', code: 'STAGED_NOT_FOUND' });
      return;
    }
    const issues = await getStagedIssues(req.params.id, actorOf(req));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="marcom-upload-report.csv"');
    res.send(issuesToCsv(issues));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- history

marcomUploadRouter.get('/batches', async (req, res, next) => {
  try {
    res.json(await listBatches(Number(req.query.page ?? 1), Number(req.query.pageSize ?? 25)));
  } catch (err) {
    next(err);
  }
});

marcomUploadRouter.get('/batches/:id', async (req, res, next) => {
  try {
    const id = intParam(req.params.id);
    if (id === null) { res.status(404).json({ error: 'Batch not found.', code: 'BATCH_NOT_FOUND' }); return; }
    res.json(await getBatch(id));
  } catch (err) {
    next(err);
  }
});

marcomUploadRouter.get('/batches/:id/file', requirePermission('admin_marcom_upload', 'export'), async (req, res, next) => {
  try {
    const id = intParam(req.params.id);
    if (id === null) { res.status(404).json({ error: 'Batch not found.', code: 'BATCH_NOT_FOUND' }); return; }
    const f = await getBatchFile(id);
    await auditMarcom(req.user!.id, 'marcom_upload_batch', String(id), 'CREATE', { event: 'file_download' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${f.filename}"`);
    res.send(f.buffer);
  } catch (err) {
    next(err);
  }
});

marcomUploadRouter.post('/batches/:id/rollback', requirePermission('admin_marcom_upload', 'delete'), async (req, res, next) => {
  try {
    const id = intParam(req.params.id);
    if (id === null) { res.status(404).json({ error: 'Batch not found.', code: 'BATCH_NOT_FOUND' }); return; }
    res.json(await rollbackBatch({ batchId: id, actor: actorOf(req), reason: req.body?.reason }));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- error mapping

/** Turns expected failures into `{ error, code }` JSON; anything else falls through to server.ts's 500 handler. */
export const marcomErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (err instanceof MarcomError) {
    res.status(err.status).json({ error: err.message, code: err.code, ...err.extra });
    return;
  }
  if (err instanceof multer.MulterError) {
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    res.status(tooBig ? 413 : 400).json({
      error: tooBig ? `The file is larger than the ${MAX_FILE_BYTES / 1024 / 1024} MB limit.` : 'Invalid upload.',
      code: tooBig ? 'FILE_TOO_LARGE' : 'BAD_UPLOAD',
    });
    return;
  }
  if (err instanceof ValidationError) {
    res.status(400).json({ error: err.message, code: 'INVALID_FILE', problems: (err as { problems?: string[] }).problems });
    return;
  }
  next(err);
};
marcomUploadRouter.use(marcomErrorHandler);

// ---------------------------------------------------------------- freshness (view permission, not admin)

export const marcomFreshnessRouter = Router();
const REPORT_PAGES = ['marcom_spending', 'marcom_media_campaigns', 'marcom_digital', 'marcom_trade'];

marcomFreshnessRouter.get('/', requireAuth, requirePasswordChangeCleared, async (req, res, next) => {
  try {
    const u = req.user!;
    const allowed = (await Promise.all(REPORT_PAGES.map((p) => hasPermission(u.id, u.roleId, p, 'view')))).some(Boolean);
    if (!allowed) {
      res.status(403).json({ error: 'You do not have permission to access this resource.' });
      return;
    }
    res.json(await getFreshness());
  } catch (err) {
    next(err);
  }
});
