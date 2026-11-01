import { ValidationError } from '../lib/errors';
import type { PoolConnection } from 'mysql2/promise';
import { pool } from '../db/pool';
import {
  SCOPE_DIMENSIONS,
  SCOPE_OPERATORS,
  combineDimensionRules,
  dimensionsNeedingDomain,
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

type ScopeRow = { role_id: number; dimension: string; rule_no: number | null; operator: string | null; value: string };

const isMissingColumn = (err: unknown) => (err as { code?: string })?.code === 'ER_BAD_FIELD_ERROR';

/** Which optional columns role_data_scope has on this database: operator (migration 0044), rule_no (0056). */
interface ScopeColumns {
  operator: boolean;
  ruleNo: boolean;
}

/** Every stored row of one role (or of every role), with its rule number and operator. On a database without
 * migration 0044 / 0056 the missing column reads as its default -- operator "in", rule 1 -- exactly the old
 * behaviour, so deploying this code before the migrations never breaks a request. */
async function readScopeRows(roleId: number | null): Promise<{ rows: ScopeRow[]; columns: ScopeColumns }> {
  const where = roleId === null ? '' : ' WHERE role_id = ?';
  const params = roleId === null ? [] : [roleId];
  const variants: { select: string; columns: ScopeColumns }[] = [
    { select: 'rule_no, operator', columns: { operator: true, ruleNo: true } },
    { select: 'NULL AS rule_no, operator', columns: { operator: true, ruleNo: false } },
    { select: 'NULL AS rule_no, NULL AS operator', columns: { operator: false, ruleNo: false } },
  ];
  for (let i = 0; ; i += 1) {
    const order = variants[i].columns.ruleNo ? 'rule_no, scope_id' : 'scope_id';
    try {
      const [rows] = await pool.query(`SELECT role_id, dimension, ${variants[i].select}, value FROM role_data_scope${where} ORDER BY ${order}`, params);
      return { rows: rows as ScopeRow[], columns: variants[i].columns };
    } catch (err) {
      if (!isMissingColumn(err) || i === variants.length - 1) throw err;
    }
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

/** One role's rules as the admin saved them (grouped: one per dimension + rule number). */
export async function getRoleScopeRules(roleId: number | null | undefined): Promise<RoleScopeRule[]> {
  if (roleId === null || roleId === undefined) return [];
  return groupScopeRows((await readScopeRows(roleId)).rows);
}

/**
 * The role's scope RESOLVED to the allowed values per dimension, at request time (middleware/scopeContext.ts): every
 * rule of a dimension applies (AND) -- the values every "in" rule lists, minus every value a "not_in" rule excludes;
 * with only "not_in" rules, every current key of the dimension except the excluded ones (measures/filters.ts
 * resolveRoleScope). Only a dimension whose rules are all "not_in" costs a lookup (a small dim table), so a role
 * without exclusions reads exactly what it read before. Every endpoint enforces this one resolved set.
 */
export async function getRoleDataScopeRules(roleId: number | null | undefined): Promise<DataScopeRule[]> {
  const rules = await getRoleScopeRules(roleId);
  if (rules.length === 0) return [];
  const domain = await dimensionKeys(dimensionsNeedingDomain(rules));
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
  ruleNo: number;
  operator: ScopeOperator;
  values: DimensionValue[];
}

/** Every role's rules with each value's label, for the Role & Permission Management page. Computed fresh on every
 * call, same "no caching" policy as getRolePermissionMatrix. A value no longer in its dim table shows its key. */
export async function getAllRoleDataScopeRulesWithLabels(): Promise<Record<number, DataScopeRuleWithLabels[]>> {
  const { rows } = await readScopeRows(null);
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
      ruleNo: rule.ruleNo,
      operator: rule.operator,
      values: rule.values.map((value) => ({ value, label: labels.get(`${rule.dimension}:${value}`) ?? value })),
    }));
  }
  return result;
}

/** Validates a rule sent by the Roles page (never trusted): a known dimension and operator, at least one value,
 * duplicates dropped. Pure, so the unit tests can cover it. */
export function parseScopeRuleInput(raw: { dimension?: unknown; operator?: unknown; values?: unknown }): Omit<RoleScopeRule, 'ruleNo'> {
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

/** Refusal of a save whose dimension rules together leave no value (e.g. "is A" AND "is not A"). */
export const NO_MATCH_MESSAGE = 'This combination matches no data: the rules on this dimension leave no value. Change or remove one of them.';

/**
 * Checks a dimension's rules as they would be after a save: two or more rules that together leave no value (e.g.
 * "is [A]" AND "is not [A]", or two "is" rules sharing no value) are refused. A single rule is never refused here --
 * one "is none of" every value stays allowed, as before (it deliberately resolves to "no data"). Pure.
 */
export function assertRulesMatchData(rules: Pick<RoleScopeRule, 'operator' | 'values'>[], domain: string[]): void {
  if (rules.length < 2) return;
  if (combineDimensionRules(rules, domain).length === 0) throw new ValidationError(NO_MATCH_MESSAGE);
}

/** The parsed rule plus its dimension's current keys; every value must be one of them. */
async function validatedRule(input: { dimension?: unknown; operator?: unknown; values?: unknown }) {
  const rule = parseScopeRuleInput(input);
  const domain = (await dimensionKeys([rule.dimension]))[rule.dimension] ?? [];
  const known = new Set(domain);
  const unknown = rule.values.filter((v) => !known.has(v));
  if (unknown.length > 0) throw new ValidationError(`Unknown value(s) for this dimension: ${unknown.join(', ')}`);
  return { rule, domain };
}

/** Writes one rule's rows, inside the caller's transaction. */
async function insertRuleRows(conn: PoolConnection, roleId: number, rule: RoleScopeRule, columns: ScopeColumns): Promise<void> {
  for (const value of rule.values) {
    if (columns.ruleNo) {
      await conn.query('INSERT INTO role_data_scope (role_id, dimension, rule_no, operator, value) VALUES (?, ?, ?, ?, ?)', [
        roleId,
        rule.dimension,
        rule.ruleNo,
        rule.operator,
        value,
      ]);
    } else {
      await conn.query('INSERT INTO role_data_scope (role_id, dimension, operator, value) VALUES (?, ?, ?, ?)', [roleId, rule.dimension, rule.operator, value]);
    }
  }
}

async function inTransaction(work: (conn: PoolConnection) => Promise<void>): Promise<void> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await work(conn);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    if (isMissingColumn(err)) throw new ValidationError('Data scope operators need database migration 0044 (role_data_scope.operator).');
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Adds a NEW rule on a dimension (POST /admin/roles/:id/data-scope), next to any rules the dimension already has --
 * all of them apply (AND). Every value must exist in the dimension's dim_* table, and the dimension's rules together
 * must still match some value (assertRulesMatchData). The operator is stored as is: an exclusion stays an exclusion,
 * never turned into the list of values allowed today.
 */
export async function addRoleScopeRule(roleId: number, input: { dimension?: unknown; operator?: unknown; values?: unknown }): Promise<RoleScopeRule> {
  const { rule, domain } = await validatedRule(input);
  const { rows, columns } = await readScopeRows(roleId);
  const existing = groupScopeRows(rows).filter((r) => r.dimension === rule.dimension);
  if (existing.length > 0 && !columns.ruleNo) {
    throw new ValidationError('A second rule on the same dimension needs database migration 0056 (role_data_scope.rule_no).');
  }
  assertRulesMatchData([...existing, rule], domain);
  const saved: RoleScopeRule = { ...rule, ruleNo: Math.max(0, ...existing.map((r) => r.ruleNo)) + 1 };
  await inTransaction((conn) => insertRuleRows(conn, roleId, saved, columns));
  return saved;
}

/** Replaces one existing rule (PUT /admin/roles/:id/data-scope/:dimension/:ruleNo): same checks as addRoleScopeRule,
 * the dimension's other rules untouched. */
export async function updateRoleScopeRule(
  roleId: number,
  ruleNo: number,
  input: { dimension?: unknown; operator?: unknown; values?: unknown },
): Promise<RoleScopeRule> {
  const { rule, domain } = await validatedRule(input);
  const { rows, columns } = await readScopeRows(roleId);
  const existing = groupScopeRows(rows).filter((r) => r.dimension === rule.dimension);
  if (!existing.some((r) => r.ruleNo === ruleNo)) throw new ValidationError('That rule no longer exists: reload the page.');
  assertRulesMatchData([...existing.filter((r) => r.ruleNo !== ruleNo), rule], domain);
  const saved: RoleScopeRule = { ...rule, ruleNo };
  await inTransaction(async (conn) => {
    if (columns.ruleNo) {
      await conn.query('DELETE FROM role_data_scope WHERE role_id = ? AND dimension = ? AND rule_no = ?', [roleId, rule.dimension, ruleNo]);
    } else {
      await conn.query('DELETE FROM role_data_scope WHERE role_id = ? AND dimension = ?', [roleId, rule.dimension]);
    }
    await insertRuleRows(conn, roleId, saved, columns);
  });
  return saved;
}

/**
 * Replaces EVERY rule of one dimension with a single rule (PUT /admin/roles/:id/data-scope/:dimension) -- the
 * one-rule-per-dimension behaviour from before migration 0056, kept for callers of that endpoint.
 */
export async function setRoleScopeRule(roleId: number, input: { dimension?: unknown; operator?: unknown; values?: unknown }): Promise<RoleScopeRule> {
  const { rule } = await validatedRule(input);
  const { columns } = await readScopeRows(roleId);
  const saved: RoleScopeRule = { ...rule, ruleNo: 1 };
  await inTransaction(async (conn) => {
    await conn.query('DELETE FROM role_data_scope WHERE role_id = ? AND dimension = ?', [roleId, rule.dimension]);
    await insertRuleRows(conn, roleId, saved, columns);
  });
  return saved;
}

/** Removes one rule of a dimension, or -- without `ruleNo` -- every rule of it (= no restriction on that dimension).
 * Removing never needs the contradiction check: fewer rules only ever widen what the role sees. */
export async function removeRoleScopeRule(roleId: number, dimension: string, ruleNo?: number): Promise<void> {
  if (!SCOPE_DIMENSIONS.includes(dimension as ScopeDimension)) throw new ValidationError(`Unknown data-scope dimension: ${dimension}`);
  if (ruleNo === undefined) {
    await pool.query('DELETE FROM role_data_scope WHERE role_id = ? AND dimension = ?', [roleId, dimension]);
    return;
  }
  const { columns } = await readScopeRows(roleId);
  if (columns.ruleNo) {
    await pool.query('DELETE FROM role_data_scope WHERE role_id = ? AND dimension = ? AND rule_no = ?', [roleId, dimension, ruleNo]);
  } else if (ruleNo === 1) {
    await pool.query('DELETE FROM role_data_scope WHERE role_id = ? AND dimension = ?', [roleId, dimension]);
  }
}
