import { pool } from '../db/pool';
import { auditMarcom, MarcomError } from './service';

/**
 * Brand -> Company link for the MARCOM report pages (migration 0057). MARCOM data is uploaded per brand;
 * an admin assigns each brand to a company here so the pages can filter and group by Company.
 * company_key = Dim_Company.CompanyKey (= admin_company.etl_company_key), same convention as 0019.
 */
export interface BrandCompanyRow { brandId: number; brand: string; companyKey: number | null; company: string | null }
export interface CompanyOption { companyKey: number; company: string }

const COMPANY_NAMES_SQL =
  'SELECT etl_company_key, MIN(name) AS name FROM admin_company WHERE etl_company_key IS NOT NULL GROUP BY etl_company_key';

export async function listBrandCompanies(): Promise<{ brands: BrandCompanyRow[]; companies: CompanyOption[] }> {
  const [[brands], [companies]] = await Promise.all([
    pool.query(
      `SELECT b.brand_id AS brandId, b.name AS brand, b.company_key AS companyKey, c.name AS company
         FROM marcom_brand b LEFT JOIN (${COMPANY_NAMES_SQL}) c ON c.etl_company_key = b.company_key
        ORDER BY b.name`,
    ),
    pool.query(
      `SELECT etl_company_key AS companyKey, name AS company FROM admin_company
        WHERE is_active = 1 AND etl_company_key IS NOT NULL ORDER BY display_order, name`,
    ),
  ]);
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    brands: (brands as Record<string, unknown>[]).map((r) => ({ brandId: Number(r.brandId), brand: String(r.brand), companyKey: num(r.companyKey), company: (r.company as string | null) ?? null })),
    companies: (companies as Record<string, unknown>[]).map((r) => ({ companyKey: Number(r.companyKey), company: String(r.company) })),
  };
}

/** Sets (or clears, with null) a brand's company. The key must be an active admin_company ETL key. */
export async function setBrandCompany(brandId: number, companyKey: number | null, userId: number): Promise<BrandCompanyRow> {
  const [found] = await pool.query('SELECT brand_id, name, company_key FROM marcom_brand WHERE brand_id = ?', [brandId]);
  const brand = (found as { brand_id: number; name: string; company_key: number | null }[])[0];
  if (!brand) throw new MarcomError(404, 'BRAND_NOT_FOUND', 'Brand not found.');
  let company: string | null = null;
  if (companyKey !== null) {
    const [rows] = await pool.query('SELECT name FROM admin_company WHERE etl_company_key = ? AND is_active = 1 ORDER BY display_order, name LIMIT 1', [companyKey]);
    const hit = (rows as { name: string }[])[0];
    if (!hit) throw new MarcomError(400, 'UNKNOWN_COMPANY', 'Unknown company.');
    company = hit.name;
  }
  await pool.query('UPDATE marcom_brand SET company_key = ? WHERE brand_id = ?', [companyKey, brandId]);
  await auditMarcom(userId, 'marcom_brand', String(brandId), 'UPDATE', { brand: brand.name, companyKeyBefore: brand.company_key, companyKey, company });
  return { brandId, brand: brand.name, companyKey, company };
}
