import type { BrandRef } from './common';

export interface Options { years: number[]; brands: BrandRef[]; platforms?: readonly string[]; statuses?: readonly string[] }

/**
 * Wraps a page payload with the filters that were applied, the freshness line and the filter
 * OPTIONS the UI needs (every year with data, every brand, and the page's platform/status lists),
 * so the frontend never hard-codes them. Pure: also used to build the frontend test fixtures.
 */
export function makeEnvelope<T extends { hasData: boolean; meta: { missing: string[] } }>(
  page: string, filters: Record<string, unknown>, options: Options, freshness: unknown, payload: T,
) {
  if (!payload.hasData) payload.meta.missing.push('data');
  return { page, filters, options, freshness, ...payload };
}
