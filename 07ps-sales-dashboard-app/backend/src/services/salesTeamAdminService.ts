import { pool } from '../db/pool';
import { ValidationError } from '../lib/errors';

/**
 * Sales Team Management -- same overlay pattern as salespersonAdminService.ts, keyed by
 * Dim_SalesTeam.SalesTeamKey. See data/warehouse/migrations/0016_admin_salesperson_profile.sql's
 * "Sales Team Management" section for why team_name_override exists (Dim_SalesTeam is ETL-owned
 * and full-replaced every refresh, same as Dim_Salesperson) and why team_code is a plain
 * admin-owned, NOT NULL + UNIQUE identifier independent of anything ETL-sourced.
 *
 * UPDATED (Reports/Dashboards Honor Admin Salesperson Overrides, 2026-09): segment_key_override
 * feeds every dashboard/report the same way salespersonAdminService.ts's overrides do -- see that
 * file's header. A team's own segment override is picked up wherever a salesperson's effective
 * sales-team resolves to this team (measures/filters.ts's effectiveSalesTeamExpr), so it rolls up
 * transitively through team -> segment totals without needing separate handling here.
 *
 * company_key_override (Company Link + Cascading Filter Bar, 2026-09) is NOT part of that
 * reclassification mechanism -- deliberate, confirmed, mirrors salespersonAdminService.ts's own
 * company_key_override exactly (see that file's header for the full rationale). Exists purely for
 * admin labeling and as an input to routes/filters.ts's cascading filter-option endpoints.
 */

export interface SalesTeamAdminRow {
  sales_team_key: string;
  sales_team_name: string;
  team_code: string | null;
  segment_key_override: number | null;
  segment_name_override: string | null;
  company_key_override: number | null;
  company_name_override: string | null;
  target_override_amount: number | null;
  note: string | null;
  updated_at: string | null;
  updated_by_email: string | null;
}

export interface ListSalesTeamsFilters {
  search?: string;
  segmentKey?: number;
  page: number;
  pageSize: number;
}

const BASE_SELECT = `
  SELECT
    st.SalesTeamKey AS sales_team_key,
    COALESCE(stap.team_name_override, st.SalesTeam) AS sales_team_name,
    stap.team_code,
    stap.segment_key_override,
    dsg.Segment AS segment_name_override,
    stap.company_key_override,
    dcmp.Company AS company_name_override,
    stap.target_override_amount,
    stap.note,
    stap.updated_at,
    au.email AS updated_by_email
  FROM Dim_SalesTeam st
  LEFT JOIN sales_team_admin_profile stap ON stap.sales_team_key = st.SalesTeamKey
  LEFT JOIN app_user au ON au.user_id = stap.updated_by
  LEFT JOIN Dim_Segment dsg ON dsg.SegmentKey = stap.segment_key_override
  LEFT JOIN Dim_Company dcmp ON dcmp.CompanyKey = stap.company_key_override
`;

function withNumericFields(row: SalesTeamAdminRow): SalesTeamAdminRow {
  return {
    ...row,
    target_override_amount: row.target_override_amount === null ? null : Number(row.target_override_amount),
  };
}

export async function listSalesTeams(
  filters: ListSalesTeamsFilters,
): Promise<{ rows: SalesTeamAdminRow[]; total: number }> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.search) {
    clauses.push('(st.SalesTeam LIKE ? OR stap.team_name_override LIKE ?)');
    params.push(`%${filters.search}%`, `%${filters.search}%`);
  }
  if (filters.segmentKey !== undefined) {
    clauses.push('stap.segment_key_override = ?');
    params.push(filters.segmentKey);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS total FROM Dim_SalesTeam st
     LEFT JOIN sales_team_admin_profile stap ON stap.sales_team_key = st.SalesTeamKey
     ${where}`,
    params,
  );
  const total = (countRows as { total: number }[])[0]?.total ?? 0;

  const offset = Math.max(0, (filters.page - 1) * filters.pageSize);
  const [rows] = await pool.query(
    `${BASE_SELECT} ${where} ORDER BY st.SalesTeam LIMIT ? OFFSET ?`,
    [...params, filters.pageSize, offset],
  );

  return { rows: (rows as SalesTeamAdminRow[]).map(withNumericFields), total };
}

export async function getSalesTeamRow(salesTeamKey: string): Promise<SalesTeamAdminRow | null> {
  const [rows] = await pool.query(`${BASE_SELECT} WHERE st.SalesTeamKey = ?`, [salesTeamKey]);
  const row = (rows as SalesTeamAdminRow[])[0];
  return row ? withNumericFields(row) : null;
}

async function salesTeamExists(salesTeamKey: string): Promise<boolean> {
  const [rows] = await pool.query('SELECT 1 FROM Dim_SalesTeam WHERE SalesTeamKey = ? LIMIT 1', [salesTeamKey]);
  return (rows as unknown[]).length > 0;
}

async function segmentExists(segmentKey: number): Promise<boolean> {
  const [rows] = await pool.query('SELECT 1 FROM Dim_Segment WHERE SegmentKey = ? LIMIT 1', [segmentKey]);
  return (rows as unknown[]).length > 0;
}

async function companyExists(companyKey: number): Promise<boolean> {
  const [rows] = await pool.query('SELECT 1 FROM Dim_Company WHERE CompanyKey = ? LIMIT 1', [companyKey]);
  return (rows as unknown[]).length > 0;
}

async function teamCodeTakenByAnotherTeam(teamCode: string, salesTeamKey: string): Promise<boolean> {
  const [rows] = await pool.query(
    'SELECT 1 FROM sales_team_admin_profile WHERE team_code = ? AND sales_team_key <> ? LIMIT 1',
    [teamCode, salesTeamKey],
  );
  return (rows as unknown[]).length > 0;
}

export interface UpsertSalesTeamProfileInput {
  teamNameOverride?: string | null;
  teamCode?: string;
  segmentKeyOverride?: number | null;
  companyKeyOverride?: number | null;
  targetOverrideAmount?: number | null;
  note?: string | null;
}

/** Validates against live Dim_SalesTeam/Dim_Segment plus the overlay's own uniqueness rule on
 * team_code, upserts the overlay row, and appends one history row. Not wrapped in an explicit
 * transaction -- matches salespersonAdminService.ts's and the rest of this codebase's style for a
 * single-user, low-frequency admin action. */
export async function upsertSalesTeamProfile(
  salesTeamKey: string,
  input: UpsertSalesTeamProfileInput,
  actorUserId: number,
): Promise<SalesTeamAdminRow> {
  if (!(await salesTeamExists(salesTeamKey))) {
    throw new ValidationError('Unknown sales team.');
  }
  if (input.teamNameOverride !== undefined && input.teamNameOverride !== null && input.teamNameOverride.trim() === '') {
    throw new ValidationError('Name cannot be empty.');
  }
  if (input.segmentKeyOverride !== undefined && input.segmentKeyOverride !== null) {
    if (!(await segmentExists(input.segmentKeyOverride))) {
      throw new ValidationError('Invalid customer group selected.');
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

  interface ExistingProfileRow {
    team_name_override: string | null;
    team_code: string | null;
    segment_key_override: number | null;
    company_key_override: number | null;
    target_override_amount: number | null;
    note: string | null;
  }
  const [existingRows] = await pool.query(
    'SELECT team_name_override, team_code, segment_key_override, company_key_override, target_override_amount, note FROM sales_team_admin_profile WHERE sales_team_key = ?',
    [salesTeamKey],
  );
  const existing: Partial<ExistingProfileRow> = (existingRows as ExistingProfileRow[])[0] ?? {};

  const teamCode = input.teamCode !== undefined ? input.teamCode : existing.team_code ?? undefined;
  if (!teamCode || teamCode.trim() === '') {
    throw new ValidationError('Code is required.');
  }
  if (await teamCodeTakenByAnotherTeam(teamCode, salesTeamKey)) {
    throw new ValidationError(`Code "${teamCode}" is already in use by another team.`);
  }

  const merged = {
    teamNameOverride: input.teamNameOverride !== undefined ? input.teamNameOverride : existing.team_name_override ?? null,
    teamCode,
    segmentKeyOverride: input.segmentKeyOverride !== undefined ? input.segmentKeyOverride : existing.segment_key_override ?? null,
    companyKeyOverride: input.companyKeyOverride !== undefined ? input.companyKeyOverride : existing.company_key_override ?? null,
    targetOverrideAmount: input.targetOverrideAmount !== undefined ? input.targetOverrideAmount : existing.target_override_amount ?? null,
    note: input.note !== undefined ? input.note : existing.note ?? null,
  };

  await pool.query(
    `INSERT INTO sales_team_admin_profile
       (sales_team_key, team_name_override, team_code, segment_key_override, company_key_override, target_override_amount, note, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       team_name_override = VALUES(team_name_override),
       team_code = VALUES(team_code),
       segment_key_override = VALUES(segment_key_override),
       company_key_override = VALUES(company_key_override),
       target_override_amount = VALUES(target_override_amount),
       note = VALUES(note),
       updated_by = VALUES(updated_by)`,
    [salesTeamKey, merged.teamNameOverride, merged.teamCode, merged.segmentKeyOverride, merged.companyKeyOverride, merged.targetOverrideAmount, merged.note, actorUserId],
  );

  await pool.query(
    `INSERT INTO sales_team_admin_profile_history
       (sales_team_key, team_name_override, team_code, segment_key_override, company_key_override, target_override_amount, note, changed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [salesTeamKey, merged.teamNameOverride, merged.teamCode, merged.segmentKeyOverride, merged.companyKeyOverride, merged.targetOverrideAmount, merged.note, actorUserId],
  );

  const row = await getSalesTeamRow(salesTeamKey);
  if (!row) throw new ValidationError('Sales team not found after update.');
  return row;
}

/** Bulk path is deliberately restricted to segmentKeyOverride only -- "No bulk Name/Code edit
 * (too risky)" per the approved feedback. Enforced here, not just left to frontend discipline, so
 * a stray extra field in the request body can never slip a bulk name/code change through. */
export async function bulkUpdateSalesTeamSegment(
  salesTeamKeys: string[],
  segmentKeyOverride: number | null,
  actorUserId: number,
): Promise<Array<{ salesTeamKey: string; ok: boolean; error?: string }>> {
  const results: Array<{ salesTeamKey: string; ok: boolean; error?: string }> = [];
  for (const salesTeamKey of salesTeamKeys) {
    try {
      await upsertSalesTeamProfile(salesTeamKey, { segmentKeyOverride }, actorUserId);
      results.push({ salesTeamKey, ok: true });
    } catch (err) {
      results.push({ salesTeamKey, ok: false, error: err instanceof ValidationError ? err.message : 'Update failed.' });
    }
  }
  return results;
}

/** Company Link + Cascading Filter Bar, 2026-09 -- separate bulk function (not a widened
 * bulkUpdateSalesTeamSegment) so that function's existing "segment only, nothing else" safety-rail
 * contract stays literally true for its existing callers. Same per-key try/catch-and-collect-results
 * shape. */
export async function bulkUpdateSalesTeamCompany(
  salesTeamKeys: string[],
  companyKeyOverride: number | null,
  actorUserId: number,
): Promise<Array<{ salesTeamKey: string; ok: boolean; error?: string }>> {
  const results: Array<{ salesTeamKey: string; ok: boolean; error?: string }> = [];
  for (const salesTeamKey of salesTeamKeys) {
    try {
      await upsertSalesTeamProfile(salesTeamKey, { companyKeyOverride }, actorUserId);
      results.push({ salesTeamKey, ok: true });
    } catch (err) {
      results.push({ salesTeamKey, ok: false, error: err instanceof ValidationError ? err.message : 'Update failed.' });
    }
  }
  return results;
}

export interface SalesTeamProfileHistoryRow {
  history_id: number;
  team_name_override: string | null;
  team_code: string | null;
  segment_key_override: number | null;
  company_key_override: number | null;
  target_override_amount: number | null;
  note: string | null;
  changed_at: string;
  changed_by_email: string | null;
}

export async function getSalesTeamProfileHistory(
  salesTeamKey: string,
  opts: { page: number; pageSize: number },
): Promise<{ rows: SalesTeamProfileHistoryRow[]; total: number }> {
  const [countRows] = await pool.query(
    'SELECT COUNT(*) AS total FROM sales_team_admin_profile_history WHERE sales_team_key = ?',
    [salesTeamKey],
  );
  const total = (countRows as { total: number }[])[0]?.total ?? 0;

  const offset = Math.max(0, (opts.page - 1) * opts.pageSize);
  const [rows] = await pool.query(
    `SELECT h.history_id, h.team_name_override, h.team_code, h.segment_key_override, h.company_key_override,
            h.target_override_amount, h.note, h.changed_at, au.email AS changed_by_email
     FROM sales_team_admin_profile_history h
     LEFT JOIN app_user au ON au.user_id = h.changed_by
     WHERE h.sales_team_key = ?
     ORDER BY h.changed_at DESC
     LIMIT ? OFFSET ?`,
    [salesTeamKey, opts.pageSize, offset],
  );

  return { rows: rows as SalesTeamProfileHistoryRow[], total };
}
