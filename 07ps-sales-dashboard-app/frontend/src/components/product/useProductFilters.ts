'use client';
import { useMemo } from 'react';
import { useAuth } from '../../lib/AuthProvider';
import { useFilterState, useScopedFilterOptions } from '../FilterProvider';
import { isProductPageCompany, isProductPageSegment } from '../../lib/materialsAnalogy/shared';
import type { ProductDashboardScope, RefreshStatus } from '../../lib/api';
import { standardFilterBarProps } from '../standardFilterBarProps';

/**
 * The Product pages' filter bar: EXACTLY the Promotion FilterBar (standardFilterBarProps: company, Customer Group,
 * Distribution Channel, Branch (= sales team), Salesperson, date range, last-update / refresh info), with the app-wide
 * FilterProvider state -- so the Customer Group default (B2B + B2C) applies on first load and after Reset, as on
 * Promotion. The Product-only filters (Category, Stock Band, BCG Class, Lifecycle Segment) go in FilterBar.secondRow.
 * Product-page rules on top: Athena is never offered (isProductPageCompany), nor Backoffice / Inter Company in Customer
 * Group (isProductPageSegment: their lines are not real sales and the ETL drops them from every Product table).
 *
 * `scope` is what useProductDashboard sends: the company view (one company selected, else every company side by side)
 * and the Customer Group / Channel / Branch / Salesperson keys (the API applies them, and the salesperson lock).
 */
export function useProductFilters(refresh?: RefreshStatus | null) {
  const { isSalesperson } = useAuth();
  const state = useFilterState();
  const { effectiveFilters, dateFromDate, dateToDate, resetFilters, isAtDefaults } = state;
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
      segmentKeys: effectiveFilters.segmentKeys,
      channelKeys: effectiveFilters.channelKeys,
      salesTeamKeys: effectiveFilters.salesTeamKeys,
      salespersonKeys: effectiveFilters.salespersonKeys,
      fromDate: dateFromDate,
      toDate: dateToDate,
    }),
    [companyView, effectiveFilters, dateFromDate, dateToDate],
  );

  const filterBarProps = standardFilterBarProps({ state, options: filterOptions, isSalesperson, refresh, businessUnits, customerGroups });

  /** Reset props for a page with its own second-row filters (Category, Stock Band, ...): Reset does exactly what it does
   * on Promotion (the shared filters back to B2B + B2C and calendar YTD) AND clears those; it is enabled when either is
   * changed. */
  const withLocalReset = (resetLocal: () => void, localPristine: boolean) => ({
    onReset: () => {
      resetLocal();
      resetFilters();
    },
    isPristine: localPristine && isAtDefaults,
  });

  return { ...state, filterOptions, scope, companyView, companyLabel, selectedCompanyNames, filterBarProps, withLocalReset };
}
