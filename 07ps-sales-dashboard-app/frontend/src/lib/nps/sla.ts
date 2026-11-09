/**
 * NPS Detractor Follow-up SLA (docs/nps-followup.md, "SLA") -- the frontend copy of backend/src/config/npsSla.ts (a
 * test checks the two agree). The backend works out each case's SLA state; this file only names and colours it.
 *
 *   Contact SLA  contacted within 24 h of the case's created_at
 *   Close SLA    resolved within 5 days of created_at
 * Calendar hours (no working-days rule).
 */
export const NPS_SLA = { contactHours: 24, closeDays: 5 } as const;
export const HOURS_PER_DAY = 24;

export type SlaBand = 'green' | 'amber' | 'red' | 'grey';
export type SlaRule =
  | 'open_within_contact'
  | 'open_contacted'
  | 'contact_missed'
  | 'close_missed'
  | 'resolved_in_sla'
  | 'resolved_late'
  | 'unresolved'
  | 'rejected'
  | 'historical';

export interface CaseSla {
  band: SlaBand;
  rule: SlaRule;
  /** age now (open) or time to resolve (resolved), hours from created_at; null = no SLA */
  hours: number | null;
  exactHours: number | null;
  /** how far past the missed limit, hours */
  overByHours: number | null;
  contactedInSla: boolean | null;
}

/**
 * Dedicated SLA text/mark tokens, validated in both themes. Icons and labels also communicate each band.
 */
export const SLA_COLOR: Record<SlaBand, string> = {
  green: 'var(--ps-sla-green)',
  amber: 'var(--ps-sla-amber)',
  red: 'var(--ps-sla-red)',
  grey: 'var(--ps-color-neutral-text)',
};

const days = (hours: number) => `${(hours / HOURS_PER_DAY).toFixed(1)} d`;

/** The tooltip: the rule that gave the colour. */
export function slaHint(sla: CaseSla): string {
  const close = `${NPS_SLA.closeDays} d`;
  const contact = `${NPS_SLA.contactHours} h`;
  switch (sla.rule) {
    case 'open_within_contact':
      return `Within SLA: open at most ${contact} (contact by ${contact}, close by ${close})`;
    case 'open_contacted':
      return `Contacted; Close SLA (${close}) still ahead: ${days(NPS_SLA.closeDays * HOURS_PER_DAY - (sla.exactHours ?? 0))} left`;
    case 'contact_missed':
      return `Contact SLA missed: not contacted after ${contact}`;
    case 'close_missed':
      return `Close SLA missed by ${days(sla.overByHours ?? 0)}`;
    case 'resolved_in_sla':
      return `Closed within SLA (${close})`;
    case 'resolved_late':
      return `Close SLA missed by ${days(sla.overByHours ?? 0)}`;
    case 'unresolved':
      return 'Unresolved: no SLA';
    case 'rejected':
      return 'Rejected: no SLA';
    default:
      return 'Historical (rated before the follow-up started): no SLA';
  }
}

export interface SlaShare {
  count: number;
  of: number;
}

/** "x of y (z %)"; "—" when nothing is due yet. */
export function slaShareText(s: SlaShare): string {
  if (s.of === 0) return '— (none due yet)';
  return `${s.count} of ${s.of} (${Math.round((s.count / s.of) * 100)} %)`;
}
