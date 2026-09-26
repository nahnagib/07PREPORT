import React, { useRef } from 'react';
import { useCanExport } from '../exportPermission';
import { Download } from 'lucide-react';
import { Sparkline } from './Sparkline';
import { SemanticBadge } from './SemanticBadge';
import { theme } from '../theme';
import type { SemanticStatus } from './KpiTile';

export interface PerformanceReportRow {
  id: string;
  metric: string;
  actualLabel: string;
  actualFullValue?: string;
  targetLabel: string;
  /** Variance vs target, e.g. +0.0577 for +5.77%. Null when there's no target to compare against. */
  variancePct: number | null;
  /** Variance vs the same period last year. Null when there's no prior-year figure to compare. */
  varianceLyPct: number | null;
  /** Last-year-to-date actual value label (e.g. "$1.2M"). Only rendered when the table's
   * `showLytdColumn` is true. Null/omitted renders as "—" (e.g. rows with no prior-year figure). */
  lytdLabel?: string;
  lytdFullValue?: string;
  /** Recent values (oldest first) for the inline Trend sparkline. Not rendered when
   * `showLytdColumn` is true (Tachometer's Actual/LYTD/Target/Variance layout has no Trend column). */
  trendValues?: number[];
  /** Only rendered when the table's `showStatus` is true. */
  status?: SemanticStatus;
  /** One-line, plain-English sentence for a C-level reader (e.g. "Win rate is down 4pts vs last
   * quarter, driven by B2B segment"). Only rendered when the table's `showTakeaway` is true. */
  takeaway?: string;
}

export interface PerformanceReportTableProps {
  title: string;
  rows: PerformanceReportRow[];
  /** Adds a trailing Status column (pill badge) -- used by the Volume/ASP table, per the mockup. */
  showStatus?: boolean;
  /** Adds a trailing Takeaway column (plain-English sentence) -- used by each page's Executive
   * Summary table. */
  showTakeaway?: boolean;
  /** Switches the column layout to Metric Name / Actual / LYTD / Target / Variance to LYTD /
   * Variance to Target / Status (Trend dropped) -- used by the Tachometer page's two Performance
   * Details tables. Default layout (Metric Name / Actual / Target / Variance% / Variance LY /
   * Trend) is unchanged for every other consumer of this table. */
  showLytdColumn?: boolean;
  /** Overrides the showLytdColumn layout's "LYTD" header (and its "Variance to LYTD" sibling) --
   * for a table whose rows mix comparison periods (e.g. YTD rows vs LYTD, MTD rows vs LMTD) so a
   * single period name in the header would be wrong for half of them. Defaults to "LYTD". */
  lastColumnLabel?: string;
  /** Drops the Variance LY and Trend columns and relabels Variance% as "Variance to Target", for a
   * shorter Actual / Target / Variance to Target [/ Status] [/ Takeaway] layout -- used by the
   * Critical Number page's Performance Details table. Ignored when showLytdColumn is set (that
   * layout already has no Trend column and its own Variance to Target column). */
  compactColumns?: boolean;
  lastUpdatedLabel?: string;
  /** Optional filter information to display in PDF export (e.g., "Company: Majaal | Segment: Enterprise | Date Range: 2026-01-01 to 2026-12-31") */
  filtersSummary?: string;
  /** Callback to trigger PDF export with filter information included */
  onExportPdf?: () => void;
}

function variancePct(v: number | null): string {
  if (v === null) return '—';
  const pct = v * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

function varianceColor(v: number | null): string {
  if (v === null) return 'var(--ps-color-muted-text)';
  return v >= 0 ? 'var(--ps-color-success)' : 'var(--ps-color-alert)';
}

function trendStatus(v: number | null): SemanticStatus {
  if (v === null) return 'neutral';
  return v >= 0 ? 'success' : 'alert';
}

/**
 * Tachometer rebuild (dark-theme pass): clean, scannable performance table matching the mockup's
 * "Detail Performance Tables" spec (Metric Name / Actual / Target / Variance% / Variance LY / Trend
 * [/ Status]). Built as a lightweight, purpose-specific table rather than retrofitting the heavier
 * TanStack-powered DataGrid (sort/filter/resize/pin/export) -- this table's job is a compact,
 * always-visible summary strip, not an interactive grid.
 *
 * Every number here comes from the same real backend fields the KpiCards/AspMiniCards above use
 * (TachometerCard's actual/targetToDate/variancePct/lastYearSamePeriod/fullLastPeriodActual,
 * AspCard's actualAsp/targetAsp) -- never a fabricated per-region or per-product breakdown that
 * this data model doesn't actually back.
 */
export function PerformanceReportTable({ title, rows, showStatus, showTakeaway, showLytdColumn, lastColumnLabel = 'LYTD', compactColumns, lastUpdatedLabel, filtersSummary, onExportPdf }: PerformanceReportTableProps) {
  const canExport = useCanExport();
  const hideVarianceLy = compactColumns && !showLytdColumn;
  const hideTrend = compactColumns && !showLytdColumn;
  const tableRef = useRef<HTMLTableElement>(null);
  return (
    <div
      className="ps-card"
      style={{
        borderRadius: 'var(--ps-card-radius, 14px)',
        border: '1px solid var(--ps-color-border)',
        background: 'var(--ps-card-bg)',
        boxShadow: 'var(--ps-card-shadow)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 16px',
          borderBottom: '1px solid var(--ps-color-border)',
          gap: 12,
        }}
      >
        <h3 style={{ fontSize: theme.table.titleFontSize, fontWeight: 700, margin: 0 }}>{title}</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginLeft: 'auto' }}>
          {onExportPdf && canExport && (
            <button
              onClick={onExportPdf}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '6px 10px',
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--ps-color-muted-text)',
                background: 'var(--ps-color-muted-bg)',
                border: '1px solid var(--ps-color-border)',
                borderRadius: 6,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
              title="Export table as PDF with current filters"
            >
              <Download size={12} />
              Export PDF
            </button>
          )}
          {lastUpdatedLabel && (
            <span style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', whiteSpace: 'nowrap' }}>{lastUpdatedLabel}</span>
          )}
        </div>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: theme.table.bodyFontSize }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--ps-color-border)' }}>
              <th style={{ textAlign: 'left', padding: '8px 16px', color: 'var(--ps-color-muted-text)', fontWeight: 600, fontSize: theme.table.headerFontSize }}>
                Metric Name
              </th>
              <th style={{ textAlign: 'right', padding: '8px 12px', color: 'var(--ps-color-muted-text)', fontWeight: 600, fontSize: theme.table.headerFontSize }}>
                Actual
              </th>
              {showLytdColumn && (
                <th style={{ textAlign: 'right', padding: '8px 12px', color: 'var(--ps-color-muted-text)', fontWeight: 600, fontSize: theme.table.headerFontSize }}>
                  {lastColumnLabel}
                </th>
              )}
              <th style={{ textAlign: 'right', padding: '8px 12px', color: 'var(--ps-color-muted-text)', fontWeight: 600, fontSize: theme.table.headerFontSize }}>
                Target
              </th>
              {showLytdColumn ? (
                <>
                  <th style={{ textAlign: 'right', padding: '8px 12px', color: 'var(--ps-color-muted-text)', fontWeight: 600, fontSize: theme.table.headerFontSize }}>
                    Variance to {lastColumnLabel}
                  </th>
                  <th style={{ textAlign: 'right', padding: '8px 12px', color: 'var(--ps-color-muted-text)', fontWeight: 600, fontSize: theme.table.headerFontSize }}>
                    Variance to Target
                  </th>
                </>
              ) : (
                <>
                  <th style={{ textAlign: 'right', padding: '8px 12px', color: 'var(--ps-color-muted-text)', fontWeight: 600, fontSize: theme.table.headerFontSize }}>
                    {compactColumns ? 'Variance to Target' : 'Variance%'}
                  </th>
                  {!hideVarianceLy && (
                    <th style={{ textAlign: 'right', padding: '8px 12px', color: 'var(--ps-color-muted-text)', fontWeight: 600, fontSize: theme.table.headerFontSize }}>
                      Variance LY
                    </th>
                  )}
                </>
              )}
              {!showLytdColumn && !hideTrend && (
                <th style={{ textAlign: 'center', padding: '8px 12px', color: 'var(--ps-color-muted-text)', fontWeight: 600, fontSize: theme.table.headerFontSize }}>
                  Trend
                </th>
              )}
              {showStatus && (
                <th style={{ textAlign: 'center', padding: '8px 16px', color: 'var(--ps-color-muted-text)', fontWeight: 600, fontSize: theme.table.headerFontSize }}>
                  Status
                </th>
              )}
              {showTakeaway && (
                <th style={{ textAlign: 'left', padding: '8px 16px', color: 'var(--ps-color-muted-text)', fontWeight: 600, fontSize: theme.table.headerFontSize }}>
                  Takeaway
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="ps-datatable-row" style={{ borderBottom: '1px solid var(--ps-color-border)' }}>
                <td style={{ padding: '9px 16px', fontWeight: 600 }}>{r.metric}</td>
                <td
                  title={r.actualFullValue}
                  style={{ padding: '9px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
                >
                  {r.actualLabel}
                </td>
                {showLytdColumn && (
                  <td
                    title={r.lytdFullValue}
                    style={{ padding: '9px 12px', textAlign: 'right', color: 'var(--ps-color-muted-text)', fontVariantNumeric: 'tabular-nums' }}
                  >
                    {r.lytdLabel ?? '—'}
                  </td>
                )}
                <td style={{ padding: '9px 12px', textAlign: 'right', color: 'var(--ps-color-muted-text)', fontVariantNumeric: 'tabular-nums' }}>
                  {r.targetLabel}
                </td>
                {showLytdColumn ? (
                  <>
                    <td style={{ padding: '9px 12px', textAlign: 'right', color: varianceColor(r.varianceLyPct), fontVariantNumeric: 'tabular-nums' }}>
                      {variancePct(r.varianceLyPct)}
                    </td>
                    <td style={{ padding: '9px 12px', textAlign: 'right', color: varianceColor(r.variancePct), fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                      {variancePct(r.variancePct)}
                    </td>
                  </>
                ) : (
                  <>
                    <td style={{ padding: '9px 12px', textAlign: 'right', color: varianceColor(r.variancePct), fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                      {variancePct(r.variancePct)}
                    </td>
                    {!hideVarianceLy && (
                      <td style={{ padding: '9px 12px', textAlign: 'right', color: varianceColor(r.varianceLyPct), fontVariantNumeric: 'tabular-nums' }}>
                        {variancePct(r.varianceLyPct)}
                      </td>
                    )}
                  </>
                )}
                {!showLytdColumn && !hideTrend && (
                  <td style={{ padding: '9px 12px' }}>
                    {r.trendValues && r.trendValues.length > 1 ? (
                      <div style={{ display: 'flex', justifyContent: 'center' }}>
                        <Sparkline
                          values={r.trendValues}
                          status={trendStatus(r.variancePct)}
                          label={`${r.metric} trend`}
                        />
                      </div>
                    ) : (
                      <span style={{ display: 'block', textAlign: 'center', color: 'var(--ps-color-muted-text)' }}>—</span>
                    )}
                  </td>
                )}
                {showStatus && (
                  <td style={{ padding: '9px 16px', textAlign: 'center' }}>
                    {r.status ? <SemanticBadge status={r.status} /> : <span style={{ color: 'var(--ps-color-muted-text)' }}>—</span>}
                  </td>
                )}
                {showTakeaway && (
                  <td style={{ padding: '9px 16px', color: 'var(--ps-color-text)', maxWidth: 360 }}>
                    {r.takeaway ?? <span style={{ color: 'var(--ps-color-muted-text)' }}>—</span>}
                  </td>
                )}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={(compactColumns && !showLytdColumn ? 4 : 6) + (showStatus ? 1 : 0) + (showTakeaway ? 1 : 0)}
                  style={{ padding: 16, textAlign: 'center', color: 'var(--ps-color-muted-text)' }}
                >
                  No data for the current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
