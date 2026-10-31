import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { fetchFunnelStageRecords, fetchOpportunityDetails } from '../pipelineHealth';
import { fetchCustomerRows } from '../customerGrowth';
import { dateOnlyUTC } from '../filters';

/**
 * "Open in Odoo" links on Pipeline Health (opportunities, quotations, sales orders, deliveries) and the Customer Growth
 * Customers Table. Built by lib/odooLinks from the record's own Odoo id and company, never from names or numbers.
 */

const BASE = 'https://erp.example.com';
const anchor = dateOnlyUTC(2026, 10, 15);

const opportunity = { opportunityId: 3919, name: 'Hotel', customer: 'ACME', company: 'Majaal', expectedRevenue: '1000', isOpen: 1, partnerId: 19297, companyKey: 1 };
const document = { orderNumber: 'S41753', customer: 'ACME', company: 'TIKA', value: '500', documentType: 'Sales Order', opportunityId: 3919, odooOrderId: 84549, partnerId: 17957, companyKey: 3 };
const delivery = { orderNumber: 'S41753', deliveryReference: 'WH/OUT/42207', customer: 'ACME', company: 'Majaal', opportunityId: 3919, pickingId: 88772, odooOrderId: 84549, partnerId: 28958, companyKey: 1 };

function poolFor(rows: Record<string, unknown[]>): Pool {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('FROM v_sales_opportunities')) return [rows.opportunities ?? []];
    if (sql.includes('FROM v_sales_deliveries')) return [rows.deliveries ?? []];
    if (sql.includes('FROM v_sales_documents')) return [rows.documents ?? []];
    if (sql.includes('FROM v_sales_lines')) return [rows.lines ?? []];
    return [rows.dim ?? []];
  });
  return { query } as unknown as Pool;
}

afterEach(() => vi.unstubAllEnvs());

describe('Pipeline Health drill-down Odoo links', () => {
  it('builds the crm.lead / sale.order / stock.picking / res.partner form URLs in the record\'s own company (cids)', async () => {
    vi.stubEnv('ODOO_WEB_BASE_URL', `${BASE}/`);
    const pool = poolFor({ opportunities: [opportunity], documents: [document], deliveries: [delivery] });

    const [opp] = await fetchOpportunityDetails(pool, anchor, {});
    expect(opp.odooUrl).toBe(`${BASE}/web#id=3919&model=crm.lead&view_type=form&cids=1`);
    expect(opp.customerOdooUrl).toBe(`${BASE}/web#id=19297&model=res.partner&view_type=form&cids=1`);

    const stages = await fetchFunnelStageRecords(pool, anchor, {});
    for (const so of [stages.quotations[0], stages.salesOrders[0]]) {
      expect(so.odooUrl).toBe(`${BASE}/web#id=84549&model=sale.order&view_type=form&cids=3`);
      expect(so.customerOdooUrl).toBe(`${BASE}/web#id=17957&model=res.partner&view_type=form&cids=3`);
    }
    const d = stages.deliveries[0];
    expect(d.odooUrl).toBe(`${BASE}/web#id=88772&model=stock.picking&view_type=form&cids=1`);
    expect(d.orderOdooUrl).toBe(`${BASE}/web#id=84549&model=sale.order&view_type=form&cids=1`);
    expect(d.customerOdooUrl).toBe(`${BASE}/web#id=28958&model=res.partner&view_type=form&cids=1`);
  });

  it('reads the Odoo ids from the warehouse columns (SalesOrderKey, PickingID, CustomerKey, CompanyKey)', async () => {
    const pool = poolFor({});
    await fetchOpportunityDetails(pool, anchor, {});
    await fetchFunnelStageRecords(pool, anchor, {});
    const sqls = (pool.query as unknown as { mock: { calls: [string][] } }).mock.calls.map((c) => c[0]);
    expect(sqls.find((q) => q.includes('v_sales_opportunities'))).toMatch(/fo\.CustomerKey AS partnerId[\s\S]*fo\.CompanyKey AS companyKey/);
    expect(sqls.filter((q) => q.includes('fs.SalesOrderKey AS odooOrderId, fs.CustomerKey AS partnerId, fs.CompanyKey AS companyKey'))).toHaveLength(2);
    expect(sqls.find((q) => q.includes('v_sales_deliveries'))).toContain('fd.PickingID AS pickingId, fd.SalesOrderID AS odooOrderId, fd.CustomerKey AS partnerId, fd.CompanyKey AS companyKey');
  });

  it('falls back to ODOO_URL, and gives no link at all when neither setting is set', async () => {
    vi.stubEnv('ODOO_WEB_BASE_URL', '');
    vi.stubEnv('ODOO_URL', BASE);
    const [viaOdooUrl] = await fetchOpportunityDetails(poolFor({ opportunities: [opportunity] }), anchor, {});
    expect(viaOdooUrl.odooUrl).toBe(`${BASE}/web#id=3919&model=crm.lead&view_type=form&cids=1`);

    vi.stubEnv('ODOO_URL', '');
    const pool = poolFor({ opportunities: [opportunity], documents: [document], deliveries: [delivery] });
    const [opp] = await fetchOpportunityDetails(pool, anchor, {});
    const stages = await fetchFunnelStageRecords(pool, anchor, {});
    expect([opp.odooUrl, opp.customerOdooUrl]).toEqual([null, null]);
    expect([stages.salesOrders[0].odooUrl, stages.salesOrders[0].customerOdooUrl]).toEqual([null, null]);
    expect([stages.deliveries[0].odooUrl, stages.deliveries[0].orderOdooUrl, stages.deliveries[0].customerOdooUrl]).toEqual([null, null, null]);
  });

  it('gives no link when the id is missing, 0 or the -1 Unknown key; no cids without a real company', async () => {
    vi.stubEnv('ODOO_WEB_BASE_URL', BASE);
    const pool = poolFor({
      opportunities: [{ ...opportunity, partnerId: -1, companyKey: -1 }],
      documents: [{ ...document, odooOrderId: 0, partnerId: null }],
      deliveries: [{ ...delivery, pickingId: null, odooOrderId: undefined, partnerId: 0 }],
    });
    const [opp] = await fetchOpportunityDetails(pool, anchor, {});
    expect(opp.odooUrl).toBe(`${BASE}/web#id=3919&model=crm.lead&view_type=form`);
    expect(opp.customerOdooUrl).toBeNull();
    const stages = await fetchFunnelStageRecords(pool, anchor, {});
    expect([stages.quotations[0].odooUrl, stages.quotations[0].customerOdooUrl]).toEqual([null, null]);
    expect([stages.deliveries[0].odooUrl, stages.deliveries[0].orderOdooUrl, stages.deliveries[0].customerOdooUrl]).toEqual([null, null, null]);
  });
});

describe('Customers Table Odoo link', () => {
  const lines = [
    { customerKey: 42, ytdValue: '10', lifetimeValue: '10', hasYtd: 1, hasLytd: 0, hasBeforeLytd: 0, minCompanyKey: 3, maxCompanyKey: 3 },
    { customerKey: 43, ytdValue: '10', lifetimeValue: '10', hasYtd: 1, hasLytd: 0, hasBeforeLytd: 0, minCompanyKey: 1, maxCompanyKey: 3 },
  ];

  it('links the res.partner form, in the company when every sale is in one company, without cids otherwise', async () => {
    vi.stubEnv('ODOO_WEB_BASE_URL', BASE);
    const rows = await fetchCustomerRows(poolFor({ lines }), anchor, {});
    const byKey = new Map(rows.map((r) => [r.customerKey, r.customerOdooUrl]));
    expect(byKey.get(42)).toBe(`${BASE}/web#id=42&model=res.partner&view_type=form&cids=3`);
    expect(byKey.get(43)).toBe(`${BASE}/web#id=43&model=res.partner&view_type=form`);
  });

  it('no link without ODOO_WEB_BASE_URL / ODOO_URL, or for a non-positive customer key', async () => {
    vi.stubEnv('ODOO_WEB_BASE_URL', '');
    vi.stubEnv('ODOO_URL', '');
    expect((await fetchCustomerRows(poolFor({ lines }), anchor, {})).map((r) => r.customerOdooUrl)).toEqual([null, null]);
    vi.stubEnv('ODOO_WEB_BASE_URL', BASE);
    const [unknown] = await fetchCustomerRows(poolFor({ lines: [{ ...lines[0], customerKey: -1 }] }), anchor, {});
    expect(unknown.customerOdooUrl).toBeNull();
  });
});
