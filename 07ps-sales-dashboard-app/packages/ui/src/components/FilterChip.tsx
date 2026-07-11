import React from 'react';

export interface FilterChipProps {
  label: string;
  onRemove?: () => void;
}

/**
 * Complete UI Redesign pass: a small removable "active filter" chip for the modernized sidebar
 * (Business Unit / Customer Group / Distribution Channel / Branch / Salesperson / Date). Purely a
 * display + remove-callback primitive -- AppSidebar.tsx owns which filters are active and what
 * removing one means.
 */
export function FilterChip({ label, onRemove }: FilterChipProps) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 6px 3px 10px',
        borderRadius: 999,
        fontSize: 11.5,
        fontWeight: 600,
        color: 'var(--ps-color-accent)',
        background: 'var(--ps-color-accent-bg)',
        border: '1px solid var(--ps-color-border)',
        whiteSpace: 'nowrap',
        maxWidth: '100%',
      }}
    >
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove filter: ${label}`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 15,
            height: 15,
            borderRadius: '50%',
            border: 'none',
            background: 'transparent',
            color: 'inherit',
            cursor: 'pointer',
            padding: 0,
            flexShrink: 0,
            fontSize: 13,
            lineHeight: 1,
          }}
        >
          ×
        </button>
      )}
    </span>
  );
}
