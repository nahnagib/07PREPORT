/**
 * NPS Detractor Follow-up SLA (docs/nps-followup.md, "SLA") -- the ONLY place the backend keeps the limits; the
 * frontend mirrors them in frontend/src/lib/nps/sla.ts (a test checks the two agree).
 *
 *   Contact SLA  contacted_at - created_at <= contactHours (customer service contacts the customer)
 *   Close SLA    resolved_at  - created_at <= closeDays     (the case is resolved)
 *
 * Measured in CALENDAR hours from the case's created_at (when process_nps created it); no working-days rule yet.
 * Times are Africa/Tripoli wall-clock strings "yyyy-mm-dd hh:mm:ss" (created_at is converted from UTC by the caller).
 */
export const NPS_SLA = { contactHours: 24, closeDays: 5 } as const;
export const HOURS_PER_DAY = 24;
export const CLOSE_HOURS = NPS_SLA.closeDays * HOURS_PER_DAY;

/** green = within SLA · amber = open, contacted, close deadline still ahead · red = an SLA missed · grey = no SLA */
export type SlaBand = 'green' | 'amber' | 'red' | 'grey';
export type SlaRule =
  | 'open_within_contact' // open, age <= contactHours
  | 'open_contacted' // open, contacted, contactHours < age <= closeDays
  | 'contact_missed' // open, age > contactHours, not contacted
  | 'close_missed' // open, age > closeDays
  | 'resolved_in_sla' // resolved within closeDays
  | 'resolved_late' // resolved after closeDays
  | 'rejected'
  | 'historical';

export interface CaseSla {
  band: SlaBand;
  rule: SlaRule;
  /** age now (open) or time to resolve (resolved), hours from created_at, 1 decimal; null = no SLA */
  hours: number | null;
  /** the same, unrounded: the ageing bucket uses it, so a case 1 s past the limit is never drawn inside the SLA */
  exactHours: number | null;
  /** how far past the missed limit, hours (close_missed / resolved_late: past closeDays; contact_missed: past contactHours) */
  overByHours: number | null;
  /** contacted within contactHours of created_at (null = not contacted) */
  contactedInSla: boolean | null;
}

export interface SlaInput {
  stage: string;
  /** created_at as Tripoli wall-clock time */
  createdAt: string | null;
  contactedAt: string | null;
  resolvedAt: string | null;
}

const OPEN = new Set(['NEW', 'CONTACTED', 'IN_PROGRESS']);
const wall = (s: string): number => Date.parse(`${s.replace(' ', 'T')}Z`);
const hoursBetween = (from: string, to: string): number =>
  Math.max(0, (wall(to) - wall(from)) / 3_600_000);
const round1 = (h: number): number => Math.round(h * 10) / 10;

/** The SLA state of one case at `now` (Tripoli wall-clock). */
export function caseSla(c: SlaInput, now: string): CaseSla {
  const contactedInSla =
    c.contactedAt && c.createdAt
      ? hoursBetween(c.createdAt, c.contactedAt) <= NPS_SLA.contactHours
      : null;
  if (c.stage === 'REJECTED')
    return {
      band: 'grey',
      rule: 'rejected',
      hours: null,
      exactHours: null,
      overByHours: null,
      contactedInSla,
    };
  if (c.stage === 'HISTORICAL' || !c.createdAt)
    return {
      band: 'grey',
      rule: 'historical',
      hours: null,
      exactHours: null,
      overByHours: null,
      contactedInSla,
    };
  if (c.stage === 'RESOLVED') {
    if (!c.resolvedAt)
      return {
        band: 'grey',
        rule: 'historical',
        hours: null,
        exactHours: null,
        overByHours: null,
        contactedInSla,
      };
    const took = hoursBetween(c.createdAt, c.resolvedAt);
    return took <= CLOSE_HOURS
      ? {
          band: 'green',
          rule: 'resolved_in_sla',
          hours: round1(took),
          exactHours: took,
          overByHours: null,
          contactedInSla,
        }
      : {
          band: 'red',
          rule: 'resolved_late',
          hours: round1(took),
          exactHours: took,
          overByHours: round1(took - CLOSE_HOURS),
          contactedInSla,
        };
  }
  if (!OPEN.has(c.stage))
    return {
      band: 'grey',
      rule: 'historical',
      hours: null,
      exactHours: null,
      overByHours: null,
      contactedInSla,
    };
  const age = hoursBetween(c.createdAt, now);
  if (age > CLOSE_HOURS)
    return {
      band: 'red',
      rule: 'close_missed',
      hours: round1(age),
      exactHours: age,
      overByHours: round1(age - CLOSE_HOURS),
      contactedInSla,
    };
  if (age > NPS_SLA.contactHours && !c.contactedAt) {
    return {
      band: 'red',
      rule: 'contact_missed',
      hours: round1(age),
      exactHours: age,
      overByHours: round1(age - NPS_SLA.contactHours),
      contactedInSla,
    };
  }
  if (age <= NPS_SLA.contactHours)
    return {
      band: 'green',
      rule: 'open_within_contact',
      hours: round1(age),
      exactHours: age,
      overByHours: null,
      contactedInSla,
    };
  return {
    band: 'amber',
    rule: 'open_contacted',
    hours: round1(age),
    exactHours: age,
    overByHours: null,
    contactedInSla,
  };
}

/** "Resolved Ageing" buckets: hours up to maxHours (null = no upper limit); withinSla = left of the Close SLA line. */
export const AGEING_BUCKETS = [
  { key: 'd1', label: '≤ 1 d', maxHours: HOURS_PER_DAY },
  { key: 'd2', label: '1–2 d', maxHours: 2 * HOURS_PER_DAY },
  { key: 'd5', label: `2–${NPS_SLA.closeDays} d`, maxHours: CLOSE_HOURS },
  { key: 'd10', label: `${NPS_SLA.closeDays}–10 d`, maxHours: 10 * HOURS_PER_DAY },
  { key: 'd30', label: '10–30 d', maxHours: 30 * HOURS_PER_DAY },
  { key: 'dmax', label: '> 30 d', maxHours: null },
].map((b) => ({ ...b, withinSla: b.maxHours !== null && b.maxHours <= CLOSE_HOURS }));
export type AgeingBucketKey = (typeof AGEING_BUCKETS)[number]['key'];

export function ageingBucket(hours: number): AgeingBucketKey {
  return (
    AGEING_BUCKETS.find((b) => b.maxHours === null || hours <= b.maxHours) ??
    AGEING_BUCKETS[AGEING_BUCKETS.length - 1]
  ).key;
}

export interface ResolutionAgeing {
  /** one entry per bucket: resolved cases by time to resolve, open cases by age today */
  buckets: {
    key: AgeingBucketKey;
    label: string;
    withinSla: boolean;
    resolved: number;
    open: number;
  }[];
  /** resolved within closeDays, of all resolved cases */
  closedInSla: { count: number; of: number };
  /** contacted within contactHours, of the cases whose contact deadline is behind them (contacted, resolved, or open over
   *  contactHours); a resolved case without contacted_at counts as not contacted in time */
  contactedInSla: { count: number; of: number };
}

/** The ageing chart and the two SLA lines, from cases with an SLA (Rejected / Historical are left out). */
export function resolutionAgeing(
  cases: { stage: string; sla: CaseSla; contacted: boolean }[],
): ResolutionAgeing {
  const buckets = AGEING_BUCKETS.map((b) => ({
    key: b.key,
    label: b.label,
    withinSla: b.withinSla,
    resolved: 0,
    open: 0,
  }));
  const closed = { count: 0, of: 0 };
  const contacted = { count: 0, of: 0 };
  for (const c of cases) {
    if (c.sla.band === 'grey' || c.sla.exactHours === null) continue;
    const hours = c.sla.exactHours;
    const entry = buckets.find((b) => b.key === ageingBucket(hours))!;
    const resolved = c.stage === 'RESOLVED';
    if (resolved) entry.resolved += 1;
    else entry.open += 1;
    if (resolved) {
      closed.of += 1;
      if (c.sla.rule === 'resolved_in_sla') closed.count += 1;
    }
    if (c.contacted || resolved || hours > NPS_SLA.contactHours) {
      contacted.of += 1;
      if (c.sla.contactedInSla) contacted.count += 1;
    }
  }
  return { buckets, closedInSla: closed, contactedInSla: contacted };
}
