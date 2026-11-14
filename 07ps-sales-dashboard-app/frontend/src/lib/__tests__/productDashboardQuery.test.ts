import { describe, expect, it } from 'vitest';
import { buildProductDashboardQuery } from '../api';

describe('Product pages API query', () => {
  it('sends one param per selected key, so multi-value filters (the B2B + B2C default) reach the API', () => {
    const qs = new URLSearchParams(
      buildProductDashboardQuery({ company: 'Tika', segmentKeys: [1, 2], channelKeys: [3], salesTeamKeys: ['TK-01', 'TK-02'], salespersonKeys: [7, 9] }),
    );
    expect(qs.getAll('segmentKeys')).toEqual(['1', '2']);
    expect(qs.getAll('channelKeys')).toEqual(['3']);
    expect(qs.getAll('salesTeamKeys')).toEqual(['TK-01', 'TK-02']);
    expect(qs.getAll('salespersonKeys')).toEqual(['7', '9']);
    // no date range: the Product pages are always the last 12 months (2026-11-14)
    expect([qs.get('company'), qs.get('fromDate'), qs.get('toDate')]).toEqual(['Tika', null, null]);
  });

  it('no company / no keys: nothing sent for them', () => {
    expect(buildProductDashboardQuery({ company: 'All', segmentKeys: [] })).toBe('');
  });
});
