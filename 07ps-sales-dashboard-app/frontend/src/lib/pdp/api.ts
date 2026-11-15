import { apiRequest, API_BASE } from '../api';
export const BASE = '/product/product-development-plan';
export const ENTRY = 'product_development_entry';
export const PLAN = 'product_development_plan';
export const APPROVAL = 'product_development_approval';
// Database-backed configuration and records have different shapes per screen.
export type Row = Record<string, any>;
export function pdp(
  path: string,
  token: string | null,
  method = 'GET',
  body?: unknown,
): Promise<Row> {
  return apiRequest('/product-development' + path, token, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
}
export async function upload(path: string, token: string | null, body: FormData): Promise<Row> {
  return apiRequest('/product-development' + path, token, { method: 'POST', body });
}
export async function download(path: string, token: string | null, name: string) {
  const r = await fetch(API_BASE + '/product-development' + path, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error((await r.json()).error);
  const url = URL.createObjectURL(await r.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const camel = (s: string) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
export const initialValues = (row: Row): Row =>
  Object.fromEntries(Object.entries(row).map(([k, v]) => [camel(k), v]));
