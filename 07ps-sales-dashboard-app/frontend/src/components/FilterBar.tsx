'use client';
import React, { useEffect, useState } from 'react';
import { SlidersHorizontal, ChevronDown, RotateCcw } from 'lucide-react';
import { Select, DateInput, type SelectOption } from '@07ps/ui';
import type { DimOption, TachometerFilters } from '../lib/api';
import { formatTimestamp } from '../lib/format';
import { useFilterState, useScopedFilterOptions } from './FilterProvider';

/** Same UTC-based "today" FilterProvider's own default/clamp logic uses, so the To Date picker's
 * max here can never disagree with what onDateRangeChange would itself clamp it to. */
const todayIso = () => new Date().toISOString().slice(0, 10);
/** Jan 1 of the current year -- the floor for `ytdOnly` pages. Computed on each call, never hardcoded. */
const ytdStartIso = () => `${new Date().getUTCFullYear()}-01-01`;

export interface FilterBarProps {
  /** All of the sales-transaction-shaped props below (filters/onChange/businessUnits/...) are
   * optional as of the Materials Analogy rollout -- a caller that sets the matching `show*` flag
   * to false never touches that field's props at all. Every one of the 8 original Sales-warehouse
   * pages still passes all of them explicitly, so nothing about their behavior changes; this is a
   * strictly additive extension, not a rework of the existing shape. */
  filters?: TachometerFilters;
  onChange?: (next: TachometerFilters) => void;
  anchorDate?: string;
  onAnchorDateChange?: (date: string) => void;
  businessUnits?: DimOption[];
  customerGroups?: DimOption[];
  distributionChannels?: DimOption[];
  branches?: DimOption[];
  salespersons?: DimOption[];
  isSalesperson?: boolean;
  /** MAX(Fact_Orders.OrderDateTime) -- the actual last confirmed Sales Order timestamp, not the
   * ETL's own refresh-completion time (that's shown separately at the bottom of the page by
   * AppSidebar/SidebarFilters/RefreshFooter as "Last Update"/"Last Refresh Time"). */
  lastUpdate?: string | null;
  /** MAX(Fact_Orders.CreatedDateTime) -- Odoo create_date (record creation), distinct from
   * lastUpdate above (date_order, the order/confirmation date). Optional so callers that haven't
   * wired refreshStatus.lastOrderCreated through yet just don't render this field. */
  lastOrderCreated?: string | null;
  dateFromDate?: string;
  dateToDate?: string;
  onDateRangeChange?: (from: string, to: string) => void;

  // ---- Materials Analogy rollout: which field GROUPS render at all, so a page whose data model
  // has none of these dimensions (Stock Velocity/PIM Contribution/Product Lifecycle -- still
  // synthetic product/inventory data, not the Sales warehouse; BCG Matrix moved to live
  // fact_bcgmatrix data, see lib/materialsAnalogy/shared.ts's header, but shares the same
  // product-grain field shape so it stays off these groups too) can turn a whole group off
  // instead of being forced to pass empty arrays/fake values into fields that would just render
  // "Locked"/"Not available" chrome that doesn't apply to it. All default to true, so every
  // existing call site (which never passes these) renders exactly as before. ----
  /** From Date / To Date. Off for Materials Analogy pages -- that dataset is a fixed YTD-vs-LYTD
   * comparison, not a slice-able date range (see lib/materialsAnalogy/shared.ts). */
  showDateRange?: boolean;
  /** Current-year-only pages (the Pipeline pages): From/To can never go earlier than Jan 1 of the
   * current year -- earlier dates are disabled in the pickers, and a range inherited from another
   * page (the date state is shared across pages) is clamped up to Jan 1 on mount. */
  ytdOnly?: boolean;
  /** Single "Date" field (bound to anchorDate/onAnchorDateChange), rendered first in the filter
   * row alongside Company/Customer Group/etc. -- for a page like Critical Number that has exactly
   * one anchor date and no real range, so the date control lives with the rest of the filters
   * instead of being an isolated control elsewhere on the page (dashboard revision pass, 2026-09).
   * Off by default; a caller turns this on instead of showDateRange, not in addition to it. */
  showSingleDate?: boolean;
  /** min/max (ISO yyyy-mm-dd) for the showSingleDate field, passed straight through to DateInput. */
  dateMin?: string;
  dateMax?: string;
  /** The built-in Company Select (numeric company_key, multi-select) -- off for Materials Analogy
   * pages, which render their own Company pill-toggle (2 values, single-select) via `extraFields`
   * instead, per that module's low-cardinality-gets-a-pill-toggle convention. */
  showCompanyDimension?: boolean;
  /** Customer Group / Distribution Channel / Branch / Salesperson / Customer -- real
   * sales-transaction dimensions that don't exist on product/inventory data. One flag for all 5
   * since they're conceptually one group (per the Materials Analogy revision's own framing). */
  showTransactionDimensions?: boolean;
  /** Customer dropdown. Only for pages whose KPIs are all sales-line based: targets and CRM pipeline
   * data have no customer grain, so on those pages a Customer selection would be silently ignored. */
  showCustomerFilter?: boolean;
  /** "Last Order Date" / "Last Order Created" -- real Odoo order timestamps; showing them next to
   * a fixed synthetic YTD/LYTD comparison would misleadingly imply a live, refreshing feed. */
  showLastOrderInfo?: boolean;
  /** Page-specific filter controls (Category Select, BCG Class pill-toggle, etc.), rendered inline
   * in the same field row as the built-in fields above -- the extension point requested instead of
   * forking a second filter-bar component. */
  extraFields?: React.ReactNode;
  /** Overrides the Reset filters button for pages whose filters are local state instead of the
   * shared FilterProvider (Materials Analogy pages); pass together with `isPristine`. */
  onReset?: () => void;
  /** True when the page's own filters already equal their defaults (disables the Reset button). */
  isPristine?: boolean;
}

const fieldBox: React.CSSProperties = { width: 152, flexShrink: 0 };

/** Matches Select/DateInput's own label styling exactly (font-size 12 + margin-bottom 4), so
 * non-field controls (Last Order info text) that have no label of their own still
 * start at the same top offset as every labeled field in the row. */
const labelSpacerStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  marginBottom: 4,
};

/**
 * Tachometer rebuild (dark-theme pass): horizontal global filter strip, replacing AppSidebar's
 * left-column layout for this page per the new mockup (filters now live in a top strip, not a
 * side panel). AppSidebar.tsx is left in place, unused, per this session's convention.
 *
 * Dashboard revision pass: collapsed by default behind a "Filters" toggle button so the default
 * view is clean; the field row below only renders while expanded. Collapse state is local to each
 * mount (not persisted/shared across pages) -- every page load starts collapsed again, matching
 * "collapsed by default" rather than remembering the last session's choice.
 *
 * Six real, backend-wired dimensions (Company, Customer Group/Segment, Distribution Channel,
 * Branch/Sales Team, Salesperson, Customer) plus the date control(s). Their option lists are
 * cross-filtered by the server (see FilterProvider / GET /filters/options), so each dropdown only
 * offers values that exist together with everything else currently selected.
 */
export function FilterBar({
  filters = {},
  onChange = () => {},
  anchorDate = '',
  onAnchorDateChange = () => {},
  businessUnits = [],
  customerGroups = [],
  distributionChannels = [],
  branches = [],
  salespersons = [],
  isSalesperson = false,
  lastUpdate = null,
  lastOrderCreated,
  dateFromDate = anchorDate,
  dateToDate = anchorDate,
  onDateRangeChange,
  showDateRange = true,
  ytdOnly = false,
  showSingleDate = false,
  dateMin,
  dateMax,
  showCompanyDimension = true,
  showTransactionDimensions = true,
  showCustomerFilter = false,
  showLastOrderInfo = true,
  extraFields,
  onReset,
  isPristine,
}: FilterBarProps) {
  // Options are cross-filtered by the server (FilterProvider owns the single /filters/options
  // request): every list below only ever holds values that are valid together with the current
  // selection. `loading` is true during any refetch, but the previous options stay on screen, so a
  // dropdown only *disables* itself when it has nothing to show yet or truly has no valid options.
  const scoped = useScopedFilterOptions();
  const { setOptionsDateMode, setCustomerFilterEnabled, resetFilters, isAtDefaults } = useFilterState();
  const handleReset = onReset ?? resetFilters;
  const resetDisabled = onReset ? (isPristine ?? false) : isAtDefaults;
  const customerEnabled = showTransactionDimensions && showCustomerFilter;
  const loading = scoped.businessUnits.loading;
  const customerOptions = (scoped.customers.data ?? []).map((o) => ({ value: String(o.customer_key), label: String(o.customer_name) }));
  const customerValue = (filters.customerKeys ?? []).map(String);

  // Which date scope narrows the option lists depends on this page's date control.
  useEffect(() => {
    setOptionsDateMode(showDateRange ? 'range' : 'anchor');
  }, [showDateRange, setOptionsDateMode]);
  useEffect(() => {
    setCustomerFilterEnabled(customerEnabled);
    return () => setCustomerFilterEnabled(false);
  }, [customerEnabled, setCustomerFilterEnabled]);

  /** Disabled/locked-reason/loading props shared by every cascading dropdown. */
  const fieldState = (optionCount: number, lockedTo?: string) => {
    if (lockedTo) return { disabled: true, lockedReason: lockedTo, loading: false };
    if (optionCount === 0) {
      return loading
        ? { disabled: true, lockedReason: 'Loading…', loading: true }
        : { disabled: true, lockedReason: 'No options', loading: false };
    }
    return { disabled: false, lockedReason: undefined, loading };
  };
  const lockedReason = isSalesperson ? 'Locked to your assigned scope' : undefined;

  // Collapsed by default so the page opens on a clean view; each page mount starts collapsed
  // again (no cross-page persistence needed -- "collapsed by default" per the revision request).
  const [isOpen, setIsOpen] = useState(false);

  const activeFilterCount =
    (showCompanyDimension ? (filters.companyKeys?.length ?? 0) : 0) +
    (showTransactionDimensions ? (filters.segmentKeys?.length ?? 0) : 0) +
    (showTransactionDimensions ? (filters.channelKeys?.length ?? 0) : 0) +
    (showTransactionDimensions ? (filters.salesTeamKeys?.length ?? 0) : 0) +
    (showTransactionDimensions ? (filters.salespersonKeys?.length ?? 0) : 0) +
    (customerEnabled ? customerValue.length : 0);

  const floorDate = (date: string) => (ytdOnly && date < ytdStartIso() ? ytdStartIso() : date);

  const handleFromDateChange = (date: string) => {
    if (onDateRangeChange) {
      onDateRangeChange(floorDate(date), dateToDate);
    }
  };

  const handleToDateChange = (date: string) => {
    if (onDateRangeChange) {
      onDateRangeChange(dateFromDate, floorDate(date));
    }
  };

  // Date state is shared across pages, so a range picked on another page may already reach back
  // before Jan 1 -- pull it up to the current year as soon as a YTD-only page mounts.
  useEffect(() => {
    if (!ytdOnly || !onDateRangeChange) return;
    if (dateFromDate < ytdStartIso() || dateToDate < ytdStartIso()) {
      onDateRangeChange(floorDate(dateFromDate), floorDate(dateToDate));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ytdOnly, dateFromDate, dateToDate]);

  return (
    <div style={{ background: 'var(--ps-color-surface)', borderBottom: '1px solid var(--ps-color-border)' }}>
      <button
        type="button"
        onClick={() => setIsOpen((o) => !o)}
        aria-expanded={isOpen}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: 'var(--ps-space-2, 8px) var(--ps-space-4, 24px)',
          color: 'var(--ps-color-text)',
        }}
      >
        <SlidersHorizontal size={14} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>Filters</span>
        {activeFilterCount > 0 && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              minWidth: 18,
              height: 18,
              padding: '0 5px',
              borderRadius: 999,
              fontSize: 11,
              fontWeight: 700,
              color: 'var(--ps-color-on-accent)',
              background: 'var(--ps-color-accent)',
            }}
          >
            {activeFilterCount}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: 'var(--ps-color-muted-text)' }}>{isOpen ? 'Hide filters' : 'Show filters'}</span>
        <ChevronDown size={14} style={{ transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s ease' }} />
      </button>

      {isOpen && (
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            flexWrap: 'wrap',
            gap: 'var(--ps-space-2, 8px)',
            padding: '0 var(--ps-space-4, 24px) var(--ps-space-3, 16px)',
          }}
        >
      {showSingleDate && (
        <div style={fieldBox}>
          <DateInput label="Date" value={anchorDate} onChange={onAnchorDateChange} min={dateMin} max={dateMax} />
        </div>
      )}

      {showDateRange && (
        <>
          <div style={fieldBox}>
            {/* max=dateToDate: the From Date picker can't be moved past the current To Date, so
                the range can never invert from this side. */}
            <DateInput label="From Date" value={dateFromDate} onChange={handleFromDateChange} min={ytdOnly ? ytdStartIso() : undefined} max={dateToDate} />
          </div>

          <div style={fieldBox}>
            {/* min=dateFromDate/max=today: the To Date picker can't go before From Date or past
                today, so the range can never invert from this side either. */}
            <DateInput label="To Date" value={dateToDate} onChange={handleToDateChange} min={dateFromDate} max={todayIso()} />
          </div>
        </>
      )}

      {showCompanyDimension && (
        <div style={fieldBox}>
          <Select
            label="Company"
            options={businessUnits.map((o) => ({ value: String(o.company_key), label: String(o.company_name) }))}
            value={(filters.companyKeys ?? []).map(String)}
            onChange={(v) => onChange({ ...filters, companyKeys: v.map(Number) })}
            multiSelect
            {...fieldState(businessUnits.length, lockedReason)}
          />
        </div>
      )}

      {showTransactionDimensions && (
        <>
          <div style={fieldBox}>
            <Select
              label="Customer Group"
              options={customerGroups.map((o) => ({ value: String(o.segment_key), label: String(o.segment_name) }))}
              value={(filters.segmentKeys ?? []).map(String)}
              onChange={(v) => onChange({ ...filters, segmentKeys: v.map(Number) })}
              multiSelect
              {...fieldState(customerGroups.length, lockedReason)}
            />
          </div>

          <div style={fieldBox}>
            <Select
              label="Distribution Channel"
              options={distributionChannels.map((o) => ({ value: String(o.channel_key), label: String(o.channel_name) }))}
              value={(filters.channelKeys ?? []).map(String)}
              onChange={(v) => onChange({ ...filters, channelKeys: v.map(Number) })}
              multiSelect
              {...fieldState(distributionChannels.length, lockedReason)}
            />
          </div>

          <div style={fieldBox}>
            <Select
              label="Branch"
              options={branches.map((o) => ({ value: String(o.sales_team_key), label: String(o.sales_team_name) }))}
              value={filters.salesTeamKeys ?? []}
              onChange={(v) => onChange({ ...filters, salesTeamKeys: v })}
              multiSelect
              searchable
              {...fieldState(branches.length, lockedReason)}
            />
          </div>

          <div style={fieldBox}>
            <Select
              label="Salesperson"
              options={salespersons.map((o) => ({ value: String(o.salesperson_key), label: String(o.salesperson_name) }))}
              value={(filters.salespersonKeys ?? []).map(String)}
              onChange={(v) => onChange({ ...filters, salespersonKeys: v.map(Number) })}
              multiSelect
              searchable
              {...fieldState(salespersons.length, isSalesperson ? 'Locked to your own record' : undefined)}
            />
          </div>

          {customerEnabled && (
          <div style={fieldBox}>
            <Select
              label="Customer"
              options={customerOptions}
              value={customerValue}
              onChange={(v) => onChange({ ...filters, customerKeys: v.map(Number) })}
              multiSelect
              searchable
              {...fieldState(customerOptions.length)}
            />
          </div>
          )}
        </>
      )}

      {extraFields}

      <div style={{ display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
        <span aria-hidden style={labelSpacerStyle}>&nbsp;</span>
        <button
          type="button"
          onClick={handleReset}
          disabled={resetDisabled}
          aria-label="Reset filters"
          title="Reset filters"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            height: 38,
            padding: '0 12px',
            borderRadius: 8,
            border: '1px solid var(--ps-color-border)',
            background: 'transparent',
            color: 'var(--ps-color-text)',
            fontSize: 13,
            fontFamily: 'inherit',
            whiteSpace: 'nowrap',
            cursor: resetDisabled ? 'not-allowed' : 'pointer',
            opacity: resetDisabled ? 0.45 : 1,
          }}
        >
          <RotateCcw size={14} aria-hidden />
          Reset filters
        </button>
      </div>

      <div style={{ flex: 1 }} />

      {showLastOrderInfo && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
          <span aria-hidden style={labelSpacerStyle}>&nbsp;</span>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              height: 38,
              fontSize: 11,
              color: 'var(--ps-color-muted-text)',
              whiteSpace: 'nowrap',
            }}
          >
            Last Order Date: {formatTimestamp(lastUpdate)}
          </div>
          {lastOrderCreated !== undefined ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                height: 16,
                fontSize: 11,
                color: 'var(--ps-color-muted-text)',
                whiteSpace: 'nowrap',
              }}
            >
              Last Order Created: {formatTimestamp(lastOrderCreated)}
            </div>
          ) : null}
        </div>
      )}
        </div>
      )}
    </div>
  );
}
