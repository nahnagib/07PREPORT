import crypto from 'node:crypto';
import type { PoolConnection } from 'mysql2/promise';
import { pool } from '../db/pool';
import { ValidationError } from '../lib/errors';
import { assertSafeXlsx } from './zipGuard';
import { runParse } from './parseRunner';
import { Issue, ParseResult, ParsedRow, TableId, sanitizeText } from './parser';
import { ADAPTERS, ADAPTER_BY_ID, Adapter, FieldType, normalize, selectCurrentSql } from './tables';
import { CurrentRow, FieldChange, TableDiff, diffTable, rowOfCell } from './diff';
import { MONTHS, TABLE_LABELS, TEMPLATE_VERSION } from './templateConfig';
import { STAGED_TTL_MINUTES, cleanupExpiredStaged, removeStagedFile, stagedPath, writeStaged } from './staging';
import fs from 'node:fs';

// ---------------------------------------------------------------------------- types

export class MarcomError extends Error {
  constructor(public status: number, public code: string, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

export interface Actor { id: number }

export interface TablePreview {
  id: TableId;
  label: string;
  rowsFound: number;
  insert: number;
  update: number;
  unchanged: number;
  /** Rows with a blocking error (not classified). */
  invalid: number;
  skippedEmpty: number;
  skippedExample: number;
  updates: { rowNumber: number; key: string; changes: FieldChange[] }[];
  updatesTruncated: boolean;
}

export interface Period { from: string; to: string; label: string }

export interface Preview {
  stagedUploadId: string;
  expiresAt: string;
  filename: string;
  fileHash: string;
  templateVersion: string;
  period: Period | null;
  tables: TablePreview[];
  totals: { insert: number; update: number; unchanged: number; examplesSkipped: number };
  newBrands: string[];
  issues: Issue[];
  errorCount: number;
  warningCount: number;
  duplicateOf: { batchId: number; uploadedAt: string; uploadedBy: string | null } | null;
  requiresNewBrandConfirmation: boolean;
  nothingToImport: boolean;
  canCommit: boolean;
}

type Q = Pick<PoolConnection, 'query'>;

/** Test seam: lets the atomicity test blow up after the writes but before COMMIT. */
export const testHooks: { afterWrites?: () => void | Promise<void> } = {};

const MAX_UPDATE_DETAILS = 200;
const LOCK_NAME = 'marcom_write_lock';

// ---------------------------------------------------------------------------- small helpers

export function safeFilename(raw: string): string {
  const base = String(raw ?? '').split(/[\\/]/).pop() ?? '';
  return sanitizeText(base).slice(0, 200) || 'upload.xlsx';
}

const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

async function rows<T = Record<string, unknown>>(q: Q, sql: string, params: unknown[] = []): Promise<T[]> {
  const [r] = await q.query(sql, params);
  return r as T[];
}

export function periodLabel(from: string, to: string): string {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  if (from === to) return `${MONTHS[fm - 1]} ${fy}`;
  if (fy === ty) return `${MONTHS[fm - 1]} to ${MONTHS[tm - 1]} ${ty}`;
  return `${MONTHS[fm - 1]} ${fy} to ${MONTHS[tm - 1]} ${ty}`;
}

/** Earliest/latest year-month touched by the file's rows. */
export function computePeriod(parse: ParseResult): Period | null {
  const ym: string[] = [];
  const push = (y: unknown, m: unknown) => { if (y && m) ym.push(`${y}-${String(m).padStart(2, '0')}`); };
  for (const t of ['spend', 'social', 'web', 'trade'] as const) {
    for (const r of parse.tables[t].rows) push(r.data.year, r.data.month);
  }
  const fromDate = (d: unknown) => { if (typeof d === 'string' && d.length >= 7) ym.push(d.slice(0, 7)); };
  for (const r of parse.tables.campaigns.rows) { fromDate(r.data.startDate); fromDate(r.data.endDate); }
  for (const r of parse.tables.events.rows) fromDate(r.data.plannedDate);
  if (!ym.length) return null;
  ym.sort();
  return { from: ym[0], to: ym[ym.length - 1], label: periodLabel(ym[0], ym[ym.length - 1]) };
}

async function loadKnown(q: Q): Promise<{ brands: string[]; campaigns: string[] }> {
  const brands = (await rows<{ name: string }>(q, 'SELECT name FROM marcom_brand')).map((r) => r.name);
  const campaigns = (await rows<{ name: string }>(q, 'SELECT name FROM marcom_campaign WHERE is_current = 1')).map((r) => r.name);
  return { brands, campaigns };
}

function newBrandsOf(parse: ParseResult, known: string[]): string[] {
  const have = new Set(known.map((b) => b.toLowerCase()));
  const out = new Map<string, string>();
  for (const t of ['spend', 'campaigns', 'events'] as const) {
    for (const r of parse.tables[t].rows) {
      const b = r.data.brand;
      if (typeof b === 'string' && !have.has(b.toLowerCase()) && !out.has(b.toLowerCase())) out.set(b.toLowerCase(), b);
    }
  }
  return [...out.values()];
}

async function currentRows(q: Q, a: Adapter): Promise<CurrentRow[]> {
  return rows<CurrentRow>(q, selectCurrentSql(a));
}

/** Diffs every table of a parse against the live rows read through `q`. */
async function diffAll(q: Q, parse: ParseResult): Promise<Record<TableId, TableDiff>> {
  const invalidByTable = new Map<TableId, Set<number>>();
  for (const i of parse.issues) {
    if (i.severity !== 'error' || !i.table) continue;
    const r = rowOfCell(i.cell);
    if (r === null) continue;
    if (!invalidByTable.has(i.table)) invalidByTable.set(i.table, new Set());
    invalidByTable.get(i.table)!.add(r);
  }
  const out = {} as Record<TableId, TableDiff>;
  for (const a of ADAPTERS) {
    out[a.id] = diffTable(a, parse.tables[a.id].rows, await currentRows(q, a), invalidByTable.get(a.id));
  }
  return out;
}

async function findDuplicate(q: Q, hash: string) {
  const r = await rows<{ batch_id: number; uploaded_at: Date; display_name: string | null }>(
    q,
    `SELECT b.batch_id, b.uploaded_at, u.display_name FROM marcom_upload_batch b
       LEFT JOIN app_user u ON u.user_id = b.uploaded_by
      WHERE b.file_hash = ? AND b.status = 'SUCCESS' ORDER BY b.batch_id DESC LIMIT 1`,
    [hash],
  );
  return r[0] ?? null;
}

function buildTablePreviews(parse: ParseResult, diffs: Record<TableId, TableDiff>): TablePreview[] {
  return ADAPTERS.map((a) => {
    const d = diffs[a.id];
    const t = parse.tables[a.id];
    return {
      id: a.id,
      label: TABLE_LABELS[a.id],
      rowsFound: t.rows.length,
      insert: d.inserts.length,
      update: d.updates.length,
      unchanged: d.unchanged.length,
      invalid: d.invalid.length,
      skippedEmpty: t.emptyRows,
      skippedExample: t.exampleRowsSkipped,
      updates: d.updates.slice(0, MAX_UPDATE_DETAILS).map((u) => ({ rowNumber: u.row.rowNumber, key: u.row.key, changes: u.changes })),
      updatesTruncated: d.updates.length > MAX_UPDATE_DETAILS,
    };
  });
}

async function audit(userId: number, entityType: string, entityId: string, action: 'CREATE' | 'UPDATE', after: Record<string, unknown>) {
  try {
    await pool.query(
      'INSERT INTO audit_log (entity_type, entity_id, action, changed_by, after_value) VALUES (?, ?, ?, ?, CAST(? AS JSON))',
      [entityType, entityId, action, userId, JSON.stringify(after)],
    );
  } catch (err) {
    // The audit trail must never turn a successful action into a failure -- but never fail silently.
    // eslint-disable-next-line no-console
    console.error('[marcom] audit_log write failed:', err);
  }
}
export const auditMarcom = audit;

// ---------------------------------------------------------------------------- validate (dry run)

export async function validateUpload(input: { buffer: Buffer; filename: string; actor: Actor }): Promise<Preview> {
  const filename = safeFilename(input.filename);
  // Cheap structural/zip-bomb/size checks first -- exceljs never sees a file that fails these.
  assertSafeXlsx(input.buffer, filename);

  cleanupExpiredStaged().catch(() => undefined);

  const stagedId = crypto.randomUUID();
  const hash = sha256(input.buffer);
  const filePath = writeStaged(stagedId, input.buffer);
  try {
    const known = await loadKnown(pool);
    const parse = await runParse(filePath, filename, { knownBrands: known.brands, knownCampaigns: known.campaigns });
    const diffs = await diffAll(pool, parse);
    const dup = await findDuplicate(pool, hash);

    const issues: Issue[] = [...parse.issues];
    for (const a of ADAPTERS) {
      for (const u of diffs[a.id].updates) {
        issues.push({
          severity: 'warning', sheet: u.row.sheet, table: a.id, cell: `A${u.row.rowNumber}`, code: 'ROW_UPDATES_EXISTING',
          message: `Overwrites an existing record: ${u.changes.map((c) => `${c.field} ${c.old ?? '(empty)'} -> ${c.new ?? '(empty)'}`).join('; ')}`,
        });
      }
    }
    if (dup) {
      issues.push({
        severity: 'warning', sheet: '', table: '', cell: '', code: 'DUPLICATE_FILE',
        message: `This exact file was already imported on ${dup.uploaded_at.toISOString().slice(0, 10)}${dup.display_name ? ` by ${dup.display_name}` : ''}.`,
      });
    }
    issues.sort((x, y) => (x.severity === y.severity ? 0 : x.severity === 'error' ? -1 : 1));

    const tables = buildTablePreviews(parse, diffs);
    const totals = {
      insert: tables.reduce((n, t) => n + t.insert, 0),
      update: tables.reduce((n, t) => n + t.update, 0),
      unchanged: tables.reduce((n, t) => n + t.unchanged, 0),
      examplesSkipped: parse.exampleRowsSkipped,
    };
    const newBrands = newBrandsOf(parse, known.brands);
    const errorCount = issues.filter((i) => i.severity === 'error').length;
    const nothingToImport = totals.insert + totals.update === 0;

    const expires = await rows<{ e: Date }>(pool, 'SELECT DATE_ADD(NOW(), INTERVAL ? MINUTE) AS e', [STAGED_TTL_MINUTES]);
    const preview: Preview = {
      stagedUploadId: stagedId,
      expiresAt: expires[0].e.toISOString(),
      filename,
      fileHash: hash,
      templateVersion: parse.templateVersion,
      period: computePeriod(parse),
      tables,
      totals,
      newBrands,
      issues,
      errorCount,
      warningCount: issues.length - errorCount,
      duplicateOf: dup ? { batchId: dup.batch_id, uploadedAt: dup.uploaded_at.toISOString(), uploadedBy: dup.display_name } : null,
      requiresNewBrandConfirmation: newBrands.length > 0,
      nothingToImport,
      canCommit: errorCount === 0 && !nothingToImport,
    };

    await pool.query(
      `INSERT INTO marcom_staged_upload (staged_id, user_id, original_filename, file_hash, file_size, preview_json, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))`,
      [stagedId, input.actor.id, filename, hash, input.buffer.length, JSON.stringify(preview), STAGED_TTL_MINUTES],
    );
    await audit(input.actor.id, 'marcom_staged_upload', stagedId, 'CREATE', {
      event: 'validate', filename, fileHash: hash, errors: errorCount, insert: totals.insert, update: totals.update,
    });
    return preview;
  } catch (err) {
    removeStagedFile(stagedId);
    throw err;
  }
}

// ---------------------------------------------------------------------------- staged lookup

interface StagedRow {
  staged_id: string; user_id: number; original_filename: string; file_hash: string;
  preview_json: string | null; expired: number; consumed_at: Date | null;
}

async function loadStaged(q: Q, stagedId: string, actor: Actor, forUpdate = false): Promise<StagedRow> {
  const r = await rows<StagedRow>(
    q,
    `SELECT staged_id, user_id, original_filename, file_hash, preview_json, consumed_at, (expires_at <= NOW()) AS expired
       FROM marcom_staged_upload WHERE staged_id = ?${forUpdate ? ' FOR UPDATE' : ''}`,
    [stagedId],
  );
  const s = r[0];
  if (!s) throw new MarcomError(404, 'STAGED_NOT_FOUND', 'This upload was not found. Please upload the file again.');
  if (s.user_id !== actor.id) throw new MarcomError(403, 'STAGED_FORBIDDEN', 'This upload belongs to another user.');
  if (s.consumed_at) throw new MarcomError(409, 'STAGED_CONSUMED', 'This upload was already imported.');
  if (s.expired) throw new MarcomError(410, 'STAGED_EXPIRED', 'This upload has expired. Please upload the file again.');
  return s;
}

export async function getStagedIssues(stagedId: string, actor: Actor): Promise<Issue[]> {
  const s = await loadStaged(pool, stagedId, actor);
  const p = typeof s.preview_json === 'string' ? JSON.parse(s.preview_json) : s.preview_json;
  return (p?.issues ?? []) as Issue[];
}

// ---------------------------------------------------------------------------- locking

/** One writer at a time across commits and rollbacks (MySQL named lock on a dedicated connection). */
async function withWriteLock<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection();
  try {
    const [r] = await conn.query('SELECT GET_LOCK(?, 30) AS got', [LOCK_NAME]);
    if ((r as { got: number }[])[0]?.got !== 1) {
      throw new MarcomError(503, 'BUSY', 'Another MARCOM import is in progress. Please try again in a moment.');
    }
    try {
      return await fn(conn);
    } finally {
      await conn.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]).catch(() => undefined);
    }
  } finally {
    conn.release();
  }
}

// ---------------------------------------------------------------------------- commit

const toDb = (type: FieldType, v: unknown): string | number | null => {
  if (v === null || v === undefined || v === '') return null;
  if (type === 'int') return Number(v);
  if (type === 'money' || type === 'dec2' || type === 'pct') return normalize(type, v);
  return String(v);
};

async function insertRow(conn: Q, a: Adapter, batchId: number, data: ParsedRow['data'], brandIds: Map<string, number>) {
  const cols = a.fields.map((f) => f.col);
  const vals = a.fields.map((f) => {
    if (f.type === 'brand') {
      const id = brandIds.get(String(data[f.field]).toLowerCase());
      if (!id) throw new Error(`brand "${data[f.field]}" was not resolved`);
      return id;
    }
    return toDb(f.type, data[f.field]);
  });
  await conn.query(
    `INSERT INTO ${a.table} (${cols.join(', ')}, batch_id, is_current) VALUES (${cols.map(() => '?').join(', ')}, ?, 1)`,
    [...vals, batchId],
  );
}

export interface CommitResult {
  batchId: number;
  period: Period | null;
  totals: { inserted: number; updated: number; unchanged: number; examplesSkipped: number };
  tables: { id: TableId; label: string; inserted: number; updated: number; unchanged: number }[];
  newBrandsCreated: string[];
}

export async function commitUpload(input: { stagedUploadId: string; actor: Actor; confirmNewBrands?: boolean }): Promise<CommitResult> {
  // Cheap ownership/expiry refusals before taking the write lock.
  const pre = await loadStaged(pool, input.stagedUploadId, input.actor);
  const filePath = stagedPath(pre.staged_id);
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch {
    throw new MarcomError(410, 'STAGED_EXPIRED', 'The staged file is no longer available. Please upload the file again.');
  }
  if (sha256(buffer) !== pre.file_hash) {
    throw new MarcomError(409, 'FILE_CHANGED', 'The staged file changed since validation. Please upload the file again.');
  }

  let result: CommitResult;
  try {
    result = await withWriteLock(async (conn) => {
      await conn.beginTransaction();
      try {
        // Re-check under the lock and the row lock: another commit may have consumed it meanwhile.
        await loadStaged(conn, pre.staged_id, input.actor, true);

        const known = await loadKnown(conn);
        const parse = await runParse(filePath, pre.original_filename, { knownBrands: known.brands, knownCampaigns: known.campaigns });
        const errors = parse.issues.filter((i) => i.severity === 'error');
        if (errors.length) {
          throw new MarcomError(422, 'BLOCKING_ERRORS', `The file has ${errors.length} blocking error(s) and cannot be imported.`, { issues: errors });
        }
        const newBrands = newBrandsOf(parse, known.brands);
        if (newBrands.length && !input.confirmNewBrands) {
          throw new MarcomError(409, 'NEW_BRANDS_UNCONFIRMED', 'New brand names were found. Confirm them (confirmNewBrands) to create them.', { newBrands });
        }
        const diffs = await diffAll(conn, parse);
        const period = computePeriod(parse);
        const inserted = ADAPTERS.reduce((n, a) => n + diffs[a.id].inserts.length, 0);
        const updated = ADAPTERS.reduce((n, a) => n + diffs[a.id].updates.length, 0);
        const unchanged = ADAPTERS.reduce((n, a) => n + diffs[a.id].unchanged.length, 0);

        const [ins] = await conn.query(
          `INSERT INTO marcom_upload_batch (filename, file_hash, template_version, uploaded_by, status, period_from, period_to, original_file)
           VALUES (?, ?, ?, ?, 'SUCCESS', ?, ?, ?)`,
          [pre.original_filename, pre.file_hash, TEMPLATE_VERSION, input.actor.id,
            period ? `${period.from}-01` : null, period ? `${period.to}-01` : null, buffer],
        );
        const batchId = (ins as { insertId: number }).insertId;

        for (const b of newBrands) {
          await conn.query('INSERT INTO marcom_brand (name, created_batch_id) VALUES (?, ?)', [b, batchId]);
        }
        const brandIds = new Map<string, number>();
        for (const r of await rows<{ brand_id: number; name: string }>(conn, 'SELECT brand_id, name FROM marcom_brand')) {
          brandIds.set(r.name.toLowerCase(), r.brand_id);
        }

        for (const a of ADAPTERS) {
          const d = diffs[a.id];
          for (const u of d.updates) {
            const [res] = await conn.query(
              `UPDATE ${a.table} SET is_current = NULL, superseded_by_batch = ? WHERE id = ? AND is_current = 1`,
              [batchId, u.existingId],
            );
            if ((res as { affectedRows: number }).affectedRows !== 1) throw new Error(`stale row in ${a.table}`);
            await insertRow(conn, a, batchId, u.row.data, brandIds);
          }
          for (const r of d.inserts) await insertRow(conn, a, batchId, r.data, brandIds);
        }

        const tables = ADAPTERS.map((a) => ({
          id: a.id, label: TABLE_LABELS[a.id],
          inserted: diffs[a.id].inserts.length, updated: diffs[a.id].updates.length, unchanged: diffs[a.id].unchanged.length,
        }));
        const summary = {
          templateVersion: parse.templateVersion,
          changed: inserted + updated > 0,
          totals: { inserted, updated, unchanged, examplesSkipped: parse.exampleRowsSkipped },
          tables,
          period,
          newBrands,
          warnings: parse.issues.filter((i) => i.severity === 'warning').slice(0, 500),
        };
        await conn.query('UPDATE marcom_upload_batch SET summary_json = ? WHERE batch_id = ?', [JSON.stringify(summary), batchId]);
        await conn.query('UPDATE marcom_staged_upload SET consumed_at = NOW() WHERE staged_id = ?', [pre.staged_id]);

        if (testHooks.afterWrites) await testHooks.afterWrites();
        await conn.commit();
        return { batchId, period, totals: summary.totals, tables, newBrandsCreated: newBrands } as CommitResult;
      } catch (err) {
        await conn.rollback().catch(() => undefined);
        throw err;
      }
    });
  } catch (err) {
    if (!(err instanceof MarcomError) && !(err instanceof ValidationError)) {
      // Unexpected failure after validation: keep a FAILED batch row for the history (no file blob).
      await pool.query(
        `INSERT INTO marcom_upload_batch (filename, file_hash, template_version, uploaded_by, status, error_message)
         VALUES (?, ?, ?, ?, 'FAILED', ?)`,
        [pre.original_filename, pre.file_hash, TEMPLATE_VERSION, input.actor.id, String((err as Error).message ?? err).slice(0, 500)],
      ).catch(() => undefined);
    }
    throw err;
  }

  removeStagedFile(pre.staged_id);
  await audit(input.actor.id, 'marcom_upload_batch', String(result.batchId), 'CREATE', {
    event: 'commit', filename: pre.original_filename, fileHash: pre.file_hash, ...result.totals,
  });
  return result;
}

// ---------------------------------------------------------------------------- rollback

export async function rollbackBatch(input: { batchId: number; actor: Actor; reason: string }): Promise<{ batchId: number }> {
  const reason = sanitizeText(String(input.reason ?? '')).slice(0, 500);
  if (reason.length < 3) throw new MarcomError(400, 'REASON_REQUIRED', 'A reason (at least 3 characters) is required to roll back a batch.');

  await withWriteLock(async (conn) => {
    await conn.beginTransaction();
    try {
      const b = (await rows<{ batch_id: number; status: string }>(conn, 'SELECT batch_id, status FROM marcom_upload_batch WHERE batch_id = ? FOR UPDATE', [input.batchId]))[0];
      if (!b) throw new MarcomError(404, 'BATCH_NOT_FOUND', 'Batch not found.');
      if (b.status !== 'SUCCESS') throw new MarcomError(409, 'NOT_ROLLBACKABLE', `Only successful batches can be rolled back (this one is ${b.status}).`);
      const latest = (await rows<{ id: number }>(conn, "SELECT MAX(batch_id) AS id FROM marcom_upload_batch WHERE status = 'SUCCESS'"))[0]?.id;
      if (latest !== input.batchId) {
        throw new MarcomError(409, 'NOT_LATEST', 'Only the latest successful batch can be rolled back.', { latestBatchId: latest });
      }

      for (const a of ADAPTERS) {
        // 1) remove what this batch inserted (frees the unique "current" slot), 2) re-arm what it superseded.
        await conn.query(`DELETE FROM ${a.table} WHERE batch_id = ?`, [input.batchId]);
        await conn.query(`UPDATE ${a.table} SET is_current = 1, superseded_by_batch = NULL WHERE superseded_by_batch = ?`, [input.batchId]);
      }
      // Brands this batch created that nothing else references any more.
      await conn.query(
        `DELETE FROM marcom_brand WHERE created_batch_id = ?
           AND NOT EXISTS (SELECT 1 FROM marcom_spend_monthly x WHERE x.brand_id = marcom_brand.brand_id)
           AND NOT EXISTS (SELECT 1 FROM marcom_campaign x WHERE x.brand_id = marcom_brand.brand_id)
           AND NOT EXISTS (SELECT 1 FROM marcom_event x WHERE x.brand_id = marcom_brand.brand_id)`,
        [input.batchId],
      );
      await conn.query(
        `UPDATE marcom_upload_batch SET status = 'ROLLED_BACK', rolled_back_by = ?, rolled_back_at = NOW(), rollback_reason = ? WHERE batch_id = ?`,
        [input.actor.id, reason, input.batchId],
      );
      await conn.commit();
    } catch (err) {
      await conn.rollback().catch(() => undefined);
      throw err;
    }
  });
  await audit(input.actor.id, 'marcom_upload_batch', String(input.batchId), 'UPDATE', { event: 'rollback', reason });
  return { batchId: input.batchId };
}

// ---------------------------------------------------------------------------- history

export interface BatchListItem {
  batchId: number;
  filename: string;
  fileHash: string;
  templateVersion: string;
  uploadedBy: { id: number | null; name: string | null };
  uploadedAt: string;
  status: 'SUCCESS' | 'FAILED' | 'ROLLED_BACK';
  period: Period | null;
  totals: { inserted: number; updated: number; unchanged: number; examplesSkipped: number } | null;
  canRollback: boolean;
  rolledBackAt: string | null;
  rolledBackBy: string | null;
  rollbackReason: string | null;
  errorMessage: string | null;
}

type BatchRow = {
  batch_id: number; filename: string; file_hash: string; template_version: string; uploaded_by: number | null;
  uploader: string | null; uploaded_at: Date; status: BatchListItem['status']; summary_json: unknown;
  pf: string | null; pt: string | null; rolled_back_at: Date | null; rollbacker: string | null; rollback_reason: string | null;
  error_message: string | null;
};

const BATCH_SELECT = `SELECT b.batch_id, b.filename, b.file_hash, b.template_version, b.uploaded_by, u.display_name AS uploader,
    b.uploaded_at, b.status, b.summary_json, DATE_FORMAT(b.period_from, '%Y-%m') AS pf, DATE_FORMAT(b.period_to, '%Y-%m') AS pt,
    b.rolled_back_at, ru.display_name AS rollbacker, b.rollback_reason, b.error_message
  FROM marcom_upload_batch b
  LEFT JOIN app_user u ON u.user_id = b.uploaded_by
  LEFT JOIN app_user ru ON ru.user_id = b.rolled_back_by`;

const parseJson = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v) as Record<string, any> | null;

function toItem(r: BatchRow, latestSuccess: number | null): BatchListItem {
  const s = parseJson(r.summary_json);
  return {
    batchId: r.batch_id, filename: r.filename, fileHash: r.file_hash, templateVersion: r.template_version,
    uploadedBy: { id: r.uploaded_by, name: r.uploader },
    uploadedAt: r.uploaded_at.toISOString(), status: r.status,
    period: r.pf && r.pt ? { from: r.pf, to: r.pt, label: periodLabel(r.pf, r.pt) } : null,
    totals: s?.totals ?? null,
    canRollback: r.status === 'SUCCESS' && r.batch_id === latestSuccess,
    rolledBackAt: r.rolled_back_at ? r.rolled_back_at.toISOString() : null,
    rolledBackBy: r.rollbacker, rollbackReason: r.rollback_reason, errorMessage: r.error_message,
  };
}

async function latestSuccessId(q: Q): Promise<number | null> {
  return (await rows<{ id: number | null }>(q, "SELECT MAX(batch_id) AS id FROM marcom_upload_batch WHERE status = 'SUCCESS'"))[0]?.id ?? null;
}

export async function listBatches(page: number, pageSize: number) {
  const p = Math.max(1, page | 0 || 1);
  const size = Math.min(100, Math.max(1, pageSize | 0 || 25));
  const latest = await latestSuccessId(pool);
  const list = await rows<BatchRow>(pool, `${BATCH_SELECT} ORDER BY b.batch_id DESC LIMIT ? OFFSET ?`, [size, (p - 1) * size]);
  const total = (await rows<{ n: number }>(pool, 'SELECT COUNT(*) AS n FROM marcom_upload_batch'))[0].n;
  return { rows: list.map((r) => toItem(r, latest)), total, page: p, pageSize: size };
}

export async function getBatch(batchId: number) {
  const r = (await rows<BatchRow>(pool, `${BATCH_SELECT} WHERE b.batch_id = ?`, [batchId]))[0];
  if (!r) throw new MarcomError(404, 'BATCH_NOT_FOUND', 'Batch not found.');
  const s = parseJson(r.summary_json);
  return { ...toItem(r, await latestSuccessId(pool)), tables: s?.tables ?? [], warnings: s?.warnings ?? [], newBrands: s?.newBrands ?? [] };
}

export async function getBatchFile(batchId: number): Promise<{ buffer: Buffer; filename: string }> {
  const r = (await rows<{ original_file: Buffer | null }>(pool, 'SELECT original_file FROM marcom_upload_batch WHERE batch_id = ?', [batchId]))[0];
  if (!r?.original_file) throw new MarcomError(404, 'FILE_NOT_FOUND', 'The original file is not available for this batch.');
  return { buffer: r.original_file, filename: `MARCOM_upload_batch_${batchId}.xlsx` };
}

// ---------------------------------------------------------------------------- freshness

export async function getFreshness() {
  const latest = (await rows<{ y: number | null; m: number | null }>(
    pool,
    `SELECT MAX(ym) DIV 100 AS y, MAX(ym) MOD 100 AS m FROM (
       SELECT MAX(year * 100 + month) AS ym FROM marcom_spend_monthly WHERE is_current = 1
       UNION ALL SELECT MAX(year * 100 + month) FROM marcom_social_monthly WHERE is_current = 1
       UNION ALL SELECT MAX(year * 100 + month) FROM marcom_web_monthly WHERE is_current = 1
       UNION ALL SELECT MAX(year * 100 + month) FROM marcom_trade_monthly WHERE is_current = 1
     ) t`,
  ))[0];
  const b = (await rows<{ batch_id: number; uploaded_at: Date; uploader: string | null }>(
    pool,
    `SELECT b.batch_id, b.uploaded_at, u.display_name AS uploader FROM marcom_upload_batch b
       LEFT JOIN app_user u ON u.user_id = b.uploaded_by
      WHERE b.status = 'SUCCESS' AND JSON_EXTRACT(b.summary_json, '$.changed') = true
      ORDER BY b.batch_id DESC LIMIT 1`,
  ))[0];
  if (!b) return { hasData: false as const };
  const period = latest?.y && latest?.m ? { year: latest.y, month: latest.m, label: `${MONTHS[latest.m - 1]} ${latest.y}` } : null;
  return { hasData: true as const, latestPeriod: period, uploadedBy: b.uploader, uploadedAt: b.uploaded_at.toISOString(), batchId: b.batch_id };
}
