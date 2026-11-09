import { describe, expect, it } from 'vitest';
import { DEFAULT_EXCLUDED_WEEKS, reachEstimateConfig } from '../npsReachEstimate';

describe('NPS_REACH_ESTIMATE_* settings', () => {
  it('on by default, automatic basis; false/0/no/off turns it off; a positive number is the fixed per-week value', () => {
    expect(reachEstimateConfig({})).toEqual({ enabled: true, fixedPerWeek: null, excludeWeeks: DEFAULT_EXCLUDED_WEEKS });
    for (const v of ['false', '0', 'no', 'OFF']) expect(reachEstimateConfig({ NPS_REACH_ESTIMATE_ENABLED: v }).enabled).toBe(false);
    expect(reachEstimateConfig({ NPS_REACH_ESTIMATE_ENABLED: 'true', NPS_REACH_ESTIMATE_PER_WEEK: '250' })).toMatchObject({ enabled: true, fixedPerWeek: 250 });
    for (const v of ['', ' ', 'abc', '0', '-5']) expect(reachEstimateConfig({ NPS_REACH_ESTIMATE_PER_WEEK: v }).fixedPerWeek).toBeNull();
  });

  it('excluded weeks: the Meta outage weeks by default; an explicit list (bad dates dropped) or empty = none', () => {
    expect(DEFAULT_EXCLUDED_WEEKS).toEqual(['2026-10-31', '2026-11-07']);
    expect(reachEstimateConfig({ NPS_REACH_ESTIMATE_EXCLUDE_WEEKS: '2026-10-31, nope ,2026-11-14' }).excludeWeeks).toEqual(['2026-10-31', '2026-11-14']);
    expect(reachEstimateConfig({ NPS_REACH_ESTIMATE_EXCLUDE_WEEKS: '' }).excludeWeeks).toEqual([]);
  });
});
