import { pool } from '../db/pool';
import { ValidationError } from '../lib/errors';

/**
 * Admin-controlled reference data for Customer Group -- an overlay on the live, ETL-replaced
 * Dim_Segment (same pattern as salesTeamAdminService.ts's overlay on Dim_SalesTeam), stored in
 * admin_customer_group (see data/warehouse/migrations/0018_reference_data_admin.sql for the full
 * rationale). Seeded once from Dim_Segment at migration time and from then on authoritative for
 * this admin page and for GET /filters/customer-groups -- there is deliberately no "if empty,
 * fall back to raw Dim_Segment" runtime branch, since the table is never empty after seeding.
 *
 * SCOPE (updated, Reports/Dashboards Honor Admin Salesperson Overrides, 2026-09): this table's
 * `name` is now used as the display label for a reclassified segment bucket in the Tachometer
 * breakdown drill-down (measures/tachometer.ts's GROUP_CONFIG.segment) when its etl_segment_key
 * matches a salesperson's effective segment. It still does NOT determine WHICH transactions land
 * in which segment bucket, though -- that's driven entirely by
 * salesperson_admin_profile.segment_key_override (falling back to the live
 * Dim_Segment.SegmentKey), via measures/filters.ts's effectiveSegmentExpr; this table only supplies
 * the pretty name and is_active/display_order for the admin page and GET /filters/customer-groups.
 * Because of that, GET /filters/customer-groups only ever returns rows with a live
 * etl_segment_key -- a purely custom (unlinked) group has nothing in Fact_SalesLines/Fact_Targets
 * to filter by, so it's visible on this admin page but not offered as a live report filter.
 */

export interface CustomerGroupRow {
  customer_group_id: number;
  name: string;
  definition: string | null;
  etl_segment_key: number | null;
  etl_segment_name: string | null;
  display_order: number;
  /** Share of the Daily Critical Number this group contributes when it's the only Customer Group
   * filter selected (0-100) -- see data/warehouse/migrations/0021_critical_number_allocation.sql
   * and criticalNumber.ts's computeDailyCriticalNumber. Defaults to 0 for a newly created group
   * until an admin sets a real value. */
  critical_number_pct: number;
  is_active: boolean;
  created_at: string;
  created_by_email: string | null;
  updated_at: string;
  updated_by_email: string | null;
  /** How many salesperson/sales-team overlay rows currently reference this group's etl_segment_key
   * -- 0 for a purely custom (unlinked) group, since there's no column path to reference one.
   * Included so the frontend can show/hide the Deactivate/Delete actions without a second call. */
  usage_count: number;
}

const BASE_SELECT = `
  SELECT
    g.customer_group_id, g.name, g.definition, g.etl_segment_key, g.etl_segment_name,
    g.display_order, g.critical_number_pct, g.is_active, g.created_at, cu.email AS created_by_email,
    g.updated_at, uu.email AS updated_by_email,
    COALESCE((
      SELECT COUNT(*) FROM salesperson_admin_profile WHERE segment_key_override = g.etl_segment_key
    ), 0) + COALESCE((
      SELECT COUNT(*) FROM sales_team_admin_profile WHERE segment_key_override = g.etl_segment_key
    ), 0) AS usage_count
  FROM admin_customer_group g
  LEFT JOIN app_user cu ON cu.user_id = g.created_by
  LEFT JOIN app_user uu ON uu.user_id = g.updated_by
`;

function withBool(row: CustomerGroupRow): CustomerGroupRow {
  return { ...row, is_active: Boolean(row.is_active), critical_number_pct: Number(row.critical_number_pct), usage_count: Number(row.usage_count) };
}

function validatePct(pct: number): void {
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    throw new ValidationError('Critical Number percentage must be a number between 0 and 100.');
  }
}

export interface ListCustomerGroupsFilters {
  isActive?: boolean;
  search?: string;
  page: number;
  pageSize: number;
}

export async function listCustomerGroups(
  filters: ListCustomerGroupsFilters,
): Promise<{ rows: CustomerGroupRow[]; total: number }> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.isActive !== undefined) {
    clauses.push('g.is_active = ?');
    params.push(filters.isActive);
  }
  if (filters.search) {
    clauses.push('(g.name LIKE ? OR g.definition LIKE ?)');
    params.push(`%${filters.search}%`, `%${filters.search}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const [countRows] = await pool.query(`SELECT COUNT(*) AS total FROM admin_customer_group g ${where}`, params);
  const total = (countRows as { total: number }[])[0]?.total ?? 0;

  const offset = Math.max(0, (filters.page - 1) * filters.pageSize);
  const [rows] = await pool.query(
    `${BASE_SELECT} ${where} ORDER BY g.display_order, g.name LIMIT ? OFFSET ?`,
    [...params, filters.pageSize, offset],
  );
  return { rows: (rows as CustomerGroupRow[]).map(withBool), total };
}

export async function getCustomerGroupById(id: number): Promise<CustomerGroupRow | null> {
  const [rows] = await pool.query(`${BASE_SELECT} WHERE g.customer_group_id = ?`, [id]);
  const row = (rows as CustomerGroupRow[])[0];
  return row ? withBool(row) : null;
}

async function nameTakenByAnother(name: string, excludeId?: number): Promise<boolean> {
  const [rows] = await pool.query(
    'SELECT 1 FROM admin_customer_group WHERE name = ? AND customer_group_id <> ? LIMIT 1',
    [name, excludeId ?? -1],
  );
  return (rows as unknown[]).length > 0;
}

async function etlSegmentExists(segmentKey: number): Promise<boolean> {
  const [rows] = await pool.query('SELECT 1 FROM Dim_Segment WHERE SegmentKey = ? LIMIT 1', [segmentKey]);
  return (rows as unknown[]).length > 0;
}

async function etlSegmentTakenByAnother(segmentKey: number, excludeId?: number): Promise<boolean> {
  const [rows] = await pool.query(
    'SELECT 1 FROM admin_customer_group WHERE etl_segment_key = ? AND customer_group_id <> ? LIMIT 1',
    [segmentKey, excludeId ?? -1],
  );
  return (rows as unknown[]).length > 0;
}

async function usageCount(etlSegmentKey: number | null): Promise<number> {
  if (etlSegmentKey === null) return 0;
  const [rows] = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM salesperson_admin_profile WHERE segment_key_override = ?) +
       (SELECT COUNT(*) FROM sales_team_admin_profile WHERE segment_key_override = ?) AS total`,
    [etlSegmentKey, etlSegmentKey],
  );
  return Number((rows as { total: number }[])[0]?.total ?? 0);
}

async function recordHistory(
  customerGroupId: number,
  row: { name: string; definition: string | null; etl_segment_key: number | null; etl_segment_name: string | null; display_order: number; critical_number_pct: number; is_active: boolean },
  action: 'CREATE' | 'UPDATE' | 'DEACTIVATE' | 'REACTIVATE' | 'DELETE',
  actorUserId: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO admin_customer_group_history
       (customer_group_id, name, definition, etl_segment_key, etl_segment_name, display_order, critical_number_pct, is_active, action, changed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [customerGroupId, row.name, row.definition, row.etl_segment_key, row.etl_segment_name, row.display_order, row.critical_number_pct, row.is_active, action, actorUserId],
  );
}

export interface CreateCustomerGroupInput {
  name: string;
  definition?: string | null;
  etlSegmentKey?: number | null;
  displayOrder?: number;
  criticalNumberPct?: number;
}

export async function createCustomerGroup(input: CreateCustomerGroupInput, actorUserId: number): Promise<CustomerGroupRow> {
  const name = input.name?.trim();
  if (!name) throw new ValidationError('Name is required.');
  if (await nameTakenByAnother(name)) throw new ValidationError(`"${name}" is already in use.`);

  let etlSegmentName: string | null = null;
  if (input.etlSegmentKey !== undefined && input.etlSegmentKey !== null) {
    if (!(await etlSegmentExists(input.etlSegmentKey))) throw new ValidationError('Invalid ETL segment selected.');
    if (await etlSegmentTakenByAnother(input.etlSegmentKey)) {
      throw new ValidationError('That ETL segment is already linked to another customer group.');
    }
    const [rows] = await pool.query('SELECT Segment FROM Dim_Segment WHERE SegmentKey = ?', [input.etlSegmentKey]);
    etlSegmentName = (rows as { Segment: string }[])[0]?.Segment ?? null;
  }

  const definition = input.definition ?? null;
  const etlSegmentKey = input.etlSegmentKey ?? null;
  const displayOrder = input.displayOrder ?? 0;
  const criticalNumberPct = input.criticalNumberPct ?? 0;
  validatePct(criticalNumberPct);

  const [result] = await pool.query(
    `INSERT INTO admin_customer_group (name, definition, etl_segment_key, etl_segment_name, display_order, critical_number_pct, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [name, definition, etlSegmentKey, etlSegmentName, displayOrder, criticalNumberPct, actorUserId, actorUserId],
  );
  const id = (result as { insertId: number }).insertId;
  await recordHistory(id, { name, definition, etl_segment_key: etlSegmentKey, etl_segment_name: etlSegmentName, display_order: displayOrder, critical_number_pct: criticalNumberPct, is_active: true }, 'CREATE', actorUserId);

  const row = await getCustomerGroupById(id);
  if (!row) throw new ValidationError('Customer group not found after creation.');
  return row;
}

export interface UpdateCustomerGroupInput {
  name?: string;
  definition?: string | null;
  etlSegmentKey?: number | null;
  displayOrder?: number;
  criticalNumberPct?: number;
  isActive?: boolean;
}

export async function updateCustomerGroup(id: number, input: UpdateCustomerGroupInput, actorUserId: number): Promise<CustomerGroupRow> {
  const existing = await getCustomerGroupById(id);
  if (!existing) throw new ValidationError('Customer group not found.');

  let name = existing.name;
  if (input.name !== undefined) {
    name = input.name.trim();
    if (!name) throw new ValidationError('Name cannot be empty.');
    if (await nameTakenByAnother(name, id)) throw new ValidationError(`"${name}" is already in use.`);
  }

  let etlSegmentKey = existing.etl_segment_key;
  let etlSegmentName = existing.etl_segment_name;
  if (input.etlSegmentKey !== undefined) {
    if (input.etlSegmentKey === null) {
      etlSegmentKey = null;
      etlSegmentName = null;
    } else {
      if (!(await etlSegmentExists(input.etlSegmentKey))) throw new ValidationError('Invalid ETL segment selected.');
      if (await etlSegmentTakenByAnother(input.etlSegmentKey, id)) {
        throw new ValidationError('That ETL segment is already linked to another customer group.');
      }
      const [rows] = await pool.query('SELECT Segment FROM Dim_Segment WHERE SegmentKey = ?', [input.etlSegmentKey]);
      etlSegmentKey = input.etlSegmentKey;
      etlSegmentName = (rows as { Segment: string }[])[0]?.Segment ?? null;
    }
  }

  const definition = input.definition !== undefined ? input.definition : existing.definition;
  const displayOrder = input.displayOrder !== undefined ? input.displayOrder : existing.display_order;

  let criticalNumberPct = existing.critical_number_pct;
  if (input.criticalNumberPct !== undefined) {
    validatePct(input.criticalNumberPct);
    criticalNumberPct = input.criticalNumberPct;
  }

  let isActive = existing.is_active;
  let action: 'UPDATE' | 'DEACTIVATE' | 'REACTIVATE' = 'UPDATE';
  if (input.isActive !== undefined && input.isActive !== existing.is_active) {
    if (input.isActive === false) {
      const used = await usageCount(etlSegmentKey);
      if (used > 0) {
        throw new ValidationError(
          `This customer group is assigned to ${used} salesperson/sales-team record(s). Reassign them before deactivating.`,
        );
      }
      action = 'DEACTIVATE';
    } else {
      action = 'REACTIVATE';
    }
    isActive = input.isActive;
  }

  await pool.query(
    `UPDATE admin_customer_group
     SET name = ?, definition = ?, etl_segment_key = ?, etl_segment_name = ?, display_order = ?, critical_number_pct = ?, is_active = ?, updated_by = ?
     WHERE customer_group_id = ?`,
    [name, definition, etlSegmentKey, etlSegmentName, displayOrder, criticalNumberPct, isActive, actorUserId, id],
  );
  await recordHistory(id, { name, definition, etl_segment_key: etlSegmentKey, etl_segment_name: etlSegmentName, display_order: displayOrder, critical_number_pct: criticalNumberPct, is_active: isActive }, action, actorUserId);

  const row = await getCustomerGroupById(id);
  if (!row) throw new ValidationError('Customer group not found after update.');
  return row;
}

/** Hard delete -- only when nothing currently references this group's ETL segment. The history
 * row is written before the delete (admin_customer_group_history.customer_group_id has no FK back
 * to admin_customer_group -- see 0018's header -- specifically so this audit row survives). */
export async function deleteCustomerGroup(id: number, actorUserId: number): Promise<void> {
  const existing = await getCustomerGroupById(id);
  if (!existing) throw new ValidationError('Customer group not found.');
  const used = await usageCount(existing.etl_segment_key);
  if (used > 0) {
    throw new ValidationError(
      `This customer group is assigned to ${used} salesperson/sales-team record(s) and cannot be deleted. Reassign them, or deactivate instead.`,
    );
  }
  await recordHistory(
    id,
    {
      name: existing.name,
      definition: existing.definition,
      etl_segment_key: existing.etl_segment_key,
      etl_segment_name: existing.etl_segment_name,
      display_order: existing.display_order,
      critical_number_pct: existing.critical_number_pct,
      is_active: existing.is_active,
    },
    'DELETE',
    actorUserId,
  );
  await pool.query('DELETE FROM admin_customer_group WHERE customer_group_id = ?', [id]);
}

export interface EtlSegmentOption {
  segment_key: number;
  segment_name: string;
}

export async function getEtlSegmentOptions(): Promise<EtlSegmentOption[]> {
  const [rows] = await pool.query('SELECT SegmentKey AS segment_key, Segment AS segment_name FROM Dim_Segment ORDER BY SegmentKey');
  return rows as EtlSegmentOption[];
}
