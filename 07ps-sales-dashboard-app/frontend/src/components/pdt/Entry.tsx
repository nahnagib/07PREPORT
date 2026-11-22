'use client';
import React, { useMemo, useState } from 'react';
import { Button, EmptyState, ErrorState, LoadingSkeleton, Select } from '@07ps/ui';
import { useAuth } from '../../lib/AuthProvider';
import { ENTRY } from '../../lib/pdp/api';
import { usePdp } from '../../lib/pdp/hooks';
import { EMPTY_FILTERS, TRACKER, filterQuery, trackerDownload, type BlockerRow, type BlockerStatus, type Filters, type FollowupItem, type FollowupKind, type Options, type Product } from '../../lib/pdt/api';
import { ExportButtons, exportProductPdf, type ExportColumn } from '../product/ProductUi';
import { Chip, FilterBar, HealthChip, PriorityText, Readiness, StageChip, fmtDay, useLookup } from './common';
import { BlockerForm, ProductForm } from './forms';
import { ImportTab } from './Import';
import { ProductDrawer } from './ProductDrawer';
import s from './Pdt.module.css';

type Tab = 'products' | 'updates' | 'blockers' | 'followup' | 'import';
const TABS: [Tab, string][] = [
  ['products', 'Products'],
  ['updates', 'Status updates'],
  ['blockers', 'Blockers & decisions'],
  ['followup', 'Follow-up board'],
  ['import', 'Excel import'],
];

interface Opened {
  code: string;
  start?: 'update' | 'blocker';
}

/**
 * Product → Product Development Plan → Data entry & follow-up (product_development_entry): the register, the weekly
 * status updates, blockers & decisions and the managers' follow-up board. Every number on the dashboard is entered here.
 */
export function TrackerEntry({ options, revision, refresh }: { options: Options; revision: number; refresh: () => void }) {
  const lookup = useLookup(options);
  const [tab, setTab] = useState<Tab>(() => {
    if (typeof window === 'undefined') return 'products';
    const t = new URLSearchParams(window.location.search).get('tab');
    return TABS.some(([k]) => k === t) ? (t as Tab) : 'products';
  });
  const [opened, setOpened] = useState<Opened | null>(null);
  const choose = (t: Tab) => {
    setTab(t);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('tab', t);
      window.history.replaceState(null, '', url.toString());
    } catch {
      /* the URL is a convenience only */
    }
  };
  const props = { options, lookup, revision, refresh, open: setOpened };
  return (
    <div className={s.stack} data-testid="pdt-entry">
      <div className={s.subTabs} role="tablist" aria-label="Data entry & follow-up">
        {TABS.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={`${s.subTab}${tab === k ? ` ${s.subTabActive}` : ''}`} onClick={() => choose(k)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'products' && <ProductsTab {...props} />}
      {tab === 'updates' && <UpdatesTab {...props} />}
      {tab === 'blockers' && <BlockersTab {...props} />}
      {tab === 'followup' && <FollowupTab {...props} />}
      {tab === 'import' && <ImportTab lookup={lookup} refresh={refresh} revision={revision} />}
      {opened && (
        <ProductDrawer key={`${opened.code}-${opened.start ?? ''}`} code={opened.code} start={opened.start} options={options} lookup={lookup} onClose={() => setOpened(null)} onChanged={refresh} />
      )}
    </div>
  );
}

interface TabProps {
  options: Options;
  lookup: ReturnType<typeof useLookup>;
  revision: number;
  refresh: () => void;
  open: (o: Opened) => void;
}

function useProducts(filters: Filters, revision: number) {
  return usePdp<{ rows: (Product & { active: boolean })[] }>(`${TRACKER}/products${filterQuery(filters)}`, revision);
}

// ---------------------------------------------------------------------------------------------------------------------

function ProductsTab({ options, lookup, revision, refresh, open }: TabProps) {
  const { canCreate } = useAuth();
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [adding, setAdding] = useState(false);
  const list = useProducts(filters, revision);
  return (
    <>
      <FilterBar filters={filters} onChange={setFilters} lookup={lookup} options={options} />
      <section className={s.card}>
        <div className={s.cardHead}>
          <div>
            <h2 className={s.cardTitle}>Product register {list.data && <span className={s.badge}>{list.data.rows.length}</span>}</h2>
            <p className={s.cardSub}>Click a product to edit it, change its stage, post an update or add a blocker.</p>
          </div>
          {canCreate(ENTRY) && !adding && <Button onClick={() => setAdding(true)}>New product</Button>}
        </div>
        {adding && (
          <div className={s.card} style={{ marginBottom: 16 }}>
            <h3 className={s.cardTitle} style={{ fontSize: 15, marginBottom: 12 }}>New product</h3>
            <ProductForm
              options={options}
              lookup={lookup}
              onSaved={(d) => {
                setAdding(false);
                refresh();
                open({ code: d.product.code });
              }}
              onCancel={() => setAdding(false)}
            />
          </div>
        )}
        {list.error && <ErrorState message={list.error} onRetry={list.retry} />}
        {!list.data && !list.error && <LoadingSkeleton variant="table" />}
        {list.data && list.data.rows.length === 0 && <EmptyState message="No product yet. Add the first one with New product." />}
        {list.data && list.data.rows.length > 0 && (
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr><th>Product</th><th>Family</th><th>Stage</th><th>Owner</th><th>Priority</th><th>Health</th><th>Readiness</th><th>Target launch</th><th>Last update</th></tr>
              </thead>
              <tbody>
                {list.data.rows.map((p) => (
                  <tr key={p.code} className={s.rowLink} tabIndex={0} onClick={() => open({ code: p.code })} onKeyDown={(e) => e.key === 'Enter' && open({ code: p.code })}>
                    <td><b>{p.name}</b><span className={s.sub}>{p.code}</span></td>
                    <td>{p.family ?? '—'}<span className={s.sub}>{p.subfamily}</span></td>
                    <td><StageChip code={p.stage} lookup={lookup} /></td>
                    <td>{p.ownerName ?? <span className={s.muted}>—</span>}</td>
                    <td><PriorityText code={p.priority} lookup={lookup} /></td>
                    <td><HealthChip code={p.health} lookup={lookup} />{p.healthReviewRequired && <span className={s.sub}>Health to confirm</span>}</td>
                    <td><Readiness pct={p.readinessPct} /></td>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtDay(p.targetLaunch) || '—'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtDay(p.lastUpdateAt) || '—'}{p.stale && <span className={s.stale} style={{ display: 'block' }}>No update</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------------

function UpdatesTab({ options, lookup, revision, open }: TabProps) {
  const { canCreate } = useAuth();
  const [owners, setOwners] = useState<string[]>([]);
  const list = useProducts({ ...EMPTY_FILTERS, owners }, revision);
  const rows = useMemo(
    () => (list.data?.rows ?? []).filter((p) => p.active).sort((a, b) => Number(b.stale) - Number(a.stale) || (a.lastUpdateAt ?? '').localeCompare(b.lastUpdateAt ?? '') || a.code.localeCompare(b.code)),
    [list.data],
  );
  return (
    <section className={s.card}>
      <div className={s.cardHead}>
        <div>
          <h2 className={s.cardTitle}>Weekly status updates</h2>
          <p className={s.cardSub}>
            One update per product: health, readiness, progress and the next step. Posting it updates the dashboard. Products with no update in {options.settings.staleDays} days show &quot;No update&quot;.
          </p>
        </div>
        <div style={{ width: 240 }}>
          <Select label="Owner" multiSelect searchable options={options.owners.map((o) => ({ value: o, label: o }))} value={owners} onChange={setOwners} />
        </div>
      </div>
      {list.error && <ErrorState message={list.error} onRetry={list.retry} />}
      {!list.data && !list.error && <LoadingSkeleton variant="table" />}
      {list.data && rows.length === 0 && <EmptyState message="No active product." />}
      {rows.length > 0 && (
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead><tr><th>Product</th><th>Owner</th><th>Health</th><th>Readiness</th><th>Last update</th><th /></tr></thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.code}>
                  <td><button type="button" className={s.linkBtn} onClick={() => open({ code: p.code })}>{p.name}</button><span className={s.sub}>{p.code} · {lookup.label('stage', p.stage)}</span></td>
                  <td>{p.ownerName ?? <span className={s.muted}>—</span>}</td>
                  <td><HealthChip code={p.health} lookup={lookup} /></td>
                  <td><Readiness pct={p.readinessPct} /></td>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtDay(p.lastUpdateAt) || 'Never'}{p.stale && <span className={s.stale} style={{ display: 'block' }}>No update</span>}</td>
                  <td style={{ textAlign: 'end' }}>{canCreate(ENTRY) && <Button variant="secondary" onClick={() => open({ code: p.code, start: 'update' })}>Post update</Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------------

const STATUS_LABEL: Record<BlockerStatus, string> = { OPEN: 'Open', IN_PROGRESS: 'In progress', RESOLVED: 'Resolved', CANCELLED: 'Cancelled' };

function BlockersTab({ options, revision, refresh, open }: TabProps) {
  const { canCreate } = useAuth();
  const [statuses, setStatuses] = useState<string[]>(['OPEN', 'IN_PROGRESS']);
  const [owners, setOwners] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const q = new URLSearchParams();
  if (statuses.length) q.set('status', statuses.join(','));
  if (owners.length) q.set('owners', owners.join(','));
  const list = usePdp<{ rows: BlockerRow[] }>(`${TRACKER}/blockers?${q.toString()}`, revision);
  const products = useProducts(EMPTY_FILTERS, revision);
  const choices = (products.data?.rows ?? []).filter((p) => p.active).map((p) => ({ code: p.code, name: p.name }));
  return (
    <section className={s.card}>
      <div className={s.cardHead}>
        <div>
          <h2 className={s.cardTitle}>Blockers &amp; decisions</h2>
          <p className={s.cardSub}>An open Blocker sets its product to Blocked. Resolving needs a note; when the last Blocker closes, the owner sets the new health.</p>
        </div>
        {canCreate(ENTRY) && !adding && <Button onClick={() => setAdding(true)} disabled={choices.length === 0}>Add blocker / decision</Button>}
      </div>
      <div className={s.toolbar} style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ width: 220 }}>
            <Select label="Status" multiSelect options={(Object.keys(STATUS_LABEL) as BlockerStatus[]).map((k) => ({ value: k, label: STATUS_LABEL[k] }))} value={statuses} onChange={setStatuses} />
          </div>
          <div style={{ width: 220 }}>
            <Select label="Owner" multiSelect searchable options={options.owners.map((o) => ({ value: o, label: o }))} value={owners} onChange={setOwners} />
          </div>
        </div>
      </div>
      {notice && <div className={s.badge} role="status" style={{ padding: '8px 10px', fontSize: 13, marginBottom: 12 }}>{notice}</div>}
      {adding && (
        <div className={s.card} style={{ marginBottom: 16 }}>
          <BlockerForm
            options={options}
            products={choices}
            onSaved={(r) => {
              setAdding(false);
              setNotice(r.healthForced ? `${r.blocker.productCode ?? 'The product'} is now Blocked: it has an open Blocker.` : 'Added.');
              refresh();
            }}
            onCancel={() => setAdding(false)}
          />
        </div>
      )}
      {list.error && <ErrorState message={list.error} onRetry={list.retry} />}
      {!list.data && !list.error && <LoadingSkeleton variant="table" />}
      {list.data && list.data.rows.length === 0 && <EmptyState message="Nothing matches." />}
      {list.data && list.data.rows.length > 0 && (
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead><tr><th>Item</th><th>Product</th><th>Owner</th><th>Due</th><th>Status</th></tr></thead>
            <tbody>
              {[...list.data.rows].sort((a, b) => Number(Boolean(b.overdue)) - Number(Boolean(a.overdue)) || a.dueDate.localeCompare(b.dueDate)).map((b) => (
                <tr key={b.blockerId} className={s.rowLink} tabIndex={0} onClick={() => b.productCode && open({ code: b.productCode })} onKeyDown={(e) => e.key === 'Enter' && b.productCode && open({ code: b.productCode })}>
                  <td>
                    <Chip color={b.kind === 'BLOCKER' ? 'var(--ps-color-alert)' : 'var(--ps-color-gold, #c4892f)'}>{b.kind === 'BLOCKER' ? 'Blocker' : 'Decision'}</Chip>{' '}
                    <b>{b.title}</b>
                    <span className={s.sub}>{b.externalId ? `${b.externalId} · ` : ''}{b.requiredAction}</span>
                  </td>
                  <td>{b.productName}<span className={s.sub}>{b.productCode}</span></td>
                  <td>{b.ownerName ?? <span className={s.muted}>—</span>}</td>
                  <td style={{ whiteSpace: 'nowrap' }} className={b.overdue ? s.error : undefined}>{fmtDay(b.dueDate)}{b.overdue ? ' · Overdue' : ''}</td>
                  <td>{STATUS_LABEL[b.status]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------------

const KIND_LABEL: Record<FollowupKind, string> = {
  BLOCKER_OVERDUE: 'Overdue blocker / decision',
  BLOCKER_DUE_SOON: 'Blocker / decision due soon',
  NEXT_STEP_OVERDUE: 'Next step overdue',
  STALE: 'No update',
  LAUNCH_AT_RISK: 'Launch soon, low readiness',
};
const KIND_COLOR: Record<FollowupKind, string> = {
  BLOCKER_OVERDUE: 'var(--ps-color-alert)',
  NEXT_STEP_OVERDUE: 'var(--ps-color-alert)',
  BLOCKER_DUE_SOON: 'var(--ps-color-gold, #c4892f)',
  LAUNCH_AT_RISK: 'var(--ps-color-gold, #c4892f)',
  STALE: 'var(--ps-color-muted-text)',
};

function FollowupTab({ options, revision, open }: TabProps) {
  const { token } = useAuth();
  const [owners, setOwners] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const filters: Filters = { ...EMPTY_FILTERS, owners, search };
  const query = filterQuery(filters);
  const board = usePdp<{ today: string; items: FollowupItem[]; settings: Options['settings'] }>(`${TRACKER}/followup${query}`, revision);
  const st = options.settings;
  const columns: ExportColumn<FollowupItem>[] = [
    { header: 'What', value: (i) => KIND_LABEL[i.kind] },
    { header: 'Product', value: (i) => `${i.productCode} ${i.productName}` },
    { header: 'Owner', value: (i) => i.ownerName ?? '' },
    { header: 'Item', value: (i) => i.title },
    { header: 'Date', value: (i) => i.date ?? '', text: (i) => fmtDay(i.date) },
    { header: 'Days', align: 'right', value: (i) => i.days, text: (i) => daysText(i) },
  ];
  return (
    <section className={s.card} data-testid="pdt-followup">
      <div className={s.cardHead}>
        <div>
          <h2 className={s.cardTitle}>Follow-up board {board.data && <span className={`${s.badge} ${s.badgeWarn}`}>{board.data.items.length}</span>}</h2>
          <p className={s.cardSub}>
            Blockers / decisions overdue or due within {st.followupDueSoonDays} days · overdue next steps · no update in {st.staleDays} days · launches within {st.launchSoonDays} days below {st.launchSoonMinReadiness}% readiness.
          </p>
        </div>
        <ExportButtons
          onXlsx={() => trackerDownload(`/followup/export${query}`, token, 'product-development-followup.xlsx')}
          onPdf={() => board.data ? exportProductPdf({ title: 'Product Development Plan — Follow-up board', subtitle: `As of ${fmtDay(board.data.today)}`, fileName: 'product-development-followup', columns, rows: board.data.items, filterParts: owners.length ? [`Owner: ${owners.join(', ')}`] : [] }) : undefined}
        />
      </div>
      <div className={s.toolbar} style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
          <div style={{ width: 240 }}>
            <Select label="Owner" multiSelect searchable options={options.owners.map((o) => ({ value: o, label: o }))} value={owners} onChange={setOwners} />
          </div>
          <div style={{ width: 240 }}>
            <label className={s.fieldLabel} htmlFor="pdt-fu-search">Product</label>
            <input id="pdt-fu-search" className={s.search} type="search" placeholder="Name or code" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
      </div>
      {board.error && <ErrorState message={board.error} onRetry={board.retry} />}
      {!board.data && !board.error && <LoadingSkeleton variant="table" />}
      {board.data && board.data.items.length === 0 && <EmptyState message="Nothing needs action right now." />}
      {board.data && board.data.items.length > 0 && (
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead><tr><th>What</th><th>Product</th><th>Owner</th><th>Item</th><th>Date</th><th /></tr></thead>
            <tbody>
              {board.data.items.map((i, n) => (
                <tr key={`${i.kind}-${i.productId}-${i.refId ?? n}`} className={s.rowLink} tabIndex={0} onClick={() => open({ code: i.productCode })} onKeyDown={(e) => e.key === 'Enter' && open({ code: i.productCode })}>
                  <td><Chip color={KIND_COLOR[i.kind]}>{KIND_LABEL[i.kind]}</Chip></td>
                  <td>{i.productName}<span className={s.sub}>{i.productCode}</span></td>
                  <td>{i.ownerName ?? <span className={s.muted}>—</span>}</td>
                  <td>{i.title}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtDay(i.date) || '—'}</td>
                  <td style={{ whiteSpace: 'nowrap' }} className={i.days > 0 && i.kind !== 'STALE' ? s.error : s.muted}>{daysText(i)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function daysText(i: FollowupItem): string {
  if (i.kind === 'STALE') return `${i.days} days since update`;
  if (i.days > 0) return `${i.days} day${i.days === 1 ? '' : 's'} late`;
  if (i.days === 0) return 'Due today';
  return `in ${-i.days} day${i.days === -1 ? '' : 's'}`;
}
