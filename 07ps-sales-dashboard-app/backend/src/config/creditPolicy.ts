/**
 * The credit policy's escalation zones (2026-10-15) -- the ONE place they are defined. Used by the "Credit Policy
 * Escalation" chart (measures/debtAging.ts, served to the page), its tooltip and zone counts, and the Customers
 * table's "Aging bucket" column (measures/debtReport.ts). Change the policy here and nowhere else.
 *
 * A customer's zone comes from the DAYS OVERDUE of its unpaid invoice with the EARLIEST due date (2026-10-20), counted
 * in calendar days from that invoice's OVERDUE DATE to the snapshot date:
 *   overdue date = due date + OVERDUE_OFFSET_DAYS (the first day the invoice is actually late);
 *   days overdue = snapshot date - overdue date; day 0 = the first day overdue (= the day after the due date).
 * Boundaries are inclusive, in days overdue, without gaps or overlaps (validated below at load). An overdue date after
 * the snapshot date (including an invoice due exactly that day) is "Not yet due" -- never day 0 / GREEN.
 */

export interface CreditPolicyActionArea {
  minDays: number;
  maxDays: number | null;
  action: string;
  details?: string;
  edgeLabel: string | null;
}

export interface CreditPolicyZone {
  key: 'GREEN' | 'YELLOW' | 'RED' | 'BLOCK';
  label: string;
  /** first day overdue in the zone (inclusive) */
  minDays: number;
  /** last day overdue in the zone (inclusive); null = no upper bound */
  maxDays: number | null;
  /** colour token the page maps to its theme (frontend tokens.css --ps-credit-<tone>) */
  tone: 'green' | 'amber' | 'red' | 'block';
  owner: string;
  action: string;
  /** chart: the label of the zone's right-hand boundary on the axis; null for the last zone */
  edgeLabel: string | null;
  actionAreas?: readonly CreditPolicyActionArea[];
}

export const CREDIT_POLICY_ZONES: readonly CreditPolicyZone[] = [
  { key: 'GREEN', label: 'GREEN', minDays: 0, maxDays: 15, tone: 'green', owner: 'Sales Manager', action: 'Payment Reminder', edgeLabel: '15 Days' },
  { key: 'YELLOW', label: 'YELLOW', minDays: 16, maxDays: 30, tone: 'amber', owner: 'Sales Director', action: 'Follow-up / Customer Visit', edgeLabel: '30 Days' },
  { key: 'RED', label: 'RED', minDays: 31, maxDays: 44, tone: 'red', owner: 'CEO', action: 'CEO Intervention', edgeLabel: '45 Days' },
  {
    key: 'BLOCK', label: 'BLOCK', minDays: 45, maxDays: null, tone: 'block', owner: 'GCEO + CFO',
    action: 'Management Escalation', edgeLabel: null,
    actionAreas: [
      { minDays: 45, maxDays: 60, action: 'Management Escalation', edgeLabel: '60 Days' },
      { minDays: 61, maxDays: 65, action: 'Final Warning + Stop Supply', edgeLabel: '65 Days',
        details: 'Send final payment warning by registered mail and suspend further supply/deliveries.' },
      { minDays: 66, maxDays: null, action: 'Legal Action', edgeLabel: null,
        details: 'CFO decides the appropriate legal action in consultation with GCEO.' },
    ],
  },
];

/** Days from an invoice's due date to its overdue date (day 0 of the policy). Change the counting start here only. */
export const OVERDUE_OFFSET_DAYS = 1;

/** Customers whose overdue date (earliest unpaid due date + OVERDUE_OFFSET_DAYS) is after the snapshot date, i.e. due
 * on or after the snapshot date: not overdue yet. */
export const NOT_YET_DUE = { key: 'NOT_YET_DUE', label: 'Not yet due' } as const;

/** A dot gets the dashed "approaching next zone" ring this many days before it moves up (days >= upper - 6). */
export const ESCALATION_WINDOW_DAYS = 7;

export type CreditZoneKey = CreditPolicyZone['key'] | typeof NOT_YET_DUE.key;

/** Throws when the zones leave a gap, overlap or are out of order -- a bad edit fails at startup, not silently. */
export function validateCreditPolicy(zones: readonly CreditPolicyZone[]): void {
  if (zones.length === 0 || zones[0].minDays !== 0) throw new Error('credit policy: the first zone must start at day 0');
  zones.forEach((z, i) => {
    const last = i === zones.length - 1;
    if (last !== (z.maxDays === null)) throw new Error('credit policy: only the last zone is open-ended');
    if (z.maxDays !== null && z.maxDays < z.minDays) throw new Error(`credit policy: zone ${z.key} ends before it starts`);
    if (i > 0 && z.minDays !== (zones[i - 1].maxDays as number) + 1) throw new Error(`credit policy: gap or overlap before zone ${z.key}`);
    if (z.actionAreas) {
      let expected = z.minDays;
      z.actionAreas.forEach((a, j) => {
        if (a.minDays !== expected || (a.maxDays !== null && a.maxDays < a.minDays)) throw new Error('credit policy: gap or overlap in action areas');
        if (j === z.actionAreas!.length - 1 ? a.maxDays !== z.maxDays : a.maxDays === null) throw new Error('credit policy: action areas must cover their zone');
        expected = (a.maxDays ?? 0) + 1;
      });
    }
  });
}
validateCreditPolicy(CREDIT_POLICY_ZONES);

/** Internal actions never change the customer's main status or responsible role. */
export function creditActionForDays(daysOverdue: number): CreditPolicyActionArea | null {
  const zone = creditZoneForDays(daysOverdue);
  return zone?.actionAreas?.find((a) => daysOverdue >= a.minDays && (a.maxDays === null || daysOverdue <= a.maxDays)) ?? null;
}

/** The zone of a number of days overdue; null when negative (= not yet due). */
export function creditZoneForDays(daysOverdue: number, zones: readonly CreditPolicyZone[] = CREDIT_POLICY_ZONES): CreditPolicyZone | null {
  if (daysOverdue < 0) return null;
  return zones.find((z) => daysOverdue >= z.minDays && (z.maxDays === null || daysOverdue <= z.maxDays)) ?? zones[zones.length - 1];
}

/** Next zone and the days until the customer enters it (if still unpaid); null in the last zone or when not yet due. */
export function nextCreditZone(daysOverdue: number, zones: readonly CreditPolicyZone[] = CREDIT_POLICY_ZONES): { zone: CreditPolicyZone; inDays: number } | null {
  const z = creditZoneForDays(daysOverdue, zones);
  if (!z || z.maxDays === null) return null;
  const next = zones[zones.indexOf(z) + 1];
  return next ? { zone: next, inDays: z.maxDays + 1 - daysOverdue } : null;
}

/** The dashed ring: the customer enters the next zone within ESCALATION_WINDOW_DAYS (never in the last zone). */
export function approachingNextZone(daysOverdue: number, zones: readonly CreditPolicyZone[] = CREDIT_POLICY_ZONES): boolean {
  const n = nextCreditZone(daysOverdue, zones);
  return n !== null && n.inDays <= ESCALATION_WINDOW_DAYS;
}
