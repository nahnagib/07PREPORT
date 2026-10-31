'use client';
import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppHeader } from '../../../../components/AppHeader';
import { BottomNavBar } from '../../../../components/BottomNavBar';
import { FilterBar } from '../../../../components/FilterBar';
import { PermissionGuard } from '../../../../components/AuthGuard';
import { useFilterState, useScopedFilterOptions } from '../../../../components/FilterProvider';
import { FollowupCharts } from '../../../../components/nps/FollowupCharts';
import { NpsReach } from '../../../../components/nps/NpsReach';
import { NpsTopRow } from '../../../../components/nps/NpsTopRow';
import { NpsTrendChart, RespondersTrend } from '../../../../components/nps/NpsTrends';
import { OdooLink } from '../../../../components/OdooLink';
import { StatusPill, TimeOpen } from '../../../../components/nps-followup/FollowupBits';
import { useAuth } from '../../../../lib/AuthProvider';
import { useNpsScore } from '../../../../lib/hooks';
import type {
  NpsDetractor,
  NpsFollowupSummary,
  NpsGrain,
  NpsMeta,
  NpsOverview,
  NpsPage,
  NpsReach as ReachData,
  NpsResponseRate,
  NpsScope,
  NpsTrend,
} from '../../../../lib/api';
import { formatNumber, formatTimestamp } from '../../../../lib/format';
import {
  GROUPS,
  GROUP_COLOR,
  followupCaseHref,
  longDate,
  npsPeriod,
  pct,
  periodCaption,
} from '../../../../lib/nps/view';
import {
  Button,
  ChartPanel,
  DataGrid,
  EmptyState,
  ErrorState,
  KpiTile,
  LoadingSkeleton,
  type DataGridColumn,
} from '@07ps/ui';

/**
 * NPS Score (Process department). Data: the ETL job process_nps loads the NPS developer's ratings into the warehouse
 * (docs/nps-etl.md); the page reads backend /nps-score, which reads the v_process_nps_* views and, live, the follow-up
 * cases. The formulas are in backend measures/npsScore.ts and the colour bands in backend config/npsThresholds.ts (sent
 * here through /meta).
 *
 * Period: year-to-date by default (1 January -> today, Tripoli time), the same for every visual; the date filter can
 * change it (the label above then shows the chosen range).
 * Row 1 the Promotion tachometer layout: NPS tachometer · Response Rate (narrow) · CSAT tachometer.
 * Row 2 responders: Total · Promoters · Passives · Detractors (# and % of responders).
 * Row 3 WhatsApp message reach: company/date only.
 * Row 4 the trend: Weekly (Sunday..Saturday) / Monthly / Yearly from the first period with ratings; NPS and CSAT lines
 *       plus monthly stacked responders; periods below the minimum faded on the score chart.
 * Row 5 Errors by reason · Detractors by reason · Detractors by status (live from the follow-up cases).
 * Row 6 the detractor list with the follow-up case and the customers' comments: only with the nps_comments permission.
 * Every rating visual filters on the rating date (Tripoli time), the global filters and the role's data scope.
 */
export default function NpsScorePage() {
  return (
    <PermissionGuard pageKey="nps_score">
      <NpsScoreBody />
    </PermissionGuard>
  );
}

const LIST_PAGE = 100;

function NpsScoreBody() {
  const { user, token, error: authError, retryAuth, logout, isSalesperson, canView } = useAuth();
  const roleLabel = user?.role.label ?? user?.fullName;
  const allowed = canView('nps_score');
  const { effectiveFilters, onFiltersChange, anchorDate, onAnchorDateChange, dateFromDate, dateToDate, onDateRangeChange } = useFilterState();
  const filterOptions = useScopedFilterOptions();
  const [grain, setGrain] = useState<NpsGrain>('month');
  // The Responders Trend has its own Weekly / Monthly / Yearly switch (same choices, independent of the Satisfaction Trend).
  const [respondersGrain, setRespondersGrain] = useState<NpsGrain>('month');
  const [listPages, setListPages] = useState(1);

  const period = useMemo(() => npsPeriod(dateFromDate, dateToDate), [dateFromDate, dateToDate]);
  const scope: NpsScope = useMemo(() => ({ ...effectiveFilters, dateFrom: period.dateFrom, dateTo: period.dateTo }), [effectiveFilters, period]);
  useEffect(() => setListPages(1), [scope]);

  const meta = useNpsScore<NpsMeta>(token, authError, retryAuth, 'meta', scope, undefined, allowed);
  const overview = useNpsScore<NpsOverview>(token, authError, retryAuth, 'overview', scope, undefined, allowed);
  const trend = useNpsScore<NpsTrend>(token, authError, retryAuth, 'trend', scope, { grain }, allowed);
  // Only fetched when it differs from the Satisfaction Trend's grain; otherwise both charts share one response.
  const respondersOwnTrend = useNpsScore<NpsTrend>(token, authError, retryAuth, 'trend', scope, { grain: respondersGrain }, allowed && respondersGrain !== grain);
  const reach = useNpsScore<ReachData>(token, authError, retryAuth, 'reach', scope, undefined, allowed);
  const rate = useNpsScore<NpsResponseRate>(token, authError, retryAuth, 'response-rate', scope, undefined, allowed);
  const followup = useNpsScore<NpsFollowupSummary>(token, authError, retryAuth, 'followup-summary', scope, undefined, allowed);
  const canSeeDetractors = meta.data?.canSeeDetractors === true;
  const detractors = useNpsScore<NpsPage<NpsDetractor>>(token, authError, retryAuth, 'detractors', scope,
    { page: 1, pageSize: LIST_PAGE * listPages }, allowed && canSeeDetractors);

  const totals = overview.data?.totals;
  const thresholds = meta.data?.thresholds;
  const freshness = meta.data?.freshness;

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', paddingBottom: 64 }}>
      <AppHeader anchorDate={anchorDate} onAnchorDateChange={onAnchorDateChange} roleLabel={roleLabel} onLogout={logout} showDateInput={false} />
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
        <span title="The last successful NPS Score load (once a night, full reload), Tripoli time">Data refreshed: <strong>{formatTimestamp(freshness?.lastSuccessUtc ?? null)}</strong></span>
        <span title="Every visual on this page covers this period (rating date / message date, Tripoli time)" data-testid="nps-period"><strong>{periodCaption(period)}</strong></span>
        <span>Latest rating <strong>{meta.data?.lastRatingAt ? `${meta.data.lastRatingAt.slice(0, 16)}` : '—'}</strong></span>
        <span>Ratings since <strong>{longDate(meta.data?.firstRatingDate)}</strong></span>
        <span>Reach since <strong>{longDate(rate.data?.reachStart)}</strong></span>
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
            {/* Row 1: NPS · Response Rate · CSAT (the Promotion tachometer layout) */}
            <NpsTopRow totals={totals} thresholds={thresholds} rate={rate} />

            {/* Row 2: responders */}
            <section className="ps-nps-boxes" aria-label="Responders">
              <KpiTile label="Total Responders" value={formatNumber(totals.responders)} subValue={`${formatNumber(totals.withComment)} with a comment`} emphasizeLabel />
              {GROUPS.map((g) => (
                <KpiTile
                  key={g.key}
                  emphasizeLabel
                  label={g.label}
                  value={formatNumber(totals[g.key])}
                  subValue={`${pct(totals[`${g.key}Pct` as const])} of responders`}
                  status={g.key === 'promoters' ? 'success' : g.key === 'passives' ? 'watch' : 'alert'}
                  accentColor={GROUP_COLOR[g.key]}
                />
              ))}
            </section>

            {/* Row 3: WhatsApp message reach (section 4) */}
            <NpsReach state={reach} part="boxes" />

            {/* Row 4: trend */}
            <section className="ps-nps-trends" aria-label="Trends">
              <NpsTrendChart state={trend} grain={grain} onGrainChange={setGrain} />
              <RespondersTrend state={respondersGrain === grain ? trend : respondersOwnTrend} grain={respondersGrain} onGrainChange={setRespondersGrain} />
            </section>

            {/* Row 5: reasons and follow-up (live from the follow-up cases) */}
            <section className="ps-nps-row" aria-label="Reasons and follow-up">
              <NpsReach state={reach} part="errors" />
              <FollowupCharts state={followup} part="reason" />
              <FollowupCharts state={followup} part="status" />
            </section>

            {/* Row 6: the detractor list (nps_comments) */}
            {canSeeDetractors && (
              <ChartPanel title={`Detractors (${formatNumber(detractors.data?.total ?? totals.detractors)})`}
                infoText="Every ★ rating of the period, newest first, with its follow-up case (status, reason, owner and time open, live from the Detractor Follow-up page) and the customer's comments (phone numbers and e-mail addresses masked). Click a row to open the case (its delivery is on the case card); the order code opens in Odoo. Visible only with the NPS Score detractor list permission.">
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
  const router = useRouter();
  if (state.error) return <ErrorState message={state.error} onRetry={state.retry} />;
  if (!state.data) return <LoadingSkeleton variant="table" />;
  if (state.data.total === 0) return <EmptyState message="No detractors for these filters and dates." />;
  type Row = NpsDetractor & Record<string, unknown>;
  const columns: DataGridColumn<Row>[] = [
    { key: 'caseId', header: 'Case #', width: 90, render: (r) => (r.caseId !== null ? `#${r.caseId}` : '—'), rawValue: (r) => r.caseId ?? '' },
    { key: 'ratedAt', header: 'Date', width: 140, render: (r) => r.ratedAt?.slice(0, 16) ?? '—' },
    { key: 'customer', header: 'Customer', width: 200, render: (r) => <span dir="auto">{r.customer ?? '—'}</span> },
    { key: 'orderRef', header: 'Order', render: (r) => (r.orderRef ? <OdooLink href={r.orderUrl}>{r.orderRef}</OdooLink> : '—'), rawValue: (r) => r.orderRef ?? '' },
    { key: 'salesTeam', header: 'Team', render: (r) => <span dir="auto">{r.salesTeam ?? '—'}</span> },
    { key: 'salesperson', header: 'Salesperson', render: (r) => r.salesperson ?? '—' },
    { key: 'status', header: 'Status', render: (r) => (r.status ? <StatusPill status={r.status} /> : 'Not yet a case'), rawValue: (r) => r.status ?? '' },
    { key: 'reason', header: 'Reason', render: (r) => <span title={r.reasonAr ?? undefined}>{r.reason ?? 'Not yet classified'}</span>, rawValue: (r) => r.reason ?? '' },
    { key: 'owner', header: 'Owner', render: (r) => r.owner ?? '—', rawValue: (r) => r.owner ?? '' },
    { key: 'hoursOpen', header: 'Time open / Solved in', width: 150,
      render: (r) => (r.status && r.hoursOpen !== null && r.timeBand ? <TimeOpen c={{ status: r.status, hoursOpen: r.hoursOpen, timeBand: r.timeBand }} /> : '—'),
      rawValue: (r) => r.hoursOpen ?? '' },
    { key: 'comment', header: 'Comment', width: 280, render: (r) => <span dir="auto" style={{ whiteSpace: 'pre-line' }}>{r.comment ?? '—'}</span>,
      rawValue: (r) => r.comment ?? '' },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <DataGrid columns={columns} rows={state.data.rows as Row[]} getRowId={(r) => String(r.responseId)} fileName="nps-score-detractors" pageSize={25}
        onRowClick={(r) => r.caseId !== null && router.push(followupCaseHref(r.caseId, r.status === 'HISTORICAL'))} />
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
