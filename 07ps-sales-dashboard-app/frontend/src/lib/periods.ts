import { useMemo } from 'react';
import type { PeriodGranularity } from './api';

/**
 * The shared period selector of every time trend (backend lib/periods.ts holds the windows and the SQL bucketing):
 * Daily / Weekly / Monthly / Yearly, default Weekly on every page load (the choice is per page and not saved), a fixed
 * window of 30 days / 12 weeks / 12 months / 5 years that always ends with the current, still partial period.
 * Weeks run Saturday..Friday (the Collections / NPS business week) and are named by their Saturday.
 */
export const PERIOD_GRANULARITIES: readonly PeriodGranularity[] = ['day', 'week', 'month', 'year'];
export const DEFAULT_GRANULARITY: PeriodGranularity = 'week';
export const PERIOD_COUNT: Record<PeriodGranularity, number> = { day: 30, week: 12, month: 12, year: 5 };
export const GRANULARITY_LABEL: Record<PeriodGranularity, string> = { day: 'Daily', week: 'Weekly', month: 'Monthly', year: 'Yearly' };
/** The period-over-period change follows the granularity: day on day, week on week, month on month, year on year. */
export const CHANGE_LABEL: Record<PeriodGranularity, string> = { day: 'DoD', week: 'WoW', month: 'MoM', year: 'YoY' };
/** "the last 12 weeks" -- for subtitles and help text. */
export const WINDOW_LABEL: Record<PeriodGranularity, string> = {
  day: 'last 30 days',
  week: 'last 12 weeks (Sat–Fri)',
  month: 'last 12 months',
  year: 'last 5 years',
};

// Fixed English month names (browsers disagree on "Sep" / "Sept").
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const parts = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m, d, dow: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
};
const dd = (d: number) => String(d).padStart(2, '0');

/** The x-axis label of the period starting `start` (yyyy-mm-dd), unique within a window:
 * "09 Nov" (a day), "07 Nov" (a week, by its Saturday), "Nov 2026", "2026". */
export function periodAxisLabel(start: string, g: PeriodGranularity): string {
  const { y, m, d } = parts(start);
  if (g === 'year') return String(y);
  if (g === 'month') return `${MONTHS[m - 1]} ${y}`;
  return `${dd(d)} ${MONTHS[m - 1]}`;
}

/** The full name of a period, for tooltips and tables: "Mon 09 Nov 2026", "Wk of 07 Nov 2026", "Nov 2026", "2026". */
export function periodTitle(start: string, g: PeriodGranularity): string {
  const { y, m, d, dow } = parts(start);
  if (g === 'day') return `${DAYS[dow]} ${dd(d)} ${MONTHS[m - 1]} ${y}`;
  if (g === 'week') return `Wk of ${dd(d)} ${MONTHS[m - 1]} ${y}`;
  return periodAxisLabel(start, g);
}

export interface PeriodWindowView {
  granularity: PeriodGranularity;
  /** 30 / 12 / 12 / 5 */
  count: number;
  /** "Weekly" */
  name: string;
  /** "WoW" */
  changeLabel: string;
  /** "last 12 weeks (Sat–Fri)" */
  windowLabel: string;
  label: (start: string) => string;
  title: (start: string) => string;
  /** The chart's tooltip title for an axis label of these points (the label is all a chart's tooltip receives). */
  tooltipTitle: (points: readonly { start: string }[]) => (label: string) => string;
  /** The axis label of the in-progress point, for the charts' inProgressLabel (null when none is in progress). */
  inProgressLabel: (points: readonly { start: string; inProgress: boolean }[]) => string | null;
}

export function periodWindowView(g: PeriodGranularity): PeriodWindowView {
  const label = (start: string) => periodAxisLabel(start, g);
  const title = (start: string) => periodTitle(start, g);
  return {
    granularity: g,
    count: PERIOD_COUNT[g],
    name: GRANULARITY_LABEL[g],
    changeLabel: CHANGE_LABEL[g],
    windowLabel: WINDOW_LABEL[g],
    label,
    title,
    tooltipTitle: (points) => {
      const byLabel = new Map(points.map((p) => [label(p.start), title(p.start)]));
      return (l: string) => byLabel.get(l) ?? l;
    },
    inProgressLabel: (points) => {
      const p = points.find((x) => x.inProgress);
      return p ? label(p.start) : null;
    },
  };
}

/** Labels, window and change wording of a granularity (the page keeps the granularity itself in its own state). */
export function usePeriodWindow(g: PeriodGranularity): PeriodWindowView {
  return useMemo(() => periodWindowView(g), [g]);
}

/** "+12.3% WoW" -- a period-over-period change; null without a previous value. */
export function formatChange(pct: number | null | undefined, g: PeriodGranularity): string | null {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return null;
  const v = pct * 100;
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}% ${CHANGE_LABEL[g]}`;
}
