import React, { useId } from 'react';
import { EmptyState } from '@07ps/ui';
import type { NpsFollowupSummary } from '../../lib/api';
import { formatNumber } from '../../lib/format';
import { NPS_SLA, SLA_COLOR, slaShareText } from '../../lib/nps/sla';

type Ageing = NpsFollowupSummary['ageing'];

/** Solid = resolved; hatched = still open. Bucket colour communicates the close SLA. */
export const AGEING_SERIES = [
  { key: 'resolved', label: 'Resolved', hatched: false },
  { key: 'open', label: 'Still open', hatched: true },
] as const;

const W = 640;
const H = 250;
const PAD = { top: 26, right: 12, bottom: 34, left: 34 };

/** A round axis top for `max` with about four steps. */
function axisTop(max: number): { top: number; step: number } {
  if (max <= 4) return { top: Math.max(max, 1), step: 1 };
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  return { top: Math.ceil(max / step) * step, step };
}

/**
 * "Resolved Ageing": a vertical stacked bar per age bucket -- resolved cases by the time they took, open cases by
 * their age today -- with the "Close SLA 5 d" line between 2–5 d and 5–10 d (left = within SLA, right = breached).
 * Plain SVG (no click: the detractor list has no chart filter to hand a bucket to).
 */
export function AgeingBars({ ageing }: { ageing: Ageing }) {
  const patternId = `ageing-open-${useId().replace(/:/g, '')}`;
  const total = ageing.buckets.reduce((n, b) => n + b.resolved + b.open, 0);
  const { top, step } = axisTop(Math.max(...ageing.buckets.map((b) => b.resolved + b.open)));
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const band = plotW / ageing.buckets.length;
  const barW = Math.min(56, band * 0.62);
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  // the Close SLA line: the boundary after the last within-SLA bucket
  const lastIn = ageing.buckets.reduce((at, b, i) => (b.withinSla ? i : at), -1);
  const slaX = PAD.left + band * (lastIn + 1);
  const describe = ageing.buckets
    .map((b) => `${b.label}: ${b.resolved} resolved, ${b.open} open`)
    .join('; ');

  return (
    <div data-testid="fu-ageing">
      <div
        style={{ overflowX: 'auto' }}
        tabIndex={0}
        role="region"
        aria-label="Resolved Ageing chart; scroll horizontally on small screens"
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          role="img"
          style={{ display: 'block', minWidth: 520, maxHeight: 280 }}
          aria-label={`Resolved Ageing. ${describe}. Close SLA ${NPS_SLA.closeDays} days.`}
        >
          <defs>
            {[
              ['within', SLA_COLOR.green],
              ['breached', SLA_COLOR.red],
            ].map(([key, color]) => (
              <pattern
                key={key}
                id={`${patternId}-${key}`}
                width={7}
                height={7}
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(45)"
              >
                <rect width={7} height={7} fill="var(--ps-color-surface)" />
                <rect width={4} height={7} fill={color} />
              </pattern>
            ))}
          </defs>
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={y(t)}
                y2={y(t)}
                stroke="var(--ps-color-border)"
                strokeWidth={1}
              />
              <text
                x={PAD.left - 6}
                y={y(t)}
                textAnchor="end"
                dominantBaseline="central"
                fontSize={11}
                fill="var(--ps-color-muted-text)"
              >
                {formatNumber(t)}
              </text>
            </g>
          ))}
          {ageing.buckets.map((b, i) => {
            const cx = PAD.left + band * i + band / 2;
            const sum = b.resolved + b.open;
            let base = 0;
            return (
              <g
                key={b.key}
                data-testid={`fu-ageing-${b.key}`}
                data-resolved={b.resolved}
                data-open={b.open}
                data-within-sla={b.withinSla}
              >
                <title>{`${b.label} (${b.withinSla ? 'within SLA' : 'SLA breached'}): ${b.resolved} resolved, ${b.open} still open`}</title>
                {AGEING_SERIES.map((s) => {
                  const v = b[s.key];
                  if (v === 0) return null;
                  const y0 = y(base + v);
                  const h = y(base) - y0;
                  base += v;
                  const color = b.withinSla ? SLA_COLOR.green : SLA_COLOR.red;
                  return (
                    <rect
                      key={s.key}
                      data-series={s.key}
                      x={cx - barW / 2}
                      y={y0}
                      width={barW}
                      height={Math.max(h - 1, 1)}
                      style={{ color }}
                      fill={
                        s.hatched
                          ? `url(#${patternId}-${b.withinSla ? 'within' : 'breached'})`
                          : color
                      }
                      rx={2}
                    />
                  );
                })}
                {sum > 0 && (
                  <text
                    x={cx}
                    y={y(sum) - 5}
                    textAnchor="middle"
                    fontSize={11.5}
                    fontWeight={700}
                    fill="var(--ps-color-text)"
                  >
                    {formatNumber(sum)}
                  </text>
                )}
                <text
                  x={cx}
                  y={H - PAD.bottom + 16}
                  textAnchor="middle"
                  fontSize={11.5}
                  fill="var(--ps-color-text)"
                >
                  {b.label}
                </text>
              </g>
            );
          })}
          <line
            x1={PAD.left}
            x2={W - PAD.right}
            y1={y(0)}
            y2={y(0)}
            stroke="var(--ps-color-muted-text)"
            strokeWidth={1}
          />
          {lastIn >= 0 && (
            <g data-testid="fu-ageing-sla-line">
              <line
                x1={slaX}
                x2={slaX}
                y1={PAD.top - 14}
                y2={y(0)}
                stroke="var(--ps-color-text)"
                strokeWidth={1.5}
                strokeDasharray="5 4"
              />
              <text
                x={slaX}
                y={PAD.top - 18}
                textAnchor="middle"
                fontSize={11.5}
                fontWeight={700}
                fill="var(--ps-color-text)"
              >{`Close SLA ${NPS_SLA.closeDays} d`}</text>
              <text
                x={slaX - 8}
                y={H - 6}
                textAnchor="end"
                fontSize={11}
                fill="var(--ps-color-muted-text)"
              >
                ← within SLA
              </text>
              <text
                x={slaX + 8}
                y={H - 6}
                textAnchor="start"
                fontSize={11}
                fill="var(--ps-color-muted-text)"
              >
                breached →
              </text>
            </g>
          )}
        </svg>
      </div>
      {total === 0 && <EmptyState message="No resolved or open detractor cases in this period." />}
      <div
        style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, marginTop: 4 }}
        aria-hidden="true"
      >
        {AGEING_SERIES.map((s) => (
          <span
            key={s.key}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              color: 'var(--ps-color-text)',
            }}
          >
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 2,
                display: 'inline-block',
                background: s.hatched
                  ? 'repeating-linear-gradient(45deg, var(--ps-color-text) 0 2px, var(--ps-color-surface) 2px 4px)'
                  : 'var(--ps-color-text)',
              }}
            />
            {s.label}
          </span>
        ))}
        {[
          ['Within SLA', SLA_COLOR.green],
          ['Breached', SLA_COLOR.red],
        ].map(([label, color]) => (
          <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: color }} />
            {label}
          </span>
        ))}
      </div>
      <p
        data-testid="fu-ageing-sla"
        style={{
          fontSize: 12.5,
          fontWeight: 600,
          margin: '8px 0 0',
          color: 'var(--ps-color-text)',
        }}
      >
        Closed within SLA: {slaShareText(ageing.closedInSla)} · Contacted within{' '}
        {NPS_SLA.contactHours} h: {slaShareText(ageing.contactedInSla)}
      </p>
    </div>
  );
}
