'use client';
import React, { useEffect } from 'react';
import { ExternalLink, X } from 'lucide-react';
import { DataGrid, ErrorState, LoadingSkeleton, type DataGridColumn } from '@07ps/ui';
import type { DebtDrillKind, DebtDrilldown, DebtDrillRow } from '../../lib/api';
import { formatDate, formatMoney, formatNumber } from '../../lib/format';
import { drillReconciles, drillTitle, safeOdooUrl } from '../../lib/debt/view';

export interface DebtDrillTarget {
  kind: DebtDrillKind;
  key: string;
  /** what was clicked: the customer / bucket / salesperson / team name, or "customer · company" for a table row */
  label: string;
  currency: string;
  /** the clicked figure, which the listed lines must add up to */
  expected: number;
}

type DrillGridRow = DebtDrillRow & { id: string } & Record<string, unknown>;

/**
 * The open lines behind one chart bar or customer-table row (GET /debt-report/drilldown), in that bar's currency,
 * with the page's filters and the report exclusions. The footer shows the lines' total next to the clicked figure, so
 * a reader sees they reconcile. Sortable, searchable, CSV / Excel export (DataGrid).
 */
export function DebtDrilldownModal({
  target,
  data,
  loading,
  error,
  onRetry,
  onClose,
  snapshotDate,
}: {
  target: DebtDrillTarget;
  data: DebtDrilldown | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onClose: () => void;
  snapshotDate: string | null;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const ccy = target.currency;
  const money = (key: keyof DebtDrillRow & string, header: string): DataGridColumn<DrillGridRow> => ({
    key, header, align: 'right', width: 150, rawValue: (r) => Number(r[key] ?? 0), render: (r) => formatMoney(ccy, Number(r[key] ?? 0)),
  });
  const columns: DataGridColumn<DrillGridRow>[] = [
    { key: 'company', header: 'Company', width: 90 },
    { key: 'document', header: 'Invoice no.', width: 150, rawValue: (r) => r.document ?? '' },
    { key: 'invoiceDate', header: 'Invoice date', width: 110, rawValue: (r) => r.invoiceDate ?? '', render: (r) => formatDate(r.invoiceDate) },
    { key: 'dueDate', header: 'Due date', width: 110, rawValue: (r) => r.dueDate ?? '', render: (r) => formatDate(r.dueDate) },
    { key: 'daysOverdue', header: 'Days overdue', align: 'right', width: 100, render: (r) => formatNumber(r.daysOverdue) },
    { key: 'customer', header: 'Customer', width: 220, render: (r) => <span dir="auto">{r.customer}</span> },
    { key: 'currency', header: 'Currency', width: 80 },
    money('invoiceAmount', 'Invoice amount'),
    money('openBalance', 'Open balance'),
    money('overdueAmount', 'Overdue amount'),
    { key: 'salesperson', header: 'Salesperson', width: 150, render: (r) => <span dir="auto">{r.salesperson}</span> },
    { key: 'salesTeam', header: 'Team', width: 160, render: (r) => <span dir="auto">{r.salesTeam}</span> },
    { key: 'segment', header: 'Segment', width: 100, rawValue: (r) => r.segment ?? '' },
    {
      key: 'odooUrl', header: 'Odoo', width: 80, rawValue: (r) => r.odooUrl,
      render: (r) => {
        const href = safeOdooUrl(r.odooUrl);
        return href ? (
          <a href={href} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} style={{ color: 'var(--ps-color-accent)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            Open <ExternalLink size={12} aria-hidden />
          </a>
        ) : '—';
      },
    },
  ];
  const rows: DrillGridRow[] = (data?.rows ?? []).map((r) => ({ ...r, id: String(r.lineId) }));
  const measure = drillReconciles(target.kind);
  const total = data ? data.totals[measure] : null;
  const reconciled = total !== null && Math.abs(total - target.expected) < 0.005;

  return (
    <div role="presentation" onClick={onClose} style={overlay}>
      <div role="dialog" aria-modal="true" aria-label={drillTitle(target.kind, target.label, ccy)} onClick={(e) => e.stopPropagation()} style={panel}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--ps-color-text)' }} dir="auto">
              {drillTitle(target.kind, target.label, ccy)}
            </h2>
            <p style={note}>
              Snapshot {formatDate(snapshotDate)}. Each line is aged by its own due date (an instalment’s own maturity); due today is not
              overdue.
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={closeButton}>
            <X size={18} aria-hidden />
          </button>
        </div>

        {error ? (
          <ErrorState message={error} onRetry={onRetry} />
        ) : loading && !data ? (
          <LoadingSkeleton variant="table" />
        ) : (
          <>
            <div role="status" style={summary}>
              <span>
                {formatNumber(data?.totals.lines ?? 0)} lines · {formatNumber(data?.totals.openDocuments ?? 0)} documents
              </span>
              <span>
                Total {measure === 'overdueAmount' ? 'overdue' : 'open balance'} <strong>{formatMoney(ccy, total ?? 0)}</strong>
              </span>
              <span style={{ color: reconciled ? 'var(--ps-color-muted-text)' : 'var(--ps-color-alert)' }}>
                {reconciled ? `= the figure clicked (${formatMoney(ccy, target.expected)})` : `≠ the figure clicked (${formatMoney(ccy, target.expected)})`}
              </span>
            </div>
            <DataGrid<DrillGridRow>
              columns={columns}
              rows={rows}
              getRowId={(r) => r.id}
              fileName={`debt-${target.kind}-${target.key}-${ccy}-${snapshotDate ?? 'latest'}`}
              pageSize={25}
              maxBodyHeight={460}
            />
          </>
        )}
      </div>
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0, 0, 0, 0.45)', display: 'flex', alignItems: 'center',
  justifyContent: 'center', padding: 'var(--ps-space-3, 16px)',
};
const panel: React.CSSProperties = {
  width: 'min(1400px, 100%)', maxHeight: '92vh', overflow: 'auto', background: 'var(--ps-color-surface)', color: 'var(--ps-color-text)',
  borderRadius: 12, border: '1px solid var(--ps-color-border)', padding: 'var(--ps-space-3, 16px)', display: 'flex', flexDirection: 'column', gap: 12,
  boxShadow: '0 12px 40px rgba(0, 0, 0, 0.25)',
};
const note: React.CSSProperties = { margin: '4px 0 0', fontSize: 12, color: 'var(--ps-color-muted-text)' };
const summary: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: '4px 20px', fontSize: 12.5, color: 'var(--ps-color-text)' };
const closeButton: React.CSSProperties = {
  background: 'none', border: '1px solid var(--ps-color-border)', borderRadius: 8, padding: 6, cursor: 'pointer', color: 'var(--ps-color-text)',
  display: 'inline-flex',
};
