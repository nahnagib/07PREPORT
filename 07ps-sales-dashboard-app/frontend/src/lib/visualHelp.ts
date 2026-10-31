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
const PERF_DETAILS = (what: string): VisualHelpEntry => ({
  help: {
    definition: `Every metric of this page in one table: ${what}, against its target and last year where there is one.`,
    notes: 'Same filters and as-of date as the page.',
  },
});
const ODOO = 'Click a name / number to open it in Odoo (new tab)';
const GRID = ['Search all columns with the search box', 'Filter any column using the boxes under the headers', 'Sort by clicking a column header (Shift-click to add a second sort)', 'Pin a column so it stays visible', 'Export the rows to CSV / Excel or PDF, or copy them', 'Move between pages with Previous / Next'];
const NPS_LEVELS = '★★★ = Promoter (NPS 9–10) · ★★ = Passive (7–8) · ★ = Detractor (0–6)';
const NPS = 'NPS = % Promoters − % Detractors, % = count ÷ Responders × 100';
const CSAT = 'CSAT = (Passives + Promoters) ÷ Responders × 100';

export const VISUAL_HELP = {
  'admin.criticalNumber.setting': { help: { definition: 'Base daily sales pace in LYD, before company and customer-group allocations.', notes: 'Saved here; used on the next dashboard load.' }, },
  // ================================================ PROMOTION =======================================================
  // ---- Tachometer -----------------------------------------------------------------------------------------------------
  'promotion.tachometer.ytdValue': {
    help: {
      definition: 'Net sales value (LYD, untaxed, confirmed orders) from 1 Jan to the as-of date, against the target to date.',
      notes: 'LYTD = same dates last year; LFY = the full last year.',
    },
    interactions: ['Click the card to see YTD Value by salesperson, branch, customer group and more'],
  },
  'promotion.tachometer.ytdVolume': {
    help: {
      definition: 'Invoiced quantity from 1 Jan to the as-of date, against the volume target to date.',
    },
    interactions: ['Click the card to see YTD Volume by salesperson, branch, customer group and more'],
  },
  'promotion.tachometer.mtdValue': {
    help: {
      definition: 'Net sales value (LYD) from the 1st of the month to the as-of date, against the month target to date.',
      notes: 'LMTD = same days of the same month last year.',
    },
    interactions: ['Click the card to see MTD Value by salesperson, branch, customer group and more'],
  },
  'promotion.tachometer.mtdVolume': {
    help: {
      definition: 'Invoiced quantity from the 1st of the month to the as-of date, against the month volume target to date.',
    },
    interactions: ['Click the card to see MTD Volume by salesperson, branch, customer group and more'],
  },
  'promotion.tachometer.ytdAsp': {
    help: {
      definition: 'Average selling price YTD: what one unit sold for on average, against the price the year target implies.',
    },
  },
  'promotion.tachometer.mtdAsp': {
    help: {
      definition: 'Average selling price this month to date, against the price the month target implies.',
    },
  },
  'promotion.tachometer.valueDetails': PERF_DETAILS('YTD and MTD Value'),
  'promotion.tachometer.volumeAspDetails': PERF_DETAILS('YTD and MTD Volume and ASP'),
  // ---- Tachometer breakdown -----------------------------------------------------------------------------------------
  'promotion.tachometerBreakdown.headline': {
    help: { definition: 'The metric you opened, for the whole selection, with its target to date.', },
  },
  'promotion.tachometerBreakdown.totalGroups': { help: { definition: 'How many groups (e.g. salespeople) of the chosen dimension have data for this metric.' } },
  'promotion.tachometerBreakdown.onTarget': { help: { definition: 'Groups whose actual reached their own target to date.', } },
  'promotion.tachometerBreakdown.critical': { help: { definition: 'Groups more than 10% below their target to date.', } },
  'promotion.tachometerBreakdown.topPerformer': { help: { definition: 'The group with the best variance to its target.', } },
  'promotion.tachometerBreakdown.needsAttention': { help: { definition: 'The group with the worst variance to its target.', } },
  'promotion.tachometerBreakdown.table': {
    help: { definition: 'The metric per group of the chosen dimension: actual, target to date, variance and status.', },
    interactions: ['Switch the dimension (salesperson, branch, customer group …) above the table'],
  },
  // ---- Critical Number ------------------------------------------------------------------------------------------------
  'promotion.criticalNumber.daily': {
    help: {
      definition: 'The sales value (LYD) the company must invoice every working day to stay on its annual pace.',
      notes: 'Set by an admin (Admin › Critical Number); changes apply on the next dashboard load.',
    },
  },
  'promotion.criticalNumber.dailyCounter': {
    help: { definition: 'Today\'s invoiced value against the Daily Critical Number.', },
  },
  'promotion.criticalNumber.monthlyCounter': {
    help: {
      definition: 'Value invoiced this month against the pace the Daily Critical Number sets for the working days so far.',
    },
  },
  'promotion.criticalNumber.yearlyCounter': {
    help: {
      definition: 'Value invoiced this year against the pace the Daily Critical Number sets for the working days so far.',
    },
  },
  'promotion.criticalNumber.workingDays': {
    help: {
      definition: 'Working days from 1 Jan to the as-of date, compared with the same dates last year.',
      notes: 'Forced closures do not reduce working days: they close one branch, not the company.',
    },
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
      notes: 'Positive (green) = ahead of pace, negative = behind; days above the number offset days below it.',
    },
  },
  'promotion.criticalNumber.missingDays': {
    help: {
      definition: 'The Missing Value YTD expressed in working days (same sign: positive = days ahead of pace).',
    },
  },
  'promotion.criticalNumber.details': PERF_DETAILS('daily, monthly and yearly counters, working days and missing value'),
  // ---- Revenue Trend --------------------------------------------------------------------------------------------------
  'promotion.revenueTrend.momValue': {
    help: { definition: 'Sales value (LYD) per month this year, with the same month last year and the month target.', },
  },
  'promotion.revenueTrend.momVolume': {
    help: { definition: 'Invoiced quantity per month this year, with the same month last year and the month target.', },
  },
  'promotion.revenueTrend.momAsp': {
    help: { definition: 'Average selling price per month this year, with last year and the target ASP.', },
  },
  'promotion.revenueTrend.varianceCard': {
    help: {
      definition: 'Pass / fail: did the actual reach the target to date? Shows the variance in %.',
    },
  },
  'promotion.revenueTrend.details': PERF_DETAILS('monthly and YTD Value, Volume and ASP'),
  // ---- Invoices Engine ------------------------------------------------------------------------------------------------
  'promotion.invoicesEngine.linesPerInvoice': {
    help: { definition: 'How many product lines an invoice has on average, for LYTD, YTD, LMTD and MTD.', notes: 'An invoice is one confirmed sales order.' },
  },
  'promotion.invoicesEngine.salesPerInvoice': {
    help: { definition: 'Average invoice value (LYD) for LYTD, YTD, LMTD and MTD.', },
  },
  'promotion.invoicesEngine.volumePerInvoice': {
    help: { definition: 'Average invoiced quantity per invoice for LYTD, YTD, LMTD and MTD.', },
  },
  'promotion.invoicesEngine.salesTrend': {
    help: { definition: 'Invoice sales value (LYD) and number of invoices by year.' },
    interactions: ['Turn on drill-down, then click a year to split it by Invoice Class'],
  },
  'promotion.invoicesEngine.totalInvoices': {
    help: { definition: 'Number of invoices (confirmed sales orders) in the period: YTD, LYTD (same dates last year), MTD or LMTD.' },
  },
  'promotion.invoicesEngine.invoicesTrend': {
    help: { definition: 'Number of invoices per month, this year against last year.' },
  },
  'promotion.invoicesEngine.classification': {
    help: {
      definition: 'Invoice value YTD split by invoice size.',
    },
    interactions: ['Click a class to filter the page by it; click it again to clear'],
  },
  'promotion.invoicesEngine.details': PERF_DETAILS('invoice counts and per-invoice averages'),
  // ---- Customer Growth ------------------------------------------------------------------------------------------------
  'promotion.customerGrowth.newCustomers': {
    help: { definition: 'Customers whose first ever purchase falls in the period (LYTD, YTD, LMTD, MTD).', },
  },
  'promotion.customerGrowth.totalCustomers': {
    help: { definition: 'Customers with at least one purchase in the period (LYTD, YTD, LMTD, MTD).' },
  },
  'promotion.customerGrowth.customerStatus': {
    help: { definition: 'Every customer with sales in your filters, by status this year.', },
    interactions: ['Click the title to open the Customers Table', 'Click a status tile to filter the Customers Table; click the same status again to reset to All'],
  },
  'promotion.customerGrowth.customersTrend': {
    help: { definition: 'Total sales value (LYD) and customer count by year.' },
    interactions: ['Click a year to make it the page\'s year filter; click it again to clear'],
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
    help: { definition: 'Share of sales value YTD from the Top 10 customers vs every other customer.', },
    interactions: ['Click Top 10 or Other to list that group\'s customers'],
  },
  'promotion.customerGrowth.categoryShare': {
    help: {
      definition: 'Share of sales YTD by customer category. Category A = highest to D = lowest sales value in the last full calendar year (B2B and B2C customers; others have no category). LYTD stays in the table.',
    },
    interactions: ['Click a category to make it the page\'s filter', 'Turn on drill-down to click a category and list its customers instead'],
  },
  'promotion.customerGrowth.details': PERF_DETAILS('new / total customers and the growth rates'),
  'promotion.customerGrowth.customersTable': {
    help: {
      definition: 'Every customer with sales in your filters: YTD and lifetime value, first and last purchase, group / class and status.',
    },
    interactions: ['Click a customer name to open it in Odoo (new tab)'],
  },
  // ---- Pipeline Health ------------------------------------------------------------------------------------------------
  'promotion.pipelineHealth.dataQuality': {
    help: { definition: 'Opportunities with missing or conflicting CRM fields that can distort this page (missing stage, segment, dates; open and won at once …).' },
  },
  'promotion.pipelineHealth.fullPipeline': {
    help: {
      definition: 'B2B opportunities created this year and how many reached Quotation, Sales Order and Delivery. Each stage counts distinct opportunities, so it is a subset of the stage before. Stage Benchmark compares each step with its target.',
      notes: 'Lost opportunities are left out.',
    },
    interactions: ['Click a stage to see its records (quotations, orders, deliveries)', 'Open the Opportunity chain to follow each opportunity through every stage'],
  },
  'promotion.pipelineHealth.expectedClosure': {
    help: { definition: 'Open opportunities (count and expected revenue, LYD) by expected closing month.' },
    interactions: ['Click a month to see those opportunities'],
  },
  'promotion.pipelineHealth.byStage': {
    help: { definition: 'Opportunity expected revenue (LYD) by current CRM stage, Won and Lost included.' },
    interactions: ['Click a segment to see those opportunities'],
  },
  'promotion.pipelineHealth.probability': {
    help: { definition: 'Open opportunities by win probability set in the CRM (10% to 90% buckets).' },
    interactions: ['Click a bucket to see those opportunities'],
  },
  'promotion.pipelineHealth.details': PERF_DETAILS('funnel counts, values and conversions'),
  'promotion.pipelineHealth.chain': {
    help: { definition: 'Every B2B opportunity created this year, followed through its quotations, sales orders and deliveries, linked through Odoo\'s opportunity reference.' },
    interactions: ['Click a row to see the opportunity’s quotations, orders and deliveries'],
  },
  'promotion.pipelineHealth.opportunityDetails': {
    help: { definition: 'The opportunities behind the bar, segment, bucket or stage you clicked.' },
    interactions: [ODOO],
  },
  'promotion.pipelineHealth.stageRecords': {
    help: { definition: 'The quotations, sales orders or deliveries behind the funnel stage you clicked; the funnel counts distinct opportunities, so one opportunity can have several rows.' },
    interactions: [ODOO],
  },
  // ---- Pipeline Trend -------------------------------------------------------------------------------------------------
  'promotion.pipelineTrend.quotationRates': {
    help: {
      definition: 'Quotations created this year and how they ended.',
      formula: ['Win Rate = Won quotations ÷ Total quotations', 'Won/Lost Ratio = Won quotations ÷ Lost quotations'],
    },
  },
  'promotion.pipelineTrend.aging': {
    help: {
      definition: 'Open opportunities and open quotations, each as a 100% bar by age. A healthy pipeline sits mostly in 0–30 days with little 90+.',
    },
    interactions: ['Click a bucket to list its opportunities or quotations, with customer and salesperson'],
  },
  'promotion.pipelineTrend.opportunities': {
    help: { definition: 'Opportunities created per month this year: count and expected revenue (LYD).' },
  },
  'promotion.pipelineTrend.quotations': {
    help: { definition: 'Quotations created per month this year: count and value (LYD).' },
  },
  'promotion.pipelineTrend.salesOrders': {
    help: { definition: 'Sales orders confirmed per month this year: count and value (LYD).' },
  },
  'promotion.pipelineTrend.details': PERF_DETAILS('monthly opportunities, quotations and sales orders'),
  'promotion.pipelineTrend.agingDrill': {
    help: { definition: 'The open opportunities or quotations in the age bucket you clicked.' },
  },
  // ---- Activity Momentum ----------------------------------------------------------------------------------------------
  'promotion.activityMomentum.counts': {
    help: {
      definition: 'Opportunities by activity status: active, lost, won, without activity, without next step, created YTD.',
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
  },
  'promotion.activityMomentum.newOpportunities': {
    help: { definition: 'New opportunities created per month this year.' },
  },
  'promotion.activityMomentum.details': PERF_DETAILS('activity counts and ratios'),
  'promotion.activityMomentum.table': {
    help: { definition: 'The opportunities of the activity status chosen in the slicer, with their last quotation and age.' },
    interactions: ['Pick a status in the Opportunity Status slicer', 'Open "Opportunity Activities" for a row\'s details'],
  },

  // ================================================ PRODUCT =========================================================
  'product.bcgMatrix.matrix': {
    help: { definition: 'Products by BCG class: volume against gross profit, calendar YTD.', notes: 'Paper bags and raw materials are excluded; products without a standard cost are "Unclassified (no cost)".' },
    interactions: ['Click a class to filter the product list by it'],
  },
  'product.bcgMatrix.movement': {
    help: { definition: 'How products moved between BCG classes vs the same period last year: New, Stable, Improved, Declined or Discontinued (sold last year, not this year).', },
  },
  'product.bcgMatrix.productDetail': {
    help: { definition: 'Each product with its revenue and volume YTD, volume growth vs LYTD, GP% and BCG class.', },
    interactions: GRID,
  },
  'product.bcgMatrix.details': PERF_DETAILS('portfolio value, volume and class counts'),
  'product.stockVelocity.movers': {
    help: {
      definition: 'Products sold in the period, split at the median velocity into fast and slow movers. Bars show LYD because units differ between products.',
    },
    interactions: ['Click Fast or Slow to list its products'],
  },
  'product.stockVelocity.overstock': {
    help: { definition: 'LYD tied up in overstocked or non-moving stock (at Odoo stock valuation), by BCG class.', },
    interactions: ['Click a class to list its products, highest value first'],
  },
  'product.stockVelocity.stockOutRisk': {
    help: { definition: 'Above-median sellers whose stock may run out soon, by BCG class.', },
    interactions: ['Click a class to list its products, most urgent first'],
  },
  'product.stockVelocity.details': PERF_DETAILS('velocity, days of inventory and stock bands'),
  'product.pimContribution.hierarchy': {
    help: { definition: 'Sales value (LYD) of the period by category, then range / family, then product.', },
    interactions: ['Click a slice to go one level down'],
  },
  'product.pimContribution.asp': {
    help: { definition: 'Average selling price of the period at the level you are on, in the selected unit.', },
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
    },
  },
  'product.productLifecycle.details': PERF_DETAILS('lifecycle segments'),

  // ================================================ PRICE ===========================================================
  'price.receivables.trend': {
    help: {
      definition: 'Open invoices (line) split into overdue and not yet due (stacked bars), with the page filters. Day = each snapshot; Week (Sun–Sat) and Month = the last snapshot of the period.',
    },
    interactions: ['Switch Day / Week / Month', 'Click a period to see its receivables'],
  },
  'price.receivables.collections': {
    help: {
      definition: 'Cash collected per period, with the collection rate where a snapshot exists at the start of the period.',
    },
    interactions: ['Switch Day / Week / Month', 'Click a period to list its payments'],
  },
  'price.receivables.byCustomer': {
    help: { definition: 'Top customers by overdue amount and their % of the total overdue.', },
    interactions: ['Click a bar for the customer\'s overdue invoices'],
  },
  'price.receivables.aging': {
    help: { definition: 'Open amount per aging bucket. Not due in blue, overdue in red; due today is not overdue.', },
    interactions: ['Click a bar for its invoices'],
  },
  'price.receivables.bySalesperson': {
    help: { definition: 'Overdue amount per salesperson of the invoice (else the customer of record).', },
    interactions: ['Click a bar for its overdue invoices'],
  },
  'price.receivables.byTeam': {
    help: { definition: 'Overdue amount per branch (sales team of the invoice); an invoice without a sales team is Unknown.', },
    interactions: ['Click a bar for its overdue invoices'],
  },
  'price.receivables.customerTable': {
    help: { definition: 'Each customer\'s open, overdue and not-yet-due amounts, credit limit and payment term, with the page filters.', },
    interactions: ['Click a row for the customer\'s open invoices'],
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
    help: { definition: 'Responders per period (bars) with Promoters, Passives and Detractors (lines).', },
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
    interactions: ['Click a row to open its follow-up case', ODOO],
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
      notes: 'Ratios divide sums; they are never averaged across months or brands.',
    },
  },
  'marcom.spending.byCategory': { help: { definition: 'Marketing spend by category: campaigns as one category next to the non-campaign categories.', } },
  'marcom.spending.reconciliation': { help: { definition: 'Campaign + other spend against the total booked by finance, per month and brand.', } },
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
    },
  },
  'marcom.spending.cpc': { help: { definition: 'Social post cost per click.', } },
  'marcom.campaigns.spendVsRevenue': { help: { definition: 'Spend and revenue of each campaign, with the revenue ÷ spend rate.', } },
  'marcom.campaigns.roiTrend': {
    help: { definition: 'ROI per month this year against last year, with the YTD ROI.', formula: 'ROI = Σ revenue attributed ÷ Σ spend' },
  },
  'marcom.campaigns.roiByCampaign': { help: { definition: 'ROI of each campaign against the green / red bands.', formula: 'ROI = revenue attributed ÷ spend' } },
  'marcom.campaigns.timeline': { help: { definition: 'Campaigns on a calendar from start to end date, coloured by status.' } },
  'marcom.campaigns.cityMap': { help: { definition: 'Campaign spend by city.' } },
  'marcom.campaigns.costByType': { help: { definition: 'Campaign cost by media type.' },
    interactions: ['Switch the chart view'] },
  'marcom.digital.followers': { help: { definition: 'Followers per platform (latest month uploaded), with the Meta total (Facebook + Instagram).' } },
  'marcom.digital.ctr': { help: { definition: 'Click-through rate overall and per platform.', formula: 'CTR = Σ clicks ÷ Σ impressions' } },
  'marcom.digital.engagementRate': { help: { definition: 'Engagement rate overall and per platform.', formula: 'Engagement Rate = Σ (paid + organic engagement) ÷ Σ impressions' } },
  'marcom.digital.organicVsPaid': {
    help: { definition: 'Paid and organic engagement per month, with the organic share.', },
    interactions: ['Switch stacked / grouped'],
  },
  'marcom.digital.bounceRate': { help: { definition: 'Share of website visitors who left after one page.', formula: 'Bounce Rate = Σ bounce visitors ÷ Σ visitors' } },
  'marcom.digital.avgSession': { help: { definition: 'Average website session length.', } },
  'marcom.digital.byBrand': { help: { definition: 'Every digital KPI of the page per brand, for the selected period.', } },
  'marcom.trade.compliance': { help: { definition: 'Retail display compliance: latest month, average and monthly trend.' } },
  'marcom.trade.giveaways': { help: { definition: 'Giveaway stock: latest month, average and monthly trend.' } },
  'marcom.trade.printed': { help: { definition: 'Printed material stock: latest month, average and monthly trend.' } },
  'marcom.trade.eventsByType': { help: { definition: 'Trade events per month by event type.' },
    interactions: ['Switch the chart view'] },
  'marcom.trade.eventsTimeline': { help: { definition: 'Trade events on a calendar.' },
    interactions: ['Switch the chart view'] },
  'marcom.trade.attendance': { help: { definition: 'Event attendance against the expected number.', } },
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
