# MARCOM template 2.0 — changelog (Marketing review, 2026-10-29)

Branch `feature/marcom-change-request`. Migration `0062_marcom_brand_split_other_spend.sql` (reverse in `data/warehouse/down/`).
Template version **2.0** — files made with 1.x are refused by the importer (header check); download the new template.

## Decisions (confirmed with the requester)

| Topic | Decision |
|---|---|
| Group structure | BMH is the group. Tika and Majaal are companies under it. Xtreme and Germa are Tika brands; the Majaal brand belongs to the Majaal company. Set per brand on *MARCOM Data Upload → Brand → Company*. |
| BMH | Not a brand: it marks **group events / group-level activity**. Stored as `marcom_brand.kind = 'GROUP'` (tick "Group" on the upload page). Group rows carry spend, never brand revenue, and are left out of growth / attributed % / brand share. |
| Websites | Each brand has its own website → P3 Table B has a required Brand, one row per Year + Month + Brand. |
| Campaign spend per month | A campaign's spend is spread over the months it runs **by active days** (both ends inclusive). 1 Feb–15 Mar, 43,000 → Feb 28,000, Mar 15,000. Same split in the template (grey column) and in the dashboard. |
| "Total Marketing Spend" on P1 | **Calculated**, no longer typed: Total MARCOM Spend = Campaign Spend + Other MARCOM Spend. The old input column becomes the optional **Finance Booked MARCOM Total**; when it is filled, Unallocated = Booked − (Campaign + Other), red when ≠ 0. "Budget Allocated" stays a separate input. |
| Company total revenue | Optional monthly input, used only for Brand Share %. No YTD inputs anywhere. |
| P3 rows already uploaded without a brand | Not guessed: flagged *needs review*, shown only under "All" as "No brand (needs review)", and dropped automatically for any month + platform that is re-uploaded with brands. |

## 1. Digital Performance per brand

- Template P3 Table A: `Year | Month | Brand | Platform | Account / Page Name (optional) | Followers | Impressions | Clicks | Paid | Organic` → grey Total Engagement, CTR %, ER % and statuses. Table B: `Year | Month | Brand | Bounce | Visitors | Sessions | Minutes` → grey Bounce %, Avg Session, status.
- The downloaded template (`GET /marcom/upload/template?year=YYYY`) fills the Brand / Category dropdowns from the database and **pre-fills** Year + Month + Brand + Facebook/Instagram (Table A) and Year + Month + Brand (Table B) for all 12 months. Rows left untouched are ignored on upload. `?blank=1` returns the shipped file.
- Importer: Brand required (`REQUIRED_MISSING`), duplicate Year + Month + Brand + Platform (+ Account) rejected (`DUPLICATE_KEY`).
- DB: `brand_id` (FK) on `marcom_social_monthly` / `marcom_web_monthly`, `account_name` on social; unique keys `(year, month, brand_id, platform, account_name, is_current)` and `(year, month, brand_id, is_current)`; `needs_review` on rows migrated without a brand.
- Page: Company + Brand filters on Digital Performance; every KPI, chart and status respects them. A new "Comparison by brand" card shows followers, impressions, clicks, engagement, CTR, ER, visitors, bounce and session per brand (with RAG), plus CTR / ER bars.
- **Fixes:**
  - **"Clipped" impressions:** in the uploaded 1.x file the Impressions values were text with line breaks (`"2100000⏎"`, `"8240⏎⏎⏎"`), so the cell showed two lines and the CTR/ER formulas returned nothing. The 2.0 grey formulas read numbers typed as text, and the input cells reject text in Excel. The importer already accepted them.
  - **"0" engagement:** the Total Engagement formula was correct. Paid and Organic Engagement were typed as **0** in every row except January Facebook.

## 2. Non-campaign MARCOM spend

- New sheet **P1b – Other MARCOM Spending**: `Year | Month | Brand | Category | Description | Vendor/Supplier (opt.) | Amount (LYD) | Notes (opt.)`, one row per expense line. Categories come from `Lists!I` (download: from the database).
- Lookup `marcom_spend_category` (seeded: Uniforms, Printing & Printouts, Gifts & Giveaways, Events & Sponsorships, Branding & Signage, POS / Merchandising Materials, Photography & Production, Agency / Freelancer Fees, Other) — add or rename rows there; the next downloaded template picks them up.
- Versioned table `marcom_other_spend` (natural key Year + Month + Brand + Category + Description).
- P1 grey reconciliation per Year + Month + Brand: Campaign Spend · Other MARCOM Spend · Total MARCOM Spend · Unallocated.
- Every spend-based KPI uses Total MARCOM Spend: ROI (also the ROI trend on Media Campaign Performance), budget utilization, CAC, spend % of revenue.
- MARCOM Spending page: KPI cards Total MARCOM / Campaign / Other / Unallocated; spend bars split campaign vs other; "Spend by category" (Campaigns as one category); "Reconciliation" table per month and brand; "Other MARCOM spend lines" table with a category filter (brand / month follow the page filters).

## 3. P1 revenue = brand level, monthly

| Template 1.x | Template 2.0 | DB column |
|---|---|---|
| Total Marketing Spend | *(calculated: Campaign + Other)*; old value kept as Finance Booked MARCOM Total (optional) | `spend` → `finance_booked_total` |
| Revenue Attributed to Marketing | Revenue Attributed to Marketing (≤ Brand Revenue, validated) | `revenue_attributed` (now NULL-able) |
| Total Company Revenue – Current | **Brand Revenue – Current Month** | new `brand_revenue_current` |
| Total Company Revenue – Same Month LY | **Brand Revenue – Same Month Last Year** | new `brand_revenue_ly` |
| — | Company Total Revenue – Current Month (optional) | new `company_revenue_total` |
| — | — | old values kept in `legacy_company_revenue_current` / `legacy_company_revenue_ly` |

- P1 has a **Definitions** box (rows 4–11) and a help pop-up on each yellow header (Excel input message; ExcelJS cannot read the comment format openpyxl writes, so no classic cell comments).
- Formulas: Brand Growth = (Brand Rev − Brand Rev LY) ÷ Brand Rev LY; Marketing-Attributed % = Attributed ÷ Brand Rev; Brand Share % = Brand Rev ÷ Company Total; ROI = Attributed ÷ Total MARCOM Spend.
- Migration: existing P1 rows keep their numbers but get **no brand revenue** (`revenue_needs_review = 1`) — the old columns asked for the company total. The Spending page shows how many months are affected and leaves them out of growth / attributed %. Re-upload those months with the 2.0 template to clear the flag.

## New importer validations

| Code | Level | Rule |
|---|---|---|
| `REQUIRED_MISSING` | error | Brand revenue (current, LY) and attributed revenue on every brand row; Brand on P3 rows |
| `ATTRIBUTED_GT_BRAND_REVENUE` | error | Attributed > Brand Revenue |
| `BRAND_REVENUE_GT_COMPANY` | error | Brand Revenue > Company Total |
| `INVALID_CATEGORY` | error | P1b category not in the list |
| `DUPLICATE_KEY` | error | Same Year + Month + Brand + Platform (+ Account) on P3; same line on P1b |
| `BRAND_REVENUE_EQUALS_COMPANY` | warning | Brand Revenue = Company Total (company total typed as brand revenue?) |
| `OUTLIER_VS_MEDIAN` | warning | Value > 5× that brand's median month in the file |
| `COPIED_ACROSS_BRANDS` | warning | A column identical for two brands in all (3+) shared months |
| `SAME_VALUE_EVERY_ROW` | warning | One value in every row (6+ rows), e.g. the 162.25 budget |
| `ZERO_AMOUNT` | warning | P1b line of 0 |

## Data issues found in `Input/MARCOM_Contribution_Data.xls` (flagged, not fixed)

The file was exported from Apple Numbers, uses template 1.x and was never imported (local or prod MARCOM tables hold demo data only).

1. **Majaal, March, Total Company Revenue = 79,000,000** — 5.3× Majaal's median month (15,000,000). Probably 7,900,000. Would raise `OUTLIER_VS_MEDIAN`.
2. **Majaal "Same Month Last Year" = Xtreme's** in all 9 months (8.7M, 7.7M, 3.1M, 2.7M, 8.6M, 8.4M, 11.7M, 10.3M, 11.7M) → `COPIED_ACROSS_BRANDS`.
3. **Budget Allocated = 162.25 in all 24 rows** → `SAME_VALUE_EVERY_ROW`. It makes budget utilization 339 % – 378,737 % (e.g. Xtreme June 614,500 / 162.25). Placeholder or formula error, not a real budget.
4. **The "company revenue" columns look like company totals, not brand values**: Xtreme 7.0M–19.4M a month, while the review states Xtreme ≈ 3M of Tika's 8M. All 18 Xtreme/Majaal months → re-enter as Brand Revenue.
5. **Revenue Attributed looks like a revenue total, not the marketing part**: Xtreme Jan–Apr has 3.4M–5.0M attributed with **0 spend**; Xtreme September attributed = 8,000,000 (the Tika company figure quoted in the review); ROI up to 1 : 12,000 (Majaal August, 550 spend). Needs a re-check with the new definition.
6. Total Clicks (Xtreme): Jul 401,400, Aug 791,400, Sep 594,800 vs a 73,000 median — 5–11×; CPC becomes 0.0004 LYD.
7. P3 social rows (Jan–Sep, Facebook + Instagram) have no brand; owner unknown → will be flagged *needs review* if ever imported.
8. P3 website: one row (Aug 2026) with 18 visitors, 1 session, 7,000 minutes (avg session 7,000 min) — implausible.
9. P2: "Tiles Of libya" (Majaal) has no spend / revenue; "خليك محمي.. خليك إكستريم" OOH cost 487,000 > campaign spend 465,480; spend and revenue of most campaigns stored as text.

## Review query (run after 0062 on any database that had 1.x data)

```sql
-- Months uploaded with template 1.x: their revenue was asked as a COMPANY total -> re-enter as brand revenue.
SELECT b.name AS brand, s.year, s.month, s.legacy_company_revenue_current, s.legacy_company_revenue_ly,
       s.revenue_attributed, s.finance_booked_total
  FROM marcom_spend_monthly s JOIN marcom_brand b ON b.brand_id = s.brand_id
 WHERE s.is_current = 1 AND s.revenue_needs_review = 1
 ORDER BY b.name, s.year, s.month;
-- Social / web rows without a brand
SELECT 'social' AS t, year, month, platform, impressions FROM marcom_social_monthly WHERE is_current = 1 AND needs_review = 1
UNION ALL SELECT 'web', year, month, NULL, total_visitors FROM marcom_web_monthly WHERE is_current = 1 AND needs_review = 1;
```

## Deploy notes

- Apply `0062` (idempotent; tested down → up → up on a copy with 1.x rows). It also inserts `BMH` as a GROUP entry.
- Removing a 1.x batch that has later batches keeping some of its rows unchanged now stops with `LATER_FILE_OLD_TEMPLATE` (the old file cannot be re-read by the 2.0 parser): remove the later batches first.
- Template source: `backend/scripts/build_marcom_template.py` rebuilds `backend/assets/marcom/MARCOM_Contribution_Data_Template.xlsx` in place; column positions must match `backend/src/marcom/templateConfig.ts`.
- Test DB script (`backend/scripts/marcomTestDb.py`) now applies every migration from 0022 on (skipping non-MARCOM ones that need the full warehouse), so the DB-backed suites run again.

## UI change request #2 (Marketing review, 2026-10-31) — layout only

API, importer, DB and calculations unchanged; the API still returns `reconciliation`, `otherLines` and the per-brand digital data.

- **MARCOM Spending:** removed the Total / Campaign / Other / Unallocated KPI row, the "Overlay brand revenue" toggle, the
  "Reconciliation" table and the "Other MARCOM spend lines" table. The Total MARCOM Spend (+ Budget) and Revenue Attributed
  (+ Spend % of Revenue) cards now stand on their own above the chart. "Spend vs Revenue" (~62%) and "Spend by category"
  (~38%) share one row and stack on narrow screens. The "… of brand revenue" lines are hidden when there is no brand revenue
  instead of showing "n/a".
- **Digital Performance:** removed the "Comparison by brand" card. Company / Brand filters unchanged.
