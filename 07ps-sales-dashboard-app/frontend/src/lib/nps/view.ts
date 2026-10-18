import type { NpsBand, NpsBandScale, NpsCounts, NpsTrend } from '../api';

/**
 * NPS Score page helpers (app/(departments)/process/nps-score). Pure, so they are unit tested. Every figure comes from
 * the API (backend measures/npsScore.ts) and the bands from /meta (backend config/npsThresholds.ts): this file only
 * formats them.
 */

export type GroupKey = 'promoters' | 'passives' | 'detractors';

/** The three groups, best first: stars, our labels (en + ar) and the standard NPS range. */
export const GROUPS: readonly { key: GroupKey; level: number; stars: string; label: string; labelAr: string; range: string }[] = [
  { key: 'promoters', level: 3, stars: '★★★', label: 'Promoters', labelAr: 'المروجون', range: '9–10' },
  { key: 'passives', level: 2, stars: '★★', label: 'Passives', labelAr: 'المحايدون', range: '7–8' },
  { key: 'detractors', level: 1, stars: '★', label: 'Detractors', labelAr: 'المنتقدون', range: '0–6' },
];

/** Theme tokens only (light and dark both define them). */
export const GROUP_COLOR: Record<GroupKey, string> = {
  promoters: 'var(--ps-color-success)',
  passives: 'var(--ps-color-watch)',
  detractors: 'var(--ps-color-alert)',
};

export const BAND_COLOR: Record<NpsBand, string> = {
  red: 'var(--ps-color-alert)',
  yellow: 'var(--ps-color-watch)',
  green: 'var(--ps-color-success)',
};
export const BAND_STATUS: Record<NpsBand, 'alert' | 'watch' | 'success'> = { red: 'alert', yellow: 'watch', green: 'success' };

/** The page's info text (business context, decision of 2026-10-18). */
export const NPS_CONTEXT = [
  'NPS measures customer satisfaction. Google Reviews, customer surveys and Customer Lifetime Value will be added later as other satisfaction measures.',
  'Customers receive the feedback message on WhatsApp: B2B customers once a month, on their first delivery of the month; B2C customers on every delivery.',
  'The customer answers with stars: ★★★ = Promoter (standard NPS 9–10), ★★ = Passive (7–8), ★ = Detractor (0–6).',
  'NPS = % Promoters − % Detractors. CSAT = (Passives + Promoters) / Responders. Responders are the ratings only; comments are never counted.',
  'Every rating figure uses the rating date (Tripoli time).',
].join('\n');

/** Two decimals, as the requirement shows them (64.97); "—" without a value. */
export function fmt2(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : value.toFixed(2);
}

/** "70.06%"; "—" without a value. */
export function pct(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${value.toFixed(2)}%`;
}

/** "n = 3" for a value below the minimum number of responders. */
export function smallSample(counts: Pick<NpsCounts, 'belowMinimum' | 'responders'>): string | null {
  return counts.belowMinimum ? `n = ${counts.responders}` : null;
}

/** The line under the gauge: "Promoters 70.06% − Detractors 5.08%". */
export function npsBreakdown(counts: Pick<NpsCounts, 'promotersPct' | 'detractorsPct'>): string {
  return `Promoters ${pct(counts.promotersPct)} − Detractors ${pct(counts.detractorsPct)}`;
}

/** The gauge is drawn 0..100: a negative NPS pins the needle at 0 (the real number is printed below). */
export function gaugeValue(nps: number | null, scale: NpsBandScale): number {
  if (nps === null) return scale.min;
  return Math.max(scale.min, Math.min(scale.max, nps));
}

/** Position (0 = bottom, 1 = top) of a value on a min..max vertical bar. */
export function barRatio(value: number, scale: NpsBandScale): number {
  const span = scale.max - scale.min;
  return span > 0 ? Math.max(0, Math.min(1, (value - scale.min) / span)) : 0;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-10-05" -> "05 Oct", "2026-10" -> "Oct 2026", "2026" -> "2026" (fixed names: browsers disagree on "Sep"). */
export function periodLabel(period: string): string {
  const [y, m, d] = period.split('-');
  if (d) return `${d} ${MONTHS[Number(m) - 1]}`;
  if (m) return `${MONTHS[Number(m) - 1]} ${y}`;
  return y;
}

/**
 * Trend points for ComboChart: responders (bars), NPS (line), the same NPS faded where the period is below the minimum
 * number of responders (a separate, muted series), and the target line.
 */
export function trendPoints(trend: Pick<NpsTrend, 'points' | 'target'>) {
  return trend.points.map((p) => ({
    label: periodLabel(p.period),
    period: p.period,
    responders: p.responders,
    nps: p.belowMinimum ? null : p.nps === null ? null : Math.round(p.nps * 100) / 100,
    npsSmall: p.belowMinimum && p.nps !== null ? Math.round(p.nps * 100) / 100 : null,
    target: trend.target,
  }));
}
