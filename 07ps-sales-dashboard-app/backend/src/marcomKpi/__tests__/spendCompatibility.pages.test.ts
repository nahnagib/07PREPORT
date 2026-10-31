import { beforeEach, describe, expect, it, vi } from 'vitest';
const mode=vi.hoisted(()=>({modern:true,connectionError:false}));
vi.mock('../../marcom/service',()=>({getFreshness:async()=>({})}));
vi.mock('../db',async importOriginal=>{
  const actual=await importOriginal<typeof import('../db')>();
  return {...actual,listBrands:async()=>[{id:1,name:'A'}],availableYears:async()=>[2026],latestMonth:async()=>({year:2026,month:2}),
    runCurrent:vi.fn(async(table:string,q:{select:string})=>{
      if(mode.connectionError) throw Object.assign(new Error('offline'),{code:'ECONNREFUSED'});
      if(table==='spend') {
        if(mode.modern&&q.select.includes('t.spend AS spend')) throw Object.assign(new Error("Unknown column 't.spend'"),{code:'ER_BAD_FIELD_ERROR'});
        return [{year:2026,month:2,brandId:1,brand:'A',spend:mode.modern?0:250,revenue:500,companyCurrent:1000,companyLy:800,budget:600,newCustomers:2,avgInvoice:50,socialPostCost:10,clicks:20}];
      }
      if(table==='other')return [{year:2026,month:2,brandId:1,amount:40}];
      return [];
    })};
});
import { spendingPage,campaignsPage } from '../pages';
import { runCurrent } from '../db';
beforeEach(()=>{mode.modern=true;mode.connectionError=false;vi.clearAllMocks()});
describe('MARCOM pages on both database schemas',()=>{
  it('restores Spending and Campaigns when the removed spend column is absent',async()=>{
    expect((await spendingPage({year:'2026',fromMonth:'2',toMonth:'2'})).totals.spend.total).toBe(40);
    expect((await campaignsPage({year:'2026',fromMonth:'2',toMonth:'2'})).page).toBe('campaigns');
    expect(vi.mocked(runCurrent).mock.calls.some(c=>c[0]==='other')).toBe(true);
  });
  it('preserves the original schema inputs',async()=>{
    mode.modern=false;
    expect((await spendingPage({year:'2026',fromMonth:'2',toMonth:'2'})).totals.spend.total).toBe(250);
    expect(vi.mocked(runCurrent).mock.calls.some(c=>c[0]==='other')).toBe(false);
  });
  it('propagates connection errors instead of masking them as a schema change',async()=>{
    mode.connectionError=true;
    await expect(spendingPage({year:'2026',fromMonth:'2',toMonth:'2'})).rejects.toMatchObject({code:'ECONNREFUSED'});
  });
});
