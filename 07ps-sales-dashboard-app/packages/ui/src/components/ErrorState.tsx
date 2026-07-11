import React from 'react';

export interface ErrorStateProps {
  message?: string;
  onRetry?: () => void;
  /** Incident reference for system-tier errors - Section 5.9. Never expose raw stack traces/table names. */
  incidentRef?: string;
}

/**
 * Standards Section 3.23 / 5.9 - Error States.
 * Card-level inline error with retry, never a full-page failure for a data/refresh error.
 * No raw DB errors, stack traces, or internal table/field names are ever shown to the end user.
 */
export function ErrorState({
  message = "This card couldn't load. Please try again.",
  onRetry,
  incidentRef,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '16px',
        border: '1px solid var(--ps-color-alert)',
        borderRadius: 8,
        color: 'var(--ps-color-alert)',
        fontSize: 14,
      }}
    >
      <span>{message}</span>
      {incidentRef && <span style={{ fontSize: 12, opacity: 0.8 }}>Reference: {incidentRef}</span>}
      {onRetry && (
        <button
          onClick={onRetry}
          style={{
            alignSelf: 'flex-start',
            border: '1px solid currentColor',
            background: 'transparent',
            color: 'inherit',
            padding: '4px 12px',
            borderRadius: 6,
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          Retry
        </button>
      )}
    </div>
  );
}
