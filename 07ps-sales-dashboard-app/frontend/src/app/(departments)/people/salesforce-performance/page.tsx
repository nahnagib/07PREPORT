'use client';
import React, { useEffect, useState } from 'react';
import { Activity, ChevronRight, FileDown, Search, Users } from 'lucide-react';
import {
  Bar, BarChart, CartesianGrid, Cell, LabelList, Line, LineChart, Pie, PieChart, ReferenceLine, ResponsiveContainer, Sector, Tooltip,
  XAxis, YAxis,
} from 'recharts';
import {
  Button,
  Card,
  ChartPanel,
  DataGrid,
  EmptyState,
  ErrorState,
  LoadingSkeleton,
  Select,
  TrendChart,
  VisualInfoIcons,
  chartTooltipProps,
  exportRowsAsPdf,
  tooltipBoxStyle,
  useCanExport,
  type DataGridColumn,
} from '@07ps/ui';
import { AppHeader } from '../../../../components/AppHeader';
import { PermissionGuard } from '../../../../components/AuthGuard';
import { BottomNavBar } from '../../../../components/BottomNavBar';
import { FilterBar } from '../../../../components/FilterBar';
import { useFilterState, useScopedFilterOptions } from '../../../../components/FilterProvider';
import { RefreshFooter } from '../../../../components/RefreshFooter';
import { ValidationStatusBar } from '../../../../components/ValidationStatusBar';
import { standardFilterBarProps } from '../../../../components/standardFilterBarProps';
import { useAuth } from '../../../../lib/AuthProvider';
import { formatCompactCurrency, formatCurrency, formatPercent, formatSignedPercent, formatTimestamp } from '../../../../lib/format';
import { useRefreshStatus, useSalesPeopleOverview } from '../../../../lib/hooks';
import { CATEGORICAL_8 } from '../../../../lib/marcom/palette';
import {
  CONTRIBUTION_LEVEL_LABEL, STATUS_COLOR, STATUS_ORDER, benchmarkMet, contributionSlices, filterPeople,
  monthlyStatusPerformance, peopleSummary, personPath, personShares, showsBest, statusMix, teamPulse, topPerson,
  CHANNEL_SEGMENT, RECONCILIATION_REASON_LABEL, parseChannel, totalPulse,
  type DirectorChannel, type DirectorPerformance, type DrillStep, type PeopleReconciliation, type PeopleStatus,
  type PeopleStatusDefinition, type SalesPersonPerformance, type TotalFigures,
} from '../../../../lib/salesPeoplePerformance';
import { DataQualityRow } from '../../../../components/DataQualityRow';
import { vh, type VisualHelpId } from '../../../../lib/visualHelp';
import styles from './page.module.css';

const YTD = 'ytd';
const dash = (text: string | undefined) => text ?? '—';
const compact = (value: number | null) => (value == null ? '—' : formatCompactCurrency(value));
/** "+LYD 7.3M" / "−LYD 2.1M". */
const signedCompact = (value: number | null) =>
  (value == null ? '—' : `${value >= 0 ? '+' : '−'}${formatCompactCurrency(Math.abs(value))}`);
const monthLabel = (month: string) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const varianceColor = (value: number | null) =>
  value == null ? 'var(--ps-color-muted-text)' : value >= 0 ? 'var(--ps-color-success)' : 'var(--ps-color-alert)';
const headcount = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;
const peoplePercent = new Intl.NumberFormat('en-GB', { style: 'percent', maximumFractionDigits: 1 });
const axisTick = { fill: 'var(--ps-color-muted-text)', fontSize: 11 };

function benchmarkGap(share: number, benchmark: number, isCap: boolean) {
  if (share === benchmark) return 'At benchmark';
  const gap = (Math.abs(share - benchmark) * 100).toFixed(1);
  if (isCap) return `${gap} pp ${share > benchmark ? 'over cap' : 'below cap'}`;
  return `${gap} pp ${share < benchmark ? 'short' : 'above goal'}`;
}

function StatusPill({ status, label }: { status: PeopleStatus; label: string }) {
  return (
    <span className={styles.pill} style={{ '--status': STATUS_COLOR[status] } as React.CSSProperties}>
      <span className={styles.dot} aria-hidden />
      {label}
    </span>
  );
}

/** The same header ChartPanel draws (14px bold title + help icons + actions on the right), for the sections that are
 * not a single panel. */
function SectionHeader({ title, helpId, children }: { title: string; helpId: VisualHelpId; children?: React.ReactNode }) {
  return (
    <div className={styles.sectionHeader}>
      <div className={styles.sectionTitle}>
        <h2>{title}</h2>
        <VisualInfoIcons title={title} {...vh(helpId)} />
      </div>
      {children && <div className={styles.sectionActions}>{children}</div>}
    </div>
  );
}

/** Same button as the other Promotion pages (copied per page, the convention there). */
function ExportPdfButton({ onClick, downloading, disabled }: { onClick: () => void; downloading: boolean; disabled?: boolean }) {
  const canExport = useCanExport();
  if (!canExport) return null;
  return (
    <button type="button" onClick={onClick} disabled={downloading || disabled} className={styles.exportButton}>
      <FileDown size={13} />
      {downloading ? 'Exporting...' : 'Export as PDF'}
    </button>
  );
}

/** Enter / Space on a role="button" card, like KpiCard. */
function pressable(onPress: () => void) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    onClick: onPress,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onPress();
      }
    },
  };
}

function VsTarget({ people, total }: { people: SalesPersonPerformance[]; total?: TotalFigures }) {
  const { actual, target, variance, variancePct } = total
    ? { actual: total.actual, target: total.target ?? 0, variance: total.variance, variancePct: total.variancePct }
    : peopleSummary(people);
  return (
    <div className={styles.ytdVariance} title={`${formatCurrency(actual)} of ${formatCurrency(target)}`}>
      <div className={styles.varianceRow} style={{ color: varianceColor(variance) }}>
        <span data-testid="variance-amount">{signedCompact(variance)}</span>
        {variancePct != null && (
          <span data-testid="variance-pct" className={styles.variancePill}
            style={{ '--variance': varianceColor(variance) } as React.CSSProperties}>{formatSignedPercent(variancePct)}</span>
        )}
      </div>
      <div className={styles.muted}>vs YTD target</div>
    </div>
  );
}

function StatusCard({ definition, people, pressed, dimmed = false, onPress }: {
  definition: PeopleStatusDefinition; people: SalesPersonPerformance[]; pressed: boolean; dimmed?: boolean; onPress: () => void;
}) {
  const color = STATUS_COLOR[definition.key];
  return (
    <Card {...pressable(onPress)} aria-pressed={pressed} aria-label={`${definition.label}: ${people.length} people`} data-dimmed={dimmed || undefined}
      className={`ps-card-clickable ${styles.statusCard}`} style={{ '--status': color, borderInlineStart: `4px solid ${color}` } as React.CSSProperties}>
      <span className={styles.cardTitle}><span className={styles.dot} aria-hidden />{definition.label}</span>
      <div className={styles.cardValue}>{people.length}</div>
      <VsTarget people={people} />
    </Card>
  );
}

function TotalCard({ people, total, pressed, dimmed = false, onPress }: {
  people: SalesPersonPerformance[]; total?: TotalFigures; pressed: boolean; dimmed?: boolean; onPress: () => void;
}) {
  return (
    <Card {...pressable(onPress)} aria-pressed={pressed} aria-label={`Total sales people: ${people.length}`} data-dimmed={dimmed || undefined}
      className={`ps-card-clickable ${styles.statusCard}`}
      style={{ '--status': 'var(--ps-color-accent)', borderInlineStart: '4px solid var(--ps-color-accent)' } as React.CSSProperties}>
      <span className={styles.cardTitle}><Users size={14} aria-hidden />Total sales people</span>
      <div className={styles.cardValue}>{people.length}</div>
      <VsTarget people={people} total={total} />
    </Card>
  );
}

/** The #1 person of a status: the best for Top performer / On target, the worst for the other three. */
function TopPersonCard({ definition, person, searching, pressed, onPress }: {
  definition: PeopleStatusDefinition; person: SalesPersonPerformance | null; searching: boolean; pressed: boolean; onPress: () => void;
}) {
  const color = STATUS_COLOR[definition.key];
  const style = { '--status': color, borderInlineStart: `4px solid ${color}` } as React.CSSProperties;
  const caption = showsBest(definition.key) ? 'Best' : 'Needs most attention';
  const title = <span className={styles.cardTitle}><span className={styles.dot} aria-hidden />{definition.label} · {caption}</span>;
  if (!person) {
    return (
      <Card role="region" aria-label={definition.label} className={styles.statusCard} style={style}>
        {title}
        <p className={styles.emptyCategory}>{searching ? 'No one matches this search' : 'No one in this tier'}</p>
      </Card>
    );
  }
  return (
    <Card role="region" aria-label={definition.label} className={styles.statusCard} style={style}>
      {title}
      <div {...pressable(onPress)} aria-pressed={pressed} aria-label={person.name} className={styles.personPick}>
        <span className={styles.personName} title={person.name}>{person.name}</span>
        <span className={styles.cardValue} style={{ color: varianceColor(person.variancePct) }}>
          {dash(formatSignedPercent(person.variancePct))}
        </span>
        <span className={styles.cardSub} style={{ color: varianceColor(person.variance) }} title={formatCurrency(person.variance)}>
          {signedCompact(person.variance)} vs target
        </span>
        <span className={styles.personFigures} title={`${formatCurrency(person.actual)} of ${formatCurrency(person.target)}`}>
          {compact(person.actual)} <span className={styles.muted}>of {compact(person.target)}</span>
        </span>
        <ProgressBar label={`${person.name} achievement`} value={person.achievement} />
      </div>
    </Card>
  );
}

function ProgressBar({ label, value }: { label: string; value: number | null }) {
  const pct = value == null ? null : Math.max(0, Math.min(1, value));
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={pct == null ? undefined : Math.round(pct * 100)} className={styles.track}>
      {pct != null && <span style={{ width: `${pct * 100}%` }} />}
    </div>
  );
}

/** First slot of the Top people row: achievement, gap and the run-rate needed for the full-year target, for the people
 * on the page, or for the selected person. */
function TeamPulseCard({ pulse, title }: { pulse: ReturnType<typeof teamPulse>; title: string }) {
  return (
    <Card role="region" aria-label="Team pulse" className={styles.statusCard}
      style={{ '--status': 'var(--ps-color-accent)', borderInlineStart: '4px solid var(--ps-color-accent)' } as React.CSSProperties}>
      <span className={styles.cardTitle}><Activity size={14} aria-hidden />{title}</span>
      <div className={styles.personPick} style={{ cursor: 'default' }}>
        <span className={styles.personName}>YTD achievement</span>
        <span className={styles.cardValue}>{dash(formatPercent(pulse.achievement))}</span>
        <span className={styles.cardSub} style={{ color: varianceColor(pulse.gap) }} title={formatCurrency(pulse.gap)}>
          {signedCompact(pulse.gap)} {pulse.gap != null && pulse.gap < 0 ? 'behind' : 'ahead of'} YTD target
        </span>
        <span className={styles.personFigures}>
          Need {compact(pulse.required)}/month <span className={styles.muted}>· running {compact(pulse.running)}/month</span>
        </span>
        <span className={styles.muted} title={`${formatCurrency(pulse.actual)} of ${formatCurrency(pulse.fullYear)}`}>
          {compact(pulse.actual)} of full-year {compact(pulse.fullYear)}
        </span>
        <ProgressBar label="YTD actual of the full-year target" value={pulse.progress} />
      </div>
    </Card>
  );
}

/** A channel owner (2026-11-15): the channel's YTD actual and target, in the people cards' style, with the tier colour.
 * Click = filter the page to that channel (?channel=). Dimmed when the tier filter or the Customer Group leaves it out. */
function DirectorCard({ director, tierLabel, pressed, dimmed, onPress }: {
  director: DirectorPerformance; tierLabel: string; pressed: boolean; dimmed: boolean; onPress: () => void;
}) {
  const color = director.status === 'no_target' ? 'var(--ps-color-muted-text)' : STATUS_COLOR[director.status];
  const name = director.names.join(', ') || 'Not assigned';
  return (
    <Card {...pressable(onPress)} aria-pressed={pressed} aria-label={`${director.roleLabel}: ${name}`} data-dimmed={dimmed || undefined}
      data-testid={`director-card-${director.channel}`} className={`ps-card-clickable ${styles.statusCard}`}
      style={{ '--status': color, borderInlineStart: `4px solid ${color}` } as React.CSSProperties}>
      <span className={styles.cardTitle}><span className={styles.dot} aria-hidden />{director.roleLabel} · {tierLabel}</span>
      <div className={styles.personPick} style={{ cursor: 'inherit' }}>
        <span className={styles.personName} title={name}>{name}</span>
        <span className={styles.cardValue} style={{ color: varianceColor(director.variancePct) }}>
          {dash(formatSignedPercent(director.variancePct))}
        </span>
        <VsTarget people={[]} total={director} />
        <span className={styles.personFigures} title={`${formatCurrency(director.actual)} of ${formatCurrency(director.target)}`}>
          {compact(director.actual)} <span className={styles.muted}>of {compact(director.target)} · {director.channel} channel
            {director.targetSource === 'director_rows' ? ' · director target' : ''}</span>
        </span>
        <ProgressBar label={`${director.roleLabel} achievement`} value={director.achievement} />
      </div>
    </Card>
  );
}

/** Admins only: why the listed people do not add up to the company total, by reason and by salesperson. */
function ReconciliationTable({ data }: { data: PeopleReconciliation }) {
  const byReason = new Map<string, { actual: number; target: number; count: number }>();
  for (const r of data.rows) {
    const o = byReason.get(r.reason) ?? { actual: 0, target: 0, count: 0 };
    o.actual += r.actual; o.target += r.target; o.count += 1;
    byReason.set(r.reason, o);
  }
  return (
    <Card data-testid="reconciliation-table">
      <table className={styles.reconciliation}>
        <thead><tr><th>Reason</th><th>Salesperson</th><th>YTD sales</th><th>YTD target</th></tr></thead>
        <tbody>
          {[...byReason].map(([reason, o]) => (
            <tr key={reason} className={styles.reconciliationTotal}>
              <td>{RECONCILIATION_REASON_LABEL[reason as keyof typeof RECONCILIATION_REASON_LABEL]}</td><td>{o.count} rows</td>
              <td>{formatCurrency(o.actual)}</td><td>{formatCurrency(o.target)}</td>
            </tr>
          ))}
          {data.rows.map((r, i) => (
            <tr key={`${r.key}-${i}`}>
              <td>{RECONCILIATION_REASON_LABEL[r.reason]}</td><td dir="auto">{r.name}</td>
              <td>{formatCurrency(r.actual)}</td><td>{formatCurrency(r.target)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

type TooltipProps<T> = { active?: boolean; payload?: Array<{ payload?: T }> };

function TooltipBox({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ ...tooltipBoxStyle, padding: '8px 10px' }}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>{title}</div>
      {children}
    </div>
  );
}

export default function SalesPeoplePerformancePage() {
  const { token, user, isSalesperson, error: authError, retryAuth, logout, canView } = useAuth();
  const state = useFilterState();
  const options = useScopedFilterOptions();
  const refresh = useRefreshStatus(token, authError, retryAuth);
  const { anchorDate, effectiveFilters } = state;
  const filterKey = JSON.stringify(effectiveFilters);
  // A director card filters the whole page to its channel (?channel=B2B|B2C): Customer Group = that channel (2026-11-15).
  const [channel, setChannel] = useState<DirectorChannel | null>(null);
  const [showReconciliation, setShowReconciliation] = useState(false);
  const requestFilters = channel ? { ...effectiveFilters, segmentKeys: [CHANNEL_SEGMENT[channel]] } : effectiveFilters;
  const overview = useSalesPeopleOverview(token, anchorDate, requestFilters, authError, retryAuth, canView('sales_people_performance'));
  const [status, setStatus] = useState<PeopleStatus | null>(null);
  const [personKey, setPersonKey] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [mixMonth, setMixMonth] = useState('');
  const [hiddenLines, setHiddenLines] = useState<ReadonlySet<PeopleStatus>>(new Set());
  const [drill, setDrill] = useState<DrillStep[]>([]);
  const [downloading, setDownloading] = useState<string | null>(null);
  useEffect(() => { setPersonKey(null); setMixMonth(''); setDrill([]); }, [anchorDate, filterKey]);
  // The Team tiers filter is in the URL (?tier=top_performer ...), so a refresh or a shared link keeps it (2026-11-15).
  useEffect(() => {
    try {
      const query = new URLSearchParams(window.location.search);
      const tier = query.get('tier');
      if (tier && (STATUS_ORDER as readonly string[]).includes(tier)) setStatus(tier as PeopleStatus);
      setChannel(parseChannel(query.get('channel')));
    } catch {
      /* no URL: everyone */
    }
  }, []);
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      if (status) url.searchParams.set('tier', status);
      else url.searchParams.delete('tier');
      if (channel) url.searchParams.set('channel', channel);
      else url.searchParams.delete('channel');
      if (url.href !== window.location.href) window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    } catch {
      /* the filter still applies */
    }
  }, [status, channel]);
  // Selecting a person opens the donut on their team's members; clearing the selection goes back to the top level.
  const atoms = overview.data?.contributions;
  useEffect(() => {
    setDrill(personKey != null && atoms ? personPath(atoms, personKey) ?? [] : []);
  }, [personKey, atoms]);

  // The API only returns people with a positive YTD target, so every count, share and total below is theirs alone.
  const people = overview.data?.people ?? [];
  const definitions = STATUS_ORDER.map((key) => overview.data?.statuses.find((d) => d.key === key))
    .filter((d): d is PeopleStatusDefinition => d != null);
  const label = (key: PeopleStatus) => definitions.find((d) => d.key === key)?.label ?? key;
  const searched = filterPeople(people, null, null, search);
  const names = filterPeople(searched, status);
  const selected = people.find((p) => p.key === personKey) ?? null;
  const cohort = selected ? [selected] : names;
  const cohortKeys = new Set(cohort.map((p) => p.key));
  const months = people[0]?.months.map((m) => m.month) ?? [];
  const mixPeriod = months.includes(mixMonth) ? mixMonth : YTD;
  const mixPeriodLabel = mixPeriod === YTD ? `YTD 1 Jan – ${anchorDate}` : monthLabel(mixPeriod);

  const chooseStatus = (next: PeopleStatus | null) => { setStatus(next); setPersonKey(null); };
  const choosePerson = (key: number) => setPersonKey((current) => (current === key ? null : key));
  const clearPage = () => { setStatus(null); setChannel(null); setSearch(''); setPersonKey(null); setDrill([]); };
  const chooseChannel = (next: DirectorChannel | null) => { setChannel(next); setPersonKey(null); setDrill([]); };
  const company = overview.data?.company;
  const directors = overview.data?.directors ?? [];
  const reconciliation = overview.data?.reconciliation ?? null;
  const monthsElapsed = overview.data?.monthsElapsed ?? 0;
  const tierPeople = status ? filterPeople(people, status) : people;
  // Team pulse: one person; a tier's people (not the company figure); else the company = the Tachometer YTD Value.
  const pulse = selected ? teamPulse([selected], monthsElapsed)
    : status || !company ? teamPulse(tierPeople, monthsElapsed) : totalPulse(company, monthsElapsed);
  const pulseTitle = selected ? `Pulse · ${selected.name}`
    : status ? `Pulse · ${label(status)} (${tierPeople.length} ${tierPeople.length === 1 ? 'person' : 'people'})`
      : channel ? `Team pulse · ${channel} channel` : 'Team pulse';
  const tierText = (d: DirectorPerformance) => (d.status === 'no_target' ? 'No target' : label(d.status as PeopleStatus));
  const toggleLine = (key: PeopleStatus) => setHiddenLines((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  // Benchmarks apply to the full team in scope. Selection can focus a row without changing its denominator.
  const mixIndex = mixPeriod === YTD ? null : months.indexOf(mixPeriod);
  const selectedMixStatus = selected ? (mixIndex == null ? selected.status : selected.months[mixIndex]?.status) : null;
  const mix = statusMix(people, mixIndex);
  const mixRows = mix.rows.filter((row) => !selected || row.status === selectedMixStatus).map((row) => {
    const definition = definitions.find((d) => d.key === row.status);
    const benchmark = definition?.benchmark ?? null;
    const isCap = definition?.direction === 'max';
    return {
      ...row,
      label: label(row.status),
      peopleLabel: `${row.count} · ${peoplePercent.format(row.share)}`,
      benchmark,
      benchmarkLabel: benchmark == null ? '—' : `${isCap ? '≤' : '≥'}${peoplePercent.format(benchmark)}`,
      gap: benchmark == null ? '' : benchmarkGap(row.share, benchmark, isCap),
      met: definition ? benchmarkMet(row.share, definition) : null,
    };
  });
  const mixNote = !selected ? null : selectedMixStatus == null || selectedMixStatus === 'no_target'
    ? `${selected.name} had no target in ${mixPeriodLabel}`
    : `${selected.name} was ${label(selectedMixStatus).toLowerCase()} ${mixIndex == null ? 'YTD' : `in ${mixPeriodLabel}`}`;
  // MoM performance: per month, achievement of the people in each (monthly) status.
  const momCohort = status && !selected ? searched : cohort;
  const momTiers = status && !selected ? definitions.filter((d) => d.key === status) : definitions;
  const momRows = monthlyStatusPerformance(momCohort).map((m) => ({
    month: m.month, label: monthLabel(m.month), statuses: m.statuses,
    ...Object.fromEntries(STATUS_ORDER.map((s) => [s, m.statuses[s].achievement])),
  }));
  const trendPoints = months.map((m, i) => {
    const sums = peopleSummary(cohort.map((p) => p.months[i]));
    return { label: monthLabel(m), actual: sums.actual, target: sums.target };
  });
  // With a person selected the donut shows everyone on the page (their team-mates included), with that person highlighted.
  const pieKeys = selected ? new Set(people.map((p) => p.key)) : cohortKeys;
  const personNames = new Map(people.map((p) => [p.key, p.name]));
  const contributions = contributionSlices(atoms ?? [], drill, pieKeys, personNames);
  const pieSlices = contributions.slices.map((s, i) => ({
    ...s, color: CATEGORICAL_8[i % CATEGORICAL_8.length], highlighted: !!selected && s.members.includes(selected.key),
  }));
  const pieData = pieSlices.filter((s) => s.share != null);
  const canDrill = contributions.level != null && contributions.level !== 'person';
  const selectedPath = selected && atoms ? personPath(atoms, selected.key) : null;
  const shares = selected && atoms && selectedPath ? personShares(atoms, selected.key, selectedPath, pieKeys) : [];
  const statusOfSlice = (key: string) => people.find((p) => String(p.key) === key)?.status;
  const drillInto = (slice: { key: string; label: string }) => {
    if (canDrill && contributions.level) setDrill((path) => [...path, { level: contributions.level!, key: slice.key, label: slice.label }]);
  };
  const personRows = cohort.map((p) => ({ ...p, id: String(p.key) }));

  const statusFilter = definitions.map((d) => ({ value: d.label, label: d.label }));
  const money = <T,>(key: keyof T, header: string, get: (r: T) => number | null): DataGridColumn<T> => ({
    key, header, align: 'right', render: (r) => formatCurrency(get(r)), rawValue: (r) => get(r) ?? '',
  });
  const ratio = <T,>(key: keyof T, header: string, get: (r: T) => number | null, fmt: (v: number | null) => string): DataGridColumn<T> => ({
    key, header, align: 'right', render: (r) => fmt(get(r)), rawValue: (r) => fmt(get(r)), sortValue: (r) => get(r) ?? -Infinity,
  });
  const pct = (v: number | null) => dash(formatPercent(v));
  const variance = (v: number | null) => dash(formatSignedPercent(v));

  type PersonRow = (typeof personRows)[number];
  const detailColumns: DataGridColumn<PersonRow>[] = [
    { key: 'name', header: 'Name' },
    money<PersonRow>('actual', 'Actual value (YTD)', (r) => r.actual),
    money<PersonRow>('target', 'YTD target', (r) => r.target),
    money<PersonRow>('lastYear', 'Same period last year', (r) => r.lastYear),
    money<PersonRow>('variance', 'Variance to target', (r) => r.variance),
    ratio<PersonRow>('variancePct', 'Variance %', (r) => r.variancePct, variance),
    ratio<PersonRow>('achievement', 'Achievement', (r) => r.achievement, pct),
    { key: 'status', header: 'Tier', render: (r) => <StatusPill status={r.status} label={label(r.status)} />,
      rawValue: (r) => label(r.status), filterOptions: statusFilter },
  ];

  const selectionParts = [
    channel && `Channel: ${channel}`,
    status && `Tier: ${label(status)}`,
    search.trim() && `Name contains: ${search.trim()}`,
    selected && `Person: ${selected.name}`,
  ].filter((p): p is string => !!p);

  async function exportPdf(key: string, title: string, headers: string[], rows: string[][], extra: string[] = [],
    filters = selectionParts) {
    setDownloading(key);
    try {
      await exportRowsAsPdf({
        title,
        columns: headers.map((header, i) => ({ header, align: i === 0 ? 'left' : 'right' })),
        rows,
        fileName: `sales-people-${title.toLowerCase().replace(/\s+/g, '-')}`,
        extraFilterParts: [...filters, ...extra],
      });
    } finally {
      setDownloading(null);
    }
  }
  const figureRow = (name: string, f: TotalFigures | undefined, tier: string) => f
    ? [name, formatCurrency(f.actual), formatCurrency(f.target), formatCurrency(f.variance), dash(formatSignedPercent(f.variancePct)),
      formatCurrency(f.fullYearTarget), tier]
    : [name, '—', '—', '—', '—', '—', tier];
  const exportDirectors = () => exportPdf('directors', 'Directors and company total',
    ['', 'Actual YTD', 'Target to date', 'Variance', 'Variance %', 'Full-year target', 'Tier'],
    [figureRow('Company total (= Tachometer YTD Value)', company, company && company.status !== 'no_target' ? label(company.status as PeopleStatus) : ''),
      ...directors.map((d) => figureRow(`${d.roleLabel}${d.names.length ? ` (${d.names.join(', ')})` : ''}`, d, tierText(d)))],
    [`Anchor date: ${anchorDate}`]);
  const exportMix = () => exportPdf('mix', 'Tier mix', ['Tier', 'People', 'Team share', 'Benchmark', 'Gap'],
    mixRows.map((r) => [r.label, String(r.count), peoplePercent.format(r.share), r.benchmarkLabel, r.gap]),
    [`Period: ${mixPeriodLabel}`, `Team size: ${headcount(mix.total)}`], mixNote ? [mixNote] : []);
  const exportMom = () => exportPdf('mom', 'MoM performance by tier', ['Month', ...momTiers.map((d) => d.label)],
    momRows.map((m) => [m.label, ...momTiers.map((d) => {
      const s = m.statuses[d.key];
      return s.count ? `${pct(s.achievement)} (${s.count})` : '—';
    })]));
  const exportPie = () => exportPdf('pie', 'Person contribution',
    [contributions.level ? CONTRIBUTION_LEVEL_LABEL[contributions.level] : 'Level', 'Share', 'Actual', 'Target', 'Achievement', 'People'],
    pieSlices.map((s) => [s.label, pct(s.share), formatCurrency(s.actual), formatCurrency(s.target), pct(s.achievement), String(s.people)]),
    drill.map((s) => `${CONTRIBUTION_LEVEL_LABEL[s.level]}: ${s.label}`));
  const exportTrend = () => exportPdf('trend', 'Actual vs target by month', ['Month', 'Actual', 'Target'],
    trendPoints.map((p) => [p.label, formatCurrency(p.actual), formatCurrency(p.target)]));

  const cohortCaption = selected ? selected.name : headcount(cohort.length);

  return (
    <PermissionGuard pageKey="sales_people_performance">
      <div className={styles.page}>
        <AppHeader anchorDate={anchorDate} onAnchorDateChange={state.onAnchorDateChange}
          roleLabel={user?.role.label ?? user?.fullName} onLogout={logout} showDateInput={false} />
        <FilterBar {...standardFilterBarProps({ state, options, isSalesperson, refresh: refresh.data })}
          salespersons={options.salespersons?.data?.filter((option) =>
            !/^sale(?:s|rs)[\s._-]*person(?:[\s._#-]*\d+)?$/i.test(String(option.salesperson_name ?? '').trim())) ?? []}
          showDateRange={false} showSingleDate
          onReset={() => { clearPage(); state.resetFilters(); }}
          isPristine={state.isAtDefaults && !status && !channel && !search && personKey == null} />
        <ValidationStatusBar isStale={refresh.data?.isStale} isInverted={refresh.data?.isInverted} refreshCheck={refresh.data?.refreshCheck} />
        {/* Admins only (the API sends it to admins only): why the people do not add up to the company total. */}
        {user?.isAdmin === true && reconciliation && (Math.abs(reconciliation.gap.actual) >= 1 || Math.abs(reconciliation.gap.target) >= 1) && (
          <>
            <DataQualityRow testId="salesforce-reconciliation" {...vh('promotion.salesPeople.reconciliation')}
              summary={`${compact(reconciliation.gap.actual)} of sales and ${compact(reconciliation.gap.target)} of target are not on any listed person (no target, vacant seat, director or unassigned)`}
              onOpen={() => setShowReconciliation((v) => !v)} />
            {showReconciliation && <div className={styles.reconciliationWrap}><ReconciliationTable data={reconciliation} /></div>}
          </>
        )}

        <main className={styles.main}>
          {overview.error ? (
            <Card><ErrorState message={overview.error} onRetry={overview.retry} /></Card>
          ) : overview.loading ? (
            <>
              <div className={styles.cards}>{Array.from({ length: 6 }, (_, i) => <Card key={i}><LoadingSkeleton variant="kpi" /></Card>)}</div>
              <Card><LoadingSkeleton variant="chart" /></Card>
            </>
          ) : !people.length ? (
            <Card><EmptyState message="No sales people with a target for the selected filters." onResetFilters={() => { clearPage(); state.resetFilters(); }} /></Card>
          ) : (
            <>
              {channel && (
                <div className={styles.filterChips} data-testid="channel-filter-chip">
                  <span className={styles.filterChip}>
                    Channel: {channel}
                    <button type="button" aria-label={`Clear the channel filter (${channel})`} onClick={() => chooseChannel(null)}>×</button>
                  </span>
                </div>
              )}
              {status && (
                <div className={styles.filterChips} data-testid="tier-filter-chip">
                  <span className={styles.filterChip} style={{ '--status': STATUS_COLOR[status] } as React.CSSProperties}>
                    <span className={styles.dot} aria-hidden />Tier: {label(status)}
                    <button type="button" aria-label={`Clear the tier filter (${label(status)})`} onClick={() => chooseStatus(null)}>×</button>
                  </span>
                </div>
              )}
              {/* 1. Team tiers: one card per tier, click = filter the whole page to that tier (?tier=). */}
              <section aria-label="YTD tier summary" className={styles.section}>
                <SectionHeader title="Team tiers" helpId="promotion.salesPeople.statusCards">
                  <span className={styles.muted}>YTD 1 Jan – {anchorDate}</span>
                </SectionHeader>
                <div className={styles.cards}>
                  <TotalCard people={people} total={company} pressed={!status} dimmed={!!status} onPress={() => chooseStatus(null)} />
                  {definitions.map((d) => (
                    <StatusCard key={d.key} definition={d} people={people.filter((p) => p.status === d.key)}
                      pressed={status === d.key} dimmed={!!status && status !== d.key}
                      onPress={() => chooseStatus(status === d.key ? null : d.key)} />
                  ))}
                </div>
              </section>

              {/* 1b. Directors (channel owners, 2026-11-15): not counted in any people figure. Click = that channel only. */}
              {directors.length > 0 && (
                <section aria-label="Directors" className={styles.section} data-testid="directors-row">
                  <SectionHeader title="Directors" helpId="promotion.salesPeople.directors">
                    <ExportPdfButton onClick={exportDirectors} downloading={downloading === 'directors'} />
                  </SectionHeader>
                  <div className={styles.directorCards}>
                    {directors.map((d) => (
                      <DirectorCard key={d.channel} director={d} tierLabel={tierText(d)} pressed={channel === d.channel}
                        dimmed={!d.inFilter || (status != null && d.status !== status)}
                        onPress={() => chooseChannel(channel === d.channel ? null : d.channel)} />
                    ))}
                  </div>
                </section>
              )}

              {/* 2. The #1 person per status, each card under its Team status card. */}
              <section aria-label="Top people by category" className={styles.section}>
                <SectionHeader title="Top people by category" helpId="promotion.salesPeople.topPeople">
                  <label className={styles.search}>
                    <Search size={14} aria-hidden />
                    <input aria-label="Search sales people" placeholder="Search a name…" value={search}
                      onChange={(e) => { setSearch(e.target.value); setPersonKey(null); }} />
                  </label>
                </SectionHeader>
                <div className={styles.cards}>
                  <TeamPulseCard pulse={pulse} title={pulseTitle} />
                  {definitions.filter((d) => !status || d.key === status).map((d) => {
                    const top = topPerson(searched, d.key);
                    return (
                      <TopPersonCard key={d.key} definition={d} person={top} searching={!!search.trim()}
                        pressed={top != null && personKey === top.key} onPress={() => top && choosePerson(top.key)} />
                    );
                  })}
                </div>
              </section>

              {/* Selected person: everything below follows them. */}
              {selected && (
                <Card className={styles.banner} style={{ borderInlineStart: `4px solid ${STATUS_COLOR[selected.status]}` }} role="status">
                  <strong>Selected: {selected.name}</strong>
                  <StatusPill status={selected.status} label={label(selected.status)} />
                  <span className={styles.muted}>The charts and the details table follow this person.</span>
                  <Button variant="secondary" onClick={() => setPersonKey(null)}>Show everyone</Button>
                </Card>
              )}

              {/* 3. Status mix (grouped bars) | MoM performance by status. */}
              <div className={styles.grid}>
                <ChartPanel title="Tier mix" {...vh('promotion.salesPeople.statusMix')} wrapHeader
                  headerActions={(
                    <div className={styles.panelActions}>
                      <div className={styles.monthPicker}>
                        <Select label="Month" options={[...months.map((m) => ({ value: m, label: monthLabel(m) })).reverse(), { value: YTD, label: 'YTD' }]}
                          value={[mixPeriod]} onChange={(v) => setMixMonth(v[0] ?? '')} />
                      </div>
                      <ExportPdfButton onClick={exportMix} downloading={downloading === 'mix'} disabled={!mixRows.length} />
                    </div>
                  )}>
                  <p className={styles.caption}>
                    Team headcount by {mixPeriod === YTD ? 'YTD tier' : 'monthly tier'} · {mixPeriodLabel} · {headcount(mix.total)}
                    <span className={styles.swatches}>
                      <span><i className={styles.swatchSolid} aria-hidden />People · team share</span>
                      <span><i className={styles.swatchHatched} aria-hidden />Benchmark</span>
                    </span>
                  </p>
                  {mixNote && <p className={styles.note} role="note">{mixNote}</p>}
                  {mix.total === 0 ? <EmptyState message="No people with a target for this period." /> : mixRows.length > 0 && (
                  <ResponsiveContainer width="100%" height={mixRows.length * 56 + 32}>
                    <BarChart data={mixRows} layout="vertical" margin={{ top: 4, right: 70, left: 0, bottom: 0 }}
                      barCategoryGap="22%" barGap={2}>
                      <defs>
                        {STATUS_ORDER.map((s) => (
                          <pattern key={s} id={`spp-hatch-${s}`} patternUnits="userSpaceOnUse" width={6} height={6} patternTransform="rotate(45)">
                            <rect width={6} height={6} style={{ fill: `color-mix(in srgb, ${STATUS_COLOR[s]} 30%, var(--ps-card-bg))` }} />
                            <line x1={0} y1={0} x2={0} y2={6} style={{ stroke: STATUS_COLOR[s], strokeWidth: 2 }} />
                          </pattern>
                        ))}
                      </defs>
                      <CartesianGrid stroke="var(--ps-color-border)" horizontal={false} />
                      <XAxis type="number" domain={[0, 1]} ticks={[0, 0.25, 0.5, 0.75, 1]} tick={axisTick}
                        tickFormatter={(v: number) => `${Math.round(v * 100)}%`} allowDataOverflow />
                      <YAxis type="category" dataKey="label" width={108} interval={0} tickLine={false}
                        tick={({ x, y, index }: { x: number; y: number; index: number }) => {
                          const row = mixRows[index];
                          return (
                            <g transform={`translate(${x},${y})`} textAnchor="end">
                              <text y={-3} {...axisTick}>{row.label}</text>
                              <text y={12} className={styles.benchmarkGap} data-met={row.met ?? undefined}>{row.gap}</text>
                            </g>
                          );
                        }} />
                      <Tooltip {...chartTooltipProps} content={({ active, payload }: TooltipProps<(typeof mixRows)[number]>) => {
                        const r = active ? payload?.[0]?.payload : undefined;
                        return r ? (
                          <TooltipBox title={r.label}>
                            <div>{r.count} of {mix.total} people · {peoplePercent.format(r.share)}</div>
                            <div>Benchmark: {r.benchmarkLabel}{r.gap && ` · ${r.gap}`}</div>
                          </TooltipBox>
                        ) : null;
                      }} />
                      <Bar dataKey="share" name="Team share" isAnimationActive={false}>
                        {mixRows.map((r) => <Cell key={r.status} fill={STATUS_COLOR[r.status]} fillOpacity={status && r.status !== status ? 0.25 : 1} />)}
                        <LabelList dataKey="peopleLabel" position="right" fontSize={11} fill="var(--ps-color-text)" />
                      </Bar>
                      <Bar dataKey="benchmark" name="Benchmark" isAnimationActive={false}>
                        {mixRows.map((r) => <Cell key={r.status} fill={`url(#spp-hatch-${r.status})`} stroke={STATUS_COLOR[r.status]}
                          fillOpacity={status && r.status !== status ? 0.25 : 1} strokeOpacity={status && r.status !== status ? 0.25 : 1} />)}
                        <LabelList dataKey="benchmarkLabel" position="right" fontSize={11} fill="var(--ps-color-muted-text)" />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                  )}
                </ChartPanel>

                <ChartPanel title="MoM performance by tier" {...vh('promotion.salesPeople.momStatus')}
                  headerActions={<ExportPdfButton onClick={exportMom} downloading={downloading === 'mom'} disabled={!momRows.length} />}>
                  <p className={styles.caption}>Achievement of each month&apos;s tier group · {status && !selected ? `${label(status)} only` : cohortCaption}</p>
                  <div role="group" aria-label="Show tiers" className={styles.legend}>
                    {momTiers.map((d) => (
                      <button key={d.key} type="button" aria-pressed={!hiddenLines.has(d.key)} onClick={() => toggleLine(d.key)}
                        style={{ '--status': STATUS_COLOR[d.key] } as React.CSSProperties}>
                        <span className={styles.dot} aria-hidden />{d.label}
                      </button>
                    ))}
                  </div>
                  <ResponsiveContainer width="100%" height={268}>
                    <LineChart data={momRows} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
                      <CartesianGrid stroke="var(--ps-color-border)" vertical={false} />
                      <XAxis dataKey="label" tick={axisTick} />
                      <YAxis tick={axisTick} tickFormatter={(v: number) => `${Math.round(v * 100)}%`} />
                      <ReferenceLine y={1} stroke="var(--ps-color-muted-text)" strokeDasharray="4 4" />
                      <Tooltip {...chartTooltipProps} content={({ active, payload }: TooltipProps<(typeof momRows)[number]>) => {
                        const m = active ? payload?.[0]?.payload : undefined;
                        return m ? (
                          <TooltipBox title={m.label}>
                            {momTiers.filter((d) => !hiddenLines.has(d.key) && m.statuses[d.key].count).map((d) => {
                              const s = m.statuses[d.key];
                              return (
                                <div key={d.key}>
                                  <strong style={{ color: STATUS_COLOR[d.key] }}>●</strong> {d.label}: {pct(s.achievement)}
                                  {' '}· {compact(s.actual)} of {compact(s.target)} · {headcount(s.count)}
                                </div>
                              );
                            })}
                          </TooltipBox>
                        ) : null;
                      }} />
                      {momTiers.map((d) => (
                        <Line key={d.key} type="monotone" dataKey={d.key} name={d.label} stroke={STATUS_COLOR[d.key]} strokeWidth={2}
                          dot={{ r: 3, fill: STATUS_COLOR[d.key] }} hide={hiddenLines.has(d.key)} isAnimationActive={false} />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </ChartPanel>
              </div>

              {/* 4. Person contribution (pie with drill-down) | Actual vs target by month. */}
              <div className={styles.grid}>
                <ChartPanel title="Person contribution" {...vh('promotion.salesPeople.contributions')}
                  headerActions={<ExportPdfButton onClick={exportPie} downloading={downloading === 'pie'} disabled={!pieSlices.length} />}>
                  <nav aria-label="Contribution level" className={styles.breadcrumb}>
                    <button type="button" onClick={() => setDrill([])} aria-current={drill.length === 0 ? 'page' : undefined}>All</button>
                    {drill.map((step, i) => (
                      <React.Fragment key={`${step.level}-${step.key}`}>
                        <ChevronRight size={12} aria-hidden />
                        <button type="button" onClick={() => setDrill((path) => path.slice(0, i + 1))}
                          aria-current={i === drill.length - 1 ? 'page' : undefined}>{step.label}</button>
                      </React.Fragment>
                    ))}
                  </nav>
                  {selected && shares.length > 0 && (
                    <p className={styles.shareRow} aria-label={`${selected.name} share of YTD actual`}>
                      {shares.map((sh, i) => (
                        <React.Fragment key={sh.level}>
                          {i > 0 && ' · '}
                          {i === 0 ? 'Share of ' : ''}{sh.level === 'total' ? 'Total' : CONTRIBUTION_LEVEL_LABEL[sh.level]}: <strong>{pct(sh.share)}</strong>
                        </React.Fragment>
                      ))}
                    </p>
                  )}
                  <p className={styles.caption}>
                    Share of YTD actual by {contributions.level ? CONTRIBUTION_LEVEL_LABEL[contributions.level].toLowerCase() : 'level'}
                    {' '}· {selected ? `${selected.name} highlighted` : cohortCaption}{canDrill ? ' · click a slice to drill down' : ''}
                  </p>
                  {!pieSlices.length ? (
                    <EmptyState message="No sales in this selection." />
                  ) : (
                    <div className={styles.pieWrap}>
                      <div className={styles.pie}>
                        <ResponsiveContainer width="100%" height={260}>
                          <PieChart>
                            <Pie data={pieData} dataKey="actual" nameKey="label" innerRadius="48%" outerRadius="74%"
                              stroke="var(--ps-card-bg)" strokeWidth={2} isAnimationActive={false}
                              activeIndex={pieData.flatMap((s, i) => (s.highlighted ? [i] : []))}
                              activeShape={(props: React.ComponentProps<typeof Sector> & { midAngle?: number }) => {
                                // Pull the highlighted slice out along its middle angle.
                                const angle = -((props.midAngle ?? 0) * Math.PI) / 180;
                                return <Sector {...props} cx={(props.cx ?? 0) + 8 * Math.cos(angle)} cy={(props.cy ?? 0) + 8 * Math.sin(angle)} />;
                              }}
                              onClick={(slice: { key: string; label: string }) => drillInto(slice)}
                              labelLine={false}
                              label={({ x, y, payload, textAnchor }: { x: number; y: number; textAnchor: 'start' | 'end' | 'middle';
                                payload: (typeof pieSlices)[number] }) => ((payload.share ?? 0) >= 0.04 ? (
                                <text x={x} y={y} textAnchor={textAnchor} dominantBaseline="central" fontSize={11} fill="var(--ps-color-text)">
                                  {payload.label.length > 16 ? `${payload.label.slice(0, 15)}…` : payload.label} {pct(payload.share)}
                                </text>
                              ) : null)}>
                              {pieData.map((s) => (
                                <Cell key={s.key} fill={s.color} fillOpacity={selected && !s.highlighted ? 0.3 : 1}
                                  style={canDrill ? { cursor: 'pointer' } : undefined} />
                              ))}
                            </Pie>
                            <Tooltip {...chartTooltipProps} content={({ active, payload }: TooltipProps<(typeof pieSlices)[number]>) => {
                              const s = active ? payload?.[0]?.payload : undefined;
                              if (!s) return null;
                              const personStatus = contributions.level === 'person' ? statusOfSlice(s.key) : undefined;
                              return (
                                <TooltipBox title={`${s.label} · ${pct(s.share)}`}>
                                  <div>Actual: {formatCurrency(s.actual)}</div>
                                  <div>Target: {formatCurrency(s.target)}</div>
                                  {contributions.level === 'person' ? (
                                    <>
                                      <div>Variance to YTD target: {variance(s.target > 0 ? (s.actual - s.target) / s.target : null)}</div>
                                      {personStatus && <div>Tier: {label(personStatus)}</div>}
                                    </>
                                  ) : (
                                    <>
                                      <div>Achievement: {pct(s.achievement)}</div>
                                      <div>{headcount(s.people)}</div>
                                    </>
                                  )}
                                </TooltipBox>
                              );
                            }} />
                          </PieChart>
                        </ResponsiveContainer>
                      </div>
                      <ul className={styles.pieLegend} aria-label="Contribution slices">
                        {pieSlices.map((s) => (
                          <li key={s.key}>
                            <button type="button" disabled={!canDrill} onClick={() => drillInto(s)} data-highlighted={s.highlighted || undefined}
                              data-dimmed={(!!selected && !s.highlighted) || undefined}
                              aria-label={`${s.label}: ${pct(s.share)} of actual, ${formatCurrency(s.actual)}${canDrill ? '. Drill down' : ''}`}>
                              <i style={{ background: s.color }} aria-hidden />
                              <span className={styles.pieLabel} dir="auto">{s.label}</span>
                              <span className={styles.pieShare}>{pct(s.share)}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </ChartPanel>

                <ChartPanel title="Actual vs target by month" {...vh('promotion.salesPeople.actualVsTarget')}
                  headerActions={<ExportPdfButton onClick={exportTrend} downloading={downloading === 'trend'} disabled={!trendPoints.length} />}>
                  <p className={styles.caption}>{cohortCaption} · LYD</p>
                  <TrendChart title="Actual vs target by month" showTitle={false} points={trendPoints} height={300}
                    tooltipValueFormatter={formatCurrency} valueFormatter={(v) => formatCompactCurrency(v)} />
                </ChartPanel>
              </div>

              {/* 5. Performance details: last on the page. */}
              <ChartPanel title={`Performance details · ${cohort.length}`} {...vh('promotion.salesPeople.details')}>
                <DataGrid columns={detailColumns} rows={personRows} getRowId={(r) => r.id}
                  fileName="salesforce-performance-details" extraFilterParts={selectionParts}
                  onRowClick={(r) => choosePerson(r.key)} pageSize={25} />
              </ChartPanel>
            </>
          )}
        </main>
        <RefreshFooter lastRefreshTime={refresh.data ? formatTimestamp(refresh.data.lastRefreshTime) : undefined} />
        <BottomNavBar active="Salesforce Performance" />
      </div>
    </PermissionGuard>
  );
}
