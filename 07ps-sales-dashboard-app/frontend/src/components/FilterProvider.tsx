'use client';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { fetchFilterOptions, fetchRefreshStatus, type DimOption, type FilterOptionsResponse, type TachometerFilters } from '../lib/api';
import { useAuth } from '../lib/AuthProvider';
import { useBusinessUnit } from './BusinessUnitProvider';

const todayIso = () => new Date().toISOString().slice(0, 10);
/** Jan 1 of the current year -- every page's date-range filter defaults to YTD (Jan 1 -> today). */
const ytdStartIso = () => `${new Date().getUTCFullYear()}-01-01`;

/** Order-independent array equality (Company Link + Cascading Filter Bar, 2026-09) -- used by
 * onFiltersChange to detect whether a given filter field actually changed, regardless of the
 * order Select's multi-select toggling produced the new array in. */
function sameKeys(a: Array<string | number> | undefined, b: Array<string | number> | undefined): boolean {
  const as = [...(a ?? [])].map(String).sort();
  const bs = [...(b ?? [])].map(String).sort();
  return as.length === bs.length && as.every((v, i) => v === bs[i]);
}

export const EMPTY_FILTERS: TachometerFilters = {
  companyKeys: [],
  segmentKeys: [],
  channelKeys: [],
  salesTeamKeys: [],
  salespersonKeys: [],
  customerKeys: [],
};

/** Dashboard-wide default: Customer Group defaults to B2B (segment_key 1) + B2C (segment_key 2)
 * on every fresh load, per the BI Report Enhancement Brief's "Distribution filter" requirement --
 * confirmed with the business that "Distribution" refers to the Customer Group filter's B2B/B2C
 * values (dim_segment), not the separate Distribution Channel filter (dim_distribution_channel).
 * Keys are the fixed segment_key values documented in backend/src/measures/filters.ts, not fetched
 * dynamically -- they're stable warehouse dimension keys, not user-editable options. */
export const DEFAULT_FILTERS: TachometerFilters = {
  ...EMPTY_FILTERS,
  segmentKeys: [1, 2],
};

interface FilterContextValue {
  filters: TachometerFilters;
  /** `filters`, but forced to the signed-in salesperson's own scope when isSalesperson is true --
   * same lock every page computed locally before this provider existed (server-side enforcement is
   * still the real boundary; see applySalespersonLock in backend/src/measures/filters.ts). */
  effectiveFilters: TachometerFilters;
  anchorDate: string;
  dateFromDate: string;
  dateToDate: string;
  onFiltersChange: (next: TachometerFilters) => void;
  onAnchorDateChange: (date: string) => void;
  onDateRangeChange: (from: string, to: string) => void;
  resetFilters: () => void;
  /** True when every filter and date already equals its default (the Reset button's disabled state). */
  isAtDefaults: boolean;
  /** Cross-filtered options for every filter (GET /filters/options) -- see useScopedFilterOptions. */
  options: FilterOptionsState;
  reloadOptions: () => void;
  /** Which date scope narrows the option lists: 'range' = From..To (pages with a date range),
   * 'anchor' = everything up to the single anchor date. FilterBar sets this from its own props. */
  setOptionsDateMode: (mode: 'range' | 'anchor') => void;
  /** Whether the current page's KPIs can be scoped by Customer (FilterBar sets this). While false the
   * selection is left out of `effectiveFilters`, so it can neither narrow other lists nor be ignored
   * silently by a page whose data has no customer grain (targets, CRM pipeline). */
  setCustomerFilterEnabled: (enabled: boolean) => void;
  /** Bumped whenever warehouse data has been refreshed (an ETL run finished); every data hook
   * lists it as a dependency, so bumping it re-fetches all dashboard data and the filter options. */
  dataVersion: number;
  bumpDataVersion: () => void;
}

export interface FilterOptionsState {
  data: FilterOptionsResponse['options'] | null;
  /** True during any (re)fetch, including background refreshes while `data` is still shown. */
  loading: boolean;
  error: string | null;
  /** The selected filters together match no sales data (within the date scope). */
  empty: boolean;
}

const OPTIONS_DEBOUNCE_MS = 250;
const REFRESH_POLL_MS = 60_000;

const FilterContext = createContext<FilterContextValue | null>(null);

/**
 * Single source of truth for the filter bar's state (Company/Customer Group/Distribution
 * Channel/Branch/Salesperson + the anchor/from/to dates), shared across every Promotion page --
 * same context-provider pattern as BusinessUnitProvider, one level up. Previously each page owned
 * an identical copy of this state (useState + handleFiltersChange + handleDateRangeChange,
 * repeated in all 8 page files), which meant navigating between pages silently reset every filter.
 * Mounted once in app/layout.tsx, inside AuthProvider (needs useAuth() for the salesperson lock)
 * and BusinessUnitProvider (already-global company->logo sync, absorbed here from what used to be
 * each page's own handleFiltersChange).
 */
export function FilterProvider({ children }: { children: React.ReactNode }) {
  const { isSalesperson, salespersonKey, token } = useAuth();
  const { setBusinessUnit } = useBusinessUnit();

  const [filters, setFilters] = useState<TachometerFilters>(DEFAULT_FILTERS);
  const [anchorDate, setAnchorDate] = useState(todayIso());
  const [dateFromDate, setDateFromDate] = useState(ytdStartIso());
  const [dateToDate, setDateToDate] = useState(todayIso());

  const [customerEnabled, setCustomerFilterEnabled] = useState(false);

  const effectiveFilters = useMemo<TachometerFilters>(() => {
    const base = isSalesperson ? { ...EMPTY_FILTERS, salespersonKeys: salespersonKey != null ? [salespersonKey] : [] } : filters;
    return customerEnabled ? base : { ...base, customerKeys: [] };
  }, [isSalesperson, salespersonKey, filters, customerEnabled]);

  /** Company -> header logo (Majaal/Tika/both). Also re-run when the server prunes a company. */
  const syncBusinessUnit = useCallback(
    (next: TachometerFilters) => {
      const companyKeys = next.companyKeys ?? [];
      if (companyKeys.length === 1 && companyKeys[0] === 1) setBusinessUnit('majaal');
      else if (companyKeys.length === 1 && companyKeys[0] === 2) setBusinessUnit('tika');
      else setBusinessUnit('all');
    },
    [setBusinessUnit],
  );

  const onFiltersChange = useCallback(
    (next: TachometerFilters) => {
      // Dependent selections are no longer cleared here: the server cross-filters every option
      // list and returns the selection with only the now-invalid values removed (see the options
      // effect below), so a still-valid child selection survives a parent change.
      setFilters(next);
      syncBusinessUnit(next);
    },
    [syncBusinessUnit],
  );

  const onDateRangeChange = useCallback((from: string, to: string) => {
    // Guard against an inverted range (e.g. the From Date picker firing after To Date was already
    // moved earlier) -- end can never be before start, and neither can be past today, so every
    // KPI hook downstream always receives a valid, non-empty window.
    const today = todayIso();
    const clampedTo = to > today ? today : to;
    const clampedFrom = from > clampedTo ? clampedTo : from;
    setDateFromDate(clampedFrom);
    setDateToDate(clampedTo);
    // Anchor date drives MTD/YTD for every KPI (month/year start -> anchor date) -- it must track
    // the range's END, not its start. Anchoring to `from` instead (the previous bug) pinned every
    // KPI's MTD/YTD window to whatever the start date was -- e.g. Jan 1, which collapses MTD/YTD
    // to a single day -- and meant moving the To Date picker alone never changed any data at all.
    setAnchorDate(clampedTo);
  }, []);

  const resetFilters = useCallback(() => {
    setFilters(DEFAULT_FILTERS);
    setBusinessUnit('all');
    const today = todayIso();
    setAnchorDate(today);
    setDateFromDate(ytdStartIso());
    setDateToDate(today);
  }, [setBusinessUnit]);

  const isAtDefaults =
    (['companyKeys', 'segmentKeys', 'channelKeys', 'salesTeamKeys', 'salespersonKeys', 'customerKeys'] as const).every((d) =>
      sameKeys(filters[d], DEFAULT_FILTERS[d]),
    ) &&
    dateFromDate === ytdStartIso() &&
    dateToDate === todayIso() &&
    anchorDate === todayIso();

  // ---- Cross-filtered option lists (GET /filters/options) --------------------------------------
  const [optionsDateMode, setOptionsDateMode] = useState<'range' | 'anchor'>('anchor');
  const [dataVersion, setDataVersion] = useState(0);
  const bumpDataVersion = useCallback(() => setDataVersion((v) => v + 1), []);
  const [optionsReload, setOptionsReload] = useState(0);
  const reloadOptions = useCallback(() => setOptionsReload((v) => v + 1), []);
  const [options, setOptions] = useState<FilterOptionsState>({ data: null, loading: true, error: null, empty: false });

  const dateFrom = optionsDateMode === 'range' ? dateFromDate : null;
  const dateTo = optionsDateMode === 'range' ? dateToDate : anchorDate;
  const filtersSig = JSON.stringify(effectiveFilters);
  const isFirstOptionsLoad = useRef(true);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    // First load is immediate; later ones are debounced so rapid multi-select clicks collapse into
    // one request. Cleanup aborts the in-flight request, so a slow stale response can never
    // overwrite a newer one (and cancelled timers never fire at all).
    const delay = isFirstOptionsLoad.current ? 0 : OPTIONS_DEBOUNCE_MS;
    // Keep showing the previous options while refetching (no flicker) -- only `loading` flips.
    setOptions((o) => ({ ...o, loading: true, error: null }));
    const timer = setTimeout(() => {
      fetchFilterOptions(token, effectiveFilters, { dateFrom, dateTo }, controller.signal)
        .then((res) => {
          isFirstOptionsLoad.current = false;
          setOptions({ data: res.options, loading: false, error: null, empty: !res.hasData });
          // Auto-deselect: adopt the server's pruned selection if it dropped anything. Not for a
          // salesperson-tier user (their filters are forced server-side and aren't editable).
          if (!isSalesperson) {
            const dims = ['companyKeys', 'segmentKeys', 'channelKeys', 'salesTeamKeys', 'salespersonKeys', 'customerKeys'] as const;
            setFilters((prev) => {
              if (dims.every((d) => sameKeys(prev[d], res.filters[d]))) return prev;
              const next = { ...prev };
              for (const d of dims) {
                if (!sameKeys(prev[d], res.filters[d])) (next as Record<string, unknown>)[d] = res.filters[d];
              }
              syncBusinessUnit(next);
              return next;
            });
          }
        })
        .catch((err) => {
          if (err instanceof DOMException && err.name === 'AbortError') return;
          setOptions((o) => ({ ...o, loading: false, error: err instanceof Error ? err.message : 'Failed to load filter options.' }));
        });
    }, delay);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // effectiveFilters is tracked through its serialized form (a new object each render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, filtersSig, dateFrom, dateTo, isSalesperson, dataVersion, optionsReload, syncBusinessUnit]);

  // Notice a finished ETL run (any user, any page): poll the refresh timestamp and, when it moves,
  // bump dataVersion so dashboards and filter options reload on their own.
  const lastRefreshSeen = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    const check = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      fetchRefreshStatus(token)
        .then((status) => {
          if (cancelled) return;
          const seen = lastRefreshSeen.current;
          lastRefreshSeen.current = status.lastRefreshTime;
          if (seen !== undefined && seen !== status.lastRefreshTime) bumpDataVersion();
        })
        .catch(() => {
          // Best-effort; the next tick tries again.
        });
    };
    check();
    const id = setInterval(check, REFRESH_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [token, bumpDataVersion]);

  const value: FilterContextValue = {
    filters,
    effectiveFilters,
    anchorDate,
    dateFromDate,
    dateToDate,
    onFiltersChange,
    onAnchorDateChange: setAnchorDate,
    onDateRangeChange,
    resetFilters,
    isAtDefaults,
    options,
    reloadOptions,
    setOptionsDateMode,
    setCustomerFilterEnabled,
    dataVersion,
    bumpDataVersion,
  };

  return <FilterContext.Provider value={value}>{children}</FilterContext.Provider>;
}

export function useFilterState() {
  const ctx = useContext(FilterContext);
  if (!ctx) throw new Error('useFilterState must be used within FilterProvider');
  return ctx;
}

export function useDataVersion(): number {
  // Outside a FilterProvider (e.g. isolated tests) there is nothing to refresh on.
  return useContext(FilterContext)?.dataVersion ?? 0;
}

interface AsyncOptions {
  data: DimOption[] | null;
  loading: boolean;
  error: string | null;
}

/**
 * Cross-filtered option lists in the shape pages already consume from useFilterOptions
 * (businessUnits/customerGroups/... each `{ data, loading, error }`), plus `customers`. All lists
 * come from the one shared /filters/options request owned by FilterProvider, so every page and the
 * FilterBar see the same, already-narrowed options without each fetching their own.
 */
export function useScopedFilterOptions() {
  const ctx = useContext(FilterContext);
  if (!ctx) throw new Error('useScopedFilterOptions must be used within FilterProvider');
  const { data, loading, error } = ctx.options;
  const pick = (key: keyof FilterOptionsResponse['options']): AsyncOptions => ({
    data: data ? data[key] : null,
    loading,
    error,
  });
  return {
    businessUnits: pick('businessUnits'),
    customerGroups: pick('customerGroups'),
    distributionChannels: pick('distributionChannels'),
    branches: pick('branches'),
    salespersons: pick('salespersons'),
    customers: pick('customers'),
    empty: ctx.options.empty,
    reload: ctx.reloadOptions,
  };
}
