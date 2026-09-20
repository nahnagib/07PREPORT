/**
 * Pure geometry for the Gantt chart: where a bar sits on the time axis, whether it is clipped by
 * the selected period, and which ticks to draw. No DOM, no dates-as-local-time (everything is UTC
 * day numbers), so it is fully unit-testable and immune to timezone drift.
 */
export interface GanttRange { start: string; end: string }
export interface BarGeometry {
  visible: boolean;
  /** Percent of the axis. */
  left: number;
  width: number;
  clippedStart: boolean;
  clippedEnd: boolean;
  milestone: boolean;
}

const DAY = 86_400_000;

export function dayNumber(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return NaN;
  return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY);
}

export const isoOf = (day: number): string => new Date(day * DAY).toISOString().slice(0, 10);

/** Inclusive number of days in the range. */
export function rangeDays(r: GanttRange): number {
  return dayNumber(r.end) - dayNumber(r.start) + 1;
}

/**
 * A bar covers [start, end] inclusive. `end` null/undefined makes a milestone (a point on the
 * start date). Bars entirely outside the range are `visible: false`; bars that overhang get an
 * arrow (`clippedStart` / `clippedEnd`) and are trimmed to the axis.
 */
export function layoutBar(range: GanttRange, bar: { start: string; end?: string | null }): BarGeometry {
  const total = rangeDays(range);
  const rs = dayNumber(range.start);
  const s = dayNumber(bar.start) - rs;
  const milestone = bar.end === null || bar.end === undefined;
  const e = milestone ? s + 1 : dayNumber(bar.end!) - rs + 1;
  if (!Number.isFinite(s) || !Number.isFinite(e) || !(total > 0)) return { visible: false, left: 0, width: 0, clippedStart: false, clippedEnd: false, milestone };
  if (e <= 0 || s >= total) return { visible: false, left: 0, width: 0, clippedStart: s < 0, clippedEnd: e > total, milestone };
  const from = Math.max(s, 0);
  const to = Math.min(Math.max(e, s + 1), total);
  return {
    visible: true,
    left: (from / total) * 100,
    width: ((to - from) / total) * 100,
    clippedStart: s < 0,
    clippedEnd: e > total,
    milestone,
  };
}

export interface Tick { pos: number; label: string; major: boolean }

export type TickGranularity = 'day' | 'week' | 'month';

/** Day ticks for short ranges, weekly (Mondays) for medium, months only for long ones. */
export function tickGranularity(days: number): TickGranularity {
  return days <= 45 ? 'day' : days <= 200 ? 'week' : 'month';
}

/** Pixels per day, so the axis never gets squashed: the chart scrolls horizontally instead. */
export function pixelsPerDay(days: number): number {
  const g = tickGranularity(days);
  return g === 'day' ? 30 : g === 'week' ? 7 : 3.4;
}

export function buildTicks(range: GanttRange, monthLabel: (year: number, month: number, showYear: boolean) => string): Tick[] {
  const total = rangeDays(range);
  const rs = dayNumber(range.start);
  const gran = tickGranularity(total);
  const ticks: Tick[] = [];
  for (let d = 0; d < total; d++) {
    const date = new Date((rs + d) * DAY);
    const dom = date.getUTCDate();
    const y = date.getUTCFullYear();
    if (dom === 1 || d === 0) {
      // Month boundary (and the very first day, so a range starting mid-month still gets a label).
      ticks.push({ pos: (d / total) * 100, label: monthLabel(y, date.getUTCMonth() + 1, d === 0 || date.getUTCMonth() === 0), major: true });
    } else if (gran === 'day') {
      ticks.push({ pos: (d / total) * 100, label: String(dom), major: false });
    } else if (gran === 'week' && date.getUTCDay() === 1) {
      ticks.push({ pos: (d / total) * 100, label: String(dom), major: false });
    }
  }
  return ticks;
}

/** Position (percent) of a date on the axis, or null if outside the range. */
export function markerPos(range: GanttRange, iso: string): number | null {
  const total = rangeDays(range);
  const off = dayNumber(iso) - dayNumber(range.start);
  return Number.isFinite(off) && off >= 0 && off < total ? ((off + 0.5) / total) * 100 : null;
}

/** The axis range for an API `period` (first day of fromMonth .. last day of toMonth). */
export function periodRange(p: { year: number; fromMonth: number; toMonth: number }): GanttRange {
  const pad = (n: number) => String(n).padStart(2, '0');
  const last = new Date(Date.UTC(p.year, p.toMonth, 0)).getUTCDate();
  return { start: `${p.year}-${pad(p.fromMonth)}-01`, end: `${p.year}-${pad(p.toMonth)}-${pad(last)}` };
}
