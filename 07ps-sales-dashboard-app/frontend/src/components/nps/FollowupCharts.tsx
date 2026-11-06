import { vh } from '../../lib/visualHelp';
import React from 'react';
import { ChartPanel, EmptyState, ErrorState, LoadingSkeleton } from '@07ps/ui';
import type { NpsFollowupSummary } from '../../lib/api';
import { formatNumber } from '../../lib/format';
import { FOLLOWUP_BUCKETS } from '../../lib/nps/view';
import { ReasonPie } from './ReasonPie';

export type FollowupState = { data: NpsFollowupSummary | null; loading: boolean; error: string | null; retry: () => void };

const NOTE = { fontSize: 12, color: 'var(--ps-color-neutral-text)', margin: '4px 0 0' } as const;
const STATUS_LABEL: Record<string, string> = { OPEN: 'Open', CLOSE: 'Close', DISPUTED: 'Disputed' };

/** "Rejected: 1 · Historical: 28" under both charts (stages left out of them). */
function LeftOut({ s }: { s: NpsFollowupSummary }) {
  return (
    <p style={NOTE} data-testid="fu-left-out">
      Rejected: {formatNumber(s.rejected)} · Historical: {formatNumber(s.historical)}
      {s.noCase > 0 ? ` · Not yet a case: ${formatNumber(s.noCase)}` : ''}
    </p>
  );
}

/** "By status: Open 13 · Close 1 · Disputed 1" (the status, worked out from the stage; Historical has none). */
function ByStatus({ s }: { s: NpsFollowupSummary }) {
  return (
    <p style={NOTE} data-testid="fu-by-status">
      By status: {s.byStatus.map((b) => `${STATUS_LABEL[b.key]} ${formatNumber(b.count)}`).join(' · ')}
    </p>
  );
}

/**
 * Detractors by reason category and by stage, read live from the follow-up cases (nps_followup_case) for the page's
 * period and filters: an edit on the follow-up page shows here on the next load. Historical (rated before the
 * follow-up started) and Rejected cases are left out of both charts and counted under them; the stage chart also
 * gives the counts by status.
 */
export function FollowupCharts({ state, part }: { state: FollowupState; part: 'reason' | 'stage' }) {
  const s = state.data;
  let body: React.ReactNode;
  if (state.error) body = <ErrorState message={state.error} onRetry={state.retry} />;
  else if (!s || state.loading) body = <LoadingSkeleton variant="chart" />;
  else if (s.charted === 0) body = <><EmptyState message="No followed-up detractors for these filters and dates." /><LeftOut s={s} /></>;
  else if (part === 'reason') {
    body = (
      <>
        <ReasonPie ariaLabel="Detractors by reason" testId="fu-reason" totalLabel="Detractors"
          items={s.byReason.map((r, i) => ({
            key: r.categoryKey ?? 'none', label: r.label, hint: r.labelAr ?? undefined, count: r.count,
            color: r.categoryKey === null ? 'var(--ps-nps-slate)' : ['var(--ps-nps-blue)', 'var(--ps-nps-teal)', 'var(--ps-nps-cyan)', 'var(--ps-nps-lilac)', 'var(--ps-nps-amber)'][i % 5],
          }))} />
        <LeftOut s={s} />
      </>
    );
  } else {
    const counts = Object.fromEntries(s.byStage.map((b) => [b.key, b.count]));
    body = (
      <>
        <ReasonPie ariaLabel="Detractors by stage" testId="fu-stage" totalLabel="Detractors"
          items={FOLLOWUP_BUCKETS.map((b) => ({ key: b.key, label: b.label, count: counts[b.key] ?? 0, color: b.color }))} />
        <ByStatus s={s} />
        <LeftOut s={s} />
      </>
    );
  }
  return (
    <ChartPanel {...vh(part === 'reason' ? 'process.npsScore.byReason' : 'process.npsScore.byStage')}
      title={part === 'reason' ? 'Detractors by reason' : 'Detractors by stage'}
    >
      {body}
    </ChartPanel>
  );
}
