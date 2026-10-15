import { ValidationError } from '../lib/errors';
import { pool } from '../db/pool';
import {
  SCOPE_DIMENSIONS,
  SCOPE_OPERATORS,
  groupScopeRows,
  resolveRoleScope,
  type DataScopeRule,
  type Filters,
  type RoleScopeRule,
  type ScopeDimension,
  type ScopeOperator,
} from '../measures/filters';

/** The 5 dimensions a data-scope rule can target, same set as Filters/FilterBar. Order here is
 * the order the admin UI's dimension picker shows them in. */
export const DATA_SCOPE_DIMENSIONS: { key: keyof Filters; label: string }[] = [
  { key: 'companyKeys', label: 'Company' },
  { key: 'segmentKeys', label: 'Customer Group' },
  { key: 'channelKeys', label: 'Distribution Channel' },
  { key: 'salesTeamKeys', label: 'Branch' },
  { key: 'salespersonKeys', label: 'Sales Person' },
];

/** dim_* lookup table/columns each dimension's values (and their labels) come from -- the same tables the facts'
 * keys point to, the -1 Unknown / Unassigned member included. */
const DIMENSION_LOOKUP: Record<ScopeDimension, { table: string; keyCol: string; labelCol: string }> = {
  companyKeys: { table: 'dim_company', keyCol: 'CompanyKey', labelCol: 'Company' },
  segmentKeys: { table: 'dim_segment', keyCol: 'SegmentKey', labelCol: 'Segment' },
  channelKeys: { table: 'dim_channel', keyCol: 'ChannelKey', labelCol: 'DistributionChannel' },
  salesTeamKeys: { table: 'dim_sales_team', keyCol: 'SalesTeamKey', labelCol: 'SalesTeam' },
  salespersonKeys: { table: 'dim_salesperson', keyCol: 'SalespersonKey', labelCol: 'salesperson' },
};

/** The -1 member's picker label when its dim row has no name of its own. */
const UNKNOWN_LABEL: Record<ScopeDimension, string> = {
  companyKeys: 'Unknown company',
  segmentKeys: 'Unknown',
  channelKeys: 'Unknown',
  salesTeamKeys: 'Unknown branch',
  salespersonKeys: 'Unassigned',
};

type ScopeRow = { role_id: number; dimension: string; operator: string | null; value: string };

const isMissingOperatorColumn = (err: unknown) => (err as { code?: string })?.code === 'ER_BAD_FIELD_ERROR';

/** Every stored row of one role (or of every role), with its operator. Before migration 0044 is applied the column
 * does not exist: every row is then read as "in" -- exactly the old behaviour -- so deploying this code before the
 * migration never breaks a request. */
async function readScopeRows(roleId: number | null): Promise<ScopeRow[]> {
  const where = roleId === null ? '' : ' WHERE role_id = ?';
  const params = roleId === null ? [] : [roleId];
  try {
    const [rows] = await pool.query(`SELECT role_id, dimension, operator, value FROM role_data_scope${where} ORDER BY scope_id`, params);
    return rows as ScopeRow[];
  } catch (err) {
    if (!isMissingOperatorColumn(err)) throw err;
    const [rows] = await pool.query(`SELECT role_id, dimension, NULL AS operator, value FROM role_data_scope${where} ORDER BY scope_id`, params);
    return rows as ScopeRow[];
  }
}

/** Every current key of the given dimensions (their dim_* tables), as strings. */
async function dimensionKeys(dimensions: ScopeDimension[]): Promise<Partial<Record<ScopeDimension, string[]>>> {
  const out: Partial<Record<ScopeDimension, string[]>> = {};
  for (const dimension of new Set(dimensions)) {
    const l = DIMENSION_LOOKUP[dimension];
    const [rows] = await pool.query(`SELECT ${l.keyCol} AS k FROM ${l.table}`);
    out[dimension] = (rows as { k: string | number }[]).map((r) => String(r.k));
  }
  return out;
}

/** One role's rules as the admin saved them (grouped, one per dimension). */
export async function getRoleScopeRules(roleId: number | null | undefined): Promise<RoleScopeRule[]> {
  if (roleId === null || roleId === undefined) return [];
  return groupScopeRows(await readScopeRows(roleId));
}

/**
 * The role's scope RESOLVED to the allowed values per dimension, at request time (middleware/scopeContext.ts): "in"
 * rules as saved, "not_in" rules as every current key of the dimension except the excluded ones (measures/filters.ts
 * resolveRoleScope). Only a dimension with a "not_in" rule costs a lookup (a small dim table), so a role without
 * exclusions reads exactly what it read before.
 */
export async function getRoleDataScopeRules(roleId: number | null | undefined): Promise<DataScopeRule[]> {
  const rules = await getRoleScopeRules(roleId);
  if (rules.length === 0) return [];
  const domain = await dimensionKeys(rules.filter((r) => r.operator === 'not_in').map((r) => r.dimension));
  return resolveRoleScope(rules, domain);
}

export interface DimensionValue {
  value: string;
  label: string;
}

/** Every value of every scope dimension, for the Roles page's value picker: the full dim_* tables (never narrowed by
 * the admin's own scope), Unknown / Unassigned (-1) first, so it can be allowed or excluded on its own. */
export async function getScopeDimensionValues(): Promise<Record<ScopeDimension, DimensionValue[]>> {
  const out = {} as Record<ScopeDimension, DimensionValue[]>;
  for (const dimension of SCOPE_DIMENSIONS) out[dimension] = await getDimensionValues(dimension);
  return out;
}

/** One dimension's values for the picker (GET /admin/roles/dimension-values/:dimension): the whole dim table --
 * read straight from the warehouse, so never narrowed by the signed-in admin's own data scope. */
export async function getDimensionValues(dimension: string): Promise<DimensionValue[]> {
  if (!SCOPE_DIMENSIONS.includes(dimension as ScopeDimension)) throw new ValidationError(`Unknown data-scope dimension: ${dimension}`);
  const d = dimension as ScopeDimension;
  const l = DIMENSION_LOOKUP[d];
  const [rows] = await pool.query(`SELECT ${l.keyCol} AS k, ${l.labelCol} AS label FROM ${l.table}`);
  return (rows as { k: string | number; label: string | null }[])
    .map((r) => {
      const value = String(r.k);
      const name = r.label === null || r.label === undefined ? '' : String(r.label).trim();
      if (value === '-1') return { value, label: name && !/^(unknown|unassigned)$/i.test(name) ? `${name} (unassigned)` : UNKNOWN_LABEL[d] };
      return { value, label: name || value };
    })
    .sort((a, b) => Number(b.value === '-1') - Number(a.value === '-1') || a.label.localeCompare(b.label));
}

export interface DataScopeRuleWithLabels {
  dimension: ScopeDimension;
  operator: ScopeOperator;
  values: DimensionValue[];
}

/** Every role's rules with each value's label, for the Role & Permission Management page. Computed fresh on every
 * call, same "no caching" policy as getRolePermissionMatrix. A value no longer in its dim table shows its key. */
export async function getAllRoleDataScopeRulesWithLabels(): Promise<Record<number, DataScopeRuleWithLabels[]>> {
  const rows = await readScopeRows(null);
  const byRole = new Map<number, ScopeRow[]>();
  for (const r of rows) byRole.set(r.role_id, [...(byRole.get(r.role_id) ?? []), r]);
  const labels = new Map<string, string>();
  if (rows.length > 0) {
    const all = await getScopeDimensionValues();
    for (const d of SCOPE_DIMENSIONS) for (const v of all[d]) labels.set(`${d}:${v.value}`, v.label);
  }
  const result: Record<number, DataScopeRuleWithLabels[]> = {};
  for (const [roleId, roleRows] of byRole) {
    result[roleId] = groupScopeRows(roleRows).map((rule) => ({
      dimension: rule.dimension,
      operator: rule.operator,
      values: rule.values.map((value) => ({ value, label: labels.get(`${rule.dimension}:${value}`) ?? value })),
    }));
  }
  return result;
}

/** Validates a rule sent by the Roles page (never trusted): a known dimension and operator, at least one value,
 * duplicates dropped. Pure, so the unit tests can cover it. */
export function parseScopeRuleInput(raw: { dimension?: unknown; operator?: unknown; values?: unknown }): RoleScopeRule {
  const dimension = String(raw.dimension ?? '') as ScopeDimension;
  if (!SCOPE_DIMENSIONS.includes(dimension)) throw new ValidationError(`Unknown data-scope dimension: ${String(raw.dimension)}`);
  const operator = String(raw.operator ?? '') as ScopeOperator;
  if (!SCOPE_OPERATORS.includes(operator)) throw new ValidationError('Operator must be "in" (is any of) or "not_in" (is none of).');
  if (!Array.isArray(raw.values)) throw new ValidationError('Values must be a list.');
  const values = [...new Set(raw.values.map((v) => (typeof v === 'number' || typeof v === 'string' ? String(v).trim() : '')))];
  if (values.length === 0) throw new ValidationError('A rule needs at least one value.');
  if (values.some((v) => v === '' || v.length > 64)) throw new ValidationError('Every value must be a non-empty key (at most 64 characters).');
  return { dimension, operator, values };
}

/**
 * Saves the role's rule on one dimension, replacing whatever rule that dimension had (one rule per dimension, so two
 * rules can never contradict each other). Every value must exist in the dimension's dim_* table. The operator is
 * stored as is: an exclusion stays an exclusion, never turned into the list of values allowed today.
 */
export async function setRoleScopeRule(roleId: number, input: { dimension?: unknown; operator?: unknown; values?: unknown }): Promise<RoleScopeRule> {
  const rule = parseScopeRuleInput(input);
  const known = new Set((await dimensionKeys([rule.dimension]))[rule.dimension]);
  const unknown = rule.values.filter((v) => !known.has(v));
  if (unknown.length > 0) throw new ValidationError(`Unknown value(s) for this dimension: ${unknown.join(', ')}`);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM role_data_scope WHERE role_id = ? AND dimension = ?', [roleId, rule.dimension]);
    for (const value of rule.values) {
      await conn.query('INSERT INTO role_data_scope (role_id, dimension, operator, value) VALUES (?, ?, ?, ?)', [roleId, rule.dimension, rule.operator, value]);
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    if (isMissingOperatorColumn(err)) throw new ValidationError('Data scope operators need database migration 0044 (role_data_scope.operator).');
    throw err;
  } finally {
    conn.release();
  }
  return rule;
}

/** Removes the role's rule on one dimension (= no restriction on it). */
export async function removeRoleScopeRule(roleId: number, dimension: string): Promise<void> {
  if (!SCOPE_DIMENSIONS.includes(dimension as ScopeDimension)) throw new ValidationError(`Unknown data-scope dimension: ${dimension}`);
  await pool.query('DELETE FROM role_data_scope WHERE role_id = ? AND dimension = ?', [roleId, dimension]);
}
