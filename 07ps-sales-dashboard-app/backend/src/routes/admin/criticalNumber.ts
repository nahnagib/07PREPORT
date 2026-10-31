import { Router } from 'express';
import { pool } from '../../db/pool';
import { requireAuth } from '../../middleware/auth';
import { requireAdminRole, requirePasswordChangeCleared } from '../../middleware/permission';
import { readCriticalNumber, validateCriticalNumber } from '../../services/criticalNumberSetting';
export const adminCriticalNumberRouter = Router();
adminCriticalNumberRouter.use(requireAuth, requirePasswordChangeCleared, requireAdminRole);
adminCriticalNumberRouter.get('/', async (_req, res, next) => {
  try { res.json({ value: await readCriticalNumber(pool) }); } catch (err) { next(err); }
});
adminCriticalNumberRouter.put('/', async (req, res, next) => {
  let value: number;
  try { value = validateCriticalNumber(req.body?.value); } catch (err) { res.status(400).json({ error: (err as Error).message }); return; }
  try {
    await pool.execute("INSERT INTO dashboard_setting(setting_key,numeric_value,updated_by) VALUES ('daily_critical_number',?,?) ON DUPLICATE KEY UPDATE numeric_value=VALUES(numeric_value), updated_by=VALUES(updated_by)", [value, req.user!.id]);
    res.json({ value });
  } catch (err) { next(err); }
});
