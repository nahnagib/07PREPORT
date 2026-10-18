'use client';
import React, { useEffect, useMemo, useState } from 'react';
import { AppHeader } from '../../../../components/AppHeader';
import { BottomNavBar } from '../../../../components/BottomNavBar';
import { FilterBar } from '../../../../components/FilterBar';
import { PermissionGuard } from '../../../../components/AuthGuard';
import { useFilterState, useScopedFilterOptions } from '../../../../components/FilterProvider';
import { CsatBar } from '../../../../components/nps/CsatBar';
import { NpsReach } from '../../../../components/nps/NpsReach';
import { Waiting } from '../../../../components/nps/Waiting';
import { useAuth } from '../../../../lib/AuthProvider';
import { useNpsScore } from '../../../../lib/hooks';
import type { NpsDetractor, NpsGrain, NpsMeta, NpsOverview, NpsPage, NpsReach as ReachData, NpsScope, NpsTrend } from '../../../../lib/api';
import { formatDate, formatNumber, formatTimestamp } from '../../../../lib/format';
import {
  BAND_STATUS,
  GROUPS,
  GROUP_COLOR,
  NPS_CONTEXT,
  fmt2,
  gaugeValue,
  npsBreakdown,
  pct,
  smallSample,
  trendPoints,
} from '../../../../lib/nps/view';
import {
  Button,
  ChartPanel,
  ComboChart,
  DataGrid,
  EmptyState,
  ErrorState,
  Gauge,
  KpiTile,
  LoadingSkeleton,
  type DataGridColumn,
} from '@07ps/ui';

/**
 * NPS Score (Process department). Data: the ETL job process_nps loads the NPS developer's ratings into the warehouse
 * (docs/nps-etl.md); the page reads backend /nps-score, which reads only the v_process_nps_* views. The formulas are in
 * backend measures/npsScore.ts and the colour bands in backend config/npsThresholds.ts (sent here through /meta).
 *
 * Row 1 the score: the NPS tachometer (the Promotion pages' Gauge with fixed bands) + the CSAT bar.
 * Row 2 responders: Total · Promoters · Passives · Detractors (# and % of responders).
 * Row 3 WhatsApp message reach: company/date only; waiting until the first message load.
 * Row 4 the NPS trend: Daily / Monthly / Yearly; target line; periods below the minimum faded.
 * Row 5 Errors by reason (with the message data) · Detractors by reason · Detractors by status (waiting for the
 *       follow-up data source -- no data is invented).
 * Row 6 the detractor list with the customers' comments: only with the nps_comments permission.
 * Every rating visual filters on the rating date (Tripoli time), the global filters and the role's data scope.
 */
export default function NpsScorePage() {
  return (
    <PermissionGuard pageKey="nps_score">
      <NpsScoreBody />
    </PermissionGuard>
  );
}

const GRAIN_LABEL: Record<NpsGrain, string> = { day: 'Daily', month: 'Monthly', year: 'Yearly' };
const LIST_PAGE = 100;

function NpsScoreBody() {
  const { user, token, error: authError, retryAuth, logout, isSalesperson, canView } = useAuth();
  const roleLabel = user?.role.label ?? user?.fullName;
  const allowed = canView('nps_score');
  const { effectiveFilters, onFiltersChange, anchorDate, onAnchorDateChange, dateFromDate, dateToDate, onDateRangeChange } = useFilterState();
  const filterOptions = useScopedFilterOptions();
  const [grain, setGrain] = useState<NpsGrain>('month');
  const [listPages, setListPages] = useState(1);

  const scope: NpsScope = useMemo(() => ({ ...effectiveFilters, dateFrom: dateFromDate, dateTo: dateToDate }), [effectiveFilters, dateFromDate, dateToDate]);
  useEffect(() => setListPages(1), [scope]);

  const meta = useNpsScore<NpsMeta>(token, authError, retryAuth, 'meta', scope, undefined, allowed);
  const overview = useNpsScore<NpsOverview>(token, authError, retryAuth, 'overview', scope, undefined, allowed);
  const trend = useNpsScore<NpsTrend>(token, authError, retryAuth, 'trend', scope, { grain }, allowed);
  const reach = useNpsScore<ReachData>(token, authError, retryAuth, 'reach', scope, undefined, allowed);
  const canSeeDetractors = meta.data?.canSeeDetractors === true;
  const detractors = useNpsScore<NpsPage<NpsDetractor>>(token, authError, retryAuth, 'detractors', scope,
    { page: 1, pageSize: LIST_PAGE * listPages }, allowed && canSeeDetractors);

  const totals = overview.data?.totals;
  const thresholds = meta.data?.thresholds;
  const freshness = meta.data?.freshness;

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', paddingBottom: 64 }}>
      <AppHeader pageTitle="NPS Score" anchorDate={anchorDate} onAnchorDateChange={onAnchorDateChange} roleLabel={roleLabel} onLogout={logout} showDateInput={false} />
      <FilterBar
        filters={effectiveFilters}
        onChange={onFiltersChange}
        anchorDate={anchorDate}
        onAnchorDateChange={onAnchorDateChange}
        businessUnits={filterOptions.businessUnits.data ?? []}
        customerGroups={filterOptions.customerGroups.data ?? []}
        distributionChannels={filterOptions.distributionChannels.data ?? []}
        branches={filterOptions.branches.data ?? []}
        salespersons={filterOptions.salespersons.data ?? []}
        isSalesperson={isSalesperson}
        dateFromDate={dateFromDate}
        dateToDate={dateToDate}
        onDateRangeChange={onDateRangeChange}
        showLastOrderInfo={false}
        showCustomerFilter
      />

      <div className="ps-nps-freshness" data-testid="nps-freshness">
        <span>NPS refresh <strong>{formatTimestamp(freshness?.lastSuccessUtc ?? null)}</strong></span>
        <span>Latest rating <strong>{meta.data?.lastRatingAt ? `${meta.data.lastRatingAt.slice(0, 16)} (Tripoli)` : '—'}</strong></span>
        <span>Ratings since <strong>{meta.data?.firstRatingDate ? formatDate(meta.data.firstRatingDate) : '—'}</strong></span>
        {freshness?.lastFailureUtc ? <span style={{ color: 'var(--ps-color-alert)' }}>Last NPS run failed at {formatTimestamp(freshness.lastFailureUtc)}</span> : null}
      </div>

      <main className="ps-nps-main">
        {overview.error || meta.error ? (
          <ErrorState message={overview.error ?? meta.error ?? undefined} onRetry={() => { overview.retry(); meta.retry(); }} />
        ) : !totals || !thresholds ? (
          <div className="ps-nps-row">{[0, 1, 2].map((i) => <LoadingSkeleton key={i} variant="chart" />)}</div>
        ) : (
          <>
            {totals.responders === 0 && <EmptyState message="No ratings for these filters and dates." />}
            {/* Row 1: the score */}
            <section className="ps-nps-score-row" aria-label="NPS and CSAT">
              <ChartPanel title="NPS Score" infoText={NPS_CONTEXT}>
                <div className="ps-nps-gauge" style={{ opacity: totals.belowMinimum ? 0.45 : 1 }} data-testid="nps-gauge">
                  <Gauge
                    actual={gaugeValue(totals.nps, thresholds.nps)}
                    targetToDate={thresholds.nps.target}
                    targetLabel={`Target ${thresholds.nps.target}`}
                    status={totals.npsBand ? BAND_STATUS[totals.npsBand] : 'neutral'}
                    bands={thresholds.nps}
                    showValueLabel={false}
                    label="NPS Score"
                    size={240}
                  />
                  <div className="ps-nps-value" data-testid="nps-value">{fmt2(totals.nps)}</div>
                  <div className="ps-nps-sub">{npsBreakdown(totals)}</div>
                  {smallSample(totals) && <div className="ps-nps-sub">{smallSample(totals)} (below {meta.data?.minResponders} responders)</div>}
                </div>
              </ChartPanel>
              <ChartPanel title="CSAT" infoText={`Satisfied = (Passives + Promoters) / Responders. Red below ${thresholds.csat.yellowFrom}, yellow from ${thresholds.csat.yellowFrom}, green from ${thresholds.csat.greenFrom}; target ${thresholds.csat.target}.`}>
                <div className="ps-nps-gauge">
                  <CsatBar value={totals.csat} band={totals.csatBand} scale={thresholds.csat} muted={totals.belowMinimum} />
                  <div className="ps-nps-sub">Satisfied = (Passives + Promoters) / Responders</div>
                  {smallSample(totals) && <div className="ps-nps-sub">{smallSample(totals)}</div>}
                </div>
              </ChartPanel>
            </section>

            {/* Row 2: responders */}
            <section className="ps-nps-boxes" aria-label="Responders">
              <KpiTile label="Total Responders" value={formatNumber(totals.responders)} subValue={`${formatNumber(totals.withComment)} with a comment`} />
              {GROUPS.map((g) => (
                <KpiTile
                  key={g.key}
                  label={`${g.stars} ${g.label} · ${g.labelAr}`}
                  value={formatNumber(totals[g.key])}
                  subValue={`${pct(totals[`${g.key}Pct` as const])} of responders`}
                  accentColor={GROUP_COLOR[g.key]}
                />
              ))}
            </section>

            {/* Row 3: WhatsApp message reach (section 4) */}
            <NpsReach state={reach} part="boxes" />

            {/* Row 4: trend */}
            <ChartPanel
              title="NPS trend"
              wrapHeader
              infoText={`Line: NPS per period, with the target line at ${trend.data?.target ?? thresholds.nps.target}. Bars: responders. A period below ${meta.data?.minResponders} responders is shown faded.`}
              headerActions={
                <div className="ps-nps-switch" role="group" aria-label="Trend period">
                  {(Object.keys(GRAIN_LABEL) as NpsGrain[]).map((g) => (
                    <Button key={g} variant={grain === g ? 'primary' : 'secondary'} onClick={() => setGrain(g)} aria-pressed={grain === g}>
                      {GRAIN_LABEL[g]}
                    </Button>
                  ))}
                </div>
              }
            >
              {trend.error ? (
                <ErrorState message={trend.error} onRetry={trend.retry} />
              ) : !trend.data ? (
                <LoadingSkeleton variant="chart" />
              ) : (
                <ComboChart
                  showTitle={false}
                  points={trendPoints(trend.data)}
                  bars={[{ key: 'responders', name: 'Responders', color: 'var(--ps-color-last-year)' }]}
                  lines={[
                    { key: 'nps', name: 'NPS', color: 'var(--ps-color-accent)', yAxisId: 'right', labelFormatter: (v) => fmt2(v) },
                    { key: 'npsSmall', name: `NPS (n < ${trend.data.minResponders})`, color: 'var(--ps-color-neutral-text)', yAxisId: 'right' },
                    { key: 'target', name: `Target ${trend.data.target}`, color: 'var(--ps-color-success)', yAxisId: 'right' },
                  ]}
                  leftAxisFormatter={(v) => formatNumber(v)}
                  rightAxisFormatter={(v) => String(Math.round(v))}
                  height={300}
                />
              )}
            </ChartPanel>

            {/* Row 5: reasons and follow-up */}
            <section className="ps-nps-row" aria-label="Reasons and follow-up">
              <NpsReach state={reach} part="errors" />
              <ChartPanel title="Detractors by reason" infoText="The reason each detractor gave or the team recorded. No data source exists yet (see docs/nps-etl.md, follow-up).">
                <Waiting message="Waiting for the follow-up data source" />
              </ChartPanel>
              <ChartPanel title="Detractors by status" infoText="Solved in under 48 hours (green), in 48 hours to 5 days (yellow), in more than 5 days (red), or pending (black), from the rating time to the time the case was solved. No data source exists yet.">
                <Waiting message="Waiting for the follow-up data source" />
              </ChartPanel>
            </section>

            {/* Row 6: the detractor list (nps_comments) */}
            {canSeeDetractors && (
              <ChartPanel title={`Detractors (${formatNumber(detractors.data?.total ?? totals.detractors)})`}
                infoText="Every ★ rating, newest first, with the customer's comments (phone numbers and e-mail addresses masked). Visible only with the NPS Score detractor list permission.">
                <DetractorList state={detractors} onMore={() => setListPages((p) => p + 1)} />
              </ChartPanel>
            )}
          </>
        )}
      </main>
      <BottomNavBar active="NPS Score" />
    </div>
  );
}

type ListState = { data: NpsPage<NpsDetractor> | null; loading: boolean; error: string | null; retry: () => void };

function DetractorList({ state, onMore }: { state: ListState; onMore: () => void }) {
  if (state.error) return <ErrorState message={state.error} onRetry={state.retry} />;
  if (!state.data) return <LoadingSkeleton variant="table" />;
  if (state.data.total === 0) return <EmptyState message="No detractors for these filters and dates." />;
  type Row = NpsDetractor & Record<string, unknown>;
  const columns: DataGridColumn<Row>[] = [
    { key: 'ratedAt', header: 'Date (Tripoli)', width: 140, render: (r) => r.ratedAt?.slice(0, 16) ?? '—' },
    { key: 'customer', header: 'Customer', width: 200, render: (r) => <span dir="auto">{r.customer ?? '—'}</span> },
    { key: 'orderRef', header: 'Order', render: (r) => <span dir="auto">{r.orderRef ?? '—'}</span> },
    { key: 'salesTeam', header: 'Team', render: (r) => <span dir="auto">{r.salesTeam ?? '—'}</span> },
    { key: 'salesperson', header: 'Salesperson', render: (r) => r.salesperson ?? '—' },
    { key: 'status', header: 'Status', render: (r) => r.status ?? 'No follow-up data', rawValue: (r) => r.status ?? '' },
    { key: 'reason', header: 'Reason', render: (r) => r.reason ?? 'No follow-up data', rawValue: (r) => r.reason ?? '' },
    { key: 'comment', header: 'Comment', width: 280, render: (r) => <span dir="auto" style={{ whiteSpace: 'pre-line' }}>{r.comment ?? '—'}</span>,
      rawValue: (r) => r.comment ?? '' },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <DataGrid columns={columns} rows={state.data.rows as Row[]} getRowId={(r) => String(r.responseId)} fileName="nps-score-detractors" pageSize={25} />
      {state.data.rows.length < state.data.total && (
        <div>
          <Button variant="secondary" onClick={onMore} disabled={state.loading}>
            {state.loading ? 'Loading…' : `Show more (${formatNumber(state.data.rows.length)} of ${formatNumber(state.data.total)})`}
          </Button>
        </div>
      )}
    </div>
  );
}
