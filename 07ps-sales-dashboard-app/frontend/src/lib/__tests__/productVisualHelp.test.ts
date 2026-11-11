import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { VISUAL_HELP, vh, type VisualHelpId } from '../visualHelp';
import { bcgClassDefinition, bcgClassRule, bcgThresholds, movementRule } from '../materialsAnalogy/shared';

const PRODUCT_DIR = path.resolve('src/app/(departments)/product');
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const productIds = Object.keys(VISUAL_HELP).filter((id) => id.startsWith('product.')) as VisualHelpId[];

/** Interactive Product visuals (click / hover / drill / export): each needs an "i". */
const INTERACTIVE: VisualHelpId[] = [
  'product.bcgMatrix.matrix', 'product.bcgMatrix.movement', 'product.bcgMatrix.productDetail',
  'product.stockVelocity.movers', 'product.stockVelocity.overstock', 'product.stockVelocity.frequency', 'product.stockVelocity.stockOutRisk',
  'product.stockVelocity.aging',
  'product.pimContribution.hierarchy', 'product.pimContribution.categories', 'product.pimContribution.brandProducts', 'product.pimContribution.brands',
  'product.productLifecycle.productDetail',
];

describe('Product pages "?" and "i"', () => {
  it('every Product visual on the pages has a help entry, and every Product entry is used', () => {
    const used = new Set<string>();
    for (const file of walk(PRODUCT_DIR).filter((f) => f.endsWith('page.tsx'))) {
      for (const m of readFileSync(file, 'utf8').matchAll(/\bvh\(['"](product\.[^'"]+)['"]\)/g)) used.add(m[1]);
    }
    expect([...used].sort()).toEqual([...productIds].sort());
  });

  it('the "?" follows the app-wide rule: shown only where a number needs explaining, one short line', () => {
    const WITH_HELP: VisualHelpId[] = [
      'product.bcgMatrix.matrix', 'product.bcgMatrix.movement', 'product.bcgMatrix.productDetail', 'product.stockVelocity.movers',
      'product.stockVelocity.overstock', 'product.stockVelocity.frequency', 'product.stockVelocity.stockOutRisk',
      'product.stockVelocity.aging', 'product.stockVelocity.isr', 'product.stockVelocity.kpiDoh', 'product.stockVelocity.kpiOverstock',
      'product.stockVelocity.kpiStockOut', 'product.stockVelocity.kpiFast', 'product.stockVelocity.kpiInStock', 'product.stockVelocity.kpiInventory',
      'product.pimContribution.asp', 'product.productLifecycle.pareto',
    ];
    for (const id of productIds) {
      const hint = vh(id);
      if (WITH_HELP.includes(id)) {
        expect(typeof hint.help?.formula, id).toBe('string');                 // one formula line
        expect(hint.help!.definition.length, id).toBeLessThanOrEqual(90);    // one short definition
      } else {
        expect(hint.help, `${id} is self-explanatory: no "?"`).toBeUndefined();
      }
    }
  });

  it('every interactive Product visual has its "i"', () => {
    for (const id of INTERACTIVE) expect((VISUAL_HELP[id] as { interactions?: readonly string[] }).interactions?.length ?? 0, id).toBeGreaterThan(0);
    expect((VISUAL_HELP['product.bcgMatrix.movement'] as { interactions?: readonly string[] }).interactions?.[0]).toMatch(/Click a slice/);
  });

  it('Product Movement and the BCG classes are one line each, from the config values', () => {
    const t = bcgThresholds({ bcg: { movement_stable_band_pct: 10, volume_threshold: { Majaal: 3500, Tika: 25000 }, profit_threshold_pct: 35 }, lifecycle: { new_first_sale_within_days: 180 } });
    expect(movementRule(t)).toBe('Improved > +10% · Drop < −10% · Stable within ±10% · New = first sale ≤ 180 days or no LYTD · archived Odoo products are left out');
    expect(bcgClassRule(t)).toBe('High volume = Volume ≥ Majaal 3,500 / Tika 25,000 units · High profit = GP% ≥ 35%');
  });

  it('Stock Velocity: every KPI card has its "?", the KPI cards have no "i"', () => {
    for (const id of ['kpiDoh', 'kpiOverstock', 'kpiStockOut', 'kpiFast', 'kpiInStock', 'kpiInventory', 'isr'] as const) {
      const entry = VISUAL_HELP[`product.stockVelocity.${id}`] as { help: { formula?: string }; interactions?: readonly string[] };
      expect(entry.help.formula, id).toBeTruthy();
      expect(entry.interactions, id).toBeUndefined();
    }
    expect(VISUAL_HELP['product.stockVelocity.kpiDoh'].help.formula).toMatch(/Quantity On Hand ÷ average daily Quantity Sold/);
  });

  it('BCG class definitions read the config thresholds (Athena left out)', () => {
    const t = bcgThresholds({ bcg: { volume_threshold: { Majaal: 3500, Tika: 25000, Athena: 3500 }, profit_threshold_pct: 35 } });
    expect(bcgClassDefinition('Stars', t)).toBe('Volume ≥ Majaal 3,500 / Tika 25,000 units, GP% ≥ 35%');
    expect(bcgClassDefinition('Cash Cows', t)).toBe('Volume ≥ Majaal 3,500 / Tika 25,000 units, GP% < 35%');
    expect(bcgClassDefinition('Strategic', t)).toBe('Volume < Majaal 3,500 / Tika 25,000 units, GP% ≥ 35%');
    expect(bcgClassDefinition('Dogs', t)).toBe('Volume < Majaal 3,500 / Tika 25,000 units, GP% < 35%');
    expect(bcgClassDefinition('Unclassified (no cost)', t)).toMatch(/No sale with a standard cost/);
    expect(bcgClassDefinition('Stars', bcgThresholds({ bcg: { volume_threshold: { Majaal: 4000 }, profit_threshold_pct: 40 } }))).toBe('Volume ≥ Majaal 4,000 units, GP% ≥ 40%');
  });

  it('no median text is left in the BCG help', () => {
    for (const id of ['product.bcgMatrix.matrix', 'product.bcgMatrix.productDetail'] as const) {
      expect(JSON.stringify(VISUAL_HELP[id]), id).not.toMatch(/median/i);
    }
  });
});
