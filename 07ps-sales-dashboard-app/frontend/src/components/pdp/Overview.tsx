'use client';
import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { ChartPanel, ComboChart, DataGrid, FunnelChart, Gauge, KpiTile, Select, type DataGridColumn, type SemanticStatus } from '@07ps/ui';
import { BASE, type Row } from '../../lib/pdp/api';
import { usePdp } from '../../lib/pdp/hooks';
import { copy as t, enumLabel, formatKpi, formatTarget, GATES, KPI_HELP, STATE_COLOR, STATUS_COLOR } from '../../lib/pdp/text';
import type { SectionProps } from './PdpPage';
import { Chip, Empty, Loaded, Notice, Section, fmtDate } from './ui';
import s from './PdpVisuals.module.css';

interface Kpi extends Row {
  code: string;
  label: string;
  value: number | null;
  target: number;
  comparator: string;
  unit: string;
  status: 'green' | 'red' | 'none';
  numerator: number | null;
  denominator: number | null;
  projectIds: number[];
}

const TILE_STATUS: Record<Kpi['status'], SemanticStatus> = { green: 'success', red: 'alert', none: 'neutral' };

/** The current quarter and the eight before / four after it, newest first. */
function quarterOptions(): { value: string; label: string }[] {
  const now = new Date();
  let y = now.getFullYear();
  let q = Math.floor(now.getMonth() / 3) + 1 + 4;
  while (q > 4) {
    q -= 4;
    y += 1;
  }
  const out: { value: string; label: string }[] = [];
  for (let i = 0; i < 13; i += 1) {
    out.push({ value: `${y}-Q${q}`, label: `${y} Q${q}` });
    q -= 1;
    if (q === 0) {
      q = 4;
      y -= 1;
    }
  }
  return out;
}

export function Overview({ revision }: SectionProps) {
  const quarters = useMemo(quarterOptions, []);
  const [quarter, setQuarter] = useState<string>(quarters[4].value);
  const [drill, setDrill] = useState<Kpi | null>(null);
  const overview = usePdp<Row>(`/overview?quarter=${quarter}`, revision);

  return (
    <>
      <div className={s.toolbar}>
        <div style={{ width: 200 }}>
          <Select label={t.overview.quarter} options={quarters} value={[quarter]} onChange={(v) => v[0] && (setQuarter(v[0]), setDrill(null))} />
        </div>
      </div>
      <Loaded state={overview} skeleton="kpi">
        {(d) => (
          <>
            {d.capacity.freezeActive && <Notice tone="watch">{t.overview.freeze}</Notice>}
            <div className={s.kpis} data-testid="pdp-kpis">
              {(d.kpis as Kpi[]).map((k) => (
                <button
                  key={k.code}
                  type="button"
                  className={`${s.kpiButton}${drill?.code === k.code ? ` ${s.kpiSelected}` : ''}`}
                  aria-pressed={drill?.code === k.code}
                  onClick={() => setDrill(drill?.code === k.code ? null : k)}
                >
                  <KpiTile
                    label={k.label}
                    value={formatKpi(k.value, k.unit)}
                    variance={formatTarget(k.target, k.comparator, k.unit)}
                    subValue={k.denominator !== null && k.numerator !== null && k.unit === 'pct' ? `${k.numerator} of ${k.denominator}` : k.status === 'none' ? 'No data this quarter' : undefined}
                    status={TILE_STATUS[k.status]}
                    help={KPI_HELP[k.code]}
                  />
                </button>
              ))}
            </div>
            {drill && <KpiDrill kpi={drill} revision={revision} />}
            <div className={s.two}>
              <Capacity c={d.capacity} />
              <ChartPanel title={t.overview.pipeline} help={{ definition: t.overview.pipelineHelp }}>
                <FunnelChart
                  showTitle={false}
                  height={300}
                  stages={[
                    ...GATES.filter((g) => g.key !== 'closed').map((g, i) => ({
                      id: g.key,
                      label: `${g.key} · ${g.name}`,
                      value: Number(d.funnel[g.key] ?? 0),
                      pct: null,
                      color: `color-mix(in srgb, var(--ps-color-accent) ${100 - i * 10}%, var(--ps-color-muted-bg))`,
                    })),
                    { id: 'launched', label: 'Launched', value: Number(d.funnel.launched ?? 0), pct: null, color: 'var(--ps-color-success)' },
                    { id: 'closed', label: 'Closed', value: Number(d.funnel.closed ?? 0), pct: null, color: 'var(--ps-color-muted-text)' },
                  ]}
                />
              </ChartPanel>
            </div>
            <Alerts alerts={d.alerts as Row[]} />
            <Portfolio rows={d.portfolio.byFamily as Row[]} byStatus={d.portfolio.byStatus as Row[]} />
          </>
        )}
      </Loaded>
    </>
  );
}

function Capacity({ c }: { c: Row }) {
  const status: SemanticStatus = c.active > c.max ? 'alert' : c.active === c.max ? 'watch' : 'success';
  const mixPoints = (c.mix.rows as Row[]).map((r) => ({ label: enumLabel(r.classification), actual: r.pct, target: r.target }));
  return (
    <Section title={t.overview.capacity} help={{ definition: t.overview.capacityHelp }} testId="pdp-capacity">
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center' }}>
        <Gauge actual={c.active} targetToDate={c.max} status={status} label={t.overview.capacity} valueLabel={`${c.active} / ${c.max}`} targetLabel={`max ${c.max}`} size={200} />
        <div style={{ fontSize: 13, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span>
            <strong>{c.active}</strong> active of <strong>{c.max}</strong>
          </span>
          <span style={{ color: 'var(--ps-color-muted-text)' }}>
            {t.overview.onHold}: <strong>{c.onHold}</strong>
          </span>
          {c.mix.reformulation > 0 && <span style={{ color: 'var(--ps-color-muted-text)' }}>Reformulation: {c.mix.reformulation}</span>}
        </div>
      </div>
      <div style={{ fontSize: 12.5, fontWeight: 700, margin: '12px 0 4px' }}>{t.overview.mix}</div>
      <ComboChart
        showTitle={false}
        points={mixPoints}
        bars={[
          { key: 'actual', name: 'Active share %', color: 'var(--ps-color-accent)' },
          { key: 'target', name: 'Target %', color: 'var(--ps-chart-target, var(--ps-color-muted-text))' },
        ]}
        leftAxisFormatter={(v) => `${v}%`}
        height={180}
      />
      {c.mix.warning && <Notice tone="watch">{t.overview.mixWarning}</Notice>}
    </Section>
  );
}

function KpiDrill({ kpi, revision }: { kpi: Kpi; revision: number }) {
  const ids = kpi.projectIds.join(',');
  const projects = usePdp<Row>(ids ? `/projects?ids=${ids}` : null, revision);
  const columns: DataGridColumn<Row>[] = [
    { key: 'code', header: 'Code', render: (r) => <Link href={`${BASE}/projects/${r.code}`}>{r.code}</Link>, rawValue: (r) => r.code },
    { key: 'title', header: 'Title', width: 260 },
    { key: 'product_name', header: 'Product', rawValue: (r) => r.product_name ?? r.proposed_product_name ?? '' },
    { key: 'classification', header: 'Classification', render: (r) => enumLabel(r.classification), rawValue: (r) => r.classification },
    { key: 'state', header: 'State', render: (r) => <Chip color={STATE_COLOR[r.state]}>{enumLabel(r.state)}</Chip>, rawValue: (r) => r.state },
    { key: 'target_launch_date', header: 'Target launch', render: (r) => fmtDate(r.target_launch_date), rawValue: (r) => r.target_launch_date ?? '' },
  ];
  return (
    <Section title={`${t.overview.drill} “${kpi.label}”`}>
      {!ids ? (
        <Empty message={t.empty.kpiDrill} />
      ) : (
        <Loaded state={projects}>{(d) => <DataGrid columns={columns} rows={d.projects} getRowId={(r) => String(r.code)} fileName={`pdp-kpi-${kpi.code.toLowerCase()}`} />}</Loaded>
      )}
    </Section>
  );
}

function Alerts({ alerts }: { alerts: Row[] }) {
  const rows = alerts.map((a, i) => ({ ...a, id: i }));
  const color: Record<string, string> = {
    no_approver: 'var(--ps-color-alert)',
    fast_track: 'var(--ps-color-alert)',
    late_project: 'var(--ps-color-alert)',
    my_approval: 'var(--ps-color-accent)',
    late_product: 'var(--ps-color-gold)',
  };
  const columns: DataGridColumn<Row>[] = [
    { key: 'kind', header: 'Alert', width: 170, render: (r) => <Chip color={color[r.kind] ?? 'var(--ps-color-muted-text)'}>{enumLabel(r.kind)}</Chip>, rawValue: (r) => enumLabel(r.kind), filterOptions: Object.keys(color).map((k) => ({ value: enumLabel(k), label: enumLabel(k) })) },
    { key: 'message', header: 'Details', width: 520, render: (r) => <span dir="auto">{r.message}</span> },
    {
      key: 'projectCode',
      header: 'Open',
      render: (r) => (r.projectCode ? <Link href={`${BASE}/projects/${r.projectCode}`}>{r.projectCode}</Link> : r.productId ? <Link href={`${BASE}/tree?product=${r.productId}`}>Product</Link> : r.kind === 'no_approver' ? <Link href={`${BASE}/admin`}>Administration</Link> : '—'),
      rawValue: (r) => r.projectCode ?? '',
    },
  ];
  return (
    <Section title={`${t.overview.alerts} (${alerts.length})`} help={{ definition: t.overview.alertsHelp }} testId="pdp-alerts">
      {rows.length === 0 ? <Empty message={t.empty.alerts} /> : <DataGrid columns={columns} rows={rows} getRowId={(r) => String(r.id)} fileName="pdp-alerts" pageSize={10} />}
    </Section>
  );
}

function Portfolio({ rows, byStatus }: { rows: Row[]; byStatus: Row[] }) {
  const total = byStatus.reduce((n, r) => n + Number(r.count), 0);
  return (
    <ChartPanel title={t.overview.portfolio} help={{ definition: t.overview.portfolioHelp }}>
      {total === 0 ? (
        <Empty message={t.empty.tree} />
      ) : (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
            {byStatus.map((r) => (
              <Chip key={r.status} color={STATUS_COLOR[r.status]}>
                {enumLabel(r.status)}: {r.count}
              </Chip>
            ))}
          </div>
          <ComboChart
            showTitle={false}
            points={rows.map((r) => ({ label: r.family, in_market: r.in_market, under_development: r.under_development, planned: r.planned, discontinued: r.discontinued }))}
            bars={(['in_market', 'under_development', 'planned', 'discontinued'] as const).map((k) => ({ key: k, name: enumLabel(k), color: STATUS_COLOR[k], stackId: 'status' }))}
            height={320}
          />
        </>
      )}
    </ChartPanel>
  );
}
