import type { PoolConnection } from 'mysql2/promise';
import { ADAPTERS, Adapter, keyOf } from './tables';
import { TABLE_LABELS } from './templateConfig';
import type { TableId } from './parser';

/**
 * Removing ONE upload batch from the append-only MARCOM tables (0022: a live row has is_current = 1; a row replaced by a
 * later batch has is_current = NULL and superseded_by_batch = that batch). Used by "Remove batch" (any successful batch)
 * and by "Roll back latest batch" (the same thing for the newest batch, where no later batch exists).
 *
 * Per table, for the removed batch B:
 *   a. every row B inserted is deleted -- current or not -- unless (c2) below hands it over to a later batch;
 *   b. a row of B that a LATER batch superseded (same natural key): the later row stays current and is not touched; only
 *      B's old version is deleted. Nothing points from the later row to B's row (the link is superseded_by_batch on the
 *      OLD row), so no dangling link is left;
 *   c. rows of an EARLIER batch that B superseded (superseded_by_batch = B):
 *        c1. B's row for that key is still current  -> the earlier row is re-armed (current again, link cleared), as the
 *            rollback always did;
 *        c2. a later batch re-stated B's row unchanged (the later file holds the same key and values, so commit wrote
 *            nothing) -> B's row is handed over to the EARLIEST such later batch (batch_id = that batch) instead of being
 *            deleted, so the later batch keeps the data it uploaded; the earlier row then points at that batch;
 *        c3. a later batch superseded B's row -> the earlier row stays history and now points at that later batch, so a
 *            future rollback / removal of that later batch re-arms the right row.
 *   d. brands B created: deleted when no remaining row of any table uses them; otherwise kept (and re-owned by the
 *      earliest batch that still uses them, so removing THAT batch can clean them up later).
 */

type Q = Pick<PoolConnection, 'query'>;

export interface DbRow {
  id: number;
  batch: number;
  current: boolean;
  supersededBy: number | null;
  key: string;
  label: string;
}

export interface KeyRef { key: string; label: string }
export interface TablePlan {
  id: TableId;
  label: string;
  /** B's rows that are deleted (current + superseded) */
  deleteIds: number[];
  deletedCurrent: number;
  /** B's rows a later batch had superseded: only B's old version goes, the later row stays current */
  deletedSuperseded: (KeyRef & { supersededBy: number })[];
  /** B's current rows a later batch re-stated unchanged: handed over to that batch (kept, not deleted) */
  handedOver: (KeyRef & { id: number; toBatch: number })[];
  /** earlier batches' rows made current again */
  rearm: (KeyRef & { id: number; batch: number })[];
  /** earlier batches' history rows re-linked from B to the batch that now replaces them */
  relink: (KeyRef & { id: number; batch: number; toBatch: number })[];
}

export interface BrandPlan {
  deleted: { id: number; name: string }[];
  kept: { id: number; name: string; usedBy: number[] }[];
}

export interface RemovalPlan {
  batchId: number;
  tables: TablePlan[];
  brands: BrandPlan;
}

/** later batch id -> natural keys (keyOf) per table found in its file */
export type LaterKeys = Map<number, Partial<Record<TableId, Set<string>>>>;

const BRAND_TABLES = ADAPTERS.filter((a) => a.fields.some((f) => f.type === 'brand'));

function rowsSql(a: Adapter, where: string): string {
  const hasBrand = a.fields.some((x) => x.type === 'brand');
  const cols = a.keyFields.map((k) => {
    const x = a.fields.find((f) => f.field === k)!;
    if (x.type === 'brand') return 'b.name AS `brand`';
    if (x.type === 'date') return `DATE_FORMAT(t.${x.col}, '%Y-%m-%d') AS \`${x.field}\``;
    return `t.${x.col} AS \`${x.field}\``;
  });
  return `SELECT t.id, t.batch_id, t.is_current, t.superseded_by_batch, ${cols.join(', ')} FROM ${a.table} t ` +
    `${hasBrand ? 'JOIN marcom_brand b ON b.brand_id = t.brand_id ' : ''}WHERE ${where}`;
}

/** "2026-03 · Brand A" style label of a natural key. */
export function keyLabel(a: Adapter, data: Record<string, unknown>): string {
  const d = { ...data };
  if (d.year !== undefined && d.month !== undefined) {
    const ym = `${d.year}-${String(d.month).padStart(2, '0')}`;
    return [ym, ...a.keyFields.filter((k) => k !== 'year' && k !== 'month').map((k) => String(d[k] ?? ''))].join(' · ');
  }
  return a.keyFields.map((k) => String(d[k] ?? '')).join(' · ');
}

async function read(q: Q, a: Adapter, where: string, params: unknown[]): Promise<DbRow[]> {
  const [r] = await q.query(rowsSql(a, where), params);
  return (r as Record<string, unknown>[]).map((x) => ({
    id: Number(x.id),
    batch: Number(x.batch_id),
    current: Number(x.is_current) === 1,
    supersededBy: x.superseded_by_batch === null || x.superseded_by_batch === undefined ? null : Number(x.superseded_by_batch),
    key: keyOf(a, x),
    label: keyLabel(a, x),
  }));
}

/**
 * Pure planning of one table from B's rows, the rows B superseded and the later batches' file keys (sorted by batch id).
 * Exported for unit tests.
 */
export function planTable(a: Adapter, own: DbRow[], earlier: DbRow[], laterKeys: LaterKeys, currentOthers: Map<string, DbRow>): TablePlan {
  const plan: TablePlan = { id: a.id, label: TABLE_LABELS[a.id], deleteIds: [], deletedCurrent: 0, deletedSuperseded: [], handedOver: [], rearm: [], relink: [] };
  const laterIds = [...laterKeys.keys()].sort((x, y) => x - y);
  const ownByKey = new Map<string, { row: DbRow; handedTo: number | null }>();
  for (const r of own) {
    let handedTo: number | null = null;
    if (r.current) handedTo = laterIds.find((id) => laterKeys.get(id)?.[a.id]?.has(r.key)) ?? null;
    ownByKey.set(r.key, { row: r, handedTo });
    if (handedTo !== null) {
      plan.handedOver.push({ id: r.id, key: r.key, label: r.label, toBatch: handedTo });
      continue;
    }
    plan.deleteIds.push(r.id);
    if (r.current) plan.deletedCurrent += 1;
    else if (r.supersededBy !== null) plan.deletedSuperseded.push({ key: r.key, label: r.label, supersededBy: r.supersededBy });
  }
  for (const e of earlier) {
    const mine = ownByKey.get(e.key);
    let toBatch: number | null;
    if (mine) toBatch = mine.handedTo ?? (mine.row.current ? null : mine.row.supersededBy);
    else toBatch = currentOthers.get(e.key)?.batch ?? null; // B has no row for the key (should not happen): follow the live row
    if (toBatch === null) plan.rearm.push({ id: e.id, key: e.key, label: e.label, batch: e.batch });
    else plan.relink.push({ id: e.id, key: e.key, label: e.label, batch: e.batch, toBatch });
  }
  return plan;
}

/** Reads everything the plan needs for batch B through `q` (inside the write transaction for a real removal). */
export async function planRemoval(q: Q, batchId: number, laterKeys: LaterKeys): Promise<RemovalPlan> {
  const tables: TablePlan[] = [];
  for (const a of ADAPTERS) {
    const own = await read(q, a, 't.batch_id = ?', [batchId]);
    const earlier = await read(q, a, 't.superseded_by_batch = ?', [batchId]);
    const others = new Map<string, DbRow>();
    if (earlier.length) for (const r of await read(q, a, 't.is_current = 1 AND t.batch_id <> ?', [batchId])) others.set(r.key, r);
    tables.push(planTable(a, own, earlier, laterKeys, others));
  }
  // brands B created: still used by a row that stays?
  const deleted = new Set(tables.flatMap((t) => t.deleteIds.map((id) => `${t.id}:${id}`)));
  const [created] = await q.query('SELECT brand_id, name FROM marcom_brand WHERE created_batch_id = ? ORDER BY name', [batchId]);
  const brands: BrandPlan = { deleted: [], kept: [] };
  for (const b of created as { brand_id: number; name: string }[]) {
    const usedBy = new Set<number>();
    for (const a of BRAND_TABLES) {
      const [refs] = await q.query(`SELECT id, batch_id FROM ${a.table} WHERE brand_id = ?`, [b.brand_id]);
      const handed = new Map(tables.find((t) => t.id === a.id)!.handedOver.map((h) => [h.id, h.toBatch]));
      for (const r of refs as { id: number; batch_id: number }[]) {
        if (deleted.has(`${a.id}:${r.id}`)) continue;
        usedBy.add(handed.get(Number(r.id)) ?? Number(r.batch_id));
      }
    }
    if (usedBy.size) brands.kept.push({ id: b.brand_id, name: b.name, usedBy: [...usedBy].sort((x, y) => x - y) });
    else brands.deleted.push({ id: b.brand_id, name: b.name });
  }
  return { batchId, tables, brands };
}

const chunks = <T,>(xs: T[], n = 500): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** Applies a plan (inside the caller's transaction, under the MARCOM write lock). */
export async function applyRemoval(q: Q, plan: RemovalPlan): Promise<void> {
  for (const t of plan.tables) {
    const table = ADAPTERS.find((a) => a.id === t.id)!.table;
    for (const h of t.handedOver) await q.query(`UPDATE ${table} SET batch_id = ? WHERE id = ?`, [h.toBatch, h.id]);
    // delete before re-arming: the deleted current row frees the unique (key, is_current = 1) slot
    for (const ids of chunks(t.deleteIds)) await q.query(`DELETE FROM ${table} WHERE id IN (?)`, [ids]);
    for (const ids of chunks(t.rearm.map((r) => r.id))) {
      await q.query(`UPDATE ${table} SET is_current = 1, superseded_by_batch = NULL WHERE id IN (?)`, [ids]);
    }
    for (const r of t.relink) await q.query(`UPDATE ${table} SET superseded_by_batch = ? WHERE id = ?`, [r.toBatch, r.id]);
  }
  for (const b of plan.brands.deleted) {
    await q.query(
      `DELETE FROM marcom_brand WHERE brand_id = ?
         ${BRAND_TABLES.map((a) => `AND NOT EXISTS (SELECT 1 FROM ${a.table} x WHERE x.brand_id = marcom_brand.brand_id)`).join(' ')}`,
      [b.id],
    );
  }
  for (const b of plan.brands.kept) await q.query('UPDATE marcom_brand SET created_batch_id = ? WHERE brand_id = ?', [b.usedBy[0], b.id]);
}

/** Per-table counts for the audit log and the API response. */
export function planCounts(plan: RemovalPlan) {
  return Object.fromEntries(plan.tables.map((t) => [t.id, {
    deleted: t.deleteIds.length, deletedCurrent: t.deletedCurrent, deletedSuperseded: t.deletedSuperseded.length,
    handedOver: t.handedOver.length, rearmed: t.rearm.length, relinked: t.relink.length,
  }]));
}
