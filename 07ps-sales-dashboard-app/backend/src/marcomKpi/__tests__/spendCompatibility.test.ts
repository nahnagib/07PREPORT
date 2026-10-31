import { R } from '../rat';
import { describe, expect, it } from 'vitest';
import { combineSpendRows } from '../spendCompatibility';
import type { SpendRow } from '../spending';
const monthly = (year=2026,month=2): SpendRow => ({year,month,brandId:1,brand:'A',spend:999999,revenue:500,companyCurrent:1000,companyLy:800,budget:600,newCustomers:2,avgInvoice:50,socialPostCost:10,clicks:20});
describe('revised spend schema compatibility', () => {
  it('spreads campaign spend by inclusive active days and adds other costs, ignoring booked spend', () => {
    const rows=combineSpendRows([monthly()],[{brandId:1,start:'2026-02-01',end:'2026-03-15',spend:4300}],[{year:2026,month:2,brandId:1,amount:200}],[2026],2,3,[{id:1,name:'A'}]);
    expect(rows.map(r=>[r.month,R(r.spend).toNumber()])).toEqual([[2,3000],[3,1500]]);
    expect(rows[0].companyCurrent).toBe(1000);
  });
  it('keeps prorated costs exact until the KPI is serialized', () => {
    const rows=combineSpendRows([],[{brandId:1,start:'2026-01-01',end:'2026-03-31',spend:100}],[],[2026],1,3,[{id:1,name:'A'}]);
    const total=rows.reduce((sum,row)=>sum.add(R(row.spend)),R(0));
    expect(total.cmp(R(100))).toBe(0);
  });
  it('includes campaign/other-only months and year boundaries without duplicating expense lines', () => {
    const rows=combineSpendRows([],[{brandId:1,start:'2025-12-31',end:'2026-01-01',spend:100}],[],[2025,2026],1,12,[{id:1,name:'A'}]);
    expect(rows.map(r=>[r.year,r.month,R(r.spend).toNumber()])).toEqual([[2025,12,50],[2026,1,50]]);
  });
});
