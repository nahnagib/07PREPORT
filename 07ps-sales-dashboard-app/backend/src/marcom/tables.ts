import type { TableId } from './parser';

/**
 * Maps each parsed template table to its DB table. `field` is the parser's field name (also the
 * alias used when reading current rows back), `col` the column, `type` how values are normalised
 * for comparison and storage. Money is compared/stored at 2 dp and percentages at 4 dp (matching
 * the DECIMAL scales in migration 0022), so 50000 equals 50000.00 and a re-upload is idempotent.
 */
export type FieldType = 'int' | 'money' | 'dec2' | 'pct' | 'text' | 'date' | 'brand';

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
      f('spend', 'spend', 'money'), f('revenueAttributed', 'revenue_attributed', 'money'),
      f('companyRevenueCurrent', 'company_revenue_current', 'money'), f('companyRevenueLy', 'company_revenue_ly', 'money'),
      f('budget', 'budget', 'money'), f('newCustomers', 'new_customers', 'int'), f('avgInvoice', 'avg_invoice', 'money'),
      f('socialPostCost', 'social_post_cost', 'money'), f('clicks', 'clicks', 'int'),
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
    id: 'media', table: 'marcom_campaign_media', keyFields: ['campaignName', 'mediaType'],
    fields: [
      f('campaignName', 'campaign_name', 'text'), f('mediaType', 'media_type', 'text'),
      f('units', 'units', 'int'), f('cost', 'cost', 'money'),
    ],
  },
  {
    id: 'social', table: 'marcom_social_monthly', keyFields: ['year', 'month', 'platform'],
    fields: [
      f('year', 'year', 'int'), f('month', 'month', 'int'), f('platform', 'platform', 'text'),
      f('followers', 'followers', 'int'), f('impressions', 'impressions', 'int'), f('clicks', 'clicks', 'int'),
      f('engagementPaid', 'engagement_paid', 'int'), f('engagementOrganic', 'engagement_organic', 'int'),
    ],
  },
  {
    id: 'web', table: 'marcom_web_monthly', keyFields: ['year', 'month'],
    fields: [
      f('year', 'year', 'int'), f('month', 'month', 'int'), f('bounceVisitors', 'bounce_visitors', 'int'),
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

/** SELECT of the live (is_current = 1) rows, aliased to the parser's field names. */
export function selectCurrentSql(a: Adapter): string {
  const hasBrand = a.fields.some((x) => x.type === 'brand');
  const cols = a.fields.map((x) => {
    if (x.type === 'brand') return 'b.name AS `brand`';
    if (x.type === 'date') return `DATE_FORMAT(t.${x.col}, '%Y-%m-%d') AS \`${x.field}\``;
    return `t.${x.col} AS \`${x.field}\``;
  });
  return `SELECT t.id AS __id, ${cols.join(', ')} FROM ${a.table} t ` +
    `${hasBrand ? 'JOIN marcom_brand b ON b.brand_id = t.brand_id ' : ''}WHERE t.is_current = 1`;
}

export function keyOf(a: Adapter, data: Record<string, unknown>): string {
  return a.keyFields.map((k) => {
    const fd = a.fields.find((x) => x.field === k)!;
    return String(normalize(fd.type, data[k]) ?? '').toLowerCase();
  }).join('|');
}
