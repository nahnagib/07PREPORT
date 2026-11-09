/**
 * Response Rate: the estimate of the messages that reached customers BEFORE NPS_REACH_START (measures/npsScore.ts,
 * fetchNpsResponseRate). The WhatsApp source never kept successful messages before that date, while ratings exist from
 * the first rating date, so a YTD rate over measured messages only overstates the rate. The estimate fills that gap from
 * the measured weekly volume -- never from responders or from the rate itself.
 *
 *   NPS_REACH_ESTIMATE_ENABLED     default true; false = no estimate (the rate starts at NPS_REACH_START, as before)
 *   NPS_REACH_ESTIMATE_PER_WEEK    optional fixed Delivered + Read per week for the gap; empty = automatic (the average
 *                                  of the complete measured weeks of the selected companies)
 */
export interface ReachEstimateConfig {
  enabled: boolean;
  /** null = automatic */
  fixedPerWeek: number | null;
}

export function reachEstimateConfig(env: Record<string, string | undefined> = process.env): ReachEstimateConfig {
  const flag = (env.NPS_REACH_ESTIMATE_ENABLED ?? '').trim().toLowerCase();
  const enabled = !['false', '0', 'no', 'off'].includes(flag);
  const raw = (env.NPS_REACH_ESTIMATE_PER_WEEK ?? '').trim();
  const n = raw === '' ? NaN : Number(raw);
  return { enabled, fixedPerWeek: Number.isFinite(n) && n > 0 ? n : null };
}
