import { pool } from '../db/pool';

/**
 * audit_log (data/warehouse/migrations/0025_audit_log.sql): who changed what, when, with JSON
 * before/after snapshots. Written by the ETL input-file uploads (routes/admin/etlInputFiles.ts) and
 * the MARCOM upload (marcom/service.ts's own audit()); read by the admin Audit Log screen.
 */

export type AuditAction = 'CREATE' | 'UPDATE' | 'DELETE';

/** entity_type for replacements of the ETL's manual input workbooks; entity_id is the file name. */
export const ETL_INPUT_FILE_ENTITY = 'etl_input_file';

export interface AuditLogRow {
  audit_id: number;
  entity_type: string;
  entity_id: string;
  action: AuditAction;
  changed_by: number | null;
  changed_by_name: string | null;
  changed_by_email: string | null;
  changed_at: Date;
  before_value: unknown;
  after_value: unknown;
}

/** Returns false (and logs) instead of throwing: callers decide how to surface a lost audit row. */
export async function writeAuditLog(entry: {
  entityType: string;
  entityId: string;
  action: AuditAction;
  changedBy: number;
  before?: unknown;
  after?: unknown;
}): Promise<boolean> {
  try {
    await pool.query(
      `INSERT INTO audit_log (entity_type, entity_id, action, changed_by, before_value, after_value)
       VALUES (?, ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON))`,
      [
        entry.entityType,
        entry.entityId,
        entry.action,
        entry.changedBy,
        entry.before === undefined ? null : JSON.stringify(entry.before),
        entry.after === undefined ? null : JSON.stringify(entry.after),
      ],
    );
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[audit_log] write failed for ${entry.entityType}/${entry.entityId}:`, err);
    return false;
  }
}

/** mysql2 hands JSON columns back already parsed on MySQL 8, but as strings on some servers/drivers. */
function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

const SELECT = `
  SELECT al.audit_id, al.entity_type, al.entity_id, al.action, al.changed_by, al.changed_at,
         al.before_value, al.after_value, u.display_name AS changed_by_name, u.email AS changed_by_email
    FROM audit_log al
    LEFT JOIN app_user u ON u.user_id = al.changed_by`;

function normalize(rows: AuditLogRow[]): AuditLogRow[] {
  return rows.map((r) => ({ ...r, before_value: parseJson(r.before_value), after_value: parseJson(r.after_value) }));
}

export async function listAuditLog(filters: {
  entityType?: string;
  entityId?: string;
  page: number;
  pageSize: number;
}): Promise<{ rows: AuditLogRow[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.entityType) {
    where.push('al.entity_type = ?');
    params.push(filters.entityType);
  }
  if (filters.entityId) {
    where.push('al.entity_id = ?');
    params.push(filters.entityId);
  }
  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const offset = (filters.page - 1) * filters.pageSize;
  const [rows] = await pool.query(`${SELECT}${whereSql} ORDER BY al.changed_at DESC, al.audit_id DESC LIMIT ? OFFSET ?`, [
    ...params,
    filters.pageSize,
    offset,
  ]);
  const [countRows] = await pool.query(`SELECT COUNT(*) AS total FROM audit_log al${whereSql}`, params);
  return { rows: normalize(rows as AuditLogRow[]), total: Number((countRows as { total: number }[])[0]?.total ?? 0) };
}

export async function listAuditEntityTypes(): Promise<string[]> {
  const [rows] = await pool.query('SELECT DISTINCT entity_type FROM audit_log ORDER BY entity_type');
  return (rows as { entity_type: string }[]).map((r) => r.entity_type);
}

/** Newest entry per entity_id for one entity_type (e.g. the last upload of each input file). */
export async function latestAuditByEntity(entityType: string): Promise<Map<string, AuditLogRow>> {
  const [rows] = await pool.query(
    `${SELECT}
      WHERE al.audit_id IN (SELECT MAX(audit_id) FROM audit_log WHERE entity_type = ? GROUP BY entity_id)`,
    [entityType],
  );
  return new Map(normalize(rows as AuditLogRow[]).map((r) => [r.entity_id, r]));
}
