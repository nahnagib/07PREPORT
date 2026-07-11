import React from 'react';

/**
 * Standards Section 2.1.2 / 3.19 / 5.11 - bottom-of-page Last Update / Last Refresh Time pair,
 * present on every page. Backed (in later phases) by the ingestion job's refresh_log table
 * (data/warehouse/migrations/0004_calendar_and_metadata.sql).
 */
export function RefreshFooter({ lastUpdate = '—', lastRefreshTime = '—' }: { lastUpdate?: string; lastRefreshTime?: string }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'flex-end',
        gap: 24,
        padding: '8px 16px',
        fontSize: 11,
        color: 'var(--ps-color-muted-text)',
        borderTop: '1px solid var(--ps-color-border)',
      }}
    >
      <span>Last Update: {lastUpdate}</span>
      <span>Last Refresh Time: {lastRefreshTime}</span>
    </div>
  );
}
