# Warehouse schema — sheet-to-table mapping and validation notes

Target database: **MySQL 8**, replacing the earlier PostgreSQL choice (`docs/tech-stack-decision.md`
now reflects this — existing production infrastructure is MySQL). Built from a real 28-sheet
export, `SalesModel_OneOutput.xlsx`, not designed on assumptions alone. Every finding below was
verified programmatically against the actual export and, where noted, against a real load into a
throwaway MySQL 8 instance — not just inferred from column names.

No live database was connected to in this session. Credentials have not been provided. The
migrations were validated by loading them, plus a real sample of the Excel data, into a
local/throwaway MySQL 8 instance created for this session only.

## Migration files (apply in this order)

| File | Contents |
| --- | --- |
| `0001_dimensions.sql` | Conformed dimensions: `dim_date`, `dim_company`, `dim_segment`, `dim_distribution_channel`, `dim_sales_team`, `dim_salesperson`, `dim_customer`, `dim_product`, `dim_crm_stage`, `dim_lost_reason` |
| `0002_core_sales_facts.sql` | `fact_order`, `fact_order_line`, `fact_quotation` |
| `0003_customer_status_snapshot.sql` | `fact_customer_status_snapshot` |
| `0004_targets_and_calendar.sql` | `fact_target_plan`, `fact_calendar_exception` |
| `0005_scalability_facts.sql` | `fact_lead`, `fact_opportunity`, `fact_delivery`, `fact_inventory_snapshot`, `fact_product_performance_snapshot` |
| `0006_platform_rbac.sql` | `role_tier`, `dashboard`, `role_dashboard_access`, `app_user`, `user_role` |
| `0007_etl_and_audit_log.sql` | `etl_refresh_log`, `data_quality_log`, `audit_log` |
| `0008_target_plan_period_columns.sql` | Adds period columns to `fact_target_plan` |
| `0009_auth_identity.sql` | Real auth columns on `app_user`; `roles`, `pages`, `permissions`, `role_permissions`, `user_permissions`, `login_history`, `revoked_tokens` |
| `0010_etl_admin_page.sql` | Adds the `admin_etl` page/permission rows (superseded by the hard-role-gated ETL Control Center, see 0011 -- left in place, unused, harmless) |
| `0011_etl_control_center.sql` | `etl_job_runs` -- run tracking (trigger source, user, status, correlation with `pipeline_run_log`) for the Admin ETL Control Center |

`0002_facts.sql`, `0003_target_plan_fact.sql`, `0004_calendar_and_metadata.sql`,
`0005_customer_status_scd2.sql`, `0006_rbac_manifest.sql`, `0007_rls_policies.sql` are deprecated
stubs from the original PostgreSQL design (kept as no-op comment files for git history, per
"replace, don't silently disappear" — see each file's header).

## Sheet → table mapping

| Source sheet | Destination table(s) | Notes |
| --- | --- | --- |
| `Dim_Date` | `dim_date` | `year_month` renamed `year_month_label` — `YEAR_MONTH` is a reserved MySQL keyword |
| `Dim_Company` | `dim_company` | |
| `Dim_Segment` | `dim_segment` | |
| `Dim_DistributionChannel` | `dim_distribution_channel` | |
| `Dim_SalesTeam` | `dim_sales_team` | `SalesTeamStatus` normalized into an ENUM + kept raw in `sales_team_status_raw` |
| `Dim_Salesperson` | `dim_salesperson` | |
| `Dim_Customer` | `dim_customer` **+** `fact_customer_status_snapshot` | Split in two: static attributes (name, company, team, channel, segment, first purchase date) stay in the dimension; every refresh-computed value (LY/YTD/full-year value, active/blocked flags, `CustomerStatus`, `CustomerClass_LY`, last purchase date) moves to the snapshot fact — see "Corrected findings" below |
| `Dim_Product` **+** `Dim_ProductCost` | `dim_product` | Merged: `Dim_ProductCost.ProductCost` becomes `dim_product.standard_cost`. `Dim_ProductCost` has no other unique content |
| `Dim_CRMStage` | `dim_crm_stage` | |
| `Dim_LostReason` | `dim_lost_reason` | |
| `Dim_Invoice` | *(folded into `fact_order.invoice_key`)* | Verified 1:1 with `Fact_Orders` (both 36,969 rows, identical key sets) — carries no information `Fact_Orders` doesn't already have |
| `Fact_Orders` | `fact_order` | Real order-header revenue fact (one row per confirmed order) |
| `Fact_SalesLines` | `fact_order_line` | Real invoice-line grain, backs the Invoices Engine page |
| `Fact_Sales` | `fact_quotation` | **Renamed** — this sheet is a quotation-to-order CRM funnel fact (one row per quotation, converted or not), not a sales-revenue fact despite its name |
| `Fact_Targets` | `fact_target_plan` | Already a governed, structured fact in the real system — see "Corrected findings" |
| `Fact_OffDays` | `fact_calendar_exception` | `Branch` column holds `sales_team_key`-formatted values, not a separate Branch entity — FK'd to `dim_sales_team`, no new dimension created |
| `Fact_Lead` | `fact_lead` | **Primary key changed to `pipeline_record_id`**, not `LeadID` — see "Corrected findings" |
| `Fact_Opportunity` | `fact_opportunity` | |
| `Fact_Delivery` | `fact_delivery` | `order_key` nullable — 1,083 of 38,052 distinct delivery order numbers don't map to any `fact_order` row (system-generated/non-CRM deliveries, per the sheet's own `DeliveryClassification`) |
| `Fact_Inventory` | `fact_inventory_snapshot` | |
| `Fact_BCGMatrix` | `fact_product_performance_snapshot` | Renamed |
| `QA_CRM_DataQuality`, `QA_Inventory_DataQuality`, `QA_ProductMappingChecks`, `QA_CRM_UnmappedKeys` | *(excluded)* | Pipeline diagnostics, not warehouse data — see "Excluded sheets" below |

## Excluded sheets

The four `QA_*` sheets are outputs of the *existing* BI pipeline's own data-quality checks (e.g.
`QA_CRM_UnmappedKeys` — a running list of CustomerIDs that don't resolve to `Dim_Customer`). They
describe pipeline health, not business facts, so they aren't warehouse tables. `data_quality_log`
(0007) is the equivalent going forward: a lightweight table the new ETL writes to on each refresh,
rather than replicating these sheets verbatim.

## Platform tables (schema only, no application logic)

- `role_tier`, `dashboard`, `role_dashboard_access`, `app_user`, `user_role` — RBAC scaffold
  (Standards 5.2). `app_user.salesperson_key` is how a Salesperson-tier user is scoped to their own
  data. No auth logic (hashing, sessions, JWT) — that's Phase P2 API work, and depends on an
  open question: MySQL has no native Row-Level Security like the Postgres design this replaces, so
  the actual enforcement mechanism gets designed with the API layer, not guessed here.
- `etl_refresh_log` — one row per refresh run (Standards 5.11/5.14, 5x-daily refresh).
- `data_quality_log` — replaces the `QA_*` sheets going forward, FK'd to `etl_refresh_log`.
- `audit_log` — schema only, JSON before/after columns.

## Scalability facts (schema only, no dashboard pages)

`fact_lead`, `fact_opportunity` (CRM/Marketing), `fact_delivery` (Fulfillment),
`fact_inventory_snapshot`, `fact_product_performance_snapshot` (Inventory/Product) — modeled on the
same conformed dimensions as the Sales facts, so they're ready for later phases without needing a
redesign. No API endpoints or pages are built against them this session.

## Corrected findings vs. the original Phase 1 Database Review

The Standards doc's gap analysis was written without seeing a real export. Now that one exists,
here's what changed:

1. **Target/Plan fact — gap already closed, not still missing.** `Fact_Targets` already exists in
   the real system as a governed, monthly, salesperson-grain fact (616 rows). The standards doc's
   assumption that targets "live in Excel inputs" is wrong as of this export. No new modeling was
   needed here, just adoption as `fact_target_plan`.

2. **Calendar — partially already closed.** `dim_date` already carries `is_weekly_rest_day` from
   the source. What was genuinely missing was company/branch-specific holiday and forced-closure
   exceptions, at a grain `dim_date` can't hold directly (the same date can be a working day for
   Majaal and a closure for a Tika branch). `Fact_OffDays` (21 rows) closes this, modeled as its
   own `fact_calendar_exception` table.

3. **`dim_product` key format is not a gap.** Keys are a genuine mix of an "official master list"
   scheme (e.g. `TIKA-sku-n`) and a raw-Odoo-derived scheme (`ODOO|id`, `RAW_FROM_ODOO|hash`), by
   design of the source ETL's product-mastering process. Verified programmatically: 100% of
   `Fact_SalesLines.ProductKey` values (2,572 distinct) resolve against `Dim_Product`.

4. **`Dim_Invoice` is redundant, not a missing invoice-grain fact.** Verified 1:1 with
   `Fact_Orders` (identical 36,969-row key sets). Folded into `fact_order.invoice_key`. The real
   invoice-*line* grain needed for the Invoices Engine page is `Fact_SalesLines` → `fact_order_line`.

5. **`Fact_Sales` is not a sales-revenue fact.** Despite its name, it's a quotation-to-order CRM
   funnel fact (63,743 rows, every quotation whether or not it converted). Renamed
   `fact_quotation`. The real revenue fact is `Fact_Orders` → `fact_order`.

6. **`CustomerStatus` has six values, not four.** Standards Section 5.5's data dictionary lists
   four (Active Retained / Non-Active / Reactivated / Blocked). The real export has six: those four
   plus **Other** and **New**. Not constrained to an ENUM in `fact_customer_status_snapshot`, so a
   seventh value won't silently break future loads — flagging this for the data dictionary to be
   corrected is a Phase P0 sign-off item.

7. **CRM CustomerKey is broken in the source, ~63% resolve.** `Fact_Lead`, `Fact_Opportunity`,
   `Fact_Delivery`, and `Fact_Quotation` all have `CustomerKey` 100% null in the raw export; the
   parallel `CustomerID` text field resolves against `Dim_Customer` only about 63% of the time,
   consistent with the source's own `QA_CRM_UnmappedKeys` sheet. Fixed with a reserved
   `customer_key = -1` "Unknown Customer" surrogate row plus a nullable-FK pattern, per your
   approved decision, rather than leaving these columns unconstrained.

8. **`Fact_Lead`'s primary key is `PipelineRecordID`, not `LeadID` — found only by loading real
   data.** 145 of 3,562 `Fact_Lead` rows are duplicate `LeadID`s. Root cause: for every opportunity
   missing a real Odoo lead record, the source ETL synthesizes a second "lead history" placeholder
   row with the *same* `LeadID` (`LeadCreationSource='ETL'` — this accounts for 3,417 of the 3,562
   rows; only 145 are real Odoo-sourced leads). `PipelineRecordID` is the one column verified
   100% unique. `fact_lead`'s primary key was changed to `pipeline_record_id` after this was
   caught by the validation load (the original design, going in, assumed `LeadID` was safe as a
   PK — it silently produced 245 failed inserts before this was root-caused). `lead_id` is now a
   non-unique indexed attribute, and every table that references it
   (`fact_opportunity`, `fact_order`, `fact_quotation`, `fact_delivery`) does so as a documented
   soft link, not an FK, since `LeadID` alone can no longer be a stable FK target.

9. **Two column widths were too narrow for real data — found only by loading real data.**
   `dim_product.sku` and `.product_name` were sized for a normal SKU/name (`VARCHAR(50)` /
   `VARCHAR(255)`). Ten unmapped-Odoo products carry a concatenated multi-item string instead (up
   to 141 and 256 characters respectively) — widened to `VARCHAR(255)` / `VARCHAR(512)`. Similarly,
   `fact_product_performance_snapshot.perc_gross_profit_ytd/lytd` was `DECIMAL(8,6)`; low-volume
   products produce extreme percentage outliers (real values as low as -391.0345 seen in the
   source) — widened to `DECIMAL(10,4)`.

## Known findings requiring a follow-up decision (not fixed silently in this session)

These surfaced from loading a real slice of data and are reported rather than worked around,
per instructions — they need a decision, not a guess:

- **`dim_date`'s range (2021-01-30 to 2026-07-02, from the source `Dim_Date` sheet) doesn't cover
  forward-looking dates.** 205 of 616 `Fact_Targets` rows (forward monthly targets through at
  least December 2026), 89 of 3,272 `Fact_Opportunity` rows (`ExpectedCloseDate`), and 3
  `Fact_OffDays` rows (pre-planned future holidays) all reference dates beyond the calendar
  dimension's current upper bound. This is a real, common warehousing gap: calendar dimensions are
  normally pre-populated well into the future for exactly this reason. Extending it requires
  confirming the weekly-rest-day pattern and holiday calendar for those future dates — not
  something to assume silently, so it's flagged here rather than fixed.
- **4 `Fact_Delivery` rows reference a `ScheduledDate` outside `dim_date`'s range on the *past*
  side** — one is 2006-01-31 (almost certainly a placeholder/default timestamp, not a real
  schedule), the other three are early January 2021, just before `dim_date`'s lower bound. Worth
  raising with the source system owner rather than quietly extending the calendar backward to
  absorb a likely data artifact.
- **7 `Fact_Inventory` rows are genuine duplicates** — the same (SnapshotDate, ProductKey,
  LocationID) combination appears more than once with different values. This is a source data
  quality issue (the real ETL should aggregate or dedupe before load), not a schema problem.

## Validation performed this session

1. All 44 executable statements across the 7 new MySQL migration files applied cleanly to a fresh
   MySQL 8.0.46 instance — 29 tables created, zero errors.
2. A real, substantial slice of `SalesModel_OneOutput.xlsx` was then loaded into that schema: every
   dimension and small fact table in full (dims, `Fact_Lead`, `Fact_Opportunity`, `Fact_Targets`,
   `Fact_OffDays`, `Fact_Inventory`, `Fact_BCGMatrix`), and a 1,500–6,000 row sample of the four
   largest transactional sheets (`Fact_Orders`, `Fact_SalesLines`, `Fact_Sales`, `Fact_Delivery`).
3. Final result: every dimension loads with **zero errors**. Every remaining fact-table error is
   one of the diagnosed, legitimate findings above (forward-dated rows, genuine source duplicates,
   or a likely placeholder timestamp) — not a schema defect. Two real bugs were caught and fixed
   by this process before they could reach production: the `Fact_Lead` primary-key issue (#8 above)
   and the two column-width issues (#9 above). Both would have silently rejected real rows if the
   schema had only been designed on paper.
