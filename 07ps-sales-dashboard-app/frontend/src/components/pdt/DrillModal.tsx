'use client';
import React, { useEffect } from 'react';
import { X } from 'lucide-react';
import { DataGrid, type DataGridColumn } from '@07ps/ui';
import type { Product } from '../../lib/pdt/api';
import { HealthChip, fmtDay, type Lookup } from './common';
import s from './Pdt.module.css';

type DrillRow = Record<string, unknown> & {
  id: string;
  code: string;
  name: string;
  brand: string;
  family: string;
  subfamily: string;
  stage: string;
  health: string;
  priority: string;
  owner: string;
  readiness: number | null;
  target: string;
  days: number | null;
  flag: string;
  nextStep: string;
  product: Product;
};

const DAY = 86_400_000;
/** Days from today to the target launch; none for a launched product or one without a target. */
export function daysToLaunch(p: Pick<Product, 'stage' | 'targetLaunch'>, today: string): number | null {
  if (p.stage === 'LAUNCHED' || !p.targetLaunch) return null;
  return Math.round((Date.parse(`${p.targetLaunch}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY);
}

/**
 * The products behind a clicked KPI card, pipeline stage, family bar segment or year (the same filtered set as the
 * page): sortable, searchable, CSV / Excel export (DataGrid), in the modal shell of the app's other drill-downs
 * (Receivables). A row opens the product drawer. Esc or ✕ closes it (not while the drawer is open).
 */
export function DrillModal({ title, subtitle, products, lookup, today, fileName, onClose, onOpenProduct, paused = false }: {
  title: string;
  subtitle?: string;
  products: Product[];
  lookup: Lookup;
  today: string;
  fileName: string;
  onClose: () => void;
  onOpenProduct: (code: string) => void;
  /** True while the product drawer is open on top: Esc then belongs to the drawer. */
  paused?: boolean;
}) {
  useEffect(() => {
    if (paused) return undefined;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, paused]);

  const rows: DrillRow[] = products.map((p) => ({
    id: p.code,
    code: p.code,
    name: p.name,
    brand: p.brand,
    family: p.family ?? '',
    subfamily: p.subfamily ?? '',
    stage: lookup.label('stage', p.stage),
    health: p.health ? lookup.label('health', p.health) : 'Not set',
    priority: p.priority ? lookup.label('priority', p.priority) : '',
    owner: p.ownerName ?? '',
    readiness: p.readinessPct,
    target: p.targetLaunch ?? '',
    days: daysToLaunch(p, today),
    flag: p.flagLabel ?? '',
    nextStep: p.nextStep ?? '',
    product: p,
  }));

  const columns: DataGridColumn<DrillRow>[] = [
    { key: 'code', header: 'Code', width: 80 },
    { key: 'name', header: 'Product name', width: 200, render: (r) => <b>{r.name}</b> },
    { key: 'brand', header: 'Brand', width: 110 },
    { key: 'family', header: 'Family', width: 170 },
    { key: 'subfamily', header: 'Subfamily', width: 150 },
    { key: 'stage', header: 'Stage', width: 110 },
    { key: 'health', header: 'Health', width: 120, render: (r) => <HealthChip code={r.product.health} lookup={lookup} /> },
    { key: 'priority', header: 'Priority', width: 80 },
    { key: 'owner', header: 'Owner', width: 130 },
    { key: 'readiness', header: 'Readiness %', align: 'right', width: 100, rawValue: (r) => r.readiness ?? '', render: (r) => (r.readiness === null ? '—' : `${r.readiness}%`), sortValue: (r) => r.readiness ?? -1 },
    { key: 'target', header: 'Target launch', width: 120, render: (r) => fmtDay(r.target) || '—', sortValue: (r) => r.target || '9999' },
    { key: 'days', header: 'Days to launch', align: 'right', width: 110, rawValue: (r) => r.days ?? '', render: (r) => (r.days === null ? '—' : <span className={r.days < 0 ? s.flagAlert : undefined}>{r.days}</span>), sortValue: (r) => r.days ?? Number.POSITIVE_INFINITY },
    { key: 'flag', header: 'Flag', width: 170, render: (r) => (r.flag ? <span className={`${s.flag} ${r.product.flag === 'HEALTH_NOT_SET' ? s.flagMuted : r.product.flag === 'LAUNCH_SOON_LOW_READINESS' ? s.flagWatch : s.flagAlert}`}>{r.flag}</span> : '') },
    { key: 'nextStep', header: 'Next step', width: 220 },
  ];

  return (
    <div role="presentation" onClick={onClose} className={s.modalOverlay}>
      <div role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()} className={s.modalPanel} data-testid="pdt-drill">
        <div className={s.modalHead}>
          <div style={{ minWidth: 0 }}>
            <h2 className={s.modalTitle}>
              {title} <span className={s.badge} data-testid="pdt-drill-count">{rows.length} product{rows.length === 1 ? '' : 's'}</span>
            </h2>
            {subtitle && <p className={s.modalNote}>{subtitle}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className={s.modalClose}>
            <X size={18} aria-hidden />
          </button>
        </div>
        {rows.length === 0 ? (
          <p className={s.muted}>No product for the current filters.</p>
        ) : (
          <DataGrid<DrillRow>
            columns={columns}
            rows={rows}
            getRowId={(r) => r.id}
            fileName={fileName}
            pageSize={25}
            maxBodyHeight={460}
            onRowClick={(r) => onOpenProduct(r.code)}
          />
        )}
      </div>
    </div>
  );
}
