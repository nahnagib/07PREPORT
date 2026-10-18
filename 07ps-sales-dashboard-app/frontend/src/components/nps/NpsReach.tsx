import React from 'react';
import { ChartPanel, EmptyState, ErrorState, KpiTile, LoadingSkeleton } from '@07ps/ui';
import type { NpsReach as ReachData } from '../../lib/api';
import { formatNumber } from '../../lib/format';
import { Waiting } from './Waiting';

export type ReachState = { data: ReachData | null; loading: boolean; error: string | null; retry: () => void };

/** Both panels share one request. Counts are messages in their current state, not unique people. */
export function NpsReach({ state, part }: { state: ReachState; part: 'boxes' | 'errors' }) {
  const data = state.data;
  let body: React.ReactNode;
  if (state.error) body = <ErrorState message={state.error} onRetry={state.retry} />;
  else if (!data || state.loading) body = <LoadingSkeleton variant="chart" />;
  else if (data.status === 'restricted') body = <Waiting message="Message reach is unavailable for your assigned data scope." />;
  else if (data.status === 'waiting' || !data.totals) body = <Waiting message="Waiting for the WhatsApp message data" />;
  else if (part === 'boxes') {
    const totals = data.totals;
    body = (
      <>
        <section className="ps-nps-boxes" aria-label="WhatsApp message counts">
          {([
            ['Total Reach', totals.totalReach], ['Delivered', totals.delivered],
            ['Not Delivered', totals.notDelivered], ['Read', totals.read], ['Error', totals.error],
          ] as const).map(([label, value]) => <KpiTile key={label} label={label} value={formatNumber(value)} />)}
        </section>
        {totals.otherState > 0 && <p role="status">{formatNumber(totals.otherState)} messages have other states; included in Total Reach.</p>}
      </>
    );
  } else if (data.errors.length === 0) body = <EmptyState message="No message errors for these companies and dates." />;
  else {
    const max = Math.max(...data.errors.map((e) => e.count));
    body = (
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }} aria-label="Message errors by reason">
        {data.errors.map((e) => (
          <li key={e.key} style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', flexWrap: 'wrap' }}>
              <span>{e.label}{e.fixable ? ' · Fixable' : ''}</span><strong>{formatNumber(e.count)}</strong>
            </div>
            <div role="img" aria-label={`${e.label}: ${e.count}`} style={{ marginTop: 6, height: 8, background: 'var(--ps-color-border)', borderRadius: 4 }}>
              <div style={{ width: `${max ? e.count / max * 100 : 0}%`, height: '100%', background: 'var(--ps-color-alert)', borderRadius: 4 }} />
            </div>
            <p style={{ fontSize: 12, margin: '6px 0', color: 'var(--ps-color-neutral-text)' }}>{e.hint}</p>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <ChartPanel title={part === 'boxes' ? 'Message reach' : 'Errors by reason'}
      infoText="WhatsApp feedback messages by message date and company. Delivered, Read, Not Delivered (sent), and Error are separate current states. Counts are messages, not unique recipients. Error mapping is provisional until the source is profiled.">
      {data?.companyAndDateOnly && <p style={{ fontSize: 12 }}>Company and date filters only</p>}
      {body}
      {data?.status === 'ready' && data.loadedAt && <p style={{ fontSize: 12, color: 'var(--ps-color-neutral-text)' }}>Message refresh {data.loadedAt} UTC</p>}
    </ChartPanel>
  );
}
