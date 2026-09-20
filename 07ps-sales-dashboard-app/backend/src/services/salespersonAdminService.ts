import { pool } from '../db/pool';
import { ValidationError } from '../lib/errors';

/**
 * Admin Salesperson Management -- reads live Dim_Salesperson/Fact_SalesLines/Fact_Targets
 * (unchanged, read-only) and overlays the admin-owned salesperson_admin_profile table added in
 * data/warehouse/migrations/0016_admin_salesperson_profile.sql. See that migration's header for
 * why this is an overlay rather than a direct edit of the ETL-owned dims: Dim_Salesperson/
 * Dim_SalesTeam/Dim_Company/Fact_Targets are all fully dropped-and-reloaded by the ETL on every
 * refresh, so a direct write would be silently wiped, and Dim_Salesperson has no enforced key to
 * reliably UPDATE against anyway.
 *
 * UPDATED (Reports/Dashboards Honor Admin Salesperson Overrides, 2026-09): the overlay fields
 * returned below are no longer display-only annotations. channel_key_override/segment_key_override/
 * sales_team_key_override now reclassify this salesperson's revenue into the overridden bucket for
 * EVERY dashboard/report (Tachometer, Revenue Trend, Critical Number, Pipeline Health/Trend,
 * Activity Momentum, Customer Growth, Invoices Engine, the Overview PDF Report) via
 * measures/filters.ts's effectiveSegmentExpr/effectiveChannelExpr/effectiveSalesTeamExpr, and
 * target_override_amount replaces this salesperson's real Fact_Targets-derived contribution
 * everywhere a target figure is computed (measures/tachometer.ts's fetchTargetForMonths/
 * fetchTargetForMonthsGrouped). BCG Matrix/Brand Performance are the one exception -- they classify
 * products, not salesperson revenue, and are unaffected by any of this. See measures/filters.ts's
 * effectiveSegmentExpr docstring for the full mechanism.
 *
 * company_key_override (Company Link + Cascading Filter Bar, 2026-09) is the one field below that
 * does NOT feed any measure -- confirmed deliberate, not a gap to close: report Company totals
 * keep using each transaction's real Fact_*.CompanyKey, unconditionally. It exists purely for
 * admin organizational labeling and as an input to the cascading filter-option endpoints in
 * routes/filters.ts (GET /filters/customer-groups/distribution-channels/branches/salespersons).
 * See that file's SALESPERSON_COMPANY_MAP_SQL and data/warehouse/migrations/0019's header.
 */

export interface SalespersonAdminRow {
  salesperson_key: number;
  salesperson_name: string;
  admin_name_override: string | null;
  ytd_sales_value: number;
  ytd_target_amount: number;
  ytd_attainment_pct: number | null;
  channel_key_override: number | null;
  channel_name_override: string | null;
  segment_key_override: number | null;
  segment_name_override: string | null;
  sales_team_key_override: string | null;
  sales_team_name_override: string | null;
  company_key_override: number | null;
  company_name_override: string | null;
  target_override_amount: number | null;
  note: string | null;
  updated_at: string | null;
  updated_by_email: string | null;
  // Linked user account (app_user.salesperson_key -- see 0009_auth_identity.sql/0017's header).
  // Not unique/FK-enforced on the app_user side, so this is a correlated-subquery "pick one"
  // rather than a plain JOIN, to avoid multiplying rows if more than one user ever shares a key.
  linked_user_id: number | null;
  linked_user_email: string | null;
}

export interface ListSalespersonsFilters {
  search?: string;
  channelKey?: number;
  segmentKey?: number;
  salesTeamKey?: string;
  page: number;
  pageSize: number;
}

const BASE_SELECT = `
  SELECT
    ds.SalespersonKey AS salesperson_key,
    ds.salesperson    AS salesperson_name,
    sap.admin_name_override,
    COALESCE(sales.ytd_value, 0)  AS ytd_sales_value,
    COALESCE(tgt.ytd_target, 0)   AS ytd_target_amount,
    sap.channel_key_override,
    dc.DistributionChannel AS channel_name_override,
    sap.segment_key_override,
    dsg.Segment AS segment_name_override,
    sap.sales_team_key_override,
    dst.SalesTeam AS sales_team_name_override,
    sap.company_key_override,
    dcmp.Company AS company_name_override,
    sap.target_override_amount,
    sap.note,
    sap.updated_at,
    au.email AS updated_by_email,
    lu.user_id AS linked_user_id,
    lu.email AS linked_user_email
  FROM Dim_Salesperson ds
  LEFT JOIN (
    SELECT fsl.SalespersonKey, SUM(fsl.value) AS ytd_value
    FROM Fact_SalesLines fsl
    JOIN Dim_Date dd ON fsl.DateKey = dd.DateKey
    WHERE dd.Date BETWEEN ? AND ?
    GROUP BY fsl.SalespersonKey
  ) sales ON sales.SalespersonKey = ds.SalespersonKey
  LEFT JOIN (
    SELECT ft.SalespersonKey, SUM(ft.Target_Revenue) AS ytd_target
    FROM Fact_Targets ft
    WHERE ft.Year = ?
    GROUP BY ft.SalespersonKey
  ) tgt ON tgt.SalespersonKey = ds.SalespersonKey
  LEFT JOIN salesperson_admin_profile sap ON sap.salesperson_key = ds.SalespersonKey
  LEFT JOIN app_user au ON au.user_id = sap.updated_by
  LEFT JOIN Dim_DistributionChannel dc ON dc.ChannelKey = sap.channel_key_override
  LEFT JOIN Dim_Segment dsg ON dsg.SegmentKey = sap.segment_key_override
  LEFT JOIN Dim_SalesTeam dst ON dst.SalesTeamKey = sap.sales_team_key_override
  LEFT JOIN Dim_Company dcmp ON dcmp.CompanyKey = sap.company_key_override
  LEFT JOIN (
    -- app_user.salesperson_key has no unique constraint (see 0017's header), so this picks a
    -- single deterministic row per salesperson rather than letting a plain JOIN multiply rows if
    -- more than one user were ever linked to the same key.
    SELECT au1.salesperson_key, au1.user_id, au1.email
    FROM app_user au1
    WHERE au1.salesperson_key IS NOT NULL
      AND au1.user_id = (
        SELECT MIN(au2.user_id) FROM app_user au2 WHERE au2.salesperson_key = au1.salesperson_key
      )
  ) lu ON lu.salesperson_key = ds.SalespersonKey
`;

function ytdWindowParams(): [string, string, number] {
  const now = new Date();
  const year = now.getUTCFullYear();
  const start = `${year}-01-01`;
  const end = now.toISOString().slice(0, 10);
  return [start, end, year];
}

function withAttainment(row: Omit<SalespersonAdminRow, 'ytd_attainment_pct'>): SalespersonAdminRow {
  const target = Number(row.ytd_target_amount);
  return {
    ...row,
    ytd_sales_value: Number(row.ytd_sales_value),
    ytd_target_amount: target,
    target_override_amount: row.target_override_amount === null ? null : Number(row.target_override_amount),
    ytd_attainment_pct: target > 0 ? (Number(row.ytd_sales_value) / target) * 100 : null,
  };
}

export async function listSalespersons(
  filters: ListSalespersonsFilters,
): Promise<{ rows: SalespersonAdminRow[]; total: number }> {
  const [start, end, year] = ytdWindowParams();

  const clauses: string[] = [];
  const havingParams: unknown[] = [];
  if (filters.search) {
    clauses.push('ds.salesperson LIKE ?');
    havingParams.push(`%${filters.search}%`);
  }
  if (filters.channelKey !== undefined) {
    clauses.push('sap.channel_key_override = ?');
    havingParams.push(filters.channelKey);
  }
  if (filters.segmentKey !== undefined) {
    clauses.push('sap.segment_key_override = ?');
    havingParams.push(filters.segmentKey);
  }
  if (filters.salesTeamKey !== undefined) {
    clauses.push('sap.sales_team_key_override = ?');
    havingParams.push(filters.salesTeamKey);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS total FROM Dim_Salesperson ds
     LEFT JOIN salesperson_admin_profile sap ON sap.salesperson_key = ds.SalespersonKey
     ${where}`,
    havingParams,
  );
  const total = (countRows as { total: number }[])[0]?.total ?? 0;

  const offset = Math.max(0, (filters.page - 1) * filters.pageSize);
  const [rows] = await pool.query(
    `${BASE_SELECT} ${where} ORDER BY ds.salesperson LIMIT ? OFFSET ?`,
    [start, end, year, ...havingParams, filters.pageSize, offset],
  );

  return { rows: (rows as Omit<SalespersonAdminRow, 'ytd_attainment_pct'>[]).map(withAttainment), total };
}

export async function getSalespersonRow(salespersonKey: number): Promise<SalespersonAdminRow | null> {
  const [start, end, year] = ytdWindowParams();
  const [rows] = await pool.query(`${BASE_SELECT} WHERE ds.SalespersonKey = ?`, [start, end, year, salespersonKey]);
  const row = (rows as Omit<SalespersonAdminRow, 'ytd_attainment_pct'>[])[0];
  return row ? withAttainment(row) : null;
}

async function salespersonExists(salespersonKey: number): Promise<boolean> {
  const [rows] = await pool.query('SELECT 1 FROM Dim_Salesperson WHERE SalespersonKey = ? LIMIT 1', [salespersonKey]);
  return (rows as unknown[]).length > 0;
}

async function channelExists(channelKey: number): Promise<boolean> {
  const [rows] = await pool.query('SELECT 1 FROM Dim_DistributionChannel WHERE ChannelKey = ? LIMIT 1', [channelKey]);
  return (rows as unknown[]).length > 0;
}

async function segmentExists(segmentKey: number): Promise<boolean> {
  const [rows] = await pool.query('SELECT 1 FROM Dim_Segment WHERE SegmentKey = ? LIMIT 1', [segmentKey]);
  return (rows as unknown[]).length > 0;
}

async function salesTeamExists(salesTeamKey: string): Promise<boolean> {
  const [rows] = await pool.query('SELECT 1 FROM Dim_SalesTeam WHERE SalesTeamKey = ? LIMIT 1', [salesTeamKey]);
  return (rows as unknown[]).length > 0;
}

async function companyExists(companyKey: number): Promise<boolean> {
  const [rows] = await pool.query('SELECT 1 FROM Dim_Company WHERE CompanyKey = ? LIMIT 1', [companyKey]);
  return (rows as unknown[]).length > 0;
}

export interface UpsertSalespersonProfileInput {
  adminNameOverride?: string | null;
  channelKeyOverride?: number | null;
  segmentKeyOverride?: number | null;
  salesTeamKeyOverride?: string | null;
  companyKeyOverride?: number | null;
  targetOverrideAmount?: number | null;
  note?: string | null;
}

/** Validates against the live Dim_* tables (never a hardcoded enum -- see module docstring),
 * upserts the overlay row, and appends one history row. Not wrapped in an explicit transaction --
 * matches this codebase's existing style (no pool.getConnection() usage anywhere else either) for
 * a single-user, low-frequency admin action. */
export async function upsertSalespersonProfile(
  salespersonKey: number,
  input: UpsertSalespersonProfileInput,
  actorUserId: number,
): Promise<SalespersonAdminRow> {
  if (!(await salespersonExists(salespersonKey))) {
    throw new ValidationError('Unknown salesperson.');
  }
  if (input.channelKeyOverride !== undefined && input.channelKeyOverride !== null) {
    if (!(await channelExists(input.channelKeyOverride))) {
      throw new ValidationError('Invalid distribution channel selected.');
    }
  }
  if (input.segmentKeyOverride !== undefined && input.segmentKeyOverride !== null) {
    if (!(await segmentExists(input.segmentKeyOverride))) {
      throw new ValidationError('Invalid customer group selected.');
    }
  }
  if (input.salesTeamKeyOverride !== undefined && input.salesTeamKeyOverride !== null) {
    if (!(await salesTeamExists(input.salesTeamKeyOverride))) {
      throw new ValidationError('Invalid sales team selected.');
    }
  }
  if (input.companyKeyOverride !== undefined && input.companyKeyOverride !== null) {
    if (!(await companyExists(input.companyKeyOverride))) {
      throw new ValidationError('Invalid company selected.');
    }
  }
  if (
    input.targetOverrideAmount !== undefined &&
    input.targetOverrideAmount !== null &&
    !(input.targetOverrideAmount > 0)
  ) {
    throw new ValidationError('Target amount must be greater than 0.');
  }
  if (input.adminNameOverride !== undefined && input.adminNameOverride !== null && input.adminNameOverride.trim() === '') {
    throw new ValidationError('Admin name cannot be blank -- leave it unset instead to fall back to the ODOO name.');
  }

  // Merge with the existing row so a partial PATCH (e.g. just { note }) doesn't null out fields
  // the caller didn't mention.
  interface ExistingProfileRow {
    admin_name_override: string | null;
    channel_key_override: number | null;
    segment_key_override: number | null;
    sales_team_key_override: string | null;
    company_key_override: number | null;
    target_override_amount: number | null;
    note: string | null;
  }
  const [existingRows] = await pool.query(
    'SELECT admin_name_override, channel_key_override, segment_key_override, sales_team_key_override, company_key_override, target_override_amount, note FROM salesperson_admin_profile WHERE salesperson_key = ?',
    [salespersonKey],
  );
  const existing: Partial<ExistingProfileRow> = (existingRows as ExistingProfileRow[])[0] ?? {};

  const merged: Required<UpsertSalespersonProfileInput> = {
    adminNameOverride: input.adminNameOverride !== undefined ? input.adminNameOverride : existing.admin_name_override ?? null,
    channelKeyOverride: input.channelKeyOverride !== undefined ? input.channelKeyOverride : existing.channel_key_override ?? null,
    segmentKeyOverride: input.segmentKeyOverride !== undefined ? input.segmentKeyOverride : existing.segment_key_override ?? null,
    salesTeamKeyOverride: input.salesTeamKeyOverride !== undefined ? input.salesTeamKeyOverride : existing.sales_team_key_override ?? null,
    companyKeyOverride: input.companyKeyOverride !== undefined ? input.companyKeyOverride : existing.company_key_override ?? null,
    targetOverrideAmount: input.targetOverrideAmount !== undefined ? input.targetOverrideAmount : existing.target_override_amount ?? null,
    note: input.note !== undefined ? input.note : existing.note ?? null,
  };

  await pool.query(
    `INSERT INTO salesperson_admin_profile
       (salesperson_key, admin_name_override, channel_key_override, segment_key_override, sales_team_key_override, company_key_override, target_override_amount, note, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       admin_name_override = VALUES(admin_name_override),
       channel_key_override = VALUES(channel_key_override),
       segment_key_override = VALUES(segment_key_override),
       sales_team_key_override = VALUES(sales_team_key_override),
       company_key_override = VALUES(company_key_override),
       target_override_amount = VALUES(target_override_amount),
       note = VALUES(note),
       updated_by = VALUES(updated_by)`,
    [
      salespersonKey,
      merged.adminNameOverride,
      merged.channelKeyOverride,
      merged.segmentKeyOverride,
      merged.salesTeamKeyOverride,
      merged.companyKeyOverride,
      merged.targetOverrideAmount,
      merged.note,
      actorUserId,
    ],
  );

  await pool.query(
    `INSERT INTO salesperson_admin_profile_history
       (salesperson_key, admin_name_override, channel_key_override, segment_key_override, sales_team_key_override, company_key_override, target_override_amount, note, changed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      salespersonKey,
      merged.adminNameOverride,
      merged.channelKeyOverride,
      merged.segmentKeyOverride,
      merged.salesTeamKeyOverride,
      merged.companyKeyOverride,
      merged.targetOverrideAmount,
      merged.note,
      actorUserId,
    ],
  );

  const row = await getSalespersonRow(salespersonKey);
  if (!row) throw new ValidationError('Salesperson not found after update.');
  return row;
}

export interface SalespersonProfileHistoryRow {
  history_id: number;
  admin_name_override: string | null;
  channel_key_override: number | null;
  segment_key_override: number | null;
  sales_team_key_override: string | null;
  company_key_override: number | null;
  target_override_amount: number | null;
  note: string | null;
  changed_at: string;
  changed_by_email: string | null;
}

export async function getSalespersonProfileHistory(
  salespersonKey: number,
  opts: { page: number; pageSize: number },
): Promise<{ rows: SalespersonProfileHistoryRow[]; total: number }> {
  const [countRows] = await pool.query(
    'SELECT COUNT(*) AS total FROM salesperson_admin_profile_history WHERE salesperson_key = ?',
    [salespersonKey],
  );
  const total = (countRows as { total: number }[])[0]?.total ?? 0;

  const offset = Math.max(0, (opts.page - 1) * opts.pageSize);
  const [rows] = await pool.query(
    `SELECT h.history_id, h.admin_name_override, h.channel_key_override, h.segment_key_override, h.sales_team_key_override,
            h.company_key_override, h.target_override_amount, h.note, h.changed_at, au.email AS changed_by_email
     FROM salesperson_admin_profile_history h
     LEFT JOIN app_user au ON au.user_id = h.changed_by
     WHERE h.salesperson_key = ?
     ORDER BY h.changed_at DESC
     LIMIT ? OFFSET ?`,
    [salespersonKey, opts.pageSize, offset],
  );

  return { rows: rows as SalespersonProfileHistoryRow[], total };
}
