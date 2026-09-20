'use client';
import React from 'react';
import { Info, AlertTriangle } from 'lucide-react';
import type { RefreshCheck } from '../lib/api';

/**
 * Modernization pass: combines what used to be two separately-stacked banners (the always-visible
 * "not connected to live Odoo" disclaimer, and a conditionally-shown amber stale-data banner) into
 * one consolidated status bar. Neither piece of required information is removed - the validation-
 * data disclaimer is still always shown verbatim (status-check requirement from an earlier
 * session), and the staleness message still appears whenever `isStale` is true (Standards Section
 * 3.23) - they're just presented as one row instead of two, and the row's tint changes from neutral
 * to amber when stale.
 */
export function ValidationStatusBar({
  isStale,
  isInverted,
  refreshCheck,
  lastRefreshTime,
}: {
  isStale?: boolean;
  isInverted?: boolean;
  /** The backend's consistency verdict; its message says exactly what disagrees and what to do. */
  refreshCheck?: RefreshCheck;
  lastRefreshTime?: string;
}) {
  // Inversion (Last Refresh < Last Update) is a correctness bug, not mere staleness — it should
  // never legitimately happen, so it gets its own always-shown, higher-severity banner regardless
  // of the isStale check below.
  if (isInverted) {
    return (
      <div
        role="alert"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
          width: '100%',
          padding: '8px 16px',
          background: 'var(--ps-color-critical, #d32f2f)',
          color: '#fff',
          fontSize: 12,
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
          <AlertTriangle size={14} aria-hidden style={{ flexShrink: 0 }} />
          {refreshCheck?.message
            ? `Refresh log check failed: ${refreshCheck.message}${refreshCheck.action ? ` What to do: ${refreshCheck.action}` : ''}`
            : `Refresh log check failed: last successful refresh (${lastRefreshTime ?? '—'}) is inconsistent with the loaded data. Treat "Last Refresh" as unreliable until this is fixed.`}
        </span>
      </div>
    );
  }

  // Only show a banner if data is stale — otherwise no warning is needed for live, current data
  if (!isStale) {
    return null;
  }

  return (
    <div
      role="note"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        flexWrap: 'wrap',
        width: '100%',
        padding: '8px 16px',
        background: 'var(--ps-color-watch)',
        color: '#1a1a1a',
        fontSize: 12,
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
        <AlertTriangle size={14} aria-hidden style={{ flexShrink: 0 }} />
        Data may be out of date · last successful refresh: {lastRefreshTime ?? '—'}
      </span>
    </div>
  );
}
