import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PoolConnection } from 'mysql2/promise';
import { pool } from '../../db/pool';
import { writeAuditLog } from '../auditLogService';
import { PdpError } from './errors';
import { exec, one, rows } from './db';
import { tikaCompanyKey } from './company';
import { ensureConfigSeed, SEED_CRITERIA } from './seedConfig';
import { parsePolicyDocx, parseProductTree, parseScoringMatrix, type Correction, type Unplaced } from './importParsers';
import { writeProductHistory } from './treeService';

/**
 * One-time seed import (Admin role only) of the CEO's files:
 *   Product_Tree.xlsm      -> brand, families (+ Sheet1 descriptions), subfamilies, products
 *   RD_Scoring_Matrix.xlsx -> checked against the seeded criteria (reported, never overwritten)
 *   R_D_Policy.docx        -> policy version 1.0 (21 sections), published
 * Idempotent on natural keys (family name; family + subfamily; product name; version 1.0): a re-run creates nothing,
 * and an existing row is never overwritten (edits made in the app win). Everything runs in ONE transaction; a dry run
 * rolls it back, so its counts are exactly what a commit would do.
 *
 * Files come from the upload (production), or -- test stack only -- from the folder named by PDP_IMPORT_DIR.
 */

export const IMPORT_FILES = { productTree: 'Product_Tree.xlsm', scoringMatrix: 'RD_Scoring_Matrix.xlsx', policy: 'R_D_Policy.docx' } as const;
export type ImportFiles = Partial<Record<keyof typeof IMPORT_FILES, Buffer>>;

interface Counts { created: number; updated: number; skipped: number }

export interface ImportReport {
  mode: 'dry-run' | 'commit';
  sources: Record<string, string>;
  configSeeded: number;
  tables: Record<string, Counts>;
  corrections: Correction[];
  unplaced: Unplaced[];
  tree: { families: number; subfamilies: number; products: number; byStatus: Record<string, number>; flexible: number };
  scoring: { criteria: { name: string; weight: number; status: 'same' | 'differs' | 'missing_in_app'; differences: string[] }[]; problems: string[] };
  policy: { version: string; title: string; sections: number; status: 'created' | 'skipped' } | null;
  odooMatches: { product: string; candidates: { ProductKey: number; name: string; code: string | null; match: 'exact' | 'contains' | 'words' }[] }[];
  warnings: string[];
}

export function importFolder(): string | null {
  const dir = process.env.PDP_IMPORT_DIR?.trim();
  return dir ? dir : null;
}

export async function readImportFolder(): Promise<ImportFiles> {
  const dir = importFolder();
  if (!dir) throw new PdpError('import.noFolder', 'Reading from a server folder is only enabled on the test stack (PDP_IMPORT_DIR). Upload the files instead.', undefined, 403);
  const out: ImportFiles = {};
  for (const [k, name] of Object.entries(IMPORT_FILES)) {
    try {
      out[k as keyof typeof IMPORT_FILES] = await readFile(path.join(dir, name));
    } catch {
      // a missing file is simply not imported (reported by the caller)
    }
  }
  return out;
}

const count = (r: ImportReport, table: string, kind: keyof Counts) => {
  r.tables[table] = r.tables[table] ?? { created: 0, updated: 0, skipped: 0 };
  r.tables[table][kind] += 1;
};

function normalize(s: string): string {
  return s.toLowerCase().replace(/\[[^\]]*\]/g, ' ').replace(/[^a-z0-9؀-ۿ]+/g, ' ').trim();
}

export async function runImport(files: ImportFiles, opts: { commit: boolean; actorUserId: number; sources: Record<string, string> }): Promise<ImportReport> {
  if (!files.productTree && !files.scoringMatrix && !files.policy) throw new PdpError('import.noFile', 'Add at least one of the three files.', 'file');
  const ck = await tikaCompanyKey();
  const report: ImportReport = {
    mode: opts.commit ? 'commit' : 'dry-run', sources: opts.sources, configSeeded: 0, tables: {}, corrections: [], unplaced: [],
    tree: { families: 0, subfamilies: 0, products: 0, byStatus: {}, flexible: 0 }, scoring: { criteria: [], problems: [] }, policy: null, odooMatches: [], warnings: [],
  };

  // Parse everything before touching the database: a broken file stops the import with nothing written.
  const tree = files.productTree ? await parseProductTree(files.productTree) : null;
  const matrix = files.scoringMatrix ? await parseScoringMatrix(files.scoringMatrix) : null;
  const policy = files.policy ? parsePolicyDocx(files.policy) : null;
  if (!tree) report.warnings.push(`${IMPORT_FILES.productTree} not provided: product tree not imported.`);
  if (!matrix) report.warnings.push(`${IMPORT_FILES.scoringMatrix} not provided: scoring matrix not checked.`);
  if (!policy) report.warnings.push(`${IMPORT_FILES.policy} not provided: policy not imported.`);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const settingsRows = await one<{ n: number }>(conn, 'SELECT COUNT(*) AS n FROM pdp_setting WHERE company_key = ?', [ck]);
    if (Number(settingsRows?.n ?? 0) === 0) report.configSeeded = await ensureConfigSeed(conn, ck);

    if (tree) await importTree(conn, ck, tree, report, opts.actorUserId);
    if (matrix) await checkMatrix(conn, ck, matrix, report);
    if (policy) await importPolicy(conn, ck, policy, report, opts.actorUserId);
    if (tree) await proposeOdooMatches(conn, ck, report);

    if (opts.commit) await conn.commit();
    else await conn.rollback();
  } catch (err) {
    await conn.rollback().catch(() => undefined);
    throw err;
  } finally {
    conn.release();
  }
  if (opts.commit) {
    await writeAuditLog({ entityType: 'pdp_import', entityId: new Date().toISOString(), action: 'CREATE', changedBy: opts.actorUserId, after: { tables: report.tables, corrections: report.corrections.length, unplaced: report.unplaced.length } });
  }
  return report;
}

async function importTree(conn: PoolConnection, ck: number, tree: Awaited<ReturnType<typeof parseProductTree>>, report: ImportReport, actor: number) {
  report.corrections.push(...tree.corrections);
  report.unplaced.push(...tree.unplaced);
  const brandIds = new Map<string, number>();
  const familyIds = new Map<string, number>();
  const subIds = new Map<string, number>();
  let order = 0;

  for (const r of tree.rows) {
    order += 1;
    // brand
    let brandId = brandIds.get(r.brand.toLowerCase());
    if (!brandId) {
      const b = await one<{ brand_id: number }>(conn, 'SELECT brand_id FROM pdp_brand WHERE company_key = ? AND name = ? AND deleted_at IS NULL', [ck, r.brand]);
      if (b) { brandId = b.brand_id; count(report, 'pdp_brand', 'skipped'); }
      else {
        brandId = (await exec(conn, 'INSERT INTO pdp_brand (company_key, name, created_by, updated_by) VALUES (?, ?, ?, ?)', [ck, r.brand, actor, actor])).insertId;
        count(report, 'pdp_brand', 'created');
      }
      brandIds.set(r.brand.toLowerCase(), brandId);
    }
    // family (+ Sheet1 description when the app has none yet)
    const famKey = `${brandId}|${r.family.toLowerCase()}`;
    let familyId = familyIds.get(famKey);
    if (!familyId) {
      const desc = tree.familyDescriptions.get(r.family.toLowerCase()) ?? null;
      if (!desc) report.warnings.push(`No Sheet1 description for family "${r.family}".`);
      const f = await one<{ family_id: number; description: string | null }>(conn, 'SELECT family_id, description FROM pdp_product_family WHERE company_key = ? AND brand_id = ? AND name = ? AND deleted_at IS NULL', [ck, brandId, r.family]);
      if (f) {
        familyId = f.family_id;
        if (!f.description && desc) {
          await exec(conn, 'UPDATE pdp_product_family SET description = ?, updated_by = ? WHERE family_id = ?', [desc, actor, familyId]);
          count(report, 'pdp_product_family', 'updated');
        } else count(report, 'pdp_product_family', 'skipped');
      } else {
        familyId = (await exec(conn, 'INSERT INTO pdp_product_family (company_key, brand_id, name, description, sort_order, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [ck, brandId, r.family, desc, familyIds.size + 1, actor, actor])).insertId;
        count(report, 'pdp_product_family', 'created');
      }
      familyIds.set(famKey, familyId);
    }
    // subfamily
    const subKey = `${familyId}|${r.subfamily.toLowerCase()}`;
    let subId = subIds.get(subKey);
    if (!subId) {
      const s = await one<{ subfamily_id: number }>(conn, 'SELECT subfamily_id FROM pdp_product_subfamily WHERE family_id = ? AND name = ? AND deleted_at IS NULL', [familyId, r.subfamily]);
      if (s) { subId = s.subfamily_id; count(report, 'pdp_product_subfamily', 'skipped'); }
      else {
        subId = (await exec(conn, 'INSERT INTO pdp_product_subfamily (company_key, family_id, name, sort_order, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?)',
          [ck, familyId, r.subfamily, subIds.size + 1, actor, actor])).insertId;
        count(report, 'pdp_product_subfamily', 'created');
      }
      subIds.set(subKey, subId);
    }
    // product (natural key: its name; an existing product is never overwritten)
    const p = await one<{ product_id: number }>(conn, 'SELECT product_id FROM pdp_product WHERE company_key = ? AND name = ? AND deleted_at IS NULL', [ck, r.name]);
    if (p) {
      count(report, 'pdp_product', 'skipped');
    } else {
      // Launch dates are imported as they are (2026-11-14: the CEO updates them in the app after go-live).
      const inMarket = r.status === 'in_market';
      const id = (await exec(conn,
        `INSERT INTO pdp_product (company_key, subfamily_id, name, description, status, planned_launch_date, actual_launch_date, launch_date_flexible, comment, sort_order, source, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'IMPORT', ?, ?)`,
        [ck, subId, r.name, r.description, r.status, r.launchDate, inMarket ? r.launchDate : null, r.flexible, r.comment, order, actor, actor])).insertId;
      await writeProductHistory(conn, ck, id, 'created', null, r.status, `Seed import (Product_Tree.xlsm row ${r.row})`, actor);
      count(report, 'pdp_product', 'created');
    }
    report.tree.byStatus[r.status] = (report.tree.byStatus[r.status] ?? 0) + 1;
    if (r.flexible) report.tree.flexible += 1;
  }
  report.tree.families = familyIds.size;
  report.tree.subfamilies = subIds.size;
  report.tree.products = tree.rows.length;
}

async function checkMatrix(conn: PoolConnection, ck: number, matrix: Awaited<ReturnType<typeof parseScoringMatrix>>, report: ImportReport) {
  report.corrections.push(...matrix.corrections);
  report.scoring.problems.push(...matrix.problems);
  const app = await rows<Record<string, unknown>>(conn, 'SELECT * FROM pdp_scoring_criterion WHERE company_key = ?', [ck]);
  for (const c of matrix.criteria) {
    const a = app.find((x) => String(x.name).toLowerCase() === c.name.toLowerCase());
    const seed = SEED_CRITERIA.find((s) => s.name.toLowerCase() === c.name.toLowerCase());
    if (!seed) report.scoring.problems.push(`"${c.name}" is not one of the criteria in the brief (section 2.2)`);
    if (!a) {
      report.scoring.criteria.push({ name: c.name, weight: c.weight, status: 'missing_in_app', differences: [] });
      count(report, 'pdp_scoring_criterion', 'skipped');
      continue;
    }
    const differences: string[] = [];
    if (Number(a.weight) !== c.weight) differences.push(`weight: file ${c.weight}, app ${a.weight}`);
    c.meanings.forEach((m, i) => {
      if (String(a[`meaning_${i}`]) !== m) differences.push(`meaning ${i}: file "${m}", app "${a[`meaning_${i}`]}"`);
    });
    report.scoring.criteria.push({ name: c.name, weight: c.weight, status: differences.length ? 'differs' : 'same', differences });
    count(report, 'pdp_scoring_criterion', 'skipped');
  }
}

async function importPolicy(conn: PoolConnection, ck: number, policy: ReturnType<typeof parsePolicyDocx>, report: ImportReport, actor: number) {
  const existing = await one(conn, "SELECT 1 FROM pdp_policy_version WHERE company_key = ? AND version_label = '1.0' AND deleted_at IS NULL", [ck]);
  if (existing) {
    report.policy = { version: '1.0', title: policy.title, sections: policy.sections.length, status: 'skipped' };
    count(report, 'pdp_policy_version', 'skipped');
    return;
  }
  if (policy.sections.length === 0) throw new PdpError('import.policyEmpty', 'R_D_Policy.docx has no "Heading 2" sections.', 'policy');
  const v = await exec(conn,
    "INSERT INTO pdp_policy_version (company_key, version_label, status, title, notes, source, published_at, published_by, created_by, updated_by) VALUES (?, '1.0', 'published', ?, ?, 'IMPORT', CURRENT_TIMESTAMP, ?, ?, ?)",
    [ck, policy.title, 'Imported from R_D_Policy.docx', actor, actor, actor]);
  count(report, 'pdp_policy_version', 'created');
  for (const s of policy.sections) {
    await exec(conn, 'INSERT INTO pdp_policy_section (company_key, version_id, section_no, title, body, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)', [ck, v.insertId, s.section_no, s.title, s.body, actor, actor]);
    count(report, 'pdp_policy_section', 'created');
  }
  report.policy = { version: '1.0', title: policy.title, sections: policy.sections.length, status: 'created' };
}

/**
 * Proposals only (2026-11-14: nothing is linked automatically; each link is confirmed in the app): for every in-market
 * product, TIKA (or shared) Odoo products whose name matches exactly, contains the name, or contains all its words.
 */
async function proposeOdooMatches(conn: PoolConnection, ck: number, report: ImportReport) {
  const products = await rows<{ name: string }>(conn, "SELECT name FROM pdp_product WHERE company_key = ? AND status = 'in_market' AND deleted_at IS NULL AND dim_product_key IS NULL ORDER BY sort_order, name", [ck]);
  if (products.length === 0) return;
  const odoo = await rows<{ ProductKey: number; name: string; code: string | null }>(conn,
    `SELECT ProductKey, COALESCE(product_name, OdooProductName) AS name, default_code AS code FROM dim_product
      WHERE CompanyKey IN (?, -1) AND is_deleted = 0 AND active = 1 AND COALESCE(product_name, OdooProductName) IS NOT NULL`, [ck]);
  const normOdoo = odoo.map((o) => ({ ...o, n: normalize(o.name) }));
  for (const p of products) {
    const n = normalize(p.name);
    const words = n.split(' ').filter((w) => w.length > 1);
    const exact = normOdoo.filter((o) => o.n === n);
    const contains = normOdoo.filter((o) => o.n !== n && ` ${o.n} `.includes(` ${n} `));
    const allWords = normOdoo.filter((o) => o.n !== n && !contains.includes(o) && words.length > 1 && words.every((w) => ` ${o.n} `.includes(` ${w} `)));
    const candidates = [
      ...exact.map((o) => ({ ProductKey: Number(o.ProductKey), name: o.name, code: o.code, match: 'exact' as const })),
      ...contains.map((o) => ({ ProductKey: Number(o.ProductKey), name: o.name, code: o.code, match: 'contains' as const })),
      ...allWords.map((o) => ({ ProductKey: Number(o.ProductKey), name: o.name, code: o.code, match: 'words' as const })),
    ].slice(0, 8);
    report.odooMatches.push({ product: p.name, candidates });
  }
}
