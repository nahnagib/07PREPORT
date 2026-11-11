import type { NpsBand, NpsCounts, NpsFollowupStage, NpsFollowupStatus, NpsManualPeriod, NpsReachSource, NpsResponseRate, NpsTrend } from '../api';

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

/** Short info text of the Satisfaction Trend chart (the full context sits on the NPS Score card's title). */
export const TREND_INFO = 'NPS and CSAT per period (lines) with responders (bars). Muted lines: periods below the minimum number of responders.';

/** Short info text of the Responders Trend chart. */
export const RESPONDERS_TREND_INFO = 'Responders per period (bars) with Promoters, Passives and Detractors (lines), for the selected filters, by week, month or year.';

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

/** Hover of the NPS number: the formula with this selection's figures, "NPS = % Promoters − % Detractors = 70.06% − 5.08% = 64.97". */
export function npsBreakdown(counts: Pick<NpsCounts, 'promotersPct' | 'detractorsPct' | 'nps'>): string {
  return `NPS = % Promoters − % Detractors = ${pct(counts.promotersPct)} − ${pct(counts.detractorsPct)} = ${fmt2(counts.nps)}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-10-03" (a week, named by its Saturday) -> "04 Oct", "2026-10" -> "Oct 2026", "2026" -> "2026" (fixed names: browsers disagree on "Sep"). */
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

type RateTip = Pick<NpsResponseRate, 'responders' | 'delivered' | 'read' | 'reached' | 'totalReach' | 'rate' | 'rateOfReach'>
  & Partial<Pick<NpsResponseRate, 'includesManual' | 'reachedBySource' | 'manualPeriods' | 'reachStart' | 'companyAndDateOnly'>>;

/** What the Response Rate counts and which filters it uses (the ⓘ and the value tooltip; no longer printed on the card). */
export const RATE_FILTER_NOTE = 'Company and date filters only: the other filters (customer group, channel, branch, salesperson, customer) '
  + 'are not applied, on either side. Responders = every rating of the selected companies.';

/**
 * Rate of reach = Responders ÷ Total Reach (Total Reach = Delivered + Not Delivered + Read + Error + other states), from
 * the API's response rate (backend fetchNpsResponseRate: the SAME reach read as the cards). Total Reach ≥ Delivered +
 * Read, so it is never above the Response Rate, nor above 100 %. "—" without a figure.
 */
export function rateOfReachLine(r: Pick<NpsResponseRate, 'responders' | 'totalReach' | 'rateOfReach'> | null): { value: string; tip: string } {
  const value = r && r.rateOfReach !== null ? pct(r.rateOfReach) : '—';
  const counts = r && r.rateOfReach !== null ? ` = ${count(r.responders)} ÷ ${count(r.totalReach)} = ${value}` : '';
  return { value, tip: `Rate of reach = Responders ÷ Total Reach${counts}\nTotal Reach = Delivered + Not Delivered + Read + Error. Never above the Response Rate.` };
}

const count = (n: number) => n.toLocaleString('en-US');

/** "13–31 Aug" inside one month, else "13 Aug – 02 Oct". */
const dayRange = (from: string, to: string) =>
  (from.slice(0, 7) === to.slice(0, 7) ? `${from.slice(8, 10)}–${dayMonth(to)}` : `${dayMonth(from)} – ${dayMonth(to)}`);
const nextDay = (iso: string) => new Date(Date.parse(`${iso}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/**
 * Where the reach of 12 Jul – 02 Oct comes from, from the manual periods (backend migration 0071), then the measured
 * part: "12 Jul – 12 Aug estimated · 13 Aug – 02 Oct from Meta (manual; 13–31 Aug Delivered/Read estimated) · from
 * 03 Oct measured". Back-to-back periods of the same kind are merged; '' without manual periods.
 */
export function manualSubtitle(periods: NpsManualPeriod[], reachStart: string | null): string {
  const runs: { kind: 'estimate' | 'meta'; from: string; to: string; mixed: { from: string; to: string }[] }[] = [];
  for (const p of [...periods].sort((a, b) => a.from.localeCompare(b.from))) {
    const kind = p.source === 'estimate' ? 'estimate' : 'meta';
    const last = runs[runs.length - 1];
    if (last && last.kind === kind && nextDay(last.to) >= p.from) {
      if (p.to > last.to) last.to = p.to;
    } else runs.push({ kind, from: p.from, to: p.to, mixed: [] });
    const run = runs[runs.length - 1];
    if (p.source === 'meta_manual+estimate' && !run.mixed.some((m) => m.from === p.from && m.to === p.to)) run.mixed.push({ from: p.from, to: p.to });
  }
  if (runs.length === 0) return '';
  const parts = runs.map((r) => (r.kind === 'estimate'
    ? `${dayMonth(r.from)} – ${dayMonth(r.to)} estimated`
    : `${dayMonth(r.from)} – ${dayMonth(r.to)} from Meta (manual${r.mixed.map((m) => `; ${dayRange(m.from, m.to)} Delivered/Read estimated`).join('')})`));
  if (reachStart) parts.push(`from ${dayMonth(reachStart.slice(0, 10))} measured`);
  return parts.join(' · ');
}

/** The mark on a card whose figure includes manual or estimated reach. */
export const MANUAL_MARK = 'incl. manual/est.';

/** A reach figure split by source: "Measured (from 03 Oct): 1,222 · Meta manual: 1,141 · Estimate: 1,113 · Total: 3,476". */
export function sourceSplit(split: Record<NpsReachSource, number>, reachStart: string | null): string {
  return [
    `Measured${reachStart ? ` (from ${dayMonth(reachStart.slice(0, 10))})` : ''}: ${count(split.etl)}`,
    `Meta manual: ${count(split.manual)}`,
    `Estimate: ${count(split.estimate)}`,
    `Total: ${count(split.etl + split.manual + split.estimate)}`,
  ].join('\n');
}

/**
 * The hover text of the response rate: the formula with its counts. With manual reach in the period: Delivered + Read
 * split measured / Meta manual / estimate, and where each part comes from.
 */
export function responseRateTooltip(r: RateTip): string {
  const lines = [`Responders ÷ (Delivered + Read) = ${count(r.responders)} ÷ (${count(r.delivered)} + ${count(r.read)}) = ${pct(r.rate)}`];
  if (r.includesManual && r.reachedBySource) {
    lines.push(`Delivered + Read:\n${sourceSplit(r.reachedBySource, r.reachStart ?? null)}`);
    const where = manualSubtitle(r.manualPeriods ?? [], r.reachStart ?? null);
    if (where) lines.push(where);
  }
  lines.push('Customers can only answer a message that reached them.');
  if (r.companyAndDateOnly) lines.push(RATE_FILTER_NOTE);
  return lines.join('\n');
}

/** "801 responders ÷ 3,476 reached": the numerator and the denominator the headline uses. */
export const rateFraction = (r: Pick<NpsResponseRate, 'responders' | 'reached'>): string =>
  `${count(r.responders)} responders ÷ ${count(r.reached)} reached`;

// -- follow-up charts -----------------------------------------------------------------------------------------------------
/** "Detractors by status", level 1 (the generated status). */
export const FOLLOWUP_STATUS_SLICES: Record<NpsFollowupStatus, { label: string; color: string }> = {
  OPEN: { label: 'Open', color: 'var(--ps-fu-open)' },
  CLOSE: { label: 'Closed', color: 'var(--ps-fu-close)' },
  DISPUTED: { label: 'Disputed', color: 'var(--ps-fu-disputed)' },
};

export const FOLLOWUP_STAGE_LABEL: Record<NpsFollowupStage, string> = {
  HISTORICAL: 'Historical', NEW: 'New', CONTACTED: 'Contacted', IN_PROGRESS: 'In Progress', RESOLVED: 'Resolved', UNRESOLVED: 'Unresolved', REJECTED: 'Rejected',
};

/** The stages in the status drill-down: a single-stage status keeps its status colour; Open's three are validated apart. */
export const FOLLOWUP_STAGE_COLOR: Record<NpsFollowupStage, string> = {
  HISTORICAL: 'var(--ps-nps-slate)',
  NEW: 'var(--ps-fu-open)',
  CONTACTED: 'var(--ps-fu-mid)',
  IN_PROGRESS: 'var(--ps-fu-plum)',
  RESOLVED: 'var(--ps-fu-close)',
  UNRESOLVED: 'var(--ps-fu-disputed)',
  REJECTED: 'var(--ps-fu-disputed)',
};

/** The follow-up page's case card (?case=ID); a Historical case opens over the List view (the board hides them). */
export const followupCaseHref = (caseId: number, historical = false): string =>
  `/process/nps-followup?${historical ? 'view=list&' : ''}case=${caseId}`;
