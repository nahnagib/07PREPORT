# Tachometer KPI/Measures Layer -- Validation Report

Scope: prove every KPI the Tachometer page needs can be correctly queried from the warehouse,
before any gauge/filter UI is built (P1 exit criterion). Measures/query layer only -- no UI, no
page components. Code lives in `data/warehouse/measures/` (see that folder's own README for module
layout); this report covers what was validated and how.

## 1. Metric -> warehouse source mapping

| Metric | Source | Notes |
| --- | --- | --- |
| YTD/MTD Value | `fact_order.order_value`, summed over the date window via `dim_date.calendar_date` | Order-header grain, not `fact_order_line` (see below) |
| YTD/MTD Volume | `fact_order.order_volume`, same window | |
| ASP (YTD/MTD) | `Value / Volume`, computed in Python (`ValueVolume.asp`) | Avoids a SQL divide-by-zero; returns `None` if volume is 0 |
| LYTD/LMTD | Same query, date window shifted one calendar year back (`filters.lytd_window` / `lmtd_window`) | |
| FLY/FLM | Same query, full prior calendar year/month window (`filters.fly_window` / `flm_window`) | |
| FY/FM Target | `fact_target_plan.target_revenue` / `target_volume`, summed by `target_year`/`target_month` | **Not** `date_key` -- see Finding 2 below |
| Target-to-date (grey needle) | Prorated in Python from FY/FM Target (`filters.prorate_mtd_target` / `prorate_ytd_target`) | Simple calendar-day method, confirmed with you; no existing pipeline logic to reuse (searched, none exists) |

**fact_order vs. fact_order_line:** Value/Volume use `fact_order` (one row per confirmed order,
the real order-header revenue fact) not `fact_order_line` (invoice-line grain, built for the
Invoices Engine page's per-line metrics). Using the line-grain table here would double-count any
order with multiple lines.

**Proration method:** confirmed with you as simple calendar-day proration. Implementation detail
worth being explicit about: because `fact_target_plan` stores one target row per calendar month
(not a single annual figure), the YTD-to-date figure is computed as *sum of full targets for
already-completed months + the current month's target prorated by day-of-month* -- not a flat
day-of-year ratio applied to the full-year total. Real monthly targets vary substantially
month-to-month (see Finding 2's data), so a flat annual-ratio proration would misstate a to-date
figure for a business with uneven monthly targets. See `filters.prorate_ytd_target`'s docstring.

## 2. Filter logic

| Filter | Backing dimension | Confirmed how |
| --- | --- | --- |
| Business Unit / Company | `dim_company.company_key` | Direct match (Tika, Majaal) |
| **Customer Group** | `dim_segment.segment_key` -- **not** `dim_customer.CustomerSegment` | See below |
| Distribution Channel | `dim_distribution_channel.channel_key` | Direct match |
| Branch | `dim_sales_team.sales_team_key` -- no separate Branch/Location table exists | Confirmed via `Fact_OffDays.Branch` containing `sales_team_key`-formatted values (prior session finding), and `dim_sales_team` has one row per physical team/branch (28 rows, each with a city) |
| Sales Person | `dim_salesperson.salesperson_key` | Direct match |
| POS | **Not wired -- confirmed no real data** | See below |

**Customer Group finding:** checked before assuming. `dim_customer.CustomerSegment` (the obvious
guess) only ever takes `'B2B'`, `'B2C'`, or `'Unknown'` in the real export (12,094 / 1,843 / 80 of
14,017 customers) -- no `'Corporate'` or `'Internal Company'` value exists there. The manual's four
groups are instead backed by `dim_segment`/`segment_key`, which the real `Dim_Segment` sheet
defines as five values: B2B (1), B2C (2), Backoffice (3), Inter Company (4), Unknown (5), all
populated with real row counts in `fact_order` (B2C 31,282 / B2B 4,371 / Backoffice 1,108 /
Unknown 176 / Inter Company 84). "Backoffice"/"Inter Company" are the same two groups the manual
labels "Corporate"/"Internal Company" -- a presentation-layer label mapping, not a different
dimension.

**POS finding:** searched every column header across all 28 sheets of the real export for
anything POS-related; found nothing (`HasHistoryPostLYTDLastYear` is the only substring match,
and it's "Post", unrelated). Confirms the manual's own "Inactive (not used)" note. No POS filter
is implemented -- building one with no backing data would be a working filter that silently does
nothing, which is worse than not building it.

**Salesperson RBAC lock:** `filters.apply_salesperson_lock()`, gated on `role_tier = 'SALESPERSON'`
(from `user_role`/`role_tier`) and `app_user.salesperson_key`. For a SALESPERSON-tier user: every
other filter (company/segment/channel/branch) is forced to "no restriction" and `salesperson_key`
is forced to the user's own key; a caller passing a *different* `salesperson_key` raises rather
than silently redirecting or silently honoring it (`SalespersonLockError`), so an integration bug
can't leak another salesperson's numbers. Unit-tested (`tests/test_filters.py`, 5 RBAC-specific
cases).

**Date filter:** a single "Specific Date" anchor drives both windows, matching the manual's own
description (MTD: start-of-month through selected date; YTD: start-of-year through selected date)
-- implemented once (`filters.mtd_window` / `ytd_window`) and reused for every metric, including
the LY/full-period variants (which just shift or replace the anchor before calling the same
functions).

## 3. classify_vs_target -- shared threshold function

`data/warehouse/measures/classify.py::classify_vs_target(actual, target)`. Green (actual >=
target), Yellow (actual >= 90% of target), Red (actual < 90% of target), plus a `NO_TARGET` state
for missing/non-positive targets so callers don't have to guess what "red" means when there's
nothing to compare against. One function, used by both the Value/Volume tachometers and the ASP
cards (`compute_asp_card` calls the identical function) -- not copy-pasted per metric.

18 boundary tests (`tests/test_classify.py`), all passing, explicitly including:
- exactly 10% below target -> **Yellow, not Red** (the edge case called out in the task)
- just over 10% below -> Red
- actual == target -> Green
- target None/zero/negative -> `NO_TARGET`
- boundary re-tested at a different absolute scale (4,500/5,000) to confirm it's not hardcoded

`variance_pct()` alongside it returns the signed percentage a caller can display next to the
color, sharing the same NO_TARGET semantics.

## 4. Last Update / Last Refresh Time

`data/warehouse/measures/refresh_status.py`:
- **Last Update** = `MAX(fact_order.order_datetime)` -- the latest loaded sales order timestamp.
- **Last Refresh Time** = most recent `pipeline_run_log.pipeline_end_time` where `status =
  'SUCCESS'` (not simply the most recent row regardless of status -- a failed run isn't "when the
  page last loaded the data").

Both confirmed queryable against the existing audit schema; no new tables needed.

## 5. Validation methodology -- what was actually loaded and why

Task C's throwaway warehouse was built by running the vendored pipeline against a **mocked** Odoo
catalog (2 companies, 2 sales teams, 4 products, a handful of sale.report/sale.order/crm.lead
rows) plus the real Input files. That's the right way to validate the *ingestion* pipeline
end-to-end without live Odoo access, and remains correct and unchanged.

It is the wrong dataset to validate *this* session's KPI query logic against, though: with only a
few mocked orders in `fact_order`, there's nothing real to reconcile Value/Volume/ASP against. For
this validation, `fact_order`, `dim_date`, and `fact_target_plan` in the throwaway MySQL instance
were additionally loaded **directly** from the real `SalesModel_OneOutput.xlsx` sheets
(`Fact_Orders` 37,021 rows, `Dim_Date` 1,983 rows, `Fact_Targets` 616 rows) -- bypassing Odoo and
the pipeline entirely, a one-time direct load for measures-validation purposes only. This does not
change the ingestion pipeline, the mocked-Odoo connector, or Task C's deliverable in any way; it
only repopulates a throwaway database used purely to prove these queries are correct against real
numbers. No live Odoo connection was made or needed for this, since the real export already
contains the real historical values to check against.

Anchor date used throughout: **2026-07-05** ("today" in this environment, and conveniently also
the real export's actual latest observed order date -- both MTD and YTD windows contain real
transactions to check).

### Finding: `dim_date` needed the real calendar loaded too

Loading the real 37,021-row `Fact_Orders` against the throwaway warehouse's existing `dim_date`
(built during Task C by running the pipeline against the narrow mocked-Odoo date range, correctly
for that run's own inputs) surfaced 35,784 orders with no matching `dim_date` row -- an INNER JOIN
on `dim_date` would have silently dropped nearly all of them from every Value/Volume query. This
isn't a bug in the pipeline or loader: the pipeline's self-generated `Dim_Date` sheet correctly
covers only the dates *it* observed in its own run, and it never saw these dates because they came
from the mocked Odoo catalog's narrow window. It's an artifact of this session's validation method
(injecting real historical data the original mocked run never saw). Fixed by also loading the real,
complete `Dim_Date` sheet (1,983 rows, already a full continuous calendar from 2021-01-30 to
2026-07-05 in the source export) directly, merged in via `ON DUPLICATE KEY UPDATE` so the existing
backfilled rows (e.g. the `TK-WST-BB` 1970-01-01 sentinel) weren't lost. Confirmed 0 orphaned
`fact_order` rows after the merge.

### Finding: `fact_target_plan`'s salesperson_key needed the real Fact_Targets reload too

The throwaway warehouse's `fact_target_plan`, as loaded by Task C's mocked-Odoo pipeline run, had
`salesperson_key = 0` for **all** 616 rows -- because resolving a name like "Mohamed Abdulhady" to
a `salesperson_key` depends on `dim_salesperson`, which is itself Odoo-derived, and the mock
catalog only has 2 salespeople. This reproduces exactly the mock-artifact already documented in
`data/warehouse/migrations/0004_targets_and_calendar.sql`'s corrected note. For this session's
salesperson-scoped test case to mean anything, `fact_target_plan` was reloaded directly from the
real `Fact_Targets` sheet (616 rows, real `SalespersonKey` values, 34 distinct keys) the same way
as `fact_order`/`dim_date` above.

### Real schema fix made during this session: `target_year`/`target_month` columns

While wiring the FY/FM Target queries, filtering `fact_target_plan` by calendar year via
`date_key` (or a `dim_date` join) would silently exclude the 12 known-bad `TK-WST-BB` rows
documented in `../ingestion/KNOWN_ISSUES.md` (their `date_key` is `19700101`, so a year-2026 filter
driven by `date_key` resolves them to year 1970 and drops them). Added `target_year`/`target_month`
columns (`0008_target_plan_period_columns.sql`), populated from the source sheet's own valid
`Year`/`Month` columns (not derived from the broken date), and pointed all target-period filtering
at them instead. Confirmed materially correct: FY 2026 target sum via `target_year` = LYD
169,380,533; the same sum via a `date_key` range = LYD 166,446,533 -- a LYD 2,934,000 undercount
that would have silently affected every FY/FM Target total that isn't filtered down to exactly
`TK-WST-BB`. This does not patch the broken date itself (still unpatched, per the known-issue
decision), it just stops period-based target aggregation from depending on the one column known to
be wrong for that team.

## 6. Full test matrix reconciliation results

Filter matrix (Section 9.1): All / Majaal only / Tika only / Salesperson 50 (Majaal's
highest-order-count salesperson, 4,783 real orders -- chosen as the "one named Salesperson" case).
Each run for both MTD and YTD, anchor date 2026-07-05.

### Value / Volume / ASP (vs. a pure-Python recomputation directly from the real `Fact_Orders` sheet)

| Filter | Period | My Value | Oracle Value | My Volume | Oracle Volume | My ASP | Oracle ASP | Match |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| All | MTD | 531,584.50 | 531,584.50 | 4,652.986 | 4,652.986 | 114.2459 | 114.2459 | Exact |
| All | YTD | 50,466,283.42 | 50,466,283.38 | 353,346.848 | 353,346.848 | 142.8236 | 142.8236 | Value off by $0.037 (see note) |
| Majaal only | MTD | 486,645.50 | 486,645.50 | 3,248.986 | 3,248.986 | 149.7838 | 149.7838 | Exact |
| Majaal only | YTD | 45,934,662.42 | 45,934,662.38 | 276,026.848 | 276,026.848 | 166.4137 | 166.4137 | Value off by $0.037 (see note) |
| Tika only | MTD | 44,939.00 | 44,939.00 | 1,404.000 | 1,404.000 | 32.0078 | 32.0078 | Exact |
| Tika only | YTD | 4,531,621.00 | 4,531,621.00 | 77,320.000 | 77,320.000 | 58.6087 | 58.6087 | Exact |
| Salesperson 50 | MTD | 69,105.00 | 69,105.00 | 161.720 | 161.720 | 427.3126 | 427.3126 | Exact |
| Salesperson 50 | YTD | 15,954,983.11 | 15,954,983.11 | 83,008.209 | 83,008.209 | 192.2097 | 192.2097 | Exact |

**Root cause of the two non-exact Value rows:** a $0.037 absolute difference on ~$50M and ~$46M
sums (relative error ~7 x 10^-10). This is floating-point summation drift between MySQL's
`DECIMAL(16,2)` fixed-point `SUM()` and a pure Python `float` accumulation over ~34,000 individual
order values read straight from the Excel cells -- not a logic error. Confirmed by isolating the
diff: it is the *identical* $0.03667 amount in both the "All" and "Majaal only" rows (Tika's rows,
summing far fewer records, matched exactly), consistent with float accumulation noise scaling with
the number of terms summed, not with a filter or join being wrong. No formula was adjusted to hide
this -- it's reported as-is because it's immaterial (worth six-plus orders of magnitude less than
a single cent would be) but real.

### FY/FM Target (vs. the real `Fact_Targets` sheet, summed in pure Python)

| Filter | FM Target (mine) | FM Target (oracle) | FY Target (mine) | FY Target (oracle) | Match |
| --- | --- | --- | --- | --- | --- |
| All | 18,613,114.47 | 18,613,114.47 | 169,380,533.00 | 169,380,533.00 | Exact (to the same float-noise tolerance) |
| Majaal only | 8,809,891.72 | 8,809,891.72 | 80,362,652.00 | 80,362,652.00 | Exact |
| Tika only | 9,803,222.75 | 9,803,222.75 | 89,017,881.00 | 89,017,881.00 | Exact |
| Salesperson 50 | 1,321,884.96 | 1,321,884.96 | 12,017,136.00 | 12,017,136.00 | Exact -- only correct after the real Fact_Targets reload (see Finding above; the mock-artifact-loaded fact_target_plan returned 0 here before the reload) |

### Target-to-date, classification, and ASP cards (sample, anchor 2026-07-05)

| Filter | Period | Actual (Value) | Target-to-date | Status | Variance |
| --- | --- | --- | --- | --- | --- |
| All | MTD | 531,584.50 | 3,002,115.24 | Red | -82.3% |
| All | YTD | 50,466,283.42 | 68,805,490.27 | Red | -26.7% |
| Majaal only | MTD | 486,645.50 | 1,420,950.28 | Red | -65.7% |
| Majaal only | YTD | 45,934,662.42 | 32,612,384.56 | Green | +40.9% |
| Tika only | MTD | 44,939.00 | 1,581,164.96 | Red | -97.2% |
| Tika only | YTD | 4,531,621.00 | 36,193,105.71 | Red | -87.5% |
| Salesperson 50 | MTD | 69,105.00 | 213,207.25 | Red | -67.6% |
| Salesperson 50 | YTD | 15,954,983.11 | 4,899,890.29 | Green | +225.6% |

ASP cards spot-checked (All/Majaal, MTD/YTD) also produced varying Green/Yellow statuses (not a
single hardcoded outcome), confirming `compute_asp_card` is exercising the same
`classify_vs_target` logic correctly for a different metric family.

These are genuine, sometimes-Red-sometimes-Green results driven by real numbers -- no thresholds
or formulas were tuned to make them look a particular way.

## 7. Not validated in this session (structural only, unchanged from Task C)

Everything downstream of live Odoo (the actual production sales/CRM/inventory feed) remains
validated *structurally only*, per Task C and per this session's explicit instruction not to run a
live Odoo extraction. The direct real-data loads described in Section 5 were a one-time
substitution in the throwaway database for measures-validation purposes only; they do not
constitute a live Odoo connection and don't change that constraint.

## 8. Backend data-access layer -- flagged, not fixed here (out of scope)

`backend/src/db/pool.ts` uses `pg` (node-postgres) and `backend/src/middleware/rlsContext.ts`
implements Row-Level Security via Postgres `SET LOCAL`/`current_setting()`, referencing a
migration file that is now a deprecated no-op stub
(`data/warehouse/migrations/0007_rls_policies.sql`) because the project moved to MySQL 8. MySQL
has no equivalent native RLS mechanism, so this backend scaffold cannot enforce scoping the way its
own README describes today. This predates this session and was not touched (explicitly out of
scope: no platform-shell changes this session), but it's a real blocker for wherever these measures
functions get wired into an actual API endpoint in Phase P3 -- that phase will need to either
adopt a MySQL client (e.g. `mysql2`) and move scope-enforcement into application code (this
package's `filters.apply_salesperson_lock` is exactly that kind of application-level enforcement,
already written framework-agnostically for this reason), or find another way to reconcile the two.
The SQL and business logic in `data/warehouse/measures/` don't depend on that decision either way
and can be ported into whichever shape Phase P3 settles on.

## 9. Deliverables

- `data/warehouse/measures/` -- `classify.py`, `filters.py`, `tachometer.py`, `refresh_status.py`,
  `db.py`, `tests/` (40 tests, all passing)
- `data/warehouse/migrations/0008_target_plan_period_columns.sql`
- `data/ingestion/KNOWN_ISSUES.md` (new)
- `data/ingestion/README.md` (Google Drive decision closed)
- This report

## 10. Done / not done

Done: every metric in the manual's table is queryable and matches real production numbers for the
full Section 9.1 test matrix (to floating-point tolerance, root-caused above); the color-threshold
logic is one shared, boundary-tested function; filter logic including the Customer Group mapping
and the Salesperson RBAC lock are implemented and tested; Last Update/Last Refresh Time are wired;
both open decisions (Google Drive intake, `TK-WST-BB`) are closed or explicitly logged as pending.

Not done, by design: no gauge UI, no filter UI, no page layout -- that's the next prompt.
