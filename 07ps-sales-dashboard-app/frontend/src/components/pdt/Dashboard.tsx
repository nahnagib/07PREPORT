'use client';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ChartPanel, EmptyState, ErrorState, GroupedBarChart, KpiTile, LoadingSkeleton, type GroupedBarChartPoint, type SemanticStatus } from '@07ps/ui';
import { useAuth } from '../../lib/AuthProvider';
import { BASE, ENTRY } from '../../lib/pdp/api';
import { usePdp } from '../../lib/pdp/hooks';
import { TRACKER, filterQuery, trackerDownload, type Dashboard as DashboardData, type Filters, type KpiKey, type Options, type Product, type StageCode, EMPTY_FILTERS } from '../../lib/pdt/api';
import { ExportButtons } from '../product/ProductUi';
import { FilterBar, fmtDay, fmtMonth, fmtStamp, useLookup } from './common';
import { DrillModal } from './DrillModal';
import { ProductDrawer } from './ProductDrawer';
import { stageFromParam, stageToParam } from './StageSummary';
import s from './Pdt.module.css';

/** What the open details table shows. */
type Drill =
  | { kind: 'kpi'; key: KpiKey }
  | { kind: 'stage'; stage: StageCode }
  | { kind: 'family'; familyId: number | null; family: string; stage?: StageCode }
  | { kind: 'year'; year: number };

const KPI_LABEL: Record<KpiKey, string> = {
  total: 'Total products',
  inMarket: 'In market',
  active: 'Active',
  planned: 'Planned',
  onTrack: 'On track',
  needAttention: 'Need attention',
  upcomingLaunches: 'Launches in next 90 days',
  healthNotSet: 'Health not set',
};

/** The ?stage= of the current URL (deep link to a stage). */
function stageInUrl(): StageCode | null {
  if (typeof window === 'undefined') return null;
  return stageFromParam(new URLSearchParams(window.location.search).get('stage'));
}

const pct = (n: number, total: number) => (total > 0 ? Math.round((n / total) * 100) : 0);

/**
 * Product → Product Development Plan (dashboard tab). Read with product_development_plan View.
 *   Row 1 (portfolio): Total = In market + Active (target within 12 months) + Planned (no date, > 12 months, date passed).
 *   Row 2 (status, not-launched products): On track, Need attention, Launches in next 90 days (+ "Health not set" note).
 *   Charts: development stage pipeline, where we stand (family x stage), launch roadmap (= the 90-day card), launches by
 *   year, open blockers & decisions.
 * Every card, stage, family segment and year opens the details table (DrillModal) of its products; a row opens the product
 * drawer. Everything follows the filters (backend applies them; the drill-downs use the same filtered set). A stage click
 * also sets the Stage filter (?stage= in the URL).
 */
export function TrackerDashboard({ options, revision, refresh }: { options: Options; revision: number; refresh: () => void }) {
  const { token, canView } = useAuth();
  const lookup = useLookup(options);
  const [filters, setFilters] = useState<Filters>(() => {
    const st = stageInUrl();
    return st ? { ...EMPTY_FILTERS, stages: [st] } : EMPTY_FILTERS;
  });
  const [drill, setDrill] = useState<Drill | null>(() => {
    const st = stageInUrl();
    return st ? { kind: 'stage', stage: st } : null;
  });
  const [open, setOpen] = useState<{ code: string } | null>(null);
  const [matrixTable, setMatrixTable] = useState(false);
  const query = filterQuery(filters);
  const dash = usePdp<DashboardData>(`${TRACKER}/dashboard${query}`, revision);
  const d = dash.data;

  // One selected stage = exactly one stage in the Stage filter; kept in the URL (?stage=development).
  const selected = filters.stages.length === 1 ? (filters.stages[0] as StageCode) : null;
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

  const byCode = useMemo(() => new Map((d?.tracker ?? []).map((p) => [p.code, p])), [d]);
  const closeDrill = useCallback(() => setDrill(null), []);

  /** Clicking a stage filters the page on it and opens its products; clicking the selected stage again clears both. */
  const clickStage = (stage: StageCode) => {
    if (selected === stage) {
      setFilters((f) => ({ ...f, stages: [] }));
      setDrill(null);
      return;
    }
    setFilters((f) => ({ ...f, stages: [stage] }));
    setDrill({ kind: 'stage', stage });
  };

  const drillView = useMemo((): { title: string; subtitle?: string; products: Product[]; file: string } | null => {
    if (!d || !drill) return null;
    const all = d.tracker;
    switch (drill.kind) {
      case 'kpi': {
        const codes = d.kpiCodes[drill.key] ?? [];
        const label = drill.key === 'upcomingLaunches' ? `Launches in next ${d.settings.upcomingWindowDays} days` : KPI_LABEL[drill.key];
        return { title: label, subtitle: KPI_RULE(d.settings.upcomingWindowDays)[drill.key], products: codes.map((c) => byCode.get(c)).filter((p): p is Product => Boolean(p)), file: `product-development-${drill.key}` };
      }
      case 'stage':
        return { title: `${lookup.label('stage', drill.stage)} stage`, products: all.filter((p) => p.stage === drill.stage), file: `product-development-stage-${stageToParam(drill.stage)}` };
      case 'family': {
        const inFamily = all.filter((p) => p.familyId === drill.familyId && (!drill.stage || p.stage === drill.stage));
        return { title: drill.stage ? `${drill.family} · ${lookup.label('stage', drill.stage)}` : drill.family, products: inFamily, file: 'product-development-family' };
      }
      case 'year':
        return {
          title: `Launches in ${drill.year}`,
          subtitle: 'Launched that year (actual launch date) and not launched yet with a target date that year.',
          products: all.filter((p) => (p.stage === 'LAUNCHED' ? p.actualLaunch : p.targetLaunch)?.startsWith(String(drill.year))),
          file: `product-development-launches-${drill.year}`,
        };
      default:
        return null;
    }
  }, [d, drill, byCode, lookup]);

  const kpiActive = (key: KpiKey) => drill?.kind === 'kpi' && drill.key === key;
  const kpi = (key: KpiKey, value: number, status: SemanticStatus, footnote?: string) => (
    <button
      key={key}
      type="button"
      className={`${s.kpiBtn}${kpiActive(key) ? ` ${s.kpiBtnActive}` : ''}`}
      aria-pressed={kpiActive(key)}
      onClick={() => setDrill(kpiActive(key) ? null : { kind: 'kpi', key })}
      data-testid={`pdt-kpi-${key}`}
    >
      <KpiTile label={key === 'upcomingLaunches' && d ? `Launches in next ${d.settings.upcomingWindowDays} days` : KPI_LABEL[key]} value={String(value)} status={status} footnote={footnote} />
    </button>
  );

  // ---- charts ----
  const stagePoints: GroupedBarChartPoint[] = (d?.stageSummary.stages ?? []).map((t) => ({ label: t.label, count: t.count, _stage: t.stage, _color: t.color, _overdue: t.overdue }));
  const stageTotal = d?.stageSummary.totals.total ?? 0;
  const stageOfLabel = (label: string) => d?.stageSummary.stages.find((t) => t.label === label)?.stage;
  const familyRows = (d?.matrix.rows ?? []).filter((r) => r.total > 0);
  const familyPoints: GroupedBarChartPoint[] = familyRows.map((r) => ({ label: r.family, ...r.counts, _total: r.total }));
  const familyOfLabel = (label: string) => familyRows.find((r) => r.family === label);
  const yearPoints: GroupedBarChartPoint[] = (d?.byYear ?? []).filter((y) => y.launched + y.planned > 0).map((y) => ({ label: String(y.year), launched: y.launched, planned: y.planned }));
  const roadmapCount = d ? d.roadmap.months.reduce((n, m) => n + m.products.length, 0) : 0;

  return (
    <div className={s.stack} data-testid="pdt-dashboard">
      <FilterBar filters={filters} onChange={setFilters} lookup={lookup} options={options} infoText={d ? `Last Excel import: ${d.lastImport ? fmtStamp(d.lastImport) : 'never'}` : undefined} />

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
          <div className={s.kpiBlock} data-testid="pdt-kpis">
            <div className={s.kpiHead}>
              <span className={s.kpiHint}>Click a card for its products</span>
              <ExportButtons label="dashboard" xlsxText="Export dashboard" onXlsx={() => trackerDownload(`/dashboard/export${query}`, token, 'product-development-dashboard.xlsx')} />
            </div>
            <div className={s.kpiRow} data-testid="pdt-kpi-portfolio">
              {kpi('total', d.kpis.total, 'neutral')}
              {kpi('inMarket', d.kpis.inMarket, 'success', 'Launched')}
              {kpi('active', d.kpis.active, 'neutral', 'Target within 12 months')}
              {kpi('planned', d.kpis.planned, 'neutral', `No date ${d.kpis.plannedNoDate} · >12 months ${d.kpis.plannedBeyond} · Date passed ${d.kpis.plannedPassed}`)}
            </div>
            <div className={s.kpiRow3} data-testid="pdt-kpi-status">
              {kpi('onTrack', d.kpis.onTrack, 'success', 'Not launched')}
              {kpi('needAttention', d.kpis.needAttention, d.kpis.needAttention > 0 ? 'watch' : 'neutral', 'At risk or blocked')}
              {kpi('upcomingLaunches', d.kpis.upcomingLaunches, 'neutral', 'Same as the roadmap')}
            </div>
            {d.kpis.healthNotSet > 0 && (
              <button type="button" className={`${s.noteBtn}${kpiActive('healthNotSet') ? ` ${s.noteBtnActive}` : ''}`} onClick={() => setDrill({ kind: 'kpi', key: 'healthNotSet' })} data-testid="pdt-health-not-set">
                Health not set: <b>{d.kpis.healthNotSet}</b>
              </button>
            )}
          </div>

          <div className={s.grid2}>
            <ChartPanel title="Development stage pipeline" style={PANEL} wrapHeader headerActions={<span className={s.badge}>{stageTotal} products</span>}>
              <div data-testid="pdt-pipeline">
                <GroupedBarChart
                  showTitle={false}
                  showLegend={false}
                  points={stagePoints}
                  bars={[{ key: 'count', name: 'Products', color: 'var(--ps-color-accent)' }]}
                  colorForPoint={(p) => ((p.count as number) > 0 ? (p._color as string) : `color-mix(in srgb, ${p._color as string} 30%, transparent)`)}
                  highlightedCategory={selected ? lookup.label('stage', selected) : null}
                  onCategoryClick={(label) => {
                    const st = stageOfLabel(label);
                    if (st) clickStage(st);
                  }}
                  endLabel={(p) => ({
                    text: `${p.count as number} · ${pct(p.count as number, stageTotal)}%`,
                    badge: (p._overdue as number) > 0 ? `${p._overdue as number} overdue` : undefined,
                    muted: (p.count as number) === 0,
                  })}
                  integerAxis
                  height={Math.max(200, stagePoints.length * 38)}
                  yAxisWidth={104}
                />
              </div>
            </ChartPanel>

            <ChartPanel
              title="Where we stand"
              style={PANEL}
              wrapHeader
              headerActions={
                <button type="button" className={s.toggleBtn} aria-pressed={matrixTable} onClick={() => setMatrixTable((x) => !x)} data-testid="pdt-matrix-toggle">
                  {matrixTable ? 'Chart view' : 'Table view'}
                </button>
              }
            >
              <div data-testid="pdt-matrix">
                {matrixTable ? (
                  <MatrixTable d={d} lookup={lookup} onCell={(familyId, family, stage) => setDrill({ kind: 'family', familyId, family, stage })} />
                ) : (
                  <GroupedBarChart
                    showTitle={false}
                    stacked
                    points={familyPoints}
                    bars={lookup.stages.map((st) => ({ key: st.code as string, name: st.label, color: st.color }))}
                    onBarClick={(label, stage) => {
                      const r = familyOfLabel(label);
                      if (r) setDrill({ kind: 'family', familyId: r.familyId, family: r.family, stage: stage as StageCode });
                    }}
                    onCategoryClick={(label) => {
                      const r = familyOfLabel(label);
                      if (r) setDrill({ kind: 'family', familyId: r.familyId, family: r.family });
                    }}
                    endLabel={(p) => ({ text: String(p._total) })}
                    endLabelWidth={40}
                    integerAxis
                    height={Math.max(220, familyPoints.length * 34 + 60)}
                    yAxisWidth={170}
                  />
                )}
              </div>
            </ChartPanel>

            <ChartPanel
              title="Launch roadmap"
              style={PANEL}
              wrapHeader
              headerActions={
                <button type="button" className={s.toggleBtn} onClick={() => setDrill({ kind: 'kpi', key: 'upcomingLaunches' })} data-testid="pdt-roadmap-all">
                  Next {d.settings.upcomingWindowDays} days · {roadmapCount} launch{roadmapCount === 1 ? '' : 'es'}
                </button>
              }
            >
              <div data-testid="pdt-roadmap">
                <div className={s.roadmap}>
                  {d.roadmap.months.map((m) => (
                    <div key={m.month} className={s.month}>
                      <div className={s.monthName}>{fmtMonth(m.month)}</div>
                      {m.products.length === 0 && <span className={s.muted}>—</span>}
                      {m.products.map((p) => (
                        <button key={p.code} type="button" className={s.launch} onClick={() => setOpen({ code: p.code })}>
                          <b>{p.name}</b>
                          <span>{fmtDay(p.targetLaunch)} · {p.health ? lookup.label('health', p.health) : 'Health not set'}</span>
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
                <p className={s.footnote}>
                  Target launch {fmtDay(d.today)} – {fmtDay(d.roadmap.windowEnd)}. {d.roadmap.outsideWindow} other product(s) have a target date outside this window.
                </p>
              </div>
            </ChartPanel>

            <ChartPanel title="Launches by year" style={PANEL} wrapHeader>
              <div data-testid="pdt-years">
                <GroupedBarChart
                  showTitle={false}
                  stacked
                  points={yearPoints}
                  bars={[
                    { key: 'launched', name: 'Launched', color: 'var(--ps-color-success)' },
                    { key: 'planned', name: 'Planned (target)', color: 'var(--ps-color-accent)' },
                  ]}
                  onCategoryClick={(label) => setDrill({ kind: 'year', year: Number(label) })}
                  showTotals
                  integerAxis
                  height={Math.max(200, yearPoints.length * 30 + 60)}
                  yAxisWidth={48}
                />
              </div>
            </ChartPanel>
          </div>

          <ChartPanel title="Blockers & decisions" style={PANEL} wrapHeader headerActions={<span className={`${s.badge} ${s.badgeWarn}`}>{d.blockers.length} open</span>}>
            <div className={s.items} data-testid="pdt-blockers">
              {d.blockers.length === 0 && <div className={s.item}><span className={s.muted}>Nothing open.</span></div>}
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
          </ChartPanel>
        </>
      )}

      {d && drillView && (
        <DrillModal
          key={JSON.stringify(drill)}
          title={drillView.title}
          subtitle={drillView.subtitle}
          products={drillView.products}
          lookup={lookup}
          today={d.today}
          fileName={drillView.file}
          onClose={closeDrill}
          onOpenProduct={(code) => setOpen({ code })}
          paused={open !== null}
        />
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

const PANEL: React.CSSProperties = { height: 'auto', padding: 'clamp(8px, calc(5vw - 12px), var(--ps-card-padding, 16px))' };

/** One line under the drill-down title: the card's rule. */
const KPI_RULE = (days: number): Record<KpiKey, string> => ({
  total: 'Every product, every stage. Total = In market + Active + Planned.',
  inMarket: 'Stage = Launched.',
  active: 'Not launched, target launch from today to today + 12 months.',
  planned: 'Not launched: no target date, target more than 12 months away, or target date already passed.',
  onTrack: 'Not launched, health = On track.',
  needAttention: 'Not launched, health = At risk or Blocked.',
  upcomingLaunches: `Not launched, target launch from today to today + ${days} days (the launch roadmap).`,
  healthNotSet: 'Not launched, health left blank.',
});

/** "Where we stand" as a table (the Table view toggle): families x stages, every non-zero cell opens its products. */
function MatrixTable({ d, lookup, onCell }: { d: DashboardData; lookup: ReturnType<typeof useLookup>; onCell: (familyId: number | null, family: string, stage?: StageCode) => void }) {
  return (
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
          {d.matrix.rows.map((r) => (
            <tr key={r.familyId ?? 'none'}>
              <td>
                <button type="button" className={s.familyBtn} onClick={() => onCell(r.familyId, r.family)}>
                  <span className={s.dot} style={{ background: lookup.familyColor(r.familyId) }} />
                  {r.family}
                </button>
              </td>
              {lookup.stages.map((st) => {
                const n = r.counts[st.code as StageCode] ?? 0;
                return (
                  <td key={st.code}>
                    {n === 0 ? (
                      <span className={`${s.cell} ${s.cellZero}`}>·</span>
                    ) : (
                      <button
                        type="button"
                        className={s.cell}
                        style={{ background: `color-mix(in srgb, ${st.color} ${Math.min(14 + n * 6, 46)}%, transparent)` }}
                        onClick={() => onCell(r.familyId, r.family, st.code as StageCode)}
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
          ))}
          <tr className={s.totalRow}>
            <td>Total</td>
            {lookup.stages.map((st) => <td key={st.code}>{d.matrix.totals[st.code as StageCode] ?? 0}</td>)}
            <td>{d.matrix.total}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
