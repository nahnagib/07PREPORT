import { describe, expect, it } from 'vitest';
import { describeRule, joinOr, scopeSummary, visibleChips } from '../dataScope';

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
