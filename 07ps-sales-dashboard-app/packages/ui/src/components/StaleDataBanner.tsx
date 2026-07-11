import React from 'react';

/**
 * Standards Section 3.23 - "A stale-data banner appears automatically if Last Refresh Time
 * exceeds the expected schedule by more than one missed cycle."
 */
export function StaleDataBanner({ lastRefreshTime }: { lastRefreshTime: string }) {
  return (
    <div
      role="status"
      style={{
        width: '100%',
        padding: '8px 16px',
        background: 'var(--ps-color-watch)',
        color: '#1A1A1A',
        fontSize: 13,
        fontWeight: 600,
      }}
    >
      Data may be out of date - last successful refresh: {lastRefreshTime}
    </div>
  );
}
