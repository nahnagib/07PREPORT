# Regression report — sales rebuild, Phase 4 (2026-10-04)

Branch `feature/debt-receivables-etl`, worktree `07PREPORT-etl`. Nothing committed.

## Verdict

**PASS: approved 2026-10-04.** The four explained differences in section 4 were approved, as were the Distribution
Channel fix and the two order corrections (section 5). Everything else matches exactly or is one of the four
differences approved in advance (section 3):

- Revenue, quantities, targets, record counts, and every company, team, segment, salesperson, channel, brand and
  category total match the baseline exactly inside the comparison window.
- The new tables equal the legacy logic run on the same Odoo extraction (comparison A), except the BIM documents.
- Every orphan check passes. Every page endpoint answers. Page totals equal the regression totals.

## 1. What was compared

| Item | Value |
|---|---|
| Baseline | `~/etl-rebuild-backups/baseline_20261001-1410` (50 CSVs, legacy tables, ETL paused) |
| Record-level baseline | 22 tables restored from the 2026-10-01 14:04 dump into `zz_baseline_*` (in `powerBI_Data`). Their totals reproduce all 50 baseline CSVs exactly (0 differing rows) |
| Baseline freshness | newest Odoo `write_date` seen by the baseline: 2026-10-01 09:55:50 UTC |
| Final run | `core_dims` 6578c473 (11:04:02–11:04:50 UTC, success); `sales_full` e67484eb (11:04:53–11:26:34 UTC, success, **fresh Odoo extraction**, 537,018 rows) |
| Regression output | `~/etl-rebuild-backups/regression_20261004-1303/` (all CSVs, comparisons, page JSON) |
| Comparison window | `scripts/regression/window.py`: a record is in the window if it existed at baseline time and is unchanged since. That means same `write_date`; for an order, also the same lines with the same `write_date`. Deliveries also need their sale order in the window; leads and opportunities need all their orders in it. Written to `zz_regression_window` |

Counting method: dates compare as whole days (`DATE(x) <= 2026-09-30`), and undated rows count. Measures must
match within 0.001; row counts must match exactly.

### Comparisons

| Name | Left | Right | Purpose |
|---|---|---|---|
| A | legacy transforms on the same extraction (`legacy_same_run`) | new tables (`new`) | isolates the code: keys, rules, loading |
| B | baseline, window only (`baseline_window`) | new tables, window only (`new_window`) | **the gate**: like for like with the baseline |
| drift | baseline, all records | new tables, all records | context: includes everything that changed in Odoo since |

## 2. Pass / fail per check

| # | Check | Result | Notes |
|---|---|---|---|
| 1 | Restored baseline = baseline CSVs | **PASS** | 50/50 files, 0 differing rows |
| 2 | A: legacy logic vs new, same extraction | **PASS with one item for approval** | 50 files compared. Only `sales_documents__salesperson_month` differs (34 rows): the BIM documents, 4b. Targets per salesperson differ by the approved move (3c) |
| 3 | B: revenue (`Value`), volume, quantities, record counts, sales lines | **PASS** | sales lines in window: 141,107 rows, Value 433,241,432.90, identical |
| 4 | B: totals by company, team, segment, salesperson, channel, brand, category (lines) | **PASS** | only `InvoiceValue` differs (4a) |
| 5 | B: orders and documents | **PASS except 4a/4b** | |
| 6 | B: targets | **PASS** | 616 rows, 249,915,808.00 revenue, 3,447,061.02 volume, identical. Only the approved Unknown → name move (3c) |
| 7 | B: leads, opportunities | **PASS** | identical in the window |
| 8 | B: deliveries | **PASS except 4c** | 2 pickings, 253 units |
| 9 | Product daily, BCG, inventory | **PASS (A)**; not windowable | no record id (daily aggregates, YTD classes, today's stock). Identical to the legacy logic on the same extraction (A); whole-data drift in 4d |
| 10 | Admin salesperson profiles | **PASS** | 28/28 resolve to the same person; only change: 11 `company_key_override` 2 → 3 (Tika, approved) |
| 11 | Salesperson logins | **PASS** | user 27 → key 34 (Ibrahim Garguom), user 19 → key 3 (Abdelraheam Benkhayal): same names as at baseline |
| 12 | Every page endpoint, admin, 8 scopes | **PASS** | 151/151 HTTP 200 |
| 13 | Salesperson login on every page | **PASS** | user 27: all 200 in own scope; another salesperson's scope → 403 "outside your assigned scope" (correct). User 19 → 403 `PASSWORD_CHANGE_REQUIRED` (account must change password; not data, not touched) |
| 14 | Page totals = regression totals | **PASS (after fix 5a)** | revenue-trend value, 7 scopes × 9 months (2026): page = new tables (0.000 difference everywhere); new = baseline inside the window (0.000 everywhere, override-aware team/segment/channel included) |
| 15 | Fact → dimension orphan checks | **PASS** | sales run: 76 orphan + 17 min-rows checks pass; core run: 21 orphan pass, 1 intended warning (Salam Madhoun Active without team) |
| 16 | -1 fallbacks listed with ids and value | done | section 7 |

## 3. Accepted differences (approved in advance), with numbers

**3a. Customer counts: one customer per commercial partner.** Window, summed over company-months: 34,030 → 34,152
(+122). The distinct Odoo partners behind them are identical (34,155), so only the grain changed. The customer list now
has 16,003 rows keyed by `CustomerKey`; legacy was keyed by a name hash.

**3b. Tika company key 2 → 3.** Totals are by company name, so they don't move. Stored keys were changed in
migration 0029: 57 rows, plus 11 `salesperson_admin_profile.company_key_override` values.

**3c. Targets moved off "Unknown" to their salesperson. Totals unchanged.** 72 target rows, 22,169,850.00 revenue
and 195,549.47 volume moved from `Unknown_Salesperson` to:

| To | Revenue |
|---|---|
| Others | 12,750,000.00 |
| Sales Person 1 | 3,000,000.00 |
| Sales Person 4 | 2,369,850.00 |
| Sales Person 2 | 2,280,000.00 |
| Yousef Misrata | 1,020,000.00 |
| Salers Person 3 | 750,000.00 |

**3d. Salespeople without a team are now Inactive (rule of 2026-10-04).** 44 salespeople have no team in
`SalesTeam.xlsx`: 32 with a blank Status, 11 bootstrap-added (formerly `UNASSIGNED`), and Salam Madhoun (Status
Active). All 44 now have status Inactive, team `-1` and channel `-1`.

- **Channel movement: none (0 rows, 0.00 value)** on sales lines, orders and documents. None of the 44 had a known
  channel on any baseline fact row; the legacy code already gave non-Active salespeople the Unknown channel.
- **Team on facts: no change.** Team comes from the document (decision A).
- **Salespeople with a team but a blank Status: 0.** All 32 blank-Status people have no team either, so nothing is
  left to decide there. (This corrects my Phase 2 note; `rename-map.md` is updated.)
- The data-quality warning `warn:salesperson_active_status_without_team` lists 1 person: **60 Salam Madhoun**. Clean up
  the sheet.

## 4. Explained differences that need your approval

**4a. The legacy *incremental* load had stale order and invoice figures.** These are not changes in Odoo and not the
new code. 95 orders in the window, all Majaal from January–March 2025, plus one Tika quotation.

| Figure, same records | Baseline (legacy incremental, 1 Oct) | Legacy code, **full** build on today's extraction | New |
|---|---|---|---|
| Sales lines `InvoiceValue` (62 orders) | 2,509,356.73 | 3,081,064.73 | 3,081,064.73 |
| Orders `OrderValue` (87 orders) | 1,087,374.35 | 1,647,372.35 | 1,647,372.35 |
| Orders `OrderVolume` | 8,055.47 | 14,904.47 | 14,904.47 |
| Documents `OrderVolume` (70 documents) | 5,863.94 | 13,843.94 | 13,843.94 |
| Documents `IsRealQuotation` | 2 | 3 | 3 |

Odoo was checked read-only for these orders:

- None of their 115 invoices was created or changed after the baseline.
- No order's `state` or `invoice_status` changed.
- Their order and line `write_date`s are unchanged.

The legacy production table after the Oct 3 incremental runs held yet another `InvoiceValue` (2,973,389.73). So the
legacy incremental path drifts from its own full refresh, and the new tables equal the full refresh.

- **Effect:**
  - window `InvoiceValue` total: +571,708.00 (2,524,241,426.41 → 2,524,813,134.41);
  - window orders `OrderValue`: +559,998.00;
  - revenue (`Value`) and document `OrderValue` are unaffected.
- **Approved** 2026-10-04: the new values are correct.

**4b. BIM documents.** 84 *cancelled* documents from 2022–2024 (473,791.50) move from `Unknown_Salesperson` to
**BIM** (key 83).

- Legacy had the name "BIM" on these documents but key 0. Its salesperson dimension only held people with sales lines,
  and BIM has none.
- Under the bootstrap, BIM has key 83 and Odoo user 29 maps to it. BIM has no team, so is Inactive (3d).
- No other salesperson movement exists inside the window: none on lines; on orders, only the value differences of 4a.
- **Which measures see these documents** (checked in the backend code and the data):
  - **76 of the 84 (409,932.50)** are not real quotations (`IsRealQuotation = 0`, `IsRealSalesOrder = 0`) and have no
    sales lines or orders. **No measure on any page uses them.**
  - **8 (63,859.00)** are cancelled *real* quotations dated 2023-09-27 to 2024-05-07. The pipeline pages only query
    the current year (year-to-date since 2026-09-21: `pipelineTrend.ts` and `pipelineHealth.ts` use `ytdWindow`). So
    **these 8 appear on no page** either. (Corrected 2026-10-04: an earlier version said they show "for periods
    covering those months"; no such period can be selected.)
  - **No reported total changes.** Team (Unknown before and after), company, segment, channel and overall totals are
    unaffected; only the salesperson split moves.
  - At the time of the regression, the pipeline "quotation value" still included cancelled real quotations (legacy
    behaviour: 459 documents, 16,480,660.60 over all time). They are now excluded by decision; see section 9.
- **Approved** 2026-10-04.

**4c. Deliveries: two pickings, 253 units.** WHWA/OUT/07365 and WHF/OUT/00665. Their stock moves were reserved in Odoo
on 2026-10-03 (29 + 224 units). A stock-move change doesn't touch the picking's `write_date`, so the window kept them.
Delivered +253, remaining −253. This is an Odoo change after the baseline. **Approved** 2026-10-04.

**4d. Facts that cannot be windowed differ from the baseline by Odoo activity since 1 October.** They are identical
to the legacy logic on the same extraction (A). Whole-data drift, baseline → new:

| Fact | Change |
|---|---|
| Product daily | Value −21,863.02, 6 fewer rows. Same as sales lines (whole data −21,863.02): lines of the 448 modified and 188 new orders |
| BCG matrix | YTD value +882,014.58; 7 more rows (new products sold) |
| Inventory | stock is a snapshot of the run day: on-hand +233,052.54, value −732,643.38 |

**Approved** 2026-10-04.

## 5. Problems found and fixed during Phase 4

**5a. Bug: the Distribution Channel filter inferred nothing (fixed).** The backend's Unknown-channel inference treats
an Unknown channel as B2C/Backoffice → Retail and B2B/Inter Company → Projects. It still tested the legacy Unknown code
`1`, which no longer exists after the rebuild (Unknown is `-1`). A Retail filter lost about 4.2M LYD over 2026.

- Fixed in `backend/src/measures/filters.ts`, `backend/src/routes/filters.ts` and
  `backend/src/filters/optionsService.ts`, and in 2 tests.
- After the fix, Retail-scope page totals equal the baseline exactly inside the window.
- No other hard-coded legacy Unknown code (0, 1, 5, MJ-TIK-00, Tika 2) remains in backend or frontend.

**5b. Per-fact team fallback.** When a document has no Odoo team, the legacy pipeline used the salesperson's team for
sales lines and orders, but Unknown for documents, deliveries, leads and opportunities. The new code now does the same
per fact (`TEAM_FALLBACK_TO_SALESPERSON`). Deliveries take their keys from the sale order only. Documented in `ETL.md`
and `adding-a-department.md`.

**5c. Two orders corrected.** Order names repeat across companies. Legacy `Fact_Orders` carried Majaal's order id for
Tika's S24144 (34,965.00) and S00797 (25.00). The new tables use Tika's order, which matches the legacy attributes.

**5d. Regression tooling.**

- The capture could leave a pooled database session read-only. The first fresh run loaded its data but couldn't record
  its result; it is marked failed in `etl_run_log` and was re-run.
- Fixed in the tooling: the date cutoff now compares whole days, `'<NA>'` labels, and a collation mismatch.

## 6. Post-baseline volumes, outside the window

Records created, changed or deleted in Odoo after 2026-10-01 09:55:50 UTC. "Records" are Odoo records; rows are fact
rows.

| Fact | New since: rows, value | Modified since: rows, value now | (rows, value at baseline) | Deleted since |
|---|---|---|---|---|
| Sales lines (Value) | 303, 688,379.00 | 1,324, 13,192,095.49 | (1,279, 12,999,128.51) | 30 orders, 0 rows |
| Orders (OrderValue) | 56, 212,486.00 | 218, 10,194,107.49 | (212, 10,088,125.51) | 0 |
| Documents (OrderValue) | 165, 1,414,333.80 | 448, 11,291,155.14 | (448, 11,351,052.34) | 0 |
| Deliveries (OrderedQuantity) | 187, 1,016,239.05 | 479, 90,313.50 | (479, 115,710.21) | 12 pickings, 0 rows |
| Leads (Count) | 8 | 10 | (10) | 0 |
| Opportunities (ExpectedRevenue) | 8, 195,000.00 | 10, 930,000.00 | (10, 592,850.00) | 0 |

Odoo record counts:

- **Orders:** 188 new, 448 modified (366 of them changed only on their lines), 30 deleted.
- **Pickings:** 218 new, 479 modified, 12 deleted.
- **Leads:** 10 new, 10 modified.
- **Records that existed at baseline time but were missing from the baseline:** 0.

## 7. Integrity and -1 fallbacks (final run)

All orphan checks pass. Odoo ids that resolved to `-1`:

| Fallback | Odoo id: name | Rows | Value |
|---|---|---|---|
| Leads/opportunities salesperson: Odoo user not in `OdooUsers` | 156 ISSAM ELOUNI | 39 leads / 37 opportunities | 10,350,000.00 expected revenue |
| | 10 RAMAD | 36 / 36 | 1,681,349.00 |
| | 8 Muhaned | 16 / 16 | 760,000.00 |
| | 26 HAMZA | 17 / 17 | 172,000.00 |
| | 135 Bilal Zaki Fakhouri | 6 / – | – |
| | 62 Islam Benghuzzi | 4 / 2 | 0.00 |
| | 18 hesha | 1 / 1 | 0.00 |
| Leads/opportunities with no Odoo user | – | 10 / 9 | – |
| Documents salesperson | 156 ISSAM ELOUNI | 3 | 11,415.20 |
| Documents customer: partner not in the customer map | 28669 وائل السائح | 1 | 1,100.00 |
| Inventory product: not returned by Odoo | 3141 | 2 | 0.00 |
| `dim_customer.SalespersonKey`: partner's user not in `OdooUsers` | 39 customers (users 10, 135, 156, 62, …) | – | – |

Legacy left all of these Unknown as well: the key-match difference is 0 on every one.

Several entries look like second Odoo accounts of mapped salespeople: Muhaned (8), RAMAD (10), HAMZA (26), hesha (18).
Adding them to sheet `OdooUsers` would attribute those leads. That is your call; I haven't changed the sheet.

`-1` members on the serving views, for context (all identical in kind to legacy):

- **Lines:** team/segment 477 rows (971,585.81, no Odoo team); channel 43,632 rows (97.6M, salespeople not Active);
  product master 64,097 rows (95.4M, unmatched to PRODUCTS.xlsx, see `product_unmatched.csv`).
- **Deliveries:** 9,875 pickings without a sale order (receipts and internal moves).
- **Targets:** channel `-1` on all 616 rows, as in legacy; team/company `-1` on 24 rows (1,950,000.00).

Full lists: `regression_20261004-1303/fallbacks.csv` and `integrity.json`.

## 8. Still open (unchanged)

- ~~Approve section 4~~: approved 2026-10-04.
- Your reviews:
  - `docs/odoo_team_mapping_review.csv`: EXPORT = SALESPERSON; Website (2) and eBay (4) are not listed, so their
    documents go to team `-1`;
  - `docs/blocked_customers_mapping_review.csv`;
  - the `OdooUsers` gaps in section 7.
- Unchanged:
  - `etl-worker`/`etl-api` stay stopped;
  - the `zz_legacy_*` tables (34) are kept;
  - the `zz_baseline_*` tables (22) and `zz_regression_window` can be dropped after approval.
- ~~`zz_baseline_*` / `zz_regression_window`~~: dropped 2026-10-04.
- Phase 5 (finance) is delivered (`finance_phase5_report_2026-10-04.md`). Phase 6 is next.

## 9. Intended change after the regression: cancelled documents leave the pipeline (2026-10-04)

Decision of 2026-10-04: a cancelled quotation is not pipeline. **This deliberately changes a legacy figure.**

**Code.**

- `excludeCancelledDocumentsClause` (`backend/src/measures/filters.ts`): `COALESCE(OrderState, '') <> 'cancel'`.
- Applied to:
  - the pipeline-trend quotation series (count and value by month);
  - the pipeline-trend sales-order series;
  - the pipeline-health funnel lists of quotations and sales orders.
- **Not** applied to the Quotation Rate KPIs: "lost quotations" *are* cancelled real quotations, and the win rate
  counts them in its denominator.
- Tested in `backend/src/measures/__tests__/filters.test.ts`.

**Effect.** The pages are year-to-date; anchor 2026-09-30, all companies:

| Series | Before (rows / value) | Cancelled removed | After |
|---|---|---|---|
| Pipeline trend: quotations by month (real quotation universe, 2026) | 892 / 34,953,254.05 | 36 / 59,735.00 | 856 / 34,893,519.05 |
| Pipeline trend: sales orders by month (2026) | 675 / 22,578,002.27 | 0 | unchanged |
| Pipeline health: quotation list (2026, before the page's B2B filter) | 13,303 / 137,872,129.05 | 163 / 221,386.40 | 13,140 / 137,650,742.65 |
| Pipeline health: sales-order list (2026) | 12,125 / 107,861,611.16 | 0 | unchanged |

Over all time, the real quotation universe holds 459 cancelled documents (16,480,660.60). That is the figure you
cited; the pages only ever show the current year of it.
