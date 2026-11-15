import { DateTime } from 'luxon';
import { getAppTimezone } from './timezone';

/**
 * The Product pages' period (2026-11-14, round 2):
 *   default        the rolling LAST 12 MONTHS: today - 12 months (same day) .. today, both ends included
 *                  (2026-11-14 -> 2025-11-14 .. 2026-11-14)
 *   custom range   the user's From / To (To capped at today; From never after To)
 *   prior period   the same number of days immediately before (the comparison of every growth / movement)
 * "today" is the app timezone's date. The ETL's twin of the default window is data/etl/src/sales_pipeline/periods.py.
 */
export interface ProductPeriod {
  from: string;
  to: string;
  /** Days in the period, both ends included. */
  days: number;
  priorFrom: string;
  priorTo: string;
  /** True when the period is the default Last 12 Months (no range sent, or exactly its dates). */
  isDefault: boolean;
  /** 'Last 12 Months' for the default; 'Custom range' otherwise (the page shows the dates). */
  label: string;
}

export const LAST_12_MONTHS_LABEL = 'Last 12 Months';
export const CUSTOM_RANGE_LABEL = 'Custom range';
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** from / to / days of the default Last 12 Months ending today. */
export function last12MonthsRange(now: DateTime = DateTime.now()): { from: string; to: string; days: number } {
  const to = now.setZone(getAppTimezone()).startOf('day');
  const from = to.minus({ months: 12 });
  return { from: from.toISODate() as string, to: to.toISODate() as string, days: Math.round(to.diff(from, 'days').days) + 1 };
}

export function resolveProductPeriod(fromDate?: string, toDate?: string, now: DateTime = DateTime.now()): ProductPeriod {
  const zone = getAppTimezone();
  const today = now.setZone(zone).startOf('day');
  const def = last12MonthsRange(now);
  let from = DateTime.fromISO(def.from, { zone });
  let to = today;
  if ((fromDate && ISO.test(fromDate)) || (toDate && ISO.test(toDate))) {
    if (toDate && ISO.test(toDate)) to = DateTime.fromISO(toDate, { zone });
    if (to > today) to = today;
    if (fromDate && ISO.test(fromDate)) from = DateTime.fromISO(fromDate, { zone });
    if (from > to) from = to;
  }
  const days = Math.round(to.diff(from, 'days').days) + 1;
  const priorTo = from.minus({ days: 1 });
  const priorFrom = priorTo.minus({ days: days - 1 });
  const fromIso = from.toISODate() as string;
  const toIso = to.toISODate() as string;
  const isDefault = fromIso === def.from && toIso === def.to;
  return {
    from: fromIso,
    to: toIso,
    days,
    priorFrom: priorFrom.toISODate() as string,
    priorTo: priorTo.toISODate() as string,
    isDefault,
    label: isDefault ? LAST_12_MONTHS_LABEL : CUSTOM_RANGE_LABEL,
  };
}
