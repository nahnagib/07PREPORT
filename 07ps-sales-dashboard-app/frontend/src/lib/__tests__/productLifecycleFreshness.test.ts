import { describe, expect, it } from 'vitest';
import { freshnessByCompany, freshnessTargets } from '../product/lifecycle';

describe('Portfolio Freshness per company vs its own target (2026-11-15)', () => {
  const row = (Company: string, lifecycle: string, productStatus = 'Active') => ({ Company, lifecycle, productStatus }) as never;
  const targets = freshnessTargets({ freshness_targets: { Tika: 10, Majaal: 20 } });

  it('reads the served targets; each company against its own; Dormant / Unclassified never count', () => {
    expect(targets).toEqual({ TIKA: 10, MAJAAL: 20 });
    const rows = [
      ...Array.from({ length: 9 }, () => row('Tika', 'Mature')), row('Tika', 'New'),            // 10.0% -> On Track (>= 10)
      ...Array.from({ length: 9 }, () => row('Majaal', 'Mature', 'NonActive')), row('Majaal', 'New'), // 10.0% -> Below 20
      row('Majaal', 'New', 'Dormant'), row('Tika', 'New', 'Unclassified'),
    ];
    expect(freshnessByCompany(rows, targets)).toEqual([
      { company: 'Majaal', pct: 10, fresh: 1, portfolio: 10, target: 20, onTrack: false },
      { company: 'Tika', pct: 10, fresh: 1, portfolio: 10, target: 10, onTrack: true },
    ]);
  });

  it('no target configured: no verdict', () => {
    expect(freshnessByCompany([row('Athena', 'New')], targets)[0]).toMatchObject({ target: null, onTrack: null });
  });
});
