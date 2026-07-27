'use client';
import React, { useState } from 'react';
import { RotateCcw, FileDown, SlidersHorizontal, ChevronDown } from 'lucide-react';
import { Select, DateInput, Button, type SelectOption } from '@07ps/ui';
import type { DimOption, TachometerFilters } from '../lib/api';
import { formatTimestamp } from '../lib/format';

export interface FilterBarProps {
  filters: TachometerFilters;
  onChange: (next: TachometerFilters) => void;
  onReset: () => void;
  anchorDate: string;
  onAnchorDateChange: (date: string) => void;
  businessUnits: DimOption[];
  customerGroups: DimOption[];
  distributionChannels: DimOption[];
  branches: DimOption[];
  salespersons: DimOption[];
  isSalesperson: boolean;
  /** MAX(Fact_Orders.OrderDateTime) -- the actual last confirmed Sales Order timestamp, not the
   * ETL's own refresh-completion time (that's shown separately at the bottom of the page by
   * AppSidebar/SidebarFilters/RefreshFooter as "Last Update"/"Last Refresh Time"). */
  lastUpdate: string | null;
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
  filters,
  onChange,
  onReset,
  anchorDate,
  onAnchorDateChange,
  businessUnits,
  customerGroups,
  distributionChannels,
  branches,
  salespersons,
  isSalesperson,
  lastUpdate,
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
}: FilterBarProps) {
  const customerFilterEnabled = customerOptions != null && customerValue != null && onCustomerChange != null;
  const lockedReason = isSalesperson ? 'Locked to your assigned scope' : undefined;

  // Collapsed by default so the page opens on a clean view; each page mount starts collapsed
  // again (no cross-page persistence needed -- "collapsed by default" per the revision request).
  const [isOpen, setIsOpen] = useState(false);

  const activeFilterCount =
    (filters.companyKeys?.length ?? 0) +
    (filters.segmentKeys?.length ?? 0) +
    (filters.channelKeys?.length ?? 0) +
    (filters.salesTeamKeys?.length ?? 0) +
    (filters.salespersonKeys?.length ?? 0) +
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
      <div style={fieldBox}>
        <DateInput label="From Date" value={dateFromDate} onChange={handleFromDateChange} />
      </div>

      <div style={fieldBox}>
        <DateInput label="To Date" value={dateToDate} onChange={handleToDateChange} />
      </div>

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

      <div style={fieldBox}>
        <Select
          label="Customer Group"
          options={customerGroups.map((o) => ({ value: String(o.segment_key), label: String(o.segment_name) }))}
          value={(filters.segmentKeys ?? []).map(String)}
          onChange={(v) => onChange({ ...filters, segmentKeys: v.map(Number) })}
          multiSelect
          disabled={isSalesperson}
          lockedReason={lockedReason}
        />
      </div>

      <div style={fieldBox}>
        <Select
          label="Distribution Channel"
          options={distributionChannels.map((o) => ({ value: String(o.channel_key), label: String(o.channel_name) }))}
          value={(filters.channelKeys ?? []).map(String)}
          onChange={(v) => onChange({ ...filters, channelKeys: v.map(Number) })}
          multiSelect
          disabled={isSalesperson}
          lockedReason={lockedReason}
        />
      </div>

      <div style={fieldBox}>
        <Select
          label="Branch"
          options={branches.map((o) => ({ value: String(o.sales_team_key), label: String(o.sales_team_name) }))}
          value={filters.salesTeamKeys ?? []}
          onChange={(v) => onChange({ ...filters, salesTeamKeys: v })}
          multiSelect
          disabled={isSalesperson}
          lockedReason={lockedReason}
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
          disabled={isSalesperson}
          lockedReason={isSalesperson ? 'Locked to your own record' : undefined}
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

      {/* Invisible label-height spacer keeps this button's top edge aligned with every field's
          input, even though it has no label of its own above it. */}
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
        </div>
      )}
    </div>
  );
}
