import { pool } from '../db/pool';
import { ValidationError } from '../lib/errors';
import { hashPassword, hashResetToken, generateResetToken, validatePasswordPolicy, verifyPassword } from '../lib/password';
import { issueAccessToken } from '../lib/token';
import { sendPasswordResetEmail } from './emailService';
import { getEffectivePermissions, EffectivePermissions } from './permissionService';
import { recordLoginHistory } from './loginHistoryService';
import { AppUserRow, getUserByEmail, getUserById } from './userService';

const ACCOUNT_LOCK_THRESHOLD = () => Number(process.env.ACCOUNT_LOCK_THRESHOLD ?? 5);
const RESET_TOKEN_TTL_MIN = () => Number(process.env.PASSWORD_RESET_TOKEN_TTL_MIN ?? 60);

/** Generic, account-existence-safe error for the login endpoint. */
export class InvalidCredentialsError extends Error {}
/** Thrown only once the password has already been verified correct, so it's safe to be
 * specific -- the caller has proven they own the account. */
export class AccountUnavailableError extends Error {}

export interface PublicUser {
  id: number;
  email: string;
  fullName: string;
  status: AppUserRow['status'];
  mustChangePassword: boolean;
  role: { id: number | null; name: string | null; label: string | null };
  lastLoginAt: Date | null;
  /** Mirrors the existing data-scope lock (Standards Section 4.10/5.2) so the frontend can grey
   * out/lock filter controls the same way it already does -- the real enforcement is always
   * server-side (scopeContext.ts), this is purely so a locked user isn't confused by controls
   * that look editable. */
  isSalesperson: boolean;
  salespersonKey: number | null;
}

export function toPublicUser(user: AppUserRow): PublicUser {
  return {
    id: user.user_id,
    email: user.email,
    fullName: user.display_name,
    status: user.status,
    mustChangePassword: Boolean(user.must_change_password),
    role: { id: user.role_id, name: user.role_name ?? null, label: user.role_label ?? null },
    lastLoginAt: user.last_login_at,
    isSalesperson: user.role_tier_code === 'SALESPERSON',
    salespersonKey: user.salesperson_key,
  };
}

export async function buildMeResponse(
  user: AppUserRow,
): Promise<{ user: PublicUser; permissions: EffectivePermissions }> {
  const permissions = await getEffectivePermissions(user.user_id, user.role_id);
  return { user: toPublicUser(user), permissions };
}

export interface LoginResult {
  token: string;
  user: PublicUser;
  permissions: EffectivePermissions;
}

export async function login(
  email: string,
  password: string,
  meta: { ipAddress?: string; userAgent?: string },
): Promise<LoginResult> {
  const user = await getUserByEmail(email);

  if (!user) {
    await recordLoginHistory({
      userId: null,
      emailAttempted: email,
      eventType: 'LOGIN_FAILED_PASSWORD',
      ...meta,
    });
    throw new InvalidCredentialsError('Invalid email or password.');
  }

  const passwordOk = await verifyPassword(password, user.password_hash);
  if (!passwordOk) {
    const nextFailedCount = user.failed_login_count + 1;
    const shouldAutoLock =
      nextFailedCount >= ACCOUNT_LOCK_THRESHOLD() &&
      (user.status === 'ACTIVE' || user.status === 'PENDING_PASSWORD_CHANGE');

    await pool.query('UPDATE app_user SET failed_login_count = ?, status = ? WHERE user_id = ?', [
      nextFailedCount,
      shouldAutoLock ? 'LOCKED' : user.status,
      user.user_id,
    ]);
    await recordLoginHistory({
      userId: user.user_id,
      emailAttempted: email,
      eventType: 'LOGIN_FAILED_PASSWORD',
      ...meta,
    });
    if (shouldAutoLock) {
      await recordLoginHistory({
        userId: user.user_id,
        emailAttempted: email,
        eventType: 'ACCOUNT_LOCKED_AUTO',
        ...meta,
      });
    }
    throw new InvalidCredentialsError('Invalid email or password.');
  }

  // Password is correct from here on -- safe to be specific about account state.
  if (user.status === 'LOCKED') {
    await recordLoginHistory({
      userId: user.user_id,
      emailAttempted: email,
      eventType: 'LOGIN_FAILED_LOCKED',
      ...meta,
    });
    throw new AccountUnavailableError('Your account is locked. Contact your administrator.');
  }
  if (user.status === 'INACTIVE') {
    await recordLoginHistory({
      userId: user.user_id,
      emailAttempted: email,
      eventType: 'LOGIN_FAILED_INACTIVE',
      ...meta,
    });
    throw new AccountUnavailableError('Your account is inactive. Contact your administrator.');
  }

  await pool.query(
    'UPDATE app_user SET failed_login_count = 0, last_login_at = CURRENT_TIMESTAMP WHERE user_id = ?',
    [user.user_id],
  );
  await recordLoginHistory({
    userId: user.user_id,
    emailAttempted: email,
    eventType: 'LOGIN_SUCCESS',
    ...meta,
  });

  const { token } = issueAccessToken(user.user_id);
  const refreshedUser = (await getUserById(user.user_id))!;
  const { user: publicUser, permissions } = await buildMeResponse(refreshedUser);
  return { token, user: publicUser, permissions };
}

export async function logout(
  userId: number,
  jti: string,
  tokenExpiresAt: Date,
  meta: { ipAddress?: string; userAgent?: string },
): Promise<void> {
  await pool.query(
    'INSERT INTO revoked_tokens (jti, user_id, reason, expires_at) VALUES (?, ?, ?, ?)',
    [jti, userId, 'LOGOUT', tokenExpiresAt],
  );
  const user = await getUserById(userId);
  await recordLoginHistory({
    userId,
    emailAttempted: user?.email ?? '',
    eventType: 'LOGOUT',
    ...meta,
  });
}

/** Self-service change: requires the current password, re-issues a fresh token so the caller
 * isn't logged out by their own action (password_changed_at invalidates only tokens issued
 * *before* this call). */
export async function changePassword(
  userId: number,
  currentPassword: string,
  newPassword: string,
): Promise<{ token: string }> {
  const user = await getUserById(userId);
  if (!user) throw new ValidationError('User not found.');

  const currentOk = await verifyPassword(currentPassword, user.password_hash);
  if (!currentOk) throw new InvalidCredentialsError('Current password is incorrect.');

  const policyError = validatePasswordPolicy(newPassword);
  if (policyError) throw new ValidationError(policyError);

  const passwordHash = await hashPassword(newPassword);
  await pool.query(
    `UPDATE app_user
     SET password_hash = ?, must_change_password = FALSE,
         status = IF(status = 'PENDING_PASSWORD_CHANGE', 'ACTIVE', status),
         password_changed_at = CURRENT_TIMESTAMP
     WHERE user_id = ?`,
    [passwordHash, userId],
  );
  await recordLoginHistory({ userId, emailAttempted: user.email, eventType: 'PASSWORD_CHANGED' });

  const { token } = issueAccessToken(userId);
  return { token };
}

/** Always resolves without revealing whether the email exists (Standards Section 5.9). */
export async function forgotPassword(email: string): Promise<void> {
  const user = await getUserByEmail(email);
  if (!user || user.status === 'LOCKED' || user.status === 'INACTIVE') {
    // Silently no-op for unknown/locked/inactive accounts -- a self-service reset must not be
    // able to route around an administrator-imposed lock or disable.
    return;
  }

  const { token, tokenHash } = generateResetToken();
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MIN() * 60_000);
  await pool.query(
    'UPDATE app_user SET password_reset_token_hash = ?, password_reset_expires_at = ? WHERE user_id = ?',
    [tokenHash, expiresAt, user.user_id],
  );
  await recordLoginHistory({
    userId: user.user_id,
    emailAttempted: email,
    eventType: 'PASSWORD_RESET_REQUESTED',
  });

  // Frontend is mounted at basePath '/Dashboard' (see frontend/next.config.mjs) -- FRONTEND_ORIGIN
  // is scheme+host only (also used for CORS in server.ts), so the '/Dashboard' route prefix has to
  // be added here explicitly since this URL is emailed, not built via next/link's auto-prefixing.
  const resetUrl = `${process.env.FRONTEND_ORIGIN ?? 'http://localhost:3000'}/Dashboard/reset-password?token=${token}`;
  await sendPasswordResetEmail(user.email, user.display_name, resetUrl);
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const tokenHash = hashResetToken(token);
  const [rows] = await pool.query(
    `SELECT user_id, email, display_name FROM app_user
     WHERE password_reset_token_hash = ? AND password_reset_expires_at > CURRENT_TIMESTAMP`,
    [tokenHash],
  );
  const user = (rows as { user_id: number; email: string; display_name: string }[])[0];
  if (!user) {
    throw new InvalidCredentialsError('This reset link is invalid or has expired.');
  }

  const policyError = validatePasswordPolicy(newPassword);
  if (policyError) throw new ValidationError(policyError);

  const passwordHash = await hashPassword(newPassword);
  await pool.query(
    `UPDATE app_user
     SET password_hash = ?, must_change_password = FALSE,
         status = IF(status = 'PENDING_PASSWORD_CHANGE', 'ACTIVE', status),
         password_changed_at = CURRENT_TIMESTAMP, sessions_revoked_at = CURRENT_TIMESTAMP,
         password_reset_token_hash = NULL, password_reset_expires_at = NULL,
         failed_login_count = 0
     WHERE user_id = ?`,
    [passwordHash, user.user_id],
  );
  await recordLoginHistory({
    userId: user.user_id,
    emailAttempted: user.email,
    eventType: 'PASSWORD_RESET_COMPLETED',
  });
}
