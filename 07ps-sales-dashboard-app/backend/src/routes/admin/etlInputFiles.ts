import { ErrorRequestHandler, Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../../middleware/auth';
import { requireAdminRole, requirePasswordChangeCleared } from '../../middleware/permission';
import { ValidationError } from '../../lib/errors';
import { etlLogger } from '../../etl/services/etlLogger';
import { getActiveRun } from '../../etl/services/etlRunTracker';
import { EtlInputFileError, getEtlInputFiles, replaceEtlInputFile } from '../../etl/services/pythonRunner';
import { ETL_INPUT_FILE_ENTITY, latestAuditByEntity, writeAuditLog } from '../../services/auditLogService';

/**
 * Replacing the ETL's manual input workbooks (sales_targets.xlsx, SalesTeam.xlsx, OffDays.xlsx,
 * PRODUCTS.xlsx, BlockedCustomers.xlsx) from the ETL Control Center. Admin-role-only, same as the
 * rest of /admin/etl.
 *
 * The file itself is validated, backed up and swapped in by the ETL service (data/etl/api/
 * input_files.py) -- that process resolves ETL_INPUT_DIR the same way the pipeline does, so the new
 * file lands at the exact path the next scheduled run reads, and the existing load logic picks it
 * up into the existing tables. Nothing here starts, schedules or queues a run.
 */
export const adminEtlInputFilesRouter = Router();

adminEtlInputFilesRouter.use(requireAuth, requirePasswordChangeCleared, requireAdminRole);

/** The input files are 10-300 KB; 5 MB leaves plenty of headroom. Must match input_files.py. */
export const MAX_INPUT_FILE_BYTES = 5 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_INPUT_FILE_BYTES, files: 1, fields: 2, parts: 4 },
  fileFilter: (_req, file, cb) => {
    if (/\.xlsx$/i.test(file.originalname)) cb(null, true);
    else cb(new ValidationError('Only .xlsx files are accepted.'));
  },
});

adminEtlInputFilesRouter.get('/', async (_req, res, next) => {
  try {
    const listing = await getEtlInputFiles();
    const lastUploads = await latestAuditByEntity(ETL_INPUT_FILE_ENTITY);
    res.json({
      ...listing,
      files: listing.files.map((f) => {
        const last = lastUploads.get(f.name);
        return {
          ...f,
          lastUpload: last
            ? { at: last.changed_at, byUserId: last.changed_by, byName: last.changed_by_name ?? last.changed_by_email }
            : null,
        };
      }),
    });
  } catch (err) {
    if (err instanceof EtlInputFileError) {
      res.status(err.status >= 500 ? 503 : err.status).json({ error: err.message });
      return;
    }
    next(err);
  }
});

adminEtlInputFilesRouter.put('/:name', upload.single('file'), async (req, res, next) => {
  const name = req.params.name;
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded (expected multipart field "file").' });
      return;
    }
    // The ETL service also refuses while ITS tracker has a job; this additionally covers a run that
    // is queued in BullMQ but has not reached the ETL service yet.
    const active = await getActiveRun();
    if (active) {
      res.status(409).json({ error: `An ETL run is ${active.status}. Upload again once it has finished.` });
      return;
    }

    const result = await replaceEtlInputFile(name, req.file.buffer);
    const user = req.user!;
    const auditLogged = await writeAuditLog({
      entityType: ETL_INPUT_FILE_ENTITY,
      entityId: result.name,
      action: result.previous ? 'UPDATE' : 'CREATE',
      changedBy: user.id,
      before: result.previous,
      after: {
        ...result.current,
        uploadedFilename: req.file.originalname,
        uploadedBy: user.fullName,
        backupPath: result.backup?.path ?? null,
        inputDir: result.input_dir,
        sheets: result.validation.sheets,
        rowCounts: result.validation.counts,
      },
    });
    etlLogger.info('ETL input file replaced by admin', {
      file: result.name,
      userId: user.id,
      userName: user.fullName,
      backup: result.backup?.path ?? null,
      sha256: result.current.sha256,
      auditLogged,
    });
    res.json({ ...result, auditLogged });
  } catch (err) {
    if (err instanceof EtlInputFileError) {
      res.status(err.status).json({ error: err.message, problems: err.problems });
      return;
    }
    next(err);
  }
});

/** Multer/fileFilter rejections as clean 4xx answers instead of the generic 500 handler. */
const uploadErrors: ErrorRequestHandler = (err, _req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: `The file is larger than the ${MAX_INPUT_FILE_BYTES / 1024 / 1024} MB limit.` });
    } else {
      res.status(400).json({ error: `Upload rejected: ${err.message}` });
    }
    return;
  }
  if (err instanceof ValidationError) {
    res.status(400).json({ error: err.message });
    return;
  }
  next(err);
};
adminEtlInputFilesRouter.use(uploadErrors);
