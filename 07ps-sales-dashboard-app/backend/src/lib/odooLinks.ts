/**
 * "Open in Odoo" links for pages that have no finance fallback host. Same URL format as the finance pages
 * (config/finance.ts odooWebBaseUrl: /web#id=<id>&model=<model>&view_type=form), plus `cids` so the record opens in
 * its own company. The base comes ONLY from the settings (ODOO_WEB_BASE_URL, else ODOO_URL): with neither set there
 * is no link at all, never a guessed host.
 */
export function odooConfiguredBaseUrl(env: Record<string, string | undefined> = process.env): string | null {
  const raw = (env.ODOO_WEB_BASE_URL || env.ODOO_URL || '').trim();
  return raw ? raw.replace(/\/+$/, '') : null;
}

/** The form view of one record; null without a base or a real id (> 0). `companyKey` = the Odoo company id. */
export function odooFormUrl(base: string | null, model: string, id: number | null | undefined, companyKey?: number | null): string | null {
  if (!base || id === null || id === undefined || !Number.isInteger(id) || id <= 0) return null;
  const cids = companyKey !== null && companyKey !== undefined && Number.isInteger(companyKey) && companyKey > 0 ? `&cids=${companyKey}` : '';
  return `${base}/web#id=${id}&model=${model}&view_type=form${cids}`;
}
