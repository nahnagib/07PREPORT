import ExcelJS from 'exceljs';
import { pool } from '../db/pool';
import { writeAuditLog } from './auditLogService';
import {
  KAIZEN_CARD_ENTITY,
  KaizenValidationError,
  insertCardValues,
  listDropdownValues,
  validateCardValues,
  type CardInput,
  type CardValues,
  type KaizenListKey,
} from './kaizenService';

/**
 * One-time import of the Kaizen cards that existed before the app (Admin only). Two steps, like the
 * MARCOM upload: a dry run that reports every problem row, then a commit that re-validates and
 * inserts everything in one transaction -- or nothing, if any row is invalid.
 *
 *   - Headers are matched by name (English or Arabic, case/spacing-insensitive), in any order.
 *   - Department / Card Type / Card Priority text must match an existing value's English or Arabic
 *     label (inactive values included, since old cards may use them). Unknown text is reported, never
 *     created as a new value.
 *   - A "No" column keeps the numbers already written on the physical board; without it, cards get
 *     the next numbers. A number already taken (even by a deleted card) is reported.
 *   - Allowed once: a commit is refused while any imported card exists (delete them to redo it).
 */

type Field =
  | 'cardNo' | 'creatorName' | 'cardDate' | 'departmentId' | 'cardName' | 'cardTypeId' | 'issue' | 'rootCause'
  | 'impact' | 'priorityId' | 'proposedSolution' | 'expectedDate' | 'closerDate' | 'responsibleParty' | 'status';

const HEADER_ALIASES: Record<Field, string[]> = {
  cardNo: ['no', 'no.', '#', 'number', 'card no', 'رقم', 'الرقم', 'رقم البطاقة'],
  creatorName: ['card creator', 'creator', 'submitter', 'card creator / submitter', 'card creator/submitter', 'منشئ البطاقة', 'مقدم البطاقة', 'صاحب البطاقة'],
  cardDate: ['date', 'التاريخ', 'تاريخ البطاقة'],
  departmentId: ['department', 'الإدارة', 'الادارة', 'القسم'],
  cardName: ['card name', 'name', 'اسم البطاقة'],
  cardTypeId: ['card type', 'type', 'نوع البطاقة'],
  issue: ['issue', 'المشكلة'],
  rootCause: ['root cause', 'السبب الجذري'],
  impact: ['impact', 'التأثير', 'الأثر'],
  priorityId: ['card priority', 'priority', 'أهمية البطاقة', 'الأهمية', 'الأولوية'],
  proposedSolution: ['proposed solution', 'solution', 'الحل المقترح'],
  expectedDate: ['expected date', 'target date', 'التاريخ المتوقع', 'تاريخ الإغلاق المتوقع'],
  closerDate: ['closer date', 'closing date', 'close date', 'closed date', 'تاريخ الإغلاق'],
  responsibleParty: ['responsible party', 'responsible', 'الجهة المسؤولة', 'المسؤول'],
  status: ['status', 'الحالة', 'حالة البطاقة'],
};

const REQUIRED_HEADERS: Field[] = ['creatorName', 'cardDate', 'departmentId', 'cardName', 'cardTypeId', 'issue', 'priorityId'];

const STATUS_WORDS: Record<string, 'OPEN' | 'CLOSED'> = {
  open: 'OPEN',
  opened: 'OPEN',
  'مفتوحة': 'OPEN',
  'مفتوح': 'OPEN',
  closed: 'CLOSED',
  close: 'CLOSED',
  'تم الإغلاق': 'CLOSED',
  'تم الاغلاق': 'CLOSED',
  'مغلقة': 'CLOSED',
  'مغلق': 'CLOSED',
};

function norm(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Plain text of any exceljs cell value (rich text, hyperlinks, formula results included). */
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    const v = value as unknown as Record<string, unknown>;
    if (Array.isArray(v.richText)) return (v.richText as { text: string }[]).map((r) => r.text).join('').trim();
    if ('text' in v) return String(v.text ?? '').trim();
    if ('result' in v) return cellText(v.result as ExcelJS.CellValue);
    return '';
  }
  return String(value).trim();
}

/** A cell as an ISO date: real Excel dates, serial numbers, YYYY-MM-DD, or day-first D/M/YYYY. */
function cellDate(value: ExcelJS.CellValue): string | null | 'invalid' {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object' && value && 'result' in value) return cellDate((value as { result: ExcelJS.CellValue }).result);
  if (typeof value === 'number') {
    const d = new Date(Math.round((value - 25569) * 86400 * 1000));
    return Number.isNaN(d.getTime()) ? 'invalid' : d.toISOString().slice(0, 10);
  }
  const t = cellText(value);
  if (!t) return null;
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(t);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(t);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return 'invalid';
}

export interface KaizenImportProblem {
  /** Excel row number (1-based, as shown in Excel). 0 = the file as a whole. */
  row: number;
  field?: string;
  code: string;
  message: string;
}

export interface KaizenImportResult {
  fileRows: number;
  validRows: number;
  problems: KaizenImportProblem[];
  /** Text that didn't match any existing dropdown value, per list -- to add them first if wanted. */
  unmatched: Record<KaizenListKey, string[]>;
  alreadyImported: boolean;
  committed: boolean;
  imported: number;
}

interface ParsedRow {
  row: number;
  cardNo?: number;
  values: CardValues;
}

async function parseWorkbook(buffer: Buffer): Promise<{ parsed: ParsedRow[]; fileRows: number; problems: KaizenImportProblem[]; unmatched: KaizenImportResult['unmatched'] }> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw new KaizenValidationError('import.unreadable', 'The file could not be read as an Excel (.xlsx) workbook.');
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new KaizenValidationError('import.empty', 'The workbook has no sheets.');

  // Header row: the first of the top 10 rows that names most of the required columns.
  const aliasToField = new Map<string, Field>();
  for (const [field, aliases] of Object.entries(HEADER_ALIASES) as [Field, string[]][]) for (const a of aliases) aliasToField.set(norm(a), field);
  let headerRow = 0;
  let columns = new Map<Field, number>();
  for (let r = 1; r <= Math.min(10, sheet.rowCount); r++) {
    const found = new Map<Field, number>();
    sheet.getRow(r).eachCell((cell, col) => {
      const field = aliasToField.get(norm(cellText(cell.value)));
      if (field && !found.has(field)) found.set(field, col);
    });
    if (found.size > columns.size) {
      columns = found;
      headerRow = r;
    }
  }
  const missing = REQUIRED_HEADERS.filter((f) => !columns.has(f));
  if (headerRow === 0 || missing.length > 0) {
    throw new KaizenValidationError(
      'import.headers',
      `Missing required column(s): ${missing.map((f) => HEADER_ALIASES[f][0]).join(', ')}.`,
    );
  }

  const dropdowns = await listDropdownValues();
  const lookup = (listKey: KaizenListKey, text: string): number | undefined => {
    const n = norm(text);
    return dropdowns.find((d) => d.list_key === listKey && (norm(d.label_en) === n || norm(d.label_ar) === n))?.value_id;
  };
  const unmatched: KaizenImportResult['unmatched'] = { department: [], card_type: [], card_priority: [] };
  const problems: KaizenImportProblem[] = [];
  const parsed: ParsedRow[] = [];
  const seenNos = new Map<number, number>();
  let fileRows = 0;

  for (let r = headerRow + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const raw = (f: Field) => (columns.has(f) ? row.getCell(columns.get(f)!).value : null);
    if ([...columns.values()].every((c) => cellText(row.getCell(c).value) === '')) continue;
    fileRows++;
    const rowProblems: KaizenImportProblem[] = [];

    let cardNo: number | undefined;
    const noText = cellText(raw('cardNo')).replace(/^#/, '');
    if (noText) {
      const n = Number(noText);
      if (!Number.isInteger(n) || n <= 0) rowProblems.push({ row: r, field: 'cardNo', code: 'import.noInvalid', message: `"No" must be a positive whole number (got "${noText}").` });
      else if (seenNos.has(n)) rowProblems.push({ row: r, field: 'cardNo', code: 'import.noDuplicate', message: `No ${n} is repeated (also on row ${seenNos.get(n)}).` });
      else {
        seenNos.set(n, r);
        cardNo = n;
      }
    }

    const dates: Partial<Record<'cardDate' | 'expectedDate' | 'closerDate', string | null>> = {};
    for (const f of ['cardDate', 'expectedDate', 'closerDate'] as const) {
      const d = cellDate(raw(f));
      if (d === 'invalid') rowProblems.push({ row: r, field: f, code: 'import.dateInvalid', message: `${HEADER_ALIASES[f][0]}: "${cellText(raw(f))}" is not a date.` });
      else dates[f] = d;
    }

    const ids: Partial<Record<'departmentId' | 'cardTypeId' | 'priorityId', number | null>> = {};
    for (const [f, listKey] of [['departmentId', 'department'], ['cardTypeId', 'card_type'], ['priorityId', 'card_priority']] as const) {
      const t = cellText(raw(f));
      if (!t) {
        ids[f] = null;
        continue;
      }
      const id = lookup(listKey, t);
      if (id === undefined) {
        rowProblems.push({ row: r, field: f, code: 'import.valueUnknown', message: `${HEADER_ALIASES[f][0]}: "${t}" does not match any existing value.` });
        if (!unmatched[listKey].includes(t)) unmatched[listKey].push(t);
      } else ids[f] = id;
    }

    let status: string | undefined;
    const statusText = cellText(raw('status'));
    if (statusText) {
      status = STATUS_WORDS[norm(statusText)];
      if (!status) rowProblems.push({ row: r, field: 'status', code: 'import.statusInvalid', message: `Status: "${statusText}" is not Open or Closed.` });
    } else {
      status = dates.closerDate ? 'CLOSED' : 'OPEN';
    }

    if (rowProblems.length > 0) {
      problems.push(...rowProblems);
      continue;
    }
    const input: CardInput = {
      creatorName: cellText(raw('creatorName')),
      cardDate: dates.cardDate ?? '',
      departmentId: ids.departmentId,
      cardName: cellText(raw('cardName')),
      cardTypeId: ids.cardTypeId,
      issue: cellText(raw('issue')),
      rootCause: cellText(raw('rootCause')),
      impact: cellText(raw('impact')),
      priorityId: ids.priorityId,
      proposedSolution: cellText(raw('proposedSolution')),
      expectedDate: dates.expectedDate ?? '',
      closerDate: dates.closerDate ?? '',
      responsibleParty: cellText(raw('responsibleParty')),
      status,
    };
    try {
      parsed.push({ row: r, cardNo, values: validateCardValues(input) });
    } catch (err) {
      if (err instanceof KaizenValidationError) problems.push({ row: r, field: err.field, code: err.code, message: err.message });
      else throw err;
    }
  }

  // Numbers already used by a card in the app (deleted ones included: numbers are never reused).
  const nos = parsed.filter((p) => p.cardNo !== undefined).map((p) => p.cardNo as number);
  if (nos.length > 0) {
    const [rows] = await pool.query('SELECT card_no FROM kaizen_cards WHERE card_no IN (?)', [nos]);
    const taken = new Set((rows as { card_no: number }[]).map((x) => Number(x.card_no)));
    for (const p of parsed) {
      if (p.cardNo !== undefined && taken.has(p.cardNo)) {
        problems.push({ row: p.row, field: 'cardNo', code: 'import.noTaken', message: `No ${p.cardNo} is already used by a card in the app.` });
      }
    }
  }

  if (fileRows === 0) problems.push({ row: 0, code: 'import.noRows', message: 'The sheet has no card rows under the header.' });
  const badRows = new Set(problems.map((p) => p.row));
  return { parsed: parsed.filter((p) => !badRows.has(p.row)), fileRows, problems: problems.sort((a, b) => a.row - b.row), unmatched };
}

async function alreadyImported(): Promise<boolean> {
  const [rows] = await pool.query("SELECT 1 FROM kaizen_cards WHERE source = 'IMPORT' AND deleted_at IS NULL LIMIT 1");
  return (rows as unknown[]).length > 0;
}

export async function importKaizenCards(buffer: Buffer, opts: { commit: boolean; actorUserId: number }): Promise<KaizenImportResult> {
  const { parsed, fileRows, problems, unmatched } = await parseWorkbook(buffer);
  const imported = await alreadyImported();
  const result: KaizenImportResult = {
    fileRows,
    validRows: parsed.length,
    problems,
    unmatched,
    alreadyImported: imported,
    committed: false,
    imported: 0,
  };
  if (!opts.commit) return result;
  if (imported) throw new KaizenValidationError('import.already', 'Cards have already been imported once. Delete the imported cards first to import again.');
  if (problems.length > 0) throw new KaizenValidationError('import.hasProblems', 'Fix the reported rows before importing; nothing was imported.');

  const conn = await pool.getConnection();
  const inserted: number[] = [];
  try {
    await conn.beginTransaction();
    // Rows with an explicit No first, so auto-numbered rows continue after the highest one.
    const ordered = [...parsed].sort((a, b) => (a.cardNo === undefined ? 1 : 0) - (b.cardNo === undefined ? 1 : 0) || (a.cardNo ?? 0) - (b.cardNo ?? 0) || a.row - b.row);
    for (const p of ordered) {
      inserted.push(await insertCardValues(conn, p.values, opts.actorUserId, { cardNo: p.cardNo, source: 'IMPORT' }));
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  await writeAuditLog({
    entityType: KAIZEN_CARD_ENTITY,
    entityId: 'import',
    action: 'CREATE',
    changedBy: opts.actorUserId,
    after: { imported: inserted.length, cardNos: inserted },
  });
  return { ...result, committed: true, imported: inserted.length, alreadyImported: true };
}
