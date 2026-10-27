import React from 'react';
import { Reply, Smile, ThumbsUp } from 'lucide-react';
import { CompactKpiCard, KpiCard } from '@07ps/ui';
import type { NpsBandScale, NpsCounts, NpsResponseRate } from '../../lib/api';
import { NPS_CONTEXT, bandStatus, csatFooter, fmt2, longDate, npsBreakdown, npsFooter, pct, responseRateMetrics, responseRateTooltip, smallSample } from '../../lib/nps/view';

export type RateState = { data: NpsResponseRate | null; loading: boolean; error: string | null; retry: () => void };

/* The Promotion tachometer page's grid (YTD Value | YTD Actual ASP | YTD Volume): two gauge cards with a narrow card
   between them; the same ps-metrics-grid class, so it stacks the same way on small screens. */
const GRID: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1.5fr 260px 1.5fr', alignItems: 'stretch', gap: 'var(--ps-space-3, 16px)' };
const CELL: React.CSSProperties = { display: 'flex', width: '100%' };

/**
 * Row 1 of the NPS page, built from the Promotion page's own components: KpiCard (gauge variant, with the fixed bands
 * from /meta) for NPS and CSAT, CompactKpiCard (the "YTD Actual ASP" card) for the response rate. Every value, band and
 * target comes from the API; this only lays them out.
 */
export function NpsTopRow({ totals, thresholds, rate }: {
  totals: NpsCounts;
  thresholds: { nps: NpsBandScale; csat: NpsBandScale };
  rate: RateState;
}) {
  const fade: React.CSSProperties = totals.belowMinimum ? { opacity: 0.45 } : {};
  const nScale = thresholds.nps;
  const cScale = thresholds.csat;
  return (
    <section className="ps-metrics-grid" style={GRID} aria-label="NPS, response rate and CSAT">
      <div style={{ ...CELL, ...fade }} data-testid="nps-card" title={totals.belowMinimum ? `${smallSample(totals)}: below the minimum number of responders` : undefined}>
        <KpiCard
          title="NPS Score"
          infoText={NPS_CONTEXT}
          icon={Smile}
          variant="gauge"
          // the gauge clamps to 0..100 (a negative NPS pins the needle at 0, in red); the headline prints the real value
          actual={totals.nps ?? 0}
          targetToDate={nScale.target}
          status={bandStatus(totals.npsBand)}
          actualLabel={fmt2(totals.nps)}
          actualFullValue={npsBreakdown(totals)}
          targetLabel={`Target ${nScale.target}`}
          referenceMetrics={npsFooter(totals)}
          bands={nScale}
        />
      </div>

      <div style={CELL}>
        <ResponseRateCard state={rate} />
      </div>

      <div style={{ ...CELL, ...fade }} data-testid="csat-card">
        <KpiCard
          title="CSAT"
          icon={ThumbsUp}
          variant="gauge"
          actual={totals.csat ?? 0}
          targetToDate={cScale.target}
          status={bandStatus(totals.csatBand)}
          actualLabel={totals.csat === null ? '—' : pct(totals.csat)}
          actualFullValue="Satisfied = (Passives + Promoters) / Responders"
          targetLabel={`Target ${cScale.target}`}
          referenceMetrics={csatFooter(totals, cScale.target)}
          bands={cScale}
        />
      </div>
    </section>
  );
}

/** The narrow middle card: responders / (Delivered + Read), company and date filters only, from the reach start. */
export function ResponseRateCard({ state }: { state: RateState }) {
  const r = state.data;
  if (state.error) {
    return <CompactKpiCard title="Response Rate" icon={Reply} status="neutral" valueLabel="—" referenceMetrics={[]} notes={[state.error]} testId="rate-card" />;
  }
  if (!r || state.loading) return <CompactKpiCard title="Response Rate" icon={Reply} status="neutral" valueLabel="" referenceMetrics={[]} loading />;
  if (r.status !== 'ready') {
    const why = r.status === 'restricted' ? 'Unavailable for your assigned data scope.' : 'Waiting for the WhatsApp message data.';
    return <CompactKpiCard title="Response Rate" icon={Reply} status="neutral" valueLabel="—" referenceMetrics={[]} notes={[why]} testId="rate-card" />;
  }
  const notes: React.ReactNode[] = [
    <span key="since" data-testid="rate-since">since {longDate(r.reachStart ?? r.dateFrom)}</span>,
    <span key="what">Responders ÷ (Delivered + Read)</span>,
  ];
  if (r.companyAndDateOnly) notes.push(<strong key="only" data-testid="rate-company-only">Company and date filters only</strong>);
  return (
    <CompactKpiCard
      title="Response Rate"
      icon={Reply}
      status={bandStatus(r.band)}
      valueLabel={r.rate === null ? '—' : pct(r.rate)}
      valueTitle={responseRateTooltip(r)}
      referenceMetrics={responseRateMetrics(r)}
      notes={notes}
      sparklineValues={r.weekly.map((w) => w.rate ?? 0)}
      sparklineLabel="Weekly response rate"
      testId="rate-card"
    />
  );
}
