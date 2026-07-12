'use client';
import React, { useState } from 'react';
import { Info, Maximize2, X } from 'lucide-react';
import { Card } from './Card';
import { DataTable, type Column } from './DataTable';

export interface ChartPanelProps<T extends Record<string, unknown>> {
  title: string;
  /** Short explanatory text shown via the header info icon's native tooltip. */
  infoText?: string;
  children: React.ReactNode;
  /** Table columns/rows for the "expand to table" focus view. Omit to hide the expand action
   * entirely (the panel then just renders `children` inside the standard card chrome). */
  tableColumns?: Column<T>[];
  tableRows?: T[];
  getRowId?: (row: T) => string;
  style?: React.CSSProperties;
  /** Optional extra header control(s) (e.g. a drill-down mode toggle), rendered between the
   * title/info icon and the expand-to-table button. Purely additive -- omit for the exact
   * previous header layout. */
  headerActions?: React.ReactNode;
}

/**
 * Standard chart-card shell used across every chart panel on this page: title + info icon +
 * expand/focus action button, same Card/DataTable/overlay building blocks (and the same overlay
 * styling as @07ps/ui's ConfirmDialog) every other modal-like surface in the app already uses --
 * no page-specific chrome invented here.
 */
export function ChartPanel<T extends Record<string, unknown>>({
  title,
  infoText,
  children,
  tableColumns,
  tableRows,
  getRowId,
  style,
  headerActions,
}: ChartPanelProps<T>) {
  const [expanded, setExpanded] = useState(false);
  const canFocusTable = !!tableColumns && !!tableRows && !!getRowId;

  return (
    <Card style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', ...style }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 'var(--ps-space-2, 8px)',
          gap: 'var(--ps-space-2, 8px)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--ps-color-text)' }}>{title}</span>
          {infoText && (
            <span
              title={infoText}
              aria-label={infoText}
              style={{ color: 'var(--ps-color-muted-text)', display: 'inline-flex', cursor: 'help', flexShrink: 0 }}
            >
              <Info size={14} />
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {headerActions}
          {canFocusTable && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            aria-label={`Expand ${title} to table view`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 26,
              height: 26,
              flexShrink: 0,
              borderRadius: 6,
              border: '1px solid var(--ps-color-border)',
              background: 'var(--ps-color-muted-bg)',
              color: 'var(--ps-color-muted-text)',
              cursor: 'pointer',
            }}
          >
            <Maximize2 size={13} />
          </button>
          )}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0 }}>{children}</div>

      {expanded && canFocusTable && (
        <div
          role="presentation"
          onClick={() => setExpanded(false)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1000,
            background: 'rgba(0, 0, 0, 0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 'var(--ps-space-3, 16px)',
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '100%',
              maxWidth: 760,
              maxHeight: '80vh',
              overflow: 'auto',
              background: 'var(--ps-color-surface)',
              border: '1px solid var(--ps-color-border)',
              borderRadius: 'var(--ps-card-radius, 14px)',
              boxShadow: 'var(--ps-card-shadow)',
              padding: 'var(--ps-space-4, 24px)',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 'var(--ps-space-3, 16px)',
              }}
            >
              <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--ps-color-text)' }}>{title}</span>
              <button
                type="button"
                onClick={() => setExpanded(false)}
                aria-label="Close"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ps-color-muted-text)', display: 'flex' }}
              >
                <X size={18} />
              </button>
            </div>
            <DataTable columns={tableColumns!} rows={tableRows!} getRowId={getRowId!} />
          </div>
        </div>
      )}
    </Card>
  );
}
