import { NextFunction, Request, Response } from 'express';
import { hasPermission } from '../services/permissionService';

/** Routes reachable even while a forced password change is pending -- everything else is
 * blocked (403 PASSWORD_CHANGE_REQUIRED) until the user clears it. Enforced here, not just on
 * the frontend, per "user cannot access ANY other page until the password is changed." */
const PASSWORD_CHANGE_ALLOWLIST = new Set(['/auth/me', '/auth/change-password', '/auth/logout']);

export function requirePasswordChangeCleared(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Unauthenticated' });
    return;
  }
  if (req.user.mustChangePassword && !PASSWORD_CHANGE_ALLOWLIST.has(req.path)) {
    res.status(403).json({ error: 'PASSWORD_CHANGE_REQUIRED' });
    return;
  }
  next();
}

/**
 * Hard role gate, independent of the pages/role_permissions/user_permissions system every other
 * admin page uses. The ETL Control Center can trigger real Odoo extraction + MySQL rewrites, so
 * it is intentionally NOT customizable via Role & Permission Management -- Admin only, always,
 * even if the (now-vestigial) `admin_etl` permission is later granted to another role.
 */
export function requireAdminRole(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Unauthenticated' });
    return;
  }
  if (req.user.roleName !== 'ADMIN') {
    res.status(403).json({ error: 'Admin access required.' });
    return;
  }
  next();
}

/** Must run after requireAuth. 403s with a clean, generic message on denial -- never leaks which
 * permission rule matched (Section 5.9). */
export function requirePermission(pageKey: string, action: 'view' | 'export') {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    const allowed = await hasPermission(req.user.id, req.user.roleId, pageKey, action);
    if (!allowed) {
      res.status(403).json({ error: 'You do not have permission to access this resource.' });
      return;
    }
    next();
  };
}
