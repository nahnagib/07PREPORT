import { DateTime } from 'luxon';
import { getAppTimezone } from './timezone';

/**
 * The Product pages' one reporting window (2026-11-14): the rolling LAST 12 MONTHS, replacing calendar YTD.
 *
 *   last 12 months   today - 12 months (same day) .. today, both ends included (2026-11-14 -> 2025-11-14 .. 2026-11-14)
 *   prior 12 months  the 12 months before it, ending the day before it starts (2024-11-14 .. 2025-11-13)
 *
 * "today" is the app timezone's date. The ETL's twin is data/etl/src/sales_pipeline/periods.py (same rule); keep the
 * two in step.
 */
export interface Last12MonthsRange {
  from: string;
  to: string;
  /** Days in the window, both ends included. */
  days: number;
  priorFrom: string;
  priorTo: string;
}

export const LAST_12_MONTHS_LABEL = 'Last 12 Months';

export function last12MonthsRange(now: DateTime = DateTime.now()): Last12MonthsRange {
  const to = now.setZone(getAppTimezone()).startOf('day');
  const from = to.minus({ months: 12 });
  const priorTo = from.minus({ days: 1 });
  const priorFrom = from.minus({ months: 12 });
  return {
    from: from.toISODate() as string,
    to: to.toISODate() as string,
    days: Math.round(to.diff(from, 'days').days) + 1,
    priorFrom: priorFrom.toISODate() as string,
    priorTo: priorTo.toISODate() as string,
  };
}
