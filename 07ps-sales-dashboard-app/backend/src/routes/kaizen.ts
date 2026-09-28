import { NextFunction, Request, Response, Router } from 'express';
import multer from 'multer';
import QRCode from 'qrcode';
import { requireAuth } from '../middleware/auth';
import { requireAdminRole, requirePasswordChangeCleared, requirePermission } from '../middleware/permission';
import { ValidationError } from '../lib/errors';
import { publicAppUrl } from '../lib/appUrl';
import { allows, getRequestPermissions } from '../services/permissionService';
import {
  KaizenValidationError,
  closeCard,
  createCard,
  deleteCard,
  getCard,
  getDashboard,
  getSuggestions,
  listCards,
  listDropdownValues,
  updateCard,
  type KaizenFilters,
} from '../services/kaizenService';
import { buildKaizenExport } from '../services/kaizenExportService';
import { importKaizenCards } from '../services/kaizenImportService';

/**
 * Kaizen Board (Process department). Two permission pages (config/permissionRegistry.ts):
 *   kaizen_board  View = dashboard, QR code, read-only card list/details.
 *   kaizen_cards  View = the same card reads; Create/Edit/Delete/Export = data entry.
 * The one-time Excel import is Admin-role only; dropdown values live under /admin/kaizen-dropdowns.
 */
export const kaizenRouter = Router();

kaizenRouter.use(requireAuth, requirePasswordChangeCleared);

/** Card reads are open to anyone who can see either Kaizen page. */
async function requireKaizenRead(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const permissions = await getRequestPermissions(req);
    if (!allows(permissions, 'kaizen_board', 'view') && !allows(permissions, 'kaizen_cards', 'view')) {
      res.status(403).json({ error: 'You do not have permission to access this resource.' });
      return;
    }
  } catch (err) {
    next(err);
    return;
  }
  next();
}

function sendError(err: unknown, res: Response, next: NextFunction): void {
  if (err instanceof KaizenValidationError) {
    res.status(err.code.endsWith('notFound') ? 404 : 400).json({ error: err.message, code: err.code, field: err.field });
    return;
  }
  if (err instanceof ValidationError) {
    res.status(400).json({ error: err.message });
    return;
  }
  next(err);
}

function list(value: unknown): number[] {
  const parts = (Array.isArray(value) ? value : value === undefined ? [] : [value]).flatMap((v) => String(v).split(','));
  return parts.map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function parseKaizenFilters(query: Request['query']): KaizenFilters {
  const status = str(query.status)?.toUpperCase();
  return {
    dateFrom: str(query.dateFrom),
    dateTo: str(query.dateTo),
    departmentIds: list(query.departmentIds),
    typeIds: list(query.typeIds),
    priorityIds: list(query.priorityIds),
    status: status === 'OPEN' || status === 'CLOSED' ? status : undefined,
    search: str(query.search),
    overdue: query.overdue === 'true' || query.overdue === '1',
    creator: str(query.creator),
    responsibleParty: str(query.responsibleParty),
  };
}

function cardNoParam(req: Request): number {
  const n = Number(String(req.params.no).replace(/^#/, ''));
  if (!Number.isInteger(n) || n <= 0) throw new KaizenValidationError('card.notFound', 'Card not found.');
  return n;
}

kaizenRouter.get('/options', requireKaizenRead, async (req, res, next) => {
  try {
    const permissions = await getRequestPermissions(req);
    const [dropdowns, suggestions] = await Promise.all([
      listDropdownValues(),
      // Autocomplete lists are for the entry form only.
      allows(permissions, 'kaizen_cards', 'view') ? getSuggestions() : Promise.resolve({ responsibleParties: [], creators: [] }),
    ]);
    res.json({ dropdowns: dropdowns.map(({ usage_count: _u, ...d }) => d), ...suggestions });
  } catch (err) {
    next(err);
  }
});

kaizenRouter.get('/dashboard', requirePermission('kaizen_board', 'view'), async (req, res, next) => {
  try {
    const { dateFrom, dateTo, departmentIds } = parseKaizenFilters(req.query);
    res.json(await getDashboard({ dateFrom, dateTo, departmentIds }));
  } catch (err) {
    next(err);
  }
});

/** QR code for the physical board, pointing at the read-only card details page. Built from the
 * configured public URL (lib/appUrl.ts), never a hard-coded host. */
kaizenRouter.get('/qr', requirePermission('kaizen_board', 'view'), async (_req, res, next) => {
  try {
    const url = `${publicAppUrl()}/process/kaizen-board/cards`;
    const dataUrl = await QRCode.toDataURL(url, { width: 640, margin: 2, errorCorrectionLevel: 'M' });
    res.json({ url, dataUrl });
  } catch (err) {
    next(err);
  }
});

kaizenRouter.get('/cards', requireKaizenRead, async (req, res, next) => {
  try {
    const { rows, total } = await listCards(parseKaizenFilters(req.query), { by: str(req.query.sortBy), dir: str(req.query.sortDir) });
    res.json({ rows, total });
  } catch (err) {
    next(err);
  }
});

// Before /cards/:no so "export" isn't read as a card number.
kaizenRouter.get('/cards/export', requirePermission('kaizen_cards', 'export'), async (req, res, next) => {
  try {
    const buffer = await buildKaizenExport(parseKaizenFilters(req.query), { by: str(req.query.sortBy), dir: str(req.query.sortDir) });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="kaizen-cards.xlsx"');
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

kaizenRouter.get('/cards/:no', requireKaizenRead, async (req, res, next) => {
  try {
    const card = await getCard(cardNoParam(req));
    if (!card) throw new KaizenValidationError('card.notFound', 'Card not found.');
    res.json({ card });
  } catch (err) {
    sendError(err, res, next);
  }
});

kaizenRouter.post('/cards', requirePermission('kaizen_cards', 'create'), async (req, res, next) => {
  try {
    res.status(201).json({ card: await createCard(req.body ?? {}, req.user!.id) });
  } catch (err) {
    sendError(err, res, next);
  }
});

kaizenRouter.patch('/cards/:no', requirePermission('kaizen_cards', 'edit'), async (req, res, next) => {
  try {
    res.json({ card: await updateCard(cardNoParam(req), req.body ?? {}, req.user!.id) });
  } catch (err) {
    sendError(err, res, next);
  }
});

kaizenRouter.post('/cards/:no/close', requirePermission('kaizen_cards', 'edit'), async (req, res, next) => {
  try {
    res.json({ card: await closeCard(cardNoParam(req), req.body?.closerDate, req.user!.id) });
  } catch (err) {
    sendError(err, res, next);
  }
});

kaizenRouter.delete('/cards/:no', requirePermission('kaizen_cards', 'delete'), async (req, res, next) => {
  try {
    await deleteCard(cardNoParam(req), req.user!.id);
    res.json({ success: true });
  } catch (err) {
    sendError(err, res, next);
  }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/\.xlsx$/i.test(file.originalname)) cb(null, true);
    else cb(new KaizenValidationError('import.fileType', 'Only .xlsx files are accepted.'));
  },
});

/** One-time import. ?commit=1 imports; without it, a dry run that only reports problems. */
kaizenRouter.post('/import', requireAdminRole, (req, res, next) => {
  upload.single('file')(req, res, async (uploadErr: unknown) => {
    if (uploadErr) {
      sendError(uploadErr instanceof ValidationError ? uploadErr : new KaizenValidationError('import.fileType', 'The file could not be uploaded (max 5 MB, .xlsx).'), res, next);
      return;
    }
    try {
      if (!req.file) throw new KaizenValidationError('import.noFile', 'No file uploaded.');
      const commit = req.query.commit === '1' || req.query.commit === 'true';
      res.json(await importKaizenCards(req.file.buffer, { commit, actorUserId: req.user!.id }));
    } catch (err) {
      sendError(err, res, next);
    }
  });
});
