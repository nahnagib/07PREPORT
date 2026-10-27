'use client';
import React, { useState } from 'react';
import type { CampaignsData } from '../../../lib/marcom/types';
import { fmtInt, fmtLyd, fmtPct } from '../../../lib/marcom/format';
import { CITY_COORDS, LIBYA_PATH, MAP_H, MAP_W, NEIGHBOUR_PATHS, project } from '../../../lib/marcom/libyaMap';
import { t } from '../../../lib/marcom/text';
import { MarcomChartCard } from '../MarcomChartCard';
import { TooltipCard } from './chartKit';

type City = CampaignsData['coverageByCity']['cities'][number];

const shortType = (s: string) => s.replace(/^\d+-/, '');
/** Bubble area proportional to cost: radius = sqrt(cost / max) * MAX_R (min 4 so small cities stay visible). */
const MAX_R = 34;
const MIN_R = 4;
const BUBBLE = 'var(--ps-color-accent)';
/** How many of the biggest cities get a name label on the map (the rest show on hover / in the list). */
const LABELLED = 8;
/** Room around Libya's frame so coastal bubbles (Tripoli, Benghazi...) are never clipped at the top edge. */
const PAD = { top: 44, right: 24, bottom: 12, left: 24 };
const VB = { x: -PAD.left, y: -PAD.top, w: MAP_W + PAD.left + PAD.right, h: MAP_H + PAD.top + PAD.bottom };
const LIBYA_FILL = 'color-mix(in srgb, var(--ps-color-accent) 9%, var(--ps-color-surface))';
const LIBYA_STROKE = 'color-mix(in srgb, var(--ps-color-accent) 45%, var(--ps-color-muted-text))';

/**
 * Greedy label placement: biggest city first; a label is skipped when its box would overlap one already placed,
 * so clustered coastal cities (Tripoli / Zawiya / Khoms) don't print on top of each other. Hover always labels.
 */
function placeLabels(items: { city: string; x: number; y: number; r: number }[]): Set<string> {
  const boxes: { x0: number; y0: number; x1: number; y1: number }[] = [];
  const out = new Set<string>();
  for (const it of items) {
    if (out.size >= LABELLED) break;
    const w = it.city.length * 7.4 + 6;
    const box = { x0: it.x + it.r + 2, y0: it.y - 9, x1: it.x + it.r + 2 + w, y1: it.y + 7 };
    if (boxes.some((b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0)) continue;
    boxes.push(box);
    out.add(it.city);
  }
  return out;
}

/**
 * Media Campaign Performance -- city map (template 1.1, P2 Table B City column). An offline Libya outline with one
 * bubble per city sized by media COST; hover shows cost, units, campaigns and the media-type breakdown. The ranked
 * list beside it carries the same numbers, and the "View as table" toggle gives the full data table.
 * Rows uploaded before the City column ("No city") cannot be placed, so they are listed under the map instead.
 */
export function CityMapCard({ data, refreshing }: { data: CampaignsData['coverageByCity']; refreshing?: boolean }) {
  const [hover, setHover] = useState<string | null>(null);
  const placed = data.cities.filter((c) => CITY_COORDS[c.city]);
  const unplaced = data.cities.filter((c) => !CITY_COORDS[c.city]);
  const max = Math.max(0, ...placed.map((c) => c.cost));
  const radius = (cost: number) => (max > 0 ? Math.max(MIN_R, Math.sqrt(cost / max) * MAX_R) : MIN_R);
  const hovered = data.cities.find((c) => c.city === hover) ?? null;
  // Draw big bubbles first so small ones stay clickable on top.
  const drawOrder = [...placed].sort((a, b) => b.cost - a.cost);
  const pts = drawOrder.map((c) => {
    const [lat, lon] = CITY_COORDS[c.city];
    const [x, y] = project(lon, lat);
    return { city: c.city, x, y, r: radius(c.cost) };
  });
  const labelled = placeLabels(pts);

  const tip = (c: City) => (
    <TooltipCard
      title={c.city}
      lines={[
        { label: t('p2.mapCost'), value: fmtLyd(c.cost) },
        { label: t('p2.mapShare'), value: fmtPct(c.share) },
        { label: t('p2.costUnits'), value: fmtInt(c.units) },
        { label: t('p2.mapCampaigns'), value: fmtInt(c.campaigns) },
        ...c.byType.map((b) => ({ label: shortType(b.mediaType), value: `${fmtLyd(b.cost)} · ${fmtInt(b.units)} ${t('p2.coverageCentre')}` })),
      ]}
    />
  );

  return (
    <MarcomChartCard
      visual="campaigns.cityMap" title={t('p2.cityMap')} subtitle={t('p2.cityMapNote')} refreshing={refreshing} interactive
      empty={data.cities.length === 0 ? t('p2.cityMapEmpty') : undefined}
      summary={data.cities.map((c) => `${c.city} ${fmtLyd(c.cost)} (${fmtPct(c.share)})`).join(', ')}
      table={{
        caption: t('p2.cityMap'),
        columns: [t('p2.mapCity'), t('p2.mapCost'), t('p2.mapShare'), t('p2.costUnits'), t('p2.mapCampaigns')],
        rows: data.cities.map((c) => [c.city, fmtLyd(c.cost), fmtPct(c.share), fmtInt(c.units), fmtInt(c.campaigns)]),
      }}
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.7fr) minmax(220px, 1fr)', gap: 16, alignItems: 'start' }} className="marcom-citymap-grid">
        <div style={{ position: 'relative' }}>
          <svg viewBox={`${VB.x} ${VB.y} ${VB.w} ${VB.h}`} width="100%" role="img" aria-label={t('p2.cityMap')} data-testid="city-map" style={{ display: 'block', maxHeight: 540, margin: '0 auto' }}>
            <defs>
              <clipPath id="marcom-map-frame"><rect x={VB.x} y={VB.y} width={VB.w} height={VB.h} rx="10" /></clipPath>
            </defs>
            <g clipPath="url(#marcom-map-frame)">
              {/* sea */}
              <rect x={VB.x} y={VB.y} width={VB.w} height={VB.h} fill="var(--ps-color-page-bg)" />
              {Object.entries(NEIGHBOUR_PATHS).map(([name, d]) => (
                <path key={name} d={d} fill="var(--ps-color-muted-bg)" fillOpacity={0.45} stroke="var(--ps-color-border)" strokeWidth={0.8} />
              ))}
              <path d={LIBYA_PATH} fill={LIBYA_FILL} stroke={LIBYA_STROKE} strokeWidth={1.4} />
              {drawOrder.map((c, i) => {
                const { x, y, r } = pts[i];
                const on = hover === c.city;
                return (
                  <g key={c.city} data-testid="city-bubble" data-city={c.city}
                    onMouseEnter={() => setHover(c.city)} onMouseLeave={() => setHover(null)}
                    onFocus={() => setHover(c.city)} onBlur={() => setHover(null)} tabIndex={0}
                    aria-label={`${c.city}: ${fmtLyd(c.cost)}`} style={{ cursor: 'pointer', outline: 'none' }}>
                    <circle cx={x} cy={y} r={r} fill={BUBBLE} fillOpacity={on ? 0.75 : 0.45} stroke={BUBBLE} strokeWidth={on ? 2.5 : 1.5} />
                    <circle cx={x} cy={y} r={2.2} fill="var(--ps-color-text)" pointerEvents="none" />
                    {(labelled.has(c.city) || on) && (
                      <text x={x + r + 4} y={y + 4} fontSize={13} pointerEvents="none" fontWeight={600} fill="var(--ps-color-text)" stroke="var(--ps-color-surface)" strokeWidth={3} paintOrder="stroke">
                        {c.city}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          </svg>
          {hovered && CITY_COORDS[hovered.city] && (
            <div style={{ position: 'absolute', bottom: 8, insetInlineEnd: 8, pointerEvents: 'none', zIndex: 5, maxWidth: 260 }} data-testid="city-tip">
              {tip(hovered)}
            </div>
          )}
        </div>

        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--ps-color-muted-text)', marginBottom: 8 }}>
            <span>{t('p2.mapTotal')}</span>
            <strong style={{ color: 'var(--ps-color-text)', fontVariantNumeric: 'tabular-nums' }}>{fmtLyd(data.totalCost)}</strong>
          </div>
          <ol aria-label={t('p2.mapRanking')} style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 440, overflowY: 'auto' }}>
            {data.cities.map((c) => (
              <li key={c.city} data-testid="city-row" data-city={c.city}
                onMouseEnter={() => setHover(c.city)} onMouseLeave={() => setHover(null)}
                style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 4, padding: '6px 8px', borderRadius: 8, background: hover === c.city ? 'var(--ps-color-muted-bg)' : 'transparent', fontSize: 13 }}>
                <span style={{ fontWeight: 600, color: CITY_COORDS[c.city] ? 'var(--ps-color-text)' : 'var(--ps-color-muted-text)' }}>{c.city}</span>
                <span style={{ fontVariantNumeric: 'tabular-nums', textAlign: 'end' }}>{fmtLyd(c.cost)}</span>
                <span aria-hidden="true" style={{ gridColumn: '1 / -1', height: 5, borderRadius: 999, background: 'var(--ps-color-muted-bg)', overflow: 'hidden' }}>
                  <span style={{ display: 'block', height: '100%', width: `${Math.max(2, Math.min(100, c.share ?? 0))}%`, background: BUBBLE, borderRadius: 999 }} />
                </span>
                <span style={{ gridColumn: '1 / -1', fontSize: 11, color: 'var(--ps-color-muted-text)' }}>
                  {fmtPct(c.share)} · {fmtInt(c.units)} {t('p2.coverageCentre')} · {t('p2.mapCampaignsN', { n: c.campaigns })}
                </span>
              </li>
            ))}
          </ol>
          {unplaced.length > 0 && (
            <p data-testid="city-unplaced" style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', margin: '8px 0 0' }}>
              {t('p2.mapUnplaced', { names: unplaced.map((c) => c.city).join(', ') })}
            </p>
          )}
        </div>
      </div>
      <style>{'@media (max-width: 760px) { .marcom-citymap-grid { grid-template-columns: 1fr !important; } }'}</style>
    </MarcomChartCard>
  );
}
