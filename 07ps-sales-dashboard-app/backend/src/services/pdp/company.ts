import { pool } from '../../db/pool';
import { PdpError } from './errors';
import { rows, type Db } from './db';

/**
 * The Product Development Plan is TIKA only (Majaal is not a manufacturer). Every pdp_* row carries company_key, and
 * this module is the only place that decides its value: TIKA, looked up in the CORE dim_company (Odoo ids: Majaal 1,
 * Tika 3) by name -- never a hard-coded key, and never the legacy Dim_Company (1 Majaal / 2 Tika; see
 * db/__tests__/tableNameCase.test.ts). Cached per process once found.
 */
let cached: number | null = null;

export async function tikaCompanyKey(db: Db = pool): Promise<number> {
  if (cached !== null) return cached;
  const found = await rows<{ CompanyKey: number }>(
    db,
    "SELECT CompanyKey FROM dim_company WHERE LOWER(Company) = 'tika' OR UPPER(odoo_name) = 'TIKA' ORDER BY CompanyKey",
  );
  const keys = [...new Set(found.map((r) => Number(r.CompanyKey)))];
  if (keys.length === 0) throw new PdpError('company.tikaMissing', 'TIKA is not in dim_company yet: run the core ETL first.', undefined, 503);
  if (keys.length > 1) throw new PdpError('company.tikaAmbiguous', 'dim_company has more than one TIKA row.', undefined, 500);
  cached = keys[0];
  return cached;
}

/** Tests only. */
export function resetTikaCompanyKeyCache(): void {
  cached = null;
}

/**
 * A request may name a company (companyKey / company_key) only to say TIKA; anything else (Majaal above all) is
 * refused, so a client can never write or read another company's rows through this module.
 */
export function assertCompanyAllowed(requested: unknown, tikaKey: number): void {
  if (requested === undefined || requested === null || requested === '') return;
  const n = Number(requested);
  if (!Number.isInteger(n) || n !== tikaKey) {
    throw new PdpError('company.notAllowed', 'The Product Development Plan is for TIKA only.', 'companyKey', 400);
  }
}
