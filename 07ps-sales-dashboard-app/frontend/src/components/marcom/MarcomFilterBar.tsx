'use client';
import React from 'react';
import { MarcomFilters, PAGE_CONTROLS, isDefaultFilters } from '../../lib/marcom/filters';
import { monthName } from '../../lib/marcom/format';
import { t } from '../../lib/marcom/text';
import type { Options, PageKey } from '../../lib/marcom/types';
import { GHOST_BTN } from './MarcomChartCard';

export interface MarcomFilterBarProps {
  page: PageKey;
  filters: MarcomFilters;
  options: Options;
  /** What the API actually applied (its defaults fill whatever the user left unset). */
  applied: { year: number; fromMonth: number; toMonth: number };
  refreshing?: boolean;
  onChange: (next: MarcomFilters) => void;
  onReset: () => void;
}

const field: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11, color: 'var(--ps-color-muted-text)', textTransform: 'uppercase', letterSpacing: 0.4 };
const control: React.CSSProperties = { fontSize: 13, padding: '5px 8px', borderRadius: 6, border: '1px solid var(--ps-color-border)', background: 'var(--ps-color-surface)', color: 'var(--ps-color-text)', minWidth: 96, textTransform: 'none', letterSpacing: 0 };

/** Checkbox dropdown built on <details>: keyboard-operable with no extra JS. */
function MultiSelect({ label, options, selected, onChange }: { label: string; options: { value: string; label: string }[]; selected: string[]; onChange: (next: string[]) => void }) {
  const summary = selected.length === 0 ? t('filter.all') : selected.length === 1 ? (options.find((o) => o.value === selected[0])?.label ?? selected[0]) : t('filter.selected', { n: selected.length });
  return (
    <div style={field}>
      <span id={`ms-${label}`}>{label}</span>
      <details style={{ position: 'relative' }} data-testid={`filter-${label}`}>
        <summary aria-labelledby={`ms-${label}`} style={{ ...control, cursor: 'pointer', listStyle: 'none', display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <span>{summary}</span><span aria-hidden="true">▾</span>
        </summary>
        <div role="group" aria-label={label} style={{ position: 'absolute', zIndex: 20, insetInlineStart: 0, marginTop: 4, minWidth: 190, maxHeight: 260, overflow: 'auto', background: 'var(--ps-color-surface)', border: '1px solid var(--ps-color-border)', borderRadius: 8, boxShadow: 'var(--ps-card-shadow)', padding: 6, textTransform: 'none', letterSpacing: 0, fontSize: 13, color: 'var(--ps-color-text)' }}>
          {options.map((o) => (
            <label key={o.value} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 6px', cursor: 'pointer' }}>
              <input
                type="checkbox" checked={selected.includes(o.value)}
                onChange={(e) => onChange(e.target.checked ? [...selected, o.value] : selected.filter((v) => v !== o.value))}
              />
              {o.label}
            </label>
          ))}
        </div>
      </details>
    </div>
  );
}

export function MarcomFilterBar({ page, filters, options, applied, refreshing, onChange, onReset }: MarcomFilterBarProps) {
  const c = PAGE_CONTROLS[page];
  const year = filters.year ?? applied.year;
  const from = filters.fromMonth ?? applied.fromMonth;
  const to = filters.toMonth ?? applied.toMonth;
  const years = options.years.includes(year) ? options.years : [...options.years, year].sort((a, b) => a - b);

  return (
    <form
      role="search" aria-label={t('filter.bar')} data-testid="marcom-filters"
      onSubmit={(e) => e.preventDefault()}
      style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', padding: '10px 12px', background: 'var(--ps-color-surface)', border: '1px solid var(--ps-color-border)', borderRadius: 10 }}
    >
      <label style={field}>
        {t('filter.year')}
        <select style={control} value={year} onChange={(e) => onChange({ ...filters, year: Number(e.target.value), fromMonth: undefined, toMonth: undefined })}>
          {[...years].sort((a, b) => b - a).map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
      </label>

      {c.months && (
        <>
          <label style={field}>
            {t('filter.from')}
            <select style={control} value={from} onChange={(e) => { const m = Number(e.target.value); onChange({ ...filters, fromMonth: m, toMonth: Math.max(to, m) }); }}>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>{monthName(m, 'long')}</option>)}
            </select>
          </label>
          <label style={field}>
            {t('filter.to')}
            <select style={control} value={to} onChange={(e) => { const m = Number(e.target.value); onChange({ ...filters, toMonth: m, fromMonth: Math.min(from, m) }); }}>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>{monthName(m, 'long')}</option>)}
            </select>
          </label>
        </>
      )}

      {c.brand && (
        <MultiSelect
          label={t('filter.brand')}
          options={options.brands.map((b) => ({ value: String(b.id), label: b.name }))}
          selected={filters.brandIds.map(String)}
          onChange={(v) => onChange({ ...filters, brandIds: v.map(Number) })}
        />
      )}
      {c.platform && (
        <MultiSelect
          label={t('filter.platform')}
          options={(options.platforms ?? []).map((p) => ({ value: p, label: p }))}
          selected={filters.platforms}
          onChange={(v) => onChange({ ...filters, platforms: v })}
        />
      )}
      {c.status && (
        <MultiSelect
          label={t('filter.status')}
          options={(options.statuses ?? []).map((s) => ({ value: s, label: s }))}
          selected={filters.statuses}
          onChange={(v) => onChange({ ...filters, statuses: v })}
        />
      )}

      <button type="button" onClick={onReset} disabled={isDefaultFilters(filters)} style={{ ...GHOST_BTN, opacity: isDefaultFilters(filters) ? 0.5 : 1, cursor: isDefaultFilters(filters) ? 'not-allowed' : 'pointer' }}>
        {t('filter.reset')}
      </button>
      {refreshing && <span role="status" style={{ fontSize: 12, color: 'var(--ps-color-muted-text)' }}>{t('filter.refreshing')}</span>}
    </form>
  );
}
