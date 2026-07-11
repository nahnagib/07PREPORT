import { NextFunction, Request, Response } from 'express';
import { pool } from '../db/pool';
import { InvalidTokenError, verifyAccessToken } from '../lib/token';
import { AppUserRow, UserStatus, getUserById } from '../services/userService';
import type { RoleTier } from '../config/roles';

export interface RequestUser {
  id: number;
  email: string;
  fullName: string;
  status: UserStatus;
  mustChangePassword: boolean;
  roleId: number | null;
  roleName: string | null;
  roleLabel: string | null;
  /** Existing data-scope tier (see backend/src/measures/filters.ts) this user's business role
   * maps to by default -- untouched scope-lock system, just fed from a real user now. */
  roleTierCode: RoleTier | null;
  salespersonKey: number | null;
  companyScope: AppUserRow['company_scope'];
  jti: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: RequestUser;
    }
  }
}

async function isTokenRevoked(jti: string): Promise<boolean> {
  const [rows] = await pool.query('SELECT 1 FROM revoked_tokens WHERE jti = ? LIMIT 1', [jti]);
  return (rows as unknown[]).length > 0;
}

/**
 * Verifies the bearer JWT, then re-loads the user's role/status/lock state fresh from the DB on
 * every single request -- this is intentional, not a missed-caching opportunity: the token itself
 * carries only { sub, jti } (see lib/token.ts), so an admin locking/disabling a user, resetting
 * their password, or revoking their sessions takes effect on the very next request even though
 * the token has a full year left on its own expiry.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing bearer token' });
    return;
  }

  let verified;
  try {
    verified = verifyAccessToken(header.slice('Bearer '.length));
  } catch (err) {
    if (err instanceof InvalidTokenError) {
      res.status(401).json({ error: 'Invalid or expired session' });
      return;
    }
    next(err);
    return;
  }

  if (await isTokenRevoked(verified.jti)) {
    res.status(401).json({ error: 'Session has been signed out' });
    return;
  }

  const user = await getUserById(verified.userId);
  if (!user) {
    res.status(401).json({ error: 'Invalid or expired session' });
    return;
  }

  if (user.status === 'INACTIVE' || user.status === 'LOCKED') {
    res.status(401).json({ error: 'Your account is no longer active. Contact your administrator.' });
    return;
  }
  if (user.sessions_revoked_at && verified.issuedAt < user.sessions_revoked_at) {
    res.status(401).json({ error: 'Session has been revoked. Please sign in again.' });
    return;
  }
  if (user.password_changed_at && verified.issuedAt < user.password_changed_at) {
    res.status(401).json({ error: 'Session is no longer valid. Please sign in again.' });
    return;
  }

  req.user = {
    id: user.user_id,
    email: user.email,
    fullName: user.display_name,
    status: user.status,
    mustChangePassword: Boolean(user.must_change_password),
    roleId: user.role_id,
    roleName: user.role_name ?? null,
    roleLabel: user.role_label ?? null,
    roleTierCode: (user.role_tier_code as RoleTier | null) ?? null,
    salespersonKey: user.salesperson_key,
    companyScope: user.company_scope,
    jti: verified.jti,
  };
  next();
}
