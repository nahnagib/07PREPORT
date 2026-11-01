import type { TableId } from './parser';

/**
 * Maps each parsed template table to its DB table. `field` is the parser's field name (also the
 * alias used when reading current rows back), `col` the column, `type` how values are normalised
 * for comparison and storage. Money is compared/stored at 2 dp and percentages at 4 dp (matching
 * the DECIMAL scales in migration 0022), so 50000 equals 50000.00 and a re-upload is idempotent.
 */
/** `brand` / `category` are stored as ids (marcom_brand / marcom_spend_category) and read back by name. */
export type FieldType = 'int' | 'money' | 'dec2' | 'pct' | 'text' | 'date' | 'brand' | 'category';

export interface FieldDef { field: string; col: string; type: FieldType }

export interface Adapter {
  id: TableId;
  table: string;
  fields: FieldDef[];
  keyFields: string[];
}

const f = (field: string, col: string, type: FieldType): FieldDef => ({ field, col, type });

export const ADAPTERS: Adapter[] = [
  {
    id: 'spend', table: 'marcom_spend_monthly', keyFields: ['year', 'month', 'brand'],
    fields: [
      f('year', 'year', 'int'), f('month', 'month', 'int'), f('brand', 'brand_id', 'brand'),
      f('brandRevenueCurrent', 'brand_revenue_current', 'money'), f('brandRevenueLy', 'brand_revenue_ly', 'money'),
      f('revenueAttributed', 'revenue_attributed', 'money'), f('companyRevenueTotal', 'company_revenue_total', 'money'),
      f('budget', 'budget', 'money'), f('financeBookedTotal', 'finance_booked_total', 'money'),
      f('newCustomers', 'new_customers', 'int'), f('avgInvoice', 'avg_invoice', 'money'),
      f('socialPostCost', 'social_post_cost', 'money'), f('clicks', 'clicks', 'int'),
    ],
  },
  {
    id: 'other', table: 'marcom_other_spend', keyFields: ['year', 'month', 'brand', 'category', 'description'],
    fields: [
      f('year', 'year', 'int'), f('month', 'month', 'int'), f('brand', 'brand_id', 'brand'),
      f('category', 'category_id', 'category'), f('description', 'description', 'text'), f('vendor', 'vendor', 'text'),
      f('amount', 'amount_lyd', 'money'), f('notes', 'notes', 'text'),
    ],
  },
  {
    id: 'campaigns', table: 'marcom_campaign', keyFields: ['name'],
    fields: [
      f('name', 'name', 'text'), f('brand', 'brand_id', 'brand'), f('startDate', 'start_date', 'date'),
      f('endDate', 'end_date', 'date'), f('status', 'status', 'text'),
      f('spend', 'spend', 'money'), f('revenueAttributed', 'revenue_attributed', 'money'),
    ],
  },
  {
    id: 'media', table: 'marcom_campaign_media', keyFields: ['campaignName', 'mediaType', 'city'],
    fields: [
      f('campaignName', 'campaign_name', 'text'), f('mediaType', 'media_type', 'text'), f('city', 'city', 'text'),
      f('units', 'units', 'int'), f('cost', 'cost', 'money'),
    ],
  },
  {
    id: 'social', table: 'marcom_social_monthly', keyFields: ['year', 'month', 'brand', 'platform', 'accountName'],
    fields: [
      f('year', 'year', 'int'), f('month', 'month', 'int'), f('brand', 'brand_id', 'brand'),
      f('platform', 'platform', 'text'), f('accountName', 'account_name', 'text'),
      f('followers', 'followers', 'int'), f('impressions', 'impressions', 'int'), f('clicks', 'clicks', 'int'),
      f('engagementPaid', 'engagement_paid', 'int'), f('engagementOrganic', 'engagement_organic', 'int'),
    ],
  },
  {
    id: 'web', table: 'marcom_web_monthly', keyFields: ['year', 'month', 'brand'],
    fields: [
      f('year', 'year', 'int'), f('month', 'month', 'int'), f('brand', 'brand_id', 'brand'), f('bounceVisitors', 'bounce_visitors', 'int'),
      f('totalVisitors', 'total_visitors', 'int'), f('sessions', 'sessions', 'int'), f('totalMinutes', 'total_minutes', 'dec2'),
    ],
  },
  {
    id: 'trade', table: 'marcom_trade_monthly', keyFields: ['year', 'month'],
    fields: [
      f('year', 'year', 'int'), f('month', 'month', 'int'),
      f('compliancePct', 'compliance_pct', 'pct'), f('giveawaysStockPct', 'giveaways_stock_pct', 'pct'),
      f('printedStockPct', 'printed_stock_pct', 'pct'),
      f('attendeesActual', 'attendees_actual', 'int'), f('attendeesExpected', 'attendees_expected', 'int'),
    ],
  },
  {
    id: 'events', table: 'marcom_event', keyFields: ['name', 'brand'],
    fields: [
      f('name', 'name', 'text'), f('eventType', 'event_type', 'text'), f('brand', 'brand_id', 'brand'),
      f('plannedDate', 'planned_date', 'date'), f('completionDate', 'completion_date', 'date'), f('status', 'status', 'text'),
    ],
  },
];

export const ADAPTER_BY_ID = Object.fromEntries(ADAPTERS.map((a) => [a.id, a])) as Record<TableId, Adapter>;

/** Canonical string form of a value for comparison / display. */
export function normalize(type: FieldType, v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  switch (type) {
    case 'int': return String(Number(v));
    case 'money':
    case 'dec2': return (Math.round(Number(v) * 100) / 100).toFixed(2);
    case 'pct': return (Math.round(Number(v) * 10000) / 10000).toFixed(4);
    default: return String(v).trim();
  }
}

/**
 * Joins that turn brand_id / category_id back into names. An INNER join on purpose: social/web rows from template 1.x
 * have no brand (migration 0061, needs_review = 1) and stay out of the upload diff -- a 2.0 upload never matches them.
 */
export function lookupJoins(a: Adapter): string {
  return (a.fields.some((x) => x.type === 'brand') ? 'JOIN marcom_brand b ON b.brand_id = t.brand_id ' : '') +
    (a.fields.some((x) => x.type === 'category') ? 'JOIN marcom_spend_category c ON c.category_id = t.category_id ' : '');
}

/** Column of the select list for one field (brand/category by name). */
export function selectCol(x: FieldDef): string {
  if (x.type === 'brand') return 'b.name AS `brand`';
  if (x.type === 'category') return `c.name AS \`${x.field}\``;
  if (x.type === 'date') return `DATE_FORMAT(t.${x.col}, '%Y-%m-%d') AS \`${x.field}\``;
  return `t.${x.col} AS \`${x.field}\``;
}

/** SELECT of the live (is_current = 1) rows, aliased to the parser's field names. */
export function selectCurrentSql(a: Adapter): string {
  return `SELECT t.id AS __id, ${a.fields.map(selectCol).join(', ')} FROM ${a.table} t ${lookupJoins(a)}WHERE t.is_current = 1`;
}

export function keyOf(a: Adapter, data: Record<string, unknown>): string {
  return a.keyFields.map((k) => {
    const fd = a.fields.find((x) => x.field === k)!;
    return String(normalize(fd.type, data[k]) ?? '').toLowerCase();
  }).join('|');
}
