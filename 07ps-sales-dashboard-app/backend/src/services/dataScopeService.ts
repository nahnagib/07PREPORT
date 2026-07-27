import { ValidationError } from '../lib/errors';
import { pool } from '../db/pool';
import type { DataScopeRule, Filters } from '../measures/filters';

/** The 5 dimensions a data-scope rule can target, same set as Filters/FilterBar. Order here is
 * the order the admin UI's dimension picker shows them in. */
export const DATA_SCOPE_DIMENSIONS: { key: keyof Filters; label: string }[] = [
  { key: 'companyKeys', label: 'Company' },
  { key: 'segmentKeys', label: 'Customer Group' },
  { key: 'channelKeys', label: 'Distribution Channel' },
  { key: 'salesTeamKeys', label: 'Branch' },
  { key: 'salespersonKeys', label: 'Sales Person' },
];

const VALID_DIMENSIONS = new Set(DATA_SCOPE_DIMENSIONS.map((d) => d.key));

/** Dim_* lookup table/columns each dimension's value resolves a human-readable label from --
 * same mapping routes/filters.ts's value-list endpoints already use. */
const DIMENSION_LOOKUP: Record<keyof Filters, { table: string; keyCol: string; labelCol: string }> = {
  companyKeys: { table: 'Dim_Company', keyCol: 'CompanyKey', labelCol: 'Company' },
  segmentKeys: { table: 'Dim_Segment', keyCol: 'SegmentKey', labelCol: 'Segment' },
  channelKeys: { table: 'Dim_DistributionChannel', keyCol: 'ChannelKey', labelCol: 'DistributionChannel' },
  salesTeamKeys: { table: 'Dim_SalesTeam', keyCol: 'SalesTeamKey', labelCol: 'SalesTeam' },
  salespersonKeys: { table: 'Dim_Salesperson', keyCol: 'SalespersonKey', labelCol: 'salesperson' },
};

interface RoleDataScopeRow {
  scope_id: number;
  role_id: number;
  dimension: keyof Filters;
  value: string;
}

/** Raw rules for one role, used at request time (backend/src/middleware/scopeContext.ts) -- no
 * label resolution, kept fast since it runs on every request. */
export async function getRoleDataScopeRules(roleId: number | null | undefined): Promise<DataScopeRule[]> {
  if (roleId === null || roleId === undefined) {
    return [];
  }
  const [rows] = await pool.query('SELECT dimension, value FROM role_data_scope WHERE role_id = ?', [roleId]);
  return (rows as Pick<RoleDataScopeRow, 'dimension' | 'value'>[]).map((r) => ({
    dimension: r.dimension,
    value: r.value,
  }));
}

export interface DataScopeRuleWithLabel {
  scopeId: number;
  dimension: keyof Filters;
  value: string;
  label: string;
}

/** Every role's data-scope rules, with each rule's value resolved to a display label, for the
 * Role & Permission Management admin page. Computed fresh on every call, same "no caching" policy
 * as getRolePermissionMatrix. */
export async function getAllRoleDataScopeRulesWithLabels(): Promise<Record<number, DataScopeRuleWithLabel[]>> {
  const [rows] = await pool.query('SELECT scope_id, role_id, dimension, value FROM role_data_scope');
  const allRows = rows as RoleDataScopeRow[];

  // Resolve labels one query per dimension actually present, filtering IN (its own values) --
  // role_data_scope is small, so this stays a handful of tiny queries rather than one per rule.
  const rowsByDimension = new Map<keyof Filters, RoleDataScopeRow[]>();
  for (const row of allRows) {
    const existing = rowsByDimension.get(row.dimension);
    if (existing) existing.push(row);
    else rowsByDimension.set(row.dimension, [row]);
  }

  const labelsByDimensionAndValue = new Map<string, string>();
  for (const [dimension, dimensionRows] of rowsByDimension) {
    const lookup = DIMENSION_LOOKUP[dimension];
    const values = [...new Set(dimensionRows.map((r) => r.value))];
    if (values.length === 0) continue;
    const placeholders = values.map(() => '?').join(', ');
    const [labelRows] = await pool.query(
      `SELECT ${lookup.keyCol} AS \`key\`, ${lookup.labelCol} AS label FROM ${lookup.table} WHERE ${lookup.keyCol} IN (${placeholders})`,
      values,
    );
    for (const labelRow of labelRows as { key: string | number; label: string }[]) {
      labelsByDimensionAndValue.set(`${dimension}:${labelRow.key}`, labelRow.label);
    }
  }

  const result: Record<number, DataScopeRuleWithLabel[]> = {};
  for (const row of allRows) {
    result[row.role_id] = result[row.role_id] ?? [];
    result[row.role_id].push({
      scopeId: row.scope_id,
      dimension: row.dimension,
      value: row.value,
      label: labelsByDimensionAndValue.get(`${row.dimension}:${row.value}`) ?? row.value,
    });
  }
  return result;
}

export async function addRoleDataScopeRule(
  roleId: number,
  dimension: string,
  value: string,
): Promise<void> {
  if (!VALID_DIMENSIONS.has(dimension as keyof Filters)) {
    throw new ValidationError(`Unknown data-scope dimension: ${dimension}`);
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError('A non-empty value is required.');
  }
  await pool.query('INSERT IGNORE INTO role_data_scope (role_id, dimension, value) VALUES (?, ?, ?)', [
    roleId,
    dimension,
    value,
  ]);
}

export async function removeRoleDataScopeRule(roleId: number, scopeId: number): Promise<void> {
  await pool.query('DELETE FROM role_data_scope WHERE scope_id = ? AND role_id = ?', [scopeId, roleId]);
}
