'use client';
import React, { useMemo, useState } from 'react';
import { Card, DataTable, EmptyState, type Column } from '@07ps/ui';
import type { ChainDocument, ChainStage, OpportunityChainRow, OpportunityChains } from '../lib/api';
import { formatCurrency } from '../lib/format';

/**
 * Full Pipeline chain view: every B2B, current-year opportunity followed through
 * Opportunity -> Quotation -> Sales Order -> Delivery, with stage totals on top (so the drop-off
 * between stages is visible) and a per-row 4-step progress indicator. Clicking a row expands the
 * linked documents (number, date, value, status) -- an opportunity can have several quotations,
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
  created: string;
  value: string;
  quotations: number;
  salesOrders: number;
  deliveries: number;
  progress: string;
}

function DocList({ title, docs, color }: { title: string; docs: ChainDocument[]; color: string }) {
  return (
    <div style={{ flex: '1 1 220px', minWidth: 200 }}>
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

export function OpportunityChainView({ chains }: { chains?: OpportunityChains }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const rows = useMemo<ChainTableRow[]>(
    () =>
      (chains?.rows ?? []).map((r) => ({
        id: r.opportunityId,
        name: r.name,
        customer: r.customer ?? '—',
        salesperson: r.salesperson ?? '—',
        created: formatDate(r.createdDate),
        value: formatCurrency(r.opportunity.value),
        quotations: r.quotations.length,
        salesOrders: r.salesOrders.length,
        deliveries: r.deliveries.length,
        progress: r.reachedStage,
      })),
    [chains],
  );
  const byId = useMemo(() => new Map((chains?.rows ?? []).map((r) => [r.opportunityId, r])), [chains]);
  const selected = selectedId ? byId.get(selectedId) : undefined;

  const columns: Column<ChainTableRow>[] = [
    { key: 'name', header: 'Opportunity' },
    { key: 'customer', header: 'Customer' },
    { key: 'salesperson', header: 'Salesperson' },
    { key: 'created', header: 'Created' },
    { key: 'value', header: 'Value', align: 'right' },
    { key: 'progress', header: 'Chain progress', render: (row) => <ProgressSteps row={byId.get(row.id)!} /> },
    { key: 'quotations', header: '# Quot.', align: 'right' },
    { key: 'salesOrders', header: '# Orders', align: 'right' },
    { key: 'deliveries', header: '# Deliv.', align: 'right' },
  ];

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
                {tile.total.opportunities.toLocaleString()}
              </div>
              <div style={{ fontSize: 12, color: 'var(--ps-color-muted-text)' }}>
                {i === 0 ? 'opportunities' : 'opportunities reached'} · {formatCurrency(tile.total.value)}
              </div>
              <div style={{ fontSize: 12, color: 'var(--ps-color-muted-text)' }}>
                {i > 0 && `${tile.total.documents.toLocaleString()} documents`}
                {dropPct != null && ` · ${dropPct.toFixed(1)}% of ${totalTiles[i - 1].label.toLowerCase()}`}
              </div>
            </Card>
          );
        })}
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(row) => row.id}
        onRowClick={(row) => setSelectedId((cur) => (cur === row.id ? null : row.id))}
      />

      {selected ? (
        <Card aria-label={`Opportunity chain detail for ${selected.name}`}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ps-color-text)', marginBottom: 12 }}>
            {selected.name} — {selected.customer ?? 'no customer'}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--ps-space-3, 16px)' }}>
            <DocList title="Opportunity" docs={[selected.opportunity]} color={STAGE_COLORS[0]} />
            <DocList title="Quotations" docs={selected.quotations} color={STAGE_COLORS[1]} />
            <DocList title="Sales Orders" docs={selected.salesOrders} color={STAGE_COLORS[2]} />
            <DocList title="Deliveries" docs={selected.deliveries} color={STAGE_COLORS[3]} />
          </div>
        </Card>
      ) : (
        <div style={{ fontSize: 12, color: 'var(--ps-color-muted-text)' }}>Click a row to see its linked quotations, sales orders and deliveries.</div>
      )}
    </div>
  );
}
