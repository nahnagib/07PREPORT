'use client';
import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Download } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ChartPanel, DonutChart, ErrorState, GroupedBarChart } from '@07ps/ui';
import { PermissionGuard } from '../../../../components/AuthGuard';
import { KaizenShell, useKaizenListHref } from '../../../../components/kaizen/KaizenShell';
import { KaizenFilterBar } from '../../../../components/kaizen/KaizenFilterBar';
import { KaizenKpi, STATUS_COLOR } from '../../../../components/kaizen/KaizenBits';
import { useKaizenOptions } from '../../../../components/kaizen/useKaizenOptions';
import { useAuth } from '../../../../lib/AuthProvider';
import { formatNumber, kt as t } from '../../../../lib/kaizen/text';
import { filtersToQuery, kaizenApi, type KaizenDashboard, type KaizenFilters } from '../../../../lib/kaizen/api';
import { responsiblePoints, type ResponsiblePoint } from '../../../../lib/kaizen/responsibleChart';

/**
 * Kaizen Board (Process department) -- built live from kaizen_cards. KPI tiles in the left column,
 * charts beside them; the date range + Department filters drive everything. Every tile and chart
 * segment opens the matching cards: the entry list for users with Kaizen Cards access, the
 * read-only details list for everyone else. English-only, like the rest of the Kaizen module.
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

const TOOLTIP_STYLE: React.CSSProperties = {
  borderRadius: 10,
  border: '1px solid var(--ps-color-border)',
  fontSize: 12,
  background: 'var(--ps-color-surface)',
  color: 'var(--ps-color-text)',
};

function KaizenBoardBody() {
  const { token } = useAuth();
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
  }, [token, dashFilters]);

  useEffect(() => {
    if (token) kaizenApi.qr(token).then(setQr).catch(() => setQr(null));
  }, [token]);

  /** Opens the card list with the dashboard's filters plus `extra`. */
  const drill = (extra: KaizenFilters) => router.push(`${listHref}?${filtersToQuery({ ...dashFilters, ...extra })}`);

  if (error) return <ErrorState message={error} />;
  if (!data || options.loading) return <p style={{ color: 'var(--ps-color-muted-text)' }}>{t('kaizen.loading')}</p>;

  const cardsUnit = t('kaizen.unit.cards');
  const count = (n: number) => `${formatNumber(n)} ${cardsUnit}`;

  // Bars: every department value (active, or inactive but still counted), in the list's order.
  const deptCounts = new Map(data.byDepartment.map((d) => [d.value_id, d.count]));
  const deptRows = options
    .listValues('department')
    .filter((d) => d.is_active || deptCounts.has(d.value_id))
    .filter((d) => !filters.departmentIds?.length || filters.departmentIds.includes(d.value_id))
    .map((d) => ({ id: d.value_id, label: d.label, value: deptCounts.get(d.value_id) ?? 0, color: d.color }));

  const segments = (rows: { value_id: number; count: number }[]) =>
    rows.map((r) => ({ id: String(r.value_id), label: options.labelOf(r.value_id), value: r.count, color: options.colorOf(r.value_id) }));
  const statusSegments = [
    { id: 'OPEN', label: t('kaizen.status.OPEN'), value: data.open, color: STATUS_COLOR.OPEN },
    { id: 'CLOSED', label: t('kaizen.status.CLOSED'), value: data.closed, color: STATUS_COLOR.CLOSED },
  ].filter((s) => s.value > 0);

  const responsible = responsiblePoints(data.byResponsible, { others: t('kaizen.chart.others'), notAssigned: t('kaizen.notAssigned') });
  const responsibleByLabel = new Map(responsible.map((p) => [p.label, p]));

  const donut = (title: string, segs: ReturnType<typeof segments>, onClick: (id: string) => void) => (
    <ChartPanel title={title} infoText={t('kaizen.chart.clickHint')}>
      <DonutChart showTitle={false} segments={segs} valueFormatter={(v) => formatNumber(v)} height={220} onSegmentClick={onClick} />
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
          <KaizenKpi label={t('kaizen.kpi.total')} value={formatNumber(data.total)} unit={cardsUnit} onClick={() => drill({})} />
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
                <ResponsiveContainer width="100%" height={narrow ? Math.max(160, deptRows.length * 44) : 260}>
                  <BarChart
                    data={deptRows}
                    layout={narrow ? 'vertical' : 'horizontal'}
                    margin={narrow ? { top: 4, right: 8, left: 8, bottom: 4 } : { top: 24, right: 12, left: 12, bottom: 4 }}
                  >
                    <CartesianGrid vertical={narrow} horizontal={!narrow} stroke="var(--ps-color-border)" strokeDasharray="3 3" />
                    {narrow ? (
                      <>
                        <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11, fill: 'var(--ps-color-muted-text)' }} />
                        <YAxis
                          type="category"
                          dataKey="label"
                          width={124}
                          interval={0}
                          tickFormatter={(label: string) => `${label} · ${formatNumber(deptRows.find((r) => r.label === label)?.value ?? 0)}`}
                          tick={{ fontSize: 12, fill: 'var(--ps-color-text)' }}
                        />
                      </>
                    ) : (
                      <>
                        <XAxis dataKey="label" interval={0} tick={{ fontSize: 12, fill: 'var(--ps-color-text)' }} />
                        <YAxis allowDecimals={false} width={32} tick={{ fontSize: 12, fill: 'var(--ps-color-muted-text)' }} />
                      </>
                    )}
                    <Tooltip cursor={{ fill: 'var(--ps-color-muted-bg)' }} formatter={(v: number) => [count(v), t('kaizen.cardsWord')]} contentStyle={TOOLTIP_STYLE} />
                    <Bar
                      dataKey="value"
                      radius={narrow ? [0, 6, 6, 0] : [6, 6, 0, 0]}
                      maxBarSize={narrow ? 28 : 72}
                      isAnimationActive={false}
                      cursor="pointer"
                      onClick={(row: { id: number }) => drill({ departmentIds: [row.id] })}
                    >
                      {deptRows.map((r) => (
                        <Cell key={r.id} fill={r.color} />
                      ))}
                      {/* On phones the count is in the axis label instead (it would collide with the names). */}
                      {!narrow && <LabelList dataKey="value" position="top" style={{ fontSize: 12, fontWeight: 700, fill: 'var(--ps-color-text)' }} />}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </ChartPanel>
          </div>

          {donut(t('kaizen.chart.priority'), segments(data.byPriority), (id) => drill({ priorityIds: [Number(id)] }))}
          {donut(t('kaizen.chart.status'), statusSegments, (id) => drill({ status: id as 'OPEN' | 'CLOSED' }))}
          {donut(t('kaizen.chart.type'), segments(data.byType), (id) => drill({ typeIds: [Number(id)] }))}

          <div className="ps-kaizen-span-all">
            <ChartPanel title={t('kaizen.chart.responsible')} infoText={t('kaizen.chart.responsibleHint')}>
              {responsible.length === 0 ? (
                <p style={{ fontSize: 13, color: 'var(--ps-color-muted-text)' }}>{t('kaizen.chart.noData')}</p>
              ) : (
                <GroupedBarChart
                  showTitle={false}
                  stacked
                  showTotals
                  integerAxis
                  points={responsible}
                  bars={[
                    { key: 'open', name: t('kaizen.status.OPEN'), color: STATUS_COLOR.OPEN },
                    { key: 'closed', name: t('kaizen.status.CLOSED'), color: STATUS_COLOR.CLOSED },
                  ]}
                  // "(Not assigned)" is one grey bar; everyone else keeps the red/green status split.
                  colorForPoint={(p) => ((p as ResponsiblePoint).kind === 'unassigned' ? 'var(--ps-color-neutral-text)' : undefined)}
                  valueFormatter={(v) => formatNumber(v)}
                  yAxisWidth={narrow ? 110 : 180}
                  height={responsible.length * 34 + 64}
                  tooltipContent={(p) => {
                    const point = p as ResponsiblePoint;
                    return (
                      <div style={{ ...TOOLTIP_STYLE, padding: '8px 10px' }}>
                        <div dir="auto" style={{ fontWeight: 700, marginBottom: 4 }}>{point.label}</div>
                        {point.kind === 'others' && (
                          <div style={{ color: 'var(--ps-color-muted-text)', marginBottom: 4 }}>
                            {t('kaizen.chart.othersHint')} ({formatNumber(point.parties ?? 0)})
                          </div>
                        )}
                        <div>{t('kaizen.status.OPEN')}: {formatNumber(point.open)}</div>
                        <div>{t('kaizen.status.CLOSED')}: {formatNumber(point.closed)}</div>
                        <div style={{ fontWeight: 700 }}>{count(point.open + point.closed)}</div>
                      </div>
                    );
                  }}
                  onCategoryClick={(label) => {
                    const point = responsibleByLabel.get(label);
                    if (!point || point.kind === 'others') return; // "Others" is several people: no single filter
                    drill({ responsibleParty: point.kind === 'unassigned' ? '' : point.name });
                  }}
                />
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

function KaizenQrTile({ qr, onDownload }: { qr: { url: string; dataUrl: string } | null; onDownload: () => void }) {
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
