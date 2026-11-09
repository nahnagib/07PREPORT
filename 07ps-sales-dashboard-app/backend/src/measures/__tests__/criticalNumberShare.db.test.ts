import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../../db/pool';
import { computeDailyCriticalNumberSchedule, computeYearlyCounter } from '../criticalNumber';
import { criticalNumberLookup, loadCriticalNumberHistory } from '../criticalNumberHistory';
import { dateOnlyUTC, type Filters } from '../filters';

/**
 * The Critical Number split (2026-11-09) against a REAL warehouse, read-only (SELECT only). Opt-in:
 *
 *   DB_HOST=... DB_USER=... DB_PASSWORD=... DB_NAME=powerBI_Data npx vitest run -c vitest.cn-db.config.ts
 *
 * The acceptance table of the change: every scope's share of the 2026 revenue target in v_sales_targets
 * (Input/sales_targets.xlsx) and its Daily Critical Number = the base active on the day x that share, to within 1 LYD.
 * The expected shares are the file's own (raw columns); a scope the salesperson admin overrides move (segment / branch /
 * channel, measures/filters.ts) is listed in OVERRIDE_MOVED with the share the page really uses, since the targets are
 * filtered exactly like the actual sales on the same page. Prints the table it checked.
 */
const RUN = process.env.CN_TEST_DB === '1';
const DAY = dateOnlyUTC(2026, 11, 9);

interface Row {
  scope: string;
  filters: () => Promise<Filters>;
  /** sales_targets.xlsx share, % (raw columns) */
  share: number;
  /** The acceptance table's Daily Critical Number at base 556,462.28 (LYD, rounded) */
  lyd: number;
}

const ACCEPTANCE_BASE = 556_462.28;
const TOTAL_2026 = 169_164_533;

async function salespersonKey(name: string): Promise<number> {
  const [rows] = await pool.query('SELECT SalespersonKey AS k FROM dim_salesperson WHERE TRIM(salesperson) = ?', [name]);
  const list = rows as { k: number }[];
  if (list.length !== 1) throw new Error(`salesperson ${name}: ${list.length} rows in dim_salesperson`);
  return Number(list[0].k);
}

const sp = (name: string) => async (): Promise<Filters> => ({ salespersonKeys: [await salespersonKey(name)] });
const fixed = (f: Filters) => async () => f;

// CompanyKey 1 = Majaal, 3 = Tika; SegmentKey 1 = B2B, 2 = B2C (dim_company / dim_segment)
const ROWS: Row[] = [
  { scope: 'Group (no filter)', filters: fixed({}), share: 100, lyd: 556_462 },
  { scope: 'Majaal', filters: fixed({ companyKeys: [1] }), share: 47.378, lyd: 263_640 },
  { scope: 'Tika', filters: fixed({ companyKeys: [3] }), share: 52.622, lyd: 292_822 },
  { scope: 'B2B', filters: fixed({ segmentKeys: [1] }), share: 62.961, lyd: 350_352 },
  { scope: 'B2C', filters: fixed({ segmentKeys: [2] }), share: 37.039, lyd: 206_111 },
  { scope: 'Tika + B2B', filters: fixed({ companyKeys: [3], segmentKeys: [1] }), share: 43.408, lyd: 241_549 },
  { scope: 'Majaal + B2C', filters: fixed({ companyKeys: [1], segmentKeys: [2] }), share: 27.825, lyd: 154_838 },
  { scope: 'Branch MJ-BEN-BC-01', filters: fixed({ salesTeamKeys: ['MJ-BEN-BC-01'] }), share: 21.541, lyd: 119_867 },
  { scope: 'Branch TK-EST-BB', filters: fixed({ salesTeamKeys: ['TK-EST-BB'] }), share: 26.242, lyd: 146_028 },
  { scope: 'Salesperson Marwan Alabbar', filters: sp('Marwan Alabbar'), share: 22.487, lyd: 125_131 },
  { scope: 'Salesperson Balqeis khaled', filters: sp('Balqeis khaled'), share: 4.567, lyd: 25_411 },
  { scope: 'Salesperson Abd Nasser Khair', filters: sp('Abd Nasser Khair'), share: 0.307, lyd: 1_709 },
  { scope: 'Salesperson Hussain.elkhateb', filters: sp('Hussain.elkhateb'), share: 0, lyd: 0 },
];

/** Scopes the salesperson admin overrides (salesperson_admin_profile.segment_key_override) move on the local warehouse,
 * 2026-11-09: the scope's 2026 target (LYD) the page really uses. Islam Katch (Majaal, 892,500) is moved B2C -> B2B; no
 * branch, channel or salesperson row of the table is moved. (Hussian Makey and Mohamed Abdulhady are B2B: their wrong
 * B2B -> B2C overrides were cleared on 2026-11-09.) */
const OVERRIDE_MOVED: Record<string, number> = {
  B2B: 106_506_923 + 892_500,
  B2C: 62_657_610 - 892_500,
  'Majaal + B2C': 47_070_620 - 892_500,
};

describe.skipIf(!RUN)('Critical Number split from sales_targets.xlsx (real warehouse)', () => {
  afterAll(async () => {
    await pool.end();
  });

  it('acceptance table: share and Daily Critical Number of every scope, 2026', async () => {
    const base = criticalNumberLookup(await loadCriticalNumberHistory(pool))(DAY);
    const out: string[] = [`base active on ${DAY.toISOString().slice(0, 10)}: ${base}`, '| Scope | Expected share | Expected LYD (base 556,462) | Share | Daily Critical Number (LYD) | |', '|---|---|---|---|---|---|'];
    const failures: string[] = [];
    for (const row of ROWS) {
      const schedule = await computeDailyCriticalNumberSchedule(pool, await row.filters());
      const s = schedule.shareFor(DAY);
      const moved = OVERRIDE_MOVED[row.scope];
      const expectedShare = moved !== undefined ? (moved / TOTAL_2026) * 100 : row.share;
      // within 1 LYD of the table's value (scaled to the base active today), or of base x the moved target's share
      const expectedValue = moved !== undefined ? base * (moved / TOTAL_2026) : row.lyd * (base / ACCEPTANCE_BASE);
      const value = schedule(DAY);
      out.push(`| ${row.scope} | ${row.share.toFixed(3)}% | ${row.lyd.toLocaleString('en-US')} | ${(s.share * 100).toFixed(3)}% | ` +
        `${Math.round(value).toLocaleString('en-US')} | ${moved !== undefined ? 'moved by overrides' : ''} |`);
      if (s.shareSource !== 'current' || s.shareYear !== 2026) failures.push(`${row.scope}: share from ${s.shareSource} ${s.shareYear}`);
      if (Math.abs(s.share * 100 - expectedShare) > 0.0005) failures.push(`${row.scope}: share ${(s.share * 100).toFixed(4)}% vs ${expectedShare}%`);
      if (Math.abs(value - expectedValue) > 1) failures.push(`${row.scope}: ${value} vs ${expectedValue}`);
    }
    console.log(out.join('\n'));
    expect(failures).toEqual([]);
  });

  it("one salesperson's Yearly target to date = annual target x working days so far / 304 (base 556,462.28)", async () => {
    const filters = await sp('Marwan Alabbar')();
    const schedule = await computeDailyCriticalNumberSchedule(pool, filters);
    const yearly = await computeYearlyCounter(pool, DAY, filters, new Map(), schedule);
    const [rows] = await pool.query('SELECT SUM(Target_Revenue) AS t FROM v_sales_targets WHERE Year = 2026 AND SalespersonKey = ?', filters.salespersonKeys);
    const annual = Number((rows as { t: number }[])[0].t);
    const base = criticalNumberLookup(await loadCriticalNumberHistory(pool))(DAY);
    const viaTargets = annual * (yearly.workingDaysElapsed / 304) * (base / 556_462.28);
    console.log(`Marwan Alabbar: annual target ${annual}, working days so far ${yearly.workingDaysElapsed}, Yearly target to date ` +
      `${Math.round(yearly.expectedValue)}, annual x days / 304 = ${Math.round(viaTargets)}`);
    expect(Math.abs(yearly.expectedValue - viaTargets) / viaTargets).toBeLessThan(0.001);
  });
});
