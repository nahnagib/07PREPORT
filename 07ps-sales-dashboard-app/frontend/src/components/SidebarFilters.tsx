'use client';
import React from 'react';
import { RotateCcw } from 'lucide-react';
import { Select, DateInput } from '@07ps/ui';
import type { DimOption, TachometerFilters } from '../lib/api';
import { formatTimestamp } from '../lib/format';

export interface SidebarFiltersProps {
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
  lastUpdate: string | null;
  lastRefreshTime: string | null;
  /** Tablet (768-1279px): sidebar defaults to icon-only; tapping expands it (Section 3.17). */
  tabletExpanded?: boolean;
  onToggleTabletExpanded?: () => void;
  /** Mobile (<768px): sidebar becomes a bottom-sheet/drawer (Section 3.16), opened from the header. */
  mobileOpen?: boolean;
  onCloseMobile?: () => void;
}

/**
 * Standards Section 3.4 (Sidebar behavior) + Section 4 (Filter Standards) + Section 3.15-3.17
 * (Responsive Behavior: desktop full sidebar, tablet icon-only/expandable, mobile bottom-sheet).
 *
 * Fixed order: Business Unit -> Customer Group -> Distribution Channel -> Branch -> Sales Person
 * -> Specific Date. No POS filter (confirmed unused in the real data -- see
 * data/ingestion/tachometer_kpi_validation.md; a working-but-empty filter is worse than an absent
 * one, per the explicit instruction not to build it).
 *
 * Correction vs. the earlier foundation-shell demo: the manual's "Specific Date From/To" is not
 * two independent date inputs -- it is ONE selected date driving both the MTD window (start of
 * that month -> selected date) and the YTD window (start of that year -> selected date), exactly
 * as data/warehouse/measures/filters.py's mtdWindow/ytdWindow implement it. A two-input date-range
 * picker here would imply a control the backend has no matching parameter for.
 *
 * Design-quality pass: every filter here now uses the styled Select/DateInput components from
 * @07ps/ui instead of native <select>/<input type=date> (which is what Screenshot A showed as
 * unstyled browser chrome) - built once in the shared library, not inline on this page.
 *
 * Salesperson lock (Section 4.10/5.2): when isSalesperson is true, every filter except Sales
 * Person is rendered disabled/greyed-out (not hidden), and Sales Person shows only the signed-in
 * salesperson, pre-selected and not editable -- this is a *visual* mirror of the same lock already
 * enforced server-side by applySalespersonLock (backend/src/measures/filters.ts); the UI lock
 * alone would never be sufficient (Section 5.2), so this exists purely so a locked user isn't
 * confused by controls that look editable but silently have no effect.
 */
export function SidebarFilters({
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
  lastRefreshTime,
  tabletExpanded,
  onToggleTabletExpanded,
  mobileOpen,
  onCloseMobile,
}: SidebarFiltersProps) {
  const lockedReason = isSalesperson ? 'Locked to your assigned scope' : undefined;

  const asideClassName = [
    'ps-sidebar',
    tabletExpanded ? 'ps-sidebar-expanded' : '',
    mobileOpen ? 'ps-sidebar-open' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <>
      {mobileOpen && <div className="ps-mobile-filter-scrim" onClick={onCloseMobile} aria-hidden />}
      <aside
        className={asideClassName}
        style={{
          width: 260,
          flexShrink: 0,
          borderRight: '1px solid var(--ps-color-border)',
          background: 'var(--ps-color-surface)',
          display: 'flex',
          flexDirection: 'column',
          height: 'calc(100vh - 64px)',
          position: 'sticky',
          top: 64,
        }}
      >
        {/* Icon-only affordance shown on tablet when collapsed - Section 3.17. */}
        {onToggleTabletExpanded && (
          <button
            onClick={onToggleTabletExpanded}
            aria-label={tabletExpanded ? 'Collapse filters' : 'Expand filters'}
            style={{
              border: 'none',
              background: 'transparent',
              color: 'var(--ps-color-text)',
              fontSize: 18,
              padding: 12,
              textAlign: 'left',
              cursor: 'pointer',
            }}
          >
            ☰
          </button>
        )}

        <div className="ps-sidebar-full" style={{ padding: 16, overflowY: 'auto', flex: 1 }}>
          {onCloseMobile && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
              <button
                onClick={onCloseMobile}
                aria-label="Close filters"
                style={{ border: 'none', background: 'transparent', fontSize: 18, cursor: 'pointer' }}
              >
                ✕
              </button>
            </div>
          )}
          {/* Modernization pass: quick "Clear all" next to the heading, in addition to the existing
              full-width Reset button lower down - a faster reach for anyone who just wants to
              clear everything without scrolling to the bottom of a long filter panel. */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 12,
            }}
          >
            <strong style={{ fontSize: 13 }}>Filters</strong>
            <button
              onClick={onReset}
              disabled={isSalesperson}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                border: 'none',
                background: 'transparent',
                color: isSalesperson ? 'var(--ps-color-muted-text)' : 'var(--ps-color-accent)',
                fontSize: 12,
                fontWeight: 600,
                cursor: isSalesperson ? 'not-allowed' : 'pointer',
              }}
            >
              <RotateCcw size={12} />
              Clear all
            </button>
          </div>

          <Select
            label="Business Unit / Company"
            options={businessUnits.map((o) => ({
              value: String(o.company_key),
              label: String(o.company_name),
            }))}
            value={(filters.companyKeys ?? []).map(String)}
            onChange={(v) => onChange({ ...filters, companyKeys: v.map(Number) })}
            multiSelect
            disabled={isSalesperson}
            lockedReason={lockedReason}
          />
          <Select
            label="Customer Group"
            options={customerGroups.map((o) => ({
              value: String(o.segment_key),
              label: String(o.segment_name),
            }))}
            value={(filters.segmentKeys ?? []).map(String)}
            onChange={(v) => onChange({ ...filters, segmentKeys: v.map(Number) })}
            multiSelect
            disabled={isSalesperson}
            lockedReason={lockedReason}
          />
          <Select
            label="Distribution Channel"
            options={distributionChannels.map((o) => ({
              value: String(o.channel_key),
              label: String(o.channel_name),
            }))}
            value={(filters.channelKeys ?? []).map(String)}
            onChange={(v) => onChange({ ...filters, channelKeys: v.map(Number) })}
            multiSelect
            disabled={isSalesperson}
            lockedReason={lockedReason}
          />
          <Select
            label="Branch"
            options={branches.map((o) => ({
              value: String(o.sales_team_key),
              label: String(o.sales_team_name),
            }))}
            value={filters.salesTeamKeys ?? []}
            onChange={(v) => onChange({ ...filters, salesTeamKeys: v })}
            multiSelect
            disabled={isSalesperson}
            lockedReason={lockedReason}
          />
          <Select
            label="Sales Person"
            options={salespersons.map((o) => ({
              value: String(o.salesperson_key),
              label: String(o.salesperson_name),
            }))}
            value={(filters.salespersonKeys ?? []).map(String)}
            onChange={(v) => onChange({ ...filters, salespersonKeys: v.map(Number) })}
            multiSelect
            searchable
            disabled={isSalesperson}
            lockedReason={isSalesperson ? 'Locked to your own record' : undefined}
          />

          <DateInput
            label="Specific Date"
            value={anchorDate}
            onChange={onAnchorDateChange}
            helperText="Drives MTD (month start → this date) and YTD (year start → this date) for every KPI."
          />

          <button
            onClick={onReset}
            style={{
              width: '100%',
              padding: '6px 0',
              borderRadius: 6,
              border: '1px solid var(--ps-color-border)',
              background: 'transparent',
              color: 'var(--ps-color-text)',
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            Reset filters
          </button>
        </div>

        {/* Section 3.4: sticky footer inside sidebar always shows Last Update / Last Refresh Time */}
        <div
          className="ps-sidebar-full"
          style={{
            padding: 12,
            borderTop: '1px solid var(--ps-color-border)',
            fontSize: 11,
            color: 'var(--ps-color-muted-text)',
          }}
        >
          <div>Last Update: {formatTimestamp(lastUpdate)}</div>
          <div>Last Refresh Time: {formatTimestamp(lastRefreshTime)}</div>
        </div>
      </aside>
    </>
  );
}
