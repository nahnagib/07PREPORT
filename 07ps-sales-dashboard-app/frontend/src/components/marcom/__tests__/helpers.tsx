import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChartSizeContext } from '../MarcomChartCard';
import { setFormatLocale } from '../../../lib/marcom/format';

setFormatLocale('en-US');

/** Static render with a fixed chart width (there is no layout engine in these tests). */
export function render(node: React.ReactElement, width = 900): string {
  return renderToStaticMarkup(<ChartSizeContext.Provider value={{ width }}>{node}</ChartSizeContext.Provider>);
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#39;': "'", '&nbsp;': ' ' };

/** Visible + screen-reader text of a rendered fragment, whitespace-collapsed. */
export function flat(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|#x27|#39|nbsp);/g, (m) => ENTITIES[m])
    .replace(/\s+/g, ' ')
    .trim();
}

const FIXTURES = path.join(__dirname, '..', '__fixtures__');
export function fixture<T = unknown>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')) as T;
}

/** All data-visual ids in a rendered page, in order. */
export const visualsIn = (html: string): string[] => [...html.matchAll(/data-visual="([^"]+)"/g)].map((m) => m[1]);

/** The rendered HTML of one visual card. */
export function visualHtml(html: string, id: string): string {
  const start = html.indexOf(`data-visual="${id}"`);
  if (start < 0) throw new Error(`visual ${id} not rendered`);
  const rest = html.slice(start + 1);
  const next = rest.search(/data-visual="/);
  return next < 0 ? html.slice(start) : html.slice(start, start + 1 + next);
}

export const testIds = (html: string, id: string): string[] => [...html.matchAll(new RegExp(`<[^>]*data-testid="${id}"[^>]*>`, 'g'))].map((m) => m[0]);
