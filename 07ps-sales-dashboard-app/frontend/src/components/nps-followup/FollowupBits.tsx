'use client';
import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AlertTriangle, CheckCircle2, Clock, KanbanSquare, ListChecks, MessageSquare, MinusCircle, Tags, type LucideIcon } from 'lucide-react';
import { AppHeader } from '../AppHeader';
import { BottomNavBar } from '../BottomNavBar';
import { useAuth } from '../../lib/AuthProvider';
import {
  STAGE_COLOR,
  STAGE_LABEL,
  STATUS_COLOR,
  STATUS_LABEL,
  formatHoursOpen,
  type FollowupCase,
  type FollowupKpis,
  type FollowupStage,
  type FollowupStatus,
} from '../../lib/nps/followup';
import { NPS_SLA, SLA_COLOR, slaHint, type CaseSla, type SlaBand } from '../../lib/nps/sla';
import { KaizenKpi } from '../kaizen/KaizenBits';

export const FOLLOWUP_BASE = '/process/nps-followup';

/**
 * Chrome for the Detractor Follow-up pages (the Kaizen shell's pattern): header, a sub-nav Board / List / Reasons (each
 * only with its permission), the department bottom nav on phones. `filters` renders under the header, full width.
 */
export function FollowupShell({ view, onView, actions, filters, children }: {
  view: 'board' | 'list' | 'reasons';
  /** on the board/list page: switch the view in place (the filters stay) */
  onView?: (v: 'board' | 'list') => void;
  actions?: React.ReactNode;
  filters?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { user, logout, canView } = useAuth();
  const pathname = usePathname() ?? '';
  const tabs: { href: string; label: string; icon: LucideIcon; show: boolean; active: boolean; inPage?: 'board' | 'list' }[] = [
    { href: FOLLOWUP_BASE, label: 'Board', icon: KanbanSquare, show: canView('nps_followup'), active: pathname === FOLLOWUP_BASE && view === 'board', inPage: 'board' },
    { href: `${FOLLOWUP_BASE}?view=list`, label: 'List', icon: ListChecks, show: canView('nps_followup'), active: view === 'list', inPage: 'list' },
    { href: `${FOLLOWUP_BASE}/reasons`, label: 'Reasons', icon: Tags, show: canView('nps_followup_reasons'), active: view === 'reasons' },
  ];
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', paddingBottom: 72 }}>
      <AppHeader anchorDate="" onAnchorDateChange={() => undefined} roleLabel={user?.role.label ?? user?.fullName} onLogout={logout} showDateInput={false} />
      {filters}
      <main style={{ flex: 1, padding: 'var(--ps-space-3, 16px)', display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'space-between' }}>
          <nav className="ps-kaizen-subnav" aria-label="Detractor Follow-up">
            {tabs.filter((t) => t.show).map(({ href, label, icon: Icon, active, inPage }) => (onView && inPage ? (
              <button key={label} type="button" onClick={() => onView(inPage)} aria-pressed={active} className="ps-fu-tab" data-active={active}>
                <Icon size={15} />
                {label}
              </button>
            ) : (
              <Link key={label} href={href} aria-current={active ? 'page' : undefined} className="ps-fu-tab" data-active={active}>
                <Icon size={15} />
                {label}
              </Link>
            )))}
          </nav>
          {actions && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>{actions}</div>}
        </div>
        {children}
      </main>
      <BottomNavBar active="Detractor Follow-up" />
    </div>
  );
}

/** The STAGE (the workflow step): the List view's Stage column, the NPS page's detractor table. */
export function StagePill({ stage }: { stage: FollowupStage }) {
  const color = STAGE_COLOR[stage];
  return (
    <span className="ps-kaizen-pill" data-testid="fu-stage" style={{ background: `color-mix(in srgb, ${color} 16%, transparent)`, color }}>
      <span className="ps-kaizen-dot" style={{ background: color }} />
      {STAGE_LABEL[stage]}
    </span>
  );
}

/** The STATUS badge (Open / Close / Disputed, worked out from the stage); none for Historical. */
export function StatusBadge({ status }: { status: FollowupStatus | null }) {
  if (!status) return null;
  const color = STATUS_COLOR[status];
  return (
    <span className="ps-fu-status" data-testid="fu-status" data-status={status} title="Status: worked out from the stage"
      style={{ borderColor: color, color }}>
      {STATUS_LABEL[status]}
    </span>
  );
}

/** An icon per SLA band: the colour-blind-safe second cue next to the colour (lib/nps/sla.ts). */
const SLA_ICON: Record<SlaBand, LucideIcon> = { green: CheckCircle2, amber: Clock, red: AlertTriangle, grey: MinusCircle };

/**
 * Time open with its SLA colour (lib/nps/sla.ts) and the rule in the tooltip; Resolved says "resolved in", Rejected /
 * Historical have no SLA and read "rejected" / "historical" in grey.
 */
export function TimeOpen({ c }: { c: { stage: FollowupStage; hoursOpen: number | null; sla: CaseSla | null } }) {
  if (!c.sla) return null;
  const { band, rule } = c.sla;
  const color = SLA_COLOR[band];
  const Icon = SLA_ICON[band];
  const hint = slaHint(c.sla);
  const text = rule === 'unresolved' || rule === 'rejected' || rule === 'historical' ? rule
    : `${c.stage === 'RESOLVED' ? 'resolved in ' : 'open '}${formatHoursOpen(c.hoursOpen)}`;
  return (
    <span className="ps-fu-time" title={hint} aria-label={`${text}. ${hint}`} data-band={band} data-rule={rule} data-testid="fu-time" style={{ color }}>
      <Icon size={13} aria-hidden="true" style={{ flex: 'none' }} />
      {text}
    </span>
  );
}

/** One case on the board: order / delivery, the status badge, customer, company and branch, reason, owner, time open. */
export function CaseCard({ c, onOpen }: { c: FollowupCase; onOpen: (id: number) => void }) {
  return (
    <button type="button" className="ps-fu-card" data-testid="fu-card" data-band={c.sla.band} onClick={() => onOpen(c.caseId)}
      style={{ borderInlineStartColor: c.sla.band === 'grey' ? 'var(--ps-color-border)' : SLA_COLOR[c.sla.band] }}>
      <div className="ps-fu-card-top">
        <strong>{c.orderRef ?? c.deliveryCode ?? `Case #${c.caseId}`}</strong>
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <StatusBadge status={c.status} />
          <span className="ps-fu-muted">#{c.caseId}</span>
        </span>
      </div>
      <div className="ps-fu-card-customer" dir="auto">{c.customer ?? '—'}</div>
      <div className="ps-fu-muted">{[c.company, c.teamBranch ?? c.salesTeam].filter(Boolean).join(' · ') || '—'}</div>
      <div className="ps-fu-card-meta">
        <span title={c.reasonLabelAr ?? undefined}>{c.reasonLabelEn ?? <em className="ps-fu-muted">No reason yet</em>}</span>
        <span className="ps-fu-muted">{c.ownerName ? `Owner: ${c.ownerName}` : 'No owner'}</span>
      </div>
      <div className="ps-fu-card-foot">
        <TimeOpen c={c} />
        {c.hasComment && <MessageSquare size={14} aria-label="Has a comment" />}
        {c.sourceChanged && <span className="ps-fu-flag" title={c.sourceChangeReason ?? undefined}><AlertTriangle size={13} /> Source changed</span>}
      </div>
    </button>
  );
}

/** The board's SLA row (the board's cases; lib/nps/sla.ts), full width: 4 across on wide screens. */
export function SlaKpis({ kpis }: { kpis: FollowupKpis }) {
  return (
    <section className="ps-fu-kpis ps-fu-kpis--4" aria-label="SLA" data-testid="fu-kpis-stage">
      <KaizenKpi label="Close SLA missed" value={String(kpis.closeSlaMissed)} sub={`open more than ${NPS_SLA.closeDays} days`} accent={SLA_COLOR.red} />
      <KaizenKpi label="Contact SLA missed" value={String(kpis.contactSlaMissed)}
        sub={`open more than ${NPS_SLA.contactHours} h, not contacted`} accent={SLA_COLOR.red} />
      <KaizenKpi label="Resolved, last 30 days" value={String(kpis.resolved30Days)}
        sub={`${kpis.resolvedInSla} within SLA (${NPS_SLA.closeDays} d)`} accent={SLA_COLOR.green} />
      <KaizenKpi label="Not classified" value={String(kpis.noReason)} sub="no reason chosen yet" accent="var(--ps-color-watch)" />
    </section>
  );
}
