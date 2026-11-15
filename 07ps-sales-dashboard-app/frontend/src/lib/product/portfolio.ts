import type { ProductStatus } from '../api';

/**
 * One definition of "our products" (2026-11-15), the frontend mirror of backend measures/productPortfolio.ts: the
 * PORTFOLIO is Active + Non Active. Every Product page calculation, chart, ranking, share and export uses it; Dormant and
 * Unclassified are counted only by Total SKUs, their own cards and the status table's own tabs. The API already sends
 * the portfolio only; toProductFacts filters again so no page can drift.
 */
export const PORTFOLIO_STATUSES: readonly ProductStatus[] = ['Active', 'NonActive'];

export function isPortfolio(r: { productStatus: ProductStatus }): boolean {
  return r.productStatus === 'Active' || r.productStatus === 'NonActive';
}

export function portfolioOf<T extends { productStatus: ProductStatus }>(rows: T[]): T[] {
  return rows.filter(isPortfolio);
}
