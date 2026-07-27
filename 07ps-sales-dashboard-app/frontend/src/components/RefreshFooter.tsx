import React from 'react';

/**
 * Standards Section 2.1.2 / 3.19 / 5.11 - bottom-of-page Last Update / Last Refresh Time pair,
 * present on every page. Backed (in later phases) by the ingestion job's refresh_log table
 * (data/warehouse/migrations/0004_calendar_and_metadata.sql).
 */
export function RefreshFooter({
  lastUpdate = '—',
  lastOrderCreated,
  lastRefreshTime = '—',
}: {
  lastUpdate?: string;
  /** Odoo create_date (record creation), separate from lastUpdate (date_order -- the order/
   * confirmation date). Optional so callers that haven't wired refreshStatus.lastOrderCreated
   * through yet just don't render this span, rather than showing "—". */
  lastOrderCreated?: string;
  lastRefreshTime?: string;
}) {
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
      {lastOrderCreated ? <span>Last Order Created: {lastOrderCreated}</span> : null}
      <span>Last Refresh Time: {lastRefreshTime}</span>
    </div>
  );
}
