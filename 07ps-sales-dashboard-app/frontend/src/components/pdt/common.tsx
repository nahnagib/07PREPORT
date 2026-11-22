'use client';
import React, { useMemo } from 'react';
import { Button, DateInput, Select } from '@07ps/ui';
import { usePdp } from '../../lib/pdp/hooks';
import { EMPTY_FILTERS, NOT_SET, TRACKER, countActiveFilters, type DropdownValue, type Filters, type HealthCode, type Options, type PriorityCode, type StageCode } from '../../lib/pdt/api';
import s from './Pdt.module.css';

/** The tracker's /options (lists, settings, owners, subfamilies, today). */
export function useTrackerOptions(revision = 0) {
  return usePdp<Options>(`${TRACKER}/options`, revision);
}

export interface Lookup {
  stages: DropdownValue[];
  health: DropdownValue[];
  priorities: DropdownValue[];
  families: DropdownValue[];
  projectTypes: DropdownValue[];
  of: (list: DropdownValue['list_key'], code: string | null | undefined) => DropdownValue | undefined;
  label: (list: DropdownValue['list_key'], code: string | null | undefined) => string;
  familyColor: (familyId: number | null | undefined) => string;
}

export function useLookup(options: Options | null): Lookup {
  return useMemo(() => {
    const all = options?.dropdowns ?? [];
    const byList = (k: DropdownValue['list_key']) => all.filter((d) => d.list_key === k).sort((a, b) => a.sort_order - b.sort_order);
    const of = (list: DropdownValue['list_key'], code: string | null | undefined) => (code ? all.find((d) => d.list_key === list && d.code === code) : undefined);
    return {
      stages: byList('stage'),
      health: byList('health'),
      priorities: byList('priority'),
      families: byList('family'),
      projectTypes: byList('project_type'),
      of,
      label: (list, code) => of(list, code)?.label ?? code ?? '',
      familyColor: (id) => all.find((d) => d.list_key === 'family' && d.value_id === id)?.color ?? '#8a94a6',
    };
  }, [options]);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'YYYY-MM-DD' -> '28 Nov 2026' (the draft's format); empty for null. */
export function fmtDay(v: string | null | undefined): string {
  if (!v) return '';
  const [y, m, d] = v.slice(0, 10).split('-');
  return `${d} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** 'YYYY-MM' -> 'NOV 2026'. */
export const fmtMonth = (v: string): string => `${MONTHS[Number(v.slice(5, 7)) - 1].toUpperCase()} ${v.slice(0, 4)}`;

/** An ISO instant -> '18 Nov 2026 14:05' in the viewer's zone. */
export function fmtStamp(v: string | null | undefined): string {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const firstName = (name: string | null): string => (name ? (name.trim().split(/\s+/)[0] ?? name) : 'No owner');

export function Chip({ color, children, title }: { color: string; children: React.ReactNode; title?: string }) {
  return (
    <span className={s.chip} title={title} style={{ background: `color-mix(in srgb, ${color} 14%, transparent)`, color }}>
      {children}
    </span>
  );
}

/** Health chip; "Health not set" in a neutral dashed chip so the gap is visible but calm. */
export function HealthChip({ code, lookup }: { code: HealthCode | null; lookup: Lookup }) {
  if (!code) return <span className={s.chipUnset}>Health not set</span>;
  const v = lookup.of('health', code);
  return <Chip color={v?.color ?? '#8a94a6'}>{v?.label ?? code}</Chip>;
}

/** Stage chips use the accent like the draft (the column colour is for the kanban only). */
export function StageChip({ code, lookup }: { code: StageCode; lookup: Lookup }) {
  return <Chip color="var(--ps-color-accent)">{lookup.label('stage', code)}</Chip>;
}

export function PriorityText({ code, lookup }: { code: PriorityCode | null; lookup: Lookup }) {
  if (!code) return <span className={s.prioOther}>—</span>;
  return <span className={code === 'HIGH' ? s.prioHigh : s.prioOther}>{code === 'HIGH' ? '↑' : '–'} {lookup.label('priority', code)}</span>;
}

export function Readiness({ pct }: { pct: number | null }) {
  if (pct === null) return <span className={s.muted}>—</span>;
  return (
    <span className={s.bar} aria-label={`Readiness ${pct}%`}>
      <span className={s.barTrack}>
        <span className={s.barFill} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
      </span>
      {pct}%
    </span>
  );
}

export const countActive = countActiveFilters;

const withNotSet = (opts: { value: string; label: string }[], label = 'Not set') => [...opts, { value: NOT_SET, label }];

/** Family, Subfamily, Stage, Health, Owner, Priority, Target launch range and search: every section below follows them. */
export function FilterBar({ filters, onChange, lookup, options }: { filters: Filters; onChange: (f: Filters) => void; lookup: Lookup; options: Options }) {
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch });
  const byCode = (list: DropdownValue[]) => list.map((d) => ({ value: d.code ?? String(d.value_id), label: d.label }));
  // Subfamilies of the chosen families (all when none is chosen).
  const subs = [...new Set(options.subfamilies.filter((x) => filters.familyIds.length === 0 || filters.familyIds.includes(String(x.familyId))).map((x) => x.subfamily))].sort();
  return (
    <div className={s.filters} data-testid="pdt-filters">
      <div>
        <label className={s.fieldLabel} htmlFor="pdt-search">Search</label>
        <input id="pdt-search" className={s.search} type="search" placeholder="Product name or code" value={filters.search} onChange={(e) => set({ search: e.target.value })} />
      </div>
      <Select
        label="Family"
        multiSelect
        options={lookup.families.map((f) => ({ value: String(f.value_id), label: f.label }))}
        value={filters.familyIds}
        onChange={(v) => set({ familyIds: v, subfamilies: filters.subfamilies.filter((x) => subs.includes(x)) })}
      />
      <Select label="Subfamily" multiSelect searchable options={subs.map((x) => ({ value: x, label: x }))} value={filters.subfamilies} onChange={(v) => set({ subfamilies: v })} />
      <Select label="Stage" multiSelect options={byCode(lookup.stages)} value={filters.stages} onChange={(v) => set({ stages: v })} />
      <Select label="Health" multiSelect options={withNotSet(byCode(lookup.health))} value={filters.health} onChange={(v) => set({ health: v })} />
      <Select label="Owner" multiSelect searchable options={withNotSet(options.owners.map((o) => ({ value: o, label: o })), 'No owner')} value={filters.owners} onChange={(v) => set({ owners: v })} />
      <Select label="Priority" multiSelect options={withNotSet(byCode(lookup.priorities))} value={filters.priorities} onChange={(v) => set({ priorities: v })} />
      <DateInput label="Target launch from" value={filters.launchFrom} max={filters.launchTo || undefined} onChange={(v) => set({ launchFrom: v })} />
      <DateInput label="Target launch to" value={filters.launchTo} min={filters.launchFrom || undefined} onChange={(v) => set({ launchTo: v })} />
      <div className={s.filterActions}>
        <Button variant="ghost" disabled={countActiveFilters(filters) === 0} onClick={() => onChange(EMPTY_FILTERS)}>
          Clear filters
        </Button>
      </div>
    </div>
  );
}

/** Field-level error line under an input. */
export function FieldError({ field, error }: { field: string; error: { field?: string; message: string } | null }) {
  if (!error || error.field !== field) return null;
  return (
    <div className={s.error} role="alert">
      {error.message}
    </div>
  );
}
