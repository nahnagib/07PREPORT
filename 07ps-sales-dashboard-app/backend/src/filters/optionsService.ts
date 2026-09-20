import { RowDataPacket } from 'mysql2';
import { pool } from '../db/pool';
import { Combo, DIMENSIONS, Dimension, Selection, computeCascade } from './cascade';

/**
 * Backs GET /filters/options: loads (and caches) the distinct dimension combinations in the sales
 * data for a date window, then lets cascade.ts cross-filter them.
 *
 * Company / customer / salesperson come straight from Fact_SalesLines. Customer Group, Distribution
 * Channel and Branch are resolved through salesperson_admin_profile with EXACTLY the expressions
 * measures/filters.ts uses to filter every report (effectiveSegmentExpr / effectiveChannelExpr /
 * effectiveSalesTeamExpr, restated here as a JOIN instead of a correlated subquery -- same COALESCE
 * order, ~2x faster for a full scan). That is what keeps an option offered here and the rows a
 * dashboard query returns for it the same set. Keep in sync if those expressions ever change.
 *
 * Company deliberately uses the row's real CompanyKey (as measures/filters.ts does), not the
 * admin-assigned salesperson/team company the older per-dimension endpoints used: with the latter,
 * a salesperson could be offered under Majaal while every Majaal report excluded their rows.
 */

/** Cached combos are keyed by date window + the last successful ETL run, so a fresh ETL load is
 * picked up immediately (in any process -- the ETL worker is a separate one); the TTL covers admin
 * edits to override/name tables, which have no such signal. */
const CACHE_TTL_MS = 60_000;
const ETL_STAMP_TTL_MS = 10_000;
const MAX_CACHE_ENTRIES = 24;

interface CacheEntry<T> {
  expires: number;
  value: Promise<T>;
}

const combosCache = new Map<string, CacheEntry<Combo[]>>();
let namesCache: CacheEntry<NameMaps> | null = null;
let etlStamp: { expires: number; value: string } | null = null;

export function clearFilterOptionsCache(): void {
  combosCache.clear();
  namesCache = null;
  etlStamp = null;
}

async function getEtlStamp(): Promise<string> {
  if (etlStamp && etlStamp.expires > Date.now()) return etlStamp.value;
  let value = 'none';
  try {
    const [rows] = await pool.query<RowDataPacket[]>(`SELECT MAX(finished_at) AS s FROM etl_job_runs WHERE status = 'success'`);
    value = rows[0]?.s ? new Date(rows[0].s).toISOString() : 'none';
  } catch {
    // etl_job_runs missing (fresh dev DB) -- just fall back to TTL-only caching.
  }
  etlStamp = { expires: Date.now() + ETL_STAMP_TTL_MS, value };
  return value;
}

function cached<T>(map: Map<string, CacheEntry<T>>, key: string, load: () => Promise<T>): Promise<T> {
  const hit = map.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = load();
  // A failed load must not be cached.
  value.catch(() => map.delete(key));
  map.set(key, { expires: Date.now() + CACHE_TTL_MS, value });
  if (map.size > MAX_CACHE_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  return value;
}

export interface DateWindow {
  from: string | null; // inclusive, YYYY-MM-DD
  to: string | null;
}

async function loadCombos(window: DateWindow): Promise<Combo[]> {
  const params: string[] = [];
  let dateClause = '';
  if (window.from) {
    dateClause += ' AND dd.Date >= ?';
    params.push(window.from);
  }
  if (window.to) {
    dateClause += ' AND dd.Date <= ?';
    params.push(window.to);
  }
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT DISTINCT
        fsl.CompanyKey AS co,
        COALESCE(sap.segment_key_override, fsl.SegmentKey) AS sg,
        COALESCE(
          sap.channel_key_override,
          CASE
            WHEN fsl.ChannelKey <> 1 THEN fsl.ChannelKey
            WHEN COALESCE(sap.segment_key_override, fsl.SegmentKey) IN (2, 3) THEN 3
            WHEN COALESCE(sap.segment_key_override, fsl.SegmentKey) IN (1, 4) THEN 2
            ELSE 1
          END
        ) AS ch,
        COALESCE(sap.sales_team_key_override, fsl.SalesTeamKey) AS tm,
        fsl.SalespersonKey AS sp,
        fsl.CustomerKey AS cu
     FROM Fact_SalesLines fsl
     JOIN Dim_Date dd ON dd.DateKey = fsl.DateKey
     LEFT JOIN salesperson_admin_profile sap ON sap.salesperson_key = fsl.SalespersonKey
     WHERE 1 = 1${dateClause}`,
    params,
  );
  const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
  return rows.map((r) => ({
    companyKeys: str(r.co),
    segmentKeys: str(r.sg),
    channelKeys: str(r.ch),
    salesTeamKeys: str(r.tm),
    salespersonKeys: str(r.sp),
    customerKeys: str(r.cu),
  }));
}

interface NamedOption {
  key: string;
  row: Record<string, string | number | null>;
}
type NameMaps = Record<Dimension, Map<string, NamedOption>>;

/** Display rows per dimension, already in display order (Map preserves insertion order). Same
 * source tables and response field names as the older per-dimension /filters/* endpoints. Rows
 * that are inactive/unlinked in the admin reference-data tables are simply absent, so they can
 * never be offered. */
async function loadNames(): Promise<NameMaps> {
  const maps: NameMaps = {
    companyKeys: new Map(),
    segmentKeys: new Map(),
    channelKeys: new Map(),
    salesTeamKeys: new Map(),
    salespersonKeys: new Map(),
    customerKeys: new Map(),
  };
  const q = async (sql: string) => (await pool.query<RowDataPacket[]>(sql))[0];
  const [companies, groups, channels, teams, people, customers] = await Promise.all([
    q(`SELECT etl_company_key AS k, name FROM admin_company WHERE is_active = 1 AND etl_company_key IS NOT NULL ORDER BY display_order, name`),
    q(`SELECT etl_segment_key AS k, name FROM admin_customer_group WHERE is_active = 1 AND etl_segment_key IS NOT NULL ORDER BY display_order, name`),
    q(`SELECT etl_channel_key AS k, name FROM admin_distribution_channel WHERE is_active = 1 AND etl_channel_key IS NOT NULL ORDER BY display_order, name`),
    q(`SELECT st.SalesTeamKey AS k, COALESCE(stap.team_name_override, st.SalesTeam) AS name, st.SalesCity AS city
       FROM Dim_SalesTeam st LEFT JOIN sales_team_admin_profile stap ON stap.sales_team_key = st.SalesTeamKey ORDER BY st.SalesTeam`),
    q(`SELECT ds.SalespersonKey AS k, COALESCE(sap.admin_name_override, ds.salesperson) AS name
       FROM Dim_Salesperson ds LEFT JOIN salesperson_admin_profile sap ON sap.salesperson_key = ds.SalespersonKey ORDER BY ds.salesperson`),
    q(`SELECT CustomerKey AS k, customer AS name FROM Dim_Customer ORDER BY customer`),
  ]);
  const fill = (dim: Dimension, rows: RowDataPacket[], build: (r: RowDataPacket) => Record<string, string | number | null>) => {
    for (const r of rows) maps[dim].set(String(r.k), { key: String(r.k), row: build(r) });
  };
  fill('companyKeys', companies, (r) => ({ company_key: Number(r.k), company_name: r.name }));
  fill('segmentKeys', groups, (r) => ({ segment_key: Number(r.k), segment_name: r.name }));
  fill('channelKeys', channels, (r) => ({ channel_key: Number(r.k), channel_name: r.name }));
  fill('salesTeamKeys', teams, (r) => ({ sales_team_key: String(r.k), sales_team_name: r.name, city: r.city ?? null }));
  fill('salespersonKeys', people, (r) => ({ salesperson_key: Number(r.k), salesperson_name: r.name }));
  fill('customerKeys', customers, (r) => ({ customer_key: Number(r.k), customer_name: r.name ?? `Customer ${r.k}` }));
  return maps;
}

export interface FilterOptionsResult {
  /** The request's selection after dropping values that are no longer valid (keys typed as the
   * dashboard's Filters: numbers, except salesTeamKeys which are strings). */
  filters: {
    companyKeys: number[];
    segmentKeys: number[];
    channelKeys: number[];
    salesTeamKeys: string[];
    salespersonKeys: number[];
    customerKeys: number[];
  };
  options: {
    businessUnits: Array<Record<string, string | number | null>>;
    customerGroups: Array<Record<string, string | number | null>>;
    distributionChannels: Array<Record<string, string | number | null>>;
    branches: Array<Record<string, string | number | null>>;
    salespersons: Array<Record<string, string | number | null>>;
    customers: Array<Record<string, string | number | null>>;
  };
  /** False when the selected filters together match no sales data at all. */
  hasData: boolean;
}

const OPTION_KEYS: Array<[keyof FilterOptionsResult['options'], Dimension]> = [
  ['businessUnits', 'companyKeys'],
  ['customerGroups', 'segmentKeys'],
  ['distributionChannels', 'channelKeys'],
  ['branches', 'salesTeamKeys'],
  ['salespersons', 'salespersonKeys'],
  ['customers', 'customerKeys'],
];

export async function getFilterOptions(
  window: DateWindow,
  selection: Selection,
  scope: Partial<Selection>,
): Promise<FilterOptionsResult> {
  const stamp = await getEtlStamp();
  const [combos, names] = await Promise.all([
    cached(combosCache, `${window.from ?? ''}|${window.to ?? ''}|${stamp}`, () => loadCombos(window)),
    (() => {
      if (!namesCache || namesCache.expires <= Date.now()) {
        const value = loadNames();
        value.catch(() => {
          namesCache = null;
        });
        namesCache = { expires: Date.now() + CACHE_TTL_MS, value };
      }
      return namesCache.value;
    })(),
  ]);

  const result = computeCascade(combos, selection, scope);

  const options = {} as FilterOptionsResult['options'];
  for (const [outKey, dim] of OPTION_KEYS) {
    // Iterating the name map (not the valid set) keeps admin display order and drops any value
    // with no active/linked name row.
    const rows: Array<Record<string, string | number | null>> = [];
    for (const [key, named] of names[dim]) if (result.options[dim].has(key)) rows.push(named.row);
    options[outKey] = rows;
  }

  const num = (vs: string[]) => vs.map(Number);
  const known = (dim: Dimension, vs: string[]) => vs.filter((v) => names[dim].has(v));
  return {
    filters: {
      companyKeys: num(known('companyKeys', result.selection.companyKeys)),
      segmentKeys: num(known('segmentKeys', result.selection.segmentKeys)),
      channelKeys: num(known('channelKeys', result.selection.channelKeys)),
      salesTeamKeys: known('salesTeamKeys', result.selection.salesTeamKeys),
      salespersonKeys: num(known('salespersonKeys', result.selection.salespersonKeys)),
      customerKeys: num(known('customerKeys', result.selection.customerKeys)),
    },
    options,
    hasData: result.matchingCombos > 0,
  };
}

export { DIMENSIONS };
