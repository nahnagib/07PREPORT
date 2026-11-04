import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CompanyBadge, ProductName, ProductTooltip, SortableProductTable, type SortableColumn } from '../ProductUi';

// The shared exports are checked by what they receive (exportRowsAsCsv adds the UTF-8 BOM itself).
const { csv, pdf } = vi.hoisted(() => ({ csv: vi.fn(async () => undefined), pdf: vi.fn(async () => undefined) }));
vi.mock('@07ps/ui', async (importOriginal) => ({
  ...await importOriginal<typeof import('@07ps/ui')>(),
  exportRowsAsCsv: csv,
  exportRowsAsPdf: pdf,
}));
afterEach(() => { cleanup(); csv.mockClear(); pdf.mockClear(); });

interface Row { id: string; name: string; company: string; revenue: number }
const rows: Row[] = [
  { id: 'Majaal|1', name: 'Basalt Pattern', company: 'Majaal', revenue: 4500 },
  { id: 'Tika|2', name: 'متين GERMA-C2TE', company: 'Tika', revenue: 7300 },
  { id: 'Majaal|3', name: 'Cem Air', company: 'Majaal', revenue: 1100 },
];
const columns: SortableColumn<Row>[] = [
  { key: 'name', header: 'Product', value: (r) => r.name, sortValue: (r) => r.name, render: (r) => <ProductName name={r.name} /> },
  { key: 'company', header: 'Company', value: (r) => r.company, sortValue: (r) => r.company, render: (r) => r.company },
  { key: 'revenue', header: 'Revenue', align: 'right', value: (r) => r.revenue, text: (r) => `LYD ${r.revenue}`, sortValue: (r) => r.revenue, render: (r) => `LYD ${r.revenue}` },
];
const table = () => render(
  <SortableProductTable columns={columns} rows={rows} getRowId={(r) => r.id} searchText={(r) => r.name} defaultSort={{ key: 'revenue', dir: 'desc' }} fileName="t" pdfTitle="T" />,
);

it('product names are LTR, left-aligned and isolated', () => {
  render(<ProductName name="متين GERMA-C2TE" />);
  const el = screen.getByTestId('product-name');
  expect(el.getAttribute('dir')).toBe('ltr');
  expect(el.style.textAlign).toBe('left');
  expect(el.style.unicodeBidi).toBe('isolate');
});

it('a product tooltip shows the company badge first', () => {
  render(<ProductTooltip name="Cem Air" company="Tika" badges={<span>STARS</span>}>x</ProductTooltip>);
  expect(screen.getByTestId('product-tooltip-badges').textContent).toBe('TikaSTARS');
  render(<CompanyBadge company="Majaal" />);
});

it('sorts on any column and the CSV is the visible columns, rows and order, with raw numbers and Arabic intact', async () => {
  table();
  const names = () => screen.getAllByTestId('product-name').map((e) => e.textContent);
  expect(names()).toEqual(['متين GERMA-C2TE', 'Basalt Pattern', 'Cem Air']); // revenue, highest first
  fireEvent.click(screen.getByRole('button', { name: /^Product/ }));
  expect(names()).toEqual(['متين GERMA-C2TE', 'Cem Air', 'Basalt Pattern']); // name desc (first click)
  fireEvent.click(screen.getByRole('button', { name: /^Product/ }));
  expect(names()).toEqual(['Basalt Pattern', 'Cem Air', 'متين GERMA-C2TE']); // name asc
  fireEvent.change(screen.getByLabelText('Search products'), { target: { value: 'C2TE' } });
  expect(names()).toEqual(['متين GERMA-C2TE']);
  fireEvent.change(screen.getByLabelText('Search products'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: /^Revenue/ })); // revenue, highest first

  fireEvent.click(screen.getByRole('button', { name: 'Export T as CSV' }));
  await waitFor(() => expect(csv).toHaveBeenCalledTimes(1));
  expect(csv.mock.calls[0][0]).toEqual({ headers: ['Product', 'Company', 'Revenue'], rows: [['متين GERMA-C2TE', 'Tika', 7300], ['Basalt Pattern', 'Majaal', 4500], ['Cem Air', 'Majaal', 1100]], fileName: 't' });

  fireEvent.click(screen.getByRole('button', { name: 'Export T as PDF' }));
  await waitFor(() => expect(pdf).toHaveBeenCalledTimes(1));
  expect((pdf.mock.calls[0][0] as { rows: string[][] }).rows).toEqual([['متين GERMA-C2TE', 'Tika', 'LYD 7300'], ['Basalt Pattern', 'Majaal', 'LYD 4500'], ['Cem Air', 'Majaal', 'LYD 1100']]);
});
