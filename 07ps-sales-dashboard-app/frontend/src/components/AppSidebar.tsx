'use client';
import React, { useMemo } from 'react';
import { RotateCcw } from 'lucide-react';
import { Select, DateInput, CollapsibleSection, FilterChip } from '@07ps/ui';
import type { DimOption, TachometerFilters } from '../lib/api';
import { formatTimestamp } from '../lib/format';

export interface AppSidebarProps {
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
 * Complete UI Redesign pass: modernized replacement for SidebarFilters.tsx. Same data contract,
 * same Standards Section 3.4/3.15-3.17 responsive behavior (desktop full sidebar, tablet
 * icon-only/expandable, mobile bottom-sheet), same salesperson-lock visual mirror (Section 4.10/
 * 5.2, server-side enforcement is the real lock -- this is purely so a locked user isn't confused
 * by controls that look editable) -- what's new is presentation:
 *   - Each filter group is now a CollapsibleSection, so a dense sidebar with 6 groups doesn't force
 *     one long unbroken scroll
 *   - An "active filters" chip row up top (FilterChip, removable) gives an at-a-glance summary of
 *     what's currently filtered without opening every group
 *   - A single, more prominent "Reset All" action, replacing the old two-buttons-doing-the-same-
 *     thing ("Clear all" link + "Reset filters" button)
 *
 * SidebarFilters.tsx is left in place, unused, per this session's convention of not deleting
 * superseded components.
 */
export function AppSidebar({
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
}: AppSidebarProps) {
  const lockedReason = isSalesperson ? 'Locked to your assigned scope' : undefined;

  const asideClassName = [
    'ps-sidebar',
    tabletExpanded ? 'ps-sidebar-expanded' : '',
    mobileOpen ? 'ps-sidebar-open' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const activeChips = useMemo(() => {
    const chips: { key: keyof TachometerFilters; value: string; label: string }[] = [];
    (filters.companyKeys ?? []).forEach((key) => {
      const found = businessUnits.find((o) => o.company_key === key);
      chips.push({ key: 'companyKeys', value: String(key), label: String(found?.company_name ?? key) });
    });
    (filters.segmentKeys ?? []).forEach((key) => {
      const found = customerGroups.find((o) => o.segment_key === key);
      chips.push({ key: 'segmentKeys', value: String(key), label: String(found?.segment_name ?? key) });
    });
    (filters.channelKeys ?? []).forEach((key) => {
      const found = distributionChannels.find((o) => o.channel_key === key);
      chips.push({ key: 'channelKeys', value: String(key), label: String(found?.channel_name ?? key) });
    });
    (filters.salesTeamKeys ?? []).forEach((key) => {
      const found = branches.find((o) => o.sales_team_key === key);
      chips.push({ key: 'salesTeamKeys', value: key, label: String(found?.sales_team_name ?? key) });
    });
    (filters.salespersonKeys ?? []).forEach((key) => {
      const found = salespersons.find((o) => o.salesperson_key === key);
      chips.push({ key: 'salespersonKeys', value: String(key), label: String(found?.salesperson_name ?? key) });
    });
    return chips;
  }, [filters, businessUnits, customerGroups, distributionChannels, branches, salespersons]);

  const removeChip = (key: keyof TachometerFilters, value: string) => {
    if (isSalesperson) return;
    const current = (filters[key] as Array<string | number>) ?? [];
    onChange({ ...filters, [key]: current.filter((v) => String(v) !== value) });
  };

  return (
    <>
      {mobileOpen && <div className="ps-mobile-filter-scrim" onClick={onCloseMobile} aria-hidden />}
      <aside
        className={asideClassName}
        style={{
          width: 272,
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

        <div className="ps-sidebar-full" style={{ padding: 'var(--ps-space-3, 16px)', overflowY: 'auto', flex: 1 }}>
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

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 'var(--ps-space-2, 8px)',
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
                border: '1px solid var(--ps-color-border)',
                borderRadius: 6,
                padding: '3px 8px',
                background: 'var(--ps-color-muted-bg)',
                color: isSalesperson ? 'var(--ps-color-muted-text)' : 'var(--ps-color-text)',
                fontSize: 11.5,
                fontWeight: 600,
                cursor: isSalesperson ? 'not-allowed' : 'pointer',
              }}
            >
              <RotateCcw size={11} />
              Reset All
            </button>
          </div>

          {/* Active-filter chip row - at-a-glance summary of what's currently filtered. */}
          {activeChips.length > 0 && (
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 6,
                marginBottom: 'var(--ps-space-3, 16px)',
              }}
            >
              {activeChips.map((c) => (
                <FilterChip
                  key={`${c.key}-${c.value}`}
                  label={c.label}
                  onRemove={isSalesperson ? undefined : () => removeChip(c.key, c.value)}
                />
              ))}
            </div>
          )}

          <CollapsibleSection title="Business Unit">
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
          </CollapsibleSection>

          <CollapsibleSection title="Customer Group">
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
          </CollapsibleSection>

          <CollapsibleSection title="Distribution Channel">
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
          </CollapsibleSection>

          <CollapsibleSection title="Branch">
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
          </CollapsibleSection>

          <CollapsibleSection title="Sales Person">
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
          </CollapsibleSection>

          <CollapsibleSection title="Date">
            <DateInput
              label="Specific Date"
              value={anchorDate}
              onChange={onAnchorDateChange}
              helperText="Drives MTD (month start → this date) and YTD (year start → this date) for every KPI."
            />
          </CollapsibleSection>
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
