'use client';
import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { TachometerFilters } from '../lib/api';
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
}

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
  const { isSalesperson, salespersonKey } = useAuth();
  const { setBusinessUnit } = useBusinessUnit();

  const [filters, setFilters] = useState<TachometerFilters>(DEFAULT_FILTERS);
  const [anchorDate, setAnchorDate] = useState(todayIso());
  const [dateFromDate, setDateFromDate] = useState(ytdStartIso());
  const [dateToDate, setDateToDate] = useState(todayIso());

  const effectiveFilters = useMemo<TachometerFilters>(
    () => (isSalesperson ? { ...EMPTY_FILTERS, salespersonKeys: salespersonKey != null ? [salespersonKey] : [] } : filters),
    [isSalesperson, salespersonKey, filters],
  );

  const onFiltersChange = useCallback(
    (next: TachometerFilters) => {
      // Cascade reset (Company Link + Cascading Filter Bar, 2026-09): changing a parent filter
      // clears every dependent child's *value* -- narrowing their *option lists* is handled
      // separately by useFilterOptions (lib/hooks.ts), which re-fetches whenever its own upstream
      // keys change. Compared against the PREVIOUS filters state (via setFilters's updater form),
      // not `next` itself, so this only fires on an actual change to that specific field -- e.g.
      // salespersonKeys changing must never reset itself or anything else.
      setFilters((prev) => {
        const cascaded: TachometerFilters = { ...next };
        if (!sameKeys(prev.companyKeys, next.companyKeys)) {
          cascaded.segmentKeys = [];
          cascaded.channelKeys = [];
          cascaded.salesTeamKeys = [];
          cascaded.salespersonKeys = [];
        } else if (!sameKeys(prev.segmentKeys, next.segmentKeys)) {
          cascaded.channelKeys = [];
          cascaded.salesTeamKeys = [];
          cascaded.salespersonKeys = [];
        } else if (!sameKeys(prev.channelKeys, next.channelKeys)) {
          cascaded.salesTeamKeys = [];
          cascaded.salespersonKeys = [];
        } else if (!sameKeys(prev.salesTeamKeys, next.salesTeamKeys)) {
          cascaded.salespersonKeys = [];
        }
        return cascaded;
      });
      const companyKeys = next.companyKeys ?? [];
      if (companyKeys.length === 1 && companyKeys[0] === 1) setBusinessUnit('majaal');
      else if (companyKeys.length === 1 && companyKeys[0] === 2) setBusinessUnit('tika');
      else setBusinessUnit('all');
    },
    [setBusinessUnit],
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
  };

  return <FilterContext.Provider value={value}>{children}</FilterContext.Provider>;
}

export function useFilterState() {
  const ctx = useContext(FilterContext);
  if (!ctx) throw new Error('useFilterState must be used within FilterProvider');
  return ctx;
}
