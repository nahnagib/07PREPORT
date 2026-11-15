<!-- only:full -->
# Product: BCG Matrix

## Purpose

The **BCG Matrix** groups products by sales volume and gross profit margin. **Product Movement** compares sales volume with the same period last year.

**To open it:** in the sidebar click **Product**, then the **BCG Matrix** card or tab.

1. **STARS**: high volume **and** high profit.
2. **CASH COWS**: high volume, lower profit.
3. **STRATEGIC**: lower volume, high profit.
4. **DOGS**: lower volume and lower profit.
On desktop, Stars and Cash Cows are on the top row and Strategic and Dogs are on the bottom row. Each card shows up to 10 products by volume, with units and profit in LYD. Hover over a product to see its data date and class rule. The card's CSV and PDF exports include every SKU in the class.

### How products are classified

| | Gross profit ≥ 35% | Gross profit < 35% |
|---|---|---|
| **Volume ≥ company threshold** | **Stars** | **Cash Cows** |
| **Volume < company threshold** | **Strategic** | **Dogs** |

The volume thresholds are **3,500 units for Majaal** and **25,000 units for Tika**. The class and profit use the same data. The dashboard checks calendar YTD and prior years for the latest complete period with recorded costs and a gross margin. If none qualifies, it checks the fully costed daily totals. The **Profit data as of** subtitle shows the latest date used across the products shown.

Products with no usable cost appear under **Not classified** and show **–** for Profit. A product with zero revenue and recorded cost shows its profit under **Not classified** because its gross margin is undefined.

## Product Movement

The movement labels compare each product's calendar YTD sales volume with the same dates last year.

| Movement | Meaning |
|---|---|
| **New** | First sale within 180 days or no sales volume in the equivalent period last year. |
| **Stable** | Volume changed by at most 10% in either direction. |
| **Improved** | Volume increased by more than 10%. |
| **Drop** | Volume decreased by more than 10%. |
| **Discontinued** | Product is archived in Odoo. |

**Product Movement** is the donut chart above Product Detail. Click a slice to list those products.

## Product Detail table

![BCG Matrix: Product Detail](shots/bcg_table.png){annot="1:1300,80;2:400,124;3:443,149;4:560,82;5:175,27"}

1. **Export CSV** and **Export as PDF**: download the table.
2. Column headings (**Product Name**, **Category**, **BCG Class**, **Movement**, **Revenue YTD**, **Revenue LYTD**, **Volume YTD**, **ASP**, **GP%**, **Vol Growth**): click the arrows to sort.
3. **Filter...**: the box under each heading filters that column.
4. **Search all columns...**: searches the whole table.

This report uses the standard filter bar: dates, **Company**, **Customer Group**, **Distribution Channel**, **Branch** and **Salesperson**.

> [!NOTE]
> Classes are always based on each product's whole-company figures. Filtering by a branch or salesperson shows which products they sell, but doesn't reclassify the products.

# Product: Stock Velocity

## Purpose

**Stock Velocity** shows how fast stock is selling, which products are **overstocked** (tying up money) and which are at **risk of running out**.

**To open it:** **Product** › **Stock Velocity**.

> [!NOTE]
> **Data on this page is updated manually.** Unlike the other reports, **Stock Velocity** isn't updated by the scheduled data refresh. It currently shows product data **as of 25 July 2026**. The figures will change only when the product data is next updated.

![Stock Velocity](shots/stock_top.png){annot="1:815,131;2:240,222;3:200,370"}

1. **Page filters**: **Company** (**All**, **Majaal**, **Tika**), **Category** and **Stock Band** (**All**, **Overstock**, **Normal**, **Stock-Out Risk**), with **Reset filters**. Click **Show filters** to open them.
2. **KPI cards**:
    - **Avg Days of Inventory**: how many days current stock would last at the current sales rate.
    - **Overstocked SKUs**: the number of products above the overstock limit, and the value tied up.
    - **Stock-Out Risk SKUs**: products below the minimum, and the sales value at risk.
    - **Fast Movers (top velocity tercile)**: the fastest-selling third of products.
    - **Current Stock** (units) and **Inventory Value** (LYD).
3. **Fast vs Slow Movers**: average daily sales of fast and slow movers.

Further down, **Overstock Products** and **Stock-Out Risk** show products by BCG class. Choose a class in the selector (default **All Classes**) and click a bar to list the products (**Product**, **BCG Class**, **DOH**, **Units in Stock**, **Volume YTD**, **Value YTD**). Click **Show more** for more rows.

### Stock limits

| Company | Overstock when days of inventory are above | Stock-out risk when days of inventory are below |
|---|---|---|
| **Tika** | 60 days | 30 days |
| **Majaal** | 180 days | 60 days |

**DOH** means Days On Hand (days of inventory).

# Product: PIM Contribution

## Purpose

**PIM Contribution** (Product Information Management) shows how each level of the product hierarchy contributes to sales, from company through category, brand, family and size down to the individual product. It also shows the performance of partner brands.

**To open it:** **Product** › **PIM Contribution**.

> [!NOTE]
> **Data on this page is updated manually.** Unlike the other reports, **PIM Contribution** (except the **Brand Performance** section, which is refreshed on schedule) isn't updated by the scheduled data refresh. It currently shows product data **as of 25 July 2026**. The figures will change only when the product data is next updated.

![PIM Contribution](shots/pim_top.png){annot="1:360,40;2:270,181;3:670,181;4:1080,179"}

1. **KPI cards**: **Active Categories**, **Active Ranges / Families**, **Top Category by Value** and **Top Category by Volume**.
2. **Product Hierarchy Contribution**: share of sales at each level of the hierarchy (**Company**, **Category**, **Brand**, **Sub-Brand**, **Family**, **Size**, **Product**), starting with the split between Majaal and Tika. Click a slice to go down a level.
3. **By Value** / **By Volume**: measure the contribution by sales value or by quantity.
4. **Average Selling Price (ASP)**: ASP by company.

The page filters (**Show filters**) are **Company**, **Category** and **BCG Class**.

### Brand Performance

At the top of the page, **Brand Performance** lists the named partner brands, sorted by **Revenue YTD**, with **Volume YTD**, **ASP**, **GP%** and **SKU Count**. It follows the **Company**, **Category** and **BCG Class** filters at the top of the page.

1. Click **View products →** next to a brand.
2. The brand page opens, showing the brand's revenue, volume, ASP, gross margin and active SKUs compared with last year, and a product table (**Product Name**, **Company**, **BCG Class**, **Movement**, **Revenue YTD**, **Volume YTD**, **ASP**, **GP%**, **Vol Growth**) with **Export as PDF**.
3. Click **Back** to return.

# Product: Product Lifecycle

## Purpose

**Product Lifecycle** shows where each product is in its life: growing, mature, or discontinued. It helps you plan range renewal and clear out old stock.

**To open it:** **Product** › **Product Lifecycle**.

> [!NOTE]
> **Data on this page is updated manually.** Unlike the other reports, **Product Lifecycle** isn't updated by the scheduled data refresh. It currently shows product data **as of 25 July 2026**. The figures will change only when the product data is next updated.

![Product Lifecycle](shots/lifecycle_top.png){annot="1:490,225;2:220,370;3:1000,131"}

1. **KPI cards**: **Mature SKUs** (with their share of the filtered portfolio), **Discontinued / No Supply** (with the LYTD value at risk) and **Portfolio Freshness** (the share of products newly classified this year).
2. **Segment Value — Pareto**: value per lifecycle segment (**Stars**, **Cash Cows**, **Strategic**, **Dogs**, **Mature**, **Discontinued**) this year and last year, with a cumulative % line.
3. **Page filters**: **Company**, **Category** and **Lifecycle Segment** (**All**, **Stars**, **Cash Cows**, **Strategic**, **Dogs**, **Mature**, **Discontinued**), with **Reset filters**.

Further down, **Product Detail** lists every product.

### Product Detail table

| Column | Meaning |
|---|---|
| **Product Name** | Product code and name |
| **Company** | Majaal or Tika |
| **Category** | Product category |
| **BCG Class** | See *BCG Matrix* |
| **Lifecycle** | **Active**, **Mature** or **Discontinued** |
| **Mo. Since First Sale** | Months since the product was first sold |
| **Mo. Since Supply** | Months since the product was last supplied |
| **Value YTD** / **vs LYTD** | Sales this year, and the change against last year |

To work with the table:

1. Type part of a name in **Search product name…**
2. Choose a field in **Sort by** (default **Value YTD**) and a direction (**Desc** or **Asc**).
3. Click **Show more** to load more rows.
4. Click **Export as PDF** to download the list.

> [!TIP]
> To find old stock to clear, choose **Lifecycle Segment: Discontinued** and sort by **Value YTD**.
<!-- /only -->
