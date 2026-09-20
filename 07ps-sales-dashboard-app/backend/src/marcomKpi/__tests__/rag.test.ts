import { describe, expect, it } from 'vitest';
import { Rat } from '../rat';
import { classify, makeKpi } from '../kpi';
import type { RagRuleKey } from '../thresholds';
import { RAG_RULES } from '../thresholds';

const at = (rule: RagRuleKey, v: string) => classify(rule, Rat.parse(v));

/** Every boundary of the RAG table. Percent rules are compared as FRACTIONS ('0.05' = 5%). */
describe('RAG boundaries (exact)', () => {
  it.each([
    ['roi', '5.0000001', 'green'], ['roi', '5', 'yellow'], ['roi', '4.999', 'yellow'],
    ['roi', '3', 'yellow'], ['roi', '2.99', 'red'], ['roi', '0', 'red'],
    ['cacPctOfInvoice', '0.03', 'green'], ['cacPctOfInvoice', '0.0300001', 'yellow'],
    ['cacPctOfInvoice', '0.05', 'yellow'], ['cacPctOfInvoice', '0.0500001', 'red'], ['cacPctOfInvoice', '0.46', 'red'],
    ['cpc', '2.4999', 'green'], ['cpc', '2.5', 'yellow'], ['cpc', '5', 'yellow'], ['cpc', '5.0001', 'red'],
    ['ctr', '0.0500001', 'green'], ['ctr', '0.05', 'yellow'], ['ctr', '0.03', 'yellow'], ['ctr', '0.0299', 'red'],
    ['engagementRate', '0.0500001', 'green'], ['engagementRate', '0.05', 'yellow'], ['engagementRate', '0.03', 'yellow'], ['engagementRate', '0.0299', 'red'],
    ['avgSessionMinutes', '3.01', 'green'], ['avgSessionMinutes', '3', 'yellow'], ['avgSessionMinutes', '1', 'yellow'], ['avgSessionMinutes', '0.99', 'red'],
    ['percentOfTarget', '0.9001', 'green'], ['percentOfTarget', '0.9', 'yellow'], ['percentOfTarget', '0.8', 'yellow'], ['percentOfTarget', '0.799', 'red'],
  ] as [RagRuleKey, string, string][])('%s at %s -> %s', (rule, v, expected) => {
    expect(at(rule, v)).toBe(expected);
  });

  it('null is always na', () => {
    for (const rule of Object.keys(RAG_RULES) as RagRuleKey[]) expect(classify(rule, null)).toBe('na');
  });

  it('exact where floats would lie: 5.000000000000000001% CTR is green, exactly 5% is yellow', () => {
    // 50000000000000001 / 1000000000000000000 = 0.050000000000000001; as a float that is exactly 0.05.
    const ratio = Rat.parse('50000000000000001').div(Rat.parse('1000000000000000000'))!;
    expect(ratio.toNumber()).toBe(0.05); // display rounding would say "5%"...
    expect(classify('ctr', ratio)).toBe('green'); // ...but the status is decided on the exact value
    expect(classify('ctr', Rat.parse('5').div(Rat.parse('100'))!)).toBe('yellow');
  });

  it('a value that merely DISPLAYS as 90.0% but is 89.99999999999999% stays yellow, and 90.00000000000001% is green', () => {
    expect(at('percentOfTarget', '0.8999999999999999')).toBe('yellow');
    expect(at('percentOfTarget', '0.9000000000000001')).toBe('green');
  });
});

describe('KPI shape', () => {
  it('percent KPIs are emitted in percentage points, ratios and LYD as-is', () => {
    expect(makeKpi('percent', Rat.parse('0.0528'), { rule: 'ctr' })).toEqual({ value: 5.28, status: 'green', unit: 'percent' });
    expect(makeKpi('ratio', Rat.parse('5.6'), { rule: 'roi', direction: 'higher_better' })).toEqual({ value: 5.6, status: 'green', unit: 'ratio', direction: 'higher_better' });
  });
  it('no rule -> neutral; null -> na with value null (never NaN)', () => {
    expect(makeKpi('percent', Rat.parse('0.3'))).toMatchObject({ status: 'neutral', value: 30 });
    expect(makeKpi('percent', null, { rule: 'ctr' })).toEqual({ value: null, status: 'na', unit: 'percent' });
  });
  it('previous/delta are only present when a comparison was supplied', () => {
    expect(makeKpi('ratio', Rat.parse('5'), { rule: 'roi' })).not.toHaveProperty('delta');
    expect(makeKpi('ratio', Rat.parse('5'), { rule: 'roi', previous: Rat.parse('3.5') })).toMatchObject({ previous: 3.5, delta: 1.5 });
    expect(makeKpi('ratio', Rat.parse('5'), { rule: 'roi', previous: null })).toMatchObject({ previous: null, delta: null });
  });
});

describe('exact arithmetic', () => {
  it('0.1 + 0.2 is exactly 0.3', () => {
    expect(Rat.parse('0.1').add(Rat.parse('0.2')).cmp(Rat.parse('0.3'))).toBe(0);
  });
  it('parses decimals, negatives and exponents losslessly; rejects garbage', () => {
    expect(Rat.parse('-12.50').toNumber()).toBe(-12.5);
    expect(Rat.parse('1e3').toNumber()).toBe(1000);
    expect(Rat.parse('2.5e-1').toNumber()).toBe(0.25);
    expect(Rat.parse(null).toNumber()).toBe(0);
    expect(() => Rat.parse('abc')).toThrow();
    expect(() => Rat.parse(Number.NaN)).toThrow();
  });
  it('division by zero is null, never Infinity/NaN', () => {
    expect(Rat.ONE.div(Rat.ZERO)).toBeNull();
  });
});
