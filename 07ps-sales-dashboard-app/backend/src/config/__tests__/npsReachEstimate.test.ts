import { describe, expect, it } from 'vitest';
import { reachEstimateConfig } from '../npsReachEstimate';

describe('NPS_REACH_ESTIMATE_* settings', () => {
  it('on by default, automatic basis; false/0/no/off turns it off; a positive number is the fixed per-week value', () => {
    expect(reachEstimateConfig({})).toEqual({ enabled: true, fixedPerWeek: null });
    for (const v of ['false', '0', 'no', 'OFF']) expect(reachEstimateConfig({ NPS_REACH_ESTIMATE_ENABLED: v }).enabled).toBe(false);
    expect(reachEstimateConfig({ NPS_REACH_ESTIMATE_ENABLED: 'true', NPS_REACH_ESTIMATE_PER_WEEK: '250' })).toEqual({ enabled: true, fixedPerWeek: 250 });
    for (const v of ['', ' ', 'abc', '0', '-5']) expect(reachEstimateConfig({ NPS_REACH_ESTIMATE_PER_WEEK: v }).fixedPerWeek).toBeNull();
  });
});
