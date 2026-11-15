import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * TIKA only: the company key comes from the CORE dim_company by name (Odoo ids Majaal 1 / Tika 3), never the legacy
 * Dim_Company (1 Majaal / 2 Tika) and never a hard-coded number; Majaal's key is refused.
 */
const query = vi.fn();
vi.mock('../../../db/pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));

import { assertCompanyAllowed, resetTikaCompanyKeyCache, tikaCompanyKey } from '../company';

beforeEach(() => {
  query.mockReset();
  resetTikaCompanyKeyCache();
});

describe('tikaCompanyKey', () => {
  it('reads the lowercase core dim_company by name and returns its key (3 for Odoo TIKA)', async () => {
    query.mockResolvedValue([[{ CompanyKey: 3 }]]);
    expect(await tikaCompanyKey()).toBe(3);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toMatch(/FROM dim_company\b/);
    expect(sql).not.toMatch(/Dim_Company/);
    expect(sql).toMatch(/'tika'/);
  });
  it('is cached once found', async () => {
    query.mockResolvedValue([[{ CompanyKey: 3 }]]);
    await tikaCompanyKey();
    await tikaCompanyKey();
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('fails clearly when TIKA is missing or ambiguous', async () => {
    query.mockResolvedValueOnce([[]]);
    await expect(tikaCompanyKey()).rejects.toMatchObject({ code: 'company.tikaMissing', status: 503 });
    query.mockResolvedValueOnce([[{ CompanyKey: 3 }, { CompanyKey: 7 }]]);
    await expect(tikaCompanyKey()).rejects.toMatchObject({ code: 'company.tikaAmbiguous' });
  });
});

describe('assertCompanyAllowed', () => {
  it('rejects a Majaal company key (1) and any other company', () => {
    expect(() => assertCompanyAllowed(1, 3)).toThrow(expect.objectContaining({ code: 'company.notAllowed', field: 'companyKey' }));
    expect(() => assertCompanyAllowed('1', 3)).toThrow(expect.objectContaining({ code: 'company.notAllowed' }));
    expect(() => assertCompanyAllowed(2, 3)).toThrow(expect.objectContaining({ code: 'company.notAllowed' })); // legacy Tika key
    expect(() => assertCompanyAllowed('majaal', 3)).toThrow(expect.objectContaining({ code: 'company.notAllowed' }));
  });
  it('accepts TIKA itself or no company at all', () => {
    expect(() => assertCompanyAllowed(3, 3)).not.toThrow();
    expect(() => assertCompanyAllowed(undefined, 3)).not.toThrow();
    expect(() => assertCompanyAllowed('', 3)).not.toThrow();
  });
});
