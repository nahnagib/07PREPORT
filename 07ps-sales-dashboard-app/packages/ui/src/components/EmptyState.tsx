import React from 'react';

export interface EmptyStateProps {
  message?: string;
  onResetFilters?: () => void;
}

/**
 * Standards Section 3.22 - Empty States.
 * "When a filter combination returns no data, the affected card/chart shows a short explanatory
 * message plus a one-click 'Reset filters' action - never an empty chart frame with no explanation."
 */
export function EmptyState({
  message = 'No data for the selected filters.',
  onResetFilters,
}: EmptyStateProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        padding: '32px 16px',
        color: 'var(--ps-color-muted-text)',
        textAlign: 'center',
      }}
    >
      <p style={{ margin: 0, fontSize: 14 }}>{message}</p>
      {onResetFilters && (
        <button
          onClick={onResetFilters}
          style={{
            border: 'none',
            background: 'var(--ps-color-accent)',
            color: 'var(--ps-color-on-accent)',
            padding: '6px 14px',
            borderRadius: 6,
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          Reset filters
        </button>
      )}
    </div>
  );
}
