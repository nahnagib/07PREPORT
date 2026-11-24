import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { pool } from '../../db/pool';
import { writeAuditLog } from '../auditLogService';
import { exec, inTransaction, isoDate, isoDateTime, one, rows, type Db } from '../pdp/db';
import {
  BLOCKER_STATUSES,
  HEALTHS,
  PRIORITIES,
  PROJECT_TYPES,
  STAGES,
  UNASSIGNED_BRAND,
  businessToday,
  daysBetween,
  normaliseReadiness,
  productFlag,
  productProblems,
  type BlockerKind,
  type BlockerStatus,
  type HealthCode,
  type PriorityCode,
  type ProjectTypeCode,
  type StageCode,
} from './rules';
import { ENTITY, codeId, fail, getSettings, loadBlockers, loadProducts, listDropdowns, syncBlockerHealth, syncLatestUpdate } from './trackerService';

/**
 * Excel import / export of Input/product_development/Product_Development_Input.xlsx (docs/product-development-standalone.md
 * "Excel file"). Upload -> preview (nothing written) -> confirm (the same file, checked by its SHA-256, in one transaction).
 *
 *   Products              upsert by Code (XT-###). A stage change is written to the stage history with comment "Excel import".
 *                         A product in the database but missing from the file is left as it is and reported.
 *                         Columns are found by their header name. "Brand" (0082) is optional: a blank cell, or a file
 *                         from before the column existed, gives "Unassigned".
 *   Status updates        append-only; an exact duplicate (date + code + summary) is skipped.
 *   Blockers & decisions  upsert by ID (BL-###).
 *   Lists                 families (+ descriptions) are added / updated; the other lists are fixed.
 *   Read me, Where we stand and every "(auto)" / formula column are ignored.
 * Readiness may be 0-1 (a % cell) or 0-100; dates are Excel dates (a dd/mm/yyyy text is accepted too).
 */

export const SHEETS = { products: 'Products', updates: 'Status updates', blockers: 'Blockers & decisions', lists: 'Lists' } as const;

const PRODUCT_COLUMNS = ['Code', 'Product name', 'Family', 'Subfamily', 'Description', 'Pipeline stage', 'Health', 'Priority', 'Owner', 'Readiness %', 'Target launch date', 'Actual launch date', 'Project type', 'Next step', 'Next step due', 'Comment', 'Last updated', 'Updated by'] as const;
const UPDATE_COLUMNS = ['Update date', 'Product code', 'Health', 'Readiness %', 'Progress summary', 'Next step', 'Next step due', 'Updated by'] as const;
const BLOCKER_COLUMNS = ['ID', 'Product code', 'Type', 'Title', 'Required action / decision', 'Owner', 'Raised on', 'Due date', 'Status', 'Resolution note', 'Resolved date'] as const;
/** Optional Products column (added after Flag, 2026-11-24); read by name, never by position. */
const PRODUCT_BRAND = 'Brand';
const LIST_FAMILY = 'Product family';
const LIST_FAMILY_DESC = 'Family description';

export interface ImportError {
  sheet: string;
  row: number;
  field: string;
  code: string;
  message: string;
}

const STAGE_LABEL: Record<StageCode, string> = { IDEA: 'Idea', RESEARCH: 'Research', DEVELOPMENT: 'Development', TESTING: 'Testing', LAUNCH_READY: 'Launch ready', LAUNCHED: 'Launched' };
const HEALTH_LABEL: Record<HealthCode, string> = { ON_TRACK: 'On track', AT_RISK: 'At risk', BLOCKED: 'Blocked' };
const PRIORITY_LABEL: Record<PriorityCode, string> = { HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' };
const PROJECT_LABEL: Record<ProjectTypeCode, string> = { PLANNED: 'Planned', UNPLANNED: 'Unplanned', INNOVATION: 'Innovation', REFORMULATION: 'Reformulation' };
const KIND_LABEL: Record<BlockerKind, string> = { BLOCKER: 'Blocker', DECISION: 'Decision needed' };
const STATUS_LABEL: Record<BlockerStatus, string> = { OPEN: 'Open', IN_PROGRESS: 'In progress', RESOLVED: 'Resolved', CANCELLED: 'Cancelled' };

// ---------------------------------------------------------------------------------------------------------------------
// Cell values
// ---------------------------------------------------------------------------------------------------------------------

type Cell = ExcelJS.CellValue;

/** A formula's cached result, rich text joined, hyperlink text; everything else as is. */
function plain(v: Cell): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    const o = v as unknown as Record<string, unknown>;
    if ('result' in o) return plain(o.result as Cell);
    if ('richText' in o) return (o.richText as { text: string }[]).map((t) => t.text).join('');
    if ('text' in o) return o.text;
    if ('error' in o) return null;
    return null;
  }
  return v;
}

function str(v: Cell): string | null {
  const p = plain(v);
  if (p === null || p === undefined) return null;
  const s = (p instanceof Date ? p.toISOString().slice(0, 10) : String(p)).trim();
  return s === '' ? null : s;
}

/** Excel date / serial number / 'dd/mm/yyyy' / 'yyyy-mm-dd' -> 'YYYY-MM-DD'; undefined when not a date. */
function dateOf(v: Cell): string | null | undefined {
  const p = plain(v);
  if (p === null || p === undefined || p === '') return null;
  if (p instanceof Date) return Number.isNaN(p.getTime()) ? undefined : p.toISOString().slice(0, 10);
  if (typeof p === 'number') {
    if (p < 1 || p > 2_958_465) return undefined;
    return new Date(Math.round((p - 25569) * 86_400_000)).toISOString().slice(0, 10);
  }
  const s = String(p).trim();
  let m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) {
    const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) === iso ? iso : undefined;
  }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s ? s : undefined;
  return undefined;
}

/** Label (any case) or code of a fixed list -> code; undefined when not in the list, null when blank. */
function listValue<T extends string>(v: Cell, labels: Record<T, string>): T | null | undefined {
  const s = str(v);
  if (s === null) return null;
  const k = s.toLowerCase().replace(/\s+/g, ' ');
  for (const [code, label] of Object.entries(labels) as [T, string][]) {
    if (label.toLowerCase() === k || code.toLowerCase() === k.replace(/ /g, '_')) return code;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------------------------------

export interface ProductRow {
  row: number;
  code: string;
  name: string;
  family: string | null;
  subfamily: string | null;
  brand: string;
  description: string | null;
  stage: StageCode;
  health: HealthCode | null;
  priority: PriorityCode | null;
  owner: string | null;
  readinessPct: number | null;
  targetLaunch: string | null;
  actualLaunch: string | null;
  projectType: ProjectTypeCode | null;
  nextStep: string | null;
  nextStepDue: string | null;
  comment: string | null;
  lastEditedOn: string | null;
  updatedByName: string | null;
}

export interface UpdateRow {
  row: number;
  updateDate: string;
  code: string;
  health: HealthCode | null;
  readinessPct: number | null;
  summary: string;
  nextStep: string | null;
  nextStepDue: string | null;
  updatedByName: string | null;
}

export interface BlockerRow {
  row: number;
  externalId: string;
  code: string;
  kind: BlockerKind;
  title: string;
  requiredAction: string;
  owner: string | null;
  raisedOn: string | null;
  dueDate: string;
  status: BlockerStatus;
  resolutionNote: string | null;
  resolvedAt: string | null;
}

export interface Parsed {
  products: ProductRow[];
  updates: UpdateRow[];
  blockers: BlockerRow[];
  families: { name: string; description: string | null }[];
  errors: ImportError[];
}

/** Header name -> column number of row 1; reports the missing ones. */
function headerMap(ws: ExcelJS.Worksheet, required: readonly string[], errors: ImportError[]): Map<string, number> | null {
  const map = new Map<string, number>();
  ws.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => {
    const h = str(cell.value);
    if (h) map.set(h.toLowerCase(), col);
  });
  const missing = required.filter((h) => !map.has(h.toLowerCase()));
  for (const h of missing) errors.push({ sheet: ws.name, row: 1, field: h, code: 'import.headerMissing', message: `Column "${h}" is missing from row 1.` });
  return missing.length ? null : map;
}

// eslint-disable-next-line no-unused-vars -- parameter name of a function type (the base rule misreads it)
function* dataRows(ws: ExcelJS.Worksheet, key: (r: ExcelJS.Row) => boolean) {
  for (let i = 2; i <= ws.rowCount; i += 1) {
    const r = ws.getRow(i);
    if (key(r)) yield { r, i };
  }
}

/**
 * ExcelJS 4.4 crashes ("reading 'comments'") on a sheet whose comment / note links use absolute targets
 * (Target="/xl/comments/comment1.xml", as openpyxl and some Excel builds write them). The import never reads comments, so
 * those two links are dropped from every sheet's .rels before loading. JSZip is ExcelJS's own dependency, resolved from
 * ExcelJS's folder so it is always the copy installed with it.
 */
/* eslint-disable no-unused-vars -- parameter names of method signatures (the base rule misreads them) */
interface Zip {
  file(pattern: RegExp): { name: string; async(type: 'string'): Promise<string> }[];
  file(name: string, data: string): void;
  generateAsync(options: { type: 'nodebuffer'; compression: 'DEFLATE' }): Promise<Buffer>;
}
interface ZipModule {
  loadAsync(data: Buffer): Promise<Zip>;
}
/* eslint-enable no-unused-vars */

async function withoutCommentLinks(buffer: Buffer): Promise<Buffer> {
  const JSZip = require(require.resolve('jszip', { paths: [require.resolve('exceljs')] })) as ZipModule;
  const zip = await JSZip.loadAsync(buffer);
  let changed = false;
  for (const f of zip.file(/^xl\/worksheets\/_rels\/[^/]+\.rels$/)) {
    const xml = await f.async('string');
    const cleaned = xml.replace(/<Relationship\b[^>]*\/relationships\/(?:comments|vmlDrawing)"[^>]*\/>/g, '');
    if (cleaned !== xml) {
      zip.file(f.name, cleaned);
      changed = true;
    }
  }
  return changed ? zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }) : buffer;
}

export async function parseWorkbook(buffer: Buffer): Promise<Parsed> {
  const wb = new ExcelJS.Workbook();
  const errors: ImportError[] = [];
  try {
    await wb.xlsx.load((await withoutCommentLinks(buffer)) as unknown as ArrayBuffer);
  } catch {
    throw fail('import.unreadable', 'This file could not be read as an Excel workbook (.xlsx).', 'file');
  }
  const sheet = (name: string) => {
    const ws = wb.worksheets.find((w) => w.name.trim().toLowerCase() === name.toLowerCase());
    if (!ws) errors.push({ sheet: name, row: 0, field: 'sheet', code: 'import.sheetMissing', message: `The sheet "${name}" is missing.` });
    return ws;
  };
  const out: Parsed = { products: [], updates: [], blockers: [], families: [], errors };
  const err = (sheetName: string, row: number, field: string, code: string, message: string) => errors.push({ sheet: sheetName, row, field, code, message });

  // ---- Lists: families --------------------------------------------------------------------------------------------
  const lists = sheet(SHEETS.lists);
  if (lists) {
    const h = headerMap(lists, [LIST_FAMILY], errors);
    if (h) {
      const fc = h.get(LIST_FAMILY.toLowerCase())!;
      const dc = h.get(LIST_FAMILY_DESC.toLowerCase());
      for (const { r } of dataRows(lists, (x) => str(x.getCell(fc).value) !== null)) {
        out.families.push({ name: str(r.getCell(fc).value)!.slice(0, 100), description: dc ? (str(r.getCell(dc).value)?.slice(0, 500) ?? null) : null });
      }
    }
  }

  // ---- Products ---------------------------------------------------------------------------------------------------
  const products = sheet(SHEETS.products);
  if (products) {
    const h = headerMap(products, PRODUCT_COLUMNS, errors);
    if (h) {
      const c = (r: ExcelJS.Row, name: (typeof PRODUCT_COLUMNS)[number]) => r.getCell(h.get(name.toLowerCase())!).value;
      const brandCol = h.get(PRODUCT_BRAND.toLowerCase());
      const S = SHEETS.products;
      for (const { r, i } of dataRows(products, (x) => str(c(x, 'Code')) !== null || str(c(x, 'Product name')) !== null)) {
        const before = errors.length;
        const code = str(c(r, 'Code'))?.toUpperCase() ?? '';
        const name = str(c(r, 'Product name')) ?? '';
        if (!code) err(S, i, 'Code', 'product.codeRequired', 'Enter the product code (e.g. XT-056).');
        else if (code.length > 20) err(S, i, 'Code', 'product.codeTooLong', 'The code can be at most 20 characters.');
        if (!name) err(S, i, 'Product name', 'product.nameRequired', 'Enter the product name.');
        else if (name.length > 150) err(S, i, 'Product name', 'product.nameTooLong', 'The name can be at most 150 characters.');
        const stage = listValue(c(r, 'Pipeline stage'), STAGE_LABEL);
        if (!stage) err(S, i, 'Pipeline stage', stage === null ? 'product.stageRequired' : 'product.stageInvalid', stage === null ? 'Pick the pipeline stage.' : `"${str(c(r, 'Pipeline stage'))}" is not a stage (${Object.values(STAGE_LABEL).join(', ')}).`);
        const health = listValue(c(r, 'Health'), HEALTH_LABEL);
        if (health === undefined) err(S, i, 'Health', 'product.healthInvalid', `"${str(c(r, 'Health'))}" is not a health value (${Object.values(HEALTH_LABEL).join(', ')}).`);
        const priority = listValue(c(r, 'Priority'), PRIORITY_LABEL);
        if (priority === undefined) err(S, i, 'Priority', 'product.priorityInvalid', `"${str(c(r, 'Priority'))}" is not a priority (High, Medium, Low).`);
        const projectType = listValue(c(r, 'Project type'), PROJECT_LABEL);
        if (projectType === undefined) err(S, i, 'Project type', 'product.projectTypeInvalid', `"${str(c(r, 'Project type'))}" is not a project type (${Object.values(PROJECT_LABEL).join(', ')}).`);
        const readiness = normaliseReadiness(plain(c(r, 'Readiness %')));
        if (readiness !== null && Number.isNaN(readiness)) err(S, i, 'Readiness %', 'product.readinessInvalid', 'Readiness must be a percentage (e.g. 45%).');
        const dates: Record<string, string | null> = {};
        for (const f of ['Target launch date', 'Actual launch date', 'Next step due', 'Last updated'] as const) {
          const d = dateOf(c(r, f));
          if (d === undefined) err(S, i, f, 'date.invalid', `"${str(c(r, f))}" is not a date (type dd/mm/yyyy).`);
          dates[f] = d ?? null;
        }
        const longText = (f: (typeof PRODUCT_COLUMNS)[number], max: number) => {
          const v = str(c(r, f));
          if (v && v.length > max) err(S, i, f, 'text.tooLong', `At most ${max} characters.`);
          return v;
        };
        const brand = brandCol ? str(r.getCell(brandCol).value) : null;
        if (brand && brand.length > 100) err(S, i, PRODUCT_BRAND, 'text.tooLong', 'At most 100 characters.');
        const row: ProductRow = {
          row: i, code, name, family: str(c(r, 'Family')), subfamily: longText('Subfamily', 100), brand: brand ?? UNASSIGNED_BRAND, description: longText('Description', 5000),
          stage: stage ?? 'IDEA', health: health ?? null, priority: priority ?? null, owner: longText('Owner', 150),
          readinessPct: readiness !== null && Number.isNaN(readiness) ? null : readiness,
          targetLaunch: dates['Target launch date'], actualLaunch: dates['Actual launch date'], projectType: projectType ?? null,
          nextStep: longText('Next step', 300), nextStepDue: dates['Next step due'], comment: longText('Comment', 5000),
          lastEditedOn: dates['Last updated'], updatedByName: longText('Updated by', 150),
        };
        if (row.nextStep && !row.nextStepDue) err(S, i, 'Next step due', 'product.nextStepDueRequired', 'Enter when the next step is due.');
        if (stage && errors.length === before) {
          for (const p of productProblems({ name, stage, readinessPct: row.readinessPct, targetLaunch: row.targetLaunch, actualLaunch: row.actualLaunch })) {
            const field = { name: 'Product name', readinessPct: 'Readiness %', targetLaunch: 'Target launch date', actualLaunch: 'Actual launch date' }[p.field] ?? p.field;
            err(S, i, field, p.code, p.message);
          }
        }
        out.products.push(row);
      }
    }
  }

  // ---- Status updates ---------------------------------------------------------------------------------------------
  const updates = sheet(SHEETS.updates);
  if (updates) {
    const h = headerMap(updates, UPDATE_COLUMNS, errors);
    if (h) {
      const c = (r: ExcelJS.Row, name: (typeof UPDATE_COLUMNS)[number]) => r.getCell(h.get(name.toLowerCase())!).value;
      const S = SHEETS.updates;
      for (const { r, i } of dataRows(updates, (x) => str(c(x, 'Product code')) !== null || str(c(x, 'Progress summary')) !== null || Boolean(dateOf(c(x, 'Update date'))))) {
        const d = dateOf(c(r, 'Update date'));
        if (!d) err(S, i, 'Update date', d === null ? 'update.dateRequired' : 'date.invalid', d === null ? 'Enter the update date.' : 'Not a date (type dd/mm/yyyy).');
        const code = str(c(r, 'Product code'))?.toUpperCase() ?? '';
        if (!code) err(S, i, 'Product code', 'update.codeRequired', 'Enter the product code.');
        const health = listValue(c(r, 'Health'), HEALTH_LABEL);
        if (health === undefined) err(S, i, 'Health', 'update.healthInvalid', `"${str(c(r, 'Health'))}" is not a health value.`);
        const readiness = normaliseReadiness(plain(c(r, 'Readiness %')));
        if (readiness !== null && (Number.isNaN(readiness) || readiness < 0 || readiness > 100)) err(S, i, 'Readiness %', 'update.readinessInvalid', 'Readiness must be from 0% to 100%.');
        const summary = str(c(r, 'Progress summary'));
        if (!summary) err(S, i, 'Progress summary', 'update.summaryRequired', 'Describe the progress.');
        const nextDue = dateOf(c(r, 'Next step due'));
        if (nextDue === undefined) err(S, i, 'Next step due', 'date.invalid', 'Not a date (type dd/mm/yyyy).');
        const nextStep = str(c(r, 'Next step'));
        if (nextStep && !nextDue) err(S, i, 'Next step due', 'update.nextStepDueRequired', 'Enter when the next step is due.');
        out.updates.push({
          row: i, updateDate: d ?? '', code, health: health ?? null, readinessPct: readiness !== null && Number.isNaN(readiness) ? null : readiness,
          summary: summary ?? '', nextStep: nextStep?.slice(0, 300) ?? null, nextStepDue: nextDue ?? null, updatedByName: str(c(r, 'Updated by'))?.slice(0, 150) ?? null,
        });
      }
    }
  }

  // ---- Blockers & decisions ---------------------------------------------------------------------------------------
  const blockers = sheet(SHEETS.blockers);
  if (blockers) {
    const h = headerMap(blockers, BLOCKER_COLUMNS, errors);
    if (h) {
      const c = (r: ExcelJS.Row, name: (typeof BLOCKER_COLUMNS)[number]) => r.getCell(h.get(name.toLowerCase())!).value;
      const S = SHEETS.blockers;
      for (const { r, i } of dataRows(blockers, (x) => str(c(x, 'ID')) !== null || str(c(x, 'Product code')) !== null || str(c(x, 'Title')) !== null)) {
        const id = str(c(r, 'ID'))?.toUpperCase() ?? '';
        if (!id) err(S, i, 'ID', 'blocker.idRequired', 'Enter the ID (e.g. BL-001).');
        const code = str(c(r, 'Product code'))?.toUpperCase() ?? '';
        if (!code) err(S, i, 'Product code', 'blocker.codeRequired', 'Enter the product code.');
        const kind = listValue(c(r, 'Type'), KIND_LABEL);
        if (!kind) err(S, i, 'Type', 'blocker.typeInvalid', 'Pick Blocker or Decision needed.');
        const title = str(c(r, 'Title'));
        if (!title) err(S, i, 'Title', 'blocker.titleRequired', 'Enter the title.');
        const action = str(c(r, 'Required action / decision'));
        if (!action) err(S, i, 'Required action / decision', 'blocker.actionRequired', 'Enter the required action or decision.');
        const raised = dateOf(c(r, 'Raised on'));
        if (raised === undefined) err(S, i, 'Raised on', 'date.invalid', 'Not a date (type dd/mm/yyyy).');
        const due = dateOf(c(r, 'Due date'));
        if (!due) err(S, i, 'Due date', due === null ? 'blocker.dueRequired' : 'date.invalid', due === null ? 'Enter the due date.' : 'Not a date (type dd/mm/yyyy).');
        const status = listValue(c(r, 'Status'), STATUS_LABEL);
        if (!status) err(S, i, 'Status', 'blocker.statusInvalid', `Pick a status (${BLOCKER_STATUSES.map((s) => STATUS_LABEL[s]).join(', ')}).`);
        const note = str(c(r, 'Resolution note'));
        const resolved = dateOf(c(r, 'Resolved date'));
        if (resolved === undefined) err(S, i, 'Resolved date', 'date.invalid', 'Not a date (type dd/mm/yyyy).');
        if (status === 'RESOLVED' && !note) err(S, i, 'Resolution note', 'blocker.noteRequired', 'A resolved item needs a resolution note.');
        if (status === 'RESOLVED' && !resolved) err(S, i, 'Resolved date', 'blocker.resolvedDateRequired', 'A resolved item needs the resolved date.');
        out.blockers.push({
          row: i, externalId: id, code, kind: kind ?? 'BLOCKER', title: (title ?? '').slice(0, 200), requiredAction: (action ?? '').slice(0, 500),
          owner: str(c(r, 'Owner'))?.slice(0, 150) ?? null, raisedOn: raised ?? null, dueDate: due ?? '', status: status ?? 'OPEN',
          resolutionNote: note?.slice(0, 1000) ?? null, resolvedAt: status === 'OPEN' || status === 'IN_PROGRESS' ? null : (resolved ?? null),
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Preview (compare with the database; nothing written)
// ---------------------------------------------------------------------------------------------------------------------

interface DbProduct {
  product_id: number;
  code: string;
  name: string;
  family: string | null;
  subfamily: string | null;
  brand: string | null;
  description: string | null;
  stage: StageCode;
  stage_id: number;
  health: HealthCode | null;
  priority: PriorityCode | null;
  owner_name: string | null;
  readiness_pct: number | null;
  target_launch: unknown;
  actual_launch: unknown;
  project_type: ProjectTypeCode | null;
  next_step: string | null;
  next_step_due: unknown;
  comment: string | null;
  last_edited_on: unknown;
  updated_by_name: string | null;
}

async function dbProducts(db: Db): Promise<DbProduct[]> {
  return rows<DbProduct>(
    db,
    `SELECT p.product_id, p.code, p.name, f.label AS family, p.subfamily, p.brand, p.description, st.code AS stage, p.stage_id, h.code AS health, pr.code AS priority,
            p.owner_name, p.readiness_pct, p.target_launch, p.actual_launch, pt.code AS project_type, p.next_step, p.next_step_due, p.comment,
            p.last_edited_on, p.updated_by_name
       FROM pdt_product p
       JOIN pdt_dropdown_value st ON st.value_id = p.stage_id
       LEFT JOIN pdt_dropdown_value f ON f.value_id = p.family_id
       LEFT JOIN pdt_dropdown_value h ON h.value_id = p.health_id
       LEFT JOIN pdt_dropdown_value pr ON pr.value_id = p.priority_id
       LEFT JOIN pdt_dropdown_value pt ON pt.value_id = p.project_type_id
      WHERE p.deleted_at IS NULL`,
  );
}

// eslint-disable-next-line no-unused-vars -- parameter name of a function type (the base rule misreads it)
const PRODUCT_FIELDS: [keyof ProductRow, string, (d: DbProduct) => unknown][] = [
  ['name', 'Product name', (d) => d.name],
  ['family', 'Family', (d) => d.family],
  ['subfamily', 'Subfamily', (d) => d.subfamily],
  ['brand', 'Brand', (d) => d.brand ?? UNASSIGNED_BRAND],
  ['description', 'Description', (d) => d.description],
  ['stage', 'Pipeline stage', (d) => d.stage],
  ['health', 'Health', (d) => d.health],
  ['priority', 'Priority', (d) => d.priority],
  ['owner', 'Owner', (d) => d.owner_name],
  ['readinessPct', 'Readiness %', (d) => (d.readiness_pct === null ? null : Number(d.readiness_pct))],
  ['targetLaunch', 'Target launch date', (d) => isoDate(d.target_launch)],
  ['actualLaunch', 'Actual launch date', (d) => isoDate(d.actual_launch)],
  ['projectType', 'Project type', (d) => d.project_type],
  ['nextStep', 'Next step', (d) => d.next_step],
  ['nextStepDue', 'Next step due', (d) => isoDate(d.next_step_due)],
  ['comment', 'Comment', (d) => d.comment],
  ['lastEditedOn', 'Last updated', (d) => isoDate(d.last_edited_on)],
  ['updatedByName', 'Updated by', (d) => d.updated_by_name],
];

const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);

function changedFields(row: ProductRow, d: DbProduct): string[] {
  return PRODUCT_FIELDS.filter(([k, , get]) => {
    const a = row[k];
    const b = get(d);
    if (k === 'family' && typeof a === 'string' && typeof b === 'string') return a.toLowerCase() !== b.toLowerCase();
    return !same(a, b);
  }).map(([, label]) => label);
}

export interface PreviewProduct {
  code: string;
  name: string;
  action: 'new' | 'changed' | 'unchanged';
  fields: string[];
  stageFrom: StageCode | null;
  stageTo: StageCode;
}

export interface Preview {
  fileName: string;
  sha256: string;
  today: string;
  counts: {
    products: { rows: number; new: number; changed: number; unchanged: number; errors: number; stageChanges: number };
    updates: { rows: number; new: number; duplicates: number; errors: number };
    blockers: { rows: number; new: number; changed: number; unchanged: number; errors: number };
    families: { inFile: number; new: number; changed: number };
  };
  errors: ImportError[];
  products: PreviewProduct[];
  missingFromFile: { code: string; name: string }[];
  /** Products the import will set to Blocked because they have an open Blocker. */
  healthForced: string[];
  /** The "Where we stand" counts this file will give (family x stage, all products after the import). */
  whereWeStand: { family: string; counts: Record<StageCode, number>; total: number }[];
  canConfirm: boolean;
}

interface Plan {
  parsed: Parsed;
  preview: Preview;
  existing: Map<string, DbProduct>;
  familyIds: Map<string, number>;
  dbBlockers: Map<string, { blocker_id: number; product_id: number }>;
  newUpdates: UpdateRow[];
}

const dupKey = (date: string, code: string, summary: string) => `${date}|${code.toUpperCase()}|${summary.trim().toLowerCase()}`;

async function plan(buffer: Buffer, fileName: string, db: Db, today: string): Promise<Plan> {
  const parsed = await parseWorkbook(buffer);
  const errors = parsed.errors;
  const err = (sheet: string, row: number, field: string, code: string, message: string) => errors.push({ sheet, row, field, code, message });
  const existingList = await dbProducts(db);
  const existing = new Map(existingList.map((p) => [p.code.toUpperCase(), p]));

  // Families: those already in the list (any state) + the file's Lists sheet.
  const famRows = await rows<{ value_id: number; label: string; description: string | null }>(db, "SELECT value_id, label, description FROM pdt_dropdown_value WHERE list_key = 'family'");
  const familyIds = new Map(famRows.map((f) => [f.label.toLowerCase(), f.value_id]));
  const famDesc = new Map(famRows.map((f) => [f.label.toLowerCase(), f.description]));
  let famNew = 0;
  let famChanged = 0;
  const knownFamilies = new Set(familyIds.keys());
  for (const f of parsed.families) {
    const k = f.name.toLowerCase();
    if (!knownFamilies.has(k)) famNew += 1;
    else if (f.description !== null && (famDesc.get(k) ?? null) !== f.description) famChanged += 1;
    knownFamilies.add(k);
  }

  // Products: duplicates in the file, unknown families, names used by another product.
  const seenCode = new Map<string, number>();
  const seenName = new Map<string, number>();
  for (const p of parsed.products) {
    if (p.code) {
      if (seenCode.has(p.code)) err(SHEETS.products, p.row, 'Code', 'product.codeDuplicate', `Code ${p.code} is also on row ${seenCode.get(p.code)}.`);
      else seenCode.set(p.code, p.row);
    }
    const nk = p.name.toLowerCase().trim();
    if (nk) {
      if (seenName.has(nk)) err(SHEETS.products, p.row, 'Product name', 'product.nameDuplicate', `The same name is also on row ${seenName.get(nk)}.`);
      else seenName.set(nk, p.row);
      const other = existingList.find((d) => d.name.toLowerCase().trim() === nk && d.code.toUpperCase() !== p.code);
      if (other && !parsed.products.some((q) => q.code === other.code.toUpperCase())) {
        err(SHEETS.products, p.row, 'Product name', 'product.nameTaken', `Product ${other.code} already has this name.`);
      }
    }
    if (p.family && !knownFamilies.has(p.family.toLowerCase())) err(SHEETS.products, p.row, 'Family', 'product.familyUnknown', `"${p.family}" is not in Lists › Product family.`);
  }
  const fileCodes = new Set(parsed.products.map((p) => p.code).filter(Boolean));
  const productExists = (code: string) => fileCodes.has(code) || existing.has(code);

  // Blockers: duplicates, unknown products; the open Blockers each product will have after the import.
  const dbBlockerRows = await rows<{ blocker_id: number; external_id: string | null; product_id: number; code: string; kind: BlockerKind; status: BlockerStatus; title: string; required_action: string; owner_name: string | null; raised_on: unknown; due_date: unknown; resolution_note: string | null; resolved_at: unknown }>(
    db,
    `SELECT b.blocker_id, b.external_id, b.product_id, p.code, b.kind, b.status, b.title, b.required_action, b.owner_name, b.raised_on, b.due_date, b.resolution_note, b.resolved_at
       FROM pdt_blocker b JOIN pdt_product p ON p.product_id = b.product_id WHERE b.deleted_at IS NULL AND p.deleted_at IS NULL`,
  );
  const dbBlockers = new Map(dbBlockerRows.filter((b) => b.external_id).map((b) => [b.external_id!.toUpperCase(), b]));
  const seenId = new Map<string, number>();
  let blNew = 0;
  let blChanged = 0;
  let blUnchanged = 0;
  for (const b of parsed.blockers) {
    if (b.externalId) {
      if (seenId.has(b.externalId)) err(SHEETS.blockers, b.row, 'ID', 'blocker.idDuplicate', `ID ${b.externalId} is also on row ${seenId.get(b.externalId)}.`);
      else seenId.set(b.externalId, b.row);
    }
    if (b.code && !productExists(b.code)) err(SHEETS.blockers, b.row, 'Product code', 'blocker.productUnknown', `No product has the code ${b.code}.`);
    const d = b.externalId ? dbBlockers.get(b.externalId) : undefined;
    if (!d) blNew += 1;
    else {
      const unchanged = d.code.toUpperCase() === b.code && d.kind === b.kind && d.status === b.status && d.title === b.title && d.required_action === b.requiredAction &&
        (d.owner_name ?? null) === b.owner && isoDate(d.raised_on) === (b.raisedOn ?? isoDate(d.raised_on)) && isoDate(d.due_date) === b.dueDate &&
        (d.resolution_note ?? null) === b.resolutionNote && (isoDate(d.resolved_at) ?? null) === b.resolvedAt;
      if (unchanged) blUnchanged += 1;
      else blChanged += 1;
    }
  }
  const openBlockerCodes = new Set<string>();
  for (const b of parsed.blockers) if (b.kind === 'BLOCKER' && (b.status === 'OPEN' || b.status === 'IN_PROGRESS')) openBlockerCodes.add(b.code);
  for (const d of dbBlockerRows) {
    if (d.external_id && seenId.has(d.external_id.toUpperCase())) continue; // replaced by the file's row
    if (d.kind === 'BLOCKER' && (d.status === 'OPEN' || d.status === 'IN_PROGRESS')) openBlockerCodes.add(d.code.toUpperCase());
  }

  // Products: new / changed / unchanged, Blocked needs an open Blocker.
  const products: PreviewProduct[] = [];
  const healthForced: string[] = [];
  let stageChanges = 0;
  for (const p of parsed.products) {
    if (!p.code) continue;
    if (p.health === 'BLOCKED' && !openBlockerCodes.has(p.code)) {
      err(SHEETS.products, p.row, 'Health', 'product.blockedNeedsBlocker', 'Health is Blocked but the product has no open Blocker: add it to the Blockers & decisions sheet.');
    }
    if (openBlockerCodes.has(p.code) && p.stage !== 'LAUNCHED' && p.health !== 'BLOCKED') healthForced.push(p.code);
    const d = existing.get(p.code);
    if (!d) {
      products.push({ code: p.code, name: p.name, action: 'new', fields: [], stageFrom: null, stageTo: p.stage });
      continue;
    }
    const fields = changedFields(p, d);
    if (d.stage !== p.stage) stageChanges += 1;
    products.push({ code: p.code, name: p.name, action: fields.length ? 'changed' : 'unchanged', fields, stageFrom: d.stage, stageTo: p.stage });
  }

  // Status updates: unknown products, duplicates (database and file).
  const dbUpdates = await rows<{ update_date: unknown; code: string; summary: string }>(
    db, 'SELECT u.update_date, p.code, u.summary FROM pdt_status_update u JOIN pdt_product p ON p.product_id = u.product_id WHERE u.deleted_at IS NULL',
  );
  const seenUpdate = new Set(dbUpdates.map((u) => dupKey(isoDate(u.update_date)!, u.code, u.summary)));
  const newUpdates: UpdateRow[] = [];
  let dupCount = 0;
  for (const u of parsed.updates) {
    if (u.code && !productExists(u.code)) err(SHEETS.updates, u.row, 'Product code', 'update.productUnknown', `No product has the code ${u.code}.`);
    if (u.updateDate && u.updateDate > today) err(SHEETS.updates, u.row, 'Update date', 'update.dateFuture', 'The update date cannot be in the future.');
    if (!u.updateDate || !u.code || !u.summary) continue;
    const k = dupKey(u.updateDate, u.code, u.summary);
    if (seenUpdate.has(k)) dupCount += 1;
    else {
      seenUpdate.add(k);
      newUpdates.push(u);
    }
  }

  // "Where we stand" after the import: the file's products + products kept from the database.
  const matrix = new Map<string, Record<StageCode, number>>();
  const bump = (fam: string, st: StageCode) => {
    if (!matrix.has(fam)) matrix.set(fam, Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<StageCode, number>);
    matrix.get(fam)![st] += 1;
  };
  for (const p of parsed.products) if (p.code) bump(p.family ?? 'Family not set', p.stage);
  for (const d of existingList) if (!fileCodes.has(d.code.toUpperCase())) bump(d.family ?? 'Family not set', d.stage);
  const famOrder = [...parsed.families.map((f) => f.name), ...famRows.map((f) => f.label)];
  const whereWeStand = [...matrix.entries()]
    .sort((a, b) => {
      const ia = famOrder.findIndex((f) => f.toLowerCase() === a[0].toLowerCase());
      const ib = famOrder.findIndex((f) => f.toLowerCase() === b[0].toLowerCase());
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    })
    .map(([family, counts]) => ({ family, counts, total: STAGES.reduce((n, s) => n + counts[s], 0) }));

  const errorsBy = (sheet: string) => errors.filter((e) => e.sheet === sheet).length;
  const sorted = [...errors].sort((a, b) => a.sheet.localeCompare(b.sheet) || a.row - b.row);
  const preview: Preview = {
    fileName,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    today,
    counts: {
      products: {
        rows: parsed.products.length,
        new: products.filter((p) => p.action === 'new').length,
        changed: products.filter((p) => p.action === 'changed').length,
        unchanged: products.filter((p) => p.action === 'unchanged').length,
        errors: errorsBy(SHEETS.products),
        stageChanges,
      },
      updates: { rows: parsed.updates.length, new: newUpdates.length, duplicates: dupCount, errors: errorsBy(SHEETS.updates) },
      blockers: { rows: parsed.blockers.length, new: blNew, changed: blChanged, unchanged: blUnchanged, errors: errorsBy(SHEETS.blockers) },
      families: { inFile: parsed.families.length, new: famNew, changed: famChanged },
    },
    errors: sorted,
    products,
    missingFromFile: existingList.filter((d) => !fileCodes.has(d.code.toUpperCase())).map((d) => ({ code: d.code, name: d.name })).sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true })),
    healthForced,
    whereWeStand,
    canConfirm: sorted.length === 0,
  };
  return { parsed, preview, existing, familyIds, dbBlockers: new Map([...dbBlockers].map(([k, v]) => [k, { blocker_id: v.blocker_id, product_id: v.product_id }])), newUpdates };
}

export async function previewImport(buffer: Buffer, fileName: string, today = businessToday()): Promise<Preview> {
  return (await plan(buffer, fileName, pool, today)).preview;
}

// ---------------------------------------------------------------------------------------------------------------------
// Confirm
// ---------------------------------------------------------------------------------------------------------------------

export const IMPORT_COMMENT = 'Excel import';

export async function confirmImport(buffer: Buffer, fileName: string, expectedSha256: unknown, uid: number, today = businessToday()) {
  const sha = createHash('sha256').update(buffer).digest('hex');
  if (typeof expectedSha256 !== 'string' || expectedSha256 !== sha) {
    throw fail('import.fileChanged', 'This is not the file you previewed. Upload it again and check the preview before confirming.', 'file');
  }
  const result = await inTransaction(async (conn) => {
    const { parsed, preview, existing, familyIds, dbBlockers, newUpdates } = await plan(buffer, fileName, conn, today);
    if (!preview.canConfirm) throw fail('import.hasErrors', `The file has ${preview.errors.length} error(s). Fix them in Excel and upload it again.`, 'file');

    // 1. Families from the Lists sheet.
    for (const f of parsed.families) {
      const k = f.name.toLowerCase();
      const id = familyIds.get(k);
      if (id) {
        if (f.description !== null) await exec(conn, 'UPDATE pdt_dropdown_value SET description = ?, is_active = 1, updated_by = ? WHERE value_id = ?', [f.description, uid, id]);
      } else {
        const max = await one<{ m: number | null }>(conn, "SELECT MAX(sort_order) AS m FROM pdt_dropdown_value WHERE list_key = 'family'");
        const { insertId } = await exec(conn, "INSERT INTO pdt_dropdown_value (list_key, label, description, color, sort_order, created_by, updated_by) VALUES ('family', ?, ?, '#8a94a6', ?, ?, ?)", [f.name, f.description, Number(max?.m ?? 0) + 1, uid, uid]);
        familyIds.set(k, insertId);
      }
    }

    // 2. Products.
    const users = await rows<{ user_id: number; display_name: string }>(conn, 'SELECT user_id, display_name FROM app_user');
    const userId = (name: string | null) => (name ? (users.find((u) => u.display_name.toLowerCase() === name.toLowerCase())?.user_id ?? null) : null);
    const ids = new Map<string, number>();
    const audits: { code: string; action: 'CREATE' | 'UPDATE'; before?: unknown; after: unknown }[] = [];
    for (const p of parsed.products) {
      const pv = preview.products.find((x) => x.code === p.code)!;
      if (pv.action === 'unchanged') {
        ids.set(p.code, existing.get(p.code)!.product_id);
        continue;
      }
      const values = [
        p.name, p.family ? familyIds.get(p.family.toLowerCase())! : null, p.subfamily, p.brand, p.description, userId(p.owner), p.owner,
        p.priority ? await codeId(conn, 'priority', p.priority) : null, await codeId(conn, 'stage', p.stage), p.health ? await codeId(conn, 'health', p.health) : null,
        p.readinessPct, p.targetLaunch, p.actualLaunch, p.projectType ? await codeId(conn, 'project_type', p.projectType) : null,
        p.nextStep, p.nextStepDue, p.comment, p.lastEditedOn, p.updatedByName,
      ];
      const d = existing.get(p.code);
      if (!d) {
        const { insertId } = await exec(
          conn,
          `INSERT INTO pdt_product (code, name, family_id, subfamily, brand, description, owner_user_id, owner_name, priority_id, stage_id, health_id, readiness_pct,
                                    target_launch, actual_launch, project_type_id, next_step, next_step_due, comment, last_edited_on, updated_by_name,
                                    stage_since, created_by, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [p.code, ...values, today, uid, uid],
        );
        await exec(conn, 'INSERT INTO pdt_stage_history (product_id, from_stage_id, to_stage_id, changed_on, changed_by, comment) VALUES (?, NULL, ?, ?, ?, ?)', [insertId, await codeId(conn, 'stage', p.stage), today, uid, IMPORT_COMMENT]);
        ids.set(p.code, insertId);
        audits.push({ code: p.code, action: 'CREATE', after: p });
      } else {
        const stageChanged = d.stage !== p.stage;
        await exec(
          conn,
          `UPDATE pdt_product SET name = ?, family_id = ?, subfamily = ?, brand = ?, description = ?, owner_user_id = ?, owner_name = ?, priority_id = ?, stage_id = ?, health_id = ?,
                  readiness_pct = ?, target_launch = ?, actual_launch = ?, project_type_id = ?, next_step = ?, next_step_due = ?, comment = ?, last_edited_on = ?,
                  updated_by_name = ?, stage_since = IF(?, ?, stage_since), health_review_required = 0, updated_by = ?
            WHERE product_id = ?`,
          [...values, stageChanged ? 1 : 0, today, uid, d.product_id],
        );
        if (stageChanged) {
          await exec(conn, 'INSERT INTO pdt_stage_history (product_id, from_stage_id, to_stage_id, changed_on, changed_by, comment) VALUES (?, ?, ?, ?, ?, ?)', [d.product_id, d.stage_id, await codeId(conn, 'stage', p.stage), today, uid, IMPORT_COMMENT]);
        }
        ids.set(p.code, d.product_id);
        audits.push({ code: p.code, action: 'UPDATE', before: d, after: { ...p, changedFields: pv.fields } });
      }
    }
    const productId = async (code: string): Promise<number> => {
      if (ids.has(code)) return ids.get(code)!;
      const id = existing.get(code)?.product_id;
      if (!id) throw new Error(`product ${code} vanished during the import`);
      return id;
    };

    // 3. Blockers & decisions (upsert by ID).
    const touched = new Set<number>();
    for (const b of parsed.blockers) {
      const pid = await productId(b.code);
      touched.add(pid);
      const d = dbBlockers.get(b.externalId);
      const values = [pid, b.kind, b.title, b.requiredAction, userId(b.owner), b.owner, b.raisedOn, b.dueDate, b.status, b.resolutionNote, b.resolvedAt];
      if (d) {
        touched.add(d.product_id);
        await exec(conn, 'UPDATE pdt_blocker SET product_id = ?, kind = ?, title = ?, required_action = ?, owner_user_id = ?, owner_name = ?, raised_on = COALESCE(?, raised_on), due_date = ?, status = ?, resolution_note = ?, resolved_at = ?, updated_by = ? WHERE blocker_id = ?', [...values, uid, d.blocker_id]);
      } else {
        await exec(conn, 'INSERT INTO pdt_blocker (external_id, product_id, kind, title, required_action, owner_user_id, owner_name, raised_on, due_date, status, resolution_note, resolved_at, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, ?), ?, ?, ?, ?, ?, ?)', [
          b.externalId, pid, b.kind, b.title, b.requiredAction, userId(b.owner), b.owner, b.raisedOn, today, b.dueDate, b.status, b.resolutionNote, b.resolvedAt, uid, uid,
        ]);
      }
    }

    // 4. Status updates (append-only). The Products sheet stays the authority for health / readiness; an update only
    //    moves the product's "last update" date (the stale clock).
    const updated = new Set<number>();
    for (const u of newUpdates) {
      const pid = await productId(u.code);
      await exec(
        conn,
        `INSERT INTO pdt_status_update (product_id, update_date, health_id, readiness_pct, summary, next_step, next_step_due, updated_by_name, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [pid, u.updateDate, u.health ? await codeId(conn, 'health', u.health) : null, u.readinessPct, u.summary, u.nextStep, u.nextStepDue, u.updatedByName, uid, uid],
      );
      updated.add(pid);
    }
    for (const pid of updated) await syncLatestUpdate(conn, pid, uid, false);

    // 5. The Blocker rule (open Blocker -> Blocked) for every product the file touched.
    for (const pid of new Set([...touched, ...ids.values()])) await syncBlockerHealth(conn, pid, uid, false);

    const counts = preview.counts;
    const { insertId } = await exec(conn, 'INSERT INTO pdt_import_log (file_name, file_sha256, imported_by, counts, missing_codes) VALUES (?, ?, ?, CAST(? AS JSON), CAST(? AS JSON))', [
      fileName.slice(0, 255), sha, uid, JSON.stringify({ ...counts, healthForced: preview.healthForced.length }), JSON.stringify(preview.missingFromFile.map((m) => m.code)),
    ]);
    return { importId: insertId, preview, audits };
  });
  for (const a of result.audits) await writeAuditLog({ entityType: ENTITY.product, entityId: a.code, action: a.action, changedBy: uid, before: a.before, after: a.after });
  await writeAuditLog({ entityType: ENTITY.import, entityId: String(result.importId), action: 'CREATE', changedBy: uid, after: { fileName, sha256: sha, counts: result.preview.counts } });
  return { importId: result.importId, ...result.preview, canConfirm: false };
}

export async function importHistory(limit = 50) {
  const r = await rows<{ import_id: number; file_name: string; imported_at: unknown; imported_by: string | null; counts: unknown; missing_codes: unknown }>(
    pool,
    `SELECT l.import_id, l.file_name, l.imported_at, u.display_name AS imported_by, l.counts, l.missing_codes
       FROM pdt_import_log l LEFT JOIN app_user u ON u.user_id = l.imported_by ORDER BY l.imported_at DESC, l.import_id DESC LIMIT ?`,
    [limit],
  );
  const json = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);
  return r.map((x) => ({ importId: x.import_id, fileName: x.file_name, importedAt: isoDateTime(x.imported_at), importedBy: x.imported_by, counts: json(x.counts), missingCodes: json(x.missing_codes) ?? [] }));
}

// ---------------------------------------------------------------------------------------------------------------------
// Export in the same format (round trip: export -> edit -> import)
// ---------------------------------------------------------------------------------------------------------------------

const asDate = (d: string | null | undefined) => (d ? new Date(`${d}T00:00:00Z`) : null);

export async function exportWorkbook(today = businessToday()): Promise<Buffer> {
  const [products, blockers, dropdowns, settings, updates, extra] = await Promise.all([
    loadProducts(), loadBlockers(), listDropdowns(), getSettings(),
    rows<{ update_date: unknown; code: string; name: string; health: HealthCode | null; readiness_pct: number | null; summary: string; next_step: string | null; next_step_due: unknown; updated_by: string | null }>(
      pool,
      `SELECT u.update_date, p.code, p.name, h.code AS health, u.readiness_pct, u.summary, u.next_step, u.next_step_due, COALESCE(u.updated_by_name, a.display_name) AS updated_by
         FROM pdt_status_update u JOIN pdt_product p ON p.product_id = u.product_id AND p.deleted_at IS NULL
         LEFT JOIN pdt_dropdown_value h ON h.value_id = u.health_id LEFT JOIN app_user a ON a.user_id = u.updated_by
        WHERE u.deleted_at IS NULL ORDER BY u.update_date, u.update_id`,
    ),
    rows<{ code: string; description: string | null; comment: string | null; last_edited_on: unknown; updated_by_name: string | null }>(pool, 'SELECT code, description, comment, last_edited_on, updated_by_name FROM pdt_product WHERE deleted_at IS NULL'),
  ]);
  const more = new Map(extra.map((x) => [x.code, x]));
  const open = new Map<number, number>();
  for (const b of blockers) if (b.status === 'OPEN' || b.status === 'IN_PROGRESS') open.set(b.productId, (open.get(b.productId) ?? 0) + 1);
  const wb = new ExcelJS.Workbook();
  const readme = wb.addWorksheet('Read me');
  readme.addRows([
    ['Product Development – data input'],
    [`Exported from the dashboard on ${today}. Edit and upload it again under Product Development Plan › Data entry & follow-up › Excel import.`],
    ['Products', 'Upsert by Code. Never delete a row – set the stage instead. New products: next code at the bottom.'],
    ['Status updates', 'Add a NEW row per update. Exact duplicates (date + code + summary) are skipped.'],
    ['Blockers & decisions', 'Upsert by ID. Resolved needs a resolution note and the resolved date.'],
    ['Readiness %', '0% to 100% (45% or 0.45).'],
    ['Brand', 'Products › Brand (last column): pick from Lists › Brand. Blank = Unassigned.'],
  ]);
  readme.getColumn(1).width = 24;
  readme.getColumn(2).width = 110;

  const sheet = (name: string, cols: [string, number][], dateCols: number[], pctCols: number[] = []) => {
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = cols.map(([header, width]) => ({ header, width }));
    ws.getRow(1).font = { bold: true };
    for (const c of dateCols) ws.getColumn(c).numFmt = 'dd/mm/yyyy';
    for (const c of pctCols) ws.getColumn(c).numFmt = '0%';
    return ws;
  };
  const P = sheet(SHEETS.products, [...PRODUCT_COLUMNS, 'Days to launch', 'Flag', PRODUCT_BRAND].map((h) => [h, h === 'Description' || h === 'Comment' ? 40 : h === 'Product name' ? 28 : 16] as [string, number]), [11, 12, 15, 17], [10]);
  for (const p of products) {
    const m = more.get(p.code);
    const flag = productFlag(p, open.get(p.productId) ?? 0, today, settings);
    P.addRow([
      p.code, p.name, p.family, p.subfamily, m?.description ?? null, STAGE_LABEL[p.stage], p.health ? HEALTH_LABEL[p.health] : null, p.priority ? PRIORITY_LABEL[p.priority] : null,
      p.ownerName, p.readinessPct === null ? null : p.readinessPct / 100, asDate(p.targetLaunch), asDate(p.actualLaunch), p.projectType ? PROJECT_LABEL[p.projectType] : null,
      p.nextStep, asDate(p.nextStepDue), m?.comment ?? null, asDate(isoDate(m?.last_edited_on)), m?.updated_by_name ?? null,
      p.stage === 'LAUNCHED' || !p.targetLaunch ? null : daysBetween(today, p.targetLaunch),
      flag ? { OPEN_BLOCKER: 'Open blocker', TARGET_PASSED: 'Target date passed', HEALTH_NOT_SET: 'Health not set', LAUNCH_SOON_LOW_READINESS: 'Launch soon, low readiness' }[flag] : null,
      p.brand === UNASSIGNED_BRAND ? null : p.brand,
    ]);
  }
  const U = sheet(SHEETS.updates, [['Update date', 13], ['Product code', 12], ['Product name (auto)', 28], ['Health', 11], ['Readiness %', 11], ['Progress summary', 50], ['Next step', 30], ['Next step due', 13], ['Updated by', 18]], [1, 8], [5]);
  for (const u of updates) U.addRow([asDate(isoDate(u.update_date)), u.code, u.name, u.health ? HEALTH_LABEL[u.health] : null, u.readiness_pct === null ? null : Number(u.readiness_pct) / 100, u.summary, u.next_step, asDate(isoDate(u.next_step_due)), u.updated_by]);
  const byId = new Map(products.map((p) => [p.productId, p]));
  const B = sheet(SHEETS.blockers, [['ID', 9], ['Product code', 12], ['Product name (auto)', 28], ['Type', 16], ['Title', 32], ['Required action / decision', 40], ['Owner', 18], ['Raised on', 12], ['Due date', 12], ['Status', 12], ['Resolution note', 34], ['Resolved date', 13], ['Overdue? (auto)', 10]], [8, 9, 12]);
  for (const b of [...blockers].sort((a, c) => (a.externalId ?? '').localeCompare(c.externalId ?? '', undefined, { numeric: true }))) {
    const p = byId.get(b.productId);
    if (!p) continue;
    const overdue = (b.status === 'OPEN' || b.status === 'IN_PROGRESS') && b.dueDate < today;
    B.addRow([b.externalId, p.code, p.name, KIND_LABEL[b.kind], b.title, b.requiredAction, b.ownerName, asDate(b.raisedOn), asDate(b.dueDate), STATUS_LABEL[b.status], b.resolutionNote, asDate(b.resolvedAt), overdue ? 'OVERDUE' : null]);
  }
  const L = sheet(SHEETS.lists, [['Stage', 14], ['Health', 11], ['Priority', 10], ['Project type', 14], ['Blocker type', 16], ['Blocker status', 14], ['Owners (type names)', 22], [LIST_FAMILY, 30], [LIST_FAMILY_DESC, 90], [PRODUCT_BRAND, 20]], []);
  const fams = dropdowns.filter((d) => d.list_key === 'family' && d.is_active);
  const owners = [...new Set(products.map((p) => p.ownerName).filter((o): o is string => Boolean(o)))].sort();
  const brands = [...new Set(products.map((p) => p.brand).filter((b) => b !== UNASSIGNED_BRAND))].sort();
  const cols = [
    STAGES.map((s) => STAGE_LABEL[s]), HEALTHS.map((h) => HEALTH_LABEL[h]), PRIORITIES.map((p) => PRIORITY_LABEL[p]), PROJECT_TYPES.map((p) => PROJECT_LABEL[p]),
    ['Blocker', 'Decision needed'], BLOCKER_STATUSES.map((s) => STATUS_LABEL[s]), owners, fams.map((f) => f.label), fams.map((f) => f.description ?? ''), brands,
  ];
  const n = Math.max(...cols.map((c) => c.length));
  for (let i = 0; i < n; i += 1) L.addRow(cols.map((c) => c[i] ?? null));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
