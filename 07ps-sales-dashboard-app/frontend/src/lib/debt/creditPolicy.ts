import type { CreditCustomer, CreditPolicyZone, CreditZoneKey, RowCreditZone } from '../api';
import { formatNumber } from '../format';

/**
 * Pure helpers of the "Credit Policy Escalation" chart and the Customers table's "Aging bucket" (2026-10-15). The
 * zones themselves are NOT defined here: they come from the API (backend config/creditPolicy.ts, the one definition of
 * the policy -- GET /debt-report/aging `zones`, GET /debt-report/meta `creditPolicy.zones`). This file only turns them
 * into colours, words and pixels.
 */

export const NOT_YET_DUE: CreditZoneKey = 'NOT_YET_DUE';
export const NOT_YET_DUE_LABEL = 'Not yet due';

/** Zone colours (tokens.css --ps-credit-*). */
export const creditColor = (tone: string) => `var(--ps-credit-${tone})`;
export const creditSoft = (tone: string) => `var(--ps-credit-${tone}-soft)`;
/** Plot/header surfaces have their own light/dark contrast pairs. */
export const creditBand = (tone: string) => `var(--ps-credit-${tone}-band)`;
export const creditHeader = (tone: string) => `var(--ps-credit-${tone}-header)`;
/** Keep API policy keys stable while displaying the black escalation zone by its color name. */
export const zoneLabel = (zone: Pick<CreditPolicyZone, 'key' | 'label'>) => zone.key === 'BLOCK' ? 'BLACK' : zone.label;

/** Main-zone ranges: "0 – 15 Days", "45+ Days". */
export function zoneRange(z: Pick<CreditPolicyZone, 'minDays' | 'maxDays'>): string {
  if (z.maxDays === null) return `${formatNumber(z.minDays)}+ Days`;
  return `${formatNumber(z.minDays)} – ${formatNumber(z.maxDays)} Days`;
}

/** The open-ended action range on the x-axis. */
export function lastZoneAxisLabel(zones: CreditPolicyZone[]): string {
  const sections = timelineSections(zones);
  return `>${formatNumber(sections[sections.length - 1].minDays - 1)} Days`;
}

/** "Moves to YELLOW (Sales Director) in 3 days if unpaid." -- null without a next zone. */
export function nextZoneText(c: Pick<CreditCustomer, 'nextZone' | 'daysToNextZone'>, zones: CreditPolicyZone[]): string | null {
  if (!c.nextZone || c.daysToNextZone === null) return null;
  const z = zones.find((x) => x.key === c.nextZone);
  if (!z) return null;
  return `Moves to ${zoneLabel(z)} (${z.owner}) in ${formatNumber(c.daysToNextZone)} day${c.daysToNextZone === 1 ? '' : 's'} if unpaid.`;
}

// ---- Customers table: the "Aging bucket" column -------------------------------------------------------------------------
export interface CreditBucket {
  /** The numeric overdue range, "Not yet due", or "—". */
  label: string;
  /** The filter value is the same numeric range label, "Not yet due", or "—". */
  filterValue: string;
  tone: string | null;
  /** sorts by actual age: credits only < not yet due (the later the due date, the lower) < days overdue */
  sortValue: number;
  detail: string;
}

export const NO_BUCKET = '—';

const OVERDUE_RANGES = ['Overdue 1 – 30', 'Overdue 31 – 60', 'Overdue 61 – 90', 'Overdue 90+'];

/** Standard aging counts from the due date. The policy API counts its first late day as day 0. */
export function creditBucket(z: RowCreditZone | null): CreditBucket {
  if (!z) return { label: NO_BUCKET, filterValue: NO_BUCKET, tone: null, sortValue: -1_000_000, detail: 'No unpaid customer invoice in this view (credits or other entries only).' };
  if (z.zone === NOT_YET_DUE) return { label: NOT_YET_DUE_LABEL, filterValue: NOT_YET_DUE_LABEL, tone: null, sortValue: -1 - z.daysUntilDue,
    detail: z.daysUntilDue === 0 ? 'The oldest unpaid invoice is due today.' : `The oldest unpaid invoice is due in ${formatNumber(z.daysUntilDue)} days.` };
  const days = z.daysOverdue + 1;
  const label = OVERDUE_RANGES[days <= 30 ? 0 : days <= 60 ? 1 : days <= 90 ? 2 : 3];
  return { label, filterValue: label, tone: null, sortValue: days,
    detail: `${formatNumber(days)} day${days === 1 ? '' : 's'} overdue, counted from the oldest unpaid invoice's due date. 90+ means more than 90 days.` };
}

/** Not yet due, the four standard overdue ranges, then — (no unpaid invoice). */
export function creditBucketOptions(): { value: string; label: string }[] {
  return [NOT_YET_DUE_LABEL, ...OVERDUE_RANGES, NO_BUCKET].map((v) => ({ value: v, label: v }));
}

// ---- chart geometry ---------------------------------------------------------------------------------------------------
export interface ZoneColumn {
  key: string;
  x0: number;
  x1: number;
}

/** Action ranges share their parent zone's status, owner and colour. */
export function timelineSections(zones: CreditPolicyZone[]): (CreditPolicyZone & { details?: string })[] {
  return zones.flatMap((z) => z.actionAreas?.length
    ? z.actionAreas.map((a) => ({ ...z, ...a, actionAreas: undefined }))
    : [z]);
}

export interface ChartColumns {
  /** Four main policy zones. */
  zones: ZoneColumn[];
  /** Includes the internal BLOCK action ranges. */
  sections: ZoneColumn[];
  width: number;
}

/** Scroll on narrow screens to keep the action headers legible. */
export const CHART_MIN_WIDTH = 960;

export function chartColumns(width: number, zones: CreditPolicyZone[]): ChartColumns {
  const w = Math.max(width, CHART_MIN_WIDTH);
  const sections = timelineSections(zones);
  const weights = sections.map((s) => s.maxDays === null ? 1.35 : s.minDays === 61 ? 1.2 : 1);
  const total = weights.reduce((a, b) => a + b, 0);
  let x = 0;
  const sectionCols = sections.map((s, i) => {
    const col = { key: `${s.key}-${s.minDays}`, x0: x, x1: i === sections.length - 1 ? w : x + w * weights[i] / total };
    x = col.x1;
    return col;
  });
  return {
    width: w,
    sections: sectionCols,
    zones: zones.map((z) => {
      const indices = sections.map((s, i) => s.key === z.key ? i : -1).filter((i) => i >= 0);
      return { key: z.key, x0: sectionCols[indices[0]].x0, x1: sectionCols[indices[indices.length - 1]].x1 };
    }),
  };
}

export const DOT_MIN_R = 3.5;
export const DOT_MAX_R = 17;

/** sqrt scaling: dot AREA proportional to the amount, the largest at `maxR`, never below `minR`. */
export function dotRadius(amount: number, maxAmount: number, minR = DOT_MIN_R, maxR = DOT_MAX_R): number {
  if (!(maxAmount > 0) || !(amount > 0)) return minR;
  return Math.max(minR, maxR * Math.sqrt(amount / maxAmount));
}

/** x of a number of days overdue inside its (closed) zone: linear in days between the zone's inner edges. */
export function xOfDays(days: number, zone: Pick<CreditPolicyZone, 'minDays' | 'maxDays'>, col: ZoneColumn, pad = 10): number {
  const lo = zone.minDays;
  const hi = zone.maxDays ?? zone.minDays;
  const t = hi === lo ? 0.5 : (Math.min(Math.max(days, lo), hi) - lo) / (hi - lo);
  return col.x0 + pad + t * (col.x1 - col.x0 - 2 * pad);
}

export interface PlacedCreditDot {
  id: string;
  x: number;
  /** offset from the band's centre line */
  y: number;
  r: number;
  /** In the open-ended action range, with days printed on larger dots. */
  overflow: boolean;
}

/** x follows actual days within each action range, including a linear overflow scale above day 65.
 * y is a beeswarm to avoid overlap; radius follows the overdue amount. Future-due customers are excluded. */
export function layoutCreditDots(
  customers: Pick<CreditCustomer, 'customerKey' | 'zone' | 'daysOverdue' | 'overdueAmount'>[],
  zones: CreditPolicyZone[],
  cols: ChartColumns,
  opts: { minR?: number; maxR?: number; gap?: number; maxHeight?: number } = {},
): { dots: PlacedCreditDot[]; top: number; bottom: number } {
  const minR = opts.minR ?? DOT_MIN_R;
  const maxR = opts.maxR ?? DOT_MAX_R;
  const gap = opts.gap ?? 1.5;
  const sections = timelineSections(zones);
  const due = customers.filter((c) => c.zone !== NOT_YET_DUE && c.daysOverdue >= 0);
  const maxAmount = due.reduce((m, c) => Math.max(m, c.overdueAmount), 0);
  const maxDays = due.reduce((m, c) => Math.max(m, c.daysOverdue), sections[sections.length - 1].minDays + 1);
  const todo = due
    .map((c) => {
      const si = sections.findIndex((s) => c.daysOverdue >= s.minDays && (s.maxDays === null || c.daysOverdue <= s.maxDays));
      const section = sections[si];
      const col = cols.sections[si];
      const r = dotRadius(c.overdueAmount, maxAmount, minR, maxR);
      const x = xOfDays(c.daysOverdue, { ...section, maxDays: section.maxDays ?? maxDays }, col, maxR + 4);
      return { id: String(c.customerKey), x, r, overflow: section.maxDays === null };
    })
    .sort((a, b) => b.r - a.r || a.x - b.x || a.id.localeCompare(b.id));
  // Scale all radii together when dense customer clusters would make the panel too tall.
  // x stays unchanged, each customer remains visible, and dot areas retain their amount relationship.
  const pack = (scale: number) => {
    const placed: PlacedCreditDot[] = [];
    for (const source of todo) {
      const d = { ...source, r: source.r * scale };
      const reach = d.r + maxR * scale + gap * scale;
      const near = placed.filter((p) => Math.abs(p.x - d.x) < reach);
      const free = (y: number) => near.every((p) => Math.hypot(p.x - d.x, p.y - y) >= p.r + d.r + gap * scale);
      let y = 0;
      for (let k = 1; !free(y); k++) y = (k % 2 === 1 ? 1 : -1) * Math.ceil(k / 2) * scale;
      placed.push({ ...d, y });
    }
    return {
      dots: placed,
      top: placed.reduce((m, p) => Math.min(m, p.y - p.r), 0),
      bottom: placed.reduce((m, p) => Math.max(m, p.y + p.r), 0),
    };
  };
  let scale = 1;
  let result = pack(scale);
  if (opts.maxHeight && opts.maxHeight > 0) {
    for (let i = 0; i < 40 && result.bottom - result.top > opts.maxHeight; i++) {
      scale *= 0.85;
      result = pack(scale);
    }
  }
  return result;
}

/** True when two placed dots overlap (the tests' check). */
export function overlaps(a: PlacedCreditDot, b: PlacedCreditDot): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r - 1e-9;
}

// ---- tooltip placement --------------------------------------------------------------------------------------------------
const MARGIN = 8;
const GAP = 10;

/** Where a tooltip goes, in viewport pixels: beside the dot (right, else left), else under / above it; always inside
 * the viewport. */
export function placeTooltip(
  dot: { left: number; top: number; right: number; bottom: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, Math.max(lo, hi)));
  const cx = (dot.left + dot.right) / 2;
  const cy = (dot.top + dot.bottom) / 2;
  let left: number;
  let top: number;
  if (dot.right + GAP + size.width <= viewport.width - MARGIN) {
    left = dot.right + GAP;
    top = cy - size.height / 2;
  } else if (dot.left - GAP - size.width >= MARGIN) {
    left = dot.left - GAP - size.width;
    top = cy - size.height / 2;
  } else {
    left = cx - size.width / 2;
    top = dot.bottom + GAP + size.height <= viewport.height - MARGIN ? dot.bottom + GAP : dot.top - GAP - size.height;
  }
  return { left: clamp(left, MARGIN, viewport.width - MARGIN - size.width), top: clamp(top, MARGIN, viewport.height - MARGIN - size.height) };
}
