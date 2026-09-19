/**
 * Single description of the MARCOM Contribution Excel template
 * (backend/assets/marcom/MARCOM_Contribution_Data_Template.xlsx). Bump TEMPLATE_VERSION whenever
 * a sheet, header label or input column changes -- it is stored on every upload batch, and the
 * parser refuses files whose structure no longer matches what is declared here.
 */
export const TEMPLATE_VERSION = '1.0';

export const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

export const PLATFORMS = ['Facebook', 'Google', 'LinkedIn', 'Instagram', 'TikTok'] as const;
export const MEDIA_TYPES = ['1-Street Lights', '2-Mega Billboards', '3-Billboards', '4-Bridge Banners', '5-Light Screen'] as const;
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

export type ColKind = 'year' | 'month' | 'text' | 'enum' | 'brand' | 'date' | 'int' | 'money' | 'decimal' | 'pct';

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
  id: 'spend' | 'campaigns' | 'media' | 'social' | 'web' | 'trade' | 'events';
  sheet: string;
  /** Template's header row / last data row -- used as fallback and for the scan length. */
  headerRow: number;
  lastRow: number;
  cols: ColSpec[];
  keyFields: string[];
}

const F = (col: number, field: string, label: string, kind: ColKind, extra: Partial<ColSpec> = {}): ColSpec => ({
  col, field, label, kind, required: true, ...extra,
});

export const SHEET_P1 = 'P1 - MARCOM Spending';
export const SHEET_P2 = 'P2 - Media Campaigns';
export const SHEET_P3 = 'P3 - Digital Performance';
export const SHEET_P4 = 'P4 - Trade Marketing';

export const TABLES: TableSpec[] = [
  {
    id: 'spend', sheet: SHEET_P1, headerRow: 5, lastRow: 35, keyFields: ['year', 'month', 'brand'],
    cols: [
      F(1, 'year', 'Year', 'year'),
      F(2, 'month', 'Month', 'month'),
      F(3, 'brand', 'Brand', 'brand'),
      F(4, 'spend', 'Total Marketing Spend', 'money'),
      F(5, 'revenueAttributed', 'Revenue Attributed to Marketing', 'money'),
      F(6, 'companyRevenueCurrent', 'Total Company Revenue - Current', 'money'),
      F(7, 'companyRevenueLy', 'Total Company Revenue - Same Month Last Year', 'money'),
      F(8, 'budget', 'Budget Allocated', 'money'),
      F(9, 'newCustomers', '# of New Customers', 'int'),
      F(10, 'avgInvoice', 'Avg Sales per Invoice', 'money'),
      F(11, 'socialPostCost', 'Total Cost of Social Media Posts', 'money'),
      F(12, 'clicks', 'Total Clicks', 'int'),
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
    id: 'media', sheet: SHEET_P2, headerRow: 29, lastRow: 59, keyFields: ['campaignName', 'mediaType'],
    cols: [
      F(1, 'campaignName', 'Campaign Name', 'text'),
      F(2, 'mediaType', 'Media Type', 'enum', { enumValues: MEDIA_TYPES }),
      F(3, 'units', '# of Locations / Units', 'int'),
      F(4, 'cost', 'Cost', 'money'),
    ],
  },
  {
    id: 'social', sheet: SHEET_P3, headerRow: 5, lastRow: 35, keyFields: ['year', 'month', 'platform'],
    cols: [
      F(1, 'year', 'Year', 'year'),
      F(2, 'month', 'Month', 'month'),
      F(3, 'platform', 'Platform', 'enum', { enumValues: PLATFORMS }),
      F(4, 'followers', 'Followers / Likes', 'int'),
      F(5, 'impressions', 'Impressions', 'int'),
      F(6, 'clicks', 'Clicks', 'int'),
      F(7, 'engagementPaid', 'Paid Engagement', 'int'),
      F(8, 'engagementOrganic', 'Organic (Free) Engagement', 'int'),
    ],
  },
  {
    id: 'web', sheet: SHEET_P3, headerRow: 39, lastRow: 63, keyFields: ['year', 'month'],
    cols: [
      F(1, 'year', 'Year', 'year'),
      F(2, 'month', 'Month', 'month'),
      F(3, 'bounceVisitors', 'Single-Page (Bounce) Visitors', 'int'),
      F(4, 'totalVisitors', 'Total Visitors', 'int'),
      F(5, 'sessions', 'Total Sessions', 'int'),
      F(6, 'totalMinutes', 'Total Time Spent by All Visitors', 'decimal'),
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
  campaigns: 'P2 Table A - Campaigns',
  media: 'P2 Table B - OOH coverage',
  social: 'P3 Table A - Social media',
  web: 'P3 Table B - Website traffic',
  trade: 'P4 Table A - Trade KPIs',
  events: 'P4 Table B - Events',
};
