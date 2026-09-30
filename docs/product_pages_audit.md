# Product Pages Audit (BCG Matrix · Stock Velocity · PIM Contribution · Product Lifecycle)

Date: 2026-09-29 · Scope: investigation only. No code, data or Odoo changes have been made.
All warehouse figures below come from read-only queries against the local `powerBI_Data` MySQL
warehouse (last ETL load 2026-09-29 09:42 local; the 11:09 incremental run **failed**).

---

## 1. Executive summary — why the numbers are wrong

**Root cause: three of the four Product pages don't use sales data at all. They render a
*synthetic* JSON file, not a snapshot of real data.**

- `frontend/src/lib/materialsAnalogy/data.json` (808 rows, committed in `39a57d0 "wip: snapshot…"`)
  drives Stock Velocity, Product Lifecycle, and most of PIM Contribution.
- Its own header comment in `shared.ts` says it is *"synthetic (generated from the real PRODUCTS.xlsx
  master data, not a live warehouse query)"*. The latest date inside it is 2026-07-25, which is
  where the "25 Jul 2026 snapshot" comes from.
- The CemAir row that appears as the fastest mover is invented data. In the file it is
  `ProductKey "Tika | XT-MM-04-004 | 1"`, but it is labelled `Company: "Majaal"`, with
  `total_value_YTD 358,571.8`, `total_quantity_YTD 27,392.8` and `avg_daily_sales_qty 91.309`.
  27,392.8 ÷ 91.309 = 300.0 days exactly, which is a generator constant and not a real window.
  No join, duplication or state filter produced these numbers. They were never computed from
  Odoo rows.

The live warehouse has real CemAir data, and it disagrees both with the page and, in part,
with the acceptance premise (see §6 Q1):

| Company | Odoo product | Year | Lines | Value (LYD, untaxed) | Qty |
|---|---|---|---|---|---|
| Majaal | "Cemair" | 2025 | 14 | **102,536.00** ✅ matches Odoo | 3,662 |
| Majaal | "Cemair" | 2026 | 0 | 0 | 0 |
| Tika | "Cem Air" (Odoo product id 5019) | 2024 | 6 | 8,990 | 315 |
| Tika | "Cem Air" | 2025 | 149 | 670,605 | 24,897 |
| Tika | "Cem Air" | 2026 (to 29 Sep) | 97 | 943,727 | 29,296 |

The raw `sale.order.line` extract confirms that the Tika 2026 orders are real `state='sale'`
orders. The latest is from 2026-09-26.

**Second defect, also live today:** the ETL maps products **by name only, ignoring company**
(`product_name_mapper.py`, `ProductNameMapper`: `OdooProductName → ProductName`, which is a
global dict).
- **2,189 Tika sales lines (9.03M LYD)** are attached to a *Majaal* ProductKey.
- **23 Majaal lines (73K LYD)** are attached to a Tika ProductKey.
- All Tika CemAir sales land on `MAJAAL|MJ-SR---|1|ROW|000445`. This affects the live BCG Matrix
  page and PIM Brand Performance today.

---

## 2. The four pages — current data sources

| Page | Route | Data source today | Live? |
|---|---|---|---|
| BCG Matrix | `/product/bcg-matrix` | `useBcgMatrixOverview` → `GET` BCG route → `backend/src/measures/materialsAnalogyBcg.ts` → `fact_bcgmatrix JOIN dim_product` | **Live** (ETL-built), but affected by the name-only mapping |
| Stock Velocity | `/product/stock-velocity` | `FACTS` from `lib/materialsAnalogy/data.json` (synthetic) | **No** |
| PIM Contribution | `/product/pim-contribution` (+ `/brand/[brand]`) | KPI tiles, hierarchy donut and ASP use `FACTS` (synthetic). The Brand Performance card and brand drill-down use `useBrandPerformanceOverview` → `materialsAnalogyBrandPerformance.ts` (live `dim_product LEFT JOIN fact_bcgmatrix`) | **Mixed** |
| Product Lifecycle | `/product/product-lifecycle` | `FACTS` (synthetic): `is_mature`, `is_discontinued`, `months_since_*` are all generated | **No** |

Other points:
- Display names on all four pages come from `lib/materialsAnalogy/cleanProductNames.json`, a
  static map keyed by **ProductKey**. That is wrong by design, because ProductKey is not unique
  per product.
- None of the four pages shows a "Data as of" label. `AppHeader` is rendered without
  `lastRefreshTime`, and the pages don't call `useRefreshStatus`.
- There is **no "updated manually" text** in the page code. If you see one, please send a
  screenshot, because it isn't coming from these files.

Frontend files: `frontend/src/app/(departments)/product/{bcg-matrix,stock-velocity,pim-contribution,pim-contribution/brand/[brand],product-lifecycle}/page.tsx`,
`frontend/src/lib/materialsAnalogy/{shared.ts,data.json,cleanProductNames.json}`, `frontend/src/lib/hooks.ts`, `frontend/src/lib/api.ts`.
Backend: `backend/src/measures/materialsAnalogyBcg.ts`, `materialsAnalogyBrandPerformance.ts`, `backend/src/routes/{bcgMatrix,materialsAnalogyBrandPerformance}.ts`.

## 3. How the live pages get ETL data (the pattern to copy)

1. `backend/src/etl/` (Node) schedules the Python pipeline in `data/etl/`:
   - incremental runs on `0 */3 * * *`;
   - a full run on `0 2 * * *`.
   Each run is logged in `etl_job_runs`, `etl_run_log` and `pipeline_run_log`.
2. The Python pipeline reads Odoo over XML-RPC (read-only `search_read`/`search_count`). It
   stages raw tables (`raw_sale_report_api`, `raw_sale_order`, `raw_sale_order_line`,
   `raw_stock_*`) and writes modelled tables:
   - `fact_saleslines`, `fact_sales`, `fact_orders`;
   - `dim_product`, `dim_productcost`;
   - `fact_inventory`, `fact_bcgmatrix`.
3. Express measures in `backend/src/measures/*.ts` query those tables through `mysql2`. RBAC
   scope is enforced by `resolveScopedFilters`. Pages consume them through `use*Overview` hooks.
4. Freshness: `backend/src/measures/refreshStatus.ts` → `useRefreshStatus`.
   - `lastRefreshTime` = `etl_run_log.finished_at_utc` of the last successful run.
   - It is shown in `AppHeader` and the page footer (for example `promotion/critical-number/page.tsx`).

**Sales fact source:** `fact_saleslines` is built from Odoo **`sale.report`**, which is exactly
the model behind *Sales > Reporting > Sales Analysis* (`pipeline.py:2459`, `sales_report_repository.py`).
- This matters because `sale.report.price_subtotal` is converted to the company currency.
- `sale.order.line.price_subtotal` is in the order's currency and is also staged. For 2026 it
  totals 53.5M for Majaal against 68.0M in `sale.report`, so it must **not** be used for LYD values.
- **Recommendation:** keep `fact_saleslines` / `sale.report` as the sales source. It is what the
  Sales pages use and what your Odoo check uses.

## 4. Answers to the specific questions in the brief

| Question | Finding |
|---|---|
| Does the ETL extract display name or product name? | **Display name.** `product_id` is a many2one, flattened to `value[1]`, which is `display_name`. 25,964 of 188,195 raw lines have a `[CODE] ` prefix (for example `[MG60x60-001] TUNDRA LIGHT 60x60`). The prefix must be stripped before matching, as you described. |
| Does the ETL extract Odoo product IDs? | **Yes.** `sale.report` gives `OdooProductID` (stored in `raw_sale_report_api`), and `sale.order.line` gives `product_id_id`. **But `fact_saleslines.OdooProductID` is NULL on all 142,664 rows**, because it is dropped during transform. Adding it back is straightforward, and ID matching is strongly recommended once the sheet has an ID column. |
| Order states | `fact_saleslines` keeps rows unless `invoice_status='no' AND state NOT IN (sale,done)` (`pipeline.py:2639`). BCG additionally keeps only `invoice_status ∈ {invoiced, to invoice, upselling}`. **Result today: the fact contains only `state='sale'`.** No `done` orders exist in the extract, and draft, sent and cancel are excluded. This matches your spec in practice; I'll make it an explicit `state IN ('sale','done')` filter. |
| Order date & timezone | `order_date_date` = `date_order` converted UTC → Africa/Tripoli (`TIMEZONE` setting). This matches your spec. |
| Company scope | Odoo company ids **1 = Majaal** and **3 = TIKA**. No other company has sale orders in the extract. `dim_company` has 2 rows. |
| Volume: ordered or delivered? Which one do other pages use? | Other pages use `fact_saleslines.quantity` / `Volume`, which are **`qty_invoiced`** (fallback `product_uom_qty`), *not* ordered quantity. Example: Tika CemAir order for "Omar Alfandi" on 2026-09-26 has ordered 14, invoiced 0, and the fact shows 0. **Delivered quantity (`qty_delivered`) is not extracted.** `sale.report` doesn't include `product_uom_qty` in the ETL field list today. |
| Unit of measure | **Not extracted anywhere** (no `product_uom` on lines, and none on `product.product`). Mixed-UoM summing cannot be detected today. To follow your rule, the ETL needs to add `product_uom` (read-only field addition). |
| Intercompany | **Not excluded anywhere today.** The dashboard counts intercompany sales. Candidate group-company customers found in the facts are listed in §6 Q3. |
| Velocity window used today | Synthetic pages: whatever the generator did (300 days for CemAir). `fact_inventory.Avg_Daily_Sales`: total quantity over **the whole sales history** ÷ (max − min order date + 1) ≈ 2,070 days, keyed by ProductKey across both companies (`inventory.py:560`). |
| Stock on hand | `fact_inventory` is live, rebuilt every run from `stock.quant`: `usage='internal'`, non-scrap, active locations; Odoo `value` is used for valuation. Snapshot 2026-09-29: Majaal 2,180 rows / 41.4M LYD, Tika 730 rows / 23.3M LYD. It includes "Vessel" (VS/Stock, 126 rows) and "RM Warehouse" (raw materials, 103 rows). Those are internal locations in Odoo, but you may not want them in overstock (§6 Q6). 138 rows have negative stock. |

## 5. Current business logic (documented and kept unless noted)

**BCG (live, `legacy_transform.py` `BCGMatrixBuilder`)**
- Grain: Company + ProductKey + ProductName. Periods: YTD = 1 Jan → today; LYTD = same span last year.
- Volume class: HV if `qty ≥ 3,500` (Majaal) or `≥ 25,000` (Tika), otherwise LV.
- Profit class: HP if GP% ≥ 35%, where GP% = (avg unit price − avg product cost) / avg unit price. Unknown if there is no cost.
- Quadrants: HV/HP = **Stars**, HV/LP = **Cash Cows**, LV/HP = **Strategic**, LV/LP = **Dogs**. Unknown cost gives "Unclassified".
- Movement: New (YTD only), Lost (LYTD only), otherwise Improved, Declined or Stable by rank.
- ⚠ **Defect:** `perc_gross_profit` = 1.0 when `standard_price` = 0. Tika CemAir shows cost 0, so it is 100% GP and classified "Stars". The code already notes this as a known gap.

**Stock Velocity (synthetic today; logic in `stock-velocity/page.tsx` + `shared.ts`)**
- Stock band thresholds are per company and match `inventory.py _VELOCITY_THRESHOLDS`:
  - Tika: Overstock DOH > 60, Stock-out risk DOH < 30.
  - Majaal: Overstock DOH > 180, Stock-out risk DOH < 60.
- Avg Days of Inventory = DOH weighted by YTD sales value.
- Overstocked SKUs = count with band Overstock. "LYD tied up" = stock qty × **YTD average *selling* price**.
  ⚠ This should be stock valuation (cost) per your spec.
- Fast Movers KPI = SKUs at or above the 66.7th percentile of velocity (top tercile).
  The Fast vs Slow **chart** splits at the **median** velocity. There are two different definitions, labelled on the page.
- Stock-out risk chart: rows with band StockOutRisk and above-median YTD volume, grouped by BCG class.
- ⚠ `inventory.py` sets DOH = 0 when there are no sales, so a product with stock and zero sales
  shows as "Low Stock / Stock-out risk" instead of infinite DOH / overstock. This will be fixed.

**Product Lifecycle (synthetic):** the segments are Discontinued, Mature, or the BCG class.
The `is_mature` / `is_discontinued` flags have **no documented rule anywhere in the repo**. They
exist only in the generated JSON. See §6 Q7.

**PIM Contribution:** Category and Family roll-ups of value, volume and ASP, plus 8 partner-brand
cards (`PARTNER_BRANDS`: 5 matched, 3 are "not stocked").

## 6. Open business questions (need your answers before implementation)

1. **CemAir premise.** Odoo's *Sales Analysis* has 2026 Tika "Cem Air" (product id 5019) lines
   totalling 943,727 LYD. Your 102,536.00 for 2025 matches **Majaal's** "Cemair" only, and Tika
   2025 is 670,605. Could you re-check Odoo with Company = TIKA and Product = "Cem Air"? My guess
   is that the filter covered Majaal only, or the "CemAir" search didn't match "Cem Air". The
   acceptance test should then be *per company*.
2. **PRODUCTS_Clean.xlsx is not on this machine.** The ETL currently reads
   `C:\Users\Lenovo\Desktop\PowerBIData\Input\PRODUCTS.xlsx` (2,541 rows, 322 keys, 755 rows in
   duplicate Company+name groups), which is outside the repo. Please place `PRODUCTS_Clean.xlsx`
   somewhere and tell me the path. Should it replace `PRODUCTS.xlsx` for the whole ETL, or feed
   only the new Product-pages dimension? Replacing it would also change Sales-page product
   mapping.
3. **Intercompany customers:** please confirm which of these are group companies to exclude,
   and add any I've missed. 2021–2026 value for each is in brackets.
   - Tika → شركة مجال بنغازي لاستيراد مواد البناء (CustomerKey 6076: 26.6M; 6087: 0.53M)
   - Majaal → اصول المجموعة (2.34M) · Tika → شركة اصول المجموعة (0.32M)
   - Majaal → شركة تيكا لصناعة مواد البناء (0.66M) · Tika → same (0.11M)
   - Majaal → Signature Majaal Benghazi / BMH (0.40M) · Tika → Majaal signature (12K)
   - Majaal → معرض مجال (البيضاء) (0.57M), معرض مجال (درنة) (0.12M), معرض تيكا - الهواري (43K), مصنع تيكا (14K), جناح ليبيا بيلد مجال (81K)
   - Tika → عينات تيكا "Tika samples" (0.27M). Is this intercompany, or samples to keep?

   Preference: identify them by Odoo **partner id** list, or by a flag column in a small sheet (my recommendation is a sheet).
4. **Conflict with reconciliation test 2.** You want intercompany excluded on the Product pages,
   but the Sales pages include it today. "Products + Unmapped = Sales pages total" can therefore
   only hold if the reconciliation shows intercompany as a separate reconciling line
   (products + unmapped + intercompany = Sales total). Is that OK, or should the Sales pages also
   exclude intercompany? That would be a change to other pages, which I won't do without your
   say-so.
5. **Volume = ordered or invoiced?** Your spec says ordered (`product_uom_qty`), but the Sales
   pages use invoiced (`qty_invoiced`). For 2026 the two differ by about 20K units for Majaal.
   Which one should apply? I recommend ordered for velocity, to match your spec, and I'll label
   it on the page. Also: may I add `product_uom_qty`, `product_uom` and `qty_delivered` to the
   ETL's Odoo field lists? This is a read-only change.
6. **Stock locations:** should "Vessel" (in-transit) and "RM Warehouse" (raw materials) be
   excluded from stock on hand and overstock? Should negative quants be clamped to 0 or netted?
7. **Lifecycle rules:** what defines *Mature* and *Discontinued*? (For example: Mature = first
   sale more than N months ago; Discontinued = IsActive = 0 in the sheet, or no sale in N months.)
   There is no agreed rule in the repo.
8. **DOH look-back window:** today it is effectively "all history". I propose a single constant
   `DOH_LOOKBACK_DAYS = 90`. Is that OK?
9. **Unmapped products with zero cost** (GP% = 100%): exclude them from BCG, or show them as
   "Unclassified"? This is the current behaviour, but CemAir hits it.

## 7. Multiplier / mock / demo scan (whole repo, excluding node_modules/logs/build output)

- **No ×1.37 or any other scaling script exists** in app, backend, ETL, scripts or the
  screenshot folders. The `1.37` matches are ordinary data values inside `data.json` and the
  mockups, plus ETL log durations.
- **Synthetic product data (to be removed):** `frontend/src/lib/materialsAnalogy/data.json`,
  `cleanProductNames.json`, and `FACTS`/`BCG_FACTS` in `shared.ts`.
- **Mockups with embedded synthetic data (docs only, not served):**
  `docs/mockups/materials-analogy/{stock-velocity,product-lifecycle,pim-contribution}.html`.
  These contain DOM writes of computed KPIs, but no scaling.
- **Mock/demo code, not on the live path. Report only; I won't touch it:**
  - `data/ingestion/odoo/{fixtures.py,mock_client.py}` (mock Odoo for tests; `price_total = subtotal*1.1` fixture).
  - `data/warehouse/seed/seed.sql` (Postgres-era sample rows; its tables don't exist in the live DB).
  - `backend/src/marcom/demo/*` and `backend/scripts/marcomDemoSeed.ts` (MarCom "DEMO SEED" uploads, labelled and removable).
- **Legitimate constants, not data scaling:**
  - `refreshStatus.ts` stale threshold `×1.5`.
  - `critical-number/page.tsx` gauge axis max `target*1.5`.
- **Housekeeping observations:**
  - The warehouse has **1,012 leftover `_tmp_keys_*` tables** from ETL runs.
  - `07ps-sales-dashboard-app/app/` is a full duplicate copy of the project tree.
  - Both are out of scope, but worth cleaning up.

## 8. Plan (after approval)

**Branch:** `feature/product-pages-live`.
- The current branch `feature/kaizen-board` has many uncommitted changes. I'll branch from
  `main` using a separate git worktree so your Kaizen work is untouched. Tell me if you'd rather
  branch from `feature/kaizen-board`.

**A. Product dimension import** (`data/etl/scripts/import_products.py` + migration `0028_product_master.sql`)
- Table `dim_product_master` holds the 12 sheet columns, plus `company_norm` and `odoo_name_norm`
  (UNIQUE), `source_file`, `source_checksum` and `imported_at`.
- Validation:
  - required columns must be present;
  - Company must be in {Majaal, Tika};
  - duplicate `(company_norm, odoo_name_norm)` makes the import fail with the offending rows listed.
- The import replaces the table in a single transaction. It prints the row count, rows per
  company, and blank Category/ProductName/SKU counts.
- Normalization (shared function, used on both sides of the join): NFKC; replace NBSP and tabs
  with a space; strip a leading `[code] `; collapse whitespace; trim; upper-case.
- Company normalisation: Odoo "TIKA" → Tika, "Majaal" → Majaal.

**B. ETL — pre-aggregated product tables, rebuilt on every run** (new step in `pipeline.py` after the facts load)
- `product_sales_daily`: one row per (Company, odoo_name_norm, OdooProductID, order date).
  - Carries value, ordered qty, invoiced qty, UoM, `is_intercompany` and `mapped` flags.
  - Sourced from `sale.report` rows with `state IN ('sale','done')`, the dashboard company scope, and the Tripoli date.
  - The join to `dim_product_master` is a LEFT JOIN on (company, name). Uniqueness is guaranteed by the UNIQUE key, so the join cannot multiply rows.
  - No match goes to `Unmapped`, never dropped.
- `product_stock_current`: stock on hand and valuation per (Company, product), from `fact_inventory` (internal locations; see Q6).
- `product_unmapped_log`: distinct unmatched Company + raw name + Odoo id, with value, qty, first/last seen and run id.
- The ETL adds `product_uom`, `product_uom_qty` and `qty_delivered` to the read-only field lists (pending Q5), and fills `fact_saleslines.OdooProductID`.
- Fix the DOH = 0 for no-sales rows (DOH = ∞ / "No sales" when stock > 0).

**C. Backend** (`backend/src/measures/productDashboard.ts` + route)
- One endpoint computes, for a period (default YTD) and filters (company, category, brand, family):
  - Value, Volume, Velocity (volume ÷ days in period) per Company + product, with ProductName for display;
  - Unmapped totals;
  - inventory metrics with `DOH_LOOKBACK_DAYS` as a single constant;
  - BCG, fast/slow and lifecycle classification computed server-side from the live tables, using the existing thresholds.
- RBAC goes through `resolveScopedFilters`, the same as the other measures.
- Returns `dataAsOf` from `refreshStatus`.

**D. Frontend**
- The 4 pages switch to a `useProductDashboard` hook.
- Delete `data.json` / `cleanProductNames.json` / `FACTS`.
- Add the "Data as of …" label via the existing `AppHeader lastRefreshTime` + `useRefreshStatus` pattern.
- Add an "Unmapped: LYD X · Y units" line on each page.
- Zero-sales products stay visible with zeros.

**E. Tests and scripts**
- pytest for the import (duplicate key fails; missing column fails; summary output).
- pytest for normalisation (`[code]` prefix, NBSP, tabs).
- Join test: row count and value/qty totals identical before and after the product join, plus a same-name-in-both-companies case.
- vitest for the measure.
- Stale-data test: insert a new order into a test DB, rerun the aggregation, and check the numbers and `dataAsOf` change.
- `scripts/reconcile_products.py`, run against the warehouse:
  - top 5 by value plus 5 random products: dashboard API vs ETL source rows, exact match;
  - grand total (products + unmapped [+ intercompany, per Q4]) = Sales-page total for the same period;
  - CemAir per company for 2025 and 2026 YTD.
- Browser check of the 4 pages: console, filters, Arabic names, light and dark.

**F. Docs:** `docs/product_data_runbook.md`, then a final report.

**Shared code I expect to touch** (I'll flag each change):
- `data/etl/.../sales_report_repository.py` field list (read-only extraction);
- `pipeline.py` (new step);
- `inventory.py` DOH fix, which also changes `fact_inventory.DOH`/`Velocity_Class` for any other consumer. I found none in the frontend.

The Sales pages' own queries will not change.
