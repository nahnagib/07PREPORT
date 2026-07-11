import React from 'react';

export interface FilterOption {
  value: string;
  label: string;
}

export interface FilterSelectProps {
  label: string;
  options: FilterOption[];
  value: string[];
  onChange: (value: string[]) => void;
  multiSelect?: boolean;
  searchable?: boolean;
  disabled?: boolean;
  /** Section 3.4: locked/disabled filters are shown greyed out, never hidden. */
  lockedReason?: string;
}

/**
 * Standards Section 4 - Filter Standards.
 * A zero-selection multi-select is always treated as "All" (Section 4.12), never as "none".
 * Filters with >~15 values should be searchable (Section 4.11) - `searchable` flag reflects that.
 */
export function FilterSelect({
  label,
  options,
  value,
  onChange,
  multiSelect = false,
  searchable = false,
  disabled = false,
  lockedReason,
}: FilterSelectProps) {
  return (
    <div style={{ opacity: disabled ? 0.5 : 1, marginBottom: 16 }}>
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
      <select
        multiple={multiSelect}
        disabled={disabled}
        value={value}
        onChange={(e) =>
          onChange(Array.from(e.target.selectedOptions).map((o) => o.value))
        }
        title={searchable ? 'Type to search' : undefined}
        style={{
          width: '100%',
          padding: '6px 8px',
          borderRadius: 6,
          border: '1px solid var(--ps-color-border)',
          background: 'var(--ps-color-surface)',
          color: 'var(--ps-color-text)',
        }}
      >
        <option value="">All</option>
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      {disabled && lockedReason && (
        <p style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginTop: 4 }}>
          {lockedReason}
        </p>
      )}
    </div>
  );
}
