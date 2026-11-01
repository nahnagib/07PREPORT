import ExcelJS from 'exceljs';
import { ValidationError } from '../lib/errors';
import { assertSafeXlsx } from './zipGuard';
import {
  ColSpec, DEFAULT_SPEND_CATEGORIES, EXAMPLE_FILL, MONTHS, TABLES, TABLE_LABELS, TableSpec, TEMPLATE_VERSION, YEAR_MAX, YEAR_MIN,
} from './templateConfig';

export type TableId = TableSpec['id'];

export interface Issue {
  severity: 'error' | 'warning';
  sheet: string;
  table: TableId | '';
  /** A1 reference, or '' for a sheet/table-level message. */
  cell: string;
  /** Stable machine-readable code (see ISSUE_CODES in parser.ts) -- safe for UI/tests to key on. */
  code: string;
  message: string;
}

export interface ParsedRow {
  table: TableId;
  sheet: string;
  rowNumber: number;
  /** Natural key, lower-cased -- identical across files for the same logical record. */
  key: string;
  data: Record<string, string | number | null>;
}

export interface TableResult {
  rows: ParsedRow[];
  emptyRows: number;
  exampleRowsSkipped: number;
}

export interface ParseResult {
  templateVersion: string;
  tables: Record<TableId, TableResult>;
  issues: Issue[];
  exampleRowsSkipped: number;
}

export interface ParseOptions {
  /** Tests only -- never exposed in the UI. Keeps the shipped example rows instead of skipping them. */
  includeExamples?: boolean;
  /** Campaign names already stored, so a P2-B row may reference a campaign from an earlier upload. */
  knownCampaigns?: Iterable<string>;
  /** Brand names already stored. A brand outside this set raises a "new brand" warning (skipped when empty). */
  knownBrands?: Iterable<string>;
  /**
   * Names of group-level entries (marcom_brand.kind = 'GROUP', e.g. BMH = group events). Their P1 rows carry spend but
   * no brand revenue, so the revenue columns are optional for them. Default: none.
   */
  groupBrands?: Iterable<string>;
  /** Allowed Other-spend categories (marcom_spend_category). Default: DEFAULT_SPEND_CATEGORIES. */
  knownCategories?: Iterable<string>;
}

export class TemplateStructureError extends ValidationError {
  constructor(public problems: string[]) {
    super(`The file does not match the MARCOM template (version ${TEMPLATE_VERSION}): ${problems.join(' ')}`);
  }
}

// ---------------------------------------------------------------- helpers

const sig = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9#]+/g, '');

export function colLetter(n: number): string {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

/** Strips control chars, angle brackets and surplus whitespace; caps length. */
export function sanitizeText(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function normalizeDigits(s: string): string {
  return s
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/\u066b/g, '.')
    .replace(/[\u066c\u00a0\u202f]/g, '');
}

interface RawCell {
  value: unknown;
  formulaNoResult: boolean;
  isErrorValue: boolean;
}

function readCell(cell: ExcelJS.Cell): RawCell {
  let v: unknown = cell.value;
  let formulaNoResult = false;
  let isErrorValue = false;
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const o = v as Record<string, unknown>;
    if ('formula' in o || 'sharedFormula' in o) {
      if (o.result === undefined || o.result === null) {
        formulaNoResult = true;
        v = null;
      } else if (typeof o.result === 'object' && !(o.result instanceof Date) && 'error' in (o.result as object)) {
        isErrorValue = true;
        v = null;
      } else {
        v = o.result;
      }
    } else if ('richText' in o && Array.isArray(o.richText)) {
      v = (o.richText as { text: string }[]).map((r) => r.text).join('');
    } else if ('text' in o) {
      v = o.text;
    } else if ('error' in o) {
      isErrorValue = true;
      v = null;
    }
  }
  if (typeof v === 'string' && v.trim() === '') v = null;
  return { value: v ?? null, formulaNoResult, isErrorValue };
}

const isExampleFill = (cell: ExcelJS.Cell): boolean => {
  const f = cell.fill as { type?: string; fgColor?: { argb?: string } } | undefined;
  return f?.type === 'pattern' && !!f.fgColor?.argb && f.fgColor.argb.toUpperCase().endsWith(EXAMPLE_FILL);
};

function pad(n: number) { return String(n).padStart(2, '0'); }

function validYmd(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Real Excel dates, serial numbers, ISO text and DD/MM/YYYY text -> 'YYYY-MM-DD' (never MM/DD). */
export function parseDate(v: unknown): string | null {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return validYmd(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate());
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 1 || v > 2958465) return null;
    const dt = new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000);
    return validYmd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }
  if (typeof v === 'string') {
    const s = normalizeDigits(v.trim());
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s);
    if (m) return validYmd(+m[1], +m[2], +m[3]);
    m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/.exec(s);
    if (m) return validYmd(+m[3], +m[2], +m[1]);
    if (/^\d+(\.\d+)?$/.test(s)) return parseDate(Number(s));
  }
  return null;
}

function parseNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const s = normalizeDigits(v).replace(/[\s,]/g, '');
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return Number(s);
  }
  return null;
}

// ---------------------------------------------------------------- coercion

interface Coerced { value: string | number | null; error?: string; warning?: string; code?: string }

function coerce(col: ColSpec, raw: unknown, knownBrands: Set<string> | null, brandSeen: Set<string>, categories: string[]): Coerced {
  const label = col.label;
  switch (col.kind) {
    case 'year': {
      const n = parseNumber(raw);
      if (n === null || !Number.isInteger(n)) return { value: null, error: `${label} must be a whole year like 2026.`, code: 'INVALID_YEAR' };
      if (n < YEAR_MIN || n > YEAR_MAX) return { value: null, error: `${label} ${n} is outside ${YEAR_MIN}-${YEAR_MAX}.`, code: 'YEAR_OUT_OF_RANGE' };
      return { value: n };
    }
    case 'month': {
      const s = String(raw ?? '').trim().toLowerCase();
      const idx = MONTHS.findIndex((m) => m.toLowerCase() === s);
      if (idx < 0) return { value: null, error: `"${String(raw).trim()}" is not a valid month name (use ${MONTHS[0]}...${MONTHS[11]}).`, code: 'INVALID_MONTH' };
      return { value: idx + 1 };
    }
    case 'text': {
      const s = sanitizeText(String(raw));
      return s ? { value: s } : { value: null, error: `${label} is required.`, code: 'REQUIRED_MISSING' };
    }
    case 'brand': {
      const s = sanitizeText(String(raw));
      if (!s) return { value: null, error: `${label} is required.`, code: 'REQUIRED_MISSING' };
      const k = s.toLowerCase();
      if (knownBrands && knownBrands.size > 0 && !knownBrands.has(k) && !brandSeen.has(k)) {
        brandSeen.add(k);
        return { value: s, warning: `New brand "${s}" will be created. Check the spelling if this is unexpected.`, code: 'NEW_BRAND' };
      }
      return { value: s };
    }
    case 'category': {
      const s = String(raw ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
      const hit = categories.find((c) => c.toLowerCase() === s);
      return hit
        ? { value: hit }
        : { value: null, error: `"${String(raw).trim()}" is not a known ${label} (${categories.join(', ')}). Pick one from the list.`, code: 'INVALID_CATEGORY' };
    }
    case 'enum': {
      const s = String(raw ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
      const hit = col.enumValues!.find((e) => e.toLowerCase() === s);
      return hit
        ? { value: hit }
        : { value: null, error: `"${String(raw).trim()}" is not an allowed ${label} (${col.enumValues!.join(', ')}).`, code: 'INVALID_ENUM' };
    }
    case 'date': {
      const d = parseDate(raw);
      return d ? { value: d } : { value: null, error: `${label} is not a valid date (use a date, YYYY-MM-DD or DD/MM/YYYY).`, code: 'INVALID_DATE' };
    }
    case 'int':
    case 'money':
    case 'decimal': {
      const n = parseNumber(raw);
      if (n === null) return { value: null, error: `${label} must be a number.`, code: 'INVALID_NUMBER' };
      if (n < 0) return { value: null, error: `${label} cannot be negative (${n}).`, code: 'NEGATIVE_NUMBER' };
      if (col.kind === 'int') {
        if (!Number.isInteger(n)) return { value: null, error: `${label} must be a whole number.`, code: 'NOT_INTEGER' };
        return { value: n };
      }
      return { value: Math.round(n * 100) / 100 };
    }
    case 'pct': {
      let s = raw;
      let explicitPercent = false;
      if (typeof raw === 'string' && raw.trim().endsWith('%')) { s = raw.trim().slice(0, -1); explicitPercent = true; }
      const n = parseNumber(s);
      if (n === null) return { value: null, error: `${label} must be a percentage.`, code: 'INVALID_PERCENT' };
      if (n < 0) return { value: null, error: `${label} cannot be negative.`, code: 'NEGATIVE_NUMBER' };
      if (explicitPercent) return n <= 100 ? { value: n / 100 } : { value: null, error: `${label} ${n}% is out of range (0-100%).`, code: 'PERCENT_OUT_OF_RANGE' };
      if (n <= 1) return { value: n };
      if (n <= 100) return { value: n / 100, warning: `${label} entered as ${n}; read as ${n}%. Enter percentages as fractions (e.g. 0.94) or with a % sign.`, code: 'PERCENT_SCALED' };
      return { value: null, error: `${label} ${n} is out of range (0-100%).`, code: 'PERCENT_OUT_OF_RANGE' };
    }
  }
}

// ---------------------------------------------------------------- shipped example rows

type D = ParsedRow['data'];
const EXAMPLES: Partial<Record<TableId, (d: D) => boolean>> = {
  spend: (d) => d.year === 2026 && d.month === 9 && d.brand === 'Xtreme' && d.brandRevenueCurrent === 3000000 && d.revenueAttributed === 450000,
  // Not keyed on the category: the example must still be recognised when the DB category list no longer has it.
  other: (d) => d.year === 2026 && d.month === 9 && d.brand === 'Xtreme' && d.description === 'Staff polo shirts – showroom team' && d.amount === 25000,
  campaigns: (d) => d.name === 'Ramadan Lighting Campaign' && d.spend === 120000 && d.revenueAttributed === 650000,
  media: (d) => d.campaignName === 'Ramadan Lighting Campaign' && d.mediaType === '1-Street Lights' && d.city === 'Tripoli' && d.units === 45 && d.cost === 30000,
  social: (d) => d.year === 2026 && d.month === 9 && d.brand === 'Xtreme' && d.platform === 'Instagram' && d.followers === 52000 && d.impressions === 180000,
  web: (d) => d.year === 2026 && d.month === 9 && d.brand === 'Xtreme' && d.bounceVisitors === 3400 && d.totalVisitors === 12000,
  trade: (d) => d.year === 2026 && d.month === 8 && d.compliancePct === 0.94,
  events: (d) => d.name === 'Product Launch Night - Brand A',
};

/** Soft data-quality warnings that don't block an import. */
const CROSS_CHECKS: Partial<Record<TableId, (d: D) => { field: string; code: string; message: string }[]>> = {
  spend: (d) => [
    ...(d.budget === 0 ? [{ field: 'budget', code: 'ZERO_BUDGET', message: 'Budget is 0 - budget utilization will show n/a.' }] : []),
    ...(d.brandRevenueCurrent !== null && d.companyRevenueTotal !== null && Number(d.brandRevenueCurrent) === Number(d.companyRevenueTotal) && Number(d.brandRevenueCurrent) > 0
      ? [{ field: 'brandRevenueCurrent', code: 'BRAND_REVENUE_EQUALS_COMPANY', message: 'Brand Revenue equals Company Total Revenue. Brand Revenue is the sales of THIS brand only - check that the company total was not entered here.' }] : []),
  ],
  other: (d) => d.amount === 0 ? [{ field: 'amount', code: 'ZERO_AMOUNT', message: 'Amount is 0 - remove the line if there was no spend.' }] : [],
  social: (d) => [
    ...(Number(d.clicks) > Number(d.impressions) ? [{ field: 'clicks', code: 'CLICKS_GT_IMPRESSIONS', message: 'Clicks exceed impressions.' }] : []),
    ...(Number(d.engagementPaid) + Number(d.engagementOrganic) > Number(d.impressions)
      ? [{ field: 'engagementPaid', code: 'ENGAGEMENT_GT_IMPRESSIONS', message: 'Total engagement exceeds impressions.' }] : []),
  ],
  web: (d) => Number(d.bounceVisitors) > Number(d.totalVisitors)
    ? [{ field: 'bounceVisitors', code: 'BOUNCE_GT_VISITORS', message: 'Bounce visitors exceed total visitors.' }] : [],
  trade: (d) => Number(d.attendeesActual) > Number(d.attendeesExpected)
    ? [{ field: 'attendeesActual', code: 'ATTENDANCE_GT_EXPECTED', message: 'Actual attendees exceed expected attendees.' }] : [],
};

// ---------------------------------------------------------------- P1 revenue rules

const REVENUE_FIELDS = ['brandRevenueCurrent', 'brandRevenueLy', 'revenueAttributed'] as const;

function cellOf(spec: TableSpec, field: string, row: number): string {
  return `${colLetter(spec.cols.find((c) => c.field === field)!.col)}${row}`;
}

/** Brand rows need the three brand-level revenue inputs; attributed <= brand revenue <= company total. */
function spendRevenueIssues(spec: TableSpec, r: number, d: D, groups: Set<string>): Issue[] {
  const out: Issue[] = [];
  const err = (field: string, code: string, message: string) =>
    out.push({ severity: 'error', sheet: spec.sheet, table: spec.id, cell: cellOf(spec, field, r), code, message });
  const isGroup = typeof d.brand === 'string' && groups.has(d.brand.toLowerCase());
  if (!isGroup) {
    for (const f of REVENUE_FIELDS) {
      if (d[f] === null) err(f, 'REQUIRED_MISSING', `${spec.cols.find((c) => c.field === f)!.label} is required (monthly, this brand only - never YTD).`);
    }
  }
  const brandRev = d.brandRevenueCurrent;
  if (typeof brandRev === 'number' && typeof d.revenueAttributed === 'number' && d.revenueAttributed > brandRev) {
    err('revenueAttributed', 'ATTRIBUTED_GT_BRAND_REVENUE', `Revenue Attributed to Marketing (${d.revenueAttributed}) is more than Brand Revenue (${brandRev}). It must be the part of Brand Revenue that came from marketing.`);
  }
  if (typeof brandRev === 'number' && typeof d.companyRevenueTotal === 'number' && brandRev > d.companyRevenueTotal) {
    err('brandRevenueCurrent', 'BRAND_REVENUE_GT_COMPANY', `Brand Revenue (${brandRev}) is more than Company Total Revenue (${d.companyRevenueTotal}).`);
  }
  return out;
}

/** Money columns of P1 checked for outliers / copies / constants. */
const PLAUSIBILITY_FIELDS = ['brandRevenueCurrent', 'brandRevenueLy', 'revenueAttributed', 'companyRevenueTotal', 'budget', 'financeBookedTotal'] as const;
export const OUTLIER_FACTOR = 5;

function median(xs: number[]): number {
  const v = [...xs].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * Warnings only (the manager may have a real reason): a value over 5x the brand's median month in the file, the same
 * column holding identical values for two brands (3+ shared months, copy-paste), and one value repeated in every row.
 */
export function spendPlausibility(rows: ParsedRow[], groups: Set<string> = new Set()): Issue[] {
  const spec = TABLES.find((t) => t.id === 'spend')!;
  const out: Issue[] = [];
  const warn = (field: string, row: number, code: string, message: string) =>
    out.push({ severity: 'warning', sheet: spec.sheet, table: 'spend', cell: cellOf(spec, field, row), code, message });
  const label = (f: string) => spec.cols.find((c) => c.field === f)!.label;
  const byBrand = new Map<string, ParsedRow[]>();
  for (const r of rows) {
    const b = typeof r.data.brand === 'string' ? r.data.brand : null;
    if (!b) continue;
    const list = byBrand.get(b.toLowerCase()) ?? [];
    list.push(r);
    byBrand.set(b.toLowerCase(), list);
  }
  const num = (r: ParsedRow, f: string) => (typeof r.data[f] === 'number' ? (r.data[f] as number) : null);

  for (const f of PLAUSIBILITY_FIELDS) {
    // > 5x the brand's median month
    for (const list of byBrand.values()) {
      const vals = list.map((r) => num(r, f)).filter((v): v is number => v !== null && v > 0);
      if (vals.length < 3) continue;
      const med = median(vals);
      for (const r of list) {
        const v = num(r, f);
        if (v !== null && med > 0 && v > OUTLIER_FACTOR * med) {
          warn(f, r.rowNumber, 'OUTLIER_VS_MEDIAN', `${label(f)} ${v.toLocaleString('en-US')} is more than ${OUTLIER_FACTOR}x ${r.data.brand}'s median month (${med.toLocaleString('en-US')}). Typo (an extra zero)?`);
        }
      }
    }
    // identical values copied across brands
    const brands = [...byBrand.entries()].filter(([b]) => !groups.has(b));
    for (let i = 0; i < brands.length; i++) {
      for (let j = i + 1; j < brands.length; j++) {
        const [, a] = brands[i];
        const [, b] = brands[j];
        const am = new Map(a.map((r) => [`${r.data.year}-${r.data.month}`, num(r, f)]));
        const shared = b.filter((r) => am.has(`${r.data.year}-${r.data.month}`) && num(r, f) !== null && am.get(`${r.data.year}-${r.data.month}`) !== null);
        if (shared.length >= 3 && shared.every((r) => num(r, f) === am.get(`${r.data.year}-${r.data.month}`)) && shared.some((r) => (num(r, f) ?? 0) !== 0)) {
          warn(f, shared[0].rowNumber, 'COPIED_ACROSS_BRANDS', `${label(f)} of ${b[0].data.brand} is identical to ${a[0].data.brand} in all ${shared.length} shared months - copied by mistake?`);
        }
      }
    }
    // one value in every row
    const all = rows.map((r) => num(r, f)).filter((v): v is number => v !== null);
    if (all.length >= 6 && byBrand.size >= 1 && all.every((v) => v === all[0]) && all[0] !== 0) {
      warn(f, rows.find((r) => num(r, f) !== null)!.rowNumber, 'SAME_VALUE_EVERY_ROW', `${label(f)} is ${all[0].toLocaleString('en-US')} in every row (${all.length} rows). Is it a real figure or a placeholder?`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- table location

function locateHeader(ws: ExcelJS.Worksheet, spec: TableSpec, fromRow: number): { row: number; problems: string[] } {
  const cols = spec.cols;
  const scoreRow = (r: number) => {
    const row = ws.getRow(r);
    return cols.filter((c) => sig(readCell(row.getCell(c.col)).value).startsWith(sig(c.label))).length;
  };
  const last = Math.min(ws.rowCount || spec.headerRow, spec.headerRow + 60);
  let best = -1;
  let bestScore = -1;
  for (let r = Math.max(1, fromRow); r <= Math.max(last, spec.headerRow); r++) {
    const s = scoreRow(r);
    // Prefer a full match; on ties prefer the row closest to the template position.
    if (s > bestScore || (s === bestScore && Math.abs(r - spec.headerRow) < Math.abs(best - spec.headerRow))) {
      best = r; bestScore = s;
    }
  }
  if (bestScore === cols.length) return { row: best, problems: [] };
  const r = bestScore > 0 ? best : spec.headerRow;
  const row = ws.getRow(r);
  const problems = cols
    .filter((c) => !sig(readCell(row.getCell(c.col)).value).startsWith(sig(c.label)))
    .map((c) => `Sheet '${spec.sheet}' (${TABLE_LABELS[spec.id]}): expected header '${c.label}' in column ${colLetter(c.col)} of row ${r}.`);
  return { row: r, problems };
}

// ---------------------------------------------------------------- main

export async function parseMarcomWorkbook(buffer: Buffer, filename: string, opts: ParseOptions = {}): Promise<ParseResult> {
  assertSafeXlsx(buffer, filename);

  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as never);
  } catch {
    throw new ValidationError('The file could not be read as an .xlsx workbook. Open it in Excel, re-save as .xlsx and try again.');
  }

  const sheets = new Map<string, ExcelJS.Worksheet>();
  for (const s of new Set(TABLES.map((t) => t.sheet))) {
    const ws = wb.worksheets.find((w) => sig(w.name) === sig(s));
    if (!ws) throw new TemplateStructureError([`Sheet '${s}' is missing or was renamed.`]);
    sheets.set(s, ws);
  }

  // 1. Locate every table first so a structure problem is reported in full, before any row is read.
  const located = new Map<TableId, number>();
  const problems: string[] = [];
  const lastHeaderOnSheet = new Map<string, number>();
  for (const spec of TABLES) {
    const ws = sheets.get(spec.sheet)!;
    const from = (lastHeaderOnSheet.get(spec.sheet) ?? 0) + 1;
    const { row, problems: p } = locateHeader(ws, spec, from);
    problems.push(...p);
    located.set(spec.id, row);
    lastHeaderOnSheet.set(spec.sheet, row);
  }
  if (problems.length) throw new TemplateStructureError(problems);

  // 2. Read rows.
  const issues: Issue[] = [];
  const known = opts.knownBrands ? new Set([...opts.knownBrands].map((b) => b.toLowerCase())) : null;
  const groups = new Set([...(opts.groupBrands ?? [])].map((b) => b.toLowerCase()));
  const categories = opts.knownCategories ? [...opts.knownCategories] : [...DEFAULT_SPEND_CATEGORIES];
  const brandSeen = new Set<string>();
  const tables = {} as Record<TableId, TableResult>;

  for (const spec of TABLES) {
    const ws = sheets.get(spec.sheet)!;
    const header = located.get(spec.id)!;
    const lastRow = header + (spec.lastRow - spec.headerRow);
    const result: TableResult = { rows: [], emptyRows: 0, exampleRowsSkipped: 0 };
    const seen = new Map<string, number>();
    const push = (severity: Issue['severity'], code: string, cell: string, message: string) =>
      issues.push({ severity, sheet: spec.sheet, table: spec.id, cell, code, message });

    for (let r = header + 1; r <= lastRow; r++) {
      const row = ws.getRow(r);
      const rawByField: Record<string, RawCell> = {};
      let anyValue = false;
      let green = false;
      for (const c of spec.cols) {
        const cell = row.getCell(c.col);
        const rc = readCell(cell);
        rawByField[c.field] = rc;
        if (rc.value !== null) anyValue = true;
        if (isExampleFill(cell)) green = true;
        if (rc.formulaNoResult) {
          push('warning', 'FORMULA_NO_VALUE', cell.address, `Cell ${cell.address} has a formula with no calculated value - open the file in Excel, save, and re-upload.`);
        }
        if (rc.isErrorValue) push('error', 'EXCEL_ERROR_VALUE', cell.address, `Cell ${cell.address} contains an Excel error value.`);
      }
      // A pre-filled row (Year/Month/Brand/Platform only, nothing typed) counts as empty.
      const prefill = spec.prefillFields;
      const typed = !prefill || spec.cols.some((c) => !prefill.includes(c.field) && rawByField[c.field].value !== null);
      if (!anyValue || !typed) { result.emptyRows++; continue; }

      const rowIssues: Issue[] = [];
      const data: D = {};
      for (const c of spec.cols) {
        const cellRef = `${colLetter(c.col)}${r}`;
        const rc = rawByField[c.field];
        if (rc.value === null) {
          data[c.field] = null;
          if (c.required && !rc.isErrorValue) {
            rowIssues.push({ severity: 'error', sheet: spec.sheet, table: spec.id, cell: cellRef, code: 'REQUIRED_MISSING', message: `${c.label} is required.` });
          }
          continue;
        }
        const out = coerce(c, rc.value, known, brandSeen, categories);
        data[c.field] = out.value;
        if (out.error) rowIssues.push({ severity: 'error', sheet: spec.sheet, table: spec.id, cell: cellRef, code: out.code ?? 'INVALID_VALUE', message: out.error });
        if (out.warning) rowIssues.push({ severity: 'warning', sheet: spec.sheet, table: spec.id, cell: cellRef, code: out.code ?? 'WARNING', message: out.warning });
      }

      const isExample = EXAMPLES[spec.id]?.(data) === true;
      if (green && isExample && !opts.includeExamples) { result.exampleRowsSkipped++; continue; }
      if (green && !isExample) {
        rowIssues.push({ severity: 'warning', sheet: spec.sheet, table: spec.id, cell: `A${r}`, code: 'EXAMPLE_COLOUR', message: 'Row still has the example colour (green) but different values - imported as real data.' });
      }

      if (spec.id === 'social' && data.accountName === null) data.accountName = '';
      if (spec.id === 'spend') rowIssues.push(...spendRevenueIssues(spec, r, data, groups));

      // Date order (P2-A).
      if (spec.id === 'campaigns' && typeof data.startDate === 'string' && typeof data.endDate === 'string' && data.endDate < data.startDate) {
        rowIssues.push({ severity: 'error', sheet: spec.sheet, table: spec.id, cell: `D${r}`, code: 'END_BEFORE_START', message: 'End Date is before Start Date.' });
      }
      if (spec.id === 'events' && typeof data.completionDate === 'string' && typeof data.plannedDate === 'string' && data.completionDate < data.plannedDate) {
        rowIssues.push({ severity: 'warning', sheet: spec.sheet, table: spec.id, cell: `E${r}`, code: 'COMPLETION_BEFORE_PLANNED', message: 'Completion Date is before Planned Date.' });
      }
      for (const w of CROSS_CHECKS[spec.id]?.(data) ?? []) {
        const col = spec.cols.find((c) => c.field === w.field)!;
        rowIssues.push({ severity: 'warning', sheet: spec.sheet, table: spec.id, cell: `${colLetter(col.col)}${r}`, code: w.code, message: w.message });
      }

      // Duplicate natural key inside this file.
      const key = spec.keyFields.map((f) => String(data[f] ?? '').toLowerCase()).join('|');
      const hasKey = spec.keyFields.every((f) => data[f] !== null);
      if (hasKey) {
        const prev = seen.get(key);
        if (prev !== undefined) {
          const dupMsg = spec.id === 'events'
            ? `Duplicate event (same Event Name and Brand as row ${prev}). Make recurring event names unique, e.g. add the month.`
            : `Duplicate key - the same record already appears in row ${prev} of this table.`;
          rowIssues.push({ severity: 'error', sheet: spec.sheet, table: spec.id, cell: `A${r}`, code: 'DUPLICATE_KEY', message: dupMsg });
        } else {
          seen.set(key, r);
        }
      }

      issues.push(...rowIssues);
      result.rows.push({ table: spec.id, sheet: spec.sheet, rowNumber: r, key, data });
    }
    tables[spec.id] = result;
  }

  // 3a. Cross-row plausibility on P1 (warnings): outliers, columns copied across brands, one value in every row.
  issues.push(...spendPlausibility(tables.spend.rows, groups));

  // 3. Cross-table: P2-B campaign must exist in P2-A (this file or stored).
  const campaignNames = new Set(tables.campaigns.rows.map((r) => String(r.data.name).toLowerCase()));
  for (const n of opts.knownCampaigns ?? []) campaignNames.add(n.toLowerCase());
  // A campaign whose P2-A row was an (skipped) example still counts as present for its own example P2-B row.
  for (const row of tables.media.rows) {
    const name = row.data.campaignName;
    if (typeof name === 'string' && !campaignNames.has(name.toLowerCase())) {
      issues.push({
        severity: 'error', sheet: row.sheet, table: row.table, cell: `A${row.rowNumber}`, code: 'UNKNOWN_CAMPAIGN',
        message: `Campaign "${name}" was not found in the Campaign Master table (this file or previously uploaded data).`,
      });
    }
  }

  const exampleRowsSkipped = Object.values(tables).reduce((n, t) => n + t.exampleRowsSkipped, 0);
  return { templateVersion: TEMPLATE_VERSION, tables, issues, exampleRowsSkipped };
}
