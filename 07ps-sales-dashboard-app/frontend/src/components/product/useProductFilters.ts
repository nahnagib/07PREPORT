'use client';
import { useCallback, useMemo, useState } from 'react';
import { useAuth } from '../../lib/AuthProvider';
import { useFilterState, useScopedFilterOptions } from '../FilterProvider';
import { isProductPageCompany, isProductPageSegment } from '../../lib/materialsAnalogy/shared';
import type { ProductDashboardScope, RefreshStatus } from '../../lib/api';
import { standardFilterBarProps } from '../standardFilterBarProps';

/**
 * The Product pages' filter bar: the standard FilterBar (standardFilterBarProps, same look, refresh info) showing only
 * Company (never Athena: isProductPageCompany) and the Date range. The Product-only filters (Category, Stock Band, BCG
 * Class, Lifecycle Segment) go in FilterBar.secondRow.
 *
 * `scope` is what useProductDashboard sends: the company view (one company selected, else every company side by side)
 * and the Date filter.
 *
 * 2026-11-14 (round 2): Company and Date only. Customer Group / Channel / Branch / Salesperson are hidden and never sent
 * (the API drops them too; the role scope still applies server-side). The Date filter is the Product pages' own --
 * default the Last 12 Months (no dates sent: the API's default), a custom From / To otherwise -- shared by the 4
 * Product pages for the browser session; it does not change the other pages' date range.
 */
const DATE_KEY = 'ps_product_date_range';
type DateRange = { from: string; to: string } | null;

function readRange(): DateRange {
  try {
    const raw = sessionStorage.getItem(DATE_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v.from === 'string' && typeof v.to === 'string' ? v : null;
  } catch {
    return null;
  }
}
function writeRange(v: DateRange): void {
  try {
    if (v) sessionStorage.setItem(DATE_KEY, JSON.stringify(v));
    else sessionStorage.removeItem(DATE_KEY);
  } catch {
    /* storage unavailable: the range just isn't remembered */
  }
}
/** The default Last 12 Months shown in the date fields (today - 12 months .. today, the API's own rule). */
function last12MonthsDates(): { from: string; to: string } {
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const to = new Date();
  const from = new Date(to);
  from.setFullYear(to.getFullYear() - 1);
  if (from.getMonth() !== to.getMonth()) from.setDate(0); // 29 Feb -> 28 Feb
  return { from: iso(from), to: iso(to) };
}
export function useProductFilters(refresh?: RefreshStatus | null) {
  const { isSalesperson } = useAuth();
  const state = useFilterState();
  const { effectiveFilters, resetFilters } = state;
  const [range, setRange] = useState<DateRange>(() => readRange());
  const defaults = useMemo(() => last12MonthsDates(), []);
  const onDateRangeChange = useCallback((from: string, to: string) => {
    const next = from === defaults.from && to === defaults.to ? null : { from, to };
    setRange(next);
    writeRange(next);
  }, [defaults]);
  const resetDate = useCallback(() => {
    setRange(null);
    writeRange(null);
  }, []);
  const filterOptions = useScopedFilterOptions();

  const businessUnits = useMemo(
    () => (filterOptions.businessUnits.data ?? []).filter((u) => isProductPageCompany(String(u.company_name))),
    [filterOptions.businessUnits.data],
  );
  const customerGroups = useMemo(
    () => (filterOptions.customerGroups.data ?? []).filter((g) => isProductPageSegment(g.segment_key)),
    [filterOptions.customerGroups.data],
  );
  const selectedCompanyNames = useMemo(() => {
    const keys = new Set((effectiveFilters.companyKeys ?? []).map(String));
    return new Set(businessUnits.filter((u) => keys.has(String(u.company_key))).map((u) => String(u.company_name)));
  }, [businessUnits, effectiveFilters.companyKeys]);
  // One company selected = that company's view; none or both = every company's products side by side.
  const companyView = selectedCompanyNames.size === 1 ? [...selectedCompanyNames][0] : undefined;
  const companyLabel = selectedCompanyNames.size ? [...selectedCompanyNames].join(', ') : 'Majaal + Tika';

  const scope: ProductDashboardScope = useMemo(
    () => ({
      company: companyView,
      ...(range ? { fromDate: range.from, toDate: range.to } : {}),
    }),
    [companyView, range],
  );

  const companyPristine = (effectiveFilters.companyKeys ?? []).length === 0;
  const datePristine = range === null;
  const filterBarProps = {
    ...standardFilterBarProps({ state, options: filterOptions, isSalesperson, refresh, businessUnits, customerGroups }),
    showTransactionDimensions: false,
    dateFromDate: range?.from ?? defaults.from,
    dateToDate: range?.to ?? defaults.to,
    onDateRangeChange,
    onReset: () => {
      resetDate();
      resetFilters();
    },
    isPristine: companyPristine && datePristine,
  };

  /** Reset props for a page with its own second-row filters (Category, Stock Band, ...): Reset puts Company and Date back
   * (Last 12 Months) AND clears those; it is enabled when any of them is changed. */
  const withLocalReset = (resetLocal: () => void, localPristine: boolean) => ({
    onReset: () => {
      resetLocal();
      resetDate();
      resetFilters();
    },
    isPristine: localPristine && companyPristine && datePristine,
  });

  return { ...state, filterOptions, scope, companyView, companyLabel, selectedCompanyNames, filterBarProps, withLocalReset };
}
