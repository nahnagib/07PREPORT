'use client';
import React, { useEffect, useMemo, useState } from 'react';
import type { FlagCode, Product, StageCode, StageTile } from '../../lib/pdt/api';
import { HealthChip, Readiness, fmtDay, type Lookup } from './common';
import s from './Pdt.module.css';

const HEALTH_SEGMENTS: [keyof StageTile['health'], string, string][] = [
  ['onTrack', 'on track', 'var(--ps-color-success)'],
  ['atRisk', 'at risk', 'var(--ps-color-gold, #c4892f)'],
  ['blocked', 'blocked', 'var(--ps-color-alert)'],
  ['notSet', 'not set', 'var(--ps-color-muted-text)'],
];

/**
 * The landing page's pipeline: one row of six stage tiles (count, health split, average readiness, next target date,
 * warnings) from the backend summary. Clicking a tile selects the stage (the page's Stage filter) and opens its detail
 * panel below; clicking it again, ✕ or Esc closes it.
 */
export function StageTiles({ tiles, totals, selected, onSelect }: {
  tiles: StageTile[];
  totals: { total: number; inPipeline: number; inMarket: number };
  selected: StageCode | null;
  onSelect: (stage: StageCode | null) => void;
}) {
  return (
    <>
      <p className={s.summaryTotals} data-testid="pdt-stage-totals">
        <b>{totals.total}</b> products · <b>{totals.inPipeline}</b> in pipeline · <b>{totals.inMarket}</b> in market
      </p>
      <div className={s.summaryWrap}>
        <div className={s.tiles} role="list" aria-label="Pipeline stages">
          {tiles.map((t) => {
            const active = selected === t.stage;
            const launched = t.stage === 'LAUNCHED';
            const legend = HEALTH_SEGMENTS.filter(([k]) => t.health[k] > 0).map(([k, label]) => `${t.health[k]} ${label}`).join(' · ');
            return (
              <div key={t.stage} role="listitem" className={s.tileCell}>
                <button
                  type="button"
                  className={`${s.tile}${active ? ` ${s.tileActive}` : ''}${t.count === 0 ? ` ${s.tileEmpty}` : ''}`}
                  style={{ ['--stage' as string]: t.color }}
                  aria-pressed={active}
                  aria-expanded={active}
                  aria-controls="pdt-stage-detail"
                  onClick={() => onSelect(active ? null : t.stage)}
                  data-testid={`pdt-tile-${t.stage}`}
                >
                  <span className={s.tileName}>{t.label}</span>
                  <span className={s.tileCount}>{t.count}</span>
                  {t.count === 0 ? (
                    <span className={s.tileMuted}>No products</span>
                  ) : launched ? (
                    <span className={s.tileMuted}>in market</span>
                  ) : (
                    <>
                      <span className={s.healthBar} aria-hidden>
                        {HEALTH_SEGMENTS.filter(([k]) => t.health[k] > 0).map(([k, , color]) => (
                          <span key={k} style={{ flexGrow: t.health[k], background: color }} />
                        ))}
                      </span>
                      <span className={s.tileLegend}>{legend}</span>
                      <span className={s.tileMeta}>Avg readiness {t.avgReadiness === null ? '—' : `${t.avgReadiness}%`}</span>
                      <span className={`${s.tileMeta}${t.nextTargetPassed ? ` ${s.flagAlert}` : ''}`}>Next target {t.nextTarget ? fmtDay(t.nextTarget) : '—'}</span>
                      {(t.overdue > 0 || t.blocked > 0) && (
                        <span className={s.tileWarnings}>
                          {t.overdue > 0 && <span className={s.warnChip}>{t.overdue} overdue</span>}
                          {t.blocked > 0 && <span className={`${s.warnChip} ${s.warnChipAlert}`}>{t.blocked} blocked</span>}
                        </span>
                      )}
                    </>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      </div>
      {totals.total > 0 && (
        <div className={s.funnel} aria-label="Share of products per stage" data-testid="pdt-funnel">
          {tiles.filter((t) => t.count > 0).map((t) => (
            <span key={t.stage} style={{ flexGrow: t.count, background: t.color }} title={`${t.label}: ${t.count} of ${totals.total}`}>
              {t.count / totals.total >= 0.08 ? `${t.label} ${Math.round((t.count / totals.total) * 100)}%` : ''}
            </span>
          ))}
        </div>
      )}
    </>
  );
}

const FLAG_RANK: Record<FlagCode, number> = { OPEN_BLOCKER: 0, TARGET_PASSED: 1, HEALTH_NOT_SET: 2, LAUNCH_SOON_LOW_READINESS: 3 };
/** Blocked (health or open Blocker) first, then overdue, then health not set, then the rest; each by target date. */
const rank = (p: Product): number => (p.health === 'BLOCKED' ? 0 : p.flag ? FLAG_RANK[p.flag] : 4);

const ROWS = 10;

/** The open stage: a compact table (a simple list on a phone), sorted by flag then target, 10 rows, optional family groups. */
export function StageDetail({ tile, products, lookup, onClose, onOpenProduct }: {
  tile: StageTile;
  products: Product[];
  lookup: Lookup;
  onClose: () => void;
  onOpenProduct: (code: string) => void;
}) {
  const [all, setAll] = useState(false);
  const [byFamily, setByFamily] = useState(false);
  const [openFamilies, setOpenFamilies] = useState<Set<string>>(new Set());
  const sorted = useMemo(
    () => [...products].sort((a, b) => rank(a) - rank(b) || (a.targetLaunch ?? a.actualLaunch ?? '9999').localeCompare(b.targetLaunch ?? b.actualLaunch ?? '9999') || a.code.localeCompare(b.code, undefined, { numeric: true })),
    [products],
  );
  const groups = useMemo(() => {
    const m = new Map<string, Product[]>();
    for (const p of sorted) {
      const k = p.family ?? 'Family not set';
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(p);
    }
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  }, [sorted]);
  const launched = tile.stage === 'LAUNCHED';

  const rows = (list: Product[]) =>
    list.map((p) => (
      <tr key={p.code} className={s.rowLink} tabIndex={0} onClick={() => onOpenProduct(p.code)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpenProduct(p.code))} data-testid={`pdt-detail-row-${p.code}`}>
        <td className={s.muted}>{p.code}</td>
        <td><b>{p.name}</b></td>
        <td className={s.hidePhone}>{p.family ?? '—'}</td>
        <td><HealthChip code={p.health} lookup={lookup} /></td>
        <td className={s.hidePhone}>{p.ownerName ?? <span className={s.muted}>—</span>}</td>
        <td className={s.hidePhone}><Readiness pct={p.readinessPct} /></td>
        <td style={{ whiteSpace: 'nowrap' }} className={!launched && p.flag === 'TARGET_PASSED' ? s.flagAlert : undefined}>{fmtDay(launched ? p.actualLaunch : p.targetLaunch) || '—'}</td>
        <td className={s.hidePhone}>{p.flagLabel ? <span className={`${s.flag} ${p.flag === 'HEALTH_NOT_SET' ? s.flagMuted : p.flag === 'LAUNCH_SOON_LOW_READINESS' ? s.flagWatch : s.flagAlert}`}>{p.flagLabel}</span> : null}</td>
      </tr>
    ));

  const head = (
    <thead>
      <tr>
        <th>Code</th><th>Product</th><th className={s.hidePhone}>Family</th><th>Health</th><th className={s.hidePhone}>Owner</th><th className={s.hidePhone}>Readiness</th>
        <th>{launched ? 'Launched' : 'Target launch'}</th><th className={s.hidePhone}>Flag</th>
      </tr>
    </thead>
  );

  return (
    <section id="pdt-stage-detail" className={s.detailPanel} style={{ ['--stage' as string]: tile.color }} aria-label={`${tile.label} products`} data-testid="pdt-stage-detail">
      <div className={s.cardHead}>
        <div>
          <h3 className={s.cardTitle}>{tile.label} <span className={s.badge}>{products.length}</span></h3>
          <p className={s.cardSub}>{launched ? 'In market, latest launches last.' : 'Blocked, overdue and health-not-set first, then by target date.'} Click a product for details.</p>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <label className={s.muted} style={{ display: 'inline-flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
            <input type="checkbox" checked={byFamily} onChange={(e) => setByFamily(e.target.checked)} /> Group by family
          </label>
          <button type="button" className={s.close} onClick={onClose} aria-label={`Close ${tile.label}`}>×</button>
        </div>
      </div>
      {products.length === 0 && <p className={s.muted}>No products in this stage for the current filters.</p>}
      {products.length > 0 && !byFamily && (
        <>
          <div className={s.tableWrap}>
            <table className={`${s.table} ${s.compact}`}>
              {head}
              <tbody>{rows(all ? sorted : sorted.slice(0, ROWS))}</tbody>
            </table>
          </div>
          {sorted.length > ROWS && (
            <button type="button" className={s.showMore} onClick={() => setAll((x) => !x)}>{all ? 'Show fewer' : `Show all ${sorted.length}`}</button>
          )}
        </>
      )}
      {products.length > 0 && byFamily && (
        <div className={s.familyGroups}>
          {groups.map(([family, list]) => {
            const open = openFamilies.has(family);
            return (
              <div key={family}>
                <button
                  type="button"
                  className={s.groupHead}
                  aria-expanded={open}
                  onClick={() => setOpenFamilies((x) => { const n = new Set(x); if (open) n.delete(family); else n.add(family); return n; })}
                >
                  <span aria-hidden>{open ? '▾' : '▸'}</span> {family} ({list.length})
                </button>
                {open && (
                  <div className={s.tableWrap}>
                    <table className={`${s.table} ${s.compact}`}>
                      {head}
                      <tbody>{rows(list)}</tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** ?stage=development <-> DEVELOPMENT. */
export const stageToParam = (s: StageCode | null): string | null => (s ? s.toLowerCase().replace(/_/g, '-') : null);
export function stageFromParam(v: string | null | undefined): StageCode | null {
  const code = (v ?? '').toUpperCase().replace(/-/g, '_');
  return (['IDEA', 'RESEARCH', 'DEVELOPMENT', 'TESTING', 'LAUNCH_READY', 'LAUNCHED'] as const).find((c) => c === code) ?? null;
}

/** Esc closes the open stage (not while the product drawer, which handles Esc itself, is open). */
export function useEscToClose(active: boolean, onClose: () => void) {
  useEffect(() => {
    if (!active) return undefined;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, onClose]);
}
