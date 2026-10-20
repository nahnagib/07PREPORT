'use client';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { EmptyState, ErrorState, LoadingSkeleton, Select, type SelectOption } from '@07ps/ui';
import type { CreditCustomer, CreditPolicyZone, DebtAging } from '../../lib/api';
import { formatCompactMoney, formatDate, formatMoney, formatNumber } from '../../lib/format';
import {
  CHART_MIN_WIDTH,
  chartColumns,
  creditColor,
  creditBand,
  creditHeader,
  lastZoneAxisLabel,
  layoutCreditDots,
  nextZoneText,
  placeTooltip,
  zoneRange,
  timelineSections,
  type PlacedCreditDot,
} from '../../lib/debt/creditPolicy';

/** Four main statuses; BLOCK contains three action ranges with the same owner and colour.
 * Placement uses the days overdue of the oldest unpaid invoice (from its overdue date = the day after its due date),
 * size uses total outstanding, y avoids overlap.
 * Hover/focus shows policy details; click/Enter opens the customer's unpaid invoices. */

export interface CreditPolicyChartProps {
  data: DebtAging | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  /** the chart's own payment-term filter (deciding invoice's term); only filters customers */
  term: string | null;
  onTermChange: (term: string | null) => void;
  /** the page's currency view, for the title: "All currencies (≈ LYD)", "LYD", "USD" ... */
  viewLabel: string;
  /** a dot was clicked: open the customer's invoices */
  onCustomerClick: (c: CreditCustomer) => void;
}

const COMPANY_CURRENCY = 'LYD';
const days = (n: number) => `${formatNumber(n)} day${n === 1 ? '' : 's'}`;

/** Width of an element, following resizes. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

export function CreditPolicyChart({ data, loading, error, onRetry, term, onTermChange, viewLabel, onCustomerClick }: CreditPolicyChartProps) {
  const [hover, setHover] = useState<{ key: number; anchor: Element } | null>(null);
  const customers = useMemo(() => (data?.customers ?? []).filter((c) => !c.notYetDue && c.daysOverdue >= 0 && c.zone !== 'NOT_YET_DUE'), [data]);
  const approx = data?.allCurrencies ? '≈ ' : '';
  const ccy = data?.currency ?? COMPANY_CURRENCY;
  const money = useCallback((v: number) => `${approx}${formatMoney(ccy, v)}`, [approx, ccy]);
  const compact = useCallback((v: number) => `${approx}${formatCompactMoney(COMPANY_CURRENCY, v)}`, [approx]);
  const hovered = hover ? customers.find((c) => c.customerKey === hover.key) ?? null : null;
  useEffect(() => {
    if (hover && !customers.some((c) => c.customerKey === hover.key)) setHover(null);
  }, [customers, hover]);

  if (error) return <ErrorState message={error} onRetry={onRetry} />;
  if (!data) return loading ? <LoadingSkeleton variant="chart" /> : null;

  const termOptions: SelectOption[] = data.terms.map((t) => ({ value: t.key, label: `${t.label} (${formatNumber(t.customers)})` }));

  return (
    <section aria-label="Credit Policy Escalation" style={{ ...panel, opacity: loading ? 0.65 : 1, transition: 'opacity .15s' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 8 }}>
        <div style={{ minWidth: 0, flex: '1 1 440px' }}>
          <h3 style={h3}>Credit Policy Escalation · {viewLabel}</h3>
          <p style={note}>
            Each dot is a customer, placed by the number of days overdue of its oldest unpaid invoice (counted from the overdue date = day
            after due date). Click a dot for its details.
          </p>
        </div>
        <div style={{ width: 200, flex: '0 0 200px', maxWidth: '100%' }}>
          <Select label="PAYMENT TERM (FILTER)" options={termOptions} value={term ? [term] : []} onChange={(v) => onTermChange(v[0] ?? null)} placeholder="All terms" searchable />
        </div>
      </div>

      {customers.length === 0 ? (
        <EmptyState message="No customer is due or overdue with these filters." />
      ) : (
        <EscalationTrack
          data={data}
          customers={customers}
          money={money}
          compact={compact}
          hoveredKey={hover?.key ?? null}
          onHover={(c, anchor) => setHover(c && anchor ? { key: c.customerKey, anchor } : null)}
          onCustomerClick={onCustomerClick}
        />
      )}

      <div aria-label="Legend" style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', fontSize: 11, color: 'var(--ps-color-muted-text)', marginTop: 8 }}>
        <span>Dot size = amount outstanding</span>
        <span>Position = days overdue of the oldest unpaid invoice (from overdue date)</span>
        <span>Each customer appears once</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <svg width="14" height="14" aria-hidden>
            <circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--ps-color-text)" strokeDasharray="2.5 2" />
          </svg>
          Dashed ring = moves to the next zone within {data.escalationWindowDays} days
        </span>
        {data.asOf ? <span>Days counted to {formatDate(data.asOf)}</span> : null}
      </div>

      {hovered && hover ? <DotTooltip c={hovered} anchor={hover.anchor} zones={data.zones} money={money} foreign={!data.allCurrencies && ccy !== COMPANY_CURRENCY} /> : null}
    </section>
  );
}

// ---- the track ---------------------------------------------------------------------------------------------------------
const BAND_PAD = 10;
const BAND_H = 160;
const HEADER_H = 126;
const AXIS_H = 42;

function EscalationTrack({
  data,
  customers,
  money,
  compact,
  hoveredKey,
  onHover,
  onCustomerClick,
}: {
  data: DebtAging;
  customers: CreditCustomer[];
  money: (v: number) => string;
  compact: (v: number) => string;
  hoveredKey: number | null;
  onHover: (c: CreditCustomer | null, anchor?: Element) => void;
  onCustomerClick: (c: CreditCustomer) => void;
}) {
  const [ref, measured] = useWidth<HTMLDivElement>();
  const zones = data.zones;
  const cols = useMemo(() => chartColumns(Math.max(measured || 1100, 320), zones), [measured, zones]);
  const layout = useMemo(() => layoutCreditDots(customers, zones, cols, { maxHeight: BAND_H - BAND_PAD * 2 }), [customers, zones, cols]);
  const byKey = useMemo(() => new Map(customers.map((c) => [String(c.customerKey), c])), [customers]);
  const bandH = BAND_H;
  const mid = BAND_PAD - layout.top + (bandH - BAND_PAD * 2 - (layout.bottom - layout.top)) / 2;
  const height = bandH + AXIS_H;
  const summary = new Map(data.summary.zones.map((z) => [z.key, z]));
  const sections = timelineSections(zones);
  const order = [...layout.dots].sort((a, b) => b.r - a.r);
  const lastZone = zones[zones.length - 1];

  return (
    <div ref={ref} style={{ width: '100%', overflowX: 'auto', overflowY: 'hidden' }}>
      <div style={{ position: 'relative', width: cols.width, minWidth: CHART_MIN_WIDTH }}>
        <div style={{ position: 'relative', height: HEADER_H }}>
          {zones.map((z, i) => {
            const count = summary.get(z.key);
            return <Header key={z.key} x0={cols.zones[i].x0} x1={cols.zones[i].x1} zone={z}
              count={count?.customers ?? 0} amount={compact(count?.amountCompany ?? 0)} />;
          })}
          {sections.map((s, i) => s.key === 'BLOCK' ? (
            <div key={cols.sections[i].key} data-block-action={s.minDays}
              title={s.details}
              style={{ position: 'absolute', left: cols.sections[i].x0, width: cols.sections[i].x1 - cols.sections[i].x0,
                top: 78, bottom: 0, boxSizing: 'border-box', padding: '6px 8px', color: '#f3f4f6',
                background: creditBand('block'), borderTop: '1px solid #ffffff40',
                borderLeft: s.minDays > 45 ? '1px solid #ffffff40' : undefined }}>
              <div style={{ fontSize: 11, fontWeight: 700 }}>{s.maxDays === null ? `>${s.minDays - 1} Days` : zoneRange(s)}</div>
              <div style={{ marginTop: 3, fontSize: 10.5, lineHeight: 1.3 }}>{s.action}</div>
            </div>
          ) : null)}
        </div>
        <svg width={cols.width} height={height} viewBox={`0 0 ${cols.width} ${height}`} role="img"
          aria-label={`Credit Policy Escalation: ${customers.length} customers placed by days overdue`}
          style={{ display: 'block' }}>
          {zones.map((z, i) => (
            <rect key={z.key} data-zone={z.key} x={cols.zones[i].x0} y={0}
              width={cols.zones[i].x1 - cols.zones[i].x0} height={bandH} fill={creditBand(z.tone)} />
          ))}
          <line data-boundary="0" x1={0.75} x2={0.75} y1={0} y2={bandH + 6} stroke="var(--ps-credit-zone-ink)" strokeWidth={1.5} />
          {sections.slice(0, -1).map((s, i) => {
            const internal = s.key === 'BLOCK';
            const boundary = s.edgeLabel?.split(' ')[0] ?? s.maxDays;
            return <line key={cols.sections[i].key} data-boundary={boundary} data-internal={internal}
              x1={cols.sections[i].x1} x2={cols.sections[i].x1} y1={0} y2={bandH + 6}
              stroke={internal ? '#ffffff40' : 'var(--ps-credit-main-line)'} strokeWidth={internal ? 1 : 2}
              strokeDasharray={internal ? '3 5' : undefined} />;
          })}
          <text x={3} y={bandH + 17} fontSize={10.5} fontWeight={600} textAnchor="start" fill="var(--ps-color-text)">
            <tspan x={3}>Overdue date</tspan><tspan x={3} dy={14}>(Day 0)</tspan>
          </text>
          {sections.slice(0, -1).map((s, i) => (
            <text key={cols.sections[i].key} x={cols.sections[i].x1} y={bandH + 17} fontSize={10.5}
              textAnchor="middle" fill="var(--ps-color-text)">{s.edgeLabel ?? `${s.maxDays} Days`}</text>
          ))}
          <text x={(cols.sections[sections.length - 1].x0 + cols.width) / 2} y={bandH + 17} fontSize={10.5}
            textAnchor="middle" fill="var(--ps-color-text)">{lastZoneAxisLabel(zones)}</text>
          {order.map((p) => {
            const c = byKey.get(p.id) as CreditCustomer;
            const zone = zones.find((z) => z.key === c.zone) ?? lastZone;
            return <Dot key={p.id} p={p} c={c} zone={zone} cy={mid + p.y} money={money}
              nextText={nextZoneText(c, zones)} active={hoveredKey === c.customerKey}
              onHover={onHover} onClick={onCustomerClick} />;
          })}
        </svg>
      </div>
    </div>
  );
}

function Header({ x0, x1, zone, count, amount }: {
  x0: number; x1: number; zone: CreditPolicyZone; count: number; amount: string;
}) {
  const ink = zone.key === 'BLOCK' ? '#f3f4f6' : 'var(--ps-credit-zone-ink)';
  return (
    <div data-status={zone.key} style={{ position: 'absolute', left: x0, width: x1 - x0, top: 0, bottom: 0,
      boxSizing: 'border-box', background: creditBand(zone.tone), color: ink,
      borderRight: zone.key !== 'BLOCK' ? '1px solid var(--ps-credit-main-line)' : undefined }}>
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 5, height: 27,
        padding: '0 6px', background: creditHeader(zone.tone), color: zone.key === 'YELLOW' ? '#111827' : '#fff',
        fontSize: 11, fontWeight: 800, whiteSpace: 'nowrap' }}>
        <span>{zone.label}</span><span aria-hidden>·</span><span>{zoneRange(zone)}</span>
      </div>
      <div style={{ padding: '6px 8px', textAlign: 'center' }}>
        <div style={{ fontSize: 12, fontWeight: 700 }}>{zone.owner}</div>
        {zone.key !== 'BLOCK' ? <div style={{ fontSize: 11, marginTop: 3, lineHeight: 1.25, minHeight: 28 }}>{zone.action}</div> : null}
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', columnGap: 8, marginTop: 4,
          fontSize: 10.5, fontVariantNumeric: 'tabular-nums', lineHeight: 1.4 }}>
          <span><strong>{formatNumber(count)}</strong> customer{count === 1 ? '' : 's'}</span>
          <strong>{amount}</strong>
        </div>
      </div>
    </div>
  );
}

function Dot({
  p, c, zone, cy, money, nextText, active, onHover, onClick,
}: {
  p: PlacedCreditDot; c: CreditCustomer; zone: CreditPolicyZone; cy: number; money: (v: number) => string; nextText: string | null; active: boolean;
  onHover: (c: CreditCustomer | null, anchor?: Element) => void; onClick: (c: CreditCustomer) => void;
}) {
  const blocked = zone.key === 'BLOCK';
  const label = `${c.customer} · ${days(c.daysOverdue)} overdue · ${zone.label} (${zone.owner}) · ${money(c.totalOutstanding)}${nextText ? ` · ${nextText}` : ''}`;
  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={label}
      data-customer={c.customerKey}
      style={{ cursor: 'pointer', outline: 'none' }}
      onPointerEnter={(e) => onHover(c, e.currentTarget)}
      onPointerLeave={() => onHover(null)}
      onFocus={(e) => onHover(c, e.currentTarget)}
      onBlur={() => onHover(null)}
      onClick={() => onClick(c)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick(c);
        }
      }}
    >
      {c.approachingNextZone ? (
        <circle cx={p.x} cy={cy} r={p.r + 3.5} fill="none" stroke="var(--ps-credit-zone-ink)" strokeWidth={1} strokeDasharray="3 2.5">
          {nextText ? <title>{nextText}</title> : null}
        </circle>
      ) : null}
      <circle
        cx={p.x}
        cy={cy}
        r={p.r}
        fill={creditColor(zone.tone)}
        stroke={blocked ? '#f3f4f6' : active ? 'var(--ps-credit-zone-ink)' : 'var(--ps-credit-edge)'}
        strokeWidth={active ? 2.5 : blocked ? 1.1 : 0.9}
      />
      {p.overflow && p.r >= 10 ? (
        <text x={p.x} y={cy + 3.5} fontSize={c.daysOverdue >= 1000 ? 8 : 9.5} textAnchor="middle" fill="var(--ps-credit-ink)" fontWeight={700} pointerEvents="none">
          {c.daysOverdue}
        </text>
      ) : null}
    </g>
  );
}

// ---- tooltip -----------------------------------------------------------------------------------------------------------
function DotTooltip({ c, anchor, zones, money, foreign }: { c: CreditCustomer; anchor: Element; zones: CreditPolicyZone[]; money: (v: number) => string; foreign: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPos(placeTooltip(anchor.getBoundingClientRect(), { width: el.offsetWidth, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }));
  }, [anchor, c]);
  const zone = zones.find((z) => z.key === c.zone);
  const next = nextZoneText(c, zones);
  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      style={{
        position: 'fixed', zIndex: 1000, left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden', pointerEvents: 'none',
        width: 'min(330px, calc(100vw - 16px))', boxSizing: 'border-box', background: 'var(--ps-color-surface)', color: 'var(--ps-color-text)',
        border: '1px solid var(--ps-color-border)', borderRadius: 12, boxShadow: '0 12px 32px rgba(0,0,0,.22)', padding: '12px 14px', fontSize: 12.5,
      }}
    >
      <div dir="auto" style={{ fontSize: 14.5, fontWeight: 700, overflowWrap: 'anywhere' }}>
        {c.customer}
      </div>
      <div style={sub}>
        Code {c.customerCode} · {c.company}
      </div>
      {zone ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '8px 0 2px', fontWeight: 700 }}>
          <span aria-hidden style={{ width: 10, height: 10, borderRadius: '50%', background: creditColor(zone.tone), outline: zone.key === 'BLOCK' ? '1px solid #d1d5db' : undefined }} />
          {zone.label} · {zone.owner}
        </div>
      ) : null}
      <dl style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: '4px 12px', margin: '8px 0 0' }}>
        <Fact k="Total Outstanding LYD" v={<strong style={mono}>{formatMoney(COMPANY_CURRENCY, c.totalOutstandingCompany)}</strong>} />
        {foreign ? <Fact k="Invoice currency" v={<span style={mono}>{money(c.totalOutstanding)}</span>} /> : null}
        <Fact k="Unpaid invoices" v={<span style={mono}>{formatNumber(c.unpaidInvoiceCount)}</span>} />
        <Fact k="Oldest invoice" v={c.oldestInvoiceNumber ?? '—'} />
        <Fact k="Invoice date" v={formatDate(c.oldestInvoiceDate)} />
        <Fact k="Due date" v={formatDate(c.oldestDueDate)} />
        <Fact k="Overdue date" v={formatDate(c.oldestOverdueDate)} />
        <Fact k="Days overdue" v={<strong style={mono}>{formatNumber(c.daysOverdue)}</strong>} />
        <Fact k="Payment term" v={<span dir="auto">{c.paymentTerm}</span>} />
        <Fact k="Current Status" v={zone?.label ?? c.zone} />
        <Fact k="Responsible Role" v={c.responsibleRole} />
        <Fact k="Required Action" v={c.requiredAction} />
        {c.actionDetails ? <Fact k="Additional action" v={c.actionDetails} /> : null}
      </dl>
      {next ? <p style={{ ...sub, margin: '8px 0 0', fontWeight: 600, color: 'var(--ps-color-text)' }}>{next}</p> : null}
      <p style={{ ...sub, margin: '6px 0 0' }}>Click the dot for the customer&apos;s open invoices.</p>
    </div>,
    document.body,
  );
}

function Fact({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <>
      <dt style={{ color: 'var(--ps-color-muted-text)', whiteSpace: 'nowrap' }}>{k}</dt>
      <dd style={{ margin: 0, minWidth: 0, overflowWrap: 'anywhere' }}>{v}</dd>
    </>
  );
}

const h3: React.CSSProperties = { margin: 0, fontSize: 15, fontWeight: 700 };
const note: React.CSSProperties = { margin: '4px 0 0', fontSize: 11.5, lineHeight: 1.4, color: 'var(--ps-color-muted-text)', maxWidth: '110ch' };
const sub: React.CSSProperties = { fontSize: 12, color: 'var(--ps-color-muted-text)' };
const mono: React.CSSProperties = { fontVariantNumeric: 'tabular-nums' };
const panel: React.CSSProperties = {
  background: 'var(--ps-card-bg)', border: '1px solid var(--ps-color-border)', borderRadius: 'var(--ps-card-radius, 14px)',
  padding: '12px 12px 10px', boxShadow: 'var(--ps-card-shadow)', minWidth: 0,
};
