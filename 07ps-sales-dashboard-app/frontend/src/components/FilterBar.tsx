'use client';
import React from 'react';
import { RotateCcw } from 'lucide-react';
import { Select, DateInput, Button } from '@07ps/ui';
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
  lastRefreshTime: string | null;
  dateFromDate?: string;
  dateToDate?: string;
  onDateRangeChange?: (from: string, to: string) => void;
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
  lastRefreshTime,
  dateFromDate = anchorDate,
  dateToDate = anchorDate,
  onDateRangeChange,
}: FilterBarProps) {
  const lockedReason = isSalesperson ? 'Locked to your assigned scope' : undefined;

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
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        flexWrap: 'wrap',
        gap: 'var(--ps-space-2, 8px)',
        padding: 'var(--ps-space-3, 16px) var(--ps-space-4, 24px)',
        background: 'var(--ps-color-surface)',
        borderBottom: '1px solid var(--ps-color-border)',
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

      <div style={fieldBox} title="Not available in the current data model -- no Customer dimension is loaded in this warehouse.">
        <Select label="Customer" options={[]} value={[]} onChange={() => {}} disabled lockedReason="Not available yet" />
      </div>

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
          Last Refreshed: {formatTimestamp(lastRefreshTime)}
        </div>
      </div>
    </div>
  );
}
