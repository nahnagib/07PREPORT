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

/** Brand master is not versioned (no is_current), so it is read directly. */
export async function listBrands(): Promise<{ id: number; name: string }[]> {
  const [rows] = await pool.query('SELECT brand_id AS id, name FROM marcom_brand ORDER BY name');
  return rows as { id: number; name: string }[];
}

/** Latest uploaded (year, month) across the four month-keyed tables, optionally within one year. */
export async function latestMonth(year?: number): Promise<{ year: number; month: number } | null> {
  const tables: KpiTable[] = ['spend', 'social', 'web', 'trade'];
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
    buildCurrentQuery('social', { select: 'DISTINCT t.year AS y' }),
    buildCurrentQuery('web', { select: 'DISTINCT t.year AS y' }),
    buildCurrentQuery('trade', { select: 'DISTINCT t.year AS y' }),
    buildCurrentQuery('campaigns', { select: 'DISTINCT YEAR(t.start_date) AS y' }),
    buildCurrentQuery('events', { select: 'DISTINCT YEAR(t.planned_date) AS y' }),
  ];
  const [rows] = await pool.query(`${parts.map((p) => `(${p.sql})`).join(' UNION ')} ORDER BY y`, parts.flatMap((p) => p.params));
  return (rows as { y: number }[]).map((r) => Number(r.y));
}
