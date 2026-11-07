import { describe, expect, it } from 'vitest';
import { MOVEMENTS, MOVEMENT_COLOR, MOVEMENT_LABEL } from '../materialsAnalogy/shared';

describe('Product Movement colours and labels', () => {
  it('Improved green, Stable yellow, Drop red, New accent, Discontinued grey', () => {
    expect(MOVEMENT_COLOR).toEqual({
      New: 'var(--ps-color-accent)',
      Stable: 'var(--ps-color-gold)',
      Improved: 'var(--ps-color-success)',
      Drop: 'var(--ps-color-alert)',
      Discontinued: 'var(--ps-color-neutral-text)',
    });
  });

  it('labels stay New / Stable / Improved / Drop / Discontinued, in that order', () => {
    expect(MOVEMENTS.map((m) => MOVEMENT_LABEL[m])).toEqual(['New', 'Stable', 'Improved', 'Drop', 'Discontinued']);
  });
});
