'use client';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { Card, DataGrid, EmptyState, type DataGridColumn } from '@07ps/ui';
import type { ChainDocument, ChainStage, OpportunityChainRow, OpportunityChains } from '../lib/api';
import { formatCurrency, DISPLAY_LOCALE } from '../lib/format';

/**
 * Full Pipeline chain view: every B2B, current-year opportunity followed through
 * Opportunity -> Quotation -> Sales Order -> Delivery, with stage totals on top (so the drop-off
 * between stages is visible) and a sortable, filterable table with a per-row 4-step progress
 * indicator. Clicking a row opens a modal with the linked documents (Opportunity ID, quotation / SO
 * numbers, DL IDs, each with date, value and status) -- an opportunity can have several quotations,
 * orders and deliveries. Data comes from backend/src/measures/pipelineHealth.ts's
 * computeOpportunityChains; nothing here infers a link, it only renders what the backend returns.
 */

const STAGES: { key: ChainStage; label: string }[] = [
  { key: 'opportunity', label: 'Opportunity' },
  { key: 'quotation', label: 'Quotation' },
  { key: 'salesOrder', label: 'Sales Order' },
  { key: 'delivery', label: 'Delivery' },
];
const STAGE_INDEX: Record<ChainStage, number> = { opportunity: 0, quotation: 1, salesOrder: 2, delivery: 3 };
const STAGE_COLORS = ['var(--ps-color-accent)', 'var(--ps-color-gold)', 'var(--ps-color-success)', 'var(--ps-color-trend-target)'];

function formatDate(d: string | null): string {
  return d ?? '—';
}

function ProgressSteps({ row }: { row: OpportunityChainRow }) {
  const reached = STAGE_INDEX[row.reachedStage];
  const counts = [1, row.quotations.length, row.salesOrders.length, row.deliveries.length];
  return (
    <div
      style={{ display: 'flex', alignItems: 'center', gap: 4 }}
      role="img"
      aria-label={`Reached ${STAGES[reached].label} (${reached + 1} of 4)`}
    >
      {STAGES.map((stage, i) => {
        const done = i <= reached;
        return (
          <React.Fragment key={stage.key}>
            {i > 0 && (
              <span
                aria-hidden
                style={{ width: 14, height: 2, background: i <= reached ? STAGE_COLORS[i] : 'var(--ps-color-border)' }}
              />
            )}
            <span
              title={`${stage.label}${done ? (counts[i] > 1 ? ` (${counts[i]})` : '') : ' — not reached'}`}
              style={{
                width: 22,
                height: 22,
                borderRadius: '50%',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 11,
                fontWeight: 700,
                color: done ? 'var(--ps-color-on-accent)' : 'var(--ps-color-muted-text)',
                background: done ? STAGE_COLORS[i] : 'transparent',
                border: `2px solid ${done ? STAGE_COLORS[i] : 'var(--ps-color-border)'}`,
                outline: i === reached ? `2px solid ${STAGE_COLORS[i]}` : undefined,
                outlineOffset: 2,
              }}
            >
              {i + 1}
            </span>
          </React.Fragment>
        );
      })}
      <span style={{ marginLeft: 6, fontSize: 12, color: 'var(--ps-color-muted-text)', whiteSpace: 'nowrap' }}>{STAGES[reached].label}</span>
    </div>
  );
}

interface ChainTableRow extends Record<string, unknown> {
  id: string;
  name: string;
  customer: string;
  salesperson: string;
  stage: string;
  created: string;
  value: number;
  quotations: number;
  salesOrders: number;
  deliveries: number;
  /** "2. Quotation" -- numbered so it sorts in chain order and reads cleanly in CSV/Excel exports. */
  progress: string;
}

const progressLabel = (stage: ChainStage) => `${STAGE_INDEX[stage] + 1}. ${STAGES[STAGE_INDEX[stage]].label}`;

/** Dropdown options for a column's distinct values, in natural (numeric-aware) order. */
function distinctOptions(rows: ChainTableRow[], key: keyof ChainTableRow) {
  const values = Array.from(new Set(rows.map((r) => String(r[key]))));
  values.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return values.map((v) => ({ value: v, label: v }));
}

function DocList({ title, docs, color }: { title: string; docs: ChainDocument[]; color: string }) {
  return (
    <div style={{ flex: '1 1 200px', minWidth: 180 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color, marginBottom: 6 }}>
        {title} ({docs.length})
      </div>
      {docs.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--ps-color-muted-text)' }}>None linked</div>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {docs.map((d, i) => (
            <li key={`${d.number}-${i}`} style={{ fontSize: 12, lineHeight: 1.4 }}>
              <div style={{ fontWeight: 600, color: 'var(--ps-color-text)' }}>{d.number || '—'}</div>
              <div style={{ color: 'var(--ps-color-muted-text)' }}>
                {formatDate(d.date)} · {formatCurrency(d.value)}
                {d.status ? ` · ${d.status}` : ''}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Chain details for one opportunity, as a modal: closes on the X button, Esc, or a click on the
 * backdrop. Same overlay styling as @07ps/ui's ChartPanel focus view, portaled to <body> so it sits
 * above the app sidebar / bottom nav instead of inside the page column's stacking context. */
function ChainDetailModal({ chain, onClose }: { chain: OpportunityChainRow; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const previouslyFocused = document.activeElement as HTMLElement | null;
    document.addEventListener('keydown', onKey);
    closeRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  return createPortal(
    <div
      role="presentation"
      onClick={onClose}
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
        aria-label={`Opportunity chain detail for ${chain.name}`}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 960,
          maxHeight: '80vh',
          overflow: 'auto',
          background: 'var(--ps-color-surface)',
          border: '1px solid var(--ps-color-border)',
          borderRadius: 'var(--ps-card-radius, 14px)',
          boxShadow: 'var(--ps-card-shadow)',
          padding: 'var(--ps-space-4, 24px)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 'var(--ps-space-3, 16px)' }}>
          <div style={{ minWidth: 0 }}>
            <div dir="auto" style={{ fontSize: 16, fontWeight: 700, color: 'var(--ps-color-text)' }}>
              {chain.name} — {chain.customer ?? 'no customer'}
            </div>
            <div dir="auto" style={{ fontSize: 12, color: 'var(--ps-color-muted-text)', marginTop: 2 }}>
              {chain.salesperson ?? 'No salesperson'}
              {chain.stage ? ` · ${chain.stage}` : ''}
            </div>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ps-color-muted-text)', display: 'flex', flexShrink: 0 }}
          >
            <X size={18} />
          </button>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--ps-space-3, 16px)' }}>
          <DocList title="Opportunity ID" docs={[chain.opportunity]} color={STAGE_COLORS[0]} />
          <DocList title="Quotation number" docs={chain.quotations} color={STAGE_COLORS[1]} />
          <DocList title="SO number" docs={chain.salesOrders} color={STAGE_COLORS[2]} />
          <DocList title="DL ID" docs={chain.deliveries} color={STAGE_COLORS[3]} />
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function OpportunityChainView({ chains }: { chains?: OpportunityChains }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const closeDetail = useCallback(() => setSelectedId(null), []);

  const rows = useMemo<ChainTableRow[]>(
    () =>
      (chains?.rows ?? []).map((r) => ({
        id: r.opportunityId,
        name: r.name,
        customer: r.customer ?? '—',
        salesperson: r.salesperson ?? '—',
        stage: r.stage ?? '—',
        created: formatDate(r.createdDate),
        value: r.opportunity.value,
        quotations: r.quotations.length,
        salesOrders: r.salesOrders.length,
        deliveries: r.deliveries.length,
        progress: progressLabel(r.reachedStage),
      })),
    [chains],
  );
  const byId = useMemo(() => new Map((chains?.rows ?? []).map((r) => [r.opportunityId, r])), [chains]);
  const selected = selectedId ? byId.get(selectedId) : undefined;

  const columns = useMemo<DataGridColumn<ChainTableRow>[]>(
    () => [
      { key: 'name', header: 'Opportunity', width: 200 },
      { key: 'customer', header: 'Customer', width: 180 },
      { key: 'salesperson', header: 'Salesperson', width: 150 },
      { key: 'stage', header: 'Stage', width: 130, filterOptions: distinctOptions(rows, 'stage') },
      { key: 'created', header: 'Created', width: 110 },
      { key: 'value', header: 'Value', align: 'right', width: 130, render: (row) => formatCurrency(row.value) },
      {
        key: 'progress',
        header: 'Chain progress',
        width: 230,
        render: (row) => <ProgressSteps row={byId.get(row.id)!} />,
        filterOptions: STAGES.map((st) => ({ value: progressLabel(st.key), label: st.label })),
      },
      { key: 'quotations', header: '# Quot.', align: 'right', width: 90, filterOptions: distinctOptions(rows, 'quotations') },
      { key: 'salesOrders', header: '# Orders', align: 'right', width: 90, filterOptions: distinctOptions(rows, 'salesOrders') },
      { key: 'deliveries', header: '# Deliv.', align: 'right', width: 90, filterOptions: distinctOptions(rows, 'deliveries') },
    ],
    [rows, byId],
  );

  if (!chains || chains.rows.length === 0) {
    return <EmptyState message="No B2B opportunities created this year for the selected filters." />;
  }

  const totalTiles = [
    { label: 'Opportunities', total: chains.totals.opportunities },
    { label: 'Quotations', total: chains.totals.quotations },
    { label: 'Sales Orders', total: chains.totals.salesOrders },
    { label: 'Deliveries', total: chains.totals.deliveries },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-3, 16px)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 'var(--ps-space-2, 8px)' }}>
        {totalTiles.map((tile, i) => {
          const prev = i > 0 ? totalTiles[i - 1].total.opportunities : null;
          const dropPct = prev != null && prev > 0 ? (tile.total.opportunities / prev) * 100 : null;
          return (
            <Card key={tile.label} style={{ borderTop: `3px solid ${STAGE_COLORS[i]}` }}>
              <div style={{ fontSize: 12, color: 'var(--ps-color-muted-text)' }}>{tile.label}</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--ps-color-text)', fontVariantNumeric: 'tabular-nums' }}>
                {tile.total.opportunities.toLocaleString(DISPLAY_LOCALE)}
              </div>
              <div style={{ fontSize: 12, color: 'var(--ps-color-muted-text)' }}>
                {i === 0 ? 'opportunities' : 'opportunities reached'} · {formatCurrency(tile.total.value)}
              </div>
              <div style={{ fontSize: 12, color: 'var(--ps-color-muted-text)' }}>
                {i > 0 && `${tile.total.documents.toLocaleString(DISPLAY_LOCALE)} documents`}
                {dropPct != null && ` · ${dropPct.toFixed(1)}% of ${totalTiles[i - 1].label.toLowerCase()}`}
              </div>
            </Card>
          );
        })}
      </div>

      <div style={{ fontSize: 12, color: 'var(--ps-color-muted-text)' }}>
        Click a column header to sort (click again to reverse). Click a row to see its linked quotations, sales orders and deliveries.
      </div>

      <DataGrid
        columns={columns}
        rows={rows}
        getRowId={(row) => row.id}
        fileName="opportunity-chain"
        pageSize={25}
        onRowClick={(row) => setSelectedId(row.id)}
      />

      {selected && <ChainDetailModal chain={selected} onClose={closeDetail} />}
    </div>
  );
}
