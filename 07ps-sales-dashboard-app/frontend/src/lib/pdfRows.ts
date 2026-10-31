import type { Column } from '@07ps/ui';

/**
 * The drill-down tables' PDF rows: each column's formatted text (its `render` when that returns text, e.g. a currency),
 * else the plain row value. A render that returns an element (an Odoo link) exports the column's text, never
 * "[object Object]".
 */
export function rowsToPdfRows<T extends Record<string, unknown>>(columns: Column<T>[], rows: T[]): string[][] {
  return rows.map((row) => columns.map((c) => {
    const rendered = c.render ? c.render(row) : undefined;
    return typeof rendered === 'string' || typeof rendered === 'number' ? String(rendered) : String(row[c.key] ?? '');
  }));
}
