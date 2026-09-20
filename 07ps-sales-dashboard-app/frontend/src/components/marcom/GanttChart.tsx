'use client';
import React, { useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight } from 'lucide-react';
import { buildTicks, GanttRange, layoutBar, markerPos, pixelsPerDay, rangeDays, tickGranularity } from '../../lib/marcom/gantt';
import { fmtDate, monthName } from '../../lib/marcom/format';
import { t } from '../../lib/marcom/text';

export interface GanttRow {
  id: string;
  label: string;
  sublabel?: string;
  start: string;
  /** null/undefined -> a milestone marker on the start date (planned but not completed). */
  end?: string | null;
  status: string;
  color: string;
  overdue?: boolean;
  details: { label: string; value: string }[];
}

export interface GanttChartProps {
  rows: GanttRow[];
  range: GanttRange;
  /** 'YYYY-MM-DD' of today in the business timezone (from the API). */
  today?: string;
  legend: { label: string; color: string }[];
  ariaLabel: string;
  labelWidth?: number;
  rowHeight?: number;
  /** Rows rendered before "Show all" (keeps 100+ rows smooth). */
  pageSize?: number;
}

const HEADER_H = 40;

const monthLabel = (year: number, month: number, showYear: boolean) => `${monthName(month)}${showYear ? ` ${year}` : ''}`;

function rowSummary(r: GanttRow): string {
  const when = r.end ? `${fmtDate(r.start)} – ${fmtDate(r.end)}` : `${t('gantt.planned')} ${fmtDate(r.start)}, ${t('gantt.notCompleted')}`;
  return [r.label, r.status, when, r.overdue ? t('generic.overdue') : '', ...r.details.map((d) => `${d.label} ${d.value}`)].filter(Boolean).join('. ');
}

/**
 * Reusable Gantt chart (campaign timeline and event timeline). Sticky label column and axis, month
 * ticks with week/day ticks that adapt to the range, a today marker, status-coloured bars with a
 * legend, tooltips on hover AND keyboard focus, arrows for bars that overhang the selected period,
 * and milestone markers for items with a start but no end. Geometry lives in lib/marcom/gantt.ts.
 * Positions use logical (inline) offsets so the axis mirrors correctly if the page is ever RTL.
 */
export function GanttChart({ rows, range, today, legend, ariaLabel, labelWidth = 220, rowHeight = 34, pageSize = 60 }: GanttChartProps) {
  const [tip, setTip] = useState<string | null>(null);
  const [limit, setLimit] = useState(pageSize);
  const days = rangeDays(range);
  // Long ranges (month ticks) stretch to fit the card; short ranges keep a readable width per day and scroll sideways.
  const fluid = tickGranularity(days) === 'month';
  const trackMin = fluid ? 480 : Math.max(640, Math.round(days * pixelsPerDay(days)));
  const ticks = buildTicks(range, monthLabel);
  const todayPos = today ? markerPos(range, today) : null;
  const shown = rows.slice(0, limit);
  const tipRow = tip ? shown.find((r) => r.id === tip) : undefined;
  const tipIndex = tipRow ? shown.indexOf(tipRow) : -1;
  const tipGeo = tipRow ? layoutBar(range, tipRow) : null;

  if (rows.length === 0) {
    return <div role="status" style={{ padding: 24, textAlign: 'center', color: 'var(--ps-color-muted-text)', fontSize: 13 }}>{t('gantt.noRows')}</div>;
  }

  return (
    <div data-testid="gantt" aria-label={ariaLabel} role="group" onKeyDown={(e) => { if (e.key === 'Escape') setTip(null); }}>
      <ul aria-label={t('gantt.legend')} style={{ display: 'flex', flexWrap: 'wrap', gap: 12, listStyle: 'none', padding: 0, margin: '0 0 8px', fontSize: 12 }}>
        {legend.map((l) => (
          <li key={l.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span aria-hidden="true" style={{ width: 12, height: 12, borderRadius: 3, background: l.color, display: 'inline-block' }} />
            {l.label}
          </li>
        ))}
        {todayPos !== null && (
          <li style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span aria-hidden="true" style={{ width: 2, height: 14, background: 'var(--ps-color-alert)', display: 'inline-block' }} />
            {t('generic.today')}
          </li>
        )}
      </ul>

      <div style={{ overflow: 'auto', maxHeight: 480, border: '1px solid var(--ps-color-border)', borderRadius: 8, position: 'relative' }}>
        <div style={{ position: 'relative', width: fluid ? '100%' : labelWidth + trackMin, minWidth: labelWidth + trackMin }}>
          {/* axis */}
          <div style={{ display: 'flex', position: 'sticky', top: 0, zIndex: 4, height: HEADER_H, background: 'var(--ps-color-surface)', borderBottom: '1px solid var(--ps-color-border)' }}>
            <div style={{ ...LABEL_CELL(labelWidth), height: HEADER_H, zIndex: 5, fontSize: 11, color: 'var(--ps-color-muted-text)', alignItems: 'flex-end', paddingBottom: 4 }}>
              {fmtDate(range.start)} – {fmtDate(range.end)}
            </div>
            <div data-testid="gantt-axis" style={{ position: 'relative', ...(fluid ? { flex: 1, minWidth: trackMin } : { width: trackMin }), height: HEADER_H }}>
              {ticks.map((tk, i) => (
                <span key={i} style={{ position: 'absolute', insetInlineStart: `${tk.pos}%`, bottom: 3, paddingInlineStart: 3, fontSize: tk.major ? 11.5 : 10, fontWeight: tk.major ? 700 : 400, color: tk.major ? 'var(--ps-color-text)' : 'var(--ps-color-muted-text)', borderInlineStart: `1px solid ${tk.major ? 'var(--ps-color-muted-text)' : 'var(--ps-color-border)'}`, height: tk.major ? 26 : 14, display: 'flex', alignItems: 'flex-end', whiteSpace: 'nowrap' }}>
                  {tk.label}
                </span>
              ))}
              {todayPos !== null && (
                <span data-testid="gantt-today-label" style={{ position: 'absolute', insetInlineStart: `${todayPos}%`, top: 2, transform: todayPos > 92 ? 'translateX(-100%)' : 'translateX(-50%)', fontSize: 10, fontWeight: 700, color: 'var(--ps-color-alert)', background: 'var(--ps-color-surface)', padding: '0 3px' }}>{t('generic.today')}</span>
              )}
            </div>
          </div>

          {/* gridlines + today marker under the rows */}
          <div aria-hidden="true" style={{ position: 'absolute', insetInlineStart: labelWidth, insetInlineEnd: 0, top: HEADER_H, height: shown.length * rowHeight, pointerEvents: 'none', zIndex: 1 }}>
            {ticks.filter((tk) => tk.major).map((tk, i) => (
              <span key={i} style={{ position: 'absolute', insetInlineStart: `${tk.pos}%`, top: 0, bottom: 0, borderInlineStart: '1px solid var(--ps-color-border)' }} />
            ))}
            {todayPos !== null && (
              <span data-testid="gantt-today" style={{ position: 'absolute', insetInlineStart: `${todayPos}%`, top: 0, bottom: 0, width: 2, background: 'var(--ps-color-alert)', opacity: 0.85 }} />
            )}
          </div>

          {/* rows */}
          {shown.map((r) => {
            const g = layoutBar(range, r);
            return (
              <div key={r.id} data-testid="gantt-row" style={{ display: 'flex', height: rowHeight, borderBottom: '1px solid var(--ps-color-border)' }}>
                <div style={LABEL_CELL(labelWidth)} title={`${r.label}${r.sublabel ? ` — ${r.sublabel}` : ''}`}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</div>
                    {r.sublabel && <div style={{ fontSize: 10.5, color: 'var(--ps-color-muted-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.sublabel}</div>}
                  </div>
                  {r.overdue && (
                    <span data-testid="gantt-overdue" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10.5, fontWeight: 700, color: 'var(--ps-color-text)', border: '1px solid var(--ps-color-alert)', background: 'var(--ps-color-alert-bg)', borderRadius: 999, padding: '0 6px', whiteSpace: 'nowrap' }}>
                      <AlertTriangle size={11} aria-hidden="true" style={{ color: 'var(--ps-color-alert)' }} />
                      {t('generic.overdue')}
                    </span>
                  )}
                </div>
                <div style={{ position: 'relative', ...(fluid ? { flex: 1, minWidth: trackMin } : { width: trackMin }), height: rowHeight }}>
                  {g.visible ? (
                    r.end === null || r.end === undefined ? (
                      <div
                        data-testid="gantt-milestone" data-status={r.status} role="img" tabIndex={0} aria-label={rowSummary(r)}
                        onMouseEnter={() => setTip(r.id)} onMouseLeave={() => setTip(null)} onFocus={() => setTip(r.id)} onBlur={() => setTip(null)}
                        style={{ position: 'absolute', insetInlineStart: `calc(${g.left + g.width / 2}% - 8px)`, top: (rowHeight - 16) / 2, width: 16, height: 16, zIndex: 2, cursor: 'pointer', outlineOffset: 3 }}
                      >
                        <span aria-hidden="true" style={{ display: 'block', width: 12, height: 12, margin: 2, transform: 'rotate(45deg)', background: r.color, border: `2px solid ${r.overdue ? 'var(--ps-color-alert)' : 'var(--ps-color-surface)'}`, boxSizing: 'border-box', boxShadow: '0 0 0 1px var(--ps-color-muted-text)' }} />
                      </div>
                    ) : (
                      <div
                        data-testid="gantt-bar" data-status={r.status} data-clipped-start={g.clippedStart || undefined} data-clipped-end={g.clippedEnd || undefined}
                        role="img" tabIndex={0} aria-label={rowSummary(r)}
                        onMouseEnter={() => setTip(r.id)} onMouseLeave={() => setTip(null)} onFocus={() => setTip(r.id)} onBlur={() => setTip(null)}
                        style={{
                          position: 'absolute', insetInlineStart: `${g.left}%`, width: `${g.width}%`, minWidth: 8, top: 6, height: rowHeight - 12, zIndex: 2,
                          background: r.color, borderRadius: `${g.clippedStart ? 0 : 5}px ${g.clippedEnd ? 0 : 5}px ${g.clippedEnd ? 0 : 5}px ${g.clippedStart ? 0 : 5}px`,
                          outline: r.overdue ? '2px dashed var(--ps-color-alert)' : undefined, outlineOffset: 1, cursor: 'pointer',
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between', color: '#fff',
                        }}
                      >
                        {g.clippedStart ? <ChevronLeft size={14} aria-label={t('gantt.clippedStart')} data-testid="gantt-clip-start" /> : <span />}
                        {g.clippedEnd ? <ChevronRight size={14} aria-label={t('gantt.clippedEnd')} data-testid="gantt-clip-end" /> : <span />}
                      </div>
                    )
                  ) : (
                    <span style={{ position: 'absolute', insetInlineStart: 8, top: 0, height: rowHeight, display: 'flex', alignItems: 'center', fontSize: 11, color: 'var(--ps-color-muted-text)' }}>
                      {g.clippedStart && !g.clippedEnd ? '◀ ' : ''}{fmtDate(r.start)}{r.end ? ` – ${fmtDate(r.end)}` : ''}{g.clippedEnd && !g.clippedStart ? ' ▶' : ''}
                    </span>
                  )}
                </div>
              </div>
            );
          })}

          {tipRow && tipGeo?.visible && (
            <div
              role="tooltip" data-testid="gantt-tooltip"
              style={{
                position: 'absolute', zIndex: 6, top: HEADER_H + (tipIndex + 1) * rowHeight + 4, insetInlineStart: `calc(${labelWidth}px + (100% - ${labelWidth}px) * ${(tipGeo.left > 60 ? tipGeo.left - 14 : tipGeo.left) / 100})`,
                maxWidth: 300, background: 'var(--ps-color-surface)', color: 'var(--ps-color-text)', border: '1px solid var(--ps-color-border)', borderRadius: 8, boxShadow: 'var(--ps-card-shadow)', padding: '8px 10px', fontSize: 12, pointerEvents: 'none',
              }}
            >
              <div style={{ fontWeight: 700, marginBottom: 4 }}>{tipRow.label}</div>
              <div>{tipRow.status}{tipRow.overdue ? ` · ${t('generic.overdue')}` : ''}</div>
              <div>{tipRow.end ? `${fmtDate(tipRow.start)} – ${fmtDate(tipRow.end)}` : `${t('gantt.planned')} ${fmtDate(tipRow.start)} (${t('gantt.notCompleted')})`}</div>
              {tipRow.details.map((d) => <div key={d.label}><span style={{ color: 'var(--ps-color-muted-text)' }}>{d.label}: </span>{d.value}</div>)}
            </div>
          )}
        </div>
      </div>

      {rows.length > limit && (
        <button type="button" onClick={() => setLimit(rows.length)} style={{ marginTop: 8, fontSize: 12, fontWeight: 600, padding: '4px 10px', borderRadius: 6, cursor: 'pointer', background: 'var(--ps-color-muted-bg)', color: 'var(--ps-color-text)', border: '1px solid var(--ps-color-border)' }}>
          {t('gantt.showAll', { n: rows.length })}
        </button>
      )}
    </div>
  );
}

const LABEL_CELL = (w: number): React.CSSProperties => ({
  position: 'sticky', insetInlineStart: 0, zIndex: 3, width: w, minWidth: w, boxSizing: 'border-box',
  background: 'var(--ps-color-surface)', borderInlineEnd: '1px solid var(--ps-color-border)',
  display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px',
});
