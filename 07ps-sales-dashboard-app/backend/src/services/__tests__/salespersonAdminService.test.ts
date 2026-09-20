import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ValidationError } from '../../lib/errors';

/**
 * Covers the company_key_override addition (Company Link + Cascading Filter Bar, 2026-09) to
 * upsertSalespersonProfile -- companyExists' exact query, the partial-PATCH merge preserving an
 * unmentioned existing value, and an invalid company being rejected before any write. Mocks
 * pool.query by inspecting SQL text (matches this session's established mocking style, see
 * measures/__tests__/tachometer.test.ts) rather than call order, so it stays robust to reordering
 * inside upsertSalespersonProfile.
 */

const queryMock = vi.fn();
vi.mock('../../db/pool', () => ({ pool: { query: (...args: unknown[]) => queryMock(...(args as [string, unknown[]?])) } }));

// eslint-disable-next-line import/first
import { upsertSalespersonProfile } from '../salespersonAdminService';

interface MockOpts {
  companyExists?: boolean;
  existingCompanyKeyOverride?: number | null;
}

function setupMockPool(opts: MockOpts = {}) {
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: string) => {
    if (/FROM Dim_Salesperson WHERE SalespersonKey/.test(sql)) {
      return [[{ 1: 1 }]]; // salespersonExists -> true
    }
    if (/FROM Dim_Company WHERE CompanyKey/.test(sql)) {
      return [opts.companyExists === false ? [] : [{ 1: 1 }]];
    }
    if (/FROM salesperson_admin_profile WHERE salesperson_key/.test(sql)) {
      return [[{ admin_name_override: null, channel_key_override: null, segment_key_override: null,
                 sales_team_key_override: null, company_key_override: opts.existingCompanyKeyOverride ?? null,
                 target_override_amount: null, note: null }]];
    }
    if (/^\s*INSERT INTO salesperson_admin_profile\b/.test(sql)) {
      return [{ affectedRows: 1, insertId: 0 }];
    }
    if (/INSERT INTO salesperson_admin_profile_history/.test(sql)) {
      return [{ affectedRows: 1 }];
    }
    if (/FROM Dim_Salesperson ds/.test(sql)) {
      // getSalespersonRow's BASE_SELECT
      return [[{
        salesperson_key: 1, salesperson_name: 'Test Person', admin_name_override: null,
        ytd_sales_value: 0, ytd_target_amount: 0, channel_key_override: null, channel_name_override: null,
        segment_key_override: null, segment_name_override: null, sales_team_key_override: null,
        sales_team_name_override: null, company_key_override: opts.existingCompanyKeyOverride ?? null,
        company_name_override: null, target_override_amount: null, note: null, updated_at: null,
        updated_by_email: null, linked_user_id: null, linked_user_email: null,
      }]];
    }
    throw new Error(`Unexpected SQL in test mock: ${sql.slice(0, 120)}`);
  });
}

function insertCall() {
  return queryMock.mock.calls.find(([sql]) => /^\s*INSERT INTO salesperson_admin_profile\b/.test(sql as string));
}

describe('upsertSalespersonProfile -- company_key_override', () => {
  beforeEach(() => setupMockPool());

  it('companyExists queries Dim_Company.CompanyKey', async () => {
    setupMockPool({ companyExists: true });
    await upsertSalespersonProfile(1, { companyKeyOverride: 2 }, 99);
    const companyCheckCall = queryMock.mock.calls.find(([sql]) => /FROM Dim_Company WHERE CompanyKey/.test(sql as string));
    expect(companyCheckCall).toBeDefined();
    expect(companyCheckCall![1]).toEqual([2]);
  });

  it('a partial PATCH that omits companyKeyOverride preserves the existing value', async () => {
    setupMockPool({ existingCompanyKeyOverride: 5 });
    await upsertSalespersonProfile(1, { note: 'just a note update' }, 99);
    const call = insertCall();
    expect(call).toBeDefined();
    // company_key_override is the 6th positional param in the INSERT (salesperson_key,
    // admin_name_override, channel_key_override, segment_key_override, sales_team_key_override,
    // company_key_override, target_override_amount, note, updated_by).
    const params = call![1] as unknown[];
    expect(params[5]).toBe(5);
  });

  it('an invalid companyKeyOverride throws ValidationError before any write', async () => {
    setupMockPool({ companyExists: false });
    await expect(upsertSalespersonProfile(1, { companyKeyOverride: 999 }, 99)).rejects.toThrow(ValidationError);
    expect(insertCall()).toBeUndefined();
  });
});
