'use client';
import React, { useState } from 'react';
import { ChevronDown, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { MonthInput, Select, formatMonthEdge } from '@07ps/ui';
import { MarcomFilters, PAGE_CONTROLS, brandsForCompanies, isDefaultFilters, withCompanies } from '../../lib/marcom/filters';
import { t } from '../../lib/marcom/text';
import type { Options, PageKey } from '../../lib/marcom/types';

export interface MarcomFilterBarProps {
  page: PageKey;
  filters: MarcomFilters;
  options: Options;
  /** What the API actually applied (its defaults fill whatever the user left unset). */
  applied: { year: number; fromMonth: number; toMonth: number };
  /** Latest uploaded month (freshness): months after it have no data and are locked in the calendars. */
  latest?: { year: number; month: number } | null;
  refreshing?: boolean;
  /** Start expanded (tests); the other report pages' bar starts collapsed. */
  defaultOpen?: boolean;
  onChange: (next: MarcomFilters) => void;
  onReset: () => void;
}

/** Same field width and label spacing as the shared FilterBar on the sales pages. */
const fieldBox: React.CSSProperties = { width: 152, flexShrink: 0 };
const labelSpacerStyle: React.CSSProperties = { display: 'block', fontSize: 12, marginBottom: 4 };

/**
 * MARCOM filter bar, built to the same structure as the shared FilterBar of the other report pages:
 * collapsible "Filters" header with the active-filter count, @07ps/ui Select dropdowns, the same
 * Reset filters button -- and From Date / To Date calendars whose DAY is locked (MARCOM data is
 * monthly: From is always the 1st, To the month's last day). From and To stay in one year (the
 * API's YTD vs LYTD model is per year); the year comes from the From calendar.
 */
export function MarcomFilterBar({ page, filters, options, applied, latest, refreshing, defaultOpen = false, onChange, onReset }: MarcomFilterBarProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const c = PAGE_CONTROLS[page];
  const year = filters.year ?? applied.year;
  const from = filters.fromMonth ?? applied.fromMonth;
  const to = filters.toMonth ?? applied.toMonth;

  const yearsWithData = options.years.length ? options.years : [year];
  const minYear = Math.min(...yearsWithData, year);
  const maxYear = Math.max(...yearsWithData, year);
  /** No data after the latest uploaded month (the campaigns page keeps future months: campaigns are planned ahead). */
  const afterLatest = (y: number, m: number) => !c.futureMonths && !!latest && (y > latest.year || (y === latest.year && m > latest.month));
  const lastMonthOf = (y: number) => (!c.futureMonths && latest && y === latest.year ? latest.month : 12);

  const onFrom = (y: number, m: number) => {
    // Moving to another year moves To into it too (latest month with data there); otherwise To never precedes From.
    const nextTo = y !== year ? lastMonthOf(y) : Math.max(to, m);
    onChange({ ...filters, year: y, fromMonth: m, toMonth: Math.max(m, nextTo) });
  };
  const onTo = (_y: number, m: number) => onChange({ ...filters, year, fromMonth: from, toMonth: m });

  const companies = options.companies ?? [];
  const brandOptions = brandsForCompanies(options.brands, filters.companyKeys);

  const activeCount =
    (c.company ? filters.companyKeys.length : 0) +
    (c.brand ? filters.brandIds.length : 0) +
    (c.platform ? filters.platforms.length : 0) +
    (c.status ? filters.statuses.length : 0);
  const resetDisabled = isDefaultFilters(filters);

  return (
    <div
      role="search" aria-label={t('filter.bar')} data-testid="marcom-filters"
      style={{ background: 'var(--ps-color-surface)', border: '1px solid var(--ps-color-border)', borderRadius: 10 }}
    >
      <button
        type="button" onClick={() => setIsOpen((o) => !o)} aria-expanded={isOpen} data-testid="filters-toggle"
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', cursor: 'pointer', padding: '8px 16px', color: 'var(--ps-color-text)', fontFamily: 'inherit' }}
      >
        <SlidersHorizontal size={14} aria-hidden />
        <span style={{ fontSize: 13, fontWeight: 600 }}>Filters</span>
        {activeCount > 0 && (
          <span data-testid="filters-count" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 18, height: 18, padding: '0 5px', borderRadius: 999, fontSize: 11, fontWeight: 700, color: 'var(--ps-color-on-accent)', background: 'var(--ps-color-accent)' }}>
            {activeCount}
          </span>
        )}
        {c.months && (
          <span style={{ fontSize: 12, color: 'var(--ps-color-muted-text)', marginInlineStart: 6, fontVariantNumeric: 'tabular-nums' }} data-testid="filters-period">
            {formatMonthEdge(year, from, 'start')} – {formatMonthEdge(year, to, 'end')}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {refreshing && <span role="status" style={{ fontSize: 12, color: 'var(--ps-color-muted-text)' }}>{t('filter.refreshing')}</span>}
        <span style={{ fontSize: 11, color: 'var(--ps-color-muted-text)' }}>{isOpen ? 'Hide filters' : 'Show filters'}</span>
        <ChevronDown size={14} aria-hidden style={{ transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s ease' }} />
      </button>

      {isOpen && (
        <div style={{ display: 'flex', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8, padding: '0 16px 4px' }}>
          {c.months && (
            <>
              <div style={fieldBox}>
                <MonthInput
                  label={t('filter.fromDate')} edge="start" year={year} month={from} minYear={minYear} maxYear={maxYear}
                  isMonthDisabled={afterLatest} onChange={onFrom}
                />
              </div>
              <div style={fieldBox}>
                <MonthInput
                  label={t('filter.toDate')} edge="end" year={year} month={to} minYear={year} maxYear={year} lockYear
                  isMonthDisabled={(y, m) => m < from || afterLatest(y, m)} onChange={onTo}
                />
              </div>
            </>
          )}

          {c.company && (
            <div style={fieldBox} data-testid="filter-company">
              <Select
                label={t('filter.company')}
                options={companies.map((o) => ({ value: String(o.key), label: o.name }))}
                value={filters.companyKeys.map(String)}
                onChange={(v) => onChange(withCompanies(filters, v.map(Number), options.brands))}
                multiSelect
                disabled={companies.length === 0}
                lockedReason={companies.length === 0 ? t('filter.noCompanies') : undefined}
              />
            </div>
          )}
          {c.brand && (
            <div style={fieldBox} data-testid="filter-brand">
              <Select
                label={t('filter.brand')}
                options={brandOptions.map((b) => ({ value: String(b.id), label: b.name }))}
                value={filters.brandIds.map(String)}
                onChange={(v) => onChange({ ...filters, brandIds: v.map(Number) })}
                multiSelect searchable
                disabled={brandOptions.length === 0}
                lockedReason={brandOptions.length === 0 ? t('filter.noBrands') : undefined}
              />
            </div>
          )}
          {c.platform && (
            <div style={fieldBox} data-testid="filter-platform">
              <Select
                label={t('filter.platform')}
                options={(options.platforms ?? []).map((p) => ({ value: p, label: p }))}
                value={filters.platforms}
                onChange={(v) => onChange({ ...filters, platforms: v })}
                multiSelect
              />
            </div>
          )}
          {c.status && (
            <div style={fieldBox} data-testid="filter-status">
              <Select
                label={t('filter.status')}
                options={(options.statuses ?? []).map((s) => ({ value: s, label: s }))}
                value={filters.statuses}
                onChange={(v) => onChange({ ...filters, statuses: v })}
                multiSelect
              />
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
            <span aria-hidden style={labelSpacerStyle}>&nbsp;</span>
            <button
              type="button" onClick={onReset} disabled={resetDisabled} aria-label="Reset filters" title="Reset filters"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, height: 38, padding: '0 12px', borderRadius: 8,
                border: '1px solid var(--ps-color-border)', background: 'transparent', color: 'var(--ps-color-text)',
                fontSize: 13, fontFamily: 'inherit', whiteSpace: 'nowrap',
                cursor: resetDisabled ? 'not-allowed' : 'pointer', opacity: resetDisabled ? 0.45 : 1,
              }}
            >
              <RotateCcw size={14} aria-hidden />
              {t('filter.reset')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
