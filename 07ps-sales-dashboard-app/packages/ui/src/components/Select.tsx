'use client';
import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  label: string;
  options: SelectOption[];
  value: string[];
  onChange: (value: string[]) => void;
  multiSelect?: boolean;
  searchable?: boolean;
  disabled?: boolean;
  /** Section 3.4: locked/disabled filters are shown greyed out, never hidden. */
  lockedReason?: string;
  placeholder?: string;
}

/**
 * Design-quality pass: replaces the native <select> (Screenshot A showed the raw, unstyled
 * browser dropdown for every filter). A custom button + popover listbox styled entirely from
 * design tokens (Standards Section 3.9/3.10), not the native OS chrome that made every dropdown
 * look inconsistent across browsers/platforms.
 *
 * Deliberately built here in packages/ui, not on the Tachometer page - every future dashboard that
 * needs a filter dropdown inherits this once (Standards Section 3.20/5.8), rather than each page
 * re-styling its own <select>.
 *
 * A zero-selection state is always treated as "All" (Section 4.12), same contract as the previous
 * FilterSelect this replaces.
 */
export function Select({
  label,
  options,
  value,
  onChange,
  multiSelect = false,
  searchable = false,
  disabled = false,
  lockedReason,
  placeholder = 'All',
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const selectedLabels = options.filter((o) => value.includes(o.value)).map((o) => o.label);
  const buttonText =
    selectedLabels.length === 0 ? placeholder : selectedLabels.length === 1 ? selectedLabels[0] : `${selectedLabels.length} selected`;

  const filteredOptions = query.trim()
    ? options.filter((o) => o.label.toLowerCase().includes(query.trim().toLowerCase()))
    : options;

  function toggleValue(optValue: string) {
    if (multiSelect) {
      const next = value.includes(optValue) ? value.filter((v) => v !== optValue) : [...value, optValue];
      onChange(next);
    } else {
      onChange(value.includes(optValue) ? [] : [optValue]);
      setOpen(false);
    }
  }

  return (
    <div style={{ opacity: disabled ? 0.5 : 1, marginBottom: 16 }} ref={containerRef}>
      <label
        style={{
          display: 'block',
          fontSize: 12,
          textTransform: 'uppercase',
          letterSpacing: 0.4,
          color: 'var(--ps-color-muted-text)',
          marginBottom: 4,
        }}
      >
        {label}
      </label>

      <div style={{ position: 'relative' }}>
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="listbox"
          aria-expanded={open}
          style={{
            width: '100%',
            height: 38,
            boxSizing: 'border-box',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            padding: '0 10px',
            borderRadius: 8,
            border: `1px solid ${open ? 'var(--ps-color-accent)' : 'var(--ps-color-border)'}`,
            background: 'var(--ps-color-surface)',
            color: selectedLabels.length ? 'var(--ps-color-text)' : 'var(--ps-color-muted-text)',
            fontSize: 14,
            cursor: disabled ? 'not-allowed' : 'pointer',
            boxShadow: open ? '0 0 0 3px color-mix(in srgb, var(--ps-color-accent) 20%, transparent)' : 'none',
          }}
        >
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              textAlign: 'left',
            }}
          >
            {buttonText}
          </span>
          <ChevronDown
            size={16}
            style={{
              flexShrink: 0,
              transform: open ? 'rotate(180deg)' : 'none',
              transition: 'transform 0.15s ease-out',
              color: 'var(--ps-color-muted-text)',
            }}
          />
        </button>

        {open && !disabled && (
          <div
            role="listbox"
            style={{
              position: 'absolute',
              top: 'calc(100% + 4px)',
              left: 0,
              right: 0,
              zIndex: 40,
              background: 'var(--ps-color-surface)',
              border: '1px solid var(--ps-color-border)',
              borderRadius: 8,
              boxShadow: 'var(--ps-card-shadow)',
              maxHeight: 260,
              overflowY: 'auto',
            }}
          >
            {searchable && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 8px',
                  borderBottom: '1px solid var(--ps-color-border)',
                }}
              >
                <Search size={14} style={{ color: 'var(--ps-color-muted-text)', flexShrink: 0 }} />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search..."
                  style={{
                    border: 'none',
                    outline: 'none',
                    background: 'transparent',
                    color: 'var(--ps-color-text)',
                    fontSize: 13,
                    width: '100%',
                  }}
                />
                {query && (
                  <X
                    size={14}
                    style={{ cursor: 'pointer', color: 'var(--ps-color-muted-text)', flexShrink: 0 }}
                    onClick={() => setQuery('')}
                  />
                )}
              </div>
            )}

            <div
              role="option"
              aria-selected={value.length === 0}
              onClick={() => {
                onChange([]);
                if (!multiSelect) setOpen(false);
              }}
              style={{
                padding: '7px 10px',
                fontSize: 14,
                cursor: 'pointer',
                color: value.length === 0 ? 'var(--ps-color-accent)' : 'var(--ps-color-text)',
                fontWeight: value.length === 0 ? 600 : 400,
                background: 'transparent',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--ps-color-muted-bg)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              {placeholder}
            </div>

            {filteredOptions.map((opt) => {
              const selected = value.includes(opt.value);
              return (
                <div
                  key={opt.value}
                  role="option"
                  aria-selected={selected}
                  onClick={() => toggleValue(opt.value)}
                  style={{
                    padding: '7px 10px',
                    fontSize: 14,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    color: selected ? 'var(--ps-color-accent)' : 'var(--ps-color-text)',
                    fontWeight: selected ? 600 : 400,
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--ps-color-muted-bg)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <span>{opt.label}</span>
                  {selected && <span aria-hidden>✓</span>}
                </div>
              );
            })}

            {filteredOptions.length === 0 && (
              <div style={{ padding: '10px', fontSize: 13, color: 'var(--ps-color-muted-text)' }}>No matches</div>
            )}
          </div>
        )}
      </div>

      {disabled && lockedReason && (
        <p style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginTop: 4 }}>{lockedReason}</p>
      )}
    </div>
  );
}
