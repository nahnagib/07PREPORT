'use client';
import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { TachometerFilters } from '../lib/api';
import { useAuth } from '../lib/AuthProvider';
import { useBusinessUnit } from './BusinessUnitProvider';

const todayIso = () => new Date().toISOString().slice(0, 10);
/** Jan 1 of the current year -- every page's date-range filter defaults to YTD (Jan 1 -> today). */
const ytdStartIso = () => `${new Date().getUTCFullYear()}-01-01`;

export const EMPTY_FILTERS: TachometerFilters = {
  companyKeys: [],
  segmentKeys: [],
  channelKeys: [],
  salesTeamKeys: [],
  salespersonKeys: [],
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

  const [filters, setFilters] = useState<TachometerFilters>(EMPTY_FILTERS);
  const [anchorDate, setAnchorDate] = useState(todayIso());
  const [dateFromDate, setDateFromDate] = useState(ytdStartIso());
  const [dateToDate, setDateToDate] = useState(todayIso());

  const effectiveFilters = useMemo<TachometerFilters>(
    () => (isSalesperson ? { ...EMPTY_FILTERS, salespersonKeys: salespersonKey != null ? [salespersonKey] : [] } : filters),
    [isSalesperson, salespersonKey, filters],
  );

  const onFiltersChange = useCallback(
    (next: TachometerFilters) => {
      setFilters(next);
      const companyKeys = next.companyKeys ?? [];
      if (companyKeys.length === 1 && companyKeys[0] === 1) setBusinessUnit('majaal');
      else if (companyKeys.length === 1 && companyKeys[0] === 2) setBusinessUnit('tika');
      else setBusinessUnit('all');
    },
    [setBusinessUnit],
  );

  const onDateRangeChange = useCallback((from: string, to: string) => {
    setDateFromDate(from);
    setDateToDate(to);
    // Anchor date drives MTD/YTD for the current API -- keep it aligned to the range's start.
    setAnchorDate(from);
  }, []);

  const resetFilters = useCallback(() => {
    setFilters(EMPTY_FILTERS);
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
