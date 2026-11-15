import { pool } from '../../db/pool';
import { PdpError, notFound } from './errors';
import { exec, inTransaction, isoDate, isoDateTime, one, rows, type Db } from './db';
import { PRODUCT_STATUSES, type ProductStatus } from './rules';
import { odooConfiguredBaseUrl, odooFormUrl } from '../../lib/odooLinks';
import { bool, date, id, int, oneOf, reqText, text } from './validate';

/**
 * Xtreme product tree: brand -> family -> subfamily -> product. Families and subfamilies are soft-deleted ("retired")
 * only when empty; a product is retired by setting it to `discontinued`. Every status, launch-date, move and Odoo-link
 * change writes an append-only pdp_product_history row with its reason.
 */

export interface TreeProduct {
  product_id: number;
  subfamily_id: number;
  name: string;
  description: string | null;
  status: ProductStatus;
  planned_launch_date: string | null;
  actual_launch_date: string | null;
  launch_date_flexible: boolean;
  comment: string | null;
  dim_product_key: number | null;
  odoo_name: string | null;
  /** "Open in Odoo" form link of the linked product; null when not linked or no Odoo URL is configured. */
  odoo_url: string | null;
  sort_order: number;
}
export interface TreeSubfamily { subfamily_id: number; family_id: number; name: string; sort_order: number; products: TreeProduct[] }
export interface TreeFamily { family_id: number; brand_id: number; name: string; description: string | null; sort_order: number; subfamilies: TreeSubfamily[] }
export interface TreeBrand { brand_id: number; name: string; families: TreeFamily[] }

function mapProduct(p: Record<string, unknown>): TreeProduct {
  return {
    product_id: Number(p.product_id), subfamily_id: Number(p.subfamily_id), name: String(p.name), description: (p.description as string) ?? null,
    status: p.status as ProductStatus, planned_launch_date: isoDate(p.planned_launch_date), actual_launch_date: isoDate(p.actual_launch_date),
    launch_date_flexible: Boolean(p.launch_date_flexible), comment: (p.comment as string) ?? null,
    dim_product_key: p.dim_product_key === null || p.dim_product_key === undefined ? null : Number(p.dim_product_key),
    odoo_name: (p.odoo_name as string) ?? null, sort_order: Number(p.sort_order),
    odoo_url: odooFormUrl(odooConfiguredBaseUrl(), 'product.product', p.dim_product_key === null || p.dim_product_key === undefined ? null : Number(p.dim_product_key), Number(p.company_key)),
  };
}

export async function listProducts(ck: number, db: Db = pool): Promise<TreeProduct[]> {
  const r = await rows<Record<string, unknown>>(
    db,
    `SELECT p.*, d.OdooProductName AS odoo_name FROM pdp_product p
       LEFT JOIN dim_product d ON d.ProductKey = p.dim_product_key
      WHERE p.company_key = ? AND p.deleted_at IS NULL ORDER BY p.sort_order, p.name`,
    [ck],
  );
  return r.map(mapProduct);
}

export async function getTree(ck: number, db: Db = pool): Promise<TreeBrand[]> {
  const [brands, families, subs, products] = await Promise.all([
    rows<{ brand_id: number; name: string }>(db, 'SELECT brand_id, name FROM pdp_brand WHERE company_key = ? AND deleted_at IS NULL ORDER BY sort_order, name', [ck]),
    rows<Omit<TreeFamily, 'subfamilies'>>(db, 'SELECT family_id, brand_id, name, description, sort_order FROM pdp_product_family WHERE company_key = ? AND deleted_at IS NULL ORDER BY sort_order, name', [ck]),
    rows<Omit<TreeSubfamily, 'products'>>(db, 'SELECT subfamily_id, family_id, name, sort_order FROM pdp_product_subfamily WHERE company_key = ? AND deleted_at IS NULL ORDER BY sort_order, name', [ck]),
    listProducts(ck, db),
  ]);
  return brands.map((b) => ({
    ...b,
    families: families.filter((f) => f.brand_id === b.brand_id).map((f) => ({
      ...f,
      subfamilies: subs.filter((s) => s.family_id === f.family_id).map((s) => ({ ...s, products: products.filter((p) => p.subfamily_id === s.subfamily_id) })),
    })),
  }));
}

export async function getProductRow(ck: number, productId: number, db: Db = pool): Promise<TreeProduct> {
  const r = await one<Record<string, unknown>>(
    db,
    `SELECT p.*, d.OdooProductName AS odoo_name FROM pdp_product p LEFT JOIN dim_product d ON d.ProductKey = p.dim_product_key
      WHERE p.company_key = ? AND p.product_id = ? AND p.deleted_at IS NULL`,
    [ck, productId],
  );
  if (!r) throw notFound('product');
  return mapProduct(r);
}

export async function productHistory(ck: number, productId: number) {
  const r = await rows<Record<string, unknown>>(
    pool,
    `SELECT h.history_id, h.field, h.from_value, h.to_value, h.reason, h.changed_at, u.display_name AS changed_by_name
       FROM pdp_product_history h LEFT JOIN app_user u ON u.user_id = h.changed_by
      WHERE h.company_key = ? AND h.product_id = ? ORDER BY h.changed_at DESC, h.history_id DESC`,
    [ck, productId],
  );
  return r.map((x) => ({ ...x, changed_at: isoDateTime(x.changed_at) }));
}

export async function writeProductHistory(db: Db, ck: number, productId: number, field: string, from: unknown, to: unknown, reason: string | null, actor: number | null) {
  const s = (v: unknown) => (v === null || v === undefined ? null : String(v).slice(0, 500));
  await exec(db, 'INSERT INTO pdp_product_history (company_key, product_id, field, from_value, to_value, reason, changed_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [ck, productId, field, s(from), s(to), reason, actor]);
}

// ---------------------------------------------------------------------------- families / subfamilies

async function brandOf(ck: number, brandId: unknown) {
  const bid = id(brandId, 'brandId', 'Brand');
  if (!(await one(pool, 'SELECT 1 FROM pdp_brand WHERE company_key = ? AND brand_id = ? AND deleted_at IS NULL', [ck, bid]))) throw notFound('brand');
  return bid;
}

export async function saveFamily(ck: number, familyId: number | null, input: Record<string, unknown>, actor: number) {
  const name = reqText(input.name, 'name', 150, 'Family name');
  const description = text(input.description, 'description', { max: 2000 });
  const sortOrder = int(input.sortOrder, 'sortOrder', { min: 0 }) ?? 0;
  if (familyId) {
    const cur = await one<{ brand_id: number }>(pool, 'SELECT brand_id FROM pdp_product_family WHERE company_key = ? AND family_id = ? AND deleted_at IS NULL', [ck, familyId]);
    if (!cur) throw notFound('family');
    if (await one(pool, 'SELECT 1 FROM pdp_product_family WHERE company_key = ? AND brand_id = ? AND name = ? AND deleted_at IS NULL AND family_id <> ?', [ck, cur.brand_id, name, familyId])) {
      throw new PdpError('tree.duplicate', `There is already a family called "${name}".`, 'name', 409);
    }
    await exec(pool, 'UPDATE pdp_product_family SET name = ?, description = ?, sort_order = ?, updated_by = ? WHERE family_id = ?', [name, description, sortOrder, actor, familyId]);
    return { family_id: familyId };
  }
  const brandId = await brandOf(ck, input.brandId);
  if (await one(pool, 'SELECT 1 FROM pdp_product_family WHERE company_key = ? AND brand_id = ? AND name = ? AND deleted_at IS NULL', [ck, brandId, name])) {
    throw new PdpError('tree.duplicate', `There is already a family called "${name}".`, 'name', 409);
  }
  const r = await exec(pool, 'INSERT INTO pdp_product_family (company_key, brand_id, name, description, sort_order, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [ck, brandId, name, description, sortOrder, actor, actor]);
  return { family_id: r.insertId };
}

export async function retireFamily(ck: number, familyId: number, actor: number) {
  if (await one(pool, 'SELECT 1 FROM pdp_product_subfamily WHERE family_id = ? AND deleted_at IS NULL LIMIT 1', [familyId])) {
    throw new PdpError('tree.notEmpty', 'Move or retire its subfamilies first.', undefined, 409);
  }
  const r = await exec(pool, 'UPDATE pdp_product_family SET deleted_at = CURRENT_TIMESTAMP, deleted_by = ? WHERE company_key = ? AND family_id = ? AND deleted_at IS NULL', [actor, ck, familyId]);
  if (r.affectedRows === 0) throw notFound('family');
}

export async function saveSubfamily(ck: number, subfamilyId: number | null, input: Record<string, unknown>, actor: number) {
  const name = reqText(input.name, 'name', 150, 'Subfamily name');
  const sortOrder = int(input.sortOrder, 'sortOrder', { min: 0 }) ?? 0;
  const familyId = id(input.familyId, 'familyId', 'Family');
  if (!(await one(pool, 'SELECT 1 FROM pdp_product_family WHERE company_key = ? AND family_id = ? AND deleted_at IS NULL', [ck, familyId]))) throw notFound('family');
  if (await one(pool, 'SELECT 1 FROM pdp_product_subfamily WHERE family_id = ? AND name = ? AND deleted_at IS NULL AND subfamily_id <> ?', [familyId, name, subfamilyId ?? -1])) {
    throw new PdpError('tree.duplicate', `This family already has a subfamily called "${name}".`, 'name', 409);
  }
  if (subfamilyId) {
    const r = await exec(pool, 'UPDATE pdp_product_subfamily SET family_id = ?, name = ?, sort_order = ?, updated_by = ? WHERE company_key = ? AND subfamily_id = ? AND deleted_at IS NULL',
      [familyId, name, sortOrder, actor, ck, subfamilyId]);
    if (r.affectedRows === 0) throw notFound('subfamily');
    return { subfamily_id: subfamilyId };
  }
  const r = await exec(pool, 'INSERT INTO pdp_product_subfamily (company_key, family_id, name, sort_order, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?)', [ck, familyId, name, sortOrder, actor, actor]);
  return { subfamily_id: r.insertId };
}

export async function retireSubfamily(ck: number, subfamilyId: number, actor: number) {
  if (await one(pool, 'SELECT 1 FROM pdp_product WHERE subfamily_id = ? AND deleted_at IS NULL LIMIT 1', [subfamilyId])) {
    throw new PdpError('tree.notEmpty', 'Move its products to another subfamily first.', undefined, 409);
  }
  const r = await exec(pool, 'UPDATE pdp_product_subfamily SET deleted_at = CURRENT_TIMESTAMP, deleted_by = ? WHERE company_key = ? AND subfamily_id = ? AND deleted_at IS NULL', [actor, ck, subfamilyId]);
  if (r.affectedRows === 0) throw notFound('subfamily');
}

// ---------------------------------------------------------------------------- products

async function subfamilyOf(ck: number, v: unknown, db: Db = pool): Promise<number> {
  const sid = id(v, 'subfamilyId', 'Subfamily');
  if (!(await one(db, 'SELECT 1 FROM pdp_product_subfamily WHERE company_key = ? AND subfamily_id = ? AND deleted_at IS NULL', [ck, sid]))) throw notFound('subfamily');
  return sid;
}

async function assertNameFree(db: Db, ck: number, name: string, exceptId: number) {
  if (await one(db, 'SELECT 1 FROM pdp_product WHERE company_key = ? AND name = ? AND deleted_at IS NULL AND product_id <> ?', [ck, name, exceptId])) {
    throw new PdpError('tree.duplicate', `There is already a product called "${name}".`, 'name', 409);
  }
}

/** Odoo product link: a TIKA (or shared) product of dim_product. */
export async function assertOdooProduct(ck: number, key: unknown, db: Db = pool): Promise<number | null> {
  if (key === null || key === undefined || key === '') return null;
  const k = Number(key);
  if (!Number.isInteger(k) || k <= 0) throw new PdpError('product.odooInvalid', 'Pick an Odoo product.', 'dimProductKey');
  const p = await one(db, 'SELECT 1 FROM dim_product WHERE ProductKey = ? AND CompanyKey IN (?, -1) AND is_deleted = 0', [k, ck]);
  if (!p) throw new PdpError('product.odooNotTika', 'That Odoo product is not a TIKA product.', 'dimProductKey');
  return k;
}

export async function createProduct(ck: number, input: Record<string, unknown>, actor: number, db: Db = pool, source: 'MANUAL' | 'PROJECT' = 'MANUAL') {
  const subfamilyId = await subfamilyOf(ck, input.subfamilyId, db);
  const name = reqText(input.name, 'name', 200, 'Product name');
  await assertNameFree(db, ck, name, -1);
  const status = oneOf(input.status ?? 'planned', PRODUCT_STATUSES, 'status', 'Status');
  const planned = date(input.plannedLaunchDate, 'plannedLaunchDate', { label: 'Planned launch date' });
  const actual = date(input.actualLaunchDate, 'actualLaunchDate', { label: 'Actual launch date' });
  if (status === 'in_market' && !actual && !planned) throw new PdpError('product.launchDateRequired', 'An in-market product needs its launch date.', 'actualLaunchDate');
  const r = await exec(db,
    `INSERT INTO pdp_product (company_key, subfamily_id, name, description, status, planned_launch_date, actual_launch_date, launch_date_flexible, comment, dim_product_key, source, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [ck, subfamilyId, name, text(input.description, 'description', { max: 5000 }), status, planned, actual, bool(input.launchDateFlexible),
      text(input.comment, 'comment', { max: 500 }), await assertOdooProduct(ck, input.dimProductKey, db), source, actor, actor]);
  await writeProductHistory(db, ck, r.insertId, 'created', null, status, text(input.reason, 'reason', { max: 1000 }), actor);
  return { product_id: r.insertId };
}

/**
 * Edit a product. Changing status, a launch date, the subfamily (a move) or the Odoo link needs a reason, and each
 * change is one history row.
 */
export async function updateProduct(ck: number, productId: number, input: Record<string, unknown>, actor: number) {
  return inTransaction(async (conn) => {
    const cur = await getProductRow(ck, productId, conn);
    const next = {
      name: input.name === undefined ? cur.name : reqText(input.name, 'name', 200, 'Product name'),
      description: input.description === undefined ? cur.description : text(input.description, 'description', { max: 5000 }),
      comment: input.comment === undefined ? cur.comment : text(input.comment, 'comment', { max: 500 }),
      launch_date_flexible: input.launchDateFlexible === undefined ? cur.launch_date_flexible : bool(input.launchDateFlexible),
      status: input.status === undefined ? cur.status : oneOf(input.status, PRODUCT_STATUSES, 'status', 'Status'),
      planned_launch_date: input.plannedLaunchDate === undefined ? cur.planned_launch_date : date(input.plannedLaunchDate, 'plannedLaunchDate', { label: 'Planned launch date' }),
      actual_launch_date: input.actualLaunchDate === undefined ? cur.actual_launch_date : date(input.actualLaunchDate, 'actualLaunchDate', { label: 'Actual launch date' }),
      subfamily_id: input.subfamilyId === undefined ? cur.subfamily_id : await subfamilyOf(ck, input.subfamilyId, conn),
      dim_product_key: input.dimProductKey === undefined ? cur.dim_product_key : await assertOdooProduct(ck, input.dimProductKey, conn),
    };
    if (next.name !== cur.name) await assertNameFree(conn, ck, next.name, productId);
    const tracked = ['status', 'planned_launch_date', 'actual_launch_date', 'subfamily_id', 'dim_product_key'] as const;
    const changed = tracked.filter((k) => next[k] !== cur[k]);
    const reason = text(input.reason, 'reason', { max: 1000 });
    if (changed.length && !reason) throw new PdpError('product.reasonRequired', 'Give the reason for changing the status, a launch date, the subfamily or the Odoo link.', 'reason');
    if (next.status === 'in_market' && !next.actual_launch_date) throw new PdpError('product.actualDateRequired', 'Set the actual launch date for an in-market product.', 'actualLaunchDate');
    await exec(conn,
      `UPDATE pdp_product SET name = ?, description = ?, comment = ?, launch_date_flexible = ?, status = ?, planned_launch_date = ?, actual_launch_date = ?,
              subfamily_id = ?, dim_product_key = ?, updated_by = ? WHERE product_id = ?`,
      [next.name, next.description, next.comment, next.launch_date_flexible, next.status, next.planned_launch_date, next.actual_launch_date,
        next.subfamily_id, next.dim_product_key, actor, productId]);
    for (const k of changed) await writeProductHistory(conn, ck, productId, k, cur[k], next[k], reason, actor);
    if (next.name !== cur.name) await writeProductHistory(conn, ck, productId, 'name', cur.name, next.name, reason, actor);
    return { product_id: productId };
  });
}

/** Soft delete: only a product no project, launch or feedback refers to (otherwise retire it as discontinued). */
export async function deleteProduct(ck: number, productId: number, actor: number) {
  await getProductRow(ck, productId);
  const used = await one(pool,
    `SELECT 1 FROM pdp_project WHERE product_id = ? AND deleted_at IS NULL
     UNION ALL SELECT 1 FROM pdp_launch WHERE product_id = ? AND deleted_at IS NULL
     UNION ALL SELECT 1 FROM pdp_customer_feedback WHERE product_id = ? AND deleted_at IS NULL LIMIT 1`,
    [productId, productId, productId]);
  if (used) throw new PdpError('product.inUse', 'This product has projects, a launch or feedback: set it to Discontinued instead.', undefined, 409);
  await exec(pool, 'UPDATE pdp_product SET deleted_at = CURRENT_TIMESTAMP, deleted_by = ? WHERE product_id = ?', [actor, productId]);
  await writeProductHistory(pool, ck, productId, 'deleted', null, null, null, actor);
}

/** Odoo product picker: TIKA (or shared) products of dim_product, by name or code. */
export async function searchOdooProducts(ck: number, q: string) {
  const term = `%${q.trim()}%`;
  if (q.trim().length < 2) return [];
  return rows<{ ProductKey: number; OdooProductName: string; default_code: string | null }>(
    pool,
    `SELECT ProductKey, COALESCE(OdooProductName, product_name) AS OdooProductName, default_code FROM dim_product
      WHERE CompanyKey IN (?, -1) AND is_deleted = 0 AND (OdooProductName LIKE ? OR product_name LIKE ? OR default_code LIKE ?)
      ORDER BY active DESC, OdooProductName LIMIT 25`,
    [ck, term, term, term],
  );
}

/** Odoo customer picker for field trials and feedback: TIKA customers only. */
export async function searchTikaCustomers(ck: number, q: string) {
  if (q.trim().length < 2) return [];
  const term = `%${q.trim()}%`;
  return rows<{ CustomerKey: number; customer: string }>(
    pool,
    `SELECT c.CustomerKey, c.customer FROM dim_customer c JOIN dim_customer_company cc ON cc.CustomerKey = c.CustomerKey AND cc.CompanyKey = ?
      WHERE c.is_deleted = 0 AND (c.customer LIKE ? OR c.ref LIKE ?) ORDER BY c.customer LIMIT 25`,
    [ck, term, term],
  );
}

export async function assertTikaCustomer(ck: number, key: unknown, db: Db = pool): Promise<number | null> {
  if (key === null || key === undefined || key === '') return null;
  const k = Number(key);
  if (!Number.isInteger(k) || k <= 0) throw new PdpError('customer.invalid', 'Pick a customer.', 'customerKey');
  if (!(await one(db, 'SELECT 1 FROM dim_customer_company WHERE CustomerKey = ? AND CompanyKey = ?', [k, ck]))) {
    throw new PdpError('customer.notTika', 'That customer is not a TIKA customer.', 'customerKey');
  }
  return k;
}
