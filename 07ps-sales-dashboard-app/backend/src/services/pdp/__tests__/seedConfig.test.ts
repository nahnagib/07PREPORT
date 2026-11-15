import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SEED_CHECKLIST, SEED_CRITERIA, SEED_DROPDOWNS, SEED_GAP_ITEMS, SEED_GATE_RULES, SEED_GOVERNANCE_ROLES, SEED_KPI_TARGETS, SEED_ROADMAP_YEARS, SEED_SETTINGS,
} from '../seedConfig';

/** seedConfig.ts (used by the import on a database seeded before TIKA existed) must say what migration 0075 says. */
const SQL = readFileSync(path.resolve(__dirname, '../../../../../data/warehouse/migrations/0075_pdp_seed_config.sql'), 'utf8');
// One ROW(...) per value tuple; a multi-line ROW is joined onto one line first.
const ROWS = SQL.replace(/,\n\s+(?=')/g, ', ').split('\n').filter((l) => l.includes('ROW('));
const lit = (v: string | number) => (typeof v === 'number' ? String(v) : `'${v.replace(/'/g, "''")}'`);

/** Some ROW line holds every one of these values (as SQL literals). */
function hasRow(...values: (string | number)[]): boolean {
  return ROWS.some((line) => values.every((v) => line.includes(lit(v))));
}

describe('0075 and seedConfig.ts agree', () => {
  it('settings', () => {
    for (const [k, v] of SEED_SETTINGS) expect(hasRow(k, v), k).toBe(true);
  });
  it('scoring criteria: names, weights, the six meanings; weights total 100', () => {
    for (const c of SEED_CRITERIA) expect(hasRow(c.code, c.name, c.weight, ...c.meanings), c.name).toBe(true);
    expect(SEED_CRITERIA.reduce((s, c) => s + c.weight, 0)).toBe(100);
  });
  it('governance roles, gate rules, checklist items', () => {
    for (const [code, label, resp] of SEED_GOVERNANCE_ROLES) expect(hasRow(code, label, resp), code).toBe(true);
    for (const [gate, code, label, roles, mode, applies] of SEED_GATE_RULES) expect(hasRow(gate, code, label, JSON.stringify(roles), mode, applies), code).toBe(true);
    for (const [list, code, label, hint, gate, req, ev, owner] of SEED_CHECKLIST) {
      expect(hasRow(list, code, label, ...(hint ? [hint] : []), gate, owner), code).toBe(true);
      expect(ROWS.some((l) => l.includes(lit(code)) && l.includes(`${lit(gate)}, ${req}, ${ev}, ${lit(owner)}`)), `${code} flags`).toBe(true);
    }
    expect(SEED_CHECKLIST.filter(([list, , , , , req]) => list === 'DOCUMENTATION' && req === 1)).toHaveLength(7);
    const packaging = SEED_CHECKLIST.find(([, code]) => code === 'DOC_PACKAGING');
    expect([packaging?.[5], packaging?.[7]]).toEqual([0, 'MARKETING']);
  });
  it('KPI targets, roadmap years, gap items, drop-downs', () => {
    for (const [code, label, t, cmp, unit] of SEED_KPI_TARGETS) expect(hasRow(code, label, t, cmp, unit), code).toBe(true);
    for (const [y, theme] of SEED_ROADMAP_YEARS) expect(hasRow(y, theme), theme).toBe(true);
    expect(SEED_GAP_ITEMS).toHaveLength(13);
    for (const [cat, item, st] of SEED_GAP_ITEMS) expect(hasRow(cat, item, st), item).toBe(true);
    for (const [list, label] of SEED_DROPDOWNS) expect(hasRow(list, label), label).toBe(true);
    expect(SQL.match(/ROW\('(project_type|request_source|competitor|lab_property|feedback_channel|feedback_category)'/g)).toHaveLength(SEED_DROPDOWNS.length);
  });
});
