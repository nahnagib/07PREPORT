# Interface overview

## The 7Ps Dashboard Hub (home page)

The hub is the first page after you sign in. Click **Home** in the sidebar to return to it at any time.

<!-- only:full -->
![The 7Ps Dashboard Hub](shots/hub.png){annot="1:400,27;2:570,200;3:895,200;4:1075,327"}

1. **Header**: logo, page title and your account (see *The header* below).
2. **Promotion** card (Commercial Department). Click **View KPIs** to open the Promotion reports.
3. **Product** card (Production Department). Click **View KPIs** to open the Product reports.
4. Departments marked **Coming Soon** are not available yet.
<!-- /only -->
<!-- only:sales -->
![The 7Ps Dashboard Hub as a salesperson sees it](shots/sales_hub.png){annot="1:580,200"}

1. **Promotion** card: click **View KPIs** to open the Promotion department, then open **Tachometer**.

Departments marked **Coming Soon** are not available yet. Departments you have no access to are not shown at all.
<!-- /only -->

## Page layout

Every report page has the same layout:

<!-- only:full -->
![Layout of a report page](shots/layout.png){annot="1:100,450;2:900,27;3:900,67;4:870,300;5:860,660"}
<!-- /only -->
<!-- only:sales -->
![Layout of the Tachometer page](shots/sales_layout.png){annot="1:100,450;2:900,27;3:900,67;4:870,300;5:860,660"}
<!-- /only -->

1. **Sidebar**: moves between departments.
2. **Header**: page title and your account controls.
3. **Filter bar**: chooses the dates and the part of the business the report shows.
4. **Report area**: KPI cards, charts and tables.
5. **Bottom tab bar**: moves between the reports of the current department.

## The sidebar

<!-- only:full -->The dark sidebar on the left lists **Home**, the seven departments (**Promotion**, **Product**, **Price**, **Place**, **People**, **Process**, **Physical Evidence**).<!-- /only --><!-- only:sales -->The dark sidebar on the left lists **Home** and the department names. Your reports are under **Promotion**.<!-- /only --> The current department is highlighted.

- Click a department to open its list of reports.
- Click the **«** button at the bottom (**Collapse sidebar**) to shrink the sidebar to icons and give the report more room. Click it again to expand it.

> [!NOTE]
> On a tablet the sidebar shows icons only. On a phone it opens as a menu.

## The header

<!-- only:full -->
![The header controls](shots/header.png){annot="1:120,95;2:345,95;3:1330,95;4:1370,95;5:1404,95;6:1470,95;7:1527,95" pad="50" r="15"}
<!-- /only -->
<!-- only:sales -->
![The header controls](shots/sales_header.png){annot="1:121,90;2:347,90;3:1303,90;4:1343,90;5:1377,90;6:1461,90;7:1529,90" pad="50" r="15"}
<!-- /only -->

| # | Control | What it does |
|---|---|---|
| 1 | **BMH logo** | Shows the company. When you filter a single company, the logo of that business unit may be shown. |
| 2 | **Page title** | The name of the page you are on, for example **Promotion Dashboard** on the Tachometer. |
| 3 | **Back** (arrow) | Returns to the page you were on before, like the browser's back button. |
| 4 | **Theme** (sun / moon) | Switches between **light mode** and **dark mode**. The dashboard opens in dark mode. Your choice applies until you reload the page. |
| 5 | **Notifications** (bell) | Reserved for notifications. **This feature will be available in a future release**, so clicking the bell does nothing for now. |
| 6 | **Profile chip** | Your initial and name. Point at it to see your role ("Signed in as: …"). |
| 7 | **Log out** | Signs you out (see *Signing out*). |

> [!TIP]
> Light mode is easier to read in bright rooms and uses less ink if you print the screen.

## The bottom tab bar

The bar along the bottom of every report shows one tab per report in the current department. The current report is underlined. Click a tab to open that report. If there are more tabs than fit on the screen, scroll the bar sideways.

<!-- only:sales -->
As a salesperson, you see only the **Tachometer** tab.
<!-- /only -->

## The filter bar

Filters decide **which period** and **which part of the business** a report shows. The filter bar sits under the header and is **collapsed** when a page opens.

<!-- only:full -->
![The filter bar, opened](shots/filterbar.png){annot="1:150,17;2:93,114;3:243,114;4:392,114;5:541,114;6:690,114;7:840,114;8:989,114;9:1120,114;10:1420,17;11:1318,114" pad="14" r="12"}
<!-- /only -->
<!-- only:sales -->
![Your filter bar, opened. The locked fields are greyed out.](shots/sales_filterbar.png){annot="1:150,17;2:93,130;3:243,130;4:392,130;5:541,130;6:690,130;7:840,130;8:989,130;9:1120,130;10:1420,17;11:1318,130" pad="26" r="12"}
<!-- /only -->

| # | Control | What it does |
|---|---|---|
| 1 | **Filters** and badge | The number in the circle is how many filters are currently narrowing the data. |
| 2 | **From Date** | First day of the period. Defaults to 1 January of the current year. |
| 3 | **To Date** | Last day of the period. Defaults to today. It cannot be later than today. |
| 4 | **Company** | Majaal, Tika, or both (**All**). |
| 5 | **Customer Group** | Customer segments such as B2B and B2C. Defaults to **2 selected** (B2B and B2C). |
| 6 | **Distribution Channel** | The sales channel. |
| 7 | **Branch** | The selling branch. |
| 8 | **Salesperson** | One or more salespersons. |
| 9 | **Reset filters** | Puts every filter back to its default. It is greyed out when nothing has been changed. |
| 10 | **Show filters / Hide filters** | Opens or closes the filter bar. |
| 11 | **Last Order Date / Last Order Created** | Shows how fresh the data is: the date of the latest order included in the report. |

### Using the filters

1. Click **Show filters** at the right end of the filter bar.
2. To change a date, click **From Date** or **To Date** and pick a day in the calendar.
3. To filter a list, click it (for example **Branch**) and tick one or more values. The field then shows the value, or "*n* selected".
4. The report updates automatically. You don't need to press a button.
5. Click **Hide filters** to give the report more room. The badge still shows how many filters are active.

<!-- only:full -->
> [!NOTE]
> **Filters work together.** When you choose a value in one list, the other lists only offer values that still have data. For example, choosing a branch narrows **Salesperson** to the people who sell in that branch. If a selection no longer has any data, it is removed automatically.

> [!NOTE]
> **Filters carry across reports.** The same filters stay applied as you move between reports in the same session. They go back to their defaults when you reload the page or sign in again. Some reports use their own filters, and these are described in each chapter.

### Pages with different filter controls

| Report | Differences |
|---|---|
| **Critical Number** | One **Date** instead of From/To. The counters are calculated up to that day. |
| **Pipeline Health, Pipeline Trend, Activity Momentum** | Year-to-date data only: **From Date** cannot be earlier than 1 January of the current year. |
| **Customer Growth, Invoices Engine** | An extra **Customer** filter appears. It applies to the current report only. |
| **MARCOM** reports | Their own filters: **Year**, **From** / **To** month, **Brand** and **Reset** (see the MARCOM chapters). |
| **BCG Matrix** | The standard filter bar (dates, Company, Customer Group, Distribution Channel, Branch, Salesperson). |
| **Stock Velocity, PIM Contribution, Product Lifecycle** | Their own product filters above the report, such as **Company**, **Category**, **BCG Class**, **Stock Band** or **Lifecycle Segment**. They show current stock and year-to-date product data, so there is no date range. |

> [!TIP]
> A list that is greyed out with **No options** has no values for the current selection. Widen your other filters or click **Reset filters**.
<!-- /only -->
<!-- only:sales -->
> [!NOTE]
> **Your filters are locked to your own data.** **Company**, **Customer Group**, **Distribution Channel** and **Branch** are greyed out with the message **Locked to your assigned scope**. **Salesperson** shows **Locked to your own record**. You can change the **From Date** and **To Date** only. Everything on the page, including exports, shows your own sales only.
<!-- /only -->

## Colours and status badges

The dashboard uses the same three colours everywhere to compare an actual figure with its target:

| Colour | Badge text | Meaning |
|---|---|---|
| Green | **On Track** / **On target** / **On Pace** | The target has been reached or exceeded. |
| Amber | **Behind Target** / **Watch** / **Behind Pace** | Below target, by **10% or less**. |
| Red | **Critical** / **Off target** / **Underperforming** | Below target by **more than 10%**. |
| Grey | **No Target** / **n/a** | No target has been set, or there isn't enough data to compare. |

Every chart has a **legend** under it that shows which line or bar is which (for example **Actual**, **Y-1** for last year, and **Target**).

## Tables

Report tables share the same controls:

- **Sort**: click a column heading to sort by that column. Click it again to reverse the order.
- **Rows per page**: choose **10 / page**, **25 / page**, **50 / page** or **100 / page**.
- **Prev** / **Next**: move between pages. "Page 1 of 5" shows where you are.
- **View as table / View as chart** (on charts): shows the figures behind a chart as a table, then switches back.
<!-- only:full -->
- **Expand … to table view**: the expand icon on a chart card opens the same figures as a table.
<!-- /only -->

## How often the data is refreshed

The dashboard doesn't show live, second-by-second data. It is refreshed automatically from the company's systems on a fixed schedule (Libya time, Africa/Tripoli):

| Refresh | When | What it does |
|---|---|---|
| **30-minute refresh** | **Every 30 minutes**, day and night (:00 and :30) | Updates customers, salespeople and products, the **Receivables** and **Collections** reports, and the **NPS Score** page. Takes a few minutes. |
| **Sales refresh** | Every day at **08:50, 11:50, 14:50, 17:50 and 20:50** | Adds the latest orders, invoices and pipeline activity to the sales reports. Takes up to half an hour. |
| **Full refresh** | Every night at **02:00** | Rebuilds all sales, product and receivables data from scratch. |
<!-- only:full -->
| **MARCOM data** | **Monthly**, when the Marketing department uploads its workbook | The four MARCOM reports show "Data as of *month* — uploaded by *name* on *date*". |
| **Stock Velocity, PIM Contribution, Product Lifecycle** | **Manually** | Currently show product data as of 25 July 2026 (see the note in each chapter). |
<!-- /only -->

So Receivables, Collections and NPS figures are normally at most about 30 minutes old, and sales figures at most about three hours old during the working day. To check how fresh a report is, look at **Last Order Date** and **Last Order Created** in the filter bar, or at the line at the very bottom of the page: **Last Update** (latest data included), **Last Order Created** and **Last Refresh Time** (when the last refresh ran)<!-- only:full -->, or the "Data as of …" line on MARCOM reports<!-- /only -->.

> [!WARNING]
> If a yellow bar reading **Data may be out of date - last successful refresh: …** appears under the filter bar, the most recent scheduled refresh did not complete. The figures are correct as of the time shown, but newer sales are missing. If the bar stays for more than a few hours, contact support.

> [!TIP]
> If a sale you expect is missing, check the time of the last refresh. A sale entered at 10:00 appears after the 11:50 refresh. Reload the page (**F5**) after a refresh to see the new figures.

> [!NOTE]
> The dashboard interface is in **English only**. There is no language switch.
