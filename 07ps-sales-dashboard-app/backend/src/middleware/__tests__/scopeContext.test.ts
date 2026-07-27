import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { resolveScopedFilters } from '../scopeContext';
import { buildWhereClause, UserContext } from '../../measures/filters';

function makeReq(
  query: Record<string, unknown>,
  userContext: UserContext = { roleCode: 'BI00_EXECUTIVE' },
): Request {
  return { query, userContext } as unknown as Request;
}

function makeRes(): Response {
  return { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
}

describe('resolveScopedFilters -- default "All filters" baseline', () => {
  it('no query params at all resolves to empty arrays for every filter, which must never restrict the query', () => {
    const req = makeReq({});
    const res = makeRes();
    const next = vi.fn();

    resolveScopedFilters(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.scopedFilters).toEqual({
      companyKeys: [],
      segmentKeys: [],
      channelKeys: [],
      salesTeamKeys: [],
      salespersonKeys: [],
    });

    // This is the critical regression case: with the frontend's default "All" state (no filter
    // params sent at all), the resulting Filters object must produce an unconditional "1=1" clause
    // -- never an empty-but-still-restrictive IN () or a malformed AND chain.
    const { clause, params } = buildWhereClause(req.scopedFilters!);
    expect(clause).toBe('1=1');
    expect(params).toEqual([]);
  });

  it('a single repeated-key query param becomes a one-element array (not a bare scalar)', () => {
    const req = makeReq({ companyKeys: '1' });
    const res = makeRes();
    const next = vi.fn();

    resolveScopedFilters(req, res, next);

    expect(req.scopedFilters?.companyKeys).toEqual([1]);
    const { clause, params } = buildWhereClause(req.scopedFilters!, 'fo');
    expect(clause).toBe('fo.CompanyKey IN (?)');
    expect(params).toEqual([1]);
  });

  it('multiple repeated-key query params become a multi-element array', () => {
    const req = makeReq({ channelKeys: ['1', '2'] });
    const res = makeRes();
    const next = vi.fn();

    resolveScopedFilters(req, res, next);

    expect(req.scopedFilters?.channelKeys).toEqual([1, 2]);
  });

  it('SALESPERSON role with no filters sent still gets locked to their own key, not left empty', () => {
    const req = makeReq({}, { roleCode: 'SALESPERSON', salespersonKey: 40 });
    const res = makeRes();
    const next = vi.fn();

    resolveScopedFilters(req, res, next);

    expect(req.scopedFilters).toEqual({
      companyKeys: [],
      segmentKeys: [],
      channelKeys: [],
      salesTeamKeys: [],
      salespersonKeys: [40],
    });
  });
});

describe('resolveScopedFilters -- role data scope (role_data_scope rules)', () => {
  it('stays synchronous: req.scopedFilters is set and next() called before the function returns', () => {
    // Guards the design constraint the whole feature depends on: attachUserContext (which loads
    // dataScopeRules from the DB) runs before this, so resolveScopedFilters itself must remain a
    // plain sync function -- no `await resolveScopedFilters(...)` anywhere in the route chain.
    const req = makeReq(
      {},
      { roleCode: 'BI00_EXECUTIVE', dataScopeRules: [{ dimension: 'segmentKeys', value: '1' }] },
    );
    const res = makeRes();
    const next = vi.fn();

    resolveScopedFilters(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.scopedFilters?.segmentKeys).toEqual([1]);
  });

  it('a dimension not requested is forced to the role-scoped set (B2B Director case)', () => {
    const req = makeReq(
      { companyKeys: '1' },
      { roleCode: 'BI01_DIRECTOR_B2B', dataScopeRules: [{ dimension: 'segmentKeys', value: '1' }] },
    );
    const res = makeRes();
    const next = vi.fn();

    resolveScopedFilters(req, res, next);

    expect(req.scopedFilters).toEqual({
      companyKeys: [1],
      segmentKeys: [1],
      channelKeys: [],
      salesTeamKeys: [],
      salespersonKeys: [],
    });
  });

  it('requesting a segment outside the role scope is rejected with 403, not silently overridden', () => {
    const req = makeReq(
      { segmentKeys: '2' },
      { roleCode: 'BI01_DIRECTOR_B2B', dataScopeRules: [{ dimension: 'segmentKeys', value: '1' }] },
    );
    const res = makeRes();
    const next = vi.fn();

    resolveScopedFilters(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
    expect(req.scopedFilters).toBeUndefined();
  });
});
