import { vh } from '../../lib/visualHelp';
import React from 'react';
import { ChartPanel, EmptyState, ErrorState, KpiTile, LoadingSkeleton } from '@07ps/ui';
import type { NpsReach as ReachData } from '../../lib/api';
import { formatDate, formatNumber } from '../../lib/format';
import { pct, reachBoxTooltip, reachSubtitle } from '../../lib/nps/view';
import { errorPieItems } from '../../lib/nps/errorReasons';
import { ReasonPie } from './ReasonPie';
import { Waiting } from './Waiting';

export type ReachState = { data: ReachData | null; loading: boolean; error: string | null; retry: () => void };

const DATE_NOTE = 'Counted by message date (Tripoli time) and company only.';
const BOX_TIPS: Record<string, string> = {
  'Total Reach': `Every WhatsApp feedback message sent. ${DATE_NOTE}`,
  Delivered: `Messages delivered to the phone but not read yet. ${DATE_NOTE}`,
  'Not Delivered': `Messages sent but not delivered to the phone yet (state "sent"). ${DATE_NOTE}`,
  Read: `Messages the customer opened. ${DATE_NOTE}`,
  Error: `Messages that failed; see Errors by reason. ${DATE_NOTE}`,
};

/** "x% of reach"; "—" when nothing was sent. */
const share = (count: number, total: number) => (total > 0 ? pct((100 * count) / total) : '—');

/** The box of each card in the API's totals / measured / gap. */
const BOX_KEY = {
  'Total Reach': 'totalReach', Delivered: 'delivered', 'Not Delivered': 'notDelivered', Read: 'read', Error: 'error',
} as const;

/**
 * Both panels share one request. Counts are messages in their current state, not unique people. A period reaching into
 * the gap 12 Jul – 02 Oct shows the official totals: measured + the gap (Delivered, Read, Not Delivered estimated;
 * Error real), each card marked, its tooltip split measured / gap; the subtitle says so. Otherwise exactly as measured.
 */
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
          ] as const).map(([label, value]) => {
            const k = BOX_KEY[label];
            const split = data.isEstimated && data.estimate && data.measured && data.gap ? { m: data.measured[k], g: data.gap[k] } : null;
            const marked = split !== null && split.g > 0;
            const tip = split && data.estimate ? `${reachBoxTooltip(k, split.m, split.g, data.reachStart, data.estimate)}\n${BOX_TIPS[label]}` : BOX_TIPS[label];
            return (
              <div key={label} title={tip} data-testid={`reach-box-${label}`} data-estimated={marked ? 'true' : undefined}>
                {/* the mark: the gap 12 Jul – 02 Oct is in this card -- estimated, or (Error) its real failed messages */}
                <KpiTile label={label} value={formatNumber(value)} emphasizeLabel
                  labelDetail={marked ? (label === 'Error' ? 'incl. gap' : 'incl. est.') : undefined}
                  subValue={label === 'Total Reach' ? '100% of reach' : `${share(value, totals.totalReach)} of reach`} />
              </div>
            );
          })}
        </section>
        {totals.otherState > 0 && <p role="status">{formatNumber(totals.otherState)} messages have other states; included in Total Reach.</p>}
      </>
    );
  } else if (data.errors.length === 0) body = <EmptyState message="No message errors for these companies and dates." />;
  else {
    body = (
      <ReasonPie ariaLabel="Message errors by reason" testId="reach-errors" totalLabel="Errors" items={errorPieItems(data.errors)} />
    );
  }
  const ready = data?.status === 'ready';
  return (
    <ChartPanel {...vh(part === 'boxes' ? 'process.npsScore.reach' : 'process.npsScore.errors')} title={part === 'boxes' ? 'Message reach' : 'Errors by reason'}>
      {data?.companyAndDateOnly && <p style={{ fontSize: 12 }}>Company and date filters only</p>}
      {ready && data.isEstimated && data.estimate
        ? <p style={{ fontSize: 12, color: 'var(--ps-color-neutral-text)' }} data-testid="reach-subtitle">{reachSubtitle(data.reachStart, data.estimate)}</p>
        : ready && data.reachStart && <p style={{ fontSize: 12, color: 'var(--ps-color-neutral-text)' }} data-testid="reach-subtitle">Reach data from {formatDate(data.reachStart)}</p>}
      {body}
      {ready && data.loadedAt && <p style={{ fontSize: 12, color: 'var(--ps-color-neutral-text)' }}>Message refresh {data.loadedAt} UTC</p>}
    </ChartPanel>
  );
}
