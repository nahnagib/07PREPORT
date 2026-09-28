'use client';
import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Download } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, Treemap, XAxis, YAxis } from 'recharts';
import { ChartPanel, DonutChart, ErrorState } from '@07ps/ui';
import { PermissionGuard } from '../../../../components/AuthGuard';
import { KaizenShell, useKaizenListHref } from '../../../../components/kaizen/KaizenShell';
import { KaizenFilterBar } from '../../../../components/kaizen/KaizenFilterBar';
import { KaizenKpi, STATUS_COLOR } from '../../../../components/kaizen/KaizenBits';
import { useKaizenOptions } from '../../../../components/kaizen/useKaizenOptions';
import { useAuth } from '../../../../lib/AuthProvider';
import { useLanguage } from '../../../../lib/i18n/LanguageProvider';
import { filtersToQuery, kaizenApi, type KaizenDashboard, type KaizenFilters } from '../../../../lib/kaizen/api';

/**
 * Kaizen Board (Process department) -- built live from kaizen_cards. KPI tiles in the inline-start
 * column (right in Arabic, as in the draft), charts beside them; the date range + Department filters
 * drive everything. Every tile and chart segment opens the matching cards: the entry list for users
 * with Kaizen Cards access, the read-only details list for everyone else.
 */
export default function KaizenBoardPage() {
  return (
    <PermissionGuard pageKey="kaizen_board">
      <KaizenShell titleKey="kaizen.board">
        <KaizenBoardBody />
      </KaizenShell>
    </PermissionGuard>
  );
}

const TREEMAP_COLORS = ['#4d88c4', '#5a9e6f', '#c48a3f', '#a06fc4', '#3f9bc4', '#cc7a3f', '#6f9ceb', '#b5566b', '#7d9e3f', '#8a7fc4'];

function KaizenBoardBody() {
  const { token } = useAuth();
  const { t, pick, lang, dir, formatNumber } = useLanguage();
  const router = useRouter();
  const listHref = useKaizenListHref();
  const options = useKaizenOptions();
  const [filters, setFilters] = useState<KaizenFilters>({});
  const [data, setData] = useState<KaizenDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [qr, setQr] = useState<{ url: string; dataUrl: string } | null>(null);
  const narrow = useIsNarrow();

  const dashFilters = useMemo(
    () => ({ dateFrom: filters.dateFrom, dateTo: filters.dateTo, departmentIds: filters.departmentIds }),
    [filters.dateFrom, filters.dateTo, filters.departmentIds],
  );

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setError(null);
    kaizenApi
      .dashboard(token, dashFilters)
      .then((d) => !cancelled && setData(d))
      .catch(() => !cancelled && setError(t('kaizen.loadError')));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, dashFilters]);

  useEffect(() => {
    if (token) kaizenApi.qr(token).then(setQr).catch(() => setQr(null));
  }, [token]);

  /** Opens the card list with the dashboard's filters plus `extra`. */
  const drill = (extra: KaizenFilters) => router.push(`${listHref}?${filtersToQuery({ ...dashFilters, ...extra })}`);

  if (error) return <ErrorState message={error} />;
  if (!data || options.loading) return <p style={{ color: 'var(--ps-color-muted-text)' }}>{t('shell.loading')}</p>;

  const cards = t('kaizen.unit.cards');
  const count = (n: number) => `${formatNumber(n)} ${cards}`;

  // Bars: every department value (active, or inactive but still counted), in the list's order.
  const deptCounts = new Map(data.byDepartment.map((d) => [d.value_id, d.count]));
  const deptRows = options
    .listValues('department')
    .filter((d) => d.is_active || deptCounts.has(d.value_id))
    .filter((d) => !filters.departmentIds?.length || filters.departmentIds.includes(d.value_id))
    .map((d) => ({ id: d.value_id, label: pick(d.label_en, d.label_ar), value: deptCounts.get(d.value_id) ?? 0, color: d.color }));

  const segments = (rows: { value_id: number; count: number }[]) =>
    rows.map((r) => ({ id: String(r.value_id), label: options.labelOf(r.value_id), value: r.count, color: options.colorOf(r.value_id) }));
  const statusSegments = [
    { id: 'OPEN', label: t('kaizen.status.OPEN'), value: data.open, color: STATUS_COLOR.OPEN },
    { id: 'CLOSED', label: t('kaizen.status.CLOSED'), value: data.closed, color: STATUS_COLOR.CLOSED },
  ].filter((s) => s.value > 0);
  const treemap = data.byResponsible.map((r, i) => ({
    name: r.name ?? t('kaizen.notAssigned'),
    raw: r.name ?? '',
    size: r.count,
    fill: r.name === null ? 'var(--ps-color-neutral-text)' : TREEMAP_COLORS[i % TREEMAP_COLORS.length],
  }));

  const donut = (title: string, segs: ReturnType<typeof segments>, onClick: (id: string) => void) => (
    <ChartPanel title={title} infoText={t('kaizen.chart.clickHint')}>
      <DonutChart
        showTitle={false}
        segments={segs}
        valueFormatter={(v) => formatNumber(v)}
        height={220}
        onSegmentClick={onClick}
        exportLabel={t('kaizen.chart.exportImage')}
        emptyText={t('kaizen.chart.noData')}
      />
    </ChartPanel>
  );

  const downloadQr = () => {
    if (!qr) return;
    const a = document.createElement('a');
    a.href = qr.dataUrl;
    a.download = 'kaizen-board-qr.png';
    a.click();
  };

  return (
    <>
      <KaizenFilterBar filters={filters} onChange={setFilters} options={options} />

      <div className="ps-kaizen-board">
        <section className="ps-kaizen-kpis" aria-label={t('kaizen.board')}>
          <KaizenKpi label={t('kaizen.kpi.total')} value={formatNumber(data.total)} unit={cards} onClick={() => drill({})} />
          <KaizenKpi
            label={t('kaizen.kpi.avgDays')}
            value={data.avgDaysToClose === null ? '–' : formatNumber(data.avgDaysToClose, 1)}
            unit={data.avgDaysToClose === null ? undefined : t('kaizen.unit.days')}
            hint={t('kaizen.kpi.avgHint')}
            onClick={() => drill({ status: 'CLOSED' })}
            accent="var(--ps-color-success)"
          />
          <KaizenKpi
            label={t('kaizen.kpi.topDepartment')}
            value={data.topDepartment ? options.labelOf(data.topDepartment.value_id) : '–'}
            sub={data.topDepartment ? count(data.topDepartment.count) : undefined}
            accent={data.topDepartment ? options.colorOf(data.topDepartment.value_id) : undefined}
            onClick={data.topDepartment ? () => drill({ departmentIds: [data.topDepartment!.value_id] }) : undefined}
          />
          <KaizenKpi
            label={t('kaizen.kpi.topSubmitter')}
            value={data.topSubmitter?.name ?? '–'}
            sub={data.topSubmitter ? count(data.topSubmitter.count) : undefined}
            onClick={data.topSubmitter ? () => drill({ creator: data.topSubmitter!.name }) : undefined}
          />
          <KaizenKpi
            label={t('kaizen.kpi.topCause')}
            value={data.topType ? options.labelOf(data.topType.value_id) : '–'}
            sub={data.topType ? count(data.topType.count) : undefined}
            accent={data.topType ? options.colorOf(data.topType.value_id) : undefined}
            onClick={data.topType ? () => drill({ typeIds: [data.topType!.value_id] }) : undefined}
          />
          <KaizenQrTile qr={qr} onDownload={downloadQr} />
        </section>

        <section className="ps-kaizen-charts">
          <div className="ps-kaizen-span-all">
            <ChartPanel title={t('kaizen.chart.byDepartment')} infoText={t('kaizen.chart.clickHint')}>
              {data.total === 0 ? (
                <p style={{ fontSize: 13, color: 'var(--ps-color-muted-text)' }}>{t('kaizen.chart.noData')}</p>
              ) : (
                // Phones get horizontal bars, so long department names read down the side instead of colliding.
                // dir="ltr": SVG text-anchor flips inside an RTL page and pushes axis labels off the chart;
                // the RTL mirroring is done explicitly instead (reversed axis, axis on the right).
                <div dir="ltr">
                <ResponsiveContainer width="100%" height={narrow ? Math.max(160, deptRows.length * 44) : 260}>
                  <BarChart
                    data={deptRows}
                    layout={narrow ? 'vertical' : 'horizontal'}
                    margin={narrow ? { top: 4, right: 8, left: 8, bottom: 4 } : { top: 24, right: 12, left: 12, bottom: 4 }}
                  >
                    <CartesianGrid vertical={narrow} horizontal={!narrow} stroke="var(--ps-color-border)" strokeDasharray="3 3" />
                    {narrow ? (
                      <>
                        <XAxis type="number" allowDecimals={false} reversed={dir === 'rtl'} tick={{ fontSize: 11, fill: 'var(--ps-color-muted-text)' }} />
                        <YAxis
                          type="category"
                          dataKey="label"
                          orientation={dir === 'rtl' ? 'right' : 'left'}
                          width={124}
                          interval={0}
                          tickFormatter={(label: string) => `${label} · ${formatNumber(deptRows.find((r) => r.label === label)?.value ?? 0)}`}
                          tick={{ fontSize: 12, fill: 'var(--ps-color-text)' }}
                        />
                      </>
                    ) : (
                      <>
                        <XAxis dataKey="label" reversed={dir === 'rtl'} interval={0} tick={{ fontSize: 12, fill: 'var(--ps-color-text)' }} />
                        <YAxis allowDecimals={false} orientation={dir === 'rtl' ? 'right' : 'left'} width={32} tick={{ fontSize: 12, fill: 'var(--ps-color-muted-text)' }} />
                      </>
                    )}
                    <Tooltip
                      cursor={{ fill: 'var(--ps-color-muted-bg)' }}
                      formatter={(v: number) => [count(v), t('kaizen.cardsWord')]}
                      contentStyle={{ borderRadius: 10, border: '1px solid var(--ps-color-border)', fontSize: 12, background: 'var(--ps-color-surface)', color: 'var(--ps-color-text)' }}
                    />
                    <Bar dataKey="value" radius={narrow ? (dir === 'rtl' ? [6, 0, 0, 6] : [0, 6, 6, 0]) : [6, 6, 0, 0]} maxBarSize={narrow ? 28 : 72} isAnimationActive={false} cursor="pointer" onClick={(row: { id: number }) => drill({ departmentIds: [row.id] })}>
                      {deptRows.map((r) => (
                        <Cell key={r.id} fill={r.color} />
                      ))}
                      {/* On phones the count is in the axis label instead (it would collide with the names). */}
                      {!narrow && <LabelList dataKey="value" position="top" style={{ fontSize: 12, fontWeight: 700, fill: 'var(--ps-color-text)' }} />}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
                </div>
              )}
            </ChartPanel>
          </div>

          {donut(t('kaizen.chart.priority'), segments(data.byPriority), (id) => drill({ priorityIds: [Number(id)] }))}
          {donut(t('kaizen.chart.status'), statusSegments, (id) => drill({ status: id as 'OPEN' | 'CLOSED' }))}
          {donut(t('kaizen.chart.type'), segments(data.byType), (id) => drill({ typeIds: [Number(id)] }))}

          <div className="ps-kaizen-span-all">
            <ChartPanel title={t('kaizen.chart.responsible')} infoText={t('kaizen.chart.clickHint')}>
              {treemap.length === 0 ? (
                <p style={{ fontSize: 13, color: 'var(--ps-color-muted-text)' }}>{t('kaizen.chart.noData')}</p>
              ) : (
                <ResponsiveContainer width="100%" height={260}>
                  <Treemap
                    key={lang}
                    data={treemap}
                    dataKey="size"
                    nameKey="name"
                    isAnimationActive={false}
                    stroke="var(--ps-color-surface)"
                    content={<TreemapCell />}
                    // Recharts hands back the clicked datum's fields on the node (typed loosely as TreemapNode).
                    onClick={(node) => drill({ responsibleParty: String((node as unknown as { raw?: string }).raw ?? '') })}
                  >
                    <Tooltip
                      formatter={(v: number) => [count(v), t('kaizen.cardsWord')]}
                      contentStyle={{ borderRadius: 10, border: '1px solid var(--ps-color-border)', fontSize: 12, background: 'var(--ps-color-surface)', color: 'var(--ps-color-text)' }}
                    />
                  </Treemap>
                </ResponsiveContainer>
              )}
            </ChartPanel>
          </div>
        </section>
      </div>
    </>
  );
}

/** Phone width (matches the CSS breakpoint the layout switches at). */
function useIsNarrow() {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const update = () => setNarrow(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return narrow;
}

/** One treemap rectangle: its fill, and name + count when there's room. */
function TreemapCell(props: { x?: number; y?: number; width?: number; height?: number; name?: string; size?: number; fill?: string; depth?: number }) {
  const { x = 0, y = 0, width = 0, height = 0, name, size, fill, depth } = props;
  if (depth === 0) return null;
  const fits = width > 60 && height > 34;
  return (
    <g style={{ cursor: 'pointer' }}>
      <rect x={x} y={y} width={width} height={height} rx={4} style={{ fill, stroke: 'var(--ps-color-surface)', strokeWidth: 2 }} />
      {fits && (
        <>
          <text x={x + width / 2} y={y + height / 2 - 4} textAnchor="middle" style={{ fontSize: 13, fontWeight: 700, fill: '#fff', stroke: 'none' }}>
            {name && name.length > width / 8 ? `${name.slice(0, Math.max(3, Math.floor(width / 8) - 1))}…` : name}
          </text>
          <text x={x + width / 2} y={y + height / 2 + 14} textAnchor="middle" style={{ fontSize: 12, fill: 'rgba(255,255,255,0.9)', stroke: 'none' }}>
            {size}
          </text>
        </>
      )}
    </g>
  );
}

function KaizenQrTile({ qr, onDownload }: { qr: { url: string; dataUrl: string } | null; onDownload: () => void }) {
  const { t } = useLanguage();
  return (
    <div
      className="ps-card ps-kaizen-qr"
      style={{
        borderRadius: 'var(--ps-card-radius, 8px)',
        padding: 'var(--ps-card-padding, 16px)',
        background: 'var(--ps-card-bg)',
        border: '1px solid var(--ps-color-border)',
        display: 'flex',
        gap: 12,
        alignItems: 'center',
        borderInlineStart: '4px solid var(--ps-color-gold)',
      }}
    >
      {qr ? (
        // The QR has a white background of its own, so it scans in dark mode too.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={qr.dataUrl} alt={t('kaizen.qr.scan')} width={104} height={104} style={{ borderRadius: 6, flexShrink: 0 }} />
      ) : (
        <div className="ps-skeleton" style={{ width: 104, height: 104 }} />
      )}
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ps-color-muted-text)' }}>{t('kaizen.kpi.details')}</div>
        <div style={{ fontSize: 12, color: 'var(--ps-color-muted-text)' }}>{t('kaizen.qr.scan')}</div>
        <button
          type="button"
          onClick={onDownload}
          disabled={!qr}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            alignSelf: 'flex-start',
            padding: '5px 10px',
            borderRadius: 6,
            border: '1px solid var(--ps-color-border)',
            background: 'var(--ps-color-muted-bg)',
            color: 'var(--ps-color-text)',
            fontSize: 12,
            fontWeight: 600,
            cursor: qr ? 'pointer' : 'not-allowed',
          }}
        >
          <Download size={13} />
          {t('kaizen.qr.download')}
        </button>
      </div>
    </div>
  );
}
