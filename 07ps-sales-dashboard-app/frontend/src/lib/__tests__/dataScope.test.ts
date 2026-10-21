import { describe, expect, it } from 'vitest';
import {
  combineRules,
  describeRule,
  findMergeablePair,
  groupByDimension,
  joinOr,
  matchesNoData,
  mergeRules,
  scopeSummary,
  visibleChips,
} from '../dataScope';

describe('data scope wording (Roles page)', () => {
  it('joins values with "or"', () => {
    expect(joinOr(['A'])).toBe('A');
    expect(joinOr(['A', 'B'])).toBe('A or B');
    expect(joinOr(['A', 'B', 'C'])).toBe('A, B or C');
  });

  it('words each operator', () => {
    expect(describeRule('Company', 'in', ['Majaal', 'Tika'])).toBe('Company is Majaal or Tika');
    expect(describeRule('Company', 'not_in', ['X'])).toBe('Company is not X');
    expect(describeRule('Branch', 'not_in', ['A', 'B'])).toBe('Branch is none of A or B');
  });

  it('summarises the whole role, rules joined as AND ( · )', () => {
    expect(
      scopeSummary([
        { dimensionLabel: 'Company', operator: 'not_in', valueLabels: ['X'] },
        { dimensionLabel: 'Branch', operator: 'in', valueLabels: ['A', 'B'] },
      ]),
    ).toBe('Users with this role see: Company is not X · Branch is A or B');
    expect(scopeSummary([])).toBe('Users with this role see: all data (no restrictions)');
    // a rule being edited down to no value is not part of the scope (it cannot be saved)
    expect(scopeSummary([{ dimensionLabel: 'Company', operator: 'in', valueLabels: [] }])).toBe('Users with this role see: all data (no restrictions)');
  });

  it('shows three chips, then "+N more"', () => {
    expect(visibleChips(['a', 'b', 'c'])).toEqual({ shown: ['a', 'b', 'c'], more: 0 });
    expect(visibleChips(['a', 'b', 'c', 'd', 'e'])).toEqual({ shown: ['a', 'b', 'c'], more: 2 });
  });
});

describe('several rules on one dimension (AND)', () => {
  const companies = ['1', '3', '9', '12'];

  it('combines "is" and "is not" rules like the server does', () => {
    expect(combineRules([{ operator: 'in', values: ['9', '12'] }, { operator: 'not_in', values: ['12'] }], null)).toEqual(['9']);
    expect(combineRules([{ operator: 'in', values: ['1', '3', '9'] }, { operator: 'in', values: ['3', '9', '12'] }], null)).toEqual(['3', '9']);
    expect(combineRules([{ operator: 'not_in', values: ['12'] }, { operator: 'not_in', values: ['1'] }], companies)).toEqual(['3', '9']);
    // only "is not" rules and the values not loaded yet: unknown
    expect(combineRules([{ operator: 'not_in', values: ['12'] }], null)).toBeNull();
  });

  it('flags a combination that matches no data -- never a single rule, never an unknown one', () => {
    expect(matchesNoData([{ operator: 'in', values: ['9'] }, { operator: 'not_in', values: ['9'] }], null)).toBe(true);
    expect(matchesNoData([{ operator: 'in', values: ['9'] }, { operator: 'in', values: ['12'] }], null)).toBe(true);
    expect(matchesNoData([{ operator: 'not_in', values: ['1', '3'] }, { operator: 'not_in', values: ['9', '12'] }], companies)).toBe(true);
    expect(matchesNoData([{ operator: 'not_in', values: companies }], companies)).toBe(false);
    expect(matchesNoData([{ operator: 'not_in', values: ['1', '3'] }, { operator: 'not_in', values: ['9', '12'] }], null)).toBe(false);
    expect(matchesNoData([{ operator: 'in', values: ['9'] }, { operator: 'not_in', values: [] }], null)).toBe(false); // a rule being edited
    expect(matchesNoData([{ operator: 'in', values: ['9', '12'] }, { operator: 'not_in', values: ['12'] }], null)).toBe(false);
  });

  it('merges two same-operator rules into one that means the same', () => {
    expect(mergeRules({ operator: 'in', values: ['1', '3'] }, { operator: 'in', values: ['3', '9'] })).toEqual({ operator: 'in', values: ['3'] });
    expect(mergeRules({ operator: 'not_in', values: ['1'] }, { operator: 'not_in', values: ['3', '1'] })).toEqual({ operator: 'not_in', values: ['1', '3'] });
    expect(mergeRules({ operator: 'in', values: ['1'] }, { operator: 'not_in', values: ['3'] })).toBeNull();
    expect(mergeRules({ operator: 'in', values: ['1'] }, { operator: 'in', values: ['3'] })).toBeNull(); // matches no data instead
  });

  it('finds the first mergeable pair, and groups rules by dimension in picker order', () => {
    const rules = [
      { ruleNo: 1, operator: 'in' as const, values: ['1', '3'] },
      { ruleNo: 2, operator: 'not_in' as const, values: ['3'] },
      { ruleNo: 3, operator: 'not_in' as const, values: ['9'] },
    ];
    expect(findMergeablePair(rules)?.map((r) => r.ruleNo)).toEqual([2, 3]);
    expect(findMergeablePair(rules.slice(0, 2))).toBeNull();
    expect(
      groupByDimension(
        [
          { dimension: 'companyKeys', ruleNo: 1 },
          { dimension: 'segmentKeys', ruleNo: 1 },
          { dimension: 'companyKeys', ruleNo: 2 },
        ],
        ['segmentKeys', 'companyKeys'],
      ).map((g) => [g.dimension, g.rules.map((r) => r.ruleNo)]),
    ).toEqual([
      ['segmentKeys', [1]],
      ['companyKeys', [1, 2]],
    ]);
  });

  it('the summary lists every rule, same-dimension rules included', () => {
    expect(
      scopeSummary([
        { dimensionLabel: 'Customer Group', operator: 'in', valueLabels: ['B2C'] },
        { dimensionLabel: 'Company', operator: 'in', valueLabels: ['Athena', 'Zeus'] },
        { dimensionLabel: 'Company', operator: 'not_in', valueLabels: ['Zeus-Retail'] },
      ]),
    ).toBe('Users with this role see: Customer Group is B2C · Company is Athena or Zeus · Company is not Zeus-Retail');
  });
});
