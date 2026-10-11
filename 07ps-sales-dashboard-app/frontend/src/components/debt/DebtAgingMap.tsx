'use client';
import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { EmptyState, ErrorState, LoadingSkeleton, Select, type SelectOption } from '@07ps/ui';
import type { DebtAging, DebtAgingCustomer, DebtAgingRange, DebtAgingZone } from '../../lib/api';
import { formatDate, formatMoney, formatNumber } from '../../lib/format';
import { layoutAgingDots, type PlacedDot } from '../../lib/debt/agingLayout';
import { safeOdooUrl } from '../../lib/debt/view';

/**
 * Debt Report "Aging Map" (Price / Finance): the "Where every customer stands" chart and its legend. Every customer
 * of one currency is a dot, placed by the age of its oldest open invoice against that invoice's own payment term, in
 * four escalation zones (owner: sales rep -> sales director -> management -> legal). Renders GET /debt-report/aging as
 * received: zones, positions and day counts are computed by the server (backend measures/debtAging.ts); this
 * component only draws them (dot geometry: lib/debt/agingLayout.ts).
 *
 *   x = position (invoice age / term, real days when one term is picked), dot area = outstanding, dashed ring = reaches
 *   the next zone within the escalation window. Clicking a dot (or Enter on it) opens its details in a popup next to
 *   the dot; Esc, the close button or a click outside closes it. One popup at a time.
 *
 * Same base as the page's "Total debt" card: customer invoices only, so the map adds up to that card (same filters and
 * currency). Colour is never the only signal: the popup's pill and the band labels carry the zone name.
 */

export interface DebtAgingMapProps {
  data: DebtAging | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  /** the map's own term filter (on the deciding invoice): PaymentTermKey, 'due_date', 'missing' or null */
  term: string | null;
  onTermChange: (term: string | null) => void;
}

/** The company currency: amounts in another currency also show Odoo's LYD amount. */
const COMPANY_CURRENCY = 'LYD';

const zoneColor = (key: string) => `var(--ps-zone-${key}, var(--ps-color-muted-text))`;
const zoneSoft = (key: string) => `var(--ps-zone-${key}-soft, var(--ps-color-muted-bg))`;
const dotEdge = (key: string) => (key === 'black' ? 'var(--ps-zone-black-edge)' : 'var(--ps-color-surface)');
const mult = (m: number) => `${Number(m.toFixed(2))}×`;
const days = (n: number) => `${formatNumber(n)} day${n === 1 ? '' : 's'}`;

export function ZonePill({ zone, showOwner = true }: { zone: Pick<DebtAgingZone, 'key' | 'label' | 'owner'>; showOwner?: boolean }) {
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, padding: '2px 8px 2px 6px',
        borderRadius: 999, background: zoneSoft(zone.key), color: 'var(--ps-color-text)', whiteSpace: 'nowrap',
      }}
    >
      <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: zoneColor(zone.key), border: `1px solid ${dotEdge(zone.key)}` }} />
      {showOwner ? `${zone.label} · ${zone.owner}` : zone.label}
    </span>
  );
}

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

interface Selection {
  key: number;
  /** the dot the popup sits next to (focus goes back to it on close) */
  anchor: Element;
}

export function DebtAgingMap(props: DebtAgingMapProps) {
  const { data, loading, error, onRetry, term, onTermChange } = props;
  const [selected, setSelected] = useState<Selection | null>(null);

  const customers = useMemo(() => data?.customers ?? [], [data]);
  const zones = useMemo(() => data?.zones ?? [], [data]);
  const currency = data?.currency ?? '';
  const zoneByKey = useMemo(() => new Map(zones.map((z) => [z.key, z])), [zones]);
  const pickedTerm = data?.terms.find((t) => t.key === term) ?? null;
  const ranges = pickedTerm?.ranges ?? null;
  const sel = selected ? customers.find((c) => c.customerKey === selected.key) ?? null : null;
  // a customer that is no longer on the map (new filters, new data) closes its popup
  useEffect(() => {
    if (selected && !customers.some((c) => c.customerKey === selected.key)) setSelected(null);
  }, [customers, selected]);
  const select = useCallback((key: number, anchor: Element) => setSelected((s) => (s?.key === key ? null : { key, anchor })), []);
  const close = useCallback(
    (restoreFocus: boolean) => {
      if (restoreFocus && selected?.anchor instanceof SVGElement) selected.anchor.focus();
      setSelected(null);
    },
    [selected],
  );

  if (error) return <ErrorState message={error} onRetry={onRetry} />;
  if (!data) return loading ? <LoadingSkeleton variant="chart" /> : null;

  const termOptions: SelectOption[] = data.terms.map((t) => ({ value: t.key, label: `${t.label} (${formatNumber(t.customers)})` }));

  return (
    <section aria-label="Aging Map" style={{ ...panel, opacity: loading ? 0.65 : 1, transition: 'opacity .15s' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, marginBottom: 8 }}>
        <div style={{ minWidth: 0 }}>
          <h3 style={h3}>Where every customer stands · {currency || '—'}</h3>
          <p style={note}>
            Each dot is a customer, placed by the age of its oldest unpaid invoice against that invoice&apos;s own payment term. Click a dot for
            its details.
          </p>
        </div>
        <div style={{ width: 210, maxWidth: '100%' }}>
          <Select label="Payment term" options={termOptions} value={term ? [term] : []} onChange={(v) => onTermChange(v[0] ?? null)} placeholder="All terms" searchable />
        </div>
      </div>

      {customers.length === 0 ? (
        <EmptyState message={`No customer owes ${currency || 'anything'} with these filters.`} />
      ) : (
        <AgingTrack customers={customers} zones={zones} cap={data.settings.axisCap} ranges={ranges} selected={selected?.key ?? null} onSelect={select} currency={currency} />
      )}

      <div aria-label="Legend" style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 18px', fontSize: 12, color: 'var(--ps-color-muted-text)', marginTop: 6 }}>
        <span>Dot size = amount outstanding</span>
        <span>
          {pickedTerm && ranges
            ? `Showing ${pickedTerm.label} customers in real days${pickedTerm.termDays === 0 ? ` (${data.settings.minStep}-day steps, since the term is zero)` : ''}.`
            : "All terms on one track: each zone is stretched to the customer's own term. Pick a term to see real day counts."}
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span aria-hidden style={{ width: 12, height: 12, borderRadius: '50%', border: '2px dashed var(--ps-color-text)', display: 'inline-block' }} />
          Moves to the next zone within {days(data.settings.escalationWindowDays)} if unpaid
        </span>
      </div>

      {sel && selected ? (
        <DotPopup key={sel.customerKey} c={sel} anchor={selected.anchor} zoneByKey={zoneByKey} currency={currency} onClose={close} />
      ) : null}
    </section>
  );
}

// ---- the track --------------------------------------------------------------------------------------------------------
interface TrackProps {
  customers: DebtAgingCustomer[];
  zones: DebtAgingZone[];
  cap: number;
  ranges: DebtAgingRange[] | null;
  selected: number | null;
  onSelect: (key: number, anchor: Element) => void;
  currency: string;
}

const TOP = 34;
const BAND_PAD = 14;

export function AgingTrack({ customers, zones, cap, ranges, selected, onSelect, currency }: TrackProps) {
  const [ref, measured] = useWidth<HTMLDivElement>();
  const width = Math.max(measured || 960, 240);
  const narrow = width < 560;
  const hasOverflow = customers.some((c) => c.position > cap);
  const left = 12;
  const right = width - 12;
  const stripW = hasOverflow ? Math.min(150, Math.max(64, width * 0.13)) : 0;
  const plotRight = hasOverflow ? right - stripW - 10 : right;
  const overflow = hasOverflow ? { left: plotRight + 10 + 6, right: right - 6 } : null;

  const layout = useMemo(
    () =>
      layoutAgingDots(
        customers.map((c) => ({ id: String(c.customerKey), position: c.position, amount: c.outstanding })),
        { plotLeft: left, plotRight, cap, overflow, maxR: narrow ? 12 : 16, minR: narrow ? 3 : 3.5 },
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [customers, plotRight, cap, overflow?.left, overflow?.right, narrow],
  );
  const byKey = useMemo(() => new Map(customers.map((c) => [String(c.customerKey), c])), [customers]);
  const xs = (p: number) => left + (Math.min(Math.max(p, 0), cap) / cap) * (plotRight - left);
  const bandH = Math.max(150, layout.bottom - layout.top + BAND_PAD * 2);
  const mid = TOP + BAND_PAD - layout.top + (bandH - BAND_PAD * 2 - (layout.bottom - layout.top)) / 2;
  const height = TOP + bandH + 44;
  const ticks = [0, ...zones.filter((z) => z.upperMultiplier !== null).map((z) => z.upperMultiplier as number)];
  const tickLabel = (m: number, i: number): string => {
    if (ranges) return i === 0 ? '0' : formatNumber(ranges[i - 1]?.to ?? 0);
    if (narrow) return m === 0 ? '0' : mult(m);
    return m === 0 ? 'Invoice date' : i === 1 ? `Due (${mult(m)} term)` : `${mult(m)} term`;
  };
  // draw the biggest dots first so the small ones stay clickable on top
  const order = [...layout.dots].sort((a, b) => b.r - a.r);

  return (
    <div ref={ref} style={{ width: '100%', overflowX: 'auto', overflowY: 'hidden' }}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Aging Map: ${customers.length} customers placed by invoice age against their payment term`}>
        {zones.map((z, i) => {
          const x0 = xs(z.lowerMultiplier);
          const x1 = z.upperMultiplier === null ? right : xs(z.upperMultiplier);
          const showOwner = !narrow && x1 - x0 > 120;
          return (
            <g key={z.key}>
              <rect x={x0} y={TOP} width={Math.max(0, x1 - x0)} height={bandH} fill={zoneSoft(z.key)} />
              <rect x={x0} y={TOP} width={Math.max(0, x1 - x0)} height={6} fill={zoneColor(z.key)} />
              <text x={x0 + (x1 - x0 < 60 ? 4 : 8)} y={TOP - 10} fontSize={12} fontWeight={600} fill="var(--ps-color-text)">
                <title>{`${z.label} · ${z.owner}`}</title>
                {x1 - x0 < 60 ? z.label.slice(0, 1) : z.label}
              </text>
              {showOwner ? (
                <text x={x1 - 6} y={TOP - 10} fontSize={11} textAnchor="end" fill="var(--ps-color-muted-text)">
                  {z.owner}
                </text>
              ) : null}
              {i === zones.length - 1 && overflow ? (
                <>
                  <line x1={plotRight + 5} x2={plotRight + 5} y1={TOP + 8} y2={TOP + bandH} stroke="var(--ps-zone-black-edge)" strokeDasharray="3 3" />
                  <text x={(overflow.left + overflow.right) / 2} y={TOP + bandH + 20} fontSize={11} textAnchor="middle" fill="var(--ps-color-muted-text)">
                    {ranges && zones[0]?.upperMultiplier
                      ? `> ${formatNumber(Math.round((cap / zones[0].upperMultiplier) * (ranges[0]?.to ?? 0)))} days`
                      : `> ${mult(cap)}`}
                  </text>
                </>
              ) : null}
            </g>
          );
        })}
        {ticks.map((m, i) => {
          const x = xs(m);
          return (
            <g key={m}>
              <line x1={x} x2={x} y1={TOP} y2={TOP + bandH + 5} stroke="var(--ps-color-border)" />
              <text x={x} y={TOP + bandH + 20} fontSize={11} textAnchor={i === 0 ? 'start' : 'middle'} fill="var(--ps-color-muted-text)" style={mono}>
                {tickLabel(m, i)}
              </text>
            </g>
          );
        })}
        <text x={width / 2} y={height - 4} fontSize={11} textAnchor="middle" fill="var(--ps-color-muted-text)">
          {ranges ? 'Days since invoice date' : narrow ? 'Invoice age ÷ payment term' : "Invoice age relative to the customer's payment term"}
        </text>
        {order.map((p) => (
          <Dot key={p.id} p={p} c={byKey.get(p.id) as DebtAgingCustomer} mid={mid} selected={selected === Number(p.id)} onSelect={onSelect} currency={currency} />
        ))}
      </svg>
    </div>
  );
}

function Dot({ p, c, mid, selected, onSelect, currency }: { p: PlacedDot; c: DebtAgingCustomer; mid: number; selected: boolean; onSelect: (k: number, anchor: Element) => void; currency: string }) {
  const cy = mid + p.y;
  const label = `${c.customer} · ${c.termLabel} · invoice age ${days(c.invoiceAge)} · ${formatMoney(currency, c.outstanding)}`;
  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={`${label}, zone ${c.zone}`}
      aria-haspopup="dialog"
      aria-expanded={selected}
      data-customer={c.customerKey}
      style={{ cursor: 'pointer', outline: 'none' }}
      onClick={(e) => onSelect(c.customerKey, e.currentTarget)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(c.customerKey, e.currentTarget);
        }
      }}
    >
      <title>{label}</title>
      {c.escalatingSoon ? <circle cx={p.x} cy={cy} r={p.r + 3.5} fill="none" stroke="var(--ps-color-text)" strokeWidth={1.5} strokeDasharray="3 2.5" /> : null}
      <circle cx={p.x} cy={cy} r={p.r} fill={zoneColor(c.zone)} stroke={selected ? 'var(--ps-color-accent)' : dotEdge(c.zone)} strokeWidth={selected ? 3 : 1.25} />
      {p.overflow && p.r >= 9 ? (
        <text x={p.x} y={cy + 3} fontSize={c.invoiceAge >= 1000 ? 7.5 : 9} textAnchor="middle" fill="var(--ps-zone-ink)" fontWeight={600} pointerEvents="none">
          {c.invoiceAge}
        </text>
      ) : null}
    </g>
  );
}

// ---- the dot popup ----------------------------------------------------------------------------------------------------
const POPUP_MARGIN = 8;
const POPUP_GAP = 10;

/**
 * Where the popup goes, in viewport pixels: beside the dot (right, else left), vertically centred on it; when neither
 * side has room (a phone), under the dot, else above it. Always clamped inside the viewport.
 */
export function placePopup(
  dot: { left: number; top: number; right: number; bottom: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const m = POPUP_MARGIN;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, Math.max(lo, hi)));
  const cx = (dot.left + dot.right) / 2;
  const cy = (dot.top + dot.bottom) / 2;
  let left: number;
  let top: number;
  if (dot.right + POPUP_GAP + size.width <= viewport.width - m) {
    left = dot.right + POPUP_GAP;
    top = cy - size.height / 2;
  } else if (dot.left - POPUP_GAP - size.width >= m) {
    left = dot.left - POPUP_GAP - size.width;
    top = cy - size.height / 2;
  } else {
    left = cx - size.width / 2;
    top = dot.bottom + POPUP_GAP + size.height <= viewport.height - m ? dot.bottom + POPUP_GAP : dot.top - POPUP_GAP - size.height;
  }
  return { left: clamp(left, m, viewport.width - m - size.width), top: clamp(top, m, viewport.height - m - size.height) };
}

function DotPopup({ c, anchor, zoneByKey, currency, onClose }: {
  c: DebtAgingCustomer;
  anchor: Element;
  zoneByKey: Map<string, DebtAgingZone>;
  currency: string;
  onClose: (restoreFocus: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const place = () => {
      const el = ref.current;
      if (!el) return;
      setPos(placePopup(anchor.getBoundingClientRect(), { width: el.offsetWidth, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }));
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor, c]);

  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose(true);
    };
    // a click on another dot is that dot's own click (it moves the popup), not an outside click
    const onDown = (e: PointerEvent | MouseEvent) => {
      const t = e.target as Element | null;
      if (!t || ref.current?.contains(t) || t.closest?.('[data-customer]')) return;
      onClose(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown as unknown as EventListener);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown as unknown as EventListener);
    };
  }, [onClose]);

  const zone = zoneByKey.get(c.zone);
  const next = c.nextZone ? zoneByKey.get(c.nextZone) : undefined;
  const odoo = safeOdooUrl(c.odooUrl);
  const foreign = currency !== '' && currency !== COMPANY_CURRENCY;

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      tabIndex={-1}
      style={{
        position: 'fixed', zIndex: 1000, left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden',
        width: 'min(320px, calc(100vw - 16px))', maxHeight: 'calc(100vh - 16px)', overflowY: 'auto', boxSizing: 'border-box',
        background: 'var(--ps-color-surface)', color: 'var(--ps-color-text)', border: '1px solid var(--ps-color-border)', borderRadius: 12,
        boxShadow: '0 12px 32px rgba(0,0,0,.18)', padding: '14px 16px', fontSize: 13, outline: 'none',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div id={titleId} dir="auto" style={{ fontSize: 15, fontWeight: 700, overflowWrap: 'anywhere' }}>
            {c.customer}
          </div>
          <div style={{ color: 'var(--ps-color-muted-text)', fontSize: 12 }}>{c.company}</div>
        </div>
        <button
          type="button"
          aria-label="Close"
          onClick={() => onClose(true)}
          style={{ all: 'unset', cursor: 'pointer', width: 28, height: 28, display: 'grid', placeItems: 'center', borderRadius: 6, fontSize: 18, lineHeight: 1, color: 'var(--ps-color-muted-text)' }}
        >
          ×
        </button>
      </div>
      {zone ? <div style={{ margin: '8px 0 4px' }}><ZonePill zone={zone} /></div> : null}
      <dl style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: '6px 12px', margin: '10px 0 0' }}>
        <Fact k="Payment term" v={<span dir="auto">{c.termLabel}</span>} />
        <Fact
          k="Oldest open invoice"
          v={
            <>
              {odoo ? (
                <a href={odoo} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--ps-color-accent)' }}>
                  {c.oldestOpenDocument ?? c.oldestOpenMoveId}
                </a>
              ) : (
                c.oldestOpenDocument ?? '—'
              )}
              <div style={sub}>
                Invoice {formatDate(c.invoiceDate)} · due {c.dueDate ? formatDate(c.dueDate) : '—'}
              </div>
            </>
          }
        />
        <Fact k="Invoice age" v={<span style={mono}>{days(c.invoiceAge)}</span>} />
        <Fact k="Days past due" v={<span style={mono}>{formatNumber(c.daysPastDue)}</span>} />
        <Fact
          k="Outstanding"
          v={
            <>
              <span style={{ ...mono, fontWeight: 600 }}>{formatMoney(currency, c.outstanding)}</span>
              {foreign ? <div style={{ ...sub, ...mono }}>≈ {formatMoney(COMPANY_CURRENCY, c.outstandingCompany)}</div> : null}
            </>
          }
        />
        <Fact k="Open invoices" v={<span style={mono}>{formatNumber(c.openInvoices)}</span>} />
        <Fact
          k="Next"
          v={next && c.daysToNextZone !== null ? `${next.label} (${next.owner}) in ${days(c.daysToNextZone)}` : `With ${(zone?.owner ?? 'legal').toLowerCase()}`}
        />
      </dl>
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

const h3: React.CSSProperties = { margin: 0, fontSize: 16, fontWeight: 700 };
const note: React.CSSProperties = { margin: '4px 0 0', fontSize: 13, color: 'var(--ps-color-muted-text)', maxWidth: '75ch' };
const sub: React.CSSProperties = { fontSize: 12, color: 'var(--ps-color-muted-text)' };
const mono: React.CSSProperties = { fontVariantNumeric: 'tabular-nums' };
const panel: React.CSSProperties = {
  background: 'var(--ps-card-bg)', border: '1px solid var(--ps-color-border)', borderRadius: 'var(--ps-card-radius, 14px)',
  padding: '16px 16px 14px', boxShadow: 'var(--ps-card-shadow)', minWidth: 0,
};
