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

export interface BrandRef { id: number; name: string; companyKey?: number | null; company?: string | null }
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
  meta: { missing: string[]; deltaBasis?: string; eventsFilter?: string };
  period: { year: number; fromMonth: number; toMonth: number };
}

export interface MonthValue { month: number; value: number | null }
export interface Series { total: number; unit: string; series: MonthValue[] }

export interface BrandKpi extends Kpi { brandId: number; brand: string; companyKey?: number | null; company?: string | null }
export interface CompanyKpi extends Kpi { companyKey: number | null; company: string; brands: number }

export interface RoiBlock {
  ytd: Kpi;
  lytd: Kpi | null;
  monthly: { month: number; current: number | null; currentStatus: Status; lastYear: number | null; lastYearStatus: Status }[];
  bands: { greenAbove: number; redBelow: number };
}

export interface SpendingData extends Envelope {
  totals: {
    spend: Series; revenueAttributed: Series; companyRevenue: Series;
    budget: Series;
    spendPctOfRevenue: Kpi & { series: MonthValue[] };
    spendPctOfCompanyRevenue: Kpi & { series: MonthValue[] };
    budgetUsed: Kpi;
  };
  /** Still in the payload for compatibility; rendered on the Media Campaign Performance page. */
  roi: RoiBlock;
  budgetUtilization: {
    overall: Kpi & { spend: number; budget: number; overBudget: boolean };
    brands: (BrandKpi & { spend: number; budget: number; overBudget: boolean })[];
    companies: (CompanyKpi & { spend: number; budget: number; overBudget: boolean })[];
  };
  brandGrowth: {
    overall: Kpi & { revenueCurrent: number; revenueLastYear: number };
    brands: (BrandKpi & { revenueCurrent: number; revenueLastYear: number })[];
    companies: (CompanyKpi & { revenueCurrent: number; revenueLastYear: number })[];
  };
  cac: {
    bands: { greenAtMost: number; redAbove: number };
    overall: Kpi & { pctOfInvoice: Kpi; weightedAvgInvoice: number | null; newCustomers: number; spend: number };
    brands: (BrandKpi & { pctOfInvoice: Kpi; weightedAvgInvoice: number | null; newCustomers: number; spend: number })[];
  };
  cpc: { overall: Kpi & { socialPostCost: number; clicks: number }; brands: (BrandKpi & { socialPostCost: number; clicks: number })[] };
}

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
