# BMH 7Ps Dashboard: user manual discovery (Phase 1)

**App:** BMH – 7Ps Dashboard (login screen subtitle: "BMH 07's BI REPORT")
**Live URL:** https://dashboards.benmussaholding.com/Dashboard
**Explored:** 25 Sep 2026, as Admin (view only, nothing submitted or changed)
**Interface language:** English only, with no language switch and no Arabic UI. The Arabic manuals will keep English UI labels in bold and explain them in Arabic.

---

## 1. Site map

### Public (no sign-in needed)
| Page | URL | Purpose / controls |
|---|---|---|
| Sign in | /Dashboard/login | **Email**, **Password**, **Sign in**, **Forgot your password?**. Note on screen: "Accounts are created by an administrator. There is no self-service registration." |
| Forgot password | /Dashboard/forgot-password | **Email**, **Send reset link**, **Back to sign in**. Always confirms with "If that email exists in our system, a password reset link has been sent." |
| Reset password | /Dashboard/reset-password (opened from the emailed link) | New password and confirm. The link expires after 60 minutes. |
| Set a new password / Change password | /Dashboard/change-password | **Current password**, **New password** (at least 8 characters, including a letter and a number), **Confirm new password**, **Save new password**, **Sign out instead**. Forced on first sign-in. |

### Shared layout (every signed-in page)
- **Header:** BMH logo, page title, **Back**, light/dark theme toggle, **Notifications** bell, profile chip (name, with a tooltip "Signed in as: <role>"), **Log out**.
- **Left sidebar:** Home, Promotion, Product, Price, Place, People, Process, Physical Evidence, Admin, and a **Collapse sidebar** button.
- **Bottom tab bar:** one tab per report the user is allowed to see.
- **Filter bar** (collapsed by default, opened with **Show filters** or **Hide filters**, with a badge counting active filters): **From Date**, **To Date** (or a single **Date**), **Company**, **Customer Group**, **Distribution Channel**, **Branch**, **Salesperson**, **Customer** (only on some pages), **Reset filters**. It also shows "Last Order Date" and "Last Order Created" as data-freshness stamps.
- **Exports:** **Export PDF** / **Export as PDF** (tables, with the applied filters and "Exported by" stamped on the file), **Export CSV** (tables), **Export image** (charts, saved as PNG). All exports download through the browser to its Downloads folder.

### Home: 7Ps Dashboard Hub (/Dashboard)
Seven department cards. **Promotion** (Commercial) and **Product** (Production) are live and open with **View KPIs**. Price, Place, People, Process and Physical Evidence show **Coming Soon**.

### Promotion: Commercial Department (/Dashboard/promotion): 12 reports
| # | Report | URL | Main content (as seen live) |
|---|---|---|---|
| P1 | **Tachometer** (page title "Promotion Dashboard") | /promotion/tachometer | Gauges for YTD Value, YTD Volume, MTD Value and MTD Volume, plus YTD/MTD Actual ASP cards (status badges: On Track, Behind Target, Critical). Two **Performance Details** tables with **Export PDF**. Clicking a gauge opens its breakdown. |
| P1a | Tachometer breakdown ("YTD Value — Breakdown", etc.) | /promotion/tachometer/{ytdValue, ytdVolume, mtdValue, mtdVolume} | Gauge, **Quick Insights** (Total Groups, On Target, Critical, Top Performer, Needs Attention), and a **Full Breakdown** table grouped by Salesperson, Branch or Customer Group. Sortable columns, **Export CSV**, **Export as PDF**, 10/25/50/100 rows per page, **Prev**/**Next**, **Back to Tachometer**. |
| P2 | **Critical Number** | /promotion/critical-number | Daily, Monthly and Yearly Counters (donuts, with **Export image**), the Daily Critical Number, Working Days YTD, Official Holidays YTD (**HOLIDAY LIST**), Forced Closures YTD (**BRANCH BREAKDOWN**), and Performance Details with Takeaway. Uses a single **Date** filter. |
| P3 | **Revenue Trend** | /promotion/revenue-trend | MoM Value, MoM Volume and MoM ASP charts (each with table view and **Export image**) and Performance Details. |
| P4 | **Invoices Engine** | /promotion/invoices-engine | Sales Trend, Invoices Trend, Invoices Classification (High, Upper-Mid, Medium and Low value bands, with a **Drill-down**) and Performance Details. |
| P5 | **Customer Growth** | /promotion/customer-growth | Customers Trend, Customers Contribution (with **Drill-down**) and Customers Category Share. |
| P6 | **Pipeline Health** | /promotion/pipeline-health | Full Pipeline (with an **Opportunity chain** view), Expected Closure Opportunity, Opportunity by Stage and Probabilities Distribution. YTD data only. |
| P7 | **Pipeline Trend** | /promotion/pipeline-trend | Open Opportunities & Quotations by Aging, Opportunities, Quotations, Sales Orders and Performance Details. |
| P8 | **Activity Momentum** | /promotion/activity-momentum | Total Lost Opportunity by Reason, New Opportunities and Performance Details. |
| P9 | **MARCOM Spending** | /promotion/marcom-spending | Uses its own filters (**Year**, **From**/**To** month, **Brand**, **Reset**) and shows "Data as of … uploaded by …". |
| P10 | **Media Campaign Performance** | /promotion/marcom-campaigns | Spend vs Revenue by Campaign (**Bars**/**Bubbles**), Total Spend vs Revenue Rate, ROI by Campaign, Campaign timeline, Geographic coverage by type and Cost by type. |
| P11 | **Digital Performance** | /promotion/marcom-digital | Followers / Likes by platform, CTR, Engagement Rate, Organic vs Paid (**Stacked**/**Grouped**), Bounce Rate and Average Session Duration. |
| P12 | **Trade Marketing & Retail** | /promotion/marcom-trade | Compliance Rate, Giveaways Stock, Printed Materials Stock, Events by type per month, Events timeline (**Include planned**/**Completed only**, **Timeline**/**Table**) and Attendance Rate. |

Every MARCOM chart has **View as table**. The **Upload data** button on MARCOM pages is an Admin function and is outside the scope of these manuals.

### Product: Production Department (/Dashboard/product): 4 reports
| # | Report | URL | Main content |
|---|---|---|---|
| R1 | **BCG Matrix** | /product/bcg-matrix | Stars, Cash Cows, Strategic and Dogs class cards, the top 10 products per class, Movement chips (New, Stable, Improved, Drop, Discontinued), a product table (sortable, **Export CSV**, paged) and Performance Details. |
| R2 | **Stock Velocity** | /product/stock-velocity | KPIs (Avg Days of Inventory, Overstocked SKUs, Stock-Out Risk SKUs, Fast Movers, Current Stock, Inventory Value), Fast vs Slow Movers, Overstock Products, Stock-Out Risk (class selector) and Performance Details. |
| R3 | **PIM Contribution** | /product/pim-contribution (+ brand drill-down /brand/{brand}) | KPIs (Active Categories, Ranges/Families, Top Category by Value/Volume), Product Hierarchy Contribution (**By Value**/**By Volume**, company selector), By Company and Average Selling Price. |
| R4 | **Product Lifecycle** | /product/product-lifecycle | KPIs (Mature SKUs, Discontinued / No Supply, Portfolio Freshness), Segment Value (Pareto chart), a Product Detail table (sort field and direction, **Show more**, **Export as PDF**) and Performance Details. |

### Out of scope (per your instruction)
Admin (/Dashboard/admin/*): Users, Roles, Salespersons, Sales Teams, Companies, Customer Groups, Distribution Channels, Holidays, Closures, ETL Control, ETL Runs, MARCOM Upload, Audit Log and Login History.

---

## 2. What the Salesperson role sees (from the code; to be confirmed live)
- Only the **Tachometer** and its breakdown pages. Navigation hides every page the user has no View permission for.
- **Company**, **Customer Group**, **Distribution Channel** and **Branch** are greyed out with "Locked to your assigned scope". **Salesperson** shows "Locked to your own record". Only the dates can be changed.
- Exports contain only the salesperson's own data, because the server enforces this.

---

## 3. Proposed table of contents: Version 1 (Full access), EN and AR

1. Cover
2. Table of contents
3. **Introduction**: what the 7Ps Dashboard is, who this manual is for, and the conventions used (bold labels, Note, Tip and Warning boxes)
4. **Getting started**: supported browsers and screen size; signing in; first sign-in (setting a new password); forgot or reset password; changing your password; signing out; staying signed in and when you are signed out (see open item 3); account lockout after 5 failed attempts; "Too many attempts"
5. **Interface overview**: the Hub; the sidebar and collapsing it; the header (Back, theme, notifications, profile chip, Log out); the bottom tab bar; the filter bar (every field, active-filter badge, Reset, data-freshness stamps); status badges and colours; table view, sorting and paging; no language switch
6. **Promotion reports**: one chapter each for P1 to P12, with the Tachometer breakdown inside the Tachometer chapter. Each chapter covers the purpose, an annotated screenshot, every card, chart and control, the tasks step by step, and tips.
7. **Product reports**: R1 to R4, in the same format, including the PIM brand drill-down
8. **Reports and exporting**: Export PDF (what is stamped on it), Export CSV, Export image (PNG), how filters and date ranges apply to exports, and where the files are saved
9. **Troubleshooting and FAQ**
10. **Glossary**: YTD, MTD, LYTD, LFY, FYT, LMTD, LFM, FMT, ASP, LYD, variance, pace, working days, critical number, BCG classes, SKU, CTR, MARCOM, pipeline, and more
11. **Support contact**

## 4. Proposed table of contents: Version 2 (Salesperson), EN and AR
1. Cover
2. Table of contents
3. Introduction
4. Getting started (same as Version 1)
5. Interface overview, reduced to the header, the Tachometer tab and the filter bar with its locked fields
6. **The Tachometer**: reading each gauge and card, status badges, Performance Details, changing dates, opening a breakdown, Quick Insights, and sorting and paging the Full Breakdown
7. **Exporting and printing**: Export PDF, Export CSV, and printing the exported PDF
8. Troubleshooting and FAQ (salesperson-specific)
9. Glossary (Tachometer terms only)
10. Support contact

---

## 5. Open items and findings to review before launch
1. **Support contact** is still missing.
2. **Salesperson screenshots:** I can't sign in with a password. To capture the real locked view, please sign in to Chrome with a salesperson test account when I ask.
3. **Session timeout:** sign-in tokens last 365 days, and there is no idle timeout. Users stay signed in until they click **Log out**, an admin revokes their sessions, or their password changes. Should the manual say this plainly?
4. **Notifications bell** doesn't do anything when clicked (no feature behind it). Should I document it as "reserved for future use", or leave it out?
5. **Changing your password:** there's no menu link to it. It's only reachable by typing /Dashboard/change-password or through the forced first sign-in.
6. Possible bug: in the Tachometer breakdown, the **Needs Attention** card shows the word "Salesperson" instead of a name.
7. Developer wording shows to users: the hub cards say "Live report, wired to the validation warehouse."
8. MARCOM data shows "uploaded by tester". Please confirm it will be real data at launch.
9. No Arabic interface, so the Arabic manuals keep English labels, as in your brief.
10. **Theme:** the app opens in dark mode and doesn't remember the choice. Screenshots will be taken in light mode for print.
11. **Privacy in screenshots:** customer, salesperson and product names will be replaced with placeholders in the page before capture, and figures will be scrambled. Screenshots then show layout, not real data.
