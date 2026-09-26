import { Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import { requirePasswordChangeCleared, requirePermission } from '../../middleware/permission';
import { ValidationError } from '../../lib/errors';
import {
  createCompany,
  deleteCompany,
  getCompanyById,
  getEtlCompanyOptions,
  listCompanies,
  updateCompany,
} from '../../services/companyAdminService';

export const adminCompaniesRouter = Router();

adminCompaniesRouter.use(
  requireAuth,
  requirePasswordChangeCleared,
  requirePermission('admin_companies', 'view'),
);

adminCompaniesRouter.get('/etl-options', async (_req, res, next) => {
  try {
    res.json(await getEtlCompanyOptions());
  } catch (err) {
    next(err);
  }
});

adminCompaniesRouter.get('/', async (req, res, next) => {
  try {
    const page = Number(req.query.page ?? 1) || 1;
    const pageSize = Math.min(Number(req.query.pageSize ?? 50) || 50, 200);
    const { rows, total } = await listCompanies({
      isActive: req.query.isActive === undefined ? undefined : req.query.isActive === 'true',
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      page,
      pageSize,
    });
    res.json({ rows, total, page, pageSize });
  } catch (err) {
    next(err);
  }
});

adminCompaniesRouter.post('/', requirePermission('admin_companies', 'create'), async (req, res, next) => {
  try {
    const { name, definition, etlCompanyKey, displayOrder, criticalNumberPct } = req.body ?? {};
    const row = await createCompany(
      {
        name,
        definition: definition === undefined ? undefined : definition,
        etlCompanyKey: etlCompanyKey === undefined || etlCompanyKey === null ? null : Number(etlCompanyKey),
        displayOrder: displayOrder === undefined ? undefined : Number(displayOrder),
        criticalNumberPct: criticalNumberPct === undefined ? undefined : Number(criticalNumberPct),
      },
      req.user!.id,
    );
    res.status(201).json({ row });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});

adminCompaniesRouter.get('/:id', async (req, res, next) => {
  try {
    const row = await getCompanyById(Number(req.params.id));
    if (!row) {
      res.status(404).json({ error: 'Company not found.' });
      return;
    }
    res.json({ row });
  } catch (err) {
    next(err);
  }
});

adminCompaniesRouter.patch('/:id', requirePermission('admin_companies', 'edit'), async (req, res, next) => {
  try {
    const { name, definition, etlCompanyKey, displayOrder, criticalNumberPct, isActive } = req.body ?? {};
    const row = await updateCompany(
      Number(req.params.id),
      {
        name: name === undefined ? undefined : name,
        definition: definition === undefined ? undefined : definition,
        etlCompanyKey: etlCompanyKey === undefined ? undefined : etlCompanyKey === null ? null : Number(etlCompanyKey),
        displayOrder: displayOrder === undefined ? undefined : Number(displayOrder),
        criticalNumberPct: criticalNumberPct === undefined ? undefined : Number(criticalNumberPct),
        isActive: isActive === undefined ? undefined : Boolean(isActive),
      },
      req.user!.id,
    );
    res.json({ row });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});

adminCompaniesRouter.delete('/:id', requirePermission('admin_companies', 'delete'), async (req, res, next) => {
  try {
    await deleteCompany(Number(req.params.id), req.user!.id);
    res.json({ success: true });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});
