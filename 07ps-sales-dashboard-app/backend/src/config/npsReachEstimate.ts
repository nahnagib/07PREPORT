/**
 * NPS message reach before NPS_REACH_START (measures/npsReachEstimate.ts). The WhatsApp source never kept successful
 * (Delivered / Read) or still-"sent" (Not Delivered) messages before that date, while ratings exist from the first
 * rating, so the gap 12 Jul – 02 Oct is estimated -- the official figure for the Response Rate AND the Message reach
 * cards. Failed messages (Error) were kept by the source and are counted as they are. Outside the gap nothing is ever
 * estimated.
 *
 *   NPS_REACH_ESTIMATE_ENABLED        default true; false = no estimate (everything measured only, from NPS_REACH_START)
 *   NPS_REACH_ESTIMATE_PER_WEEK       optional fixed Delivered + Read per week for the gap (all selected companies
 *                                     together, split by their measured share); empty = automatic, per company
 *   NPS_REACH_ESTIMATE_EXCLUDE_WEEKS  Saturdays of measured weeks left out of the automatic basis (comma-separated).
 *                                     Unset = DEFAULT_EXCLUDED_WEEKS; empty = none.
 */
export interface ReachEstimateConfig {
  enabled: boolean;
  /** null = automatic */
  fixedPerWeek: number | null;
  /** week Saturdays (yyyy-mm-dd) left out of the automatic basis */
  excludeWeeks: string[];
}

/**
 * The Meta outage from 1 Nov 2026: failure group meta_temporary took over most sends (117 errors in the week of
 * 31 Oct, 73 in the first 3 days of the week of 7 Nov; none before), so those weeks' Delivered + Read are not the normal
 * volume the gap had. The messages exist in the source and failed -- not a load gap, so nothing to reload.
 */
export const DEFAULT_EXCLUDED_WEEKS = ['2026-10-31', '2026-11-07'];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function reachEstimateConfig(env: Record<string, string | undefined> = process.env): ReachEstimateConfig {
  const flag = (env.NPS_REACH_ESTIMATE_ENABLED ?? '').trim().toLowerCase();
  const enabled = !['false', '0', 'no', 'off'].includes(flag);
  const raw = (env.NPS_REACH_ESTIMATE_PER_WEEK ?? '').trim();
  const n = raw === '' ? NaN : Number(raw);
  const weeks = env.NPS_REACH_ESTIMATE_EXCLUDE_WEEKS;
  const excludeWeeks = weeks === undefined
    ? [...DEFAULT_EXCLUDED_WEEKS]
    : weeks.split(',').map((w) => w.trim()).filter((w) => ISO_DATE.test(w));
  return { enabled, fixedPerWeek: Number.isFinite(n) && n > 0 ? n : null, excludeWeeks };
}
