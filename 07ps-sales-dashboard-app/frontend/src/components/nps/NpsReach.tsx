import { vh } from '../../lib/visualHelp';
import React from 'react';
import { ChartPanel, EmptyState, ErrorState, KpiTile, LoadingSkeleton } from '@07ps/ui';
import type { NpsReach as ReachData, NpsResponseRate } from '../../lib/api';
import { formatNumber } from '../../lib/format';
import { pct, rateOfReachLine, sourceSplit } from '../../lib/nps/view';
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

/** The box of each card in the API's totals / bySource. */
const BOX_KEY = {
  'Total Reach': 'totalReach', Delivered: 'delivered', 'Not Delivered': 'notDelivered', Read: 'read', Error: 'error',
} as const;

/**
 * Both panels share one request. Counts are messages in their current state, not unique people. Before 03 Oct the
 * counts are from the approved manual reach (migration 0071). Each card's tooltip gives the source breakdown. Manual errors are one group, "Unclassified (Meta manual)".
 */
export function NpsReach({ state, part, responseRate }: {
  state: ReachState; part: 'boxes' | 'errors';
  responseRate?: Pick<NpsResponseRate, 'status' | 'responders' | 'dateFrom' | 'dateTo' | 'requestedDateFrom' | 'totalReach' | 'rateOfReach'> | null;
}) {
  const data = state.data;
  let body: React.ReactNode;
  if (state.error) body = <ErrorState message={state.error} onRetry={state.retry} />;
  else if (!data || state.loading) body = <LoadingSkeleton variant="chart" />;
  else if (data.status === 'restricted') body = <Waiting message="Survey Reach is unavailable for your assigned data scope." />;
  else if (data.status === 'waiting' || !data.totals) body = <Waiting message="Waiting for the WhatsApp message data" />;
  else if (part === 'boxes') {
    const totals = data.totals;
    // Rate of reach = the API's responders ÷ Total Reach (the same reach read as these cards), only for this very period
    // and only when its Total Reach is this card's -- never a stale or a different denominator
    const same = responseRate?.status === 'ready' && (responseRate.requestedDateFrom ?? responseRate.dateFrom) === data.dateFrom
      && responseRate.dateTo === data.dateTo && responseRate.totalReach === totals.totalReach;
    const { value: rateOfReach, tip: rateTip } = rateOfReachLine(same ? responseRate : null);
    body = (
      <>
        <section className="ps-nps-boxes" aria-label="WhatsApp message counts">
          {([
            ['Total Reach', totals.totalReach], ['Delivered', totals.delivered],
            ['Not Delivered', totals.notDelivered], ['Read', totals.read], ['Error', totals.error],
          ] as const).map(([label, value]) => {
            const k = BOX_KEY[label];
            const src = data.includesManual && data.bySource
              ? { etl: data.bySource.etl[k], manual: data.bySource.manual[k], estimate: data.bySource.estimate[k] } : null;
            const tip = src ? `${sourceSplit(src, data.reachStart)}\n${BOX_TIPS[label]}` : BOX_TIPS[label];
            return (
              <div key={label} title={label === 'Total Reach' ? `${tip}\n${rateTip}` : tip} data-testid={`reach-box-${label}`}>
                <KpiTile label={label} value={formatNumber(value)} emphasizeLabel
                  subValue={label === 'Total Reach' ? `Rate of reach: ${rateOfReach}` : `${share(value, totals.totalReach)} of reach`} />
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
    <ChartPanel {...vh(part === 'boxes' ? 'process.npsScore.reach' : 'process.npsScore.errors')} title={part === 'boxes' ? 'Survey Reach' : 'Errors by reason'}>
      {data?.companyAndDateOnly && <p style={{ fontSize: 12 }}>Company and date filters only</p>}
      {body}
      {ready && data.loadedAt && <p style={{ fontSize: 12, color: 'var(--ps-color-neutral-text)' }}>Message refresh {data.loadedAt} UTC</p>}
    </ChartPanel>
  );
}
