import React from 'react';
import type { NpsBand, NpsBandScale } from '../../lib/api';
import { BAND_COLOR, barRatio, fmt2 } from '../../lib/nps/view';

/**
 * CSAT as one vertical bar on 0..100: the red / yellow / green bands behind it (from /meta, config/npsThresholds.ts),
 * the bar in its band's colour, the value on top and the target marker. Greyed below the minimum number of responders.
 * No value = an empty track and "—". Theme tokens only (light and dark).
 */
export function CsatBar({ value, band, scale, muted = false, height = 180 }: {
  value: number | null;
  band: NpsBand | null;
  scale: NpsBandScale;
  muted?: boolean;
  height?: number;
}) {
  const width = 120;
  const top = 26;
  const bottom = height - 8;
  const barX = 44;
  const barW = 32;
  const y = (v: number) => bottom - barRatio(v, scale) * (bottom - top);
  const bands: { from: number; to: number; color: string }[] = [
    { from: scale.min, to: scale.yellowFrom, color: BAND_COLOR.red },
    { from: scale.yellowFrom, to: scale.greenFrom, color: BAND_COLOR.yellow },
    { from: scale.greenFrom, to: scale.max, color: BAND_COLOR.green },
  ];
  const fill = value === null ? null : y(value);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" data-testid="csat-bar"
      aria-label={`CSAT ${fmt2(value)}${value === null ? '' : '%'}, target ${scale.target}%`} style={{ opacity: muted ? 0.45 : 1 }}>
      {bands.map((b) => (
        <rect key={b.from} x={barX - 8} y={y(b.to)} width={barW + 16} height={y(b.from) - y(b.to)} fill={b.color} opacity={0.18} />
      ))}
      {[scale.min, scale.yellowFrom, scale.greenFrom, scale.max].map((t) => (
        <text key={t} x={barX - 12} y={y(t) + 3} fontSize={9} textAnchor="end" fill="var(--ps-color-muted-text)">{t}</text>
      ))}
      {fill !== null && band && (
        <rect x={barX} y={fill} width={barW} height={bottom - fill} rx={3} fill={BAND_COLOR[band]} data-testid="csat-fill" />
      )}
      <line x1={barX - 10} x2={barX + barW + 10} y1={y(scale.target)} y2={y(scale.target)} stroke="var(--ps-color-text)"
        strokeWidth={2} strokeDasharray="4 2" data-testid="csat-target" />
      <text x={barX + barW + 12} y={y(scale.target) + 3} fontSize={9} fill="var(--ps-color-text)">{`Target ${scale.target}`}</text>
      <text x={barX + barW / 2} y={(fill ?? bottom) - 6} fontSize={13} fontWeight={700} textAnchor="middle" fill="var(--ps-color-text)">
        {value === null ? '—' : `${fmt2(value)}%`}
      </text>
    </svg>
  );
}
