import { describe, expect, it } from 'vitest';
import { planTable, keyLabel, type DbRow, type LaterKeys } from '../removal';
import { ADAPTER_BY_ID } from '../tables';

// Pure planning of one table (removal.ts): no database.
const spend = ADAPTER_BY_ID.spend;
const row = (id: number, batch: number, key: string, current: boolean, supersededBy: number | null = null): DbRow =>
  ({ id, batch, current, supersededBy, key, label: key });

describe('planTable', () => {
  it('a/b: deletes every own row; a row a later batch superseded is listed with that batch', () => {
    const p = planTable(spend, [row(1, 5, 'k1', true), row(2, 5, 'k2', false, 7)], [], new Map(), new Map());
    expect(p.deleteIds).toEqual([1, 2]);
    expect(p.deletedCurrent).toBe(1);
    expect(p.deletedSuperseded).toEqual([{ key: 'k2', label: 'k2', supersededBy: 7 }]);
  });

  it('c1: re-arms the earlier row when the own row is current', () => {
    const p = planTable(spend, [row(2, 5, 'k', true)], [row(1, 3, 'k', false, 5)], new Map(), new Map());
    expect(p.rearm).toEqual([{ id: 1, key: 'k', label: 'k', batch: 3 }]);
    expect(p.relink).toEqual([]);
  });

  it('c3: re-links the earlier row to the batch that superseded the own row', () => {
    const p = planTable(spend, [row(2, 5, 'k', false, 8)], [row(1, 3, 'k', false, 5)], new Map(), new Map());
    expect(p.rearm).toEqual([]);
    expect(p.relink).toEqual([{ id: 1, key: 'k', label: 'k', batch: 3, toBatch: 8 }]);
  });

  it('c2: a current own row re-stated by later batches goes to the EARLIEST of them; the earlier row follows', () => {
    const later: LaterKeys = new Map([[9, { spend: new Set(['k']) }], [7, { spend: new Set(['k', 'x']) }]]);
    const p = planTable(spend, [row(2, 5, 'k', true), row(3, 5, 'z', true)], [row(1, 3, 'k', false, 5)], later, new Map());
    expect(p.handedOver).toEqual([{ id: 2, key: 'k', label: 'k', toBatch: 7 }]);
    expect(p.deleteIds).toEqual([3]);
    expect(p.relink).toEqual([{ id: 1, key: 'k', label: 'k', batch: 3, toBatch: 7 }]);
  });

  it('a superseded own row is never handed over (the later batch replaced it)', () => {
    const later: LaterKeys = new Map([[7, { spend: new Set(['k']) }]]);
    const p = planTable(spend, [row(2, 5, 'k', false, 7)], [], later, new Map());
    expect(p.handedOver).toEqual([]);
    expect(p.deleteIds).toEqual([2]);
  });

  it('an earlier row with no own row for its key follows the live row, or is re-armed when there is none', () => {
    const live = new Map([['k', row(9, 8, 'k', true)]]);
    expect(planTable(spend, [], [row(1, 3, 'k', false, 5)], new Map(), live).relink).toMatchObject([{ id: 1, toBatch: 8 }]);
    expect(planTable(spend, [], [row(1, 3, 'k', false, 5)], new Map(), new Map()).rearm).toMatchObject([{ id: 1 }]);
  });
});

describe('keyLabel', () => {
  it('reads like the sheet: yyyy-mm, then the other key fields', () => {
    expect(keyLabel(spend, { year: 2026, month: 3, brand: 'Majaal' })).toBe('2026-03 · Majaal');
    expect(keyLabel(ADAPTER_BY_ID.campaigns, { name: 'Ramadan' })).toBe('Ramadan');
  });
});
