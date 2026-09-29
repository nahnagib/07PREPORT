'use client';
import React from 'react';
import { RotateCcw } from 'lucide-react';
import { DateField } from '@07ps/ui';
import { kt as t, type KaizenTextKey } from '../../lib/kaizen/text';
import type { KaizenFilters, KaizenListKey } from '../../lib/kaizen/api';
import type { useKaizenOptions } from './useKaizenOptions';

type Options = ReturnType<typeof useKaizenOptions>;

/**
 * Filters for the Kaizen pages. The dashboard shows the date range only; the card lists add
 * Department, Type, Priority, Status, search and "overdue only". Dates show as "01 Jan 2026" and
 * open the browser's calendar. Single-value selects map onto the API's id lists. "Reset filters"
 * returns to `defaults` (the page's default date range), not to an empty filter.
 */
export function KaizenFilterBar({
  filters,
  onChange,
  options,
  full = false,
  showDepartment = true,
  defaults = {},
}: {
  filters: KaizenFilters;
  onChange: (next: KaizenFilters) => void;
  options: Options;
  full?: boolean;
  showDepartment?: boolean;
  defaults?: KaizenFilters;
}) {
  const set = (patch: Partial<KaizenFilters>) => onChange({ ...filters, ...patch });

  const listSelect = (key: KaizenListKey, field: 'departmentIds' | 'typeIds' | 'priorityIds', labelKey: KaizenTextKey, allKey: KaizenTextKey) => (
    <label className="ps-kaizen-field" style={{ minWidth: 150 }}>
      <span>{t(labelKey)}</span>
      <select
        className="ps-kaizen-input"
        value={filters[field]?.[0] ?? ''}
        onChange={(e) => set({ [field]: e.target.value ? [Number(e.target.value)] : [] })}
      >
        <option value="">{t(allKey)}</option>
        {options.listValues(key).map((d) => (
          <option key={d.value_id} value={d.value_id}>
            {d.label}
            {d.is_active ? '' : ` (${t('kaizen.inactive')})`}
          </option>
        ))}
      </select>
    </label>
  );

  // Filters that only come from a chart click (submitter, responsible party) show as removable chips.
  const chips: { label: string; clear: Partial<KaizenFilters> }[] = [];
  if (filters.creator) chips.push({ label: `${t('kaizen.filter.creator')}: ${filters.creator}`, clear: { creator: undefined } });
  if (filters.responsibleParty !== undefined) {
    chips.push({ label: `${t('kaizen.f.responsible')}: ${filters.responsibleParty || t('kaizen.notAssigned')}`, clear: { responsibleParty: undefined } });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="ps-kaizen-filters">
        <label className="ps-kaizen-field">
          <span>{t('kaizen.filter.from')}</span>
          <DateField className="ps-kaizen-input" aria-label={t('kaizen.filter.from')} placeholder={t('kaizen.filter.anyDate')} clearable value={filters.dateFrom ?? ''} max={filters.dateTo || undefined} onChange={(v) => set({ dateFrom: v || undefined })} />
        </label>
        <label className="ps-kaizen-field">
          <span>{t('kaizen.filter.to')}</span>
          <DateField className="ps-kaizen-input" aria-label={t('kaizen.filter.to')} placeholder={t('kaizen.filter.anyDate')} clearable value={filters.dateTo ?? ''} min={filters.dateFrom || undefined} onChange={(v) => set({ dateTo: v || undefined })} />
        </label>
        {showDepartment && listSelect('department', 'departmentIds', 'kaizen.f.department', 'kaizen.filter.allDepartments')}
        {full && listSelect('card_type', 'typeIds', 'kaizen.f.type', 'kaizen.filter.all')}
        {full && listSelect('card_priority', 'priorityIds', 'kaizen.f.priority', 'kaizen.filter.all')}
        {full && (
          <label className="ps-kaizen-field" style={{ minWidth: 130 }}>
            <span>{t('kaizen.f.status')}</span>
            <select className="ps-kaizen-input" value={filters.status ?? ''} onChange={(e) => set({ status: e.target.value as KaizenFilters['status'] })}>
              <option value="">{t('kaizen.filter.all')}</option>
              <option value="OPEN">{t('kaizen.status.OPEN')}</option>
              <option value="CLOSED">{t('kaizen.status.CLOSED')}</option>
            </select>
          </label>
        )}
        {full && (
          <label className="ps-kaizen-field" style={{ flex: '1 1 220px' }}>
            <span>&nbsp;</span>
            <input
              className="ps-kaizen-input"
              type="search"
              placeholder={t('kaizen.filter.search')}
              aria-label={t('kaizen.filter.search')}
              value={filters.search ?? ''}
              onChange={(e) => set({ search: e.target.value || undefined })}
            />
          </label>
        )}
        {full && (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, minHeight: 36 }}>
            <input type="checkbox" checked={Boolean(filters.overdue)} onChange={(e) => set({ overdue: e.target.checked || undefined })} />
            {t('kaizen.filter.overdueOnly')}
          </label>
        )}
        <button
          type="button"
          onClick={() => onChange({ ...defaults })}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            minHeight: 36,
            padding: '0 12px',
            borderRadius: 8,
            border: '1px solid var(--ps-color-border)',
            background: 'transparent',
            color: 'var(--ps-color-muted-text)',
            cursor: 'pointer',
            fontSize: 13,
          }}
        >
          <RotateCcw size={14} />
          {t('kaizen.filter.reset')}
        </button>
      </div>
      {chips.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {chips.map((c) => (
            <button
              key={c.label}
              type="button"
              onClick={() => set(c.clear)}
              className="ps-kaizen-pill"
              style={{ border: '1px solid var(--ps-color-accent)', background: 'var(--ps-color-accent-bg)', color: 'var(--ps-color-text)', cursor: 'pointer' }}
            >
              {c.label} ✕
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
