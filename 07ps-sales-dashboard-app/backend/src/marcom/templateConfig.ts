/**
 * Single description of the MARCOM Contribution Excel template
 * (backend/assets/marcom/MARCOM_Contribution_Data_Template.xlsx). Bump TEMPLATE_VERSION whenever
 * a sheet, header label or input column changes -- it is stored on every upload batch, and the
 * parser refuses files whose structure no longer matches what is declared here.
 */
// 1.1: City column in P2 Table B (media rows).
// 2.0: P1 brand-level revenue inputs (no YTD), Finance Booked Total, Other MARCOM Spending sheet, Brand on P3 tables.
export const TEMPLATE_VERSION = '2.0';

export const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

export const PLATFORMS = ['Facebook', 'Google', 'LinkedIn', 'Instagram', 'TikTok'] as const;
export const MEDIA_TYPES = ['1-Street Lights', '2-Mega Billboards', '3-Billboards', '4-Bridge Banners', '5-Light Screen'] as const;
/**
 * Cities for P2 Table B (the template's Lists!H dropdown). Drives the Media Campaign Performance city map;
 * the map's coordinates for each city live in frontend/src/lib/marcom/libyaMap.ts. Add a city here, in the
 * template's Lists sheet and in libyaMap.ts together (templateLists.test.ts checks the first two match).
 */
export const CITIES = [
  'Tripoli', 'Benghazi', 'Misrata', 'Zawiya', 'Zliten', 'Khoms', 'Sirte', 'Bayda', 'Tobruk', 'Derna', 'Ajdabiya', 'Marj', 'Brega', 'Sabha', 'Gharyan', 'Zuwara', 'Sabratha', 'Surman', 'Tarhuna', 'Bani Walid', 'Yafran', 'Nalut', 'Ghadames', 'Jalu', 'Waddan', 'Hun', 'Ubari', 'Murzuq', 'Ghat', 'Kufra',
] as const;
/**
 * Starting categories of non-campaign MARCOM spend. The live list is the marcom_spend_category table (migration 0061,
 * editable there); this copy seeds the template's Lists!I column and is the fallback when no DB list is passed.
 */
export const DEFAULT_SPEND_CATEGORIES = [
  'Uniforms', 'Printing & Printouts', 'Gifts & Giveaways', 'Events & Sponsorships', 'Branding & Signage',
  'POS / Merchandising Materials', 'Photography & Production', 'Agency / Freelancer Fees', 'Other',
] as const;
/** Platforms pre-filled per brand and month in P3 Table A of a downloaded template (other platforms: add a row). */
export const PREFILL_PLATFORMS: readonly string[] = ['Facebook', 'Instagram'];
export const CAMPAIGN_STATUSES = ['Planned', 'Ongoing', 'Completed', 'On Hold'] as const;
export const EVENT_TYPES = [
  '1-Professionals', '2-Architects/Designers', '3-Corporate', '4-CSR',
  '5-Entertainment', '6-Launch & Opening', '7-Internal/Trainings', '8-Exhibitions',
] as const;
export const EVENT_STATUSES = ['Planned', 'Completed', 'Postponed', 'Cancelled'] as const;

export type Platform = (typeof PLATFORMS)[number];
export type MediaType = (typeof MEDIA_TYPES)[number];
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];
export type EventType = (typeof EVENT_TYPES)[number];
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const YEAR_MIN = 2020;
export const YEAR_MAX = 2100;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** ARGB tail of the template's "shipped example row" fill (E2EFDA). */
export const EXAMPLE_FILL = 'E2EFDA';

export type ColKind = 'year' | 'month' | 'text' | 'enum' | 'brand' | 'category' | 'date' | 'int' | 'money' | 'decimal' | 'pct';

export interface ColSpec {
  /** 1-based column index (A = 1). Only input columns are listed -- formula columns are never read. */
  col: number;
  field: string;
  /** Expected header text. Matched case/whitespace/punctuation-insensitively as a prefix. */
  label: string;
  kind: ColKind;
  required?: boolean;
  enumValues?: readonly string[];
}

export interface TableSpec {
  id: 'spend' | 'other' | 'campaigns' | 'media' | 'social' | 'web' | 'trade' | 'events';
  sheet: string;
  /** Template's header row / last data row -- used as fallback and for the scan length. */
  headerRow: number;
  lastRow: number;
  cols: ColSpec[];
  keyFields: string[];
  /**
   * Columns a downloaded template pre-fills (Year/Month/Brand/Platform). A row where only these are filled is
   * treated as empty, so untouched pre-filled rows never raise "required" errors.
   */
  prefillFields?: string[];
}

const F = (col: number, field: string, label: string, kind: ColKind, extra: Partial<ColSpec> = {}): ColSpec => ({
  col, field, label, kind, required: true, ...extra,
});

export const SHEET_P1 = 'P1 - MARCOM Spending';
export const SHEET_P1B = 'P1b - Other MARCOM Spending';
export const SHEET_P2 = 'P2 - Media Campaigns';
export const SHEET_P3 = 'P3 - Digital Performance';
export const SHEET_P4 = 'P4 - Trade Marketing';

export const TABLES: TableSpec[] = [
  {
    // Header row 13: rows 4-11 hold the Definitions box. Revenue columns are brand-level and monthly (never YTD).
    id: 'spend', sheet: SHEET_P1, headerRow: 13, lastRow: 114, keyFields: ['year', 'month', 'brand'],
    cols: [
      F(1, 'year', 'Year', 'year'),
      F(2, 'month', 'Month', 'month'),
      F(3, 'brand', 'Brand', 'brand'),
      // Required for brands, left empty on group rows (BMH) -- checked per row in the parser.
      F(4, 'brandRevenueCurrent', 'Brand Revenue - Current Month', 'money', { required: false }),
      F(5, 'brandRevenueLy', 'Brand Revenue - Same Month Last Year', 'money', { required: false }),
      F(6, 'revenueAttributed', 'Revenue Attributed to Marketing', 'money', { required: false }),
      F(7, 'companyRevenueTotal', 'Company Total Revenue - Current Month', 'money', { required: false }),
      F(8, 'budget', 'Budget Allocated', 'money'),
      F(9, 'financeBookedTotal', 'Finance Booked MARCOM Total', 'money', { required: false }),
      F(10, 'newCustomers', '# of New Customers', 'int'),
      F(11, 'avgInvoice', 'Avg Sales per Invoice', 'money'),
      F(12, 'socialPostCost', 'Total Cost of Social Media Posts', 'money'),
      F(13, 'clicks', 'Total Clicks', 'int'),
    ],
  },
  {
    // One row per expense line that is not part of a campaign (uniforms, printouts, gifts, sponsorships ...).
    id: 'other', sheet: SHEET_P1B, headerRow: 5, lastRow: 306, keyFields: ['year', 'month', 'brand', 'category', 'description'],
    cols: [
      F(1, 'year', 'Year', 'year'),
      F(2, 'month', 'Month', 'month'),
      F(3, 'brand', 'Brand', 'brand'),
      F(4, 'category', 'Category', 'category'),
      F(5, 'description', 'Description', 'text'),
      F(6, 'vendor', 'Vendor / Supplier', 'text', { required: false }),
      F(7, 'amount', 'Amount', 'money'),
      F(8, 'notes', 'Notes', 'text', { required: false }),
    ],
  },
  {
    id: 'campaigns', sheet: SHEET_P2, headerRow: 5, lastRow: 25, keyFields: ['name'],
    cols: [
      F(1, 'name', 'Campaign Name', 'text'),
      F(2, 'brand', 'Brand', 'brand'),
      F(3, 'startDate', 'Start Date', 'date'),
      F(4, 'endDate', 'End Date', 'date'),
      F(5, 'status', 'Status', 'enum', { enumValues: CAMPAIGN_STATUSES }),
      F(6, 'spend', 'Total Spend', 'money'),
      F(7, 'revenueAttributed', 'Revenue Attributed to Campaign', 'money'),
    ],
  },
  {
    id: 'media', sheet: SHEET_P2, headerRow: 29, lastRow: 59, keyFields: ['campaignName', 'mediaType', 'city'],
    cols: [
      F(1, 'campaignName', 'Campaign Name', 'text'),
      F(2, 'mediaType', 'Media Type', 'enum', { enumValues: MEDIA_TYPES }),
      F(3, 'city', 'City', 'enum', { enumValues: CITIES }),
      F(4, 'units', '# of Locations / Units', 'int'),
      F(5, 'cost', 'Cost', 'money'),
    ],
  },
  {
    // One row per Year + Month + Brand + Platform (+ Account / Page Name when a brand has two pages on one platform).
    id: 'social', sheet: SHEET_P3, headerRow: 5, lastRow: 255, keyFields: ['year', 'month', 'brand', 'platform', 'accountName'],
    prefillFields: ['year', 'month', 'brand', 'platform', 'accountName'],
    cols: [
      F(1, 'year', 'Year', 'year'),
      F(2, 'month', 'Month', 'month'),
      F(3, 'brand', 'Brand', 'brand'),
      F(4, 'platform', 'Platform', 'enum', { enumValues: PLATFORMS }),
      F(5, 'accountName', 'Account / Page Name', 'text', { required: false }),
      F(6, 'followers', 'Followers / Likes', 'int'),
      F(7, 'impressions', 'Impressions', 'int'),
      F(8, 'clicks', 'Clicks', 'int'),
      F(9, 'engagementPaid', 'Paid Engagement', 'int'),
      F(10, 'engagementOrganic', 'Organic (Free) Engagement', 'int'),
    ],
  },
  {
    // Each brand has its own website: one row per Year + Month + Brand.
    id: 'web', sheet: SHEET_P3, headerRow: 259, lastRow: 320, keyFields: ['year', 'month', 'brand'],
    prefillFields: ['year', 'month', 'brand'],
    cols: [
      F(1, 'year', 'Year', 'year'),
      F(2, 'month', 'Month', 'month'),
      F(3, 'brand', 'Brand', 'brand'),
      F(4, 'bounceVisitors', 'Single-Page (Bounce) Visitors', 'int'),
      F(5, 'totalVisitors', 'Total Visitors', 'int'),
      F(6, 'sessions', 'Total Sessions', 'int'),
      F(7, 'totalMinutes', 'Total Time Spent by All Visitors', 'decimal'),
    ],
  },
  {
    id: 'trade', sheet: SHEET_P4, headerRow: 5, lastRow: 29, keyFields: ['year', 'month'],
    cols: [
      F(1, 'year', 'Year', 'year'),
      F(2, 'month', 'Month', 'month'),
      F(3, 'compliancePct', 'Trade Marketing Report Score', 'pct'),
      F(5, 'giveawaysStockPct', 'Giveaways Stock Available', 'pct'),
      F(7, 'printedStockPct', 'Printed Materials Stock Available', 'pct'),
      F(9, 'attendeesActual', '# Attendees - Actual', 'int'),
      F(10, 'attendeesExpected', '# Attendees - Expected', 'int'),
    ],
  },
  {
    id: 'events', sheet: SHEET_P4, headerRow: 33, lastRow: 63, keyFields: ['name', 'brand'],
    cols: [
      F(1, 'name', 'Event Name', 'text'),
      F(2, 'eventType', 'Event Type', 'enum', { enumValues: EVENT_TYPES }),
      F(3, 'brand', 'Brand', 'brand'),
      F(4, 'plannedDate', 'Planned Date', 'date'),
      F(5, 'completionDate', 'Completion Date', 'date', { required: false }),
      F(6, 'status', 'Status', 'enum', { enumValues: EVENT_STATUSES }),
    ],
  },
];

export const TABLE_LABELS: Record<TableSpec['id'], string> = {
  spend: 'P1 MARCOM Spending',
  other: 'P1b Other MARCOM Spending (non-campaign)',
  campaigns: 'P2 Table A - Campaigns',
  media: 'P2 Table B - OOH coverage by city',
  social: 'P3 Table A - Social media',
  web: 'P3 Table B - Website traffic',
  trade: 'P4 Table A - Trade KPIs',
  events: 'P4 Table B - Events',
};
