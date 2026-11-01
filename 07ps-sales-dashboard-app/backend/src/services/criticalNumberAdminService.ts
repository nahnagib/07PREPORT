import { DateTime } from 'luxon';
import { pool } from '../db/pool';
import { ValidationError } from '../lib/errors';
import { getAppTimezone } from '../lib/timezone';
import {
  criticalNumberRowOn,
  loadCriticalNumberHistory,
  type CriticalNumberHistoryRow,
} from '../measures/criticalNumberHistory';
import { writeAuditLog } from './auditLogService';

/**
 * Admin > Critical Number (2026-10-21): the dated Daily Critical Number base value (critical_number_history,
 * migration 0055). A change is always a NEW row applying from its effective date onward; rows are never updated or
 * deleted, so the value of a past day never changes. Admin role only (routes/admin/criticalNumber.ts).
 *
 * There is no cached KPI to clear: the Critical Number page reads this table on every request
 * (measures/criticalNumberHistory.ts), so a change shows on the next page load, independent of any ETL refresh.
 */

export const CRITICAL_NUMBER_ENTITY = 'critical_number';
/** A change of more than this share of the current value needs an explicit confirmation. */
export const LARGE_CHANGE_RATIO = 0.5;
const MAX_VALUE = 1e14; // DECIMAL(16, 2) holds up to 99,999,999,999,999.99
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Today in the business timezone (Tripoli), YYYY-MM-DD. */
export function businessToday(): string {
  return DateTime.now().setZone(getAppTimezone()).toISODate() as string;
}

export interface CriticalNumberAdminView {
  /** The row active today (null only when the table cannot be read). */
  current: CriticalNumberHistoryRow | null;
  /** Rows with an effective date after today, soonest first. */
  scheduled: CriticalNumberHistoryRow[];
  /** Every row, newest first. */
  history: CriticalNumberHistoryRow[];
  today: string;
}

export async function getCriticalNumberAdminView(): Promise<CriticalNumberAdminView> {
  const history = await loadCriticalNumberHistory(pool);
  const today = businessToday();
  const real = history.filter((r) => r.id > 0);
  return {
    current: criticalNumberRowOn(real, today),
    scheduled: real.filter((r) => r.effectiveFrom > today).reverse(),
    history: real,
    today,
  };
}

export interface CriticalNumberChangeInput {
  value: unknown;
  effectiveFrom: unknown;
  note?: unknown;
  /** Required (true) when the value moves by more than LARGE_CHANGE_RATIO of the current value. */
  confirmLargeChange?: unknown;
}

export interface ParsedCriticalNumberChange {
  value: number;
  effectiveFrom: string;
  note: string | null;
}

/** Validates a change (never trusts the client). `today` / `currentValue` are passed in so this stays pure. */
export function parseCriticalNumberChange(
  input: CriticalNumberChangeInput,
  today: string,
  currentValue: number | null,
): ParsedCriticalNumberChange {
  const raw = typeof input.value === 'string' ? input.value.replace(/[,\s]/g, '') : input.value;
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(value)) throw new ValidationError('The value must be a number in LYD.');
  if (value <= 0) throw new ValidationError('The value must be greater than 0.');
  if (Math.abs(Math.round(value * 100) - value * 100) > 1e-6) throw new ValidationError('The value can have at most 2 decimals.');
  if (value >= MAX_VALUE) throw new ValidationError('The value is too large.');

  const effectiveFrom = String(input.effectiveFrom ?? '');
  if (!DATE_ONLY.test(effectiveFrom) || !DateTime.fromISO(effectiveFrom).isValid) {
    throw new ValidationError('"Effective from" must be a date (YYYY-MM-DD).');
  }
  if (effectiveFrom < today) {
    throw new ValidationError('"Effective from" cannot be in the past: past days keep the value that was active on them.');
  }

  const noteText = input.note === undefined || input.note === null ? '' : String(input.note).trim();
  if (noteText.length > 500) throw new ValidationError('The note can have at most 500 characters.');

  if (currentValue !== null && currentValue > 0 && Math.abs(value - currentValue) / currentValue > LARGE_CHANGE_RATIO) {
    if (input.confirmLargeChange !== true) {
      throw new ValidationError(
        `This changes the Critical Number by more than ${LARGE_CHANGE_RATIO * 100}% of the current value: confirm the change to save it.`,
      );
    }
  }
  return { value: Math.round(value * 100) / 100, effectiveFrom, note: noteText || null };
}

export async function createCriticalNumberChange(input: CriticalNumberChangeInput, actorUserId: number): Promise<CriticalNumberAdminView> {
  const before = await getCriticalNumberAdminView();
  const change = parseCriticalNumberChange(input, before.today, before.current?.valueLyd ?? null);
  let insertId: number;
  try {
    const [result] = await pool.query(
      'INSERT INTO critical_number_history (value_lyd, effective_from, created_by, note) VALUES (?, ?, ?, ?)',
      [change.value, change.effectiveFrom, actorUserId, change.note],
    );
    insertId = (result as { insertId: number }).insertId;
  } catch (err) {
    if ((err as { code?: string })?.code === 'ER_NO_SUCH_TABLE') {
      throw new ValidationError('The Critical Number needs database migration 0055 (critical_number_history).');
    }
    throw err;
  }
  await writeAuditLog({
    entityType: CRITICAL_NUMBER_ENTITY,
    entityId: String(insertId),
    action: 'CREATE',
    changedBy: actorUserId,
    before: before.current ? { valueLyd: before.current.valueLyd, effectiveFrom: before.current.effectiveFrom } : undefined,
    after: { event: 'Critical Number changed', valueLyd: change.value, effectiveFrom: change.effectiveFrom, note: change.note },
  });
  return getCriticalNumberAdminView();
}
