import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Column } from '@07ps/ui';
import { OdooLink } from '../../components/OdooLink';
import { rowsToPdfRows } from '../pdfRows';

interface Row extends Record<string, unknown> { orderNumber: string; value: number; customer: string; odooUrl: string | null }

const columns: Column<Row>[] = [
  { key: 'orderNumber', header: 'Order Number', render: (r) => <OdooLink href={r.odooUrl}>{r.orderNumber}</OdooLink> },
  { key: 'value', header: 'Value', render: (r) => `LYD ${r.value}` },
  { key: 'customer', header: 'Customer' },
];
const rows: Row[] = [
  { orderNumber: 'S41753', value: 500, customer: 'ACME', odooUrl: 'https://erp.example.com/web#id=84549&model=sale.order&view_type=form&cids=1' },
  { orderNumber: 'S00004', value: 7, customer: 'محل', odooUrl: null },
];

describe('drill-down PDF rows', () => {
  it('exports the plain text of linked columns (never [object Object]) and keeps text renders', () => {
    expect(rowsToPdfRows(columns, rows)).toEqual([
      ['S41753', 'LYD 500', 'ACME'],
      ['S00004', 'LYD 7', 'محل'],
    ]);
  });
});

describe('OdooLink', () => {
  it('links the record in a new tab, or shows plain text without a URL', () => {
    const linked = renderToStaticMarkup(<OdooLink href={rows[0].odooUrl}>S41753</OdooLink>);
    expect(linked).toContain('href="https://erp.example.com/web#id=84549&amp;model=sale.order&amp;view_type=form&amp;cids=1"');
    expect(linked).toContain('target="_blank"');
    expect(linked).toContain('rel="noopener noreferrer"');
    const plain = renderToStaticMarkup(<OdooLink href={null}>S00004</OdooLink>);
    expect(plain).not.toContain('<a');
    expect(plain).toContain('S00004');
    expect(renderToStaticMarkup(<OdooLink href="javascript:alert(1)">x</OdooLink>)).not.toContain('<a');
  });
});
