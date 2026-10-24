import type { NpsBand, NpsCounts, NpsFollowupBucket, NpsResponseRate, NpsTrend } from '../api';

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
  promoters: 'var(--ps-nps-teal)',
  passives: 'var(--ps-nps-amber)',
  detractors: 'var(--ps-nps-rose)',
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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-10-04" (a week, named by its Sunday) -> "04 Oct", "2026-10" -> "Oct 2026", "2026" -> "2026" (fixed names: browsers disagree on "Sep"). */
export function periodLabel(period: string): string {
  const [y, m, d] = period.split('-');
  if (d) return `${d} ${MONTHS[Number(m) - 1]}`;
  if (m) return `${MONTHS[Number(m) - 1]} ${y}`;
  return y;
}

const round2 = (v: number | null) => (v === null ? null : Math.round(v * 100) / 100);

/**
 * Trend points for ComboChart: responders (bars), NPS and CSAT (lines), the same values faded where the period is below
 * the minimum number of responders (separate, muted series).
 */
export function trendPoints(trend: Pick<NpsTrend, 'points'>) {
  return trend.points.map((p) => ({
    label: periodLabel(p.period),
    period: p.period,
    responders: p.responders,
    nps: p.belowMinimum ? null : round2(p.nps),
    npsSmall: p.belowMinimum ? round2(p.nps) : null,
    csat: p.belowMinimum ? null : round2(p.csat),
    csatSmall: p.belowMinimum ? round2(p.csat) : null,
  }));
}

// -- the period (YTD by default, Tripoli time) ---------------------------------------------------------------------------
export const BUSINESS_TIME_ZONE = 'Africa/Tripoli';

/** Today in Tripoli, yyyy-mm-dd. */
export function tripoliToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/**
 * The page's period. The shared date filter starts as Jan 1 -> today in UTC; untouched, it is replaced by the YTD in
 * Tripoli time (1 January -> today, Tripoli), so the first hours of a Tripoli day (still yesterday in UTC) are included.
 * A range the user chose is kept as it is.
 */
export function npsPeriod(dateFrom: string, dateTo: string, now: Date = new Date()): { dateFrom: string; dateTo: string; ytd: boolean } {
  const utcToday = now.toISOString().slice(0, 10);
  const today = tripoliToday(now);
  if (dateFrom === `${utcToday.slice(0, 4)}-01-01` && dateTo === utcToday) return { dateFrom: `${today.slice(0, 4)}-01-01`, dateTo: today, ytd: true };
  return { dateFrom, dateTo, ytd: dateFrom === `${dateTo.slice(0, 4)}-01-01` && dateTo === today };
}

const dayMonth = (iso: string) => `${iso.slice(8, 10)} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
const dayMonthYear = (iso: string) => `${dayMonth(iso)} ${iso.slice(0, 4)}`;

/** "YTD · 01 Jan – 20 Oct 2026"; a chosen range "01 Aug – 15 Sep 2026" or "15 Dec 2025 – 10 Jan 2026". */
export function periodCaption(p: { dateFrom: string; dateTo: string; ytd: boolean }): string {
  const sameYear = p.dateFrom.slice(0, 4) === p.dateTo.slice(0, 4);
  const range = `${sameYear ? dayMonth(p.dateFrom) : dayMonthYear(p.dateFrom)} – ${dayMonthYear(p.dateTo)}`;
  return p.ytd ? `YTD · ${range}` : range;
}

/** "03 Oct 2026". */
export const longDate = (iso: string | null | undefined): string => (iso ? dayMonthYear(iso.slice(0, 10)) : '—');

// -- the top row ----------------------------------------------------------------------------------------------------------
/** "+1.25 pts" / "−11.54 pts" (a real minus sign); "—" without a value. */
export function fmtPts(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const r = Math.round(value * 100) / 100;
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toFixed(2)} pts`;
}

/** The tachometer pill: the API's band -> Critical / Behind Target / On Track; no value -> No Target (grey). */
export const bandStatus = (band: NpsBand | null | undefined): 'alert' | 'watch' | 'success' | 'neutral' => (band ? BAND_STATUS[band] : 'neutral');

export interface FooterMetric {
  label: string;
  value: string;
  fullValue?: string;
}

/** NPS card footer (no last-year data exists, so no LYTD / LFY): Promoters % · Passives % · Detractors % · Responders. */
export function npsFooter(t: Pick<NpsCounts, 'promoters' | 'passives' | 'detractors' | 'responders' | 'promotersPct' | 'passivesPct' | 'detractorsPct'>): FooterMetric[] {
  return [
    { label: 'Promoters', value: pct(t.promotersPct), fullValue: `${t.promoters} of ${t.responders} responders` },
    { label: 'Passives', value: pct(t.passivesPct), fullValue: `${t.passives} of ${t.responders} responders` },
    { label: 'Detractors', value: pct(t.detractorsPct), fullValue: `${t.detractors} of ${t.responders} responders` },
    { label: 'Responders', value: String(t.responders) },
  ];
}

/** CSAT card footer: Satisfied (# Passives + Promoters) · Responders · Target · Variance (pts). */
export function csatFooter(t: Pick<NpsCounts, 'promoters' | 'passives' | 'responders' | 'csat'>, target: number): FooterMetric[] {
  return [
    { label: 'Satisfied', value: String(t.promoters + t.passives), fullValue: 'Passives + Promoters' },
    { label: 'Responders', value: String(t.responders) },
    { label: 'Target', value: String(target) },
    { label: 'Variance', value: fmtPts(t.csat === null ? null : t.csat - target), fullValue: `CSAT − target ${target}` },
  ];
}

/** Response-rate card stat row: "Target 30%" and the variance in points. */
export function responseRateMetrics(r: Pick<NpsResponseRate, 'target' | 'variancePts'>): FooterMetric[] {
  return [
    { label: 'Target', value: `${r.target}%` },
    { label: 'Variance', value: fmtPts(r.variancePts) },
  ];
}

/** The hover text of the response rate: the formula with its counts, and responders / Total Reach. */
export function responseRateTooltip(r: Pick<NpsResponseRate, 'responders' | 'delivered' | 'read' | 'reached' | 'totalReach' | 'rate' | 'rateOfReach'>): string {
  return [
    `Responders ÷ (Delivered + Read) = ${r.responders} ÷ (${r.delivered} + ${r.read}) = ${pct(r.rate)}`,
    `Responders ÷ Total Reach = ${r.responders} ÷ ${r.totalReach} = ${pct(r.rateOfReach)}`,
    'Customers can only answer a message that reached them.',
  ].join('\n');
}

// -- follow-up charts -----------------------------------------------------------------------------------------------------
/** Follow-up status colors match the page's muted semantic palette; pending is blue. */
export const FOLLOWUP_BUCKETS: readonly { key: NpsFollowupBucket; label: string; color: string }[] = [
  { key: 'solved_48h', label: 'Solved < 48 h', color: 'var(--ps-nps-teal)' },
  { key: 'solved_5d', label: 'Solved 48 h – 5 days', color: 'var(--ps-nps-amber)' },
  { key: 'solved_late', label: 'Solved > 5 days', color: 'var(--ps-nps-rose)' },
  { key: 'pending', label: 'Pending', color: 'var(--ps-nps-blue)' },
];

/** The follow-up page's case card (?case=ID); a Historical case opens over the List view (the board hides them). */
export const followupCaseHref = (caseId: number, historical = false): string =>
  `/process/nps-followup?${historical ? 'view=list&' : ''}case=${caseId}`;
