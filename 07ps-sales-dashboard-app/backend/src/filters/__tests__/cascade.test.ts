import { describe, expect, it } from 'vitest';
import { Combo, Selection, computeCascade, emptySelection } from '../cascade';

// Company 1 = Majaal, 2 = Tika. Segment 1 = B2B, 2 = B2C. Channel 2 = Projects, 3 = Retail.
// Teams T1/T2 sell for Majaal, T3 for Tika. Salesperson 20 sells for BOTH companies (real data has
// such people), 10/11 only Majaal, 30 only Tika.
const c = (co: number, sg: number, ch: number, tm: string | null, sp: number, cu: number | null): Combo => ({
  companyKeys: String(co),
  segmentKeys: String(sg),
  channelKeys: String(ch),
  salesTeamKeys: tm,
  salespersonKeys: String(sp),
  customerKeys: cu === null ? null : String(cu),
});

const COMBOS: Combo[] = [
  c(1, 1, 2, 'T1', 10, 100), // Majaal / B2B / Projects
  c(1, 1, 2, 'T1', 10, 101),
  c(1, 2, 3, 'T2', 11, 102), // Majaal / B2C / Retail
  c(1, 2, 3, 'T2', 20, 103),
  c(2, 1, 2, 'T3', 20, 104), // Tika / B2B / Projects, sold by the shared salesperson
  c(2, 2, 3, 'T3', 30, 105), // Tika / B2C / Retail
  c(2, 2, 3, null, 30, 106), // Tika sale with no branch
];

const sel = (over: Partial<Selection>): Selection => ({ ...emptySelection(), ...over });
const sorted = (s: Set<string>) => [...s].sort();

describe('computeCascade', () => {
  it('offers everything when nothing is selected', () => {
    const r = computeCascade(COMBOS, sel({}));
    expect(sorted(r.options.companyKeys)).toEqual(['1', '2']);
    expect(sorted(r.options.salesTeamKeys)).toEqual(['T1', 'T2', 'T3']); // null branch never an option
    expect(sorted(r.options.customerKeys)).toHaveLength(7);
    expect(r.matchingCombos).toBe(COMBOS.length);
  });

  it('Company = Majaal removes every branch, salesperson, customer and channel that is not Majaal', () => {
    const r = computeCascade(COMBOS, sel({ companyKeys: ['1'] }));
    expect(sorted(r.options.salesTeamKeys)).toEqual(['T1', 'T2']);
    expect(sorted(r.options.salespersonKeys)).toEqual(['10', '11', '20']);
    expect(sorted(r.options.customerKeys)).toEqual(['100', '101', '102', '103']);
    expect(sorted(r.options.channelKeys)).toEqual(['2', '3']);
    // ...but Company itself still lists both, so the user can widen the selection.
    expect(sorted(r.options.companyKeys)).toEqual(['1', '2']);
  });

  it('Customer Group = B2B removes branches, salespeople and customers that are not B2B', () => {
    const r = computeCascade(COMBOS, sel({ segmentKeys: ['1'] }));
    expect(sorted(r.options.salesTeamKeys)).toEqual(['T1', 'T3']);
    expect(sorted(r.options.salespersonKeys)).toEqual(['10', '20']);
    expect(sorted(r.options.customerKeys)).toEqual(['100', '101', '104']);
    expect(sorted(r.options.channelKeys)).toEqual(['2']);
  });

  it('cascades in the reverse direction too (Salesperson -> Company/Group/Branch/Customer)', () => {
    const r = computeCascade(COMBOS, sel({ salespersonKeys: ['30'] }));
    expect(sorted(r.options.companyKeys)).toEqual(['2']);
    expect(sorted(r.options.segmentKeys)).toEqual(['2']);
    expect(sorted(r.options.salesTeamKeys)).toEqual(['T3']);
    expect(sorted(r.options.customerKeys)).toEqual(['105', '106']);
  });

  it('a customer selection narrows every other dimension', () => {
    const r = computeCascade(COMBOS, sel({ customerKeys: ['104'] }));
    expect(sorted(r.options.companyKeys)).toEqual(['2']);
    expect(sorted(r.options.segmentKeys)).toEqual(['1']);
    expect(sorted(r.options.salespersonKeys)).toEqual(['20']);
  });

  it('combines filters (Majaal AND B2B)', () => {
    const r = computeCascade(COMBOS, sel({ companyKeys: ['1'], segmentKeys: ['1'] }));
    expect(sorted(r.options.salesTeamKeys)).toEqual(['T1']);
    expect(sorted(r.options.salespersonKeys)).toEqual(['10']);
    expect(sorted(r.options.customerKeys)).toEqual(['100', '101']);
  });

  it('multi-select offers the union of what each selected value allows', () => {
    const r = computeCascade(COMBOS, sel({ companyKeys: ['1', '2'], segmentKeys: ['1'] }));
    expect(sorted(r.options.salesTeamKeys)).toEqual(['T1', 'T3']);
    const onlyTika = computeCascade(COMBOS, sel({ companyKeys: ['2'] }));
    expect(sorted(onlyTika.options.salesTeamKeys)).toEqual(['T3']);
  });

  it("does not let a dimension's own selection narrow its own list", () => {
    const r = computeCascade(COMBOS, sel({ salesTeamKeys: ['T1'] }));
    expect(sorted(r.options.salesTeamKeys)).toEqual(['T1', 'T2', 'T3']);
  });

  it('drops a selected value that another filter made invalid', () => {
    // T3 is a Tika branch: choosing Majaal makes it invalid, but T1 stays.
    const r = computeCascade(COMBOS, sel({ companyKeys: ['1'], salesTeamKeys: ['T1', 'T3'] }));
    expect(r.selection.salesTeamKeys).toEqual(['T1']);
    expect(r.selection.companyKeys).toEqual(['1']);
  });

  it('keeps pruning until stable (dropping one value can invalidate another)', () => {
    // Salesperson 30 (Tika) invalid under Majaal -> dropped; customer 105 only belongs to 30, so
    // once 30 is gone... it is invalid by Majaal directly as well. Either way both must go.
    const r = computeCascade(COMBOS, sel({ companyKeys: ['1'], salespersonKeys: ['30', '10'], customerKeys: ['105', '100'] }));
    expect(r.selection.salespersonKeys).toEqual(['10']);
    expect(r.selection.customerKeys).toEqual(['100']);
  });

  it('keeps parent selections and drops the most specific conflicting one', () => {
    // Majaal + B2B never sells via Retail: the channel goes, the company and group stay.
    const r = computeCascade(COMBOS, sel({ companyKeys: ['1'], segmentKeys: ['1'], channelKeys: ['3'] }));
    expect(r.selection).toEqual(sel({ companyKeys: ['1'], segmentKeys: ['1'] }));
    expect(r.matchingCombos).toBe(2);
  });

  it('reports no data when there is nothing to match', () => {
    const r = computeCascade([], sel({}));
    expect(r.matchingCombos).toBe(0);
    expect(r.options.companyKeys.size).toBe(0);
  });

  it('applies scope as a hard wall that selections cannot widen', () => {
    const r = computeCascade(COMBOS, sel({ companyKeys: ['2'] }), { salespersonKeys: ['10', '11'] });
    expect(r.options.salespersonKeys.size).toBeLessThanOrEqual(2);
    expect(sorted(r.options.companyKeys)).toEqual(['1']); // only Majaal rows are in scope
    expect(r.selection.companyKeys).toEqual([]); // Tika selection is out of scope -> dropped
  });

  it('a salesperson-pinned scope sees only their own branches and customers', () => {
    const r = computeCascade(COMBOS, sel({}), { salespersonKeys: ['20'] });
    expect(sorted(r.options.customerKeys)).toEqual(['103', '104']);
    expect(sorted(r.options.companyKeys)).toEqual(['1', '2']);
  });
});
