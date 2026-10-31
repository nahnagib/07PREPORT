import type { SpendRow } from './spending';
import { R, Rat } from './rat';
import type { Num } from './common';
export interface CampaignCost { brandId: number; start: string; end: string; spend: Num }
export interface OtherCost { year: number; month: number; brandId: number; amount: Num }
const date = (iso: string) => Date.parse(iso + 'T00:00:00Z');
const DAY = 86400000;
/** Current schema: actual spend is active-day-prorated campaigns plus other expense lines, never finance booked. */
export function combineSpendRows(
  monthly: SpendRow[], campaigns: CampaignCost[], other: OtherCost[],
  years: number[], fromMonth: number, toMonth: number, brands: {id:number; name:string}[],
): SpendRow[] {
  const key = (year: number, month: number, brand: number) => `${year}-${month}-${brand}`;
  const rows = new Map(monthly.map(row => [key(row.year,row.month,row.brandId), {...row}]));
  const costs = new Map<string, Rat>();
  const add = (year: number, month: number, brandId: number, amount: Rat) => {
    const k = key(year,month,brandId);
    costs.set(k,(costs.get(k) ?? Rat.ZERO).add(amount));
    if (!rows.has(k)) rows.set(k,{year,month,brandId,brand:brands.find(b=>b.id===brandId)?.name ?? `#${brandId}`,spend:0,revenue:0,companyCurrent:0,companyLy:0,budget:0,newCustomers:0,avgInvoice:0,socialPostCost:0,clicks:0});
  };
  for (const c of campaigns) {
    const start = date(c.start), end = date(c.end), days = Math.round((end-start)/DAY)+1;
    if (days <= 0) continue;
    for (const year of years) for(let month=fromMonth;month<=toMonth;month++) {
      const overlap = Math.max(0,Math.round((Math.min(end,Date.UTC(year,month,0))-Math.max(start,Date.UTC(year,month-1,1)))/DAY)+1);
      if (overlap) add(year,month,Number(c.brandId),R(c.spend).mul(Rat.of(BigInt(overlap),BigInt(days))));
    }
  }
  for(const line of other) add(Number(line.year),Number(line.month),Number(line.brandId),R(line.amount));
  return [...rows.entries()].map(([k,row])=>({...row,spend:costs.get(k) ?? Rat.ZERO})).sort((a,b)=>a.year-b.year||a.month-b.month||a.brandId-b.brandId);
}
