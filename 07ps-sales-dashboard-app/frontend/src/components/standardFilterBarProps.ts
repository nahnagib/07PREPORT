import type { DimOption, RefreshStatus } from '../lib/api';
import type { useFilterState, useScopedFilterOptions } from './FilterProvider';

type FilterState = ReturnType<typeof useFilterState>;
type FilterOptions = ReturnType<typeof useScopedFilterOptions>;

/**
 * The standard FilterBar setup (Promotion: Revenue Trend), in ONE place so every page that uses it gets the same
 * fields in the same order, the same dates, the same Reset (the shared FilterProvider: Customer Group B2B + B2C) and
 * the same last-update / refresh info -- the Product pages use it too and cannot drift apart.
 *
 * Only the two option lists may be narrowed by a page (`businessUnits`, `customerGroups`): the Product pages leave out
 * Athena and the Backoffice / Inter Company groups (useProductFilters). Every other prop is the same everywhere.
 */
export function standardFilterBarProps({
  state,
  options,
  isSalesperson,
  refresh,
  businessUnits,
  customerGroups,
}: {
  state: FilterState;
  options: FilterOptions;
  isSalesperson: boolean;
  refresh: RefreshStatus | null | undefined;
  businessUnits?: DimOption[];
  customerGroups?: DimOption[];
}) {
  return {
    filters: state.effectiveFilters,
    onChange: state.onFiltersChange,
    anchorDate: state.anchorDate,
    onAnchorDateChange: state.onAnchorDateChange,
    businessUnits: businessUnits ?? options.businessUnits.data ?? [],
    customerGroups: customerGroups ?? options.customerGroups.data ?? [],
    distributionChannels: options.distributionChannels.data ?? [],
    branches: options.branches.data ?? [],
    salespersons: options.salespersons.data ?? [],
    isSalesperson,
    lastUpdate: refresh?.lastUpdate ?? null,
    lastOrderCreated: refresh?.lastOrderCreated ?? null,
    lastRefreshTime: refresh?.lastRefreshTime ?? null,
    dateFromDate: state.dateFromDate,
    dateToDate: state.dateToDate,
    onDateRangeChange: state.onDateRangeChange,
  };
}
