'use client';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Button, EmptyState, ErrorState, LoadingSkeleton } from '@07ps/ui';
import { useAuth } from '../../lib/AuthProvider';
import { BASE, ENTRY } from '../../lib/pdp/api';
import { usePdp } from '../../lib/pdp/hooks';
import { EMPTY_FILTERS, NOT_SET, TRACKER, filterQuery, trackerDownload, type Dashboard as DashboardData, type Filters, type FlagCode, type Options, type Product, type StageCode } from '../../lib/pdt/api';
import { ExportButtons, exportProductPdf, type ExportColumn } from '../product/ProductUi';
import { FilterBar, HealthChip, PriorityText, Readiness, StageChip, countActive, fmtDay, fmtMonth, useLookup, type Lookup } from './common';
import { ProductDrawer } from './ProductDrawer';
import { StageDetail, StageTiles, stageFromParam, stageToParam, useEscToClose } from './StageSummary';
import s from './Pdt.module.css';

type SortKey = 'product' | 'family' | 'stage' | 'owner' | 'priority' | 'health' | 'readiness' | 'target' | 'flag';
const PRIORITY_ORDER: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
const HEALTH_ORDER: Record<string, number> = { BLOCKED: 0, AT_RISK: 1, ON_TRACK: 2 };
const FLAG_ORDER: Record<FlagCode, number> = { OPEN_BLOCKER: 0, TARGET_PASSED: 1, LAUNCH_SOON_LOW_READINESS: 2, HEALTH_NOT_SET: 3 };
const FLAG_CLASS: Record<FlagCode, string> = { OPEN_BLOCKER: s.flagAlert, TARGET_PASSED: s.flagAlert, LAUNCH_SOON_LOW_READINESS: s.flagWatch, HEALTH_NOT_SET: s.flagMuted };

/** The ?stage= of the current URL (deep link to an open stage). */
function stageInUrl(): StageCode | null {
  if (typeof window === 'undefined') return null;
  return stageFromParam(new URLSearchParams(window.location.search).get('stage'));
}

const nullLast = (v: number | undefined) => (v === undefined ? 99 : v);

function sorter(key: SortKey, lookup: Lookup): (a: Product, b: Product) => number {
  const stageIdx = (c: StageCode) => lookup.stages.findIndex((x) => x.code === c);
  switch (key) {
    case 'product': return (a, b) => a.name.localeCompare(b.name);
    case 'family': return (a, b) => (a.family ?? '~').localeCompare(b.family ?? '~') || (a.subfamily ?? '').localeCompare(b.subfamily ?? '');
    case 'stage': return (a, b) => stageIdx(a.stage) - stageIdx(b.stage);
    case 'owner': return (a, b) => (a.ownerName ?? '~').localeCompare(b.ownerName ?? '~');
    case 'priority': return (a, b) => nullLast(PRIORITY_ORDER[a.priority ?? '']) - nullLast(PRIORITY_ORDER[b.priority ?? '']);
    case 'health': return (a, b) => nullLast(HEALTH_ORDER[a.health ?? '']) - nullLast(HEALTH_ORDER[b.health ?? '']);
    case 'readiness': return (a, b) => (a.readinessPct ?? -1) - (b.readinessPct ?? -1);
    case 'flag': return (a, b) => nullLast(a.flag ? FLAG_ORDER[a.flag] : undefined) - nullLast(b.flag ? FLAG_ORDER[b.flag] : undefined);
    // Active pipeline by target date first; launched products (no target) after, by launch date.
    default: return (a, b) => Number(a.stage === 'LAUNCHED') - Number(b.stage === 'LAUNCHED') || (a.targetLaunch ?? a.actualLaunch ?? '9999').localeCompare(b.targetLaunch ?? b.actualLaunch ?? '9999');
  }
}

const yesterday = (today: string) => new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/**
 * Product → Product Development Plan (landing page): which products we have, where each one stands in the pipeline, and
 * what needs attention -- the draft in Input/product_development_draft, on the real Xtreme products (Excel import).
 * Read with product_development_plan View; clicking a product opens the drawer (editable with product_development_entry
 * Edit; the stage is changed there, with a comment). Every section follows the filters; clicking a stage tile, a matrix
 * cell or a gap line sets them. The open stage is in the URL (?stage=development).
 */
export function TrackerDashboard({ options, revision, refresh }: { options: Options; revision: number; refresh: () => void }) {
  const { token, canView } = useAuth();
  const lookup = useLookup(options);
  const [filters, setFilters] = useState<Filters>(() => {
    const st = stageInUrl();
    return st ? { ...EMPTY_FILTERS, stages: [st] } : EMPTY_FILTERS;
  });
  const [open, setOpen] = useState<{ code: string } | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'target', dir: 1 });
  const [showTracker, setShowTracker] = useState(false);
  const query = filterQuery(filters);
  const dash = usePdp<DashboardData>(`${TRACKER}/dashboard${query}`, revision);
  const d = dash.data;

  // One open stage = exactly one stage in the Stage filter (several picked in the filter bar = none open).
  const selected = filters.stages.length === 1 ? (filters.stages[0] as StageCode) : null;
  const selectStage = useCallback((stage: StageCode | null) => setFilters((f) => ({ ...f, stages: stage ? [stage] : [] })), []);
  const closeStage = useCallback(() => selectStage(null), [selectStage]);
  useEscToClose(selected !== null && open === null, closeStage);
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      const p = stageToParam(selected);
      if (p) url.searchParams.set('stage', p);
      else url.searchParams.delete('stage');
      if (url.toString() !== window.location.href) window.history.replaceState(null, '', url.toString());
    } catch {
      /* the URL is a convenience only */
    }
  }, [selected]);

  const rows = useMemo(() => {
    if (!d) return [];
    const cmp = sorter(sort.key, lookup);
    return [...d.tracker].sort((a, b) => sort.dir * cmp(a, b) || a.code.localeCompare(b.code, undefined, { numeric: true }));
  }, [d, sort, lookup]);

  const only = (key: 'stages' | 'familyIds', v: string) => (f: Filters) => (f[key].length === 1 && f[key][0] === v ? [] : [v]);
  const focusFamily = (id: number | null) => id !== null && setFilters((f) => ({ ...f, familyIds: only('familyIds', String(id))(f) }));
  const focusCell = (id: number | null, stage: StageCode) =>
    id !== null &&
    setFilters((f) => {
      const same = f.familyIds.length === 1 && f.familyIds[0] === String(id) && f.stages.length === 1 && f.stages[0] === stage;
      return { ...f, familyIds: same ? [] : [String(id)], stages: same ? [] : [stage] };
    });
  const activeStages = lookup.stages.filter((x) => x.code !== 'LAUNCHED').map((x) => x.code as string);

  const th = (key: SortKey, label: string) => (
    <th aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button type="button" onClick={() => setSort((x) => ({ key, dir: x.key === key ? (x.dir === 1 ? -1 : 1) : 1 }))}>
        {label}
        {sort.key === key ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}
      </button>
    </th>
  );

  const columns: ExportColumn<Product>[] = [
    { header: 'Code', value: (p) => p.code },
    { header: 'Product', value: (p) => p.name },
    { header: 'Family', value: (p) => p.family ?? '' },
    { header: 'Subfamily', value: (p) => p.subfamily ?? '' },
    { header: 'Stage', value: (p) => lookup.label('stage', p.stage) },
    { header: 'Owner', value: (p) => p.ownerName ?? '' },
    { header: 'Priority', value: (p) => lookup.label('priority', p.priority) },
    { header: 'Health', value: (p) => (p.health ? lookup.label('health', p.health) : 'Not set') },
    { header: 'Readiness %', align: 'right', value: (p) => p.readinessPct ?? '', text: (p) => (p.readinessPct === null ? '—' : `${p.readinessPct}%`) },
    { header: 'Target launch', value: (p) => p.targetLaunch ?? '', text: (p) => fmtDay(p.targetLaunch) },
    { header: 'Flag', value: (p) => p.flagLabel ?? '' },
  ];
  const filterParts = () => {
    const parts: string[] = [];
    const lbl = (list: 'stage' | 'health' | 'priority', v: string) => (v === NOT_SET ? 'Not set' : lookup.label(list, v));
    if (filters.familyIds.length) parts.push(`Family: ${filters.familyIds.map((id) => lookup.families.find((f) => String(f.value_id) === id)?.label).join(', ')}`);
    if (filters.subfamilies.length) parts.push(`Subfamily: ${filters.subfamilies.join(', ')}`);
    if (filters.stages.length) parts.push(`Stage: ${filters.stages.map((c) => lbl('stage', c)).join(', ')}`);
    if (filters.health.length) parts.push(`Health: ${filters.health.map((c) => lbl('health', c)).join(', ')}`);
    if (filters.owners.length) parts.push(`Owner: ${filters.owners.map((o) => (o === NOT_SET ? 'No owner' : o)).join(', ')}`);
    if (filters.priorities.length) parts.push(`Priority: ${filters.priorities.map((c) => lbl('priority', c)).join(', ')}`);
    if (filters.launchFrom || filters.launchTo) parts.push(`Target launch: ${fmtDay(filters.launchFrom) || '…'} – ${fmtDay(filters.launchTo) || '…'}`);
    if (filters.search.trim()) parts.push(`Search: ${filters.search.trim()}`);
    return parts;
  };

  const currentYear = Number((d?.today ?? options.today).slice(0, 4));
  const maxYear = d ? Math.max(1, ...d.byYear.map((y) => y.launched + y.planned)) : 1;

  return (
    <div className={s.stack} data-testid="pdt-dashboard">
      <FilterBar filters={filters} onChange={setFilters} lookup={lookup} options={options} />

      {dash.error && <ErrorState message={dash.error} onRetry={dash.retry} />}
      {!d && !dash.error && <LoadingSkeleton variant="kpi" />}

      {d && d.totalProducts === 0 && (
        <EmptyState message="No products yet. Upload the Product Development Excel file (or add products) under Data entry & follow-up." />
      )}
      {d && d.totalProducts === 0 && canView(ENTRY) && (
        <div><Link className={s.linkBtn} href={`${BASE}/entry?tab=import`}>Go to Excel import →</Link></div>
      )}

      {d && d.totalProducts > 0 && (
        <>
          <div className={s.kpis} data-testid="pdt-kpis">
            <Kpi label="Total products" value={d.kpis.total} foot="Xtreme portfolio, every stage" />
            <Kpi label="In market" value={d.kpis.inMarket} foot="Launched" tone="good" />
            <Kpi label="Active in pipeline" value={d.kpis.active} foot="Idea to launch ready">
              <div className={s.kpiGaps}>
                <button type="button" className={s.kpiGap} onClick={() => setFilters({ ...EMPTY_FILTERS, stages: activeStages, launchTo: yesterday(d.today) })}>
                  <span>Target date passed</span> <b>{d.kpis.targetPassed}</b>
                </button>
                <button type="button" className={s.kpiGap} onClick={() => setFilters({ ...EMPTY_FILTERS, stages: activeStages, health: [NOT_SET] })}>
                  <span>Health not set</span> <b>{d.kpis.healthNotSet}</b>
                </button>
              </div>
            </Kpi>
            <Kpi label="On track" value={d.kpis.onTrack} foot="Active products on plan" />
            <Kpi label="Need attention" value={d.kpis.needAttention} foot="At risk or blocked" tone={d.kpis.needAttention > 0 ? 'warn' : undefined} />
            <Kpi label="Launches in next 90 days" value={d.kpis.upcomingLaunches} foot={`Target within ${d.settings.upcomingWindowDays} days`} />
          </div>

          <section className={s.card} data-testid="pdt-pipeline">
            <div className={s.cardHead}>
              <div>
                <h2 className={s.cardTitle}>Product stage pipeline</h2>
                <p className={s.cardSub}>Select a stage to see its products and focus the dashboard.</p>
              </div>
              <span className={s.hint}>● Idea → validated product → launch</span>
            </div>
            <StageTiles tiles={d.stageSummary.stages} totals={d.stageSummary.totals} selected={selected} onSelect={selectStage} />
            {selected && (
              <StageDetail
                key={selected}
                tile={d.stageSummary.stages.find((x) => x.stage === selected)!}
                products={d.tracker.filter((p) => p.stage === selected)}
                lookup={lookup}
                onClose={closeStage}
                onOpenProduct={(code) => setOpen({ code })}
              />
            )}
          </section>
          <section className={s.card} data-testid="pdt-matrix">
            <div className={s.cardHead}>
              <div>
                <h2 className={s.cardTitle}>Where we stand</h2>
                <p className={s.cardSub}>Products by family and stage. Click a number to focus the page on it; click a family to see only that family.</p>
              </div>
              <span className={s.badge}>{d.matrix.total} products</span>
            </div>
            <div className={s.tableWrap} style={{ margin: 0 }}>
              <table className={s.matrix}>
                <thead>
                  <tr>
                    <th scope="col">Family</th>
                    {lookup.stages.map((st) => <th key={st.code} scope="col">{st.label}</th>)}
                    <th scope="col">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {d.matrix.rows.map((r) => {
                    const famActive = filters.familyIds.length === 1 && filters.familyIds[0] === String(r.familyId);
                    return (
                      <tr key={r.familyId ?? 'none'}>
                        <td>
                          <button type="button" className={s.familyBtn} onClick={() => focusFamily(r.familyId)} aria-pressed={famActive} title={lookup.families.find((f) => f.value_id === r.familyId)?.description ?? undefined}>
                            <span className={s.dot} style={{ background: lookup.familyColor(r.familyId) }} />
                            {r.family}
                          </button>
                        </td>
                        {lookup.stages.map((st) => {
                          const n = r.counts[st.code as StageCode] ?? 0;
                          const active = famActive && filters.stages.length === 1 && filters.stages[0] === st.code;
                          return (
                            <td key={st.code}>
                              {n === 0 ? (
                                <span className={`${s.cell} ${s.cellZero}`}>·</span>
                              ) : (
                                <button
                                  type="button"
                                  className={`${s.cell}${active ? ` ${s.cellActive}` : ''}`}
                                  style={{ background: `color-mix(in srgb, ${st.color} ${Math.min(14 + n * 6, 46)}%, transparent)` }}
                                  onClick={() => focusCell(r.familyId, st.code as StageCode)}
                                  aria-label={`${r.family}, ${st.label}: ${n}`}
                                >
                                  {n}
                                </button>
                              )}
                            </td>
                          );
                        })}
                        <td><b>{r.total}</b></td>
                      </tr>
                    );
                  })}
                  <tr className={s.totalRow}>
                    <td>Total</td>
                    {lookup.stages.map((st) => <td key={st.code}>{d.matrix.totals[st.code as StageCode] ?? 0}</td>)}
                    <td>{d.matrix.total}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <div className={s.twoCol}>
            <section className={s.card} data-testid="pdt-roadmap">
              <div className={s.cardHead}>
                <div>
                  <h2 className={s.cardTitle}>Launch roadmap</h2>
                  <p className={s.cardSub}>Upcoming target launches · grouped by month</p>
                </div>
                <span className={s.badge}>NEXT {d.settings.roadmapMonths} MONTHS</span>
              </div>
              <div className={s.roadmap}>
                {d.roadmap.months.map((m) => (
                  <div key={m.month} className={s.month}>
                    <div className={s.monthName}>{fmtMonth(m.month)}</div>
                    {m.products.length === 0 && <span className={s.muted}>No launch</span>}
                    {m.products.map((p) => (
                      <button key={p.code} type="button" className={s.launch} onClick={() => setOpen({ code: p.code })}>
                        <b>{p.name}</b>
                        <span>{fmtDay(p.targetLaunch)}</span>
                        <span className={s.launchHealth}>{p.health ? lookup.label('health', p.health) : 'Health not set'}</span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
              <p className={s.footnote}>
                {d.roadmap.outsideWindow} active product(s) have target dates outside this window. Readiness is manually estimated.
              </p>
              <div className={s.years} data-testid="pdt-years" aria-label="Launches by year">
                {d.byYear.map((y) => (
                  <div key={y.year} className={`${s.year}${y.year === currentYear ? ` ${s.yearCurrent}` : ''}`} title={`${y.year}: ${y.launched} launched, ${y.planned} planned`}>
                    <b>{y.year}</b>
                    <div className={s.yearNums}>
                      <span className={s.launchedNum}>{y.launched} launched</span>
                    </div>
                    <div className={s.yearNums}>
                      <span className={s.plannedNum}>{y.planned} planned</span>
                    </div>
                    <div className={s.barTrack} style={{ width: '100%', marginTop: 6, display: 'flex' }}>
                      <span style={{ width: `${(y.launched / maxYear) * 100}%`, background: 'var(--ps-color-success)' }} />
                      <span style={{ width: `${(y.planned / maxYear) * 100}%`, background: 'var(--ps-color-accent)' }} />
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className={s.card} data-testid="pdt-blockers">
              <div className={s.cardHead}>
                <div>
                  <h2 className={s.cardTitle}>Blockers &amp; decisions</h2>
                  <p className={s.cardSub}>Actions that need attention to keep delivery moving.</p>
                </div>
                <span className={`${s.badge} ${s.badgeWarn}`}>{d.blockers.length} open</span>
              </div>
              <div className={s.items}>
                {d.blockers.length === 0 && (
                  <div className={s.item}>
                    <span className={s.muted}>Nothing open. Blockers and decisions come from the Excel file&apos;s &quot;Blockers &amp; decisions&quot; sheet or the product drawer.</span>
                  </div>
                )}
                {d.blockers.map((b) => (
                  <div key={b.blockerId} className={`${s.item} ${s.itemLink}${b.overdue ? ` ${s.itemOverdue}` : ''}`} role="button" tabIndex={0} onClick={() => b.productCode && setOpen({ code: b.productCode })} onKeyDown={(e) => e.key === 'Enter' && b.productCode && setOpen({ code: b.productCode })}>
                    <span className={`${s.itemIcon}${b.overdue ? ` ${s.itemIconOverdue}` : ''}`} aria-hidden>!</span>
                    <div>
                      <div className={s.itemTitle}>{b.title}</div>
                      <div className={s.itemMeta}>
                        {b.productName} · {b.ownerName ?? 'No owner'} · Due {fmtDay(b.dueDate)}{b.overdue ? ' · Overdue' : ''}
                      </div>
                      <div className={s.itemAction}>{b.requiredAction}</div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>

          {!showTracker && (
            <div className={s.trackerToggle}>
              <Button variant="secondary" onClick={() => setShowTracker(true)} data-testid="pdt-show-tracker">
                Show all products ({rows.length})
              </Button>
            </div>
          )}
          {showTracker && (
          <section className={s.card} data-testid="pdt-tracker">
            <div className={s.cardHead}>
              <div>
                <h2 className={s.cardTitle}>
                  Product tracker <span className={s.badge}>{rows.length} product{rows.length === 1 ? '' : 's'}</span>
                </h2>
                <p className={s.cardSub}>Ownership, readiness and next steps across the portfolio.</p>
              </div>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <span className={s.hint}>All sections follow the filters above{countActive(filters) ? ` (${countActive(filters)} active)` : ''}</span>
                <ExportButtons
                  onXlsx={() => trackerDownload(`/dashboard/export${query}`, token, 'product-development-dashboard.xlsx')}
                  onPdf={() => exportProductPdf({ title: 'Product Development Plan — Product tracker', subtitle: `As of ${fmtDay(d.today)}`, fileName: 'product-development-tracker', columns, rows, filterParts: filterParts() })}
                />
              </div>
            </div>
            <div className={s.tableWrap}>
              <table className={s.table}>
                <thead>
                  <tr>
                    {th('product', 'Product')}
                    {th('family', 'Family')}
                    {th('stage', 'Stage')}
                    {th('owner', 'Owner')}
                    {th('priority', 'Priority')}
                    {th('health', 'Health')}
                    {th('readiness', 'Readiness')}
                    {th('target', 'Target launch')}
                    {th('flag', 'Flag')}
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr><td colSpan={9} className={s.muted}>No product matches the filters.</td></tr>
                  )}
                  {rows.map((p) => (
                    <tr key={p.code} className={s.rowLink} onClick={() => setOpen({ code: p.code })} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setOpen({ code: p.code })}>
                      <td>
                        <b>{p.name}</b>
                        <span className={s.sub}>{p.code}</span>
                      </td>
                      <td>
                        {p.family ?? '—'}
                        <span className={s.sub}>{p.subfamily}</span>
                      </td>
                      <td><StageChip code={p.stage} lookup={lookup} /></td>
                      <td>{p.ownerName ?? <span className={s.muted}>—</span>}</td>
                      <td><PriorityText code={p.priority} lookup={lookup} /></td>
                      <td><HealthChip code={p.health} lookup={lookup} /></td>
                      <td><Readiness pct={p.readinessPct} /></td>
                      <td style={{ whiteSpace: 'nowrap' }}>{p.stage === 'LAUNCHED' ? <span className={s.muted}>{fmtDay(p.actualLaunch)}</span> : fmtDay(p.targetLaunch) || '—'}</td>
                      <td>{p.flag ? <span className={`${s.flag} ${FLAG_CLASS[p.flag]}`}>{p.flagLabel}</span> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          )}
        </>
      )}

      {open && (
        <ProductDrawer
          key={open.code}
          code={open.code}
          options={options}
          lookup={lookup}
          onClose={() => setOpen(null)}
          onChanged={refresh}
        />
      )}
    </div>
  );
}

function Kpi({ label, value, foot, tone, children }: { label: string; value: number; foot: string; tone?: 'warn' | 'good'; children?: React.ReactNode }) {
  return (
    <div className={s.kpi}>
      <div className={s.kpiLabel}>{label}</div>
      <div className={`${s.kpiValue}${tone === 'warn' ? ` ${s.kpiWarn}` : tone === 'good' ? ` ${s.kpiGood}` : ''}`}>{value}</div>
      <div className={s.kpiFoot}>{foot}</div>
      {children}
    </div>
  );
}
