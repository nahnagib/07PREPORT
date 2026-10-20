import React from 'react';
import { ChartPanel, EmptyState, ErrorState, LoadingSkeleton } from '@07ps/ui';
import type { NpsFollowupSummary } from '../../lib/api';
import { formatNumber } from '../../lib/format';
import { FOLLOWUP_BUCKETS } from '../../lib/nps/view';
import { BarList } from './BarList';

export type FollowupState = { data: NpsFollowupSummary | null; loading: boolean; error: string | null; retry: () => void };

/** "Cancelled: 1 · Historical: 28" under both charts (they are left out of them). */
function LeftOut({ s }: { s: NpsFollowupSummary }) {
  return (
    <p style={{ fontSize: 12, color: 'var(--ps-color-neutral-text)', margin: '4px 0 0' }} data-testid="fu-left-out">
      Cancelled: {formatNumber(s.cancelled)} · Historical: {formatNumber(s.historical)}
      {s.noCase > 0 ? ` · Not yet a case: ${formatNumber(s.noCase)}` : ''}
    </p>
  );
}

/**
 * Detractors by reason and by status, read live from the follow-up cases (nps_followup_case) for the page's period and
 * filters: an edit on the follow-up page shows here on the next load. Historical (rated before the follow-up started)
 * and Cancelled cases are left out of both charts and counted under them.
 */
export function FollowupCharts({ state, part }: { state: FollowupState; part: 'reason' | 'status' }) {
  const s = state.data;
  let body: React.ReactNode;
  if (state.error) body = <ErrorState message={state.error} onRetry={state.retry} />;
  else if (!s) body = <LoadingSkeleton variant="chart" />;
  else if (s.charted === 0) body = <><EmptyState message="No followed-up detractors for these filters and dates." /><LeftOut s={s} /></>;
  else if (part === 'reason') {
    body = (
      <>
        <BarList ariaLabel="Detractors by reason" testId="fu-reason"
          items={s.byReason.map((r) => ({
            key: r.reasonId === null ? 'none' : String(r.reasonId), label: r.label, title: r.labelAr ?? undefined, count: r.count,
            color: r.reasonId === null ? 'var(--ps-color-muted-text)' : 'var(--ps-color-alert)',
          }))} />
        <LeftOut s={s} />
      </>
    );
  } else {
    const counts = Object.fromEntries(s.byStatus.map((b) => [b.key, b.count]));
    body = (
      <>
        <BarList ariaLabel="Detractors by status" testId="fu-status"
          items={FOLLOWUP_BUCKETS.map((b) => ({ key: b.key, label: b.label, count: counts[b.key] ?? 0, color: b.color }))} />
        <LeftOut s={s} />
      </>
    );
  }
  return (
    <ChartPanel
      title={part === 'reason' ? 'Detractors by reason' : 'Detractors by status'}
      infoText={part === 'reason'
        ? 'The reason recorded on each follow-up case (Detractor Follow-up page), live. "Not yet classified" = a case without a reason yet. Historical and Cancelled cases are left out.'
        : 'Each follow-up case, live: solved in under 48 hours (green), in 48 hours to 5 days (yellow), in more than 5 days (red), from the rating time to the time it was solved; or still pending (New, Contacted, In progress). Historical and Cancelled cases are left out.'}
    >
      {body}
    </ChartPanel>
  );
}
