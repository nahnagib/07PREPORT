import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ValidationError } from '../../lib/errors';

/** Same coverage as salespersonAdminService.test.ts, for sales_team_admin_profile's
 * company_key_override (Company Link + Cascading Filter Bar, 2026-09). */

const queryMock = vi.fn();
vi.mock('../../db/pool', () => ({ pool: { query: (...args: unknown[]) => queryMock(...(args as [string, unknown[]?])) } }));

// eslint-disable-next-line import/first
import { upsertSalesTeamProfile } from '../salesTeamAdminService';

interface MockOpts {
  companyExists?: boolean;
  existingCompanyKeyOverride?: number | null;
}

function setupMockPool(opts: MockOpts = {}) {
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: string) => {
    if (/FROM Dim_SalesTeam WHERE SalesTeamKey/.test(sql)) {
      return [[{ 1: 1 }]]; // salesTeamExists -> true
    }
    if (/FROM Dim_Company WHERE CompanyKey/.test(sql)) {
      return [opts.companyExists === false ? [] : [{ 1: 1 }]];
    }
    if (/FROM sales_team_admin_profile WHERE team_code/.test(sql)) {
      return [[]]; // teamCodeTakenByAnotherTeam -> false
    }
    if (/FROM sales_team_admin_profile WHERE sales_team_key/.test(sql)) {
      return [[{ team_name_override: null, team_code: 'TK-1', segment_key_override: null,
                 company_key_override: opts.existingCompanyKeyOverride ?? null, target_override_amount: null, note: null }]];
    }
    if (/^\s*INSERT INTO sales_team_admin_profile\b/.test(sql)) {
      return [{ affectedRows: 1, insertId: 0 }];
    }
    if (/INSERT INTO sales_team_admin_profile_history/.test(sql)) {
      return [{ affectedRows: 1 }];
    }
    if (/FROM Dim_SalesTeam st/.test(sql)) {
      // getSalesTeamRow's BASE_SELECT
      return [[{
        sales_team_key: 'TK-1', sales_team_name: 'Team 1', team_code: 'TK-1',
        segment_key_override: null, segment_name_override: null,
        company_key_override: opts.existingCompanyKeyOverride ?? null, company_name_override: null,
        target_override_amount: null, note: null, updated_at: null, updated_by_email: null,
      }]];
    }
    throw new Error(`Unexpected SQL in test mock: ${sql.slice(0, 120)}`);
  });
}

function insertCall() {
  return queryMock.mock.calls.find(([sql]) => /^\s*INSERT INTO sales_team_admin_profile\b/.test(sql as string));
}

describe('upsertSalesTeamProfile -- company_key_override', () => {
  beforeEach(() => setupMockPool());

  it('companyExists queries Dim_Company.CompanyKey', async () => {
    setupMockPool({ companyExists: true });
    await upsertSalesTeamProfile('TK-1', { companyKeyOverride: 2 }, 99);
    const companyCheckCall = queryMock.mock.calls.find(([sql]) => /FROM Dim_Company WHERE CompanyKey/.test(sql as string));
    expect(companyCheckCall).toBeDefined();
    expect(companyCheckCall![1]).toEqual([2]);
  });

  it('a partial PATCH that omits companyKeyOverride preserves the existing value', async () => {
    setupMockPool({ existingCompanyKeyOverride: 7 });
    await upsertSalesTeamProfile('TK-1', { note: 'just a note update' }, 99);
    const call = insertCall();
    expect(call).toBeDefined();
    // company_key_override is the 5th positional param (sales_team_key, team_name_override,
    // team_code, segment_key_override, company_key_override, target_override_amount, note, updated_by).
    const params = call![1] as unknown[];
    expect(params[4]).toBe(7);
  });

  it('an invalid companyKeyOverride throws ValidationError before any write', async () => {
    setupMockPool({ companyExists: false });
    await expect(upsertSalesTeamProfile('TK-1', { companyKeyOverride: 999 }, 99)).rejects.toThrow(ValidationError);
    expect(insertCall()).toBeUndefined();
  });
});
