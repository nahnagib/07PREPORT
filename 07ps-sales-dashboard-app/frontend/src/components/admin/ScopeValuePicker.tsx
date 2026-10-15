'use client';
import React, { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';
import type { DataScopeValue } from '../../lib/api';
import { filterOptions, visibleChips } from '../../lib/dataScope';

/** Options drawn at once (a dimension can have hundreds of salespeople); searching narrows to the rest. */
const MAX_RENDERED = 200;

/**
 * The data-scope rule's value field (Roles page, 2026-10-15): a searchable multi-select with a checkbox per option,
 * "Select all" (the options matching the search) and "Clear" inside the dropdown, and the selection shown as
 * removable chips -- the first three, then "+N more". Unlike the filter bar's Select, an empty selection is NOT
 * "All": a rule needs at least one value (the caller blocks saving without one).
 *
 * Options come from lib/useDimensionValues.ts (the caller passes `loading` / `error` / `onRetry`). States: "Loading
 * values...", the error with a Retry link, "No values available" (the dimension has none), "No matches" (only for a
 * non-empty search). An empty search shows every option; the search ignores case and Arabic diacritics / letter
 * variants (lib/dataScope.ts filterOptions). `savedLabels` labels the chips of a saved rule while the list loads.
 */
export function ScopeValuePicker({
  label,
  options,
  value,
  onChange,
  disabled = false,
  invalid = false,
  loading = false,
  error = null,
  onRetry,
  savedLabels,
}: {
  label: string;
  options: DataScopeValue[];
  value: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
  /** shows the field in the alert colour (e.g. saving was tried with no value) */
  invalid?: boolean;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** labels of already-saved values, used until the options have loaded */
  savedLabels?: Record<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const labelOf = new Map(options.map((o) => [o.value, o.label]));
  const selected = value.map((v) => ({ value: v, label: labelOf.get(v) ?? savedLabels?.[v] ?? v }));
  const { shown, more } = visibleChips(selected);
  const q = query.trim();
  const matching = filterOptions(options, q);
  const drawn = matching.length > MAX_RENDERED ? [...matching.slice(0, MAX_RENDERED), ...matching.slice(MAX_RENDERED).filter((o) => value.includes(o.value))] : matching;
  const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  const selectAll = () => onChange([...value, ...matching.map((o) => o.value).filter((v) => !value.includes(v))]);
  const clear = () => onChange(q ? value.filter((v) => !matching.some((o) => o.value === v)) : []);

  return (
    <div ref={ref} style={{ position: 'relative', minWidth: 0, opacity: disabled ? 0.55 : 1 }}>
      <span style={fieldLabel}>{label}</span>
      <div
        style={{
          ...field,
          borderColor: invalid ? 'var(--ps-color-alert)' : open ? 'var(--ps-color-accent)' : 'var(--ps-color-border)',
          boxShadow: open ? '0 0 0 3px color-mix(in srgb, var(--ps-color-accent) 20%, transparent)' : 'none',
        }}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, flex: 1, minWidth: 0 }}>
          {selected.length === 0 ? (
            <span style={{ color: 'var(--ps-color-muted-text)', fontSize: 13.5, padding: '3px 2px' }}>{loading ? 'Loading values...' : 'Choose values'}</span>
          ) : null}
          {shown.map((s) => (
            <span key={s.value} className="ps-chip" style={{ maxWidth: '100%' }}>
              <span dir="auto" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {s.label}
              </span>
              {!disabled && (
                <button type="button" onClick={() => toggle(s.value)} aria-label={`Remove ${s.label}`}>
                  ×
                </button>
              )}
            </span>
          ))}
          {more > 0 ? (
            <button
              type="button"
              className="ps-chip"
              onClick={() => !disabled && setOpen(true)}
              title={selected.slice(3).map((s) => s.label).join(', ')}
              style={{ cursor: disabled ? 'default' : 'pointer' }}
            >
              +{more} more
            </button>
          ) : null}
        </div>
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listId}
          aria-label={`${label}: ${selected.length} selected. ${open ? 'Close' : 'Open'} the list`}
          style={toggleButton}
        >
          <ChevronDown size={16} style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
        </button>
      </div>

      {error && !open ? (
        <p role="alert" style={{ fontSize: 12, color: 'var(--ps-color-alert)', margin: '4px 0 0' }}>
          {error}{' '}
          {onRetry ? (
            <button type="button" onClick={onRetry} style={linkButton}>
              Retry
            </button>
          ) : null}
        </p>
      ) : null}

      {open && !disabled && (
        <div style={popover}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderBottom: '1px solid var(--ps-color-border)' }}>
            <Search size={14} style={{ color: 'var(--ps-color-muted-text)', flexShrink: 0 }} aria-hidden />
            <input
              autoFocus
              dir="auto"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search..."
              aria-label={`Search ${label}`}
              style={{ border: 'none', outline: 'none', background: 'transparent', color: 'var(--ps-color-text)', fontSize: 13, width: '100%' }}
            />
            {query ? <X size={14} style={{ cursor: 'pointer', color: 'var(--ps-color-muted-text)' }} onClick={() => setQuery('')} aria-label="Clear search" /> : null}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '6px 10px', borderBottom: '1px solid var(--ps-color-border)', fontSize: 12.5 }}>
            <button type="button" onClick={selectAll} style={linkButton} disabled={loading || matching.length === 0}>
              Select all{q ? ` (${matching.length})` : ''}
            </button>
            <span style={{ color: 'var(--ps-color-muted-text)' }}>{value.length} selected</span>
            <button type="button" onClick={clear} style={linkButton} disabled={value.length === 0}>
              Clear
            </button>
          </div>
          <div id={listId} role="listbox" aria-multiselectable="true" aria-label={label} style={{ maxHeight: 240, overflowY: 'auto' }}>
            {drawn.map((o) => {
              const checked = value.includes(o.value);
              return (
                <label key={o.value} role="option" aria-selected={checked} style={optionRow}>
                  <input type="checkbox" checked={checked} onChange={() => toggle(o.value)} style={{ accentColor: 'var(--ps-color-accent)', margin: 0 }} />
                  <span dir="auto" style={{ fontWeight: checked ? 600 : 400 }}>
                    {o.label}
                  </span>
                </label>
              );
            })}
            {loading ? (
              <div role="status" style={emptyLine}>
                Loading values...
              </div>
            ) : error ? (
              <div role="alert" style={{ ...emptyLine, color: 'var(--ps-color-alert)' }}>
                {error}{' '}
                {onRetry ? (
                  <button type="button" onClick={onRetry} style={linkButton}>
                    Retry
                  </button>
                ) : null}
              </div>
            ) : options.length === 0 ? (
              <div style={emptyLine}>No values available</div>
            ) : drawn.length === 0 && q ? (
              <div style={emptyLine}>No matches</div>
            ) : null}
            {matching.length > MAX_RENDERED ? (
              <div style={{ padding: '8px 10px', fontSize: 12, color: 'var(--ps-color-muted-text)' }}>
                Showing the first {MAX_RENDERED} of {matching.length} -- type to search for the rest
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

const emptyLine: React.CSSProperties = { padding: 10, fontSize: 13, color: 'var(--ps-color-muted-text)' };
const fieldLabel: React.CSSProperties = {
  display: 'block', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--ps-color-muted-text)', marginBottom: 4,
};
const field: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, minHeight: 38, boxSizing: 'border-box', padding: '3px 4px 3px 6px', borderRadius: 8,
  border: '1px solid var(--ps-color-border)', background: 'var(--ps-color-surface)',
};
const toggleButton: React.CSSProperties = {
  flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, border: 'none', borderRadius: 6,
  background: 'transparent', color: 'var(--ps-color-muted-text)', cursor: 'pointer',
};
const popover: React.CSSProperties = {
  position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, minWidth: 240, zIndex: 40, background: 'var(--ps-color-surface)',
  border: '1px solid var(--ps-color-border)', borderRadius: 8, boxShadow: 'var(--ps-card-shadow)',
};
const optionRow: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', fontSize: 14, cursor: 'pointer', color: 'var(--ps-color-text)',
};
const linkButton: React.CSSProperties = {
  background: 'none', border: 'none', padding: 0, font: 'inherit', fontWeight: 600, color: 'var(--ps-color-accent)', cursor: 'pointer',
};
