/**
 * Customer Category on screen -- shared by Customer Growth (Customers Category Performance / Share) and Receivables and
 * Collections (Customer Category filter and column). The category is computed by the ETL and stored per customer
 * (dim_customer.CustomerClass_LY); the backend's lib/customerCategory.ts holds the same order and labels for the API.
 * No threshold lives in the frontend.
 */

/** Display order, highest value first. */
export const CUSTOMER_CATEGORIES = ['A', 'B', 'C', 'D'] as const;
export const NO_CUSTOMER_CATEGORY = 'none';

export function isCustomerCategory(value: string): boolean {
  return (CUSTOMER_CATEGORIES as readonly string[]).includes(value);
}

/** "Category A" ... "No category". */
export function customerCategoryLabel(value: string | null | undefined): string {
  return value && isCustomerCategory(value) ? `Category ${value}` : 'No category';
}

/** What a category means, in Customer Growth's words (info tooltips on both pages). */
export const CUSTOMER_CATEGORY_DEFINITION =
  "Customer Category (A highest value - D lowest), from the customer's sales value in the last full calendar year, for B2B and B2C customers; other customers have no category.";

// Categorical palette of the Customers Category Share donut -- same "borrow a few brand hues for a category dimension
// with no dedicated token" convention as Invoices Engine's INVOICE_CLASS_COLOR and Pipeline Health's CATEGORY_PALETTE.
const CATEGORY_COLORS = ['var(--ps-color-trend-target)', 'var(--ps-color-accent)', 'var(--ps-color-gold)', 'var(--ps-color-muted-text)', 'var(--ps-color-watch)', 'var(--ps-color-last-year)'];

/** Colour of the index-th slice (categories in CUSTOMER_CATEGORIES order, or a category's customers). */
export function customerCategoryColor(index: number): string {
  return CATEGORY_COLORS[index % CATEGORY_COLORS.length];
}
