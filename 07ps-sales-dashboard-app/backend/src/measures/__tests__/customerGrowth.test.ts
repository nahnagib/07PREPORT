import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { fetchCustomerActivitySnapshot, fetchCustomerRows } from '../customerGrowth';
import { dateOnlyUTC } from '../filters';

describe('Customer Growth lifetime value', () => {
  it('sums all years while retaining customer, business, access and category filters', async () => {
    const query = vi.fn(async () => [[{
      customerKey: 42, ytdValue: '130.00', lifetimeValue: '2140.75',
      hasYtd: 1, hasLytd: 0, hasBeforeLytd: 1,
    }]]);
    const pool = { query } as unknown as Pool;

    const activity = await fetchCustomerActivitySnapshot(pool, dateOnlyUTC(2026, 10, 15), {
      companyKeys: [2], salespersonKeys: [7], customerKeys: [42],
    }, { year: 2026, category: 'C' });

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('COALESCE(SUM(fsl.Value), 0) AS lifetimeValue');
    const where = sql.slice(sql.indexOf('WHERE'));
    expect(where).not.toMatch(/dd\.Date|DateKey|YEAR\(/);
    expect(where).toContain('fsl.CompanyKey IN (?)');
    expect(where).toContain('fsl.SalespersonKey IN (?)');
    expect(where).toContain('fsl.CustomerKey IN (?)');
    expect(where).toContain('dc.CustomerClass_LY = ?');
    expect(params).toEqual([
      '2026-01-01', '2026-10-15', '2026-01-01', '2026-10-15',
      '2025-01-01', '2025-10-15', '2025-01-01', 2, 7, 42, 'C',
    ]);
    expect(activity.get(42)).toMatchObject({ ytdValue: 130, lifetimeValue: 2140.75 });
  });

  it('includes lifetime values for inactive customers and preserves zero and negative net sales', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM v_sales_lines')) return [[
        { customerKey: 1, ytdValue: '0', lifetimeValue: '1520.50', hasYtd: 0, hasLytd: 1, hasBeforeLytd: 1 },
        { customerKey: 2, ytdValue: '0', lifetimeValue: '0.00', hasYtd: 0, hasLytd: 0, hasBeforeLytd: 1 },
        { customerKey: 3, ytdValue: '-25', lifetimeValue: '-125.25', hasYtd: 1, hasLytd: 1, hasBeforeLytd: 1 },
      ]];
      return [[{ customerKey: 1, name: 'Inactive customer', isBlocked: 0 }]];
    });
    const pool = { query } as unknown as Pool;

    const rows = await fetchCustomerRows(pool, dateOnlyUTC(2026, 10, 15), {});

    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ customerKey: 1, name: 'Inactive customer', ytdValue: 0, lifetimeValue: 1520.5, status: 'Non Active' }),
      expect.objectContaining({ customerKey: 2, lifetimeValue: 0 }),
      expect.objectContaining({ customerKey: 3, lifetimeValue: -125.25 }),
    ]));
    expect(query).toHaveBeenCalledTimes(2);
  });
});
