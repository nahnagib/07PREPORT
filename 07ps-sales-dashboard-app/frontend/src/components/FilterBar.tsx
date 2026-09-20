'use client';
import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { RotateCcw, FileDown, SlidersHorizontal, ChevronDown, ArrowLeft } from 'lucide-react';
import { Select, DateInput, Button, type SelectOption } from '@07ps/ui';
import type { DimOption, TachometerFilters } from '../lib/api';
import { formatTimestamp } from '../lib/format';

/** Same UTC-based "today" FilterProvider's own default/clamp logic uses, so the To Date picker's
 * max here can never disagree with what onDateRangeChange would itself clamp it to. */
const todayIso = () => new Date().toISOString().slice(0, 10);

export interface FilterBarProps {
  /** All of the sales-transaction-shaped props below (filters/onChange/businessUnits/...) are
   * optional as of the Materials Analogy rollout -- a caller that sets the matching `show*` flag
   * to false never touches that field's props at all. Every one of the 8 original Sales-warehouse
   * pages still passes all of them explicitly, so nothing about their behavior changes; this is a
   * strictly additive extension, not a rework of the existing shape. */
  filters?: TachometerFilters;
  onChange?: (next: TachometerFilters) => void;
  onReset: () => void;
  anchorDate?: string;
  onAnchorDateChange?: (date: string) => void;
  businessUnits?: DimOption[];
  customerGroups?: DimOption[];
  distributionChannels?: DimOption[];
  branches?: DimOption[];
  salespersons?: DimOption[];
  /** Cascading Filter Bar, 2026-09: true only for the brief window a dependent dropdown's option
   * list is being re-fetched after its parent changed (see lib/hooks.ts's useFilterOptions) --
   * NOT a "parent not selected yet" gate. A dropdown always shows its full option list and stays
   * clickable at zero upstream selections; this is purely a transient loading indicator. */
  customerGroupsLoading?: boolean;
  distributionChannelsLoading?: boolean;
  branchesLoading?: boolean;
  salespersonsLoading?: boolean;
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
  /** Customer Growth-only: no other page has a Customer dimension loaded in the warehouse (see the
   * "Not available in the current data model" fallback rendered when these are omitted), so this
   * filter only becomes a real, enabled control when a caller opts in by passing all three. */
  customerOptions?: SelectOption[];
  customerValue?: string[];
  onCustomerChange?: (value: string[]) => void;
  /** Export Overview Report (backend/src/routes/reports.ts) -- optional so a page that hasn't
   * wired up useExportOverviewReport yet just doesn't render the button, rather than crashing. */
  onExportReport?: () => void;
  isExporting?: boolean;
  exportError?: string | null;

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
  /** "Last Order Date" / "Last Order Created" -- real Odoo order timestamps; showing them next to
   * a fixed synthetic YTD/LYTD comparison would misleadingly imply a live, refreshing feed. */
  showLastOrderInfo?: boolean;
  /** Page-specific filter controls (Category Select, BCG Class pill-toggle, etc.), rendered inline
   * in the same field row as the built-in fields above -- the extension point requested instead of
   * forking a second filter-bar component. */
  extraFields?: React.ReactNode;
}

const fieldBox: React.CSSProperties = { width: 152, flexShrink: 0 };

/** Matches Select/DateInput's own label styling exactly (font-size 12 + margin-bottom 4), so
 * non-field controls (Reset button, Last Refreshed text) that have no label of their own still
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
 * Same 5 real, backend-wired dimensions as AppSidebar (Company, Customer Group/Segment,
 * Distribution Channel, Branch/Sales Team, Salesperson) plus the single anchor date -- this
 * dashboard has never had a two-ended date-range filter or a Customer/Customer Status dimension
 * in its schema (only Fact_Orders/Fact_Targets/Dim_Date + the 5 dims above are loaded). The mockup
 * shows both, so rather than silently drop them or fake a working control, they're rendered here
 * as visibly disabled fields with a tooltip explaining why -- the same "disabled + honest tooltip"
 * convention already used by TopTabBar/BottomNavBar for not-yet-built pages, applied here to
 * not-yet-modeled filter dimensions instead of inventing data that doesn't exist.
 */
export function FilterBar({
  filters = {},
  onChange = () => {},
  onReset,
  anchorDate = '',
  onAnchorDateChange = () => {},
  businessUnits = [],
  customerGroups = [],
  distributionChannels = [],
  branches = [],
  salespersons = [],
  customerGroupsLoading = false,
  distributionChannelsLoading = false,
  branchesLoading = false,
  salespersonsLoading = false,
  isSalesperson = false,
  lastUpdate = null,
  lastOrderCreated,
  dateFromDate = anchorDate,
  dateToDate = anchorDate,
  onDateRangeChange,
  customerOptions,
  customerValue,
  onCustomerChange,
  onExportReport,
  isExporting = false,
  exportError = null,
  showDateRange = true,
  showSingleDate = false,
  dateMin,
  dateMax,
  showCompanyDimension = true,
  showTransactionDimensions = true,
  showLastOrderInfo = true,
  extraFields,
}: FilterBarProps) {
  const router = useRouter();
  const customerFilterEnabled = showTransactionDimensions && customerOptions != null && customerValue != null && onCustomerChange != null;
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
    (customerFilterEnabled && customerValue ? customerValue.length : 0);

  const handleFromDateChange = (date: string) => {
    if (onDateRangeChange) {
      onDateRangeChange(date, dateToDate);
    }
  };

  const handleToDateChange = (date: string) => {
    if (onDateRangeChange) {
      onDateRangeChange(dateFromDate, date);
    }
  };

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
            <DateInput label="From Date" value={dateFromDate} onChange={handleFromDateChange} max={dateToDate} />
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
            disabled={isSalesperson}
            lockedReason={lockedReason}
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
              disabled={isSalesperson || customerGroupsLoading}
              lockedReason={lockedReason ?? (customerGroupsLoading ? 'Loading…' : undefined)}
            />
          </div>

          <div style={fieldBox}>
            <Select
              label="Distribution Channel"
              options={distributionChannels.map((o) => ({ value: String(o.channel_key), label: String(o.channel_name) }))}
              value={(filters.channelKeys ?? []).map(String)}
              onChange={(v) => onChange({ ...filters, channelKeys: v.map(Number) })}
              multiSelect
              disabled={isSalesperson || distributionChannelsLoading}
              lockedReason={lockedReason ?? (distributionChannelsLoading ? 'Loading…' : undefined)}
            />
          </div>

          <div style={fieldBox}>
            <Select
              label="Branch"
              options={branches.map((o) => ({ value: String(o.sales_team_key), label: String(o.sales_team_name) }))}
              value={filters.salesTeamKeys ?? []}
              onChange={(v) => onChange({ ...filters, salesTeamKeys: v })}
              multiSelect
              disabled={isSalesperson || branchesLoading}
              lockedReason={lockedReason ?? (branchesLoading ? 'Loading…' : undefined)}
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
              disabled={isSalesperson || salespersonsLoading}
              lockedReason={isSalesperson ? 'Locked to your own record' : salespersonsLoading ? 'Loading…' : undefined}
            />
          </div>

          {customerFilterEnabled ? (
            <div style={fieldBox}>
              <Select
                label="Customer"
                options={customerOptions}
                value={customerValue}
                onChange={onCustomerChange}
                multiSelect
                searchable
              />
            </div>
          ) : (
            <div style={fieldBox} title="Not available in the current data model -- no Customer dimension is loaded in this warehouse.">
              <Select label="Customer" options={[]} value={[]} onChange={() => {}} disabled lockedReason="Not available yet" />
            </div>
          )}
        </>
      )}

      {extraFields}

      {/* Invisible label-height spacer keeps this button's top edge aligned with every field's
          input, even though it has no label of its own above it. */}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <span aria-hidden style={labelSpacerStyle}>&nbsp;</span>
        <Button
          variant="secondary"
          onClick={() => router.back()}
          style={{ height: 38, boxSizing: 'border-box', padding: '0 14px', whiteSpace: 'nowrap' }}
        >
          <ArrowLeft size={14} />
          Back
        </Button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <span aria-hidden style={labelSpacerStyle}>&nbsp;</span>
        <Button
          variant="secondary"
          onClick={onReset}
          disabled={isSalesperson}
          style={{ height: 38, boxSizing: 'border-box', padding: '0 14px', whiteSpace: 'nowrap' }}
        >
          <RotateCcw size={14} />
          Reset Filters
        </Button>
      </div>

      {onExportReport ? (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <span aria-hidden style={labelSpacerStyle}>&nbsp;</span>
          <Button
            variant="secondary"
            onClick={onExportReport}
            disabled={isExporting}
            style={{ height: 38, boxSizing: 'border-box', padding: '0 14px', whiteSpace: 'nowrap' }}
          >
            <FileDown size={14} />
            {isExporting ? 'Exporting...' : 'Export Overview Report'}
          </Button>
          {exportError ? (
            <span style={{ fontSize: 11, color: 'var(--ps-color-danger, #cf222e)', marginTop: 4, maxWidth: 220 }}>
              {exportError}
            </span>
          ) : null}
        </div>
      ) : null}

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
