import { pool } from '../db/pool';

/**
 * The ONLY module in marcomKpi that contains SQL. Every read of versioned MARCOM data goes through
 * `runCurrent`, which always adds `t.is_current = 1`, so a superseded or rolled-back row can never
 * reach a KPI and no query can "forget" the filter (a test scans the source to keep it that way).
 *
 * Values are always bound parameters. Only code-owned strings (column lists, joins, ORDER BY) are
 * ever concatenated, and column names in conditions are validated against a strict pattern.
 */
const TABLES = {
  spend: 'marcom_spend_monthly',
  other: 'marcom_other_spend',
  campaigns: 'marcom_campaign',
  media: 'marcom_campaign_media',
  social: 'marcom_social_monthly',
  web: 'marcom_web_monthly',
  trade: 'marcom_trade_monthly',
  events: 'marcom_event',
} as const;

export type KpiTable = keyof typeof TABLES;

export interface Cond { sql: string; params: unknown[] }

const COL = /^[a-z_]+\.[a-z_]+$/;
function col(c: string): string {
  if (!COL.test(c)) throw new Error(`illegal column reference: ${c}`);
  return c;
}

/** Condition builders -- values are placeholders, never inlined. */
export const where = {
  eq: (c: string, v: unknown): Cond => ({ sql: `${col(c)} = ?`, params: [v] }),
  lte: (c: string, v: unknown): Cond => ({ sql: `${col(c)} <= ?`, params: [v] }),
  gte: (c: string, v: unknown): Cond => ({ sql: `${col(c)} >= ?`, params: [v] }),
  between: (c: string, a: unknown, b: unknown): Cond => ({ sql: `${col(c)} BETWEEN ? AND ?`, params: [a, b] }),
  in: (c: string, vs: readonly unknown[]): Cond =>
    vs.length === 0 ? { sql: '1 = 0', params: [] } : { sql: `${col(c)} IN (${vs.map(() => '?').join(', ')})`, params: [...vs] },
};

export interface CurrentQuery {
  /** Code-owned select list (aliases t = the table, b = marcom_brand when joined). */
  select: string;
  joins?: string[];
  where?: (Cond | null | undefined)[];
  groupBy?: string;
  orderBy?: string;
}

export const BRAND_JOIN = 'JOIN marcom_brand b ON b.brand_id = t.brand_id';
/** Social / web rows from template 1.x have no brand (migration 0061): keep them, with a NULL brand name. */
export const BRAND_LEFT_JOIN = 'LEFT JOIN marcom_brand b ON b.brand_id = t.brand_id';
export const CATEGORY_JOIN = 'JOIN marcom_spend_category c ON c.category_id = t.category_id';

export function buildCurrentQuery(table: KpiTable, q: CurrentQuery): { sql: string; params: unknown[] } {
  const conds = (q.where ?? []).filter((c): c is Cond => !!c);
  const sql =
    `SELECT ${q.select} FROM ${TABLES[table]} t ${(q.joins ?? []).join(' ')} ` +
    `WHERE t.is_current = 1${conds.map((c) => ` AND (${c.sql})`).join('')}` +
    `${q.groupBy ? ` GROUP BY ${q.groupBy}` : ''}${q.orderBy ? ` ORDER BY ${q.orderBy}` : ''}`;
  return { sql, params: conds.flatMap((c) => c.params) };
}

export async function runCurrent<T = Record<string, unknown>>(table: KpiTable, q: CurrentQuery): Promise<T[]> {
  const { sql, params } = buildCurrentQuery(table, q);
  const [rows] = await pool.query(sql, params);
  return rows as T[];
}

/**
 * Brand master is not versioned (no is_current), so it is read directly -- with the company each brand
 * belongs to (migration 0057: marcom_brand.company_key = Dim_Company.CompanyKey; name from admin_company,
 * the same reference-data layer the other report pages' Company filter reads).
 */
export async function listBrands(): Promise<{ id: number; name: string; companyKey: number | null; company: string | null; kind: 'BRAND' | 'GROUP' }[]> {
  const [rows] = await pool.query(
    `SELECT b.brand_id AS id, b.name, b.company_key AS companyKey, c.name AS company, b.kind AS kind
       FROM marcom_brand b
       LEFT JOIN (SELECT etl_company_key, MIN(name) AS name FROM admin_company WHERE etl_company_key IS NOT NULL GROUP BY etl_company_key) c
         ON c.etl_company_key = b.company_key
      ORDER BY b.name`,
  );
  return (rows as { id: number; name: string; companyKey: unknown; company: string | null; kind: string | null }[]).map((r) => ({
    id: Number(r.id), name: r.name, companyKey: r.companyKey === null || r.companyKey === undefined ? null : Number(r.companyKey), company: r.company ?? null,
    kind: r.kind === 'GROUP' ? 'GROUP' as const : 'BRAND' as const,
  }));
}

/** Other-spend categories in lookup order (marcom_spend_category is reference data, not versioned). */
export async function listSpendCategories(): Promise<string[]> {
  const [rows] = await pool.query('SELECT name FROM marcom_spend_category ORDER BY sort_order, name');
  return (rows as { name: string }[]).map((r) => r.name);
}

/** Latest uploaded (year, month) across the four month-keyed tables, optionally within one year. */
export async function latestMonth(year?: number): Promise<{ year: number; month: number } | null> {
  const tables: KpiTable[] = ['spend', 'other', 'social', 'web', 'trade'];
  const results = await Promise.all(
    tables.map((t) =>
      runCurrent<{ ym: number | null }>(t, {
        select: 't.year * 100 + t.month AS ym',
        where: [year === undefined ? null : where.eq('t.year', year)],
        orderBy: 'ym DESC LIMIT 1',
      }),
    ),
  );
  const best = Math.max(0, ...results.map((r) => Number(r[0]?.ym ?? 0)));
  return best ? { year: Math.floor(best / 100), month: best % 100 } : null;
}

/** Every year that has any current MARCOM data (month-keyed tables, plus campaign and event dates), ascending. */
export async function availableYears(): Promise<number[]> {
  const parts = [
    buildCurrentQuery('spend', { select: 'DISTINCT t.year AS y' }),
    buildCurrentQuery('other', { select: 'DISTINCT t.year AS y' }),
    buildCurrentQuery('social', { select: 'DISTINCT t.year AS y' }),
    buildCurrentQuery('web', { select: 'DISTINCT t.year AS y' }),
    buildCurrentQuery('trade', { select: 'DISTINCT t.year AS y' }),
    buildCurrentQuery('campaigns', { select: 'DISTINCT YEAR(t.start_date) AS y' }),
    buildCurrentQuery('events', { select: 'DISTINCT YEAR(t.planned_date) AS y' }),
  ];
  const [rows] = await pool.query(`${parts.map((p) => `(${p.sql})`).join(' UNION ')} ORDER BY y`, parts.flatMap((p) => p.params));
  return (rows as { y: number }[]).map((r) => Number(r.y));
}
