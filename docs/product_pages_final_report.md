# Product pages: final report

Branch `feature/product-pages-live` (worktree `Desktop/07PREPORT-ppl`, from `main`). The commits are local only; nothing is
pushed, merged or deployed.

All verification ran against an **isolated copy** of the warehouse: a throwaway MySQL container on `127.0.0.1:33308`,
cloned from production at 13:06 today. Odoo was only read.

The only change made to production was the requested `_tmp_keys_*` cleanup (§6).

---

## 1. Acceptance results

| # | Test | Result |
|---|---|---|
| 1 | CemAir, per company, against **live Odoo** Sales Analysis | ✅ Majaal "Cemair" 2025 = **102,536.00**; 2026 = **0**. Tika "Cem Air" 2025 = 670,605.00; 2026 YTD = **887,532.00** (dashboard = source = Odoo). |
| 1b | The 943,727 vs ~887K gap | ✅ Explained and fixed. There were duplicate rows in the ETL's `sale.report` cache: S27708 (28,000 counted 3×) and S27817 (195 counted 2×), totalling +56,195. The cause and fix are in §3.1. |
| 2 | `reconcile_products.py` | ✅ **ALL CHECKS PASSED.** 10 products (top 5 + 5 random) match the source to the cent for Value, Volume and Velocity. Products 116,352,414.48 + Unmapped 8,008,025.36 = **124,360,439.84 = Sales pages total** (26,763 lines, difference 0.00). Output is in §7. |
| 3 | Duplicate-join test | ✅ `test_product_join_never_multiplies_rows_or_totals`, plus a runtime row-count check in `ProductMapper.attach` and a totals assertion in the product aggregation. |
| 4 | Import tests | ✅ A duplicate Company + name, a missing column, an unknown company and a blank name each reject the file (`test_product_pages.py`). |
| 5 | Stale data | ✅ See §5. The "Data as of" label, the totals and CemAir all change after an ETL run with new orders. |
| 6 | Browser | ✅ All 4 pages plus the brand drill-down were checked against live data. A fresh tab showed **0 console errors**. Filters and drill-downs work, and Arabic names and Arabic units display correctly. The bugs found during the check were fixed (§4). |

**Test suites**

| Suite | Result |
|---|---|
| ETL (pytest) | 196 passed. There are 4 failures, and each also fails on untouched `main`: `test_input_check` near-match hint, and 3 Excel-QA-workbook tests. `main` itself had 6 failures; 2 of them are fixed on this branch. |
| Backend (vitest) | 402 passed, 96 skipped (DB-only suites). |
| Frontend (vitest) | 300 passed. `tsc` and eslint are clean on the changed files. |

---

## 2. What changed

### Product pages

- The pages now read `GET /product-dashboard/<page>/overview`, which uses the new measure `productDashboard.ts`.
- The synthetic `data.json` and `cleanProductNames.json` are **deleted**, along with every reader of them.
- The old `fact_bcgmatrix` endpoints are removed; only these pages used them.
- Each page shows "Data as of <last ETL run>", the same refresh bar and footer as the Sales pages, the sales period and the
  **Unmapped** line.
- There is a date-range filter. Velocity = volume ÷ days in the period.
- Quantities are **never added across units of measure**:
  - totals across products are shown per unit, for example `27.4K وحدة · 16.6K UNIT`, or in LYD;
  - the PIM page has a Unit selector for its volume and ASP charts.

### ETL

These changes apply to the whole ETL, not just the product pages.

- **`PRODUCTS.xlsx`** is read from sheet `Products` and validated. `scripts/import_products.py` prints the summary and loads
  `dim_product_master`. The ETL upload API uses the same check. Product keys are deterministic.
- **Matching** uses **Company + normalized Odoo name** everywhere: sales, stock and costs. It never matches across
  companies. Unmatched lines are kept as **Unmapped**. The old global name rename that caused the cross-company
  matches is removed.
  - Result: 2,067 Tika lines (8.99M LYD) that were matched to Majaal products now have **0** cross-company matches.
- **Odoo product id** is on every sales line (previously NULL on all 142,664 lines). Partner id, Odoo line id and order id
  are kept too.
- **Ordered quantity, delivered quantity and UoM** are extracted, for information only. The pages use invoiced quantity.
- **Costs are read per company** (§3.3).
- **New tables**, rebuilt each run:
  - `Fact_ProductSalesDaily`
  - `Dim_ProductDashboard`
  - `QA_ProductUnmapped`
  - `QA_ProductDataQuality`
  - `ProductDashboard_Meta`
- **Stock** counts finished-goods locations only:
  - raw materials are excluded;
  - in-transit is shown separately;
  - negative stock counts as 0 and is logged.
- **Days of inventory** uses a 90-day look-back. Stock with no sales is "No movement" and counts as Overstocked.
- **Lifecycle** uses your rule. All thresholds are in `config/product_dashboard.json`.
- **`IsIntercompany` flag** is information only; the list is in the config (§8).

### Files

40 files changed: +3,740 / −1,910.

| Area | Files |
|---|---|
| Backend | `measures/productDashboard.ts` (+ test), `routes/productDashboard.ts`, `server.ts`; removed `materialsAnalogyBcg.ts`, `materialsAnalogyBrandPerformance.ts` and their routes |
| ETL | `product_matching.py`, `product_dashboard.py`, `config/product_dashboard.json`, `scripts/import_products.py`, `legacy_transform.py`, `pipeline.py`, `inventory.py`, `staging.py`, `export/database_exporter.py`, `odoo/sales_report_repository.py`, `odoo/product_cost_repository.py`, `config/settings.py`, plus tests |
| Frontend | the 4 product pages + brand drill-down, `components/ProductDataStatus.tsx`, `lib/api.ts`, `lib/hooks.ts`, `lib/materialsAnalogy/shared.ts`; removed `data.json` and `cleanProductNames.json` |
| Scripts | `scripts/reconcile_products.py`, `scripts/compare_sales_pages.py` |
| Docs | `docs/product_pages_audit.md`, `docs/product_data_runbook.md`, `docs/product_pages_sales_before_after.md`, this report |

---

## 3. ETL defects found and fixed

Five of these fixes change shared ETL code, not only product-page code. Each one also affects the Sales pages.

### 3.1 The `sale.report` cache drifted from Odoo

This is the cause of the CemAir gap, and it makes every Sales page slightly wrong.

Causes:

- **(a)** Rows were stored in UTC but deleted using a Tripoli-time cutoff (+2 h). Every run re-inserted the rows from the
  first 2 hours after the cutoff without deleting the old copies.
- **(b)** Only a recent *order-date* window was refreshed. Edits to or cancellations of older orders were never picked up.
- **(c)** Rows had no key.
- **(d)** Amounts were stored as single-precision `FLOAT`.

Size of the problem for 2026, confirmed state:

- The cache overstated live Odoo by +1.22M (Majaal) and +1.85M (Tika).
- About 948 duplicate rows, 192 stale rows and 195 missing rows.

Fix:

- The cache is keyed by the Odoo line id.
- Every order changed since the cutoff (header or line) is refreshed in one transaction.
- Amounts are stored as `DECIMAL(20,6)`.
- Each run checks line counts and totals per company against Odoo's `read_group`. If they differ, it retries once, then
  does a full reload.
- The self-healing path was observed working in the test runs, and the next run showed "verified".

### 3.2 Historical sales lines were never rewritten

`Fact_SalesLines` loaded only a recent date window, so corrected history never reached SQL. It is now replaced whenever
its content changes.

This also fixed a large production defect: **in production today, 140,951 of 142,833 sales lines (437M LYD) carry a
`CustomerKey` that points at a different customer** in `Dim_Customer`. For example, a sale to "احمد بوبكر الصافي" is
attached to "احمد بن عمران". After the fix there are **0 mismatches**. This is why Customer Growth changes in §4.

### 3.3 Tika product costs were read as 0

Odoo's `standard_price` is company-dependent, and it was read in Majaal's company context. For example, Cem Air's real
cost is 11.08, not 0. Costs are now read per company and matched on product id + company.

As a result, GP% and BCG classes for Tika are real for the first time.

### 3.4 The 11:09 failure (and 14:10)

Cause: `[Errno 30] Read-only file system: '/etl/input/PRODUCTS.xlsx'`.

- The ETL rewrites `IsActive` in `PRODUCTS.xlsx` whenever it differs from Odoo, and your new clean file differs.
- The **running** Docker container mounts `/etl/input` read-only. The container was created on 20 Sep; `docker-compose.yml`
  now says read-write.

Fix:

- The write-back is **off by default** (`PRODUCTS_WRITE_BACK_ISACTIVE`). Your sheet is the source of `IsActive`.
- If the write-back is turned on and fails, the run no longer fails.

⚠️ **The fix is only on the branch.** Production runs keep failing on this error until the branch is deployed (§9, item 1).

### 3.5 Temp-table leak

`_tmp_keys_*` tables were dropped through a cached table list that never included them, so every drop was silently
skipped. They are now dropped by exact name, and there is an end-of-run cleanup. A failed test run left 0 behind.

### 3.6 Speed

- The ETL wrote rows with `method="multi"`. Using the driver's `executemany` is about **30× faster** (1.8 s vs 53 s per
  10K rows).
- The product mapper takes **6 s instead of 182–716 s**.
- A full cache reload now takes about 6 minutes.
- A full test run takes about 18 minutes, including a forced reload.

---

## 4. Sales pages before/after

Settings for this comparison:

- Anchor date is 2026-09-28.
- "Before" is production as of 13:06 today.
- "After" is this branch's ETL on the same Odoo data.
- The same branch backend code served both.

The changes are corrections, not regressions. Explanations follow the table.

| Page | Company | Metric | Before | After | Change |
|---|---|---|---:|---:|---:|
| Tachometer | All | Value YTD | 126,842,177.49 | 123,884,050.84 | −2,958,126.65 (−2.33%) |
| Tachometer | All | Volume YTD | 1,518,533.07 | 1,477,540.86 | −40,992.22 (−2.70%) |
| Tachometer | All | Value MTD | 19,860,663.38 | 16,977,697.73 | −2,882,965.65 (−14.52%) |
| Tachometer | All | Value same period LY | 86,383,709.41 | 86,383,709.41 | 0 |
| Tachometer | Majaal | Value YTD | 67,895,999.27 | 66,775,764.62 | −1,120,234.65 (−1.65%) |
| Tachometer | Majaal | Value MTD | 9,876,779.78 | 8,831,706.13 | −1,045,073.65 (−10.58%) |
| Tachometer | Tika | Value YTD | 58,946,178.22 | 57,108,286.22 | −1,837,892.00 (−3.12%) |
| Tachometer | Tika | Value MTD | 9,983,883.60 | 8,145,991.60 | −1,837,892.00 (−18.41%) |
| Critical Number | All | Yearly achievement | 102.03% | 99.65% | −2.38 pp |
| Critical Number | Majaal | Yearly achievement | 115.12% | 113.22% | −1.90 pp |
| Critical Number | Tika | Yearly achievement | 90.21% | 87.40% | −2.81 pp |
| Critical Number | All | Daily counter | 921,257.76 | 921,257.80 | +0.04 (FLOAT rounding removed) |
| Revenue Trend | All | Value variance YTD | 1.66% | −0.71% | −2.37 pp |
| Revenue Trend | Majaal | Value variance YTD | 14.46% | 12.57% | −1.89 pp |
| Revenue Trend | Tika | Value variance YTD | −9.93% | −12.74% | −2.81 pp |
| Invoices Engine | All | Invoices YTD | 12,001 | 12,030 | +29 |
| Invoices Engine | All | Avg sales / invoice YTD | 10,569.30 | 10,297.93 | −2.57% |
| Invoices Engine | Tika | Avg sales / invoice YTD | 7,774.49 | 7,532.09 | −3.12% |
| Customer Growth | All | Customers YTD | 3,810 | 3,616 | −194 |
| Customer Growth | All | New customers YTD | 737 | 2,244 | +1,507 |
| Customer Growth | Majaal | New customers YTD | 324 | 946 | +622 |
| Customer Growth | Tika | New customers YTD | 454 | 1,322 | +868 |
| Customer Growth | All | Retention rate | 33.98% | 26.64% | −7.34 pp |

- **Value and volume:** the cache duplicates and stale rows are removed (§3.1). Nearly all of the change is in September,
  the recent window where the duplicates were inserted. Last year's figures are unchanged.
- **Customer Growth:** the fact rows now point at the right customers (§3.2).
  - 2,251 customers made their first purchase in 2026 by `Dim_Customer`'s own dates, which matches 2,244. The old 737
    came from broken keys.
- The full table covers every page, company and metric: `docs/product_pages_sales_before_after.md`.

---

## 5. Stale-data test

| Item | Before run 4 | After run 4 (incremental, new Odoo orders) |
|---|---|---|
| "Data as of" (last successful ETL run, UTC) | 2026-09-29 14:22:09 | **2026-09-29 14:49:51** |
| Product tables built at (UTC) | 14:17:11 | **14:45:27** |
| All products + Unmapped, YTD | 124,355,014.84 LYD / 26,759 lines | **124,360,439.84 LYD / 26,763 lines** (+5,425.00, +4 new lines) |
| Tika Cem Air YTD | 887,532.00 | 887,532.00 (no new Cem Air orders) |

- Run 4 verified the cache against Odoo **without a reload**: "sale.report cache verified … totals by company match".
- It picked up 11 new or changed `sale.report` lines.
- The reconciliation re-run after run 4 passed again. The output is below.

---

## 6. Production changes made today (as requested)

`_tmp_keys_*` cleanup:

- Before dropping, I checked that no ETL job was running or queued and that no other session of the ETL's DB user was
  active. Both ETLs use that user.
- The script re-checked before each batch and only touched tables older than 15 minutes.
- **1,016 dropped, 0 left.** That is the 1,012 from this morning plus 4 leaked today.
- They will reappear until the fixed ETL is deployed and the legacy pipeline (§9) is stopped.

Nothing else in production was changed:

- no container restarts;
- no config or data edits;
- `PRODUCTS.xlsx` untouched.

---

## 7. Reconciliation output (`reconcile_products.py --odoo`)

```
Period 2026-01-01 .. 2026-09-29 (272 days); product snapshot as of 2026-09-29

1) Product-level check (dashboard API vs Fact_SalesLines)
product                                              value api       value src   volume api   volume src velocity api velocity src  ok
Tika: XtraCol Pro                                18,198,496.48   18,198,496.48  361,460.000  361,460.000   1,328.8971   1,328.8971  OK
Tika: SuperCol S1                                13,580,228.90   13,580,228.90  188,381.000  188,381.000     692.5772     692.5772  OK
Tika: SuperCol S2                                 8,401,947.85    8,401,947.85   73,894.000   73,894.000     271.6691     271.6691  OK
Tika: Germa C2TE                                  6,138,740.15    6,138,740.15  208,485.000  208,485.000     766.4890     766.4890  OK
Majaal: Greek Thassos Marble - 2cm                2,970,000.00    2,970,000.00    4,500.000    4,500.000      16.5441      16.5441  OK
Majaal: X-MORTERO JUNTA BEIGE 5KG                     5,923.12        5,923.12      164.000      164.000       0.6029       0.6029  OK
Majaal: CHANTILLY CREME CHIP 60x60                   39,009.60       39,009.60      161.280      161.280       0.5929       0.5929  OK
Majaal: KI MIELE RECT 40X120                          2,152.80        2,152.80       48.960       48.960       0.1800       0.1800  OK
Majaal: BRAZIL GREEN HONED RECT 120X280             172,821.60      172,821.60      231.840      231.840       0.8524       0.8524  OK
Majaal: P.C. 3DB BALNEA PEARL MT 120X280            103,303.20      103,303.20      305.760      305.760       1.1241       1.1241  OK

2) Grand total (all products + Unmapped == Sales pages total)
   mapped products          116,352,414.48
   Unmapped                   8,008,025.36   (126 products, 7871 lines)
   = product pages          124,360,439.84   (26763 lines)
   Sales pages              124,360,439.84   (26763 lines)  SUM(Fact_SalesLines.Value)
   (of which intercompany, information only: 8,467,685.78)
   difference                         0.00  OK

3) CemAir per company (API vs Fact_SalesLines vs live Odoo sale.report)
   2025  MAJAAL|CEMAIR    api     102,536.00  source     102,536.00  odoo     102,536.00  OK
   2025  TIKA|CEM AIR     api     670,605.00  source     670,605.00  odoo     670,605.00  OK
   YTD   MAJAAL|CEMAIR    api           0.00  source           0.00  odoo           0.00  OK
   YTD   TIKA|CEM AIR     api     887,532.00  source     887,532.00  odoo     887,532.00  OK

RESULT: ALL CHECKS PASSED
```

---

## 8. Intercompany list (`data/etl/config/product_dashboard.json`)

This list only sets the information-only `IsIntercompany` flag.

- 2026 YTD value flagged: **8,467,685.78 LYD**. It is included in all totals.
- A line is flagged when its Odoo partner id **or** its customer name is on the list.

| Customer | Odoo partner id(s) |
|---|---|
| شركة مجال بنغازي لاستيراد مواد البناء | 9641 |
| اصول المجموعة | 3798 |
| شركة اصول المجموعة | 17259 |
| شركة تيكا لصناعة مواد البناء | 9627, 17846 |
| Signature Majaal Benghazi / BMH | 24813 |
| Majaal signature | 25124 |
| معرض مجال ( البيضاء ) | 10691 |
| معرض مجال ( درنة ) | 12496 |
| معرض تيكا - الهواري | 9470 |
| مصنع تيكا | 9136 |
| جناح ليبيا بيلد مجال | 9469 |
| عينات تيكا (Tika samples) | 9642 |
| Structura - ستركتورا | 28102 |
| Group company partners: Majaal, TIKA, Namaa Al Bahr, Athena, Structura | 1, 12330, 9313, 6251, 9526, 11412 |

Candidates that are **not** flagged yet and need your confirmation:
- شركة النماء القابضة
- شركة النماء المتألق
- مديونية شركة اثينا

---

## 9. Needs your decision, or could not be verified

1. **Deploying.** Production keeps failing every run on the read-only mount (§3.4) until either:
   - **(a)** this branch is deployed (rebuild `etl-api`, `etl-worker`, `backend` and `frontend`), **or**
   - **(b)** as a stop-gap, the `etl-api` container is recreated from the current compose file so the mount becomes
     read-write. Note that (b) lets the old ETL rewrite `IsActive` in your curated sheet.

   I didn't do either without your go-ahead. After deploying, the first run does a one-time full `sale.report` reload
   (about 6 minutes) because the cache format changed.
2. **Two ETLs write to the same production warehouse.**
   - The legacy scheduler (`python` PID 3384, running since 21 Sep, in `Desktop\PowerBIData\powerbi_sales_pipeline`, plus
     5 Windows scheduled tasks "PowerBI Sales Pipeline before 0900…2100") uses the **old** `PowerBIData\Input\PRODUCTS.xlsx`.
     It produced this morning's production data.
   - Its runs overwrite the Docker ETL's tables, which is the likely source of the customer-key corruption, and it has
     the same temp-table and cache bugs.
   - It should be stopped (disable the tasks and end PID 3384). That's your call; I haven't touched it.
3. **`PRODUCTS.xlsx` is rejected by the new import.**
   - Rows **1272** (`GROUT CREMA - C02`) and **1453** (`[GRVS-010] GROUT CREMA - C02`) are the same Majaal name.
   - In Odoo they are two products (id 2860, UoM bag; id 3196, UoM UNIT) whose display names are identical, so no name
     rule can tell them apart.
   - Options: delete row 1453, so both products roll up into one product row, or add an `OdooProductID` column so each row
     matches by id (already supported).
   - Tests used a copy with row 1453 removed. Until the file is fixed, the deployed ETL would stop at validation, and the
     pages would keep the last good data.
4. **Unmapped: 8.0M LYD (2026, 126 products).**
   - The largest items are services and one-off project items: *Greek Thassos Marble - 2cm* 2.97M, *Marble Installation
     Works* 2.81M, *Porcelain Installation Works*, *Waterjet Cutting* and similar.
   - The **Discount** pseudo-product is −1.30M (Majaal) and −0.45M (Tika).
   - Should any of these get rows in the sheet? The full list is in `QA_ProductUnmapped`.
5. **47 products are "Unclassified (no cost)"** (9.06M LYD YTD): they have no standard cost in Odoo.
   **146 negative-stock locations** are listed in `QA_ProductDataQuality`.
6. **Lifecycle rule, as written:** a product in the sheet that has **never sold** is Discontinued (no sale in 365 days).
   There are 1,983 Discontinued products, including about 1,200 historical Unmapped ones. Should never-sold catalog items
   be a separate segment?
7. **Avg Days of Inventory is 502 days** (all companies; Tika 19 days).
   - It is weighted by sales value, as before.
   - The large figure is real: Majaal holds 26M LYD over its 180-day threshold plus 9M non-moving.
8. **Could not verify:**
   - the *deployed* stack end to end (not deployed);
   - RBAC-restricted users (salesperson scope) in the browser; this is covered by a unit test only;
   - the ETL Control Center upload rejection in the UI; this is covered by the API test only.
9. **Removed as having no source:** "Months since last supply" on Product Lifecycle. The ETL has no receipt dates, so it is
   replaced by "Days since last sale".
10. **Other observations, not changed:**
    - `07ps-sales-dashboard-app/app/` is an untracked, gitignored duplicate. It is **not** deployed; Docker builds from
      `07ps-sales-dashboard-app/`.
    - The `ingestion` container is in a restart loop.
    - Production has no `etl_run_log` table.
    - `Dim_Invoice` is keyed by order number only, but order numbers repeat across companies (S27708 exists in both). This
      affects Invoices Engine classes.
