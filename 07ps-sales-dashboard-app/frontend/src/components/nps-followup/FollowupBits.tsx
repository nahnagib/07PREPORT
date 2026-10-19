'use client';
import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AlertTriangle, KanbanSquare, ListChecks, MessageSquare, Tags, type LucideIcon } from 'lucide-react';
import { AppHeader } from '../AppHeader';
import { BottomNavBar } from '../BottomNavBar';
import { useAuth } from '../../lib/AuthProvider';
import {
  BAND_COLOR,
  BAND_HINT,
  STATUS_COLOR,
  STATUS_LABEL,
  formatHoursOpen,
  type FollowupCase,
  type FollowupStatus,
  type TimeBand,
} from '../../lib/nps/followup';

export const FOLLOWUP_BASE = '/process/nps-followup';

/**
 * Chrome for the Detractor Follow-up pages (the Kaizen shell's pattern): header, a sub-nav Board / List / Reasons (each
 * only with its permission), the department bottom nav on phones. `filters` renders under the header, full width.
 */
export function FollowupShell({ title, view, onView, actions, filters, children }: {
  title: string;
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
      <AppHeader pageTitle={title} anchorDate="" onAnchorDateChange={() => undefined} roleLabel={user?.role.label ?? user?.fullName} onLogout={logout} showDateInput={false} />
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

export function StatusPill({ status }: { status: FollowupStatus }) {
  const color = STATUS_COLOR[status];
  return (
    <span className="ps-kaizen-pill" data-testid="fu-status" style={{ background: `color-mix(in srgb, ${color} 16%, transparent)`, color }}>
      <span className="ps-kaizen-dot" style={{ background: color }} />
      {STATUS_LABEL[status]}
    </span>
  );
}

/** Time open with its colour; Solved says "solved in". */
export function TimeOpen({ c }: { c: Pick<FollowupCase, 'hoursOpen' | 'timeBand' | 'status'> }) {
  if (c.hoursOpen === null || c.timeBand === null) return null;
  const color = BAND_COLOR[c.timeBand as TimeBand];
  return (
    <span className="ps-fu-time" title={BAND_HINT} data-band={c.timeBand} data-testid="fu-time" style={{ color }}>
      <span className="ps-kaizen-dot" style={{ background: color }} aria-hidden="true" />
      {c.status === 'SOLVED' ? 'solved in ' : 'open '}
      {formatHoursOpen(c.hoursOpen)}
    </span>
  );
}

/** One case on the board: order / delivery, customer, company and branch, reason, owner, time open. */
export function CaseCard({ c, onOpen }: { c: FollowupCase; onOpen: (id: number) => void }) {
  return (
    <button type="button" className="ps-fu-card" data-testid="fu-card" data-band={c.timeBand ?? 'none'} onClick={() => onOpen(c.caseId)}
      style={{ borderInlineStartColor: c.timeBand ? BAND_COLOR[c.timeBand] : 'var(--ps-color-border)' }}>
      <div className="ps-fu-card-top">
        <strong>{c.orderRef ?? c.deliveryCode ?? `Case #${c.caseId}`}</strong>
        <span className="ps-fu-muted">#{c.caseId}</span>
      </div>
      <div className="ps-fu-card-customer" dir="auto">{c.customer ?? '—'}</div>
      <div className="ps-fu-muted">{[c.company, c.teamBranch ?? c.salesTeam].filter(Boolean).join(' · ') || '—'}</div>
      <div className="ps-fu-card-meta">
        <span title={c.reasonAr ?? undefined}>{c.reasonEn ?? <em className="ps-fu-muted">No reason yet</em>}</span>
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
