/**
 * Daily Critical Number base value by date (2026-10-21): the admin-owned critical_number_history table
 * (data/warehouse/migrations/0055_critical_number_history.sql), edited on Admin > Critical Number.
 *
 * Every change is a new dated row, so the value of a day never changes once that day is past:
 *   value on day D = the row with the latest effective_from <= D; several rows on one date -> the newest (highest id);
 *   a day before the earliest row -> the earliest row (the seed carries the old LYD 560,000 constant).
 *
 * This is the base, company-wide value. measures/criticalNumber.ts scales it by the Company / Customer Group shares.
 * Read fresh on every request (one tiny table, no cache), so an admin change shows on the very next page load.
 */

import type { Pool } from 'mysql2/promise';

/** Used only when critical_number_history cannot be read (e.g. migration 0055 not applied yet): the value the page
 * used before the table existed, so the page keeps working instead of failing. */
export const FALLBACK_CRITICAL_NUMBER = 560_000;

export interface CriticalNumberHistoryRow {
  id: number;
  valueLyd: number;
  /** YYYY-MM-DD */
  effectiveFrom: string;
  createdBy: number | null;
  createdByName: string | null;
  createdByEmail: string | null;
  /** ISO timestamp */
  createdAt: string;
  note: string | null;
}

type Queryable = Pick<Pool, 'query'>;

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value ?? '');
}

/** Every row, newest first (latest effective_from, then latest id). Falls back to a single 560,000 row, logged, when
 * the table is missing -- the Critical Number page then shows exactly what it showed before 0055. */
export async function loadCriticalNumberHistory(pool: Queryable): Promise<CriticalNumberHistoryRow[]> {
  try {
    const [rows] = await pool.query(
      `SELECT h.id, h.value_lyd AS valueLyd, DATE_FORMAT(h.effective_from, '%Y-%m-%d') AS effectiveFrom,
              h.created_by AS createdBy, u.display_name AS createdByName, u.email AS createdByEmail,
              h.created_at AS createdAt, h.note
       FROM critical_number_history h
       LEFT JOIN app_user u ON u.user_id = h.created_by
       ORDER BY h.effective_from DESC, h.id DESC`,
    );
    return (rows as Record<string, unknown>[]).map((r) => ({
      id: Number(r.id),
      valueLyd: Number(r.valueLyd),
      effectiveFrom: String(r.effectiveFrom),
      createdBy: r.createdBy === null || r.createdBy === undefined ? null : Number(r.createdBy),
      createdByName: (r.createdByName as string | null) ?? null,
      createdByEmail: (r.createdByEmail as string | null) ?? null,
      createdAt: toIso(r.createdAt),
      note: (r.note as string | null) ?? null,
    }));
  } catch (err) {
    console.error(
      '[criticalNumber] critical_number_history could not be read (migration 0055 applied?); ' +
        `using the fallback LYD ${FALLBACK_CRITICAL_NUMBER} for every day.`,
      err,
    );
    return [
      {
        id: 0,
        valueLyd: FALLBACK_CRITICAL_NUMBER,
        effectiveFrom: '1970-01-01',
        createdBy: null,
        createdByName: null,
        createdByEmail: null,
        createdAt: '',
        note: null,
      },
    ];
  }
}

function dateOnly(date: Date | string): string {
  return typeof date === 'string' ? date.slice(0, 10) : date.toISOString().slice(0, 10);
}

/** The history row active on `date` (see the module header for the rule). `history` must be newest first, as
 * loadCriticalNumberHistory returns it. Null only for an empty history. Pure. */
export function criticalNumberRowOn(history: CriticalNumberHistoryRow[], date: Date | string): CriticalNumberHistoryRow | null {
  if (history.length === 0) return null;
  const day = dateOnly(date);
  return history.find((r) => r.effectiveFrom <= day) ?? history[history.length - 1];
}

/** Base value active on `date`, from an already loaded history. Pure. */
export function criticalNumberOn(history: CriticalNumberHistoryRow[], date: Date | string): number {
  return criticalNumberRowOn(history, date)?.valueLyd ?? FALLBACK_CRITICAL_NUMBER;
}

/** A per-day base-value lookup over one loaded history: the shape the Monthly / Yearly / Missing measures sum per
 * working day. Memoised per date, since a YTD walk asks for every day of the year. */
export function criticalNumberLookup(history: CriticalNumberHistoryRow[]): (date: Date) => number {
  const memo = new Map<string, number>();
  return (date: Date) => {
    const day = dateOnly(date);
    let value = memo.get(day);
    if (value === undefined) {
      value = criticalNumberOn(history, day);
      memo.set(day, value);
    }
    return value;
  };
}

/** THE single source of the Daily Critical Number base value: the value active on `date`, unscaled. */
export async function getCriticalNumber(pool: Queryable, date: Date | string): Promise<number> {
  return criticalNumberOn(await loadCriticalNumberHistory(pool), date);
}
