import { describe, expect, it } from 'vitest';
import { criticalNumberShareLabel } from '../criticalNumberShare';

/** The line under the Daily Critical Number (2026-11-09): the filters' share of the group's base value, from
 * sales_targets.xlsx, with a note whenever the share is not the anchor year's own. */
describe('criticalNumberShareLabel', () => {
  const anchorDate = '2026-11-09';

  it("the anchor year's share, as a percent with up to 2 decimals, no note", () => {
    expect(criticalNumberShareLabel({ anchorDate, share: 0.224866, shareYear: 2026, shareSource: 'current' })).toEqual({
      text: '22.49% of group target · from sales_targets.xlsx 2026',
      note: null,
    });
    expect(criticalNumberShareLabel({ anchorDate, share: 1, shareYear: 2026, shareSource: 'current' })?.text).toBe(
      '100% of group target · from sales_targets.xlsx 2026',
    );
    expect(criticalNumberShareLabel({ anchorDate, share: 0, shareYear: 2026, shareSource: 'current' })?.text).toBe(
      '0% of group target · from sales_targets.xlsx 2026',
    );
  });

  it('fallback year: says which year is used and why', () => {
    expect(criticalNumberShareLabel({ anchorDate: '2027-01-04', share: 0.43408, shareYear: 2026, shareSource: 'fallback' })).toEqual({
      text: '43.41% of group target · from sales_targets.xlsx 2026',
      note: 'sales_targets.xlsx has no 2027 targets yet, so the 2026 shares are used.',
    });
  });

  it('no targets or a failed read: the group value, with a note', () => {
    expect(criticalNumberShareLabel({ anchorDate, share: 1, shareYear: null, shareSource: 'missing' })).toEqual({
      text: 'Group value (100%)',
      note: 'sales_targets.xlsx has no targets for 2026: the filters do not split the value.',
    });
    expect(criticalNumberShareLabel({ anchorDate, share: 1, shareYear: null, shareSource: 'error' })?.note).toMatch(/could not be read/);
  });

  it('an older backend without the share fields: no line', () => {
    expect(criticalNumberShareLabel({ anchorDate })).toBeNull();
  });
});
