import { pool } from '../db/pool';
import { ValidationError } from '../lib/errors';

/**
 * Admin-controlled reference data for Company -- same overlay pattern as
 * customerGroupAdminService.ts (see that file's header, and
 * data/warehouse/migrations/0018_reference_data_admin.sql), applied to Dim_Company instead of
 * Dim_Segment.
 *
 * Unlike Customer Group/Distribution Channel, neither salesperson_admin_profile nor
 * sales_team_admin_profile has any company-related override column, and app_user.company_scope is
 * a separate, pre-existing ENUM('ALL','MAJAAL','TIKA') unrelated to this table (changing that is a
 * different, bigger migration, out of scope here). So a company row here can never be "in use" in
 * the sense the other two reference-data types can be -- usageCount always returns 0, kept as a
 * function (not just omitted) so this service's shape stays parallel to the other two.
 */

export interface CompanyRow {
  company_id: number;
  name: string;
  definition: string | null;
  etl_company_key: number | null;
  etl_company_name: string | null;
  display_order: number;
  /** Share of the Daily Critical Number this company contributes when it's the only Company filter
   * selected (0-100) -- see data/warehouse/migrations/0021_critical_number_allocation.sql and
   * criticalNumber.ts's computeDailyCriticalNumber. Defaults to 0 for a newly created company until
   * an admin sets a real value. */
  critical_number_pct: number;
  is_active: boolean;
  created_at: string;
  created_by_email: string | null;
  updated_at: string;
  updated_by_email: string | null;
  usage_count: number;
}

const BASE_SELECT = `
  SELECT
    co.company_id, co.name, co.definition, co.etl_company_key, co.etl_company_name,
    co.display_order, co.critical_number_pct, co.is_active, co.created_at, cu.email AS created_by_email,
    co.updated_at, uu.email AS updated_by_email,
    0 AS usage_count
  FROM admin_company co
  LEFT JOIN app_user cu ON cu.user_id = co.created_by
  LEFT JOIN app_user uu ON uu.user_id = co.updated_by
`;

function withBool(row: CompanyRow): CompanyRow {
  return { ...row, is_active: Boolean(row.is_active), critical_number_pct: Number(row.critical_number_pct), usage_count: 0 };
}

function validatePct(pct: number): void {
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    throw new ValidationError('Critical Number percentage must be a number between 0 and 100.');
  }
}

export interface ListCompaniesFilters {
  isActive?: boolean;
  search?: string;
  page: number;
  pageSize: number;
}

export async function listCompanies(filters: ListCompaniesFilters): Promise<{ rows: CompanyRow[]; total: number }> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.isActive !== undefined) {
    clauses.push('co.is_active = ?');
    params.push(filters.isActive);
  }
  if (filters.search) {
    clauses.push('(co.name LIKE ? OR co.definition LIKE ?)');
    params.push(`%${filters.search}%`, `%${filters.search}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const [countRows] = await pool.query(`SELECT COUNT(*) AS total FROM admin_company co ${where}`, params);
  const total = (countRows as { total: number }[])[0]?.total ?? 0;

  const offset = Math.max(0, (filters.page - 1) * filters.pageSize);
  const [rows] = await pool.query(
    `${BASE_SELECT} ${where} ORDER BY co.display_order, co.name LIMIT ? OFFSET ?`,
    [...params, filters.pageSize, offset],
  );
  return { rows: (rows as CompanyRow[]).map(withBool), total };
}

export async function getCompanyById(id: number): Promise<CompanyRow | null> {
  const [rows] = await pool.query(`${BASE_SELECT} WHERE co.company_id = ?`, [id]);
  const row = (rows as CompanyRow[])[0];
  return row ? withBool(row) : null;
}

async function nameTakenByAnother(name: string, excludeId?: number): Promise<boolean> {
  const [rows] = await pool.query('SELECT 1 FROM admin_company WHERE name = ? AND company_id <> ? LIMIT 1', [name, excludeId ?? -1]);
  return (rows as unknown[]).length > 0;
}

async function etlCompanyExists(companyKey: number): Promise<boolean> {
  const [rows] = await pool.query('SELECT 1 FROM Dim_Company WHERE CompanyKey = ? LIMIT 1', [companyKey]);
  return (rows as unknown[]).length > 0;
}

async function etlCompanyTakenByAnother(companyKey: number, excludeId?: number): Promise<boolean> {
  const [rows] = await pool.query('SELECT 1 FROM admin_company WHERE etl_company_key = ? AND company_id <> ? LIMIT 1', [companyKey, excludeId ?? -1]);
  return (rows as unknown[]).length > 0;
}

async function recordHistory(
  companyId: number,
  row: { name: string; definition: string | null; etl_company_key: number | null; etl_company_name: string | null; display_order: number; critical_number_pct: number; is_active: boolean },
  action: 'CREATE' | 'UPDATE' | 'DEACTIVATE' | 'REACTIVATE' | 'DELETE',
  actorUserId: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO admin_company_history
       (company_id, name, definition, etl_company_key, etl_company_name, display_order, critical_number_pct, is_active, action, changed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [companyId, row.name, row.definition, row.etl_company_key, row.etl_company_name, row.display_order, row.critical_number_pct, row.is_active, action, actorUserId],
  );
}

export interface CreateCompanyInput {
  name: string;
  definition?: string | null;
  etlCompanyKey?: number | null;
  displayOrder?: number;
  criticalNumberPct?: number;
}

export async function createCompany(input: CreateCompanyInput, actorUserId: number): Promise<CompanyRow> {
  const name = input.name?.trim();
  if (!name) throw new ValidationError('Name is required.');
  if (await nameTakenByAnother(name)) throw new ValidationError(`"${name}" is already in use.`);

  let etlCompanyName: string | null = null;
  if (input.etlCompanyKey !== undefined && input.etlCompanyKey !== null) {
    if (!(await etlCompanyExists(input.etlCompanyKey))) throw new ValidationError('Invalid ETL company selected.');
    if (await etlCompanyTakenByAnother(input.etlCompanyKey)) {
      throw new ValidationError('That ETL company is already linked to another company record.');
    }
    const [rows] = await pool.query('SELECT Company FROM Dim_Company WHERE CompanyKey = ?', [input.etlCompanyKey]);
    etlCompanyName = (rows as { Company: string }[])[0]?.Company ?? null;
  }

  const definition = input.definition ?? null;
  const etlCompanyKey = input.etlCompanyKey ?? null;
  const displayOrder = input.displayOrder ?? 0;
  const criticalNumberPct = input.criticalNumberPct ?? 0;
  validatePct(criticalNumberPct);

  const [result] = await pool.query(
    `INSERT INTO admin_company (name, definition, etl_company_key, etl_company_name, display_order, critical_number_pct, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [name, definition, etlCompanyKey, etlCompanyName, displayOrder, criticalNumberPct, actorUserId, actorUserId],
  );
  const id = (result as { insertId: number }).insertId;
  await recordHistory(id, { name, definition, etl_company_key: etlCompanyKey, etl_company_name: etlCompanyName, display_order: displayOrder, critical_number_pct: criticalNumberPct, is_active: true }, 'CREATE', actorUserId);

  const row = await getCompanyById(id);
  if (!row) throw new ValidationError('Company not found after creation.');
  return row;
}

export interface UpdateCompanyInput {
  name?: string;
  definition?: string | null;
  etlCompanyKey?: number | null;
  displayOrder?: number;
  criticalNumberPct?: number;
  isActive?: boolean;
}

export async function updateCompany(id: number, input: UpdateCompanyInput, actorUserId: number): Promise<CompanyRow> {
  const existing = await getCompanyById(id);
  if (!existing) throw new ValidationError('Company not found.');

  let name = existing.name;
  if (input.name !== undefined) {
    name = input.name.trim();
    if (!name) throw new ValidationError('Name cannot be empty.');
    if (await nameTakenByAnother(name, id)) throw new ValidationError(`"${name}" is already in use.`);
  }

  let etlCompanyKey = existing.etl_company_key;
  let etlCompanyName = existing.etl_company_name;
  if (input.etlCompanyKey !== undefined) {
    if (input.etlCompanyKey === null) {
      etlCompanyKey = null;
      etlCompanyName = null;
    } else {
      if (!(await etlCompanyExists(input.etlCompanyKey))) throw new ValidationError('Invalid ETL company selected.');
      if (await etlCompanyTakenByAnother(input.etlCompanyKey, id)) {
        throw new ValidationError('That ETL company is already linked to another company record.');
      }
      const [rows] = await pool.query('SELECT Company FROM Dim_Company WHERE CompanyKey = ?', [input.etlCompanyKey]);
      etlCompanyKey = input.etlCompanyKey;
      etlCompanyName = (rows as { Company: string }[])[0]?.Company ?? null;
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
    action = input.isActive === false ? 'DEACTIVATE' : 'REACTIVATE';
    isActive = input.isActive;
  }

  await pool.query(
    `UPDATE admin_company
     SET name = ?, definition = ?, etl_company_key = ?, etl_company_name = ?, display_order = ?, critical_number_pct = ?, is_active = ?, updated_by = ?
     WHERE company_id = ?`,
    [name, definition, etlCompanyKey, etlCompanyName, displayOrder, criticalNumberPct, isActive, actorUserId, id],
  );
  await recordHistory(id, { name, definition, etl_company_key: etlCompanyKey, etl_company_name: etlCompanyName, display_order: displayOrder, critical_number_pct: criticalNumberPct, is_active: isActive }, action, actorUserId);

  const row = await getCompanyById(id);
  if (!row) throw new ValidationError('Company not found after update.');
  return row;
}

export async function deleteCompany(id: number, actorUserId: number): Promise<void> {
  const existing = await getCompanyById(id);
  if (!existing) throw new ValidationError('Company not found.');
  await recordHistory(
    id,
    {
      name: existing.name,
      definition: existing.definition,
      etl_company_key: existing.etl_company_key,
      etl_company_name: existing.etl_company_name,
      display_order: existing.display_order,
      critical_number_pct: existing.critical_number_pct,
      is_active: existing.is_active,
    },
    'DELETE',
    actorUserId,
  );
  await pool.query('DELETE FROM admin_company WHERE company_id = ?', [id]);
}

export interface EtlCompanyOption {
  company_key: number;
  company_name: string;
}

export async function getEtlCompanyOptions(): Promise<EtlCompanyOption[]> {
  const [rows] = await pool.query('SELECT CompanyKey AS company_key, Company AS company_name FROM Dim_Company ORDER BY CompanyKey');
  return rows as EtlCompanyOption[];
}
