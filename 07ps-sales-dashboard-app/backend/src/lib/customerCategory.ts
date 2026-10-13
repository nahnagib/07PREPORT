/**
 * Customer Category -- ONE definition for every page that shows it (Customer Growth's "Customers Category Performance",
 * Receivables and Collections' "Customer Category" filter).
 *
 * The category itself is computed by the sales ETL, once per customer, and stored on dim_customer.CustomerClass_LY
 * (dim_customer in the legacy views): A highest value - D lowest, from the customer's sales value in the last full
 * calendar year before the ETL run (2025 for runs in 2026), for B2B and B2C customers only; other customers have no
 * category (NULL). The thresholds live only there (data/etl/src/sales_pipeline/legacy_transform.py
 * _add_customer_class) and are never repeated here. Both pages read the stored value as is -- neither recomputes it
 * for its own period -- so a customer has the same category on both.
 */

/** dim_customer / dim_customer column that holds the category. */
export const CUSTOMER_CATEGORY_COLUMN = 'CustomerClass_LY';

/** Display order (highest value first). */
export const CUSTOMER_CATEGORIES = ['A', 'B', 'C', 'D'] as const;
export type CustomerCategory = (typeof CUSTOMER_CATEGORIES)[number];

/** Filter value of the customers without a category. */
export const NO_CUSTOMER_CATEGORY = 'none';
export type CustomerCategoryFilterValue = CustomerCategory | typeof NO_CUSTOMER_CATEGORY;

export function isCustomerCategory(value: unknown): value is CustomerCategory {
  return typeof value === 'string' && (CUSTOMER_CATEGORIES as readonly string[]).includes(value);
}

/** "Category A" ... "Category D", "No category" -- the wording of Customer Growth. */
export function customerCategoryLabel(value: string | null | undefined): string {
  return isCustomerCategory(value) ? `Category ${value}` : 'No category';
}

/**
 * SQL condition "the customer's category is one of `values`" on a dim_customer alias, for a filter.
 * `none` matches customers without a category.
 */
export function customerCategoryCondition(alias: string, values: readonly string[]): { sql: string; params: string[] } | null {
  if (values.length === 0) return null;
  const col = `${alias}.${CUSTOMER_CATEGORY_COLUMN}`;
  const letters = values.filter(isCustomerCategory);
  const parts: string[] = [];
  if (letters.length) parts.push(`${col} IN (${letters.map(() => '?').join(', ')})`);
  if (values.includes(NO_CUSTOMER_CATEGORY)) parts.push(`(${col} IS NULL OR ${col} NOT IN (${CUSTOMER_CATEGORIES.map(() => '?').join(', ')}))`);
  const params = [...letters, ...(values.includes(NO_CUSTOMER_CATEGORY) ? [...CUSTOMER_CATEGORIES] : [])];
  return { sql: `(${parts.join(' OR ')})`, params };
}
