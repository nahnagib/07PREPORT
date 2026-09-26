import { NextFunction, Request, Response } from 'express';
import type { PermissionAction } from '../config/permissionRegistry';
import { allows, canViewAnyDashboard, getRequestPermissions } from '../services/permissionService';

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
  if (!req.user.isAdmin) {
    res.status(403).json({ error: 'Admin access required.' });
    return;
  }
  next();
}

const FORBIDDEN = { error: 'You do not have permission to access this resource.' };

/** Must run after requireAuth. 403s with a clean, generic message on denial -- never leaks which
 * permission rule matched (Section 5.9). `action` is any registry action: routes that change data
 * check create/edit/delete, not just view. */
export function requirePermission(pageKey: string, action: PermissionAction) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    try {
      if (!allows(await getRequestPermissions(req), pageKey, action)) {
        res.status(403).json(FORBIDDEN);
        return;
      }
    } catch (err) {
      next(err);
      return;
    }
    next();
  };
}

/** Gate for shared dashboard endpoints (filter options, refresh status) that every report page
 * uses: allowed for anyone who can View at least one dashboard, not tied to a particular page. */
export async function requireAnyDashboardView(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: 'Unauthenticated' });
    return;
  }
  try {
    if (!canViewAnyDashboard(await getRequestPermissions(req))) {
      res.status(403).json(FORBIDDEN);
      return;
    }
  } catch (err) {
    next(err);
    return;
  }
  next();
}
