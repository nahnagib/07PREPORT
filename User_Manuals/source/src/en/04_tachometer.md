# <!-- only:full -->Promotion: <!-- /only -->Tachometer

## Purpose

The **Tachometer** shows at a glance whether sales are on target, year-to-date (YTD) and month-to-date (MTD). Each figure appears as a speedometer-style gauge with green, amber and red zones.
<!-- only:sales -->
Everything on your Tachometer is calculated from **your own sales and your own targets**.
<!-- /only -->

**To open it:** in the sidebar click **Promotion**, then click the **Tachometer** card, or the **Tachometer** tab in the bottom bar. The page title in the header is **Promotion Dashboard**.

## What's on the page

<!-- only:full -->
![The Tachometer page](shots/tach_top.png){annot="1:140,126;2:740,162;3:930,126;4:140,441;5:740,478;6:930,441"}
<!-- /only -->
<!-- only:sales -->
![Your Tachometer page](shots/sales_tach_top.png){annot="1:140,154;2:740,190;3:930,154;4:140,469;5:740,506;6:930,469"}
<!-- /only -->

The top of the page has six cards:

| # | Card | What it shows |
|---|---|---|
| 1 | **YTD Value** | Sales value (LYD) from 1 January to the **To Date**, against the target for the same period. |
| 2 | **YTD Actual ASP** | Average Selling Price year-to-date (sales value ÷ volume), against the ASP target. |
| 3 | **YTD Volume** | Quantity sold year-to-date, against the volume target. |
| 4 | **MTD Value** | Sales value from the 1st of the month to the **To Date**. |
| 5 | **MTD Actual ASP** | Average Selling Price month-to-date. |
| 6 | **MTD Volume** | Quantity sold month-to-date. |

### Reading a gauge card

![Parts of a gauge card](shots/tach_gauge.png){annot="1:150,44;2:525,44;3:460,78;4:410,106;5:290,160;6:215,236;7:567,275;8:640,275;9:195,352" width="75%"}

1. **Card name**, for example **YTD Value**.
2. **Status badge**: **On Track** (green), **Behind Target** (amber) or **Critical** (red). See *Colours and status badges*.
3. **Actual**: the big number, for example LYD 154.0M. (**K** = thousand, **M** = million.)
4. **Target-to-date**: the small figure at the top of the gauge. This is the target for the period so far, not the full-year target.
5. **Needle**: points at the actual figure. The coloured arc is red below 90% of target, amber from 90% to 100%, and green above 100%.
6. **Scale ends**: the left end is half the target (50%) and the right end is one and a half times the target (150%).
7. **Progress bar and %**: actual as a percentage of target-to-date. 100% means the target is reached.
8. **Trend line**: a small chart of the month-by-month pattern.
9. **Comparison row**:
    - **YTD cards**: **LYTD** (last year, same period), **LFY** (last full year's actual), **FYT** (full-year target) and **Variance** (change compared with LYTD).
    - **MTD cards**: **LMTD** (the same month last year, up to the same day), **LFM** (the previous full calendar month's actual), **FMT** (full-month target for the current month) and **Variance** (change compared with LMTD).

### Reading an ASP card

The **YTD Actual ASP** and **MTD Actual ASP** cards show the average selling price in LYD, the **Target** ASP, the **Variance** compared with the same period last year, and a small trend chart. The status badge compares the actual ASP with the target.

## Performance Details tables

Scroll down to see two **Performance Details** tables, one for value and one for volume and ASP.

![Performance Details](shots/tach_perf.png)

| Column | Meaning |
|---|---|
| **Metric Name** | For example YTD Value, MTD Volume, Full Last Year Value. |
| **Actual** | The figure for the selected period. |
| **LYTD** | The same period last year (for MTD rows, the same month last year). |
| **Target** | The target for the same period. |
| **Variance to LYTD** | % change compared with last year's same period. Positive means growth. |
| **Variance to Target** | % above (+) or below (−) target. |
| **Status** | The status badge. |

The date and time under **Performance Details** show when the table was produced. Click **Export PDF** next to a table to download it (see *Reports and exporting*).

## Changing the period

1. Click **Show filters**.
2. Change **To Date** to the day you want to measure up to. For example, choose 30 June to see the position at the end of June.
3. The YTD cards then show 1 January to 30 June, and the MTD cards show 1 June to 30 June.

<!-- only:full -->
You can also narrow the Tachometer to a **Company**, **Customer Group**, **Distribution Channel**, **Branch** or **Salesperson** (see *The filter bar*).
<!-- /only -->

> [!NOTE]
> The YTD and MTD windows are always worked out from the **To Date**. YTD starts on 1 January of that date's year, and MTD starts on the 1st of that date's month.

## Opening a breakdown

Each **Value** and **Volume** gauge card can be opened to see who is contributing to the figure.

1. Click anywhere on the **YTD Value**, **YTD Volume**, **MTD Value** or **MTD Volume** card.
2. The breakdown page opens, for example **YTD Value — Breakdown**, keeping your current filters.

<!-- only:full -->
![A breakdown page](shots/tach_breakdown.png){annot="1:900,145;2:280,590;3:585,590;4:890,590;5:1195,590;6:1500,590"}
<!-- /only -->
<!-- only:sales -->
![Your breakdown page](shots/sales_breakdown.png){annot="1:900,145;2:280,590;3:585,590;4:890,590;5:1195,590;6:1500,590"}
<!-- /only -->

1. **Summary gauge**: the same figure as on the Tachometer, with **Variance** to target and the **FY/FM Target** (full-year or full-month target).
2. **Total Groups**: how many salespersons are included.
3. **On Target**: how many of them have reached their target.
4. **Critical**: how many are more than 10% below target.
5. **Top Performer**: the salesperson furthest above target, with their variance.
6. **Needs Attention**: the salesperson furthest below target.

### The Full Breakdown table

<!-- only:full -->
![Full Breakdown table](shots/tach_breakdown_table.png){annot="1:340,80;2:1275,80;3:1435,45;4:175,122;5:313,147;6:100,575;7:1225,575"}
<!-- /only -->
<!-- only:sales -->
![Your Full Breakdown table](shots/sales_breakdown_table.png){annot="1:340,75;2:1275,75;3:1435,42;4:175,118;5:313,143;6:100,226;7:1225,226"}
<!-- /only -->

1. **Search all columns...**: type a name or value to show only the matching rows.
2. **Export CSV**: downloads the table as a CSV file (opens in Excel).
3. **Export as PDF**: downloads the table as a PDF.
4. **Column headings** (**Salesperson**, **Actual**, **Target-to-date**, **Variance**, **Status**): click the arrows next to a heading to sort by it.
5. **Filter...**: the box under each heading filters that column only. For example, type *Critical* under **Status**.
6. **Row count**: how many rows match.
7. **Rows per page** (**10 / page** … **100 / page**), **Prev**, **Next** and the page number.

A salesperson with no target shows **—** and the status **No Target**.

To return to the Tachometer, click **Back** (the arrow) in the header, or the **Tachometer** tab.

<!-- only:sales -->
> [!NOTE]
> Because your data is limited to your own record, your breakdown shows a single row: you. **Total Groups** is 1, and you are both the **Top Performer** and **Needs Attention**.
<!-- /only -->

## Tips

> [!TIP]
> The **target-to-date** grows every day through the year. A salesperson can be **On Track** on the YTD card while **Critical** on the MTD card, which means this month is slower than the rest of the year.

> [!TIP]
> Turn on light mode (the moon icon) before taking a screenshot or printing the page. It's easier to read on paper.

> [!WARNING]
> Figures are only as recent as the last data refresh (see *How often the data is refreshed*). Sales entered in the last few hours may not be included yet.
