# Phase B: incremental sales (design and step 1)

Status: design approved 2026-10-20 with additions 1-5 (sections 1-8 answer them). 2026-10-21: the owner chose to build it
in two steps (section 10): **step 1** (built) rebuilds the sales tables from a local Odoo mirror with the unchanged legacy
code and writes only the rows that differ; **step 2** (after shadow has proven step 1) scopes the slowest steps to the
affected keys of sections 4-5. Migration 0054 (after the NPS migrations 0046-0053).

## 1. sale.report replacement (the gate)

`sale.report` is rebuilt in the warehouse from `sale.order` + `sale.order.line` + product template UoM, with Odoo 17's
rules (verified by `data/etl/scripts/sales/compare_sale_report_rebuild.py`, read-only):

| sale.report | Rebuild |
|---|---|
| one row per group | non-display lines grouped by **order, product, product template UoM, discount** (NOT the line invoice status) |
| `id` | MIN(line id) -- informational only, never a key (§3) |
| `product_uom_qty`, `qty_delivered`, `qty_invoiced` | SUM(line qty / line UoM factor x template UoM factor); 0 when the line has no product |
| `price_subtotal`, `price_total` | SUM(line amount / order `currency_rate` x company->main currency rate); 0 without product |
| `date`, `name`, `partner_id`, `user_id`, `team_id`, `company_id`, `state`, `invoice_status` | from `sale.order` (invoice status = the ORDER's) |
| `product_uom` | the product template's UoM |

Results: 2026-01-01..2026-10-20 -- 525/525 company x order currency x month x salesperson cells, 36,788 rows, every
column: 0 differences. History 2021-01..2025-12 -- 1,560/1,560 cells, 138,739 rows (63,244 orders), every column: 0
differences. Both tables: `docs/etl-phase-b/sale_report_rebuild_compare_2026_ytd.csv` and `..._before_2026.csv`
(one row per company x order currency x month x salesperson: rows and the five measures from both sides, the
differences, MATCH/DIFF). Amounts are in LYD (the company currency); "currency" is the order's currency.

## 2. Currency guard (addition 4)

The sales module FAILS (isolated: other modules still run; its watermarks do not move) with a clear message when:
* any in-scope company's currency is not LYD ("company <id> <name> has currency <code>: sale.report converts it to the
  main company currency at TODAY's rate; this rebuild does not implement that -- see docs/etl-phase-b-sales-incremental.md");
* an order in the batch has `currency_rate` NULL or 0 ("order <name> (id) has no currency_rate"); Odoo would silently
  use 1, the rebuild refuses.

## 3. Row identity (addition 3)

* `fact_sales_lines` gets a stable key `SalesLineGroupKey` = SHA-1 of `OdooOrderID|OdooProductID (or -1)|template UoM id
  (or -1)|discount (6 decimals)`, plus the `discount` and `BaseUoMID` columns. It becomes the primary key, for upserts AND
  deletes (a changed order: its groups are recomputed; groups of that order no longer present are deleted).
* `SaleReportLineID` stays as a plain informational column (nothing reads it today: no backend, frontend or view logic;
  `v_sales_lines` only passes it through). Its primary key and any index use are dropped in the new migration.
* The legacy full refresh computes the same key, so both paths write identical rows.

## 4. Attributes copied from other records (addition 1)

`v_sales_*` views pass the fact columns through; the backend reads them from the views. Option (a) -- keys only, the
dashboards join the dims -- would change ~18 backend files and every view at once; **all copied attributes use option (b)**:
when a shared-list record changes, the sales rows that carry it are recomputed in the same cycle, with the SAME builder
code as the full refresh (no hand-written SQL UPDATE), so an incremental row is byte-identical to a rebuilt one.

Prerequisite (new): today `core_dims` re-stamps every dim row each run, so "what changed" is unknown. The shared-lists
step will compare a content hash per row and write only changed rows, and publish the changed keys of the cycle
(`CustomerKey`, `ProductKey`/`ProductMasterKey`, `SalesTeamKey`, `SalespersonKey`, Odoo user/team map rows, channel,
segment, company). The sales step runs right after it in the same refresh job.

| Copied attribute(s) | Tables | Source record | Recompute when it changes (option b) |
|---|---|---|---|
| customer name, CustomerID, CustomerKey | lines, orders, documents, deliveries, leads, opportunities | res.partner (dim_customer, map_partner_customer) | rows of that partner |
| IsIntercompany | lines, product_daily | partner is one of our companies | rows of that partner |
| salesperson name, SalespersonKey | lines, orders, documents, deliveries, leads, opportunities, targets | order/lead `user_id` -> map_odoo_user_salesperson (SalesTeam.xlsx) | rows of that Odoo user |
| SalesTeam / sales_team*, SalesTeamKey, SalesSegment, SegmentKey, SalesCity, SalesTeamStatus | lines, orders, documents, deliveries, leads, opportunities, targets, product_daily | dim_sales_team / map_odoo_team_sales_team (SalesTeam.xlsx) | rows of that team |
| DistributionChannel, ChannelKey | lines, orders, documents, product_daily, targets | salesperson/team in SalesTeam.xlsx | rows of that salesperson/team |
| company_final / Company, CompanyKey | all | res.company (dim_company) | rows of that company (rename only; rare) |
| product names (OdooProductName*, product_name*, ProductName*), SKU, Size, ProductLevel, Category, Brand, SubBrand, Family, ProductMasterKey, ProductMatchKey, ProductJoinKey, ProductMappingStatus/Reason, IsMappedProduct, is_discount, uom/uom_id | lines, product_daily, inventory, bcg, product dashboard/group, product_cost | product.product + PRODUCTS.xlsx (dim_product, dim_product_master, map_product_master) | rows of that product |
| ProductCost / CostValue | product_cost, product_daily, inventory, bcg | product.product standard price (company-dependent) | rows of that product x company |
| SalesOrderKey | lines, orders, documents | dim_sales_order (order) | the order's rows (already in the change set) |
| Stage, LostReason | opportunities | crm.stage / crm.lost.reason (read in full each cycle) | rows of that stage / reason |

Large changes: if one shared-list change touches more than `ETL_SALES_MAX_INCREMENTAL_ROWS` (default 50,000) sales rows
(e.g. a team re-mapped in SalesTeam.xlsx), the cycle does not try it incrementally: it queues an immediate full sales
rebuild (the legacy path) and logs why. Conditions (2026-10-20):
* it must NOT block the other modules: the rebuild runs as its own job on a second queue (`etl-long`, its own worker,
  concurrency 1) and takes a SALES lock, not the global one; the 30-minute refresh keeps running receivables,
  collections, NPS and the shared lists (it skips only the sales module while the sales lock is held). The global ETL lock
  is split into per-module locks for this (core, sales, finance, process); the 02:00 full refresh takes all of them.
* the ETL Control Center shows "Full sales rebuild in progress -- started <time>" while that job runs (from etl_job_runs,
  job_type `sales_rebuild`), and its result afterwards.

## 5. Columns computed across several records (addition 5)

| Column(s) | Table | Grain | Recompute |
|---|---|---|---|
| First_Purchase_Date | lines | customer (all their orders) | per affected customer: every row of that customer |
| CustomerStatus (New / Active Retained / Reactivated / Non Active / Blocked) | lines (and legacy Dim_Customer) | customer x YTD/LYTD windows of the latest order date | per affected customer in the cycle; ALL customers at 02:00 (the windows move with the date) |
| InvoiceValue, Invoice Class, InvoiceYear | lines | order (sum of invoiced lines) | per affected order |
| OrderValue, OrderVolume, invoice_status, order_state | orders, documents | order | per affected order |
| SourceQuotationID, JourneyKey, QuotationClassification, IsRealQuotation, IsWonQuotation, IsRealSalesOrder, IsSystemGeneratedQuotation, QuotationToSalesOrder*, IsLinkedToOpportunity, OpportunityID/LeadID links | documents, orders, deliveries, leads, opportunities | journey = lead + opportunity + its quotations + orders | per affected journey (any changed order / quotation / lead / opportunity of it) |
| HasQuotation, FirstQuotationDate, LastQuotation*, | opportunities | opportunity + its quotations | per affected opportunity |
| Delivery quantities, DeliveryStatus, DeliveryProgressPercent | deliveries | picking (+ its order lines) | per affected picking / order |
| fact_sales_product_daily (all measures) | product_daily | company x product x date x salesperson x segment x channel x team x intercompany x mapped x UoM | per affected (company, product, date) |
| ASP_LY, ASP_ThisYear | targets | salesperson x team x company x month (from lines) | per affected (salesperson, month); targets themselves on SalesTeam/sales_targets.xlsx change |
| BCG classes, product dashboard / group (FirstSaleDate, LastSaleDate, YTD/LYTD values, lifecycle, stock band) | bcg, product_dashboard, product_group | company (all its products) | per affected company if it adds < ~1 min, else nightly only (measured, reported) |
| Avg_Daily_Sales, DOH, Velocity_Class, StockClass | inventory snapshot | product x company (lookback window) | in the SAME cycle for every product whose quants, cost or sales lines changed (they mix the calendar with Odoo data -- decision 2026-10-20); all products again at 02:00 |

Date-relative columns (they change with the calendar, not with Odoo): LeadAgeDays, OpportunityAge, DaysSinceUpdate,
DaysSinceLastQuotation, IsInactive, HasRecentActivity, QuotationAge* of open quotations, CustomerStatus windows, inventory
lookback. They are day-granular; the 02:00 full refresh recomputes all of them every night (after midnight), and rows
touched during the day are recomputed with the current date. Same freshness as today.

## 6. Stored computed fields vs write_date (addition 2)

Checked read-only on production Odoo, 30 days to 2026-10-20 (`data/etl/scripts/sales/check_write_date_bumps.py`):

| Event | Field(s) | Sale lines checked | Line or order write_date moved |
|---|---|---|---|
| delivery validated | qty_delivered | 3,327 | 3,326 (the other: its move was cancelled, no change) |
| invoice created (draft) | qty_invoiced, line/order invoice_status | 6,161 | 6,161 |
| invoice posted | -- (drafts already count in Odoo 17) | 6,076 | 5,819 same transaction; 257 posted later than the draft: nothing changed on the line, the creation was caught (257/257) |
| invoice cancelled | qty_invoiced, invoice_status | 26 | 26 |
| order confirmed | state | 6,193 | 6,193 |
| order cancelled | state | 28 | 28 |

Odoo stamps `write_date` with the transaction start; the check compares with the event's own transaction start. A changed
order re-reads all its lines, so an order-only bump is enough. Safety net: the daily id/consistency check (§7) also
compares `qty_delivered`, `qty_invoiced`, `invoice_status`, `state` per line for orders changed in the last 30 days.

## 7. Deletes

Daily id reconciliation for sale.order, sale.order.line, stock.picking, stock.move, crm.lead (like core_dims); stock.quant
id check every cycle (Odoo deletes empty quants all the time; ~3k ids).

## 8. Modes and release

`ETL_SALES_MODE` = `legacy` | `shadow` | `incremental` (same pattern `ETL_RECEIVABLES_MODE`, `ETL_CORE_DIMS_MODE`):
* legacy -- today: `main` 5x/day + 02:00 full write the live tables.
* shadow -- the 30-minute cycle maintains `shd_*` copies of the sales tables; dashboards read the live tables as today.
  `sales_shadow_compare`, right after the 02:00 full refresh, writes live-vs-shadow totals (company x currency x month x
  salesperson, and row counts per table) to `etl_shadow_diff`; the ETL Control Center shows the latest day.
* incremental -- the 30-minute cycle upserts the live tables; the 5x/day job is not scheduled. The 02:00 full refresh keeps
  rebuilding the live tables in every mode (the reference).
Switching = `.env` + `docker compose up -d backend etl-worker etl-api`; no code change, no migration rollback.
As built (step 1): the mode lives in `data/etl/.env` only (`ETL_SALES_MODE`, validated: a typo fails the run). The backend
needs `ETL_SCHEDULE_SALES_BUILD_ENABLED=true` for the build's schedule; in legacy mode the build ends at once. The
receivables / shared-lists modes are not needed yet: the shared lists' contents do not change (only how they are read),
and receivables stay a full read until their own incremental step.

## 9. Built so far (no migration needed)

| Piece | Code | Tests |
|---|---|---|
| sale.report rebuild library + currency guard + stable row key | `departments/sales/sale_report.py` | `tests/test_sales_sale_report.py`; production gate `scripts/sales/compare_sale_report_rebuild.py` (library output vs the pipeline's own `fetch_sale_report`, frame to frame) |
| affected-key logic (old + new values, shared-list changes, full-rebuild limit, DOH products) | `departments/sales/affected.py` | `tests/test_sales_affected.py` |
| change detection in the shared lists (only changed rows written / stamped; deleted map keys in the task log) | `etl_platform/load.py` `upsert_changed` / `replace_changed`, `core/jobs.py` | `tests/test_platform_load_changed.py`, `tests/test_core_dims_job.py` |
| "what changed since the last sales load" reader | `departments/sales/dim_changes.py` | `tests/test_core_dims_job.py` |

Measured locally: core_dims with no Odoo change 75 s -> 51 s (customer list 30 s -> 12 s, 72k -> 0 rows written). Left for
the shared-lists step of Phase B: partner company properties (24k rows re-read, 17 s).

## 10. Step 1: the mirror rebuild (built 2026-10-21)

Why two steps: the last local sales run (2026-10-20 18:00) spent 26.5 min reading Odoo and 11.5 min in the legacy
transforms (2.4 sales + 3.1 CRM), the key conforming (2.0) and the 611k-row swap (4.0). A local mirror removes the Odoo
part; scoping the transforms to affected keys (the 1-2 min target) is the larger, riskier refactor of ~7,500 lines, so it
comes after shadow has shown that the mirror rebuild is identical to the 02:00 rebuild from Odoo.

| Piece | What it does | Code |
|---|---|---|
| Odoo mirror (`raw_odoo_mirror`, `_meta`, `raw_odoo_names`) | The 12 models the sales build reads, as search_read records with the union of every reader's fields, kept current by write_date (previous read start - `ETL_MIRROR_OVERLAP_MINUTES`). Rules for values that move without the record's write_date: template -> variants, product cost -> quants, activities -> leads, parent -> children (a removed line moves only the order), partner -> user names. Many2one names from `raw_odoo_names`. Id checks every cycle for orders, pickings, leads, quants; everything + a write_date audit at 02:00. Non-stored fields no rule covers are logged. | `departments/sales/mirror.py` |
| `sales_mirror` | Module of the 30-minute refresh (lock `sales_mirror`); full check in the 02:00 `full_all`. Logs rows read per Odoo model. | `departments/sales/incremental.py` |
| `sales_build` | Second queue (`etl-long`, lock `sales_shadow` in shadow mode, `sales` in incremental mode). Skips in seconds unless the mirror, the shared lists, the input workbooks or the business date changed. Otherwise `build_sheets(source=mirror)` (same transforms; sale.report rebuilt by the gate-verified library), the same conform, then `replace_changed` per table (`_run_id` stamps changed rows only) and the full refresh's orphan / min-rows checks in the same transaction. | `incremental.py`, `sales_pipeline/pipeline.py` |
| `sales_shadow_compare` | After the 02:00 rebuild (shadow mode): every mart row by row (content hash, `_run_id` ignored) + fact_sales_lines totals per company x order currency x month x salesperson; orders edited in Odoo after the live read began are left out (listed). `etl_shadow_compare` / `etl_shadow_diff`, Control Center card. | `incremental.py` |
| `SalesLineGroupKey`, `Discount` on fact_sales_lines | Filled by both paths with one formula (`conform.line_group_keys`, from sale.report's `discount` read from Odoo at 02:00 and the library every 30 minutes). Unique index now; primary key in step 2 (needs every row filled first). | `conform.py`, `sales_report_repository.py` |
| Per-module locks | `<lock>:<module>`: a run locks the modules it writes; the isolated refresh locks each module when it starts and skips a busy one; `full_all` waits `ETL_FULL_LOCK_WAIT_SECONDS`. | `etl_platform/runner.py` |
| Second queue | BullMQ `etl-long` + its worker in the etl-worker process; the Flask API runs one job per lane (main / long); force-reset kills holders of every `<lock>:*`. | backend `etlQueue.ts`, `worker.ts`, `api/job_tracker.py` |
| Partner company properties | Incremental: partners whose write_date or credit-limit / payment-term `ir.property` changed; a changed company default, the 02:00 run or > 26 h since the last full read -> full read. | `core/jobs.py` |

The sales build reads the dims as they are when it starts (core_dims may refresh them in a parallel cycle; a key that
disappears fails the orphan check and the next build retries). The live `dim_customer` growth columns stay with the live
build in shadow mode.

