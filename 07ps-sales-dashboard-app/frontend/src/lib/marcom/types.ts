/**
 * Payload types for GET /marcom/kpi/{spending,campaigns,digital,trade} -- mirrors
 * backend/src/marcomKpi/*. The browser only renders these: every value, status, delta and
 * reference-line boundary is computed by the API.
 */
export type Status = 'green' | 'yellow' | 'red' | 'neutral' | 'na';
export type Unit = 'ratio' | 'percent' | 'lyd' | 'minutes' | 'count' | 'days';
export type Direction = 'higher_better' | 'lower_better';

export interface Kpi {
  value: number | null;
  status: Status;
  unit: Unit;
  previous?: number | null;
  delta?: number | null;
  direction?: Direction;
}

export type PageKey = 'spending' | 'campaigns' | 'digital' | 'trade';

export interface Freshness {
  hasData: boolean;
  latestPeriod?: { year: number; month: number; label: string } | null;
  uploadedBy?: string | null;
  uploadedAt?: string;
  batchId?: number;
}

/** kind 'GROUP' = group-level entry, not a brand (BMH = group events): spend only, no brand revenue. */
export interface BrandRef { id: number; name: string; companyKey?: number | null; company?: string | null; kind?: 'BRAND' | 'GROUP' }
export interface CompanyRef { key: number; name: string }

export interface Options {
  years: number[];
  brands: BrandRef[];
  companies?: CompanyRef[];
  platforms?: string[];
  statuses?: string[];
}

export interface Envelope {
  page: PageKey;
  filters: { year: number; fromMonth: number; toMonth: number } & Record<string, unknown>;
  options: Options;
  freshness: Freshness;
  hasData: boolean;
  meta: { missing: string[]; deltaBasis?: string; eventsFilter?: string; revenueNeedsReview?: number; brandNeedsReview?: number };
  period: { year: number; fromMonth: number; toMonth: number };
}

export interface MonthValue { month: number; value: number | null }
export interface Series { total: number; unit: string; series: MonthValue[] }

export interface BrandKpi extends Kpi { brandId: number; brand: string; companyKey?: number | null; company?: string | null; kind?: 'BRAND' | 'GROUP' }
export interface CompanyKpi extends Kpi { companyKey: number | null; company: string; brands: number }

export interface RoiBlock {
  ytd: Kpi;
  lytd: Kpi | null;
  monthly: { month: number; current: number | null; currentStatus: Status; lastYear: number | null; lastYearStatus: Status }[];
  bands: { greenAbove: number; redBelow: number };
}

/** One reconciliation cell: Campaign + Other = Total MARCOM Spend, vs the finance-booked total (when entered). */
export interface Recon { campaignSpend: number; otherSpend: number; totalSpend: number; booked: number | null; unallocated: number | null }

export interface OtherSpendLine {
  year: number; month: number; brandId: number; brand: string; category: string;
  description: string; vendor: string | null; amount: number; notes: string | null;
}

export interface SpendingData extends Envelope {
  totals: {
    /** Total MARCOM Spend = campaign (prorated by active days) + other spend. */
    spend: Series; campaignSpend: Series; otherSpend: Series;
    unallocated: { total: number | null; booked: number | null; rows: number; unit: string; series: MonthValue[] };
    revenueAttributed: Series; brandRevenue: Series; companyRevenue: Series;
    budget: Series;
    spendPctOfRevenue: Kpi & { series: MonthValue[] };
    spendPctOfBrandRevenue: Kpi & { series: MonthValue[] };
    attributedPct: Kpi;
    budgetUsed: Kpi;
  };
  byCategory: { total: number; categories: { category: string; isCampaigns: boolean; amount: number; lines: number | null; share: number | null }[] };
  reconciliation: { overall: Recon; rows: (Recon & { month: number; brandId: number; brand: string })[] };
  otherLines: OtherSpendLine[];
  /** Still in the payload for compatibility; rendered on the Media Campaign Performance page. */
  roi: RoiBlock;
  budgetUtilization: {
    overall: Kpi & BudgetExtra;
    brands: (BrandKpi & BudgetExtra)[];
    companies: (CompanyKpi & BudgetExtra)[];
  };
  brandGrowth: {
    overall: Kpi & GrowthExtra;
    brands: (BrandKpi & GrowthExtra)[];
    companies: (CompanyKpi & GrowthExtra)[];
  };
  cac: {
    bands: { greenAtMost: number; redAbove: number };
    overall: Kpi & { pctOfInvoice: Kpi; weightedAvgInvoice: number | null; newCustomers: number; spend: number };
    brands: (BrandKpi & { pctOfInvoice: Kpi; weightedAvgInvoice: number | null; newCustomers: number; spend: number })[];
  };
  cpc: { overall: Kpi & { socialPostCost: number; clicks: number }; brands: (BrandKpi & { socialPostCost: number; clicks: number })[] };
}

interface BudgetExtra { spend: number; campaignSpend: number; otherSpend: number; budget: number; overBudget: boolean }
/** Brand-level revenue (template 2.0): growth YoY, marketing-attributed share, brand share of the company total. */
interface GrowthExtra { revenueCurrent: number; revenueLastYear: number; attributedPct: Kpi; brandShare: Kpi }

export interface CampaignsData extends Envelope {
  today: string;
  /** ROI trend -- YTD vs LYTD (moved here from the Spending page). */
  roi: RoiBlock;
  totals: { spend: number; revenue: number; rate: Kpi };
  spendVsRevenue: { name: string; brandId: number; brand: string; status: string; spend: number; revenue: number }[];
  roiByCampaign: { bands: { greenAbove: number; redBelow: number }; campaigns: { name: string; brand: string; roi: Kpi }[] };
  timeline: {
    name: string; brandId: number; brand: string; status: string; start: string; end: string; durationDays: number;
    spend: number; revenue: number; roi: number | null; roiStatus: Status; rate: number | null;
  }[];
  /** City map (template 1.1). `No city` = media rows uploaded before the City column. */
  coverageByCity: {
    totalCost: number; totalUnits: number;
    cities: { city: string; cost: number; units: number; share: number | null; campaigns: number; byType: { mediaType: string; units: number; cost: number }[] }[];
  };
  coverageByType: { totalUnits: number; types: { mediaType: string; units: number; share: number | null }[] };
  costByType: { totalCost: number; types: { mediaType: string; cost: number; units: number; costPerUnit: number | null }[] };
}

export interface DigitalData extends Envelope {
  followers: { platforms: { platform: string; value: number | null; asOf: { year: number; month: number } | null }[]; total: number | null; metaTotal: number | null };
  ctr: { overall: Kpi; byPlatform: { platform: string; kpi: Kpi }[] };
  engagementRate: { overall: Kpi; byPlatform: { platform: string; kpi: Kpi }[] };
  engagementMonthly: { year: number; month: number; paid: number | null; organic: number | null; organicShare: number | null }[];
  bounceRate: { kpi: Kpi; series: { year: number; month: number; value: number | null }[] };
  avgSession: { kpi: Kpi; series: { year: number; month: number; value: number | null; status: Status }[] };
  /** Side-by-side comparison, one entry per selected brand (+ "No brand (needs review)" for pre-2.0 rows). */
  byBrand: {
    brandId: number | null; brand: string; needsReview: boolean; followers: number | null;
    impressions: number; clicks: number; engagement: number; ctr: Kpi; engagementRate: Kpi;
    visitors: number | null; bounceRate: Kpi; avgSession: Kpi;
  }[];
}

export interface StockBlock {
  headline: Kpi & { asOf: { year: number; month: number } | null };
  average: Kpi;
  series: { year: number; month: number; value: number | null; status: Status }[];
}

export interface TradeData extends Envelope {
  today: string;
  compliance: StockBlock;
  giveawaysStock: StockBlock;
  printedStock: StockBlock;
  attendance: {
    kpi: Kpi; actual: number; expected: number;
    series: { year: number; month: number; actual: number; expected: number; value: number | null; status: Status }[];
  };
  eventsByTypeMonthly: { year: number; month: number; total: number; byType: Record<string, number> }[];
  eventsTimeline: { name: string; type: string; brandId: number; brand: string; planned: string; completion: string | null; status: string; overdue: boolean }[];
  eventsMonthlySummary: { year: number; month: number; planned: number; completed: number; completionPct: number | null }[];
}

export type PageData = SpendingData | CampaignsData | DigitalData | TradeData;
