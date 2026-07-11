import { pool } from '../db/pool';

export type LoginHistoryEventType =
  | 'LOGIN_SUCCESS'
  | 'LOGIN_FAILED_PASSWORD'
  | 'LOGIN_FAILED_LOCKED'
  | 'LOGIN_FAILED_INACTIVE'
  | 'LOGOUT'
  | 'PASSWORD_RESET_REQUESTED'
  | 'PASSWORD_RESET_COMPLETED'
  | 'PASSWORD_CHANGED'
  | 'FORCE_PASSWORD_CHANGE_SET'
  | 'ACCOUNT_LOCKED_AUTO'
  | 'ACCOUNT_STATUS_CHANGED'
  | 'SESSIONS_REVOKED';

export interface LoginHistoryEvent {
  userId: number | null;
  emailAttempted: string;
  eventType: LoginHistoryEventType;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** Single insert point for every auth/admin audit event -- Standards Section 5.2 audit trail. */
export async function recordLoginHistory(event: LoginHistoryEvent): Promise<void> {
  await pool.query(
    `INSERT INTO login_history (user_id, email_attempted, event_type, ip_address, user_agent)
     VALUES (?, ?, ?, ?, ?)`,
    [
      event.userId,
      event.emailAttempted,
      event.eventType,
      event.ipAddress ?? null,
      event.userAgent ?? null,
    ],
  );
}

export interface LoginHistoryFilters {
  userId?: number;
  eventType?: LoginHistoryEventType;
  fromDate?: string;
  toDate?: string;
  page: number;
  pageSize: number;
}

export interface LoginHistoryRow {
  id: number;
  user_id: number | null;
  email_attempted: string;
  event_type: LoginHistoryEventType;
  ip_address: string | null;
  user_agent: string | null;
  created_at: Date;
  display_name: string | null;
}

export async function listLoginHistory(
  filters: LoginHistoryFilters,
): Promise<{ rows: LoginHistoryRow[]; total: number }> {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filters.userId !== undefined) {
    clauses.push('lh.user_id = ?');
    params.push(filters.userId);
  }
  if (filters.eventType) {
    clauses.push('lh.event_type = ?');
    params.push(filters.eventType);
  }
  if (filters.fromDate) {
    clauses.push('lh.created_at >= ?');
    params.push(filters.fromDate);
  }
  if (filters.toDate) {
    clauses.push('lh.created_at <= ?');
    params.push(filters.toDate);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS total FROM login_history lh ${where}`,
    params,
  );
  const total = (countRows as { total: number }[])[0]?.total ?? 0;

  const offset = Math.max(0, (filters.page - 1) * filters.pageSize);
  const [rows] = await pool.query(
    `SELECT lh.*, au.display_name
     FROM login_history lh
     LEFT JOIN app_user au ON au.user_id = lh.user_id
     ${where}
     ORDER BY lh.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, filters.pageSize, offset],
  );

  return { rows: rows as LoginHistoryRow[], total };
}
