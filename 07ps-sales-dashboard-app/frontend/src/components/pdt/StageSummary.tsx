'use client';
import React from 'react';
import { tooltipBoxStyle } from '@07ps/ui';
import type { StageCode, StageTile } from '../../lib/pdt/api';
import { TooltipRow, useHoverTooltip } from '../product/ProductUi';
import { fmtDay } from './common';
import s from './Pdt.module.css';

/**
 * Development stage pipeline: one row of chevrons joined end to end (Idea › … › Launched) in the stage colours. Each
 * shows the stage, its count and share of the total; under it the overdue badge (only when > 0), the average readiness
 * and the next target date (each only when set). An empty stage is a narrow muted chevron that still shows 0. Hover = the
 * first products of the stage; click = onSelect (the page opens the stage's details table); the selected stage has an
 * outline. The tiles come from the backend summary (the page filters without the stage filter).
 */
export function StagePipeline({ tiles, totals, selected, onSelect }: {
  tiles: StageTile[];
  totals: { total: number; inPipeline: number; inMarket: number };
  selected: StageCode | null;
  onSelect: (stage: StageCode) => void;
}) {
  const tip = useHoverTooltip(260, 200);
  const byStage = new Map(tiles.map((t) => [t.stage as string, t]));
  const pct = (n: number) => (totals.total > 0 ? Math.round((n / totals.total) * 100) : 0);
  return (
    <div data-testid="pdt-pipeline">
      <p className={s.summaryTotals} data-testid="pdt-stage-totals">
        <b>{totals.total}</b> products · <b>{totals.inPipeline}</b> in pipeline · <b>{totals.inMarket}</b> in market
      </p>
      <div className={s.flow} role="list" aria-label="Pipeline stages">
        {tiles.map((t, i) => {
          const active = selected === t.stage;
          const empty = t.count === 0;
          return (
            <div key={t.stage} role="listitem" className={`${s.chevronCell}${empty ? ` ${s.chevronEmpty}` : ''}`}>
              <button
                type="button"
                className={`${s.chevron}${i === 0 ? ` ${s.chevronFirst}` : ''}${active ? ` ${s.chevronActive}` : ''}`}
                style={{ ['--stage' as string]: t.color }}
                aria-pressed={active}
                aria-label={`${t.label}: ${t.count} products (${pct(t.count)}%)`}
                onClick={() => onSelect(t.stage)}
                data-testid={`pdt-stage-${t.stage}`}
                {...tip.bind(t.stage)}
              >
                <span className={`${s.chevronInner}${i === 0 ? ` ${s.chevronFirst}` : ''}`}>
                  <span className={s.chevronName}>{t.label}</span>
                  <span className={s.chevronCount}>
                    {t.count}
                    {!empty && <small>{pct(t.count)}%</small>}
                  </span>
                  {!empty && (
                    <span className={s.chevronMeta}>
                      {t.overdue > 0 && <span className={s.overdueBadge}>{t.overdue} overdue</span>}
                      {t.avgReadiness !== null && <span>Avg {t.avgReadiness}%</span>}
                      {t.nextTarget && <span>Next {fmtDay(t.nextTarget)}</span>}
                    </span>
                  )}
                </span>
              </button>
            </div>
          );
        })}
      </div>
      {tip.render((key) => {
        const t = byStage.get(key);
        if (!t) return null;
        return (
          <div style={{ ...tooltipBoxStyle, padding: '8px 10px' }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>{t.label} · {t.count} product{t.count === 1 ? '' : 's'}</div>
            {(t.top ?? []).map((p) => <TooltipRow key={p.code} label={p.name} value={p.date ? fmtDay(p.date) : '—'} />)}
            {t.count > (t.top?.length ?? 0) && <div style={{ fontSize: 11, opacity: 0.75, marginTop: 4 }}>+{t.count - (t.top?.length ?? 0)} more · click for all</div>}
            {t.count === 0 && <div style={{ fontSize: 12, opacity: 0.75 }}>No products</div>}
          </div>
        );
      })}
    </div>
  );
}

/** ?stage=development <-> DEVELOPMENT (the dashboard keeps its single selected stage in the URL). */
export const stageToParam = (s: StageCode | null): string | null => (s ? s.toLowerCase().replace(/_/g, '-') : null);
export function stageFromParam(v: string | null | undefined): StageCode | null {
  const code = (v ?? '').toUpperCase().replace(/-/g, '_');
  return (['IDEA', 'RESEARCH', 'DEVELOPMENT', 'TESTING', 'LAUNCH_READY', 'LAUNCHED'] as const).find((c) => c === code) ?? null;
}
