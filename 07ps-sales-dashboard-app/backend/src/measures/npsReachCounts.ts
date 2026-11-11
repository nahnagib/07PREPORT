/**
 * NPS message reach -- the ONE read of v_process_nps_reach for the Survey Reach cards (fetchNpsReach) and the Response
 * Rate (fetchNpsResponseRate), so the cards and the rate can never disagree: Delivered + Read of the cards = the
 * rate's denominator.
 *
 * The view (migration 0071) has a row per message date x company x source:
 *   etl        fact_process_nps_message: the WhatsApp source, from NPS_REACH_START (03 Oct 2026)
 *   manual     process_nps_reach_manual, the Meta exports (13 Aug – 02 Oct; 13–31 Aug Not Delivered + Error only)
 *   estimate   process_nps_reach_manual, the approved estimates (12 Jul – 12 Aug; 13–31 Aug Delivered + Read)
 * Each manual period is spread evenly over its days (exact per period), so any date filter works. Where a manual
 * period covers a company and day, the source's own rows of that day are left out. Nothing else is ever estimated.
 */
import type { Pool } from 'mysql2/promise';
import { weekStartSql } from '../lib/businessWeek';

export type ReachSource = 'etl' | 'manual' | 'estimate';
export const REACH_SOURCES: readonly ReachSource[] = ['etl', 'manual', 'estimate'];

export interface ReachBoxes { totalReach: number; delivered: number; notDelivered: number; read: number; error: number; otherState: number }

/** A process_nps_reach_manual period of the selected companies (companies merged): the subtitle and tooltips name them. */
export interface ManualPeriod { from: string; to: string; source: 'estimate' | 'meta_manual' | 'meta_manual+estimate' }

export interface ReachCounts {
  totals: ReachBoxes;
  /** the same boxes by source; they add up to totals */
  bySource: Record<ReachSource, ReachBoxes>;
  /** per business week (Saturday, yyyy-mm-dd): Delivered, Read, Total Reach (all sources) */
  weekly: Map<string, { delivered: number; read: number; totalReach: number }>;
  /** every manual period of the companies when the range has manual reach (the subtitle names them all), else [] */
  manualPeriods: ManualPeriod[];
  /** manual or estimated messages are in the totals */
  includesManual: boolean;
}

export const zeroBoxes = (): ReachBoxes => ({ totalReach: 0, delivered: 0, notDelivered: 0, read: 0, error: 0, otherState: 0 });

const dateKey = (iso: string): number => Number(iso.replace(/-/g, ''));
const MESSAGE_DATE = "STR_TO_DATE(CAST(m.MessageDateKey AS CHAR), '%Y%m%d')";

const inCompany = (alias: string, keys: number[]) =>
  (keys.length ? ` AND ${alias}.CompanyKey IN (${keys.map(() => '?').join(', ')})` : '');

/** The first message date with reach (any source) of the companies (all of them when empty); null = none. */
export async function firstReachDate(pool: Pool, companyKeys: number[]): Promise<string | null> {
  const [rows] = await pool.query(
    `SELECT MIN(m.MessageDateKey) AS first_key FROM v_process_nps_reach m WHERE 1 = 1${inCompany('m', companyKeys)}`, companyKeys);
  const k = (rows as Record<string, unknown>[])[0]?.first_key;
  return k === null || k === undefined ? null : String(k).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
}

/** Reach of a period and companies (all of them when empty), by source and by business week. */
export async function fetchReachCounts(pool: Pool, dateFrom: string, dateTo: string, companyKeys: number[]): Promise<ReachCounts> {
  const params = [dateKey(dateFrom), dateKey(dateTo), ...companyKeys];
  const [rows] = await pool.query(
    `SELECT DATE_FORMAT(${weekStartSql(MESSAGE_DATE)}, '%Y-%m-%d') AS wk, m.source,
            SUM(m.total_reach) AS total_reach, SUM(m.delivered) AS delivered, SUM(m.not_delivered) AS not_delivered,
            SUM(m.read_count) AS read_count, SUM(m.error_count) AS error_count, SUM(m.other_state) AS other_state
       FROM v_process_nps_reach m WHERE m.MessageDateKey BETWEEN ? AND ?${inCompany('m', companyKeys)}
      GROUP BY wk, m.source`, params);
  const [periodRows] = await pool.query(
    `SELECT DISTINCT DATE_FORMAT(r.date_from, '%Y-%m-%d') AS date_from, DATE_FORMAT(r.date_to, '%Y-%m-%d') AS date_to, r.source
       FROM process_nps_reach_manual r WHERE 1 = 1${inCompany('r', companyKeys)}
      ORDER BY date_from, date_to`, companyKeys);

  const totals = zeroBoxes();
  const bySource: Record<ReachSource, ReachBoxes> = { etl: zeroBoxes(), manual: zeroBoxes(), estimate: zeroBoxes() };
  const weekly: ReachCounts['weekly'] = new Map();
  for (const r of rows as Record<string, unknown>[]) {
    const b: ReachBoxes = {
      totalReach: Number(r.total_reach ?? 0), delivered: Number(r.delivered ?? 0), notDelivered: Number(r.not_delivered ?? 0),
      read: Number(r.read_count ?? 0), error: Number(r.error_count ?? 0), otherState: Number(r.other_state ?? 0),
    };
    const src = (REACH_SOURCES as readonly string[]).includes(String(r.source)) ? (String(r.source) as ReachSource) : 'etl';
    for (const target of [totals, bySource[src]]) {
      for (const k of Object.keys(b) as (keyof ReachBoxes)[]) target[k] += b[k];
    }
    const wk = String(r.wk);
    const w = weekly.get(wk) ?? { delivered: 0, read: 0, totalReach: 0 };
    w.delivered += b.delivered;
    w.read += b.read;
    w.totalReach += b.totalReach;
    weekly.set(wk, w);
  }
  const includesManual = bySource.manual.totalReach + bySource.estimate.totalReach > 0;
  return {
    totals,
    bySource,
    weekly,
    manualPeriods: !includesManual ? [] : (periodRows as Record<string, unknown>[]).map((p) => ({
      from: String(p.date_from), to: String(p.date_to), source: String(p.source) as ManualPeriod['source'],
    })),
    includesManual,
  };
}
