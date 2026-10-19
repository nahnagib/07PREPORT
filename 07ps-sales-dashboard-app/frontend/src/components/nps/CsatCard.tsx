import React from 'react';
import type { NpsBand, NpsBandScale } from '../../lib/api';
import { formatNumber } from '../../lib/format';
import { BAND_COLOR, barRatio, csatStatus, fmt2 } from '../../lib/nps/view';

const MUTED = 'var(--ps-color-muted-text)';

/** Axis labels at the scale ends and band edges. Read from the right: a label closer than 10% of the scale to the next
 * label on the first line drops to a second line (95 next to 100 would overlap on a phone). */
export function axisLabels(scale: NpsBandScale): { value: number; row: 1 | 2; edge: 'start' | 'end' | 'mid' }[] {
  const values = [scale.min, scale.yellowFrom, scale.greenFrom, scale.max];
  const out: { value: number; row: 1 | 2; edge: 'start' | 'end' | 'mid' }[] = [];
  let nextOnRow1 = Infinity;
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const r = barRatio(values[i], scale);
    const row: 1 | 2 = i > 0 && i < values.length - 1 && nextOnRow1 - r < 0.1 ? 2 : 1;
    if (row === 1) nextOnRow1 = r;
    out.unshift({ value: values[i], row, edge: i === 0 ? 'start' : i === values.length - 1 ? 'end' : 'mid' });
  }
  return out;
}

/**
 * CSAT card (replaces the vertical bar of step 2): the value in its band colour, a status line against the target, the
 * satisfied count, and a horizontal bullet bar 0..100 at full width -- red / yellow / green zones from /meta
 * (config/npsThresholds.ts), the value bar, a target tick with its label kept inside the card, axis labels at the band
 * edges. Below the minimum number of responders everything is grey with "n = x"; with no responders the value is "—".
 * Plain HTML positioned in %, so it fits any width (phone included). Theme tokens only (light and dark).
 */
export function CsatCard({ value, band, scale, satisfied, responders, belowMinimum }: {
  value: number | null;
  band: NpsBand | null;
  scale: NpsBandScale;
  satisfied: number;
  responders: number;
  belowMinimum: boolean;
}) {
  const empty = responders === 0 || value === null;
  const grey = empty || belowMinimum || band === null;
  const colour = grey ? MUTED : BAND_COLOR[band as NpsBand];
  const at = (v: number) => `${barRatio(v, scale) * 100}%`;
  const zones: { from: number; to: number; band: NpsBand }[] = [
    { from: scale.min, to: scale.yellowFrom, band: 'red' },
    { from: scale.yellowFrom, to: scale.greenFrom, band: 'yellow' },
    { from: scale.greenFrom, to: scale.max, band: 'green' },
  ];
  const status = empty ? null : csatStatus(value, band, scale.target);
  const targetNearEnd = barRatio(scale.target, scale) > 0.5;
  return (
    <div className="ps-csat" data-testid="csat-card" data-band={grey ? 'grey' : band}>
      <div className="ps-csat-value" style={{ color: colour }} data-testid="csat-value">{empty ? '—' : `${fmt2(value)}%`}</div>
      {belowMinimum && !empty ? (
        <div className="ps-csat-status" style={{ color: MUTED }} data-testid="csat-status">n = {formatNumber(responders)}</div>
      ) : status ? (
        <div className="ps-csat-status" style={{ color: colour }} data-testid="csat-status">{status}</div>
      ) : null}
      <div className="ps-csat-line" data-testid="csat-satisfied">
        {empty ? 'No responders for these filters'
          : `Satisfied ${formatNumber(satisfied)} of ${formatNumber(responders)} responders (Passives + Promoters)`}
      </div>

      <div className="ps-csat-bullet" role="img" data-testid="csat-bullet"
        aria-label={`CSAT ${empty ? 'no value' : `${fmt2(value)}%`}; red below ${scale.yellowFrom}, yellow ${scale.yellowFrom} to ${scale.greenFrom}, green from ${scale.greenFrom}; target ${scale.target}`}>
        <div className="ps-csat-target-label" data-testid="csat-target-label"
          style={targetNearEnd ? { right: `calc(100% - ${at(scale.target)})`, textAlign: 'right' } : { left: at(scale.target) }}>
          Target {scale.target}
        </div>
        <div className="ps-csat-track">
          {zones.map((z) => (
            <div key={z.band} className="ps-csat-zone" data-testid={`csat-zone-${z.band}`}
              style={{ left: at(z.from), width: `calc(${at(z.to)} - ${at(z.from)})`, background: grey ? MUTED : BAND_COLOR[z.band] }} />
          ))}
          {!empty && (
            <div className="ps-csat-fill" data-testid="csat-fill" style={{ width: at(value as number), background: colour }} />
          )}
          <div className="ps-csat-target" data-testid="csat-target" style={{ left: at(scale.target) }} />
        </div>
        <div className="ps-csat-axis" aria-hidden="true">
          {axisLabels(scale).map(({ value: t, row, edge }) => (
            <span key={t} data-testid={`csat-axis-${t}`} data-row={row}
              style={{ top: row === 2 ? 14 : 0, ...(edge === 'start' ? { left: 0 } : edge === 'end' ? { right: 0 } : { left: at(t), transform: 'translateX(-50%)' }) }}>
              {t}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
