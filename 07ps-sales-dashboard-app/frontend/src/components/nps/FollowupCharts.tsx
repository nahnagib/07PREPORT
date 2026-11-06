import { vh, type VisualHelpId } from '../../lib/visualHelp';
import React, { useState } from 'react';
import { ChartPanel, EmptyState, ErrorState, LoadingSkeleton } from '@07ps/ui';
import type { NpsFollowupStatus, NpsFollowupSummary } from '../../lib/api';
import { formatNumber } from '../../lib/format';
import { FOLLOWUP_BUCKETS, FOLLOWUP_STATUS_SLICES } from '../../lib/nps/view';
import { ReasonPie } from './ReasonPie';
import { StatusPie } from './StatusPie';

export type FollowupState = { data: NpsFollowupSummary | null; loading: boolean; error: string | null; retry: () => void };

const NOTE = { fontSize: 12, color: 'var(--ps-color-neutral-text)', margin: '4px 0 0' } as const;

/** Under each chart: what is not in it. "Resolved by time" also names Rejected (one of its slices). */
function LeftOut({ s, withRejected = false }: { s: NpsFollowupSummary; withRejected?: boolean }) {
  return (
    <p style={NOTE} data-testid="fu-left-out">
      {withRejected ? `Rejected: ${formatNumber(s.rejected)} · ` : ''}Historical: {formatNumber(s.historical)}
      {s.noCase > 0 ? ` · Not yet a case: ${formatNumber(s.noCase)}` : ''}
    </p>
  );
}

export type FollowupPart = 'reason' | 'status' | 'resolved';

const TITLE: Record<FollowupPart, string> = { reason: 'Detractors by reason', status: 'Detractors by status', resolved: 'Resolved by time' };
const HELP: Record<FollowupPart, VisualHelpId> = {
  reason: 'process.npsScore.byReason', status: 'process.npsScore.byStatus', resolved: 'process.npsScore.resolvedByTime',
};

/**
 * The follow-up charts of the NPS page, read live from the follow-up cases (nps_followup_case) for the page's period
 * and filters: an edit on the follow-up page shows here on the next load.
 *   reason    by reason category; a click drills into its sub-reasons ("← All reasons")
 *   status    by status (Open / Close / Disputed); a click drills into its stages ("← All statuses")
 *   resolved  "Resolved by time": Resolved < 48 h / 48 h - 5 days / > 5 days, Not resolved yet, Rejected (not resolved)
 * ONE total in every centre: the cases with a status (Rejected included). Historical has no status: left out of all
 * three, counted under them.
 */
const REASON_COLORS = ['var(--ps-nps-blue)', 'var(--ps-nps-teal)', 'var(--ps-nps-cyan)', 'var(--ps-nps-lilac)', 'var(--ps-nps-amber)'];

export function FollowupCharts({ state, part }: { state: FollowupState; part: FollowupPart }) {
  const s = state.data;
  /** the reason donut's drill-down: the category whose sub-reasons are shown (null = all categories) */
  const [drill, setDrill] = useState<string | null>(null);
  /** the status donut's drill-down: the status whose stages are shown */
  const [statusDrill, setStatusDrill] = useState<NpsFollowupStatus | null>(null);
  const drilled = part === 'reason' ? s?.byReason.find((r) => r.categoryKey !== null && r.categoryKey === drill) : undefined;
  let body: React.ReactNode;
  if (state.error) body = <ErrorState message={state.error} onRetry={state.retry} />;
  else if (!s || state.loading) body = <LoadingSkeleton variant="chart" />;
  else if (s.charted === 0) body = <><EmptyState message="No followed-up detractors for these filters and dates." /><LeftOut s={s} withRejected={part === 'resolved'} /></>;
  else if (part === 'reason' && drilled) {
    // step 2: the sub-reasons of one category
    body = (
      <>
        <button type="button" className="ps-nps-back" data-testid="fu-reason-back" onClick={() => setDrill(null)}>← All reasons</button>
        <ReasonPie ariaLabel={`${drilled.label} by sub-reason`} testId="fu-subreason" totalLabel={drilled.label}
          items={drilled.subReasons.map((r, i) => ({
            key: String(r.reasonId), label: r.label, hint: r.labelAr ?? undefined, count: r.count,
            color: r.label === 'Not specified' ? 'var(--ps-nps-slate)' : REASON_COLORS[i % REASON_COLORS.length],
          }))} />
      </>
    );
  } else if (part === 'reason') {
    // step 1: the categories; a click on one with sub-reasons drills into them
    body = (
      <>
        <ReasonPie ariaLabel="Detractors by reason" testId="fu-reason" totalLabel="Detractors"
          onSelect={setDrill} canSelect={(key) => (s.byReason.find((r) => r.categoryKey === key)?.subReasons.length ?? 0) > 0}
          items={s.byReason.map((r, i) => ({
            key: r.categoryKey ?? 'none', label: r.label, hint: r.labelAr ?? undefined, count: r.count,
            color: r.categoryKey === null ? 'var(--ps-nps-slate)' : REASON_COLORS[i % REASON_COLORS.length],
          }))} />
        <LeftOut s={s} />
      </>
    );
  } else if (part === 'status') {
    body = (
      <>
        <StatusPie summary={s} drill={statusDrill} onDrill={setStatusDrill} />
        <LeftOut s={s} />
      </>
    );
  } else {
    const counts = Object.fromEntries(s.byStage.map((b) => [b.key, b.count]));
    body = (
      <>
        <ReasonPie ariaLabel="Resolved by time" testId="fu-resolved" totalLabel="Detractors"
          items={FOLLOWUP_BUCKETS.map((b) => ({ key: b.key, label: b.label, count: counts[b.key] ?? 0, color: b.color }))} />
        <LeftOut s={s} withRejected />
      </>
    );
  }
  const title = part === 'reason' && drilled ? `${TITLE.reason} — ${drilled.label}`
    : part === 'status' && statusDrill ? `${TITLE.status} — ${FOLLOWUP_STATUS_SLICES[statusDrill].label}`
      : TITLE[part];
  return (
    <ChartPanel {...vh(HELP[part])} title={title} capabilities={part === 'resolved' ? undefined : { drill: true }}
    >
      {body}
    </ChartPanel>
  );
}
