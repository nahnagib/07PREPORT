<!-- only:full -->
# Promotion: Critical Number

## Purpose

**Critical Number** turns the annual sales target into a **required daily sales value**, the "critical number". It then tracks, for today, this month and this year, whether sales are keeping pace with it. It also counts working days, official holidays and forced branch closures.

**To open it:** **Promotion** › **Critical Number** card, or the **Critical Number** tab.

![Critical Number: counters](shots/critical_top.png){annot="1:140,103;2:300,230;3:720,230;4:1230,230;5:395,261"}

1. **Date** filter: the counters are calculated up to this day. It defaults to today.
2. **Daily Counter**: today's sales (**Achieved**) and what is still needed (**Remaining**) to reach the daily **Target**, the Daily Critical Number. **Variance** is the gap in %.
3. **Monthly Counter**: working days used this month (for example **22 / 26 Working Days**), **Achieved** and **Remaining** value for the month, and the pace line, for example "114% of pace achieved" and "+LYD 2.3M vs pace".
4. **Yearly Counter**: the same for the year so far.
5. **Export image**: saves that counter as a PNG picture.

The badge on each counter reads **On Pace** (green), **Behind Pace** (amber) or **Underperforming** (red).

## The critical-number cards

![Critical Number: daily target and calendar](shots/critical_mid.png)

| Card | Meaning |
|---|---|
| **Daily Critical Number** | The baseline daily sales target that every counter is measured against. It scales with the **Company** and **Customer Group** filters. |
| **Working Days YTD** | Working days so far this year, with the same period last year for comparison. Weekly rest days (Fridays) and official holidays are excluded. |
| **Weekly Rest Days YTD** | The standard weekly days off so far. |
| **Official Holidays YTD** | Public holidays so far. Click **HOLIDAY LIST** to see each holiday and its date. |
| **Forced Closures YTD** | Days a branch had to close (counted as branch-days). Click **BRANCH BREAKDOWN** to see which branches. |
| **Missing Value YTD** | Net gap against pace: (Working Days YTD × Daily Critical Number) minus actual YTD value. Positive means ahead of pace, negative means behind. |
| **Missing Days YTD** | The Missing Value expressed in days of sales (Missing Value ÷ Daily Critical Number). |

The **Performance Details** table at the bottom summarises every metric with **Actual**, **Target**, **Variance to Target**, **Status** and a plain-language **Takeaway**. Click **Export PDF** to download it.

> [!NOTE]
> A forced closure at one branch does not reduce the company-wide **Working Days YTD**. It appears on its own card instead. Holidays and closures are maintained by the administrator.

> [!TIP]
> If the Daily Counter shows almost nothing early in the day, that's normal. Today's sales are added at each refresh (08:50, 11:50, 14:50, 17:50, 20:50).

# Promotion: Revenue Trend

## Purpose

**Revenue Trend** shows sales **month by month** for the current year, compared with the **same month last year** and with the **target**, for Value, Volume and ASP.

**To open it:** **Promotion** › **Revenue Trend**.

![Revenue Trend](shots/revenue_top.png){annot="1:150,144;2:180,468;3:330,144;4:486,112;5:385,176;6:60,431;7:160,600"}

1. **Chart name**, with an **(i)** icon: point at it to read what the chart shows.
2. **MoM Value**, **MoM Volume** and **MoM ASP** charts: one point per month. The legend shows **Actual** (solid black line), **Y-1** (last year, orange dotted line) and **Target** (purple dashed line).
3. **Export as PDF**: downloads the chart's figures as a PDF.
4. **Expand** (the arrows icon): opens the chart larger, with its figures as a table (**Month**, **Actual**, **Y-1**, **Target**).
5. **Export image**: saves the chart as a PNG picture.
6. **Range slider**: drag the handles at either end of the grey bar to zoom into a range of months.
7. **Variance KPI cards**: **Value**, **Volume** and **ASP Variance to YTD Target**, and the same **to MTD Target**. A pink card means the target is missed, and a white card means it is met.

At the bottom, **Performance Details** lists each metric with **Actual**, **Last** (last year), **Target**, **Variance to Last**, **Variance to Target**, **Status** and **Takeaway**, with **Export PDF**.

# Promotion: Invoices Engine

## Purpose

**Invoices Engine** analyses **invoices**: how many were issued, how efficient they are (lines, value and volume per invoice), and how they split into value bands.

**To open it:** **Promotion** › **Invoices Engine**.

![Invoices Engine](shots/invoices_top.png){annot="1:190,144;2:675,144;3:1195,144;4:150,366;5:745,366;6:1150,350"}

1. **# of Lines per Invoice**: average number of product lines on an invoice, for **LYTD**, **YTD**, **LMTD** and **MTD**.
2. **Sales per Invoice**: average invoice value.
3. **Volume per Invoice**: average quantity per invoice.
4. **Sales Trend**: **Invoice Sales Value** (bars) and **# of Invoices** (line) by year. **Click a year** to filter the whole page to that year. Click **Back to all years** to clear it.
5. **Drill-down**: shows the figures behind the chart.
6. **Total # of Invoices** tiles: **YTD**, **LYTD**, **MTD** and **LMTD** invoice counts.

Further down, **Invoices Trend** shows **Avg Sales per Invoice**, **Avg Lines per Invoice** and **Avg Volume per Invoice** by year.

![Invoices Classification](shots/invoices_class.png)

**Invoices Classification** groups invoices by value:

| Class | Band |
|---|---|
| **High Value** (A) | More than 50K LYD |
| **Upper-Mid Value** (B) | 25K–50K LYD |
| **Medium Value** (C) | 5K–25K LYD |
| **Low Value** (D) | Less than 5K LYD |

Each band shows its total value, its share of the total and the number of invoices. **Click a band** to filter the page to that class. Use **Drill-down** to see the figures behind it.

This page also has the **Customer** filter, which applies to this page only.

# Promotion: Customer Growth

## Purpose

**Customer Growth** tracks the **customer base**: new and total customers, customers kept and lost, which customers contribute most, and how customer categories perform.

**To open it:** **Promotion** › **Customer Growth**.

![Customer Growth](shots/customer_top.png){annot="1:170,176;2:1190,176;3:190,397;4:1240,440"}

1. **New Customers** and **Total Customers**: customer counts for **LYTD**, **YTD**, **LMTD** and **MTD**.
2. **Customer Status**: how many customers are **Active Retained**, **Inactive / Non-Active**, **Blocked** or **Reactivated** (see the table below). Click **View Customer Status details** to open the customer list.
3. **Customers Trend**: **Total Sales Value** (bars) and **Customer Count** (line) by year. Click a year to filter the page to it.
4. **Rate cards**: **Customer Acquisition**, **Customer Growth**, **Retention Rate** and **Churn Rate** (see *Rates* below). A pink card means the rate is unfavourable.

Further down, **Customers Contribution** compares the **Top 10 Customers** with **Other Customers** (click either group to see its customers), and **Customers Category Share** shows sales by customer category (click a category to see its customers, and use **Back to categories** to return). This page can take a few minutes to load.

### Customer statuses

| Status | Meaning |
|---|---|
| **Active Retained** | Bought this year (YTD) **and** in the same period last year (LYTD). |
| **New** | Bought this year, and had never bought before. |
| **Reactivated** | Bought this year, not in LYTD, but had bought before that. |
| **Non Active** | Bought in LYTD but **not** this year. |
| **Blocked** | Blocked in the company system, whatever they have bought. |
| **Other** | Doesn't fit any of the above. |

### Rates

| Rate | How it is calculated |
|---|---|
| **Customer Acquisition** | Change in new customers compared with last year: (New YTD − New LYTD) ÷ New LYTD |
| **Customer Growth** | Change in total customers: (Total YTD − Total LYTD) ÷ Total LYTD |
| **Retention Rate** | (Active Retained + Reactivated) ÷ Total customers LYTD |
| **Churn Rate** | Non Active ÷ Total customers LYTD |

> [!NOTE]
> Retention and Churn don't always add up to 100%. Reactivated customers count towards Retention but weren't part of last year's base.

> [!TIP]
> Use the **Customer** filter to look at a single customer across the whole page.

# Promotion: Pipeline Health

## Purpose

**Pipeline Health** shows the state of the **sales pipeline** (CRM opportunities) this year: how opportunities move from opportunity to quotation to sales order to delivery, what is expected to close and when, and how likely each deal is to close.

**To open it:** **Promotion** › **Pipeline Health**. This page uses **year-to-date data only**.

![Pipeline Health](shots/pipeline_health.png){annot="1:80,380;2:250,144;3:775,230;4:1020,169"}

1. **Full Pipeline**: a funnel of **Opportunities → Quotations → Sales Orders → Deliveries**, with the count, % and value of each stage listed underneath. Click a stage (or **Drill-down**) to list its records.
2. **Opportunity chain**: follows each opportunity through to delivery.
3. **Stage Benchmark**: each step's actual conversion % (for example **Opportunity → Quotation**) against its target %, with a status badge.
4. **Expected Closure Opportunity**: **Expected Opportunity Count** (bars) and **Expected Opportunity Value** (line) by the month deals should close. Click a month to list those opportunities.

Further down, **Opportunity by Stage** shows open opportunities by CRM stage and **Probabilities Distribution** groups them by win probability. Click a segment or bar to list the opportunities. This page can take a few minutes to load.

The opportunity list (**Opportunity Details**) shows **Opportunity Name**, **Stage**, **Probability %**, **Expected Close Date**, **Value**, **Customer**, **Company**, **Salesperson** and **Created Date**, with **Download as PDF**. Click **Back** to return to the charts.

> [!NOTE]
> Won and lost opportunities are left out of the pipeline views, because they are no longer "in the pipeline".

# Promotion: Pipeline Trend

## Purpose

**Pipeline Trend** shows how opportunities, quotations and sales orders develop **month by month**, how quickly quotations are won, and how old the open items are.

**To open it:** **Promotion** › **Pipeline Trend** (year-to-date data only).

![Pipeline Trend](shots/pipeline_trend.png){annot="1:180,176;2:345,381;3:910,176"}

1. **Quotation Rates**: **Total Quotations YTD**, **Won Quotations YTD**, **Lost Quotations YTD**, **Open Quotations YTD**, **Win Rate YTD** and **Won/Lost Ratio YTD**.
2. **Open Opportunities & Quotations by Aging**: open items grouped by age: **0-30 days**, **30-60 days**, **60-90 days** and **90+ days**.
3. **Opportunities**, **Quotations** and **Sales Orders**: monthly counts and values (**#YTD**, **Value YTD**).

**Performance Details** at the bottom lists each metric with **Actual**, **Target**, **Variance%**, **Variance LY**, **Trend**, **Status** and **Takeaway**.

> [!TIP]
> A large **90+ days** bar means quotations are ageing without a decision. Follow them up with the salespersons concerned.

# Promotion: Activity Momentum

## Purpose

**Activity Momentum** shows whether opportunities are being **actively worked**: how many are active, won, lost, or stalled, and why deals are lost.

**To open it:** **Promotion** › **Activity Momentum** (year-to-date data only).

![Activity Momentum](shots/activity.png){annot="1:205,176;2:270,389;3:1190,389;4:1500,180"}

1. **Opportunity Activities**: **#YTD** (opportunities created this year), **#Won**, **#W/O Activity**, **#Active**, **#Lost** and **#W/O Next Step**.
2. **Total Lost Opportunity by Reason**: why opportunities were lost, as a share of all lost opportunities.
3. **New Opportunities**: opportunities created per month (**YTD**) against **Target**.
4. **Inactive Deals Ratio** and **Lost Deals Ratio** (see the table below). A pink card means the ratio is unfavourable.

| Term | Meaning |
|---|---|
| **#W/O Activity** (without activity) | Open B2B opportunities that have never had a quotation, 30 days or more after they were created. |
| **#W/O Next Step** (without next step) | Open B2B opportunities that had a quotation, but nothing has happened for 30 days or more since the last quotation. |
| **Inactive Deals Ratio** | Opportunities without activity **or** without a next step (each counted once), as a share of open B2B opportunities. |
| **Lost Deals Ratio** | Lost opportunities as a share of all opportunities this year. |

Click **View Opportunity Activities details** to open the **Opportunity Table** (**Created Date**, **Opportunity Name**, **Customer**, **Company**, **Expected Revenue**, **Salesperson**, **Stage**). Use the **Activity Filter** to show only **Active**, **Lost**, **Won**, **Inactive** or **Without Next Step** opportunities. **Opportunity Activities definitions** explains each term on screen.

# Promotion: MARCOM reports

The four **MARCOM** (Marketing Communications) reports show the Marketing department's contribution. Their data comes from a **monthly workbook** uploaded by the Marketing department, not from the sales system.

## Shared controls on MARCOM pages

![MARCOM header and filters](shots/marcom_filters.png){annot="1:380,118;2:95,160;3:195,160;4:415,160;5:525,188;6:1395,254"}

1. **Data as of … — uploaded by … on …**: which month the data runs to, who uploaded it and when.
2. **Year**: the year to show. The previous year is used for comparisons.
3. **From** and **To**: the first and last month of the period.
4. **Brand** (on some pages **Platform** or **Campaign status**): narrows the page.
5. **Reset**: puts the MARCOM filters back to their defaults.
6. Every KPI card shows a status (**On target**, **Watch**, **Off target**, **No target**), the change **vs previous** (**improving**, **worsening**, **unchanged**), and **View as table**.

> [!NOTE]
> The MARCOM filters are separate from the sales filter bar. **Company**, **Branch** and similar filters don't apply to these pages. If a page shows **No MARCOM data uploaded yet**, the workbook for that period hasn't been loaded yet.

## MARCOM Spending

Shows how the marketing budget is spent and what it returns.

![MARCOM Spending (Year 2025 shown)](shots/marcom_spending.png)

- **Total Spend vs Total Revenue**: marketing spend against **Revenue Attributed to Marketing**. Tick **Overlay company revenue** to add **Total Company Revenue**.
- **ROI trend — YTD vs LYTD**: return on investment this year against last year. Green is above the target ratio, red below.
- **Budget utilization by brand**: spend as a % of budget. The line marks **100% of budget**, and brands above it are **Over budget**.
- **Brand growth**: each brand's current figure against last year.
- **CAC — Customer Acquisition Cost** and **CPC — Cost per Click**, including CAC as a % of the average invoice and CPC by brand.

## Media Campaign Performance

Shows the performance of advertising campaigns and outdoor media.

![Media Campaign Performance](shots/marcom_campaigns.png)

- **Spend vs Revenue by Campaign**: each campaign's spend and revenue. Scroll the chart sideways to see all campaigns.
- **Total Spend vs Revenue Rate**: revenue ÷ spend for all campaigns together.
- **ROI by Campaign**: ROI per campaign, coloured green (above target), amber or red.
- **Campaign timeline**: when each campaign ran. Point at a bar for its dates, brand, spend, revenue and ROI.
- **Geographic coverage by type** and **Cost by type**: outdoor media such as **Billboards**, **Mega Billboards**, **Bridge Banners**, **Street Lights** and **Light Screen**, with **Units** and **Cost per unit**. **Cost by type** can be shown as **Bars** or **Bubbles**.

## Digital Performance

Shows social media and website performance.

![Digital Performance](shots/marcom_digital.png)

- **Followers / Likes by platform**: Facebook, Instagram, LinkedIn, TikTok and Google, with the Meta total (Facebook + Instagram).
- **CTR — Click-through rate** and **Engagement Rate**, overall and by platform.
- **Organic vs Paid engagement per month**: shown **Stacked** or **Grouped**, with the organic share.
- **Bounce Rate** (lower is better) and **Average Session Duration** for the website.

## Trade Marketing & Retail

Shows in-store and event marketing.

![Trade Marketing & Retail](shots/marcom_trade.png)

- **Compliance Rate**: how well retail points follow merchandising standards. The card shows the latest month and the average for the period.
- **Giveaways Stock** and **Printed Materials Stock**: stock levels of marketing materials.
- **Events by type — per month**: events by category (Professionals, Architects/Designers, Corporate, CSR, Entertainment, Launch & Opening, Internal/Trainings, Exhibitions). Choose **Include planned** or **Completed only**. Cancelled events are excluded.
- **Events timeline — plan vs completion**: planned against completed events, as a **Timeline** or a **Table** (**Event**, **Type**, **Brand**, **Planned**, **Completion**).
- **Attendance Rate**: actual attendance against expected attendance.
<!-- /only -->
