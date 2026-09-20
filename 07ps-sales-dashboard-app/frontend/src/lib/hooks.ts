'use client';
import { useCallback, useEffect, useState } from 'react';
import {
  BcgMatrixOverview,
  BcgMatrixScopeFilters,
  BrandPerformanceOverview,
  BreakdownGroupBy,
  CriticalNumberOverview,
  CustomerGrowthOverview,
  CustomerGrowthScope,
  DimOption,
  InvoicesEngineOverview,
  InvoicesEngineScope,
  RefreshStatus,
  RevenueTrendOverview,
  TachometerBreakdown,
  TachometerFilters,
  TachometerMetricKey,
  TachometerOverview,
  TachometerTrend,
  fetchBcgMatrixOverview,
  fetchBrandPerformanceOverview,
  fetchBranches,
  fetchBusinessUnits,
  fetchCriticalNumberOverview,
  fetchCustomerGroups,
  fetchCustomerGrowthOverview,
  fetchDistributionChannels,
  fetchInvoicesEngineOverview,
  fetchActivityMomentumOverview,
  fetchPipelineHealthOverview,
  fetchPipelineTrendOverview,
  fetchRefreshStatus,
  fetchRevenueTrendOverview,
  fetchSalespersons,
  fetchTachometerBreakdown,
  fetchTachometerOverview,
  fetchTachometerTrend,
  ActivityMomentumOverview,
  PipelineHealthOverview,
  PipelineTrendOverview,
  fetchOverviewReportPdf,
} from './api';

interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

/**
 * Eternal-skeleton bug fix (Standards Section 3.23): every hook below depends on a `token` from
 * DevAuthProvider. Previously, `load()` just did `if (!token) return;` -- fine while auth is still
 * in flight on first mount, but if the token mint itself fails (backend unreachable, CORS block,
 * ...), `token` stays null forever and `load()` keeps bailing out *without ever setting loading to
 * false or setting an error* -- so every card sat in its initial `{loading:true}` state
 * indefinitely, with nothing on screen to say why. DevAuthProvider does capture that failure in its
 * own `error`, but nothing downstream was reading it.
 *
 * Fix: every hook now also takes `authError` (DevAuthProvider's own error string) and `retryAuth`
 * (re-attempts the token mint). When token is missing *because auth failed* (authError is set),
 * the hook resolves its own state to that same error instead of freezing -- so the card renders
 * the normal ErrorState+Retry UI it already supports, not an infinite skeleton. Its `retry` also
 * calls `retryAuth()` instead of a no-op `load()` in that case, so clicking Retry on any card
 * actually re-attempts the thing that's really broken.
 */
function authGate<T>(
  token: string | null,
  authError: string | null,
  setState: (s: AsyncState<T>) => void,
): boolean {
  if (token) return false;
  if (authError) {
    setState({ data: null, loading: false, error: authError });
  }
  // else: auth is still in flight on first mount -- stay in the initial loading state, `load` will
  // re-run once `token` (or `authError`) changes.
  return true;
}

function makeRetry(token: string | null, retryAuth: () => void, load: () => void): () => void {
  return () => (token ? load() : retryAuth());
}

/** Stable, order-independent string key for an array of filter keys -- used below to decide
 * whether a cascading dependent fetch actually needs to re-run, without retriggering on an
 * unrelated filter field changing (e.g. salespersonKeys must never retrigger the Customer Group
 * fetch, which only depends on companyKeys). */
function keySig(values: Array<string | number> | undefined): string {
  return JSON.stringify([...(values ?? [])].map(String).sort());
}

/**
 * Filter value-lists for the Filters Panel (Standards Section 3.4/4).
 *
 * CASCADING (Company Link + Cascading Filter Bar, 2026-09): `filters` is the current Filter Bar
 * selection. Company (businessUnits) is the top of the cascade and never narrows -- fetched once,
 * same as before. Each of the other four re-fetches whenever its own upstream keys change (Customer
 * Group depends on companyKeys; Distribution Channel on companyKeys+segmentKeys; Branch on those
 * plus channelKeys; Salesperson on all four) -- narrowing, never disabling: at zero upstream
 * selections every endpoint's fast path returns the exact same unnarrowed list as before this
 * feature. Each dependent effect is keyed on a stable, sorted serialization of only its own
 * upstream fields (see keySig) so an unrelated filter change (e.g. salespersonKeys) never
 * retriggers it.
 */
export function useFilterOptions(
  token: string | null,
  authError: string | null,
  retryAuth: () => void,
  filters: TachometerFilters = {},
) {
  const [businessUnits, setBusinessUnits] = useState<AsyncState<DimOption[]>>({ data: null, loading: true, error: null });
  const [customerGroups, setCustomerGroups] = useState<AsyncState<DimOption[]>>({ data: null, loading: true, error: null });
  const [distributionChannels, setDistributionChannels] = useState<AsyncState<DimOption[]>>({ data: null, loading: true, error: null });
  const [branches, setBranches] = useState<AsyncState<DimOption[]>>({ data: null, loading: true, error: null });
  const [salespersons, setSalespersons] = useState<AsyncState<DimOption[]>>({ data: null, loading: true, error: null });

  const companyKeys = filters.companyKeys;
  const segmentKeys = filters.segmentKeys;
  const channelKeys = filters.channelKeys;
  const salesTeamKeys = filters.salesTeamKeys;

  const loadBusinessUnits = useCallback(() => {
    if (authGate(token, authError, setBusinessUnits)) return;
    setBusinessUnits((s) => ({ ...s, loading: true, error: null }));
    fetchBusinessUnits(token as string)
      .then((data) => setBusinessUnits({ data, loading: false, error: null }))
      .catch((err) => setBusinessUnits({ data: null, loading: false, error: err.message }));
  }, [token, authError]);

  const loadCustomerGroups = useCallback(() => {
    if (authGate(token, authError, setCustomerGroups)) return;
    setCustomerGroups((s) => ({ ...s, loading: true, error: null }));
    fetchCustomerGroups(token as string, { companyKeys })
      .then((data) => setCustomerGroups({ data, loading: false, error: null }))
      .catch((err) => setCustomerGroups({ data: null, loading: false, error: err.message }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, authError, keySig(companyKeys)]);

  const loadDistributionChannels = useCallback(() => {
    if (authGate(token, authError, setDistributionChannels)) return;
    setDistributionChannels((s) => ({ ...s, loading: true, error: null }));
    fetchDistributionChannels(token as string, { companyKeys, segmentKeys })
      .then((data) => setDistributionChannels({ data, loading: false, error: null }))
      .catch((err) => setDistributionChannels({ data: null, loading: false, error: err.message }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, authError, keySig(companyKeys), keySig(segmentKeys)]);

  const loadBranches = useCallback(() => {
    if (authGate(token, authError, setBranches)) return;
    setBranches((s) => ({ ...s, loading: true, error: null }));
    fetchBranches(token as string, { companyKeys, segmentKeys, channelKeys })
      .then((data) => setBranches({ data, loading: false, error: null }))
      .catch((err) => setBranches({ data: null, loading: false, error: err.message }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, authError, keySig(companyKeys), keySig(segmentKeys), keySig(channelKeys)]);

  const loadSalespersons = useCallback(() => {
    if (authGate(token, authError, setSalespersons)) return;
    setSalespersons((s) => ({ ...s, loading: true, error: null }));
    fetchSalespersons(token as string, { companyKeys, segmentKeys, channelKeys, salesTeamKeys })
      .then((data) => setSalespersons({ data, loading: false, error: null }))
      .catch((err) => setSalespersons({ data: null, loading: false, error: err.message }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, authError, keySig(companyKeys), keySig(segmentKeys), keySig(channelKeys), keySig(salesTeamKeys)]);

  useEffect(() => {
    loadBusinessUnits();
  }, [loadBusinessUnits]);
  useEffect(() => {
    loadCustomerGroups();
  }, [loadCustomerGroups]);
  useEffect(() => {
    loadDistributionChannels();
  }, [loadDistributionChannels]);
  useEffect(() => {
    loadBranches();
  }, [loadBranches]);
  useEffect(() => {
    loadSalespersons();
  }, [loadSalespersons]);

  const reload = useCallback(() => {
    if (token) {
      loadBusinessUnits();
      loadCustomerGroups();
      loadDistributionChannels();
      loadBranches();
      loadSalespersons();
    } else {
      retryAuth();
    }
  }, [token, retryAuth, loadBusinessUnits, loadCustomerGroups, loadDistributionChannels, loadBranches, loadSalespersons]);

  return { businessUnits, customerGroups, distributionChannels, branches, salespersons, reload };
}

/** Tachometer KPI overview (Part A's /tachometer/overview endpoint). */
export function useTachometerOverview(
  token: string | null,
  anchorDate: string,
  filters: TachometerFilters,
  authError: string | null,
  retryAuth: () => void,
) {
  const [state, setState] = useState<AsyncState<TachometerOverview>>({
    data: null,
    loading: true,
    error: null,
  });

  const load = useCallback(() => {
    if (authGate(token, authError, setState)) return;
    setState((s) => ({ ...s, loading: true, error: null }));
    fetchTachometerOverview(token as string, anchorDate, filters)
      .then((data) => setState({ data, loading: false, error: null }))
      .catch((err) => setState({ data: null, loading: false, error: err.message ?? 'Failed to load.' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, authError, anchorDate, JSON.stringify(filters)]);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, retry: makeRetry(token, retryAuth, load) };
}

/** Critical Number KPI overview (backend's /critical-number/overview endpoint). Same
 * authGate/makeRetry template as useTachometerOverview. */
export function useCriticalNumberOverview(
  token: string | null,
  anchorDate: string,
  filters: TachometerFilters,
  authError: string | null,
  retryAuth: () => void,
) {
  const [state, setState] = useState<AsyncState<CriticalNumberOverview>>({
    data: null,
    loading: true,
    error: null,
  });

  const load = useCallback(() => {
    if (authGate(token, authError, setState)) return;
    setState((s) => ({ ...s, loading: true, error: null }));
    fetchCriticalNumberOverview(token as string, anchorDate, filters)
      .then((data) => setState({ data, loading: false, error: null }))
      .catch((err) => setState({ data: null, loading: false, error: err.message ?? 'Failed to load.' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, authError, anchorDate, JSON.stringify(filters)]);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, retry: makeRetry(token, retryAuth, load) };
}

/** Last Update / Last Refresh Time + staleness (Standards Section 3.4/3.19/3.23). */
export function useRefreshStatus(token: string | null, authError: string | null, retryAuth: () => void) {
  const [state, setState] = useState<AsyncState<RefreshStatus>>({ data: null, loading: true, error: null });

  const load = useCallback(() => {
    if (authGate(token, authError, setState)) return;
    setState((s) => ({ ...s, loading: true, error: null }));
    fetchRefreshStatus(token as string)
      .then((data) => setState({ data, loading: false, error: null }))
      .catch((err) => setState({ data: null, loading: false, error: err.message }));
  }, [token, authError]);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, retry: makeRetry(token, retryAuth, load) };
}

/** Drill-down breakdown for one metric card (Tachometer page -> per-metric detail page). */
export function useTachometerBreakdown(
  token: string | null,
  anchorDate: string,
  filters: TachometerFilters,
  metric: TachometerMetricKey,
  groupBy: BreakdownGroupBy,
  authError: string | null,
  retryAuth: () => void,
) {
  const [state, setState] = useState<AsyncState<TachometerBreakdown>>({
    data: null,
    loading: true,
    error: null,
  });

  const load = useCallback(() => {
    if (authGate(token, authError, setState)) return;
    setState((s) => ({ ...s, loading: true, error: null }));
    fetchTachometerBreakdown(token as string, anchorDate, filters, metric, groupBy)
      .then((data) => setState({ data, loading: false, error: null }))
      .catch((err) => setState({ data: null, loading: false, error: err.message ?? 'Failed to load.' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, authError, anchorDate, JSON.stringify(filters), metric, groupBy]);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, retry: makeRetry(token, retryAuth, load) };
}


/** Revenue Trend KPI overview (backend's /revenue-trend/overview endpoint). Same
 * authGate/makeRetry template as useCriticalNumberOverview. */
export function useRevenueTrendOverview(
  token: string | null,
  anchorDate: string,
  filters: TachometerFilters,
  authError: string | null,
  retryAuth: () => void,
) {
  const [state, setState] = useState<AsyncState<RevenueTrendOverview>>({
    data: null,
    loading: true,
    error: null,
  });

  const load = useCallback(() => {
    if (authGate(token, authError, setState)) return;
    setState((s) => ({ ...s, loading: true, error: null }));
    fetchRevenueTrendOverview(token as string, anchorDate, filters)
      .then((data) => setState({ data, loading: false, error: null }))
      .catch((err) => setState({ data: null, loading: false, error: err.message ?? 'Failed to load.' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, authError, anchorDate, JSON.stringify(filters)]);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, retry: makeRetry(token, retryAuth, load) };
}

/** Invoices Engine KPI overview (backend's /invoices-engine/overview endpoint). Same
 * authGate/makeRetry template as useRevenueTrendOverview, plus a `scope` param (the Sales Trend
 * year / Invoices Classification class page-filter selections) that re-fetches whenever it
 * changes -- these are real backend re-queries, not just a client-side re-render. */
export function useInvoicesEngineOverview(
  token: string | null,
  anchorDate: string,
  filters: TachometerFilters,
  scope: InvoicesEngineScope,
  authError: string | null,
  retryAuth: () => void,
) {
  const [state, setState] = useState<AsyncState<InvoicesEngineOverview>>({
    data: null,
    loading: true,
    error: null,
  });

  const load = useCallback(() => {
    if (authGate(token, authError, setState)) return;
    setState((s) => ({ ...s, loading: true, error: null }));
    fetchInvoicesEngineOverview(token as string, anchorDate, filters, scope)
      .then((data) => setState({ data, loading: false, error: null }))
      .catch((err) => setState({ data: null, loading: false, error: err.message ?? 'Failed to load.' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, authError, anchorDate, JSON.stringify(filters), scope.selectedYear, scope.selectedInvoiceClass]);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, retry: makeRetry(token, retryAuth, load) };
}

/** Customer Growth KPI overview (backend's /customer-growth/overview endpoint). Same
 * authGate/makeRetry template as useInvoicesEngineOverview, plus a `scope` param (the Customers
 * Trend year page-filter selection) that re-fetches whenever it changes -- a real backend
 * re-query, not just a client-side re-render. */
export function useCustomerGrowthOverview(
  token: string | null,
  anchorDate: string,
  filters: TachometerFilters,
  scope: CustomerGrowthScope,
  authError: string | null,
  retryAuth: () => void,
) {
  const [state, setState] = useState<AsyncState<CustomerGrowthOverview>>({
    data: null,
    loading: true,
    error: null,
  });

  const load = useCallback(() => {
    if (authGate(token, authError, setState)) return;
    setState((s) => ({ ...s, loading: true, error: null }));
    fetchCustomerGrowthOverview(token as string, anchorDate, filters, scope)
      .then((data) => setState({ data, loading: false, error: null }))
      .catch((err) => setState({ data: null, loading: false, error: err.message ?? 'Failed to load.' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, authError, anchorDate, JSON.stringify(filters), scope.selectedYear, scope.selectedCategory]);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, retry: makeRetry(token, retryAuth, load) };
}

/** Pipeline Health KPI overview (backend's /pipeline-health/overview endpoint). No anchorDate --
 * this page's figures are all-time, see api.ts's fetchPipelineHealthOverview header comment. Same
 * authGate/makeRetry template as every other overview hook. */
export function usePipelineHealthOverview(
  token: string | null,
  filters: TachometerFilters,
  authError: string | null,
  retryAuth: () => void,
) {
  const [state, setState] = useState<AsyncState<PipelineHealthOverview>>({
    data: null,
    loading: true,
    error: null,
  });

  const load = useCallback(() => {
    if (authGate(token, authError, setState)) return;
    setState((s) => ({ ...s, loading: true, error: null }));
    fetchPipelineHealthOverview(token as string, filters)
      .then((data) => setState({ data, loading: false, error: null }))
      .catch((err) => setState({ data: null, loading: false, error: err.message ?? 'Failed to load.' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, authError, JSON.stringify(filters)]);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, retry: makeRetry(token, retryAuth, load) };
}

/** Pipeline Trend KPI overview (backend's /pipeline-trend/overview endpoint). Same
 * authGate/makeRetry template as every other overview hook; no scope param -- read-only page. */
export function usePipelineTrendOverview(
  token: string | null,
  anchorDate: string,
  filters: TachometerFilters,
  authError: string | null,
  retryAuth: () => void,
) {
  const [state, setState] = useState<AsyncState<PipelineTrendOverview>>({
    data: null,
    loading: true,
    error: null,
  });

  const load = useCallback(() => {
    if (authGate(token, authError, setState)) return;
    setState((s) => ({ ...s, loading: true, error: null }));
    fetchPipelineTrendOverview(token as string, anchorDate, filters)
      .then((data) => setState({ data, loading: false, error: null }))
      .catch((err) => setState({ data: null, loading: false, error: err.message ?? 'Failed to load.' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, authError, anchorDate, JSON.stringify(filters)]);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, retry: makeRetry(token, retryAuth, load) };
}

/** Activity Momentum KPI overview (backend's /activity-momentum/overview endpoint). Same
 * authGate/makeRetry template as every other overview hook. */
export function useActivityMomentumOverview(
  token: string | null,
  anchorDate: string,
  filters: TachometerFilters,
  authError: string | null,
  retryAuth: () => void,
) {
  const [state, setState] = useState<AsyncState<ActivityMomentumOverview>>({
    data: null,
    loading: true,
    error: null,
  });

  const load = useCallback(() => {
    if (authGate(token, authError, setState)) return;
    setState((s) => ({ ...s, loading: true, error: null }));
    fetchActivityMomentumOverview(token as string, anchorDate, filters)
      .then((data) => setState({ data, loading: false, error: null }))
      .catch((err) => setState({ data: null, loading: false, error: err.message ?? 'Failed to load.' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, authError, anchorDate, JSON.stringify(filters)]);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, retry: makeRetry(token, retryAuth, load) };
}

/** Monthly trend series (Revenue/Volume/ASP/Monthly Achievement charts). */
export function useTachometerTrend(
  token: string | null,
  anchorDate: string,
  filters: TachometerFilters,
  authError: string | null,
  retryAuth: () => void,
) {
  const [state, setState] = useState<AsyncState<TachometerTrend>>({ data: null, loading: true, error: null });

  const load = useCallback(() => {
    if (authGate(token, authError, setState)) return;
    setState((s) => ({ ...s, loading: true, error: null }));
    fetchTachometerTrend(token as string, anchorDate, filters)
      .then((data) => setState({ data, loading: false, error: null }))
      .catch((err) => setState({ data: null, loading: false, error: err.message ?? 'Failed to load.' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, authError, anchorDate, JSON.stringify(filters)]);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, retry: makeRetry(token, retryAuth, load) };
}

/** BCG Matrix overview (backend's /bcg-matrix/overview endpoint). Same authGate/makeRetry
 * template as every other overview hook, but no anchorDate/filters -- fact_bcgmatrix's YTD/LYTD
 * figures are already computed by the ETL, so there's nothing page-side to parameterize. */
export function useBcgMatrixOverview(
  token: string | null,
  authError: string | null,
  retryAuth: () => void,
  scope: BcgMatrixScopeFilters = {},
) {
  const [state, setState] = useState<AsyncState<BcgMatrixOverview>>({ data: null, loading: true, error: null });

  const load = useCallback(() => {
    if (authGate(token, authError, setState)) return;
    setState((s) => ({ ...s, loading: true, error: null }));
    fetchBcgMatrixOverview(token as string, scope)
      .then((data) => setState({ data, loading: false, error: null }))
      .catch((err) => setState({ data: null, loading: false, error: err.message ?? 'Failed to load.' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, authError, JSON.stringify(scope)]);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, retry: makeRetry(token, retryAuth, load) };
}

/** PIM Contribution Brand Performance overview (backend's /pim-contribution/brand-performance
 * endpoint) -- same authGate/AsyncState/makeRetry template as useBcgMatrixOverview, no
 * scope/filters param (Company/Category/BCG Class filtering stays client-side on this page, same
 * as it was against the mock data this replaces). */
export function useBrandPerformanceOverview(token: string | null, authError: string | null, retryAuth: () => void) {
  const [state, setState] = useState<AsyncState<BrandPerformanceOverview>>({ data: null, loading: true, error: null });

  const load = useCallback(() => {
    if (authGate(token, authError, setState)) return;
    setState((s) => ({ ...s, loading: true, error: null }));
    fetchBrandPerformanceOverview(token as string)
      .then((data) => setState({ data, loading: false, error: null }))
      .catch((err) => setState({ data: null, loading: false, error: err.message ?? 'Failed to load.' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, authError]);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, retry: makeRetry(token, retryAuth, load) };
}

/**
 * Export Overview Report (backend/src/routes/reports.ts) -- an on-demand PDF snapshot of the
 * CURRENT situation for whatever filters are on screen. Action-triggered, not auto-fetch-on-mount
 * like every other hook above, so it follows Pipeline Health's existing `handleDownloadPdf`
 * local-state convention (isExporting boolean + label swap) instead of the authGate/AsyncState
 * template -- generalized into one shared hook so the same button works on all 8 pages without
 * duplicating this 8 times. Unlike that existing precedent, this surfaces failures via `error`
 * rather than silently swallowing them.
 */
export function useExportOverviewReport(token: string | null, anchorDate: string, filters: TachometerFilters) {
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const exportReport = useCallback(async () => {
    if (!token) {
      setError('You must be signed in to export a report.');
      return;
    }
    setIsExporting(true);
    setError(null);
    try {
      const blob = await fetchOverviewReportPdf(token, anchorDate, filters);
      const url = URL.createObjectURL(blob);
      const generatedTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const a = document.createElement('a');
      a.href = url;
      a.download = `Promotion_Overview_${anchorDate}_${generatedTimestamp}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to export the report.');
    } finally {
      setIsExporting(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, anchorDate, JSON.stringify(filters)]);

  return { isExporting, error, exportReport };
}
