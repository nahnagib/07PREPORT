import { ErrorRequestHandler, Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../../middleware/auth';
import { requirePasswordChangeCleared, requirePermission } from '../../middleware/permission';
import { ValidationError } from '../../lib/errors';
import { buildTemplateWorkbook, importUsersFromWorkbook } from '../../services/excelImportService';

export const adminImportRouter = Router();

adminImportRouter.use(
  requireAuth,
  requirePasswordChangeCleared,
  requirePermission('admin_users', 'view'),
);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  // Extension only, not MIME type -- browsers are reasonably consistent about the extension but
  // not always about the multipart Content-Type they attach (varies by OS file-association state
  // and, e.g., curl/non-browser clients send application/octet-stream by default). exceljs itself
  // is the real validator: a non-xlsx file with a renamed extension fails to parse cleanly below
  // and surfaces as a normal 400, so being lenient here doesn't weaken validation.
  fileFilter: (_req, file, cb) => {
    if (/\.xlsx$/i.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new ValidationError('Only .xlsx files are accepted.'));
    }
  },
});

adminImportRouter.post('/', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded (expected multipart field "file").' });
      return;
    }
    const result = await importUsersFromWorkbook(req.file.buffer);
    res.json(result);
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});

adminImportRouter.get('/template', async (_req, res, next) => {
  try {
    const buffer = await buildTemplateWorkbook();
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', 'attachment; filename="user-import-template.xlsx"');
    res.send(Buffer.from(buffer));
  } catch (err) {
    next(err);
  }
});

// Multer errors (file too large, wrong field name, etc.) AND fileFilter's own ValidationError
// (multer routes a fileFilter cb(err) here via next(err), same as any other middleware error) land
// here rather than the generic system-tier 500 handler, so the admin sees a clean message instead
// of "Something went wrong."
const multerErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (err instanceof multer.MulterError || err instanceof ValidationError) {
    res.status(400).json({ error: err.message });
    return;
  }
  next(err);
};
adminImportRouter.use(multerErrorHandler);
