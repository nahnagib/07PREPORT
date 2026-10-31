import type { VisualHelpContent } from '@07ps/ui';

/**
 * Every visual's "?" (what it shows: definition, formula, notes) and "i" (what you can do with it), in ONE reviewable
 * place, keyed by a stable visual id `<department>.<page>.<visual>`. Formulas follow the backend measures
 * (backend/src/measures/*, backend/src/marcomKpi/formulas.ts, config/npsThresholds.ts) and docs/product_data_runbook.md;
 * nothing here is a guess. Pages pass `{...vh('promotion.tachometer.ytdValue')}` to ChartPanel / KpiCard / InsightCard /
 * PerformanceReportTable or their own card headers; components add standard lines (expand to table, export) themselves.
 */
export interface VisualHelpEntry {
  help: VisualHelpContent;
  interactions?: readonly string[];
}

// ---- shared wording -------------------------------------------------------------------------------------------------
const STATUS = 'Status: On Track = Actual ≥ Target · Behind Target = up to 10% below · Critical = more than 10% below';
const VAR_TARGET = 'Variance to Target = (Actual − Target) ÷ Target';
const YTD_TARGET = 'Target to date = full targets of the completed months + this month\'s target × (day of month ÷ days in month)';
const MTD_TARGET = 'MTD target to date = month target × (day of month ÷ days in month)';
const ASP = 'ASP = Value ÷ Volume';
const PDF = 'Export the visual as PDF';
const PERF_DETAILS = (what: string): VisualHelpEntry => ({
  help: {
    definition: `Every metric of this page in one table: ${what}, against its target and last year where there is one.`,
    formula: [VAR_TARGET, 'Variance LY = (Actual − Last year same period) ÷ Last year same period', STATUS],
    notes: 'Same filters and as-of date as the page.',
  },
  interactions: ['Hover a trend line for its values'],
});
const ODOO = 'Click a name / number to open it in Odoo (new tab)';
const GRID = ['Search all columns with the search box', 'Filter any column using the boxes under the headers', 'Sort by clicking a column header (Shift-click to add a second sort)', 'Pin a column so it stays visible', 'Export the rows to CSV / Excel or PDF, or copy them', 'Move between pages with Previous / Next'];
const CUSTOMER_STATUS_RULES = [
  'Active Retained = purchased YTD and LYTD',
  'Non Active = purchased LYTD, not YTD',
  'Reactivated = purchased YTD, not LYTD, with purchases before LYTD',
  'New = purchased YTD, not LYTD, no purchases before',
  'Blocked = flagged blocked in Odoo (overrides every other status)',
  'Other = none of the above (e.g. purchases only before LYTD)',
];
const BCG_RULE = 'High Volume = YTD volume ≥ 3,500 (Majaal) or 25,000 (Tika) · High Profit = GP% ≥ 35% · Stars = HV/HP · Cash Cows = HV/LP · Strategic = LV/HP · Dogs = LV/LP';
const GP = 'GP% = (Value − Quantity × Odoo standard cost) ÷ Value';
const DOH = 'Days of inventory = stock on hand ÷ (invoiced quantity in the last 90 days ÷ 90)';
const STOCK_BAND = 'Overstock: DOH above 180 days (Majaal) / 60 (Tika), or stock with no sales in 90 days · Stock-out risk: DOH below 60 days (Majaal) / 30 (Tika)';
const OVERDUE = 'A line is overdue from the day after its due date (the line\'s own due date, else the invoice\'s)';
const NPS_LEVELS = '★★★ = Promoter (NPS 9–10) · ★★ = Passive (7–8) · ★ = Detractor (0–6)';
const NPS = 'NPS = % Promoters − % Detractors, % = count ÷ Responders × 100';
const CSAT = 'CSAT = (Passives + Promoters) ÷ Responders × 100';

export const VISUAL_HELP = {
  'admin.criticalNumber.setting': { help: { definition: 'Base daily sales pace in LYD, before company and customer-group allocations.', formula: 'Daily Critical Number = base LYD × company share × customer-group share', notes: 'Saved here; used on the next dashboard load.' }, interactions: ['Enter the base LYD amount and press Save'] },
  // ================================================ PROMOTION =======================================================
  // ---- Tachometer -----------------------------------------------------------------------------------------------------
  'promotion.tachometer.ytdValue': {
    help: {
      definition: 'Net sales value (LYD, untaxed, confirmed orders) from 1 Jan to the as-of date, against the target to date.',
      formula: [VAR_TARGET, 'Variance to LYTD = (YTD − LYTD) ÷ LYTD', 'Achievement % = YTD ÷ Target to date', YTD_TARGET, STATUS],
      notes: 'LYTD = same dates last year; LFY = the full last year.',
    },
    interactions: ['Click the card to see YTD Value by salesperson, branch, customer group and more'],
  },
  'promotion.tachometer.ytdVolume': {
    help: {
      definition: 'Invoiced quantity from 1 Jan to the as-of date, against the volume target to date.',
      formula: [VAR_TARGET, 'Variance to LYTD = (YTD − LYTD) ÷ LYTD', YTD_TARGET, STATUS],
    },
    interactions: ['Click the card to see YTD Volume by salesperson, branch, customer group and more'],
  },
  'promotion.tachometer.mtdValue': {
    help: {
      definition: 'Net sales value (LYD) from the 1st of the month to the as-of date, against the month target to date.',
      formula: [VAR_TARGET, 'Variance to LMTD = (MTD − LMTD) ÷ LMTD', MTD_TARGET, STATUS],
      notes: 'LMTD = same days of the same month last year.',
    },
    interactions: ['Click the card to see MTD Value by salesperson, branch, customer group and more'],
  },
  'promotion.tachometer.mtdVolume': {
    help: {
      definition: 'Invoiced quantity from the 1st of the month to the as-of date, against the month volume target to date.',
      formula: [VAR_TARGET, 'Variance to LMTD = (MTD − LMTD) ÷ LMTD', MTD_TARGET, STATUS],
    },
    interactions: ['Click the card to see MTD Volume by salesperson, branch, customer group and more'],
  },
  'promotion.tachometer.ytdAsp': {
    help: {
      definition: 'Average selling price YTD: what one unit sold for on average, against the price the year target implies.',
      formula: [ASP, 'Target ASP = full-year target value ÷ full-year target volume', VAR_TARGET, STATUS],
    },
  },
  'promotion.tachometer.mtdAsp': {
    help: {
      definition: 'Average selling price this month to date, against the price the month target implies.',
      formula: [ASP, 'Target ASP = month target value ÷ month target volume', VAR_TARGET, STATUS],
    },
  },
  'promotion.tachometer.valueDetails': PERF_DETAILS('YTD and MTD Value'),
  'promotion.tachometer.volumeAspDetails': PERF_DETAILS('YTD and MTD Volume and ASP'),
  // ---- Tachometer breakdown -----------------------------------------------------------------------------------------
  'promotion.tachometerBreakdown.headline': {
    help: { definition: 'The metric you opened, for the whole selection, with its target to date.', formula: [VAR_TARGET, STATUS] },
  },
  'promotion.tachometerBreakdown.totalGroups': { help: { definition: 'How many groups (e.g. salespeople) of the chosen dimension have data for this metric.' } },
  'promotion.tachometerBreakdown.onTarget': { help: { definition: 'Groups whose actual reached their own target to date.', formula: 'On Target = Actual ≥ Target to date' } },
  'promotion.tachometerBreakdown.critical': { help: { definition: 'Groups more than 10% below their target to date.', formula: 'Critical = Actual < 90% of Target to date' } },
  'promotion.tachometerBreakdown.topPerformer': { help: { definition: 'The group with the best variance to its target.', formula: VAR_TARGET } },
  'promotion.tachometerBreakdown.needsAttention': { help: { definition: 'The group with the worst variance to its target.', formula: VAR_TARGET } },
  'promotion.tachometerBreakdown.table': {
    help: { definition: 'The metric per group of the chosen dimension: actual, target to date, variance and status.', formula: [VAR_TARGET, STATUS] },
    interactions: ['Switch the dimension (salesperson, branch, customer group …) above the table', ...GRID],
  },
  // ---- Critical Number ------------------------------------------------------------------------------------------------
  'promotion.criticalNumber.daily': {
    help: {
      definition: 'The sales value (LYD) the company must invoice every working day to stay on its annual pace.',
      notes: 'Set by an admin (Admin › Critical Number); changes apply on the next dashboard load.',
    },
  },
  'promotion.criticalNumber.dailyCounter': {
    help: { definition: 'Today\'s invoiced value against the Daily Critical Number.', formula: ['Gap = Actual today − Daily Critical Number'] },
  },
  'promotion.criticalNumber.monthlyCounter': {
    help: {
      definition: 'Value invoiced this month against the pace the Daily Critical Number sets for the working days so far.',
      formula: ['Monthly pace = working days MTD × Daily Critical Number', 'Gap = Actual MTD − Monthly pace'],
    },
  },
  'promotion.criticalNumber.yearlyCounter': {
    help: {
      definition: 'Value invoiced this year against the pace the Daily Critical Number sets for the working days so far.',
      formula: ['Yearly pace = working days YTD × Daily Critical Number', 'Gap = Actual YTD − Yearly pace'],
    },
  },
  'promotion.criticalNumber.workingDays': {
    help: {
      definition: 'Working days from 1 Jan to the as-of date, compared with the same dates last year.',
      formula: 'Working days = calendar days − Fridays (weekly rest) − official holidays',
      notes: 'Forced closures do not reduce working days: they close one branch, not the company.',
    },
    interactions: ['Hover the comparison for last year\'s count'],
  },
  'promotion.criticalNumber.holidays': {
    help: { definition: 'Official holidays from 1 Jan to the as-of date (Admin › Official Holidays).', notes: 'They are not working days.' },
    interactions: ['Open "Holiday List" to see each holiday'],
  },
  'promotion.criticalNumber.closures': {
    help: { definition: 'Days a branch was closed (Admin › Forced Closures) from 1 Jan to the as-of date.', notes: 'Shown for information; they do not change the company working days.' },
    interactions: ['Open "Branch Breakdown" to see the closures per branch'],
  },
  'promotion.criticalNumber.restDays': {
    help: { definition: 'Fridays (the weekly rest day) from 1 Jan to the as-of date.' },
  },
  'promotion.criticalNumber.missingValue': {
    help: {
      definition: 'How far the year is ahead of (or behind) the Critical Number pace, in LYD.',
      formula: ['Pace YTD = Working days YTD × Daily Critical Number', 'Shown = Actual YTD Value − Pace YTD'],
      notes: 'Positive (green) = ahead of pace, negative = behind; days above the number offset days below it.',
    },
    interactions: ['Expand ⤢ to see the monthly trend'],
  },
  'promotion.criticalNumber.missingDays': {
    help: {
      definition: 'The Missing Value YTD expressed in working days (same sign: positive = days ahead of pace).',
      formula: 'Missing Days YTD = Missing Value YTD ÷ Daily Critical Number',
    },
    interactions: ['Expand ⤢ to see the monthly trend'],
  },
  'promotion.criticalNumber.details': PERF_DETAILS('daily, monthly and yearly counters, working days and missing value'),
  // ---- Revenue Trend --------------------------------------------------------------------------------------------------
  'promotion.revenueTrend.momValue': {
    help: { definition: 'Sales value (LYD) per month this year, with the same month last year and the month target.', formula: ['Month target for the current month is prorated: target × (day ÷ days in month)', VAR_TARGET] },
    interactions: [PDF],
  },
  'promotion.revenueTrend.momVolume': {
    help: { definition: 'Invoiced quantity per month this year, with the same month last year and the month target.', formula: VAR_TARGET },
    interactions: [PDF],
  },
  'promotion.revenueTrend.momAsp': {
    help: { definition: 'Average selling price per month this year, with last year and the target ASP.', formula: [ASP, 'Target ASP = month target value ÷ month target volume'] },
    interactions: [PDF],
  },
  'promotion.revenueTrend.varianceCard': {
    help: {
      definition: 'Pass / fail: did the actual reach the target to date? Shows the variance in %.',
      formula: [VAR_TARGET, 'Pass = Actual ≥ Target to date', YTD_TARGET, MTD_TARGET, 'ASP target = target value ÷ target volume'],
    },
  },
  'promotion.revenueTrend.details': PERF_DETAILS('monthly and YTD Value, Volume and ASP'),
  // ---- Invoices Engine ------------------------------------------------------------------------------------------------
  'promotion.invoicesEngine.linesPerInvoice': {
    help: { definition: 'How many product lines an invoice has on average, for LYTD, YTD, LMTD and MTD.', formula: '# of Lines per Invoice = invoice lines ÷ # of invoices', notes: 'An invoice is one confirmed sales order.' },
    interactions: [PDF],
  },
  'promotion.invoicesEngine.salesPerInvoice': {
    help: { definition: 'Average invoice value (LYD) for LYTD, YTD, LMTD and MTD.', formula: 'Sales per Invoice = Value ÷ # of invoices' },
    interactions: [PDF],
  },
  'promotion.invoicesEngine.volumePerInvoice': {
    help: { definition: 'Average invoiced quantity per invoice for LYTD, YTD, LMTD and MTD.', formula: 'Volume per Invoice = Volume ÷ # of invoices' },
    interactions: [PDF],
  },
  'promotion.invoicesEngine.salesTrend': {
    help: { definition: 'Invoice sales value (LYD) and number of invoices by year.' },
    interactions: ['Turn on drill-down, then click a year to split it by Invoice Class', PDF],
  },
  'promotion.invoicesEngine.totalInvoices': {
    help: { definition: 'Number of invoices (confirmed sales orders) in the period: YTD, LYTD (same dates last year), MTD or LMTD.' },
  },
  'promotion.invoicesEngine.invoicesTrend': {
    help: { definition: 'Number of invoices per month, this year against last year.' },
    interactions: [PDF],
  },
  'promotion.invoicesEngine.classification': {
    help: {
      definition: 'Invoice value YTD split by invoice size.',
      formula: 'Class A > 50K · Class B 25K–50K · Class C 5K–25K · Class D < 5K (invoice value, LYD)',
    },
    interactions: ['Click a class to filter the page by it; click it again to clear', PDF],
  },
  'promotion.invoicesEngine.details': PERF_DETAILS('invoice counts and per-invoice averages'),
  // ---- Customer Growth ------------------------------------------------------------------------------------------------
  'promotion.customerGrowth.newCustomers': {
    help: { definition: 'Customers whose first ever purchase falls in the period (LYTD, YTD, LMTD, MTD).', formula: 'New = first purchase date within the period' },
    interactions: [PDF],
  },
  'promotion.customerGrowth.totalCustomers': {
    help: { definition: 'Customers with at least one purchase in the period (LYTD, YTD, LMTD, MTD).' },
    interactions: [PDF],
  },
  'promotion.customerGrowth.customerStatus': {
    help: { definition: 'Every customer with sales in your filters, by status this year.', formula: CUSTOMER_STATUS_RULES },
    interactions: ['Click the title to open the Customers Table', 'Click a status tile to filter the Customers Table; click the same status again to reset to All', PDF],
  },
  'promotion.customerGrowth.customersTrend': {
    help: { definition: 'Total sales value (LYD) and customer count by year.' },
    interactions: ['Click a year to make it the page\'s year filter; click it again to clear', PDF],
  },
  'promotion.customerGrowth.acquisition': {
    help: { definition: 'Change in new customers YTD vs LYTD.', formula: 'Customer Acquisition = (New YTD − New LYTD) ÷ New LYTD' },
  },
  'promotion.customerGrowth.growth': {
    help: { definition: 'Change in active customers YTD vs LYTD.', formula: 'Customer Growth = (Total YTD − Total LYTD) ÷ Total LYTD' },
  },
  'promotion.customerGrowth.retention': {
    help: {
      definition: 'Share of last year\'s customers who bought again this year.',
      formula: 'Retention Rate = (Active Retained + Reactivated) ÷ Total customers LYTD',
      notes: 'Retention + Churn can exceed 100%: Reactivated customers were not in the LYTD base.',
    },
  },
  'promotion.customerGrowth.churn': {
    help: { definition: 'Share of last year\'s customers who have not bought this year.', formula: 'Churn Rate = Non Active ÷ Total customers LYTD' },
  },
  'promotion.customerGrowth.contribution': {
    help: { definition: 'Share of sales value YTD from the Top 10 customers vs every other customer.', formula: 'Share = group value ÷ total value' },
    interactions: ['Click Top 10 or Other to list that group\'s customers', PDF],
  },
  'promotion.customerGrowth.categoryShare': {
    help: {
      definition: 'Share of sales YTD by customer category. Category A = highest to D = lowest sales value in the last full calendar year (B2B and B2C customers; others have no category). LYTD stays in the table.',
      formula: 'Share = category sales YTD ÷ total sales YTD',
    },
    interactions: ['Click a category to make it the page\'s filter', 'Turn on drill-down to click a category and list its customers instead', PDF],
  },
  'promotion.customerGrowth.details': PERF_DETAILS('new / total customers and the growth rates'),
  'promotion.customerGrowth.customersTable': {
    help: {
      definition: 'Every customer with sales in your filters: YTD and lifetime value, first and last purchase, group / class and status.',
      formula: ['Lifetime Value = all recorded sales of the customer, every year, within your filters', ...CUSTOMER_STATUS_RULES],
    },
    interactions: [
      'Search all columns with the search box', 'Filter any column using the boxes under the headers', 'Sort by clicking a column header',
      'Click a customer name to open it in Odoo (new tab)', 'Filter by status with the Status Slicer', 'Export CSV / Excel / PDF, or copy the rows', 'Move between pages with Previous / Next',
    ],
  },
  // ---- Pipeline Health ------------------------------------------------------------------------------------------------
  'promotion.pipelineHealth.dataQuality': {
    help: { definition: 'Opportunities with missing or conflicting CRM fields that can distort this page (missing stage, segment, dates; open and won at once …).' },
  },
  'promotion.pipelineHealth.fullPipeline': {
    help: {
      definition: 'B2B opportunities created this year and how many reached Quotation, Sales Order and Delivery. Each stage counts distinct opportunities, so it is a subset of the stage before. Stage Benchmark compares each step with its target.',
      formula: ['Conversion = opportunities in the next stage ÷ opportunities in this stage', 'Targets: Opportunity → Quotation 80% · Quotation → Sales Order 15% · Sales Order → Delivery 98%', STATUS],
      notes: 'Lost opportunities are left out.',
    },
    interactions: ['Hover a stage for its count and value', 'Click a stage to see its records (quotations, orders, deliveries)', 'Open the Opportunity chain to follow each opportunity through every stage', PDF],
  },
  'promotion.pipelineHealth.expectedClosure': {
    help: { definition: 'Open opportunities (count and expected revenue, LYD) by expected closing month.' },
    interactions: ['Click a month to see those opportunities', PDF],
  },
  'promotion.pipelineHealth.byStage': {
    help: { definition: 'Opportunity expected revenue (LYD) by current CRM stage, Won and Lost included.' },
    interactions: ['Click a segment to see those opportunities', PDF],
  },
  'promotion.pipelineHealth.probability': {
    help: { definition: 'Open opportunities by win probability set in the CRM (10% to 90% buckets).' },
    interactions: ['Click a bucket to see those opportunities', PDF],
  },
  'promotion.pipelineHealth.details': PERF_DETAILS('funnel counts, values and conversions'),
  'promotion.pipelineHealth.chain': {
    help: { definition: 'Every B2B opportunity created this year, followed through its quotations, sales orders and deliveries, linked through Odoo\'s opportunity reference.' },
    interactions: ['Click a row to see the opportunity’s quotations, orders and deliveries', ...GRID],
  },
  'promotion.pipelineHealth.opportunityDetails': {
    help: { definition: 'The opportunities behind the bar, segment, bucket or stage you clicked.' },
    interactions: [ODOO, 'Download the table as PDF', 'Go back to the charts with Back'],
  },
  'promotion.pipelineHealth.stageRecords': {
    help: { definition: 'The quotations, sales orders or deliveries behind the funnel stage you clicked; the funnel counts distinct opportunities, so one opportunity can have several rows.' },
    interactions: [ODOO, 'Download the table as PDF, or the records with no opportunity as a separate PDF', 'Go back to the charts with Back'],
  },
  // ---- Pipeline Trend -------------------------------------------------------------------------------------------------
  'promotion.pipelineTrend.quotationRates': {
    help: {
      definition: 'Quotations created this year and how they ended.',
      formula: ['Win Rate = Won quotations ÷ Total quotations', 'Won/Lost Ratio = Won quotations ÷ Lost quotations'],
    },
    interactions: [PDF],
  },
  'promotion.pipelineTrend.aging': {
    help: {
      definition: 'Open opportunities and open quotations, each as a 100% bar by age. A healthy pipeline sits mostly in 0–30 days with little 90+.',
      formula: 'Age = as-of date − created date (opportunity) or quotation date · buckets 0–30 · 31–60 · 61–90 · 90+ days',
    },
    interactions: ['Click a bucket to list its opportunities or quotations, with customer and salesperson', PDF],
  },
  'promotion.pipelineTrend.opportunities': {
    help: { definition: 'Opportunities created per month this year: count and expected revenue (LYD).' },
    interactions: [PDF],
  },
  'promotion.pipelineTrend.quotations': {
    help: { definition: 'Quotations created per month this year: count and value (LYD).' },
    interactions: [PDF],
  },
  'promotion.pipelineTrend.salesOrders': {
    help: { definition: 'Sales orders confirmed per month this year: count and value (LYD).' },
    interactions: [PDF],
  },
  'promotion.pipelineTrend.details': PERF_DETAILS('monthly opportunities, quotations and sales orders'),
  'promotion.pipelineTrend.agingDrill': {
    help: { definition: 'The open opportunities or quotations in the age bucket you clicked.' },
    interactions: [...GRID, 'Close the list to go back'],
  },
  // ---- Activity Momentum ----------------------------------------------------------------------------------------------
  'promotion.activityMomentum.counts': {
    help: {
      definition: 'Opportunities by activity status: active, lost, won, without activity, without next step, created YTD.',
      formula: ['Without Activity = open B2B, no real quotation, 30+ days since created', 'Without Next Step = open B2B, last quotation 30+ days ago'],
    },
    interactions: ['Click the title to open the Opportunity Table'],
  },
  'promotion.activityMomentum.inactiveRatio': {
    help: { definition: 'Share of open B2B opportunities at risk of going cold.', formula: 'Inactive Deals Ratio = (Without Activity ∪ Without Next Step) ÷ open B2B opportunities', notes: 'An opportunity in both groups counts once.' },
  },
  'promotion.activityMomentum.lostRatio': {
    help: { definition: 'Share of this year\'s opportunities that were lost.', formula: 'Lost Deals Ratio = Lost YTD ÷ all opportunities created YTD' },
  },
  'promotion.activityMomentum.lostByReason': {
    help: { definition: 'Lost opportunities (count and expected revenue) by the lost reason recorded in the CRM.' },
    interactions: ['Hover a segment for its count and value', PDF],
  },
  'promotion.activityMomentum.newOpportunities': {
    help: { definition: 'New opportunities created per month this year.' },
    interactions: [PDF],
  },
  'promotion.activityMomentum.details': PERF_DETAILS('activity counts and ratios'),
  'promotion.activityMomentum.table': {
    help: { definition: 'The opportunities of the activity status chosen in the slicer, with their last quotation and age.' },
    interactions: ['Pick a status in the Opportunity Status slicer', 'Open "Opportunity Activities" for a row\'s details', 'Download the table as PDF'],
  },

  // ================================================ PRODUCT =========================================================
  'product.bcgMatrix.matrix': {
    help: { definition: 'Products by BCG class: volume against gross profit, calendar YTD.', formula: [BCG_RULE, GP], notes: 'Paper bags and raw materials are excluded; products without a standard cost are "Unclassified (no cost)".' },
    interactions: ['Click a class to filter the product list by it', PDF],
  },
  'product.bcgMatrix.movement': {
    help: { definition: 'How products moved between BCG classes vs the same period last year: New, Stable, Improved, Declined or Discontinued (sold last year, not this year).', formula: BCG_RULE },
    interactions: [PDF],
  },
  'product.bcgMatrix.productDetail': {
    help: { definition: 'Each product with its revenue and volume YTD, volume growth vs LYTD, GP% and BCG class.', formula: ['Vol Growth = (Volume YTD − Volume LYTD) ÷ Volume LYTD', GP] },
    interactions: GRID,
  },
  'product.bcgMatrix.details': PERF_DETAILS('portfolio value, volume and class counts'),
  'product.stockVelocity.movers': {
    help: {
      definition: 'Products sold in the period, split at the median velocity into fast and slow movers. Bars show LYD because units differ between products.',
      formula: ['Velocity = volume in the period ÷ days in the period', 'Fast Movers KPI = top third by velocity'],
    },
    interactions: ['Click Fast or Slow to list its products', 'Go back with Back'],
  },
  'product.stockVelocity.overstock': {
    help: { definition: 'LYD tied up in overstocked or non-moving stock (at Odoo stock valuation), by BCG class.', formula: [DOH, STOCK_BAND] },
    interactions: ['Click a class to list its products, highest value first', 'Go back with Back'],
  },
  'product.stockVelocity.stockOutRisk': {
    help: { definition: 'Above-median sellers whose stock may run out soon, by BCG class.', formula: [DOH, STOCK_BAND] },
    interactions: ['Click a class to list its products, most urgent first', 'Go back with Back'],
  },
  'product.stockVelocity.details': PERF_DETAILS('velocity, days of inventory and stock bands'),
  'product.pimContribution.hierarchy': {
    help: { definition: 'Sales value (LYD) of the period by category, then range / family, then product.', formula: 'Share = slice value ÷ parent value' },
    interactions: ['Click a slice to go one level down', 'Use the breadcrumb or Back to go up'],
  },
  'product.pimContribution.asp': {
    help: { definition: 'Average selling price of the period at the level you are on, in the selected unit.', formula: [ASP, 'Volume is never added across units of measure'] },
  },
  'product.pimContribution.details': PERF_DETAILS('category value, volume and ASP'),
  'product.pimContribution.brands': {
    help: { definition: 'Each brand\'s sales value and volume in the period, and how much of its catalog sold.' },
    interactions: ['Click a brand to open its Brand Performance page'],
  },
  'product.pimContribution.brandDetails': PERF_DETAILS('the brand\'s value, volume and SKUs'),
  'product.productLifecycle.pareto': {
    help: {
      definition: 'Sales value (LYD) by lifecycle segment with the cumulative share.',
      formula: [
        'Never sold = no sale ever · Discontinued = inactive or no sale in 365 days · New = first sale in the last 180 days',
        'Growing = last 90 days quantity > 20% above the previous 90 · Declining = more than 20% below · Mature = within ±20%',
      ],
    },
  },
  'product.productLifecycle.details': PERF_DETAILS('lifecycle segments'),

  // ================================================ PRICE ===========================================================
  'price.receivables.trend': {
    help: {
      definition: 'Open invoices (line) split into overdue and not yet due (stacked bars), with the page filters. Day = each snapshot; Week (Sun–Sat) and Month = the last snapshot of the period.',
      formula: [OVERDUE, 'Open = invoiced − paid'],
    },
    interactions: ['Switch Day / Week / Month', 'Click a period to see its receivables'],
  },
  'price.receivables.collections': {
    help: {
      definition: 'Cash collected per period, with the collection rate where a snapshot exists at the start of the period.',
      formula: 'Collection rate = collected on invoices overdue at the period start ÷ overdue at the period start',
    },
    interactions: ['Switch Day / Week / Month', 'Click a period to list its payments'],
  },
  'price.receivables.byCustomer': {
    help: { definition: 'Top customers by overdue amount and their % of the total overdue.', formula: [OVERDUE, '% = customer overdue ÷ total overdue'] },
    interactions: ['Click a bar for the customer\'s overdue invoices'],
  },
  'price.receivables.aging': {
    help: { definition: 'Open amount per aging bucket. Not due in blue, overdue in red; due today is not overdue.', formula: ['Days overdue = as-of date − overdue date', OVERDUE] },
    interactions: ['Click a bar for its invoices'],
  },
  'price.receivables.bySalesperson': {
    help: { definition: 'Overdue amount per salesperson of the invoice (else the customer of record).', formula: '% = salesperson overdue ÷ total overdue' },
    interactions: ['Click a bar for its overdue invoices', 'Show all or the top 15'],
  },
  'price.receivables.byTeam': {
    help: { definition: 'Overdue amount per branch (sales team of the invoice); an invoice without a sales team is Unknown.', formula: '% = branch overdue ÷ total overdue' },
    interactions: ['Click a bar for its overdue invoices', 'Show all or the top 15'],
  },
  'price.receivables.customerTable': {
    help: { definition: 'Each customer\'s open, overdue and not-yet-due amounts, credit limit and payment term, with the page filters.', formula: OVERDUE },
    interactions: ['Click a row for the customer\'s open invoices', ...GRID],
  },

  // ================================================ PROCESS =========================================================
  'process.npsScore.nps': {
    help: {
      definition: 'Net Promoter Score of the delivery ratings in the period (WhatsApp feedback: B2B on the first delivery of the month, B2C on every delivery).',
      formula: [NPS_LEVELS, NPS, 'Colours: red below 50 · yellow 50 to below 90 · green 90 and up · target 90'],
      notes: 'Below the minimum number of responders the value is greyed with "n = x". Comments are never counted.',
    },
  },
  'process.npsScore.csat': {
    help: { definition: 'Share of responders who were satisfied or better.', formula: [CSAT, 'Colours: red below 85 · yellow 85 to below 95 · green 95 and up · target 95'] },
  },
  'process.npsScore.responseRate': {
    help: {
      definition: 'Share of the feedback messages that reached the customer and got a rating.',
      formula: ['Response Rate = Responders ÷ (Delivered + Read)', 'Rate of reach = Responders ÷ Total reach', 'Colours: Critical below 25% · Behind Target 25–30% · On Track 30% and up'],
    },
  },
  'process.npsScore.satisfactionTrend': {
    help: { definition: 'NPS and CSAT per period (lines) with responders (bars). Muted points have fewer responders than the minimum.', formula: [NPS, CSAT] },
    interactions: ['Switch week / month / year'],
  },
  'process.npsScore.respondersTrend': {
    help: { definition: 'Responders per period (bars) with Promoters, Passives and Detractors (lines).', formula: NPS_LEVELS },
    interactions: ['Switch week / month / year'],
  },
  'process.npsScore.reach': {
    help: { definition: 'WhatsApp feedback messages by message date and company: Delivered, Read, Not Delivered and Error.' },
  },
  'process.npsScore.errors': {
    help: { definition: 'Messages that failed, by the error WhatsApp returned.' },
  },
  'process.npsScore.byReason': {
    help: { definition: 'Detractor cases by the reason recorded on the Detractor Follow-up page, live. "Not yet classified" = a case without a reason yet.' },
  },
  'process.npsScore.byStatus': {
    help: { definition: 'Detractor cases by follow-up status (Detractor Follow-up page), live.' },
  },
  'process.npsScore.detractors': {
    help: { definition: 'Every ★ rating of the period, newest first, with its follow-up case (status, reason, owner, time open) and the customer\'s comment (phone numbers and e-mails masked).' },
    interactions: ['Click a row to open its follow-up case', ODOO, ...GRID],
  },
  'process.kaizen.byStatus': {
    help: { definition: 'Kaizen cards by status.' },
    interactions: ['Click a segment to filter the card list by it'],
  },
  'process.kaizen.byType': {
    help: { definition: 'Kaizen cards by improvement type.' },
    interactions: ['Click a segment to filter the card list by it'],
  },
  'process.kaizen.byDepartment': {
    help: { definition: 'Kaizen cards per department.' },
    interactions: ['Click a bar to filter the card list by it'],
  },
  'process.kaizen.responsible': {
    help: { definition: 'Open and closed Kaizen cards per responsible person.' },
    interactions: ['Click a bar to filter the card list by that person'],
  },

  // ================================================ MARCOM (Promotion) ==============================================
  'marcom.spending.spendVsRevenue': {
    help: {
      definition: 'Marketing spend against the revenue attributed to marketing, per month, with the budget and spend as % of revenue.',
      formula: ['Spend % of Revenue = Σ spend ÷ Σ revenue', 'Budget used = Σ spend ÷ Σ budget'],
      notes: 'Ratios divide sums; they are never averaged across months or brands.',
    },
  },
  'marcom.spending.byCategory': { help: { definition: 'Marketing spend by category: campaigns as one category next to the non-campaign categories.', formula: 'Share = category spend ÷ total spend' } },
  'marcom.spending.reconciliation': { help: { definition: 'Campaign + other spend against the total booked by finance, per month and brand.', formula: 'Unallocated = Finance booked − (Campaign + Other)' } },
  'marcom.spending.otherLines': { help: { definition: 'The non-campaign marketing expense lines, as uploaded.' } },
  'marcom.spending.budgetUtilization': {
    help: { definition: 'Spend against budget per brand or company.', formula: 'Budget utilization = Σ spend ÷ Σ budget', notes: 'Above 100% = over budget.' },
    interactions: ['Switch By Brand / By Company'],
  },
  'marcom.spending.brandGrowth': {
    help: { definition: 'Brand revenue this year against the same months last year.', formula: 'Brand Growth = (Revenue − Revenue LY) ÷ Revenue LY' },
    interactions: ['Switch By Brand / By Company'],
  },
  'marcom.spending.cac': {
    help: {
      definition: 'Marketing spend per new customer, and as a share of the average first invoice.',
      formula: ['CAC = Σ spend ÷ Σ new customers', 'Average invoice = Σ (average invoice × new customers) ÷ Σ new customers', 'CAC % of invoice = CAC ÷ average invoice'],
    },
  },
  'marcom.spending.cpc': { help: { definition: 'Social post cost per click.', formula: 'CPC = Σ social post cost ÷ Σ clicks' } },
  'marcom.campaigns.spendVsRevenue': { help: { definition: 'Spend and revenue of each campaign, with the revenue ÷ spend rate.', formula: 'Rate = Revenue ÷ Spend × 100' } },
  'marcom.campaigns.roiTrend': {
    help: { definition: 'ROI per month this year against last year, with the YTD ROI.', formula: 'ROI = Σ revenue attributed ÷ Σ spend' },
  },
  'marcom.campaigns.roiByCampaign': { help: { definition: 'ROI of each campaign against the green / red bands.', formula: 'ROI = revenue attributed ÷ spend' } },
  'marcom.campaigns.timeline': { help: { definition: 'Campaigns on a calendar from start to end date, coloured by status.' } },
  'marcom.campaigns.cityMap': { help: { definition: 'Campaign spend by city.' } },
  'marcom.campaigns.costByType': { help: { definition: 'Campaign cost by media type.' }, interactions: ['Switch the chart view'] },
  'marcom.digital.followers': { help: { definition: 'Followers per platform (latest month uploaded), with the Meta total (Facebook + Instagram).' } },
  'marcom.digital.ctr': { help: { definition: 'Click-through rate overall and per platform.', formula: 'CTR = Σ clicks ÷ Σ impressions' } },
  'marcom.digital.engagementRate': { help: { definition: 'Engagement rate overall and per platform.', formula: 'Engagement Rate = Σ (paid + organic engagement) ÷ Σ impressions' } },
  'marcom.digital.organicVsPaid': {
    help: { definition: 'Paid and organic engagement per month, with the organic share.', formula: 'Organic share = organic ÷ (paid + organic)' },
    interactions: ['Switch stacked / grouped'],
  },
  'marcom.digital.bounceRate': { help: { definition: 'Share of website visitors who left after one page.', formula: 'Bounce Rate = Σ bounce visitors ÷ Σ visitors' } },
  'marcom.digital.avgSession': { help: { definition: 'Average website session length.', formula: 'Avg session = Σ minutes ÷ Σ sessions' } },
  'marcom.digital.byBrand': { help: { definition: 'Every digital KPI of the page per brand, for the selected period.', formula: ['CTR = Σ clicks ÷ Σ impressions', 'Engagement Rate = Σ (paid + organic) ÷ Σ impressions'] } },
  'marcom.trade.compliance': { help: { definition: 'Retail display compliance: latest month, average and monthly trend.' } },
  'marcom.trade.giveaways': { help: { definition: 'Giveaway stock: latest month, average and monthly trend.' } },
  'marcom.trade.printed': { help: { definition: 'Printed material stock: latest month, average and monthly trend.' } },
  'marcom.trade.eventsByType': { help: { definition: 'Trade events per month by event type.' }, interactions: ['Switch the chart view'] },
  'marcom.trade.eventsTimeline': { help: { definition: 'Trade events on a calendar.' }, interactions: ['Switch the chart view'] },
  'marcom.trade.attendance': { help: { definition: 'Event attendance against the expected number.', formula: 'Attendance Rate = Σ actual ÷ Σ expected' } },
} as const satisfies Record<string, VisualHelpEntry>;

export type VisualHelpId = keyof typeof VISUAL_HELP;

/** `{ help, interactions }` of one visual, to spread onto its component. */
export function vh(id: VisualHelpId): VisualHelpEntry {
  return VISUAL_HELP[id];
}

/** Same, for components that only know a string id (e.g. MarcomChartCard's `visual`); undefined when not registered. */
export function vhById(id: string): VisualHelpEntry | undefined {
  return (VISUAL_HELP as Record<string, VisualHelpEntry>)[id];
}
