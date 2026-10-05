# Warehouse rename map and migration list

Status: **approved 2026-10-01** (D1-D3, migration order, frozen codes).
- **Applied to `powerBI_Data`:** 0028–0033 (2026-10-01 to 2026-10-04). The user lifted the "no production writes" rule
  for the database only, because there is no staging database.
- **Not applied:** `migrations/manual/0035_retire_legacy.sql` (renumbered from 0034 on 2026-10-04), until deployment and approval.
- **Deployment steps:** `docs/deployment-plan.md`.

Scope: everything in `powerBI_Data` that the ETL writes. The app's own tables (`app_user`, `roles`, `admin_*`,
`salesperson_admin_profile`, `kaizen_*`, `marcom_*`, `etl_job_runs`, ...) keep their names; only the
dimension **key values** stored in them change where noted in section 4.

The only consumers that must keep working are the web app (backend, frontend), the Flask ETL API and the Node
orchestration. All of them are updated in this change, so **no compatibility views are kept**.

> **Retired Power BI files.** The 35 `.pbix` files under `Desktop/PowerBIData/PowerBI` (MajaalSales, TikaSales,
> Promotion Dashboard, SandBox) and their copies in `Downloads` read the old table names over ODBC
> (`dsn=mysql_local`). They are retired. Anyone reviving one must repoint every query to the new names below
> (and note `CompanyKey` Tika = 3).

---

## 1. Conventions

| Item | Rule |
|---|---|
| Physical names | lowercase snake_case, as today (`lower_case_table_names=1`) |
| Layers | `raw_<source>_<entity>`, `dim_*` / `map_*` (core), `fact_<dept>_*` / `dim_<dept>_*` (marts), `v_<dept>_*` (serving), `etl_*` (meta) |
| Keys | every dimension key deterministic: Odoo id, frozen Excel code, or `yyyymmdd`. **`-1` = Unknown/Unassigned** in every dimension; facts never hold NULL keys |
| Key column names | `<Entity>Key` (PascalCase), the same names the backend and frontend already use (`CustomerKey`, `CompanyKey`, `SalespersonKey`, `SalesTeamKey`, `ChannelKey`, `SegmentKey`, `ProductKey`, `DateKey`). Finance uses the same names, so joins read the same in every department |
| Other columns | sales marts keep today's column names, which limits backend churn and keeps the regression comparable. New finance columns use snake_case, per the agreed spec |
| Primary keys | every table gets a real PK. No FK constraints; `etl_dq_result` orphan checks enforce integrity |
| Types | utf8mb4 / utf8mb4_unicode_ci; amounts `DECIMAL(20,6)`; Odoo ids `BIGINT` |
| Ownership | all DDL in migrations. pandas never creates or alters a table (`drop_recreate` is retired for platform tables) |
| Load patterns | `upsert` (dimensions, raw Odoo: rows are never deleted), `replace` (tables that must mirror their source exactly: raw Excel copies, `map_odoo_user_salesperson`, `map_product_master`, `dim_offday`), `swap` (mart facts), `snapshot_replace` (snapshot facts) |

---

## 2. Rename map

`→ (rebuilt)` means the same name with a new schema and keys. The old table is first renamed to `zz_legacy_<name>`
by the migration (rollback copy) and dropped in 0035 (retire, at deployment) after verification.

### Core: conformed dimensions (`core/`, upsert, never dropped)
| Old | New | Key (natural) | Notes |
|---|---|---|---|
| `dim_company` | `dim_company` (rebuilt) | `CompanyKey` = Odoo `res.company.id` (Majaal 1, **Tika 3**) | + `currency_id`, `currency` |
| `dim_customer` | `dim_customer` (rebuilt) | `CustomerKey` = Odoo **commercial partner** id | name, is_company, salesperson-of-record, active, Customer Growth columns per commercial partner, `CustomerID` (old name hash, kept one release) |
| — | `map_partner_customer` | `partner_id` | → `CustomerKey`: rolls contacts/addresses up to their commercial partner |
| — | `dim_customer_company` | (`CustomerKey`, `CompanyKey`) | credit_limit, default payment term (company-dependent in Odoo 17), IsBlocked/BlockedDate/... from BlockedCustomers.xlsx |
| `dim_salesperson` | `dim_salesperson` (rebuilt) | `SalespersonKey` = **frozen** Excel code (today's numbers) | name, `SalesTeamKey`, `ChannelKey`, status. Excel only |
| — | `map_odoo_user_salesperson` | `odoo_user_id` | → `SalespersonKey` (sheet `OdooUsers` in SalesTeam.xlsx; one person, several users) |
| `dim_salesteam` | `dim_sales_team` | `SalesTeamKey` = Excel org code | (the `UNASSIGNED` team was dropped 2026-10-04: no team = Inactive) |
| `dim_distributionchannel` | `dim_channel` | `ChannelKey` = **frozen**: Projects 2, Retail 3, Wholesales 4; Unknown **1 → -1** | codes go into SalesTeam.xlsx (sheet `channel`) |
| `dim_segment` | `dim_segment` (rebuilt) | `SegmentKey` = **frozen**: B2B 1, B2C 2, Backoffice 3, Inter Company 4; Unknown **5 → -1** | codes go into SalesTeam.xlsx (sheet `segment`) |
| `dim_date` | `dim_date` (rebuilt) | `DateKey` yyyymmdd | earliest source date → 31 Dec next year, auto-extends to the max due date; + `IsWeeklyRestDay` |
| `fact_offdays` | `dim_offday` | (`DateKey`, `OffDayType`, `CompanyKey`, `SalesTeamKey`) | calendar, not a business event; rows can apply to every company or one branch, so `-1` = all |
| `dim_product` | `dim_product` (rebuilt) | `ProductKey` = Odoo `product.product.id` | see decision D1 |
| — | `dim_product_master` | `ProductMasterKey` = the PRODUCTS.xlsx code (frozen) | catalogue incl. never-sold items (product pages). See D1 |
| — | `map_product_master` | (`ProductKey`, `CompanyKey`) | → `ProductMasterKey` (existing company-aware matching) |
| — | `dim_currency` | `CurrencyKey` = Odoo `res.currency.id` | code, decimals (LYD 3) |
| — | `dim_payment_term` | `PaymentTermKey` = Odoo id | max_days, is_instalment |

### Raw (incremental upsert by source id, + `_extracted_at`, `_run_id`, `_source_write_date`)
| Old | New |
|---|---|
| `raw_sale_order` | `raw_odoo_sale_order` |
| `raw_sale_order_line` | `raw_odoo_sale_order_line` |
| `raw_sale_report_api` | `raw_odoo_sale_report` |
| `raw_stock_move` | `raw_odoo_stock_move` |
| `raw_stock_picking` | `raw_odoo_stock_picking` |
| `raw_crm_lead` | `raw_odoo_crm_lead` |
| `raw_crm_stage` | `raw_odoo_crm_stage` |
| `raw_crm_lost_reason` | `raw_odoo_crm_lost_reason` |
| — | `raw_odoo_res_partner`, `raw_odoo_res_partner_company` (credit limit / payment term per company), `raw_odoo_res_users`, `raw_odoo_res_company`, `raw_odoo_res_currency`, `raw_odoo_product_product`, `raw_odoo_account_payment_term`, `raw_odoo_account_payment_term_line` |
| — | `raw_excel_salesperson`, `raw_excel_sales_team`, `raw_excel_odoo_users`, `raw_excel_channel`, `raw_excel_segment`, `raw_excel_sales_targets`, `raw_excel_products`, `raw_excel_offdays`, `raw_excel_blocked_customers` (each with `_file_sha256`) |
| — (phase 5) | `raw_odoo_account_move`, `raw_odoo_account_move_line` (open receivable lines) |

### Sales mart (`departments/sales/`, atomic swap)
| Old | New |
|---|---|
| `fact_saleslines` | `fact_sales_lines` |
| `fact_sales` | `fact_sales_documents` |
| `fact_orders` | `fact_sales_orders` |
| `fact_targets` | `fact_sales_targets` |
| `fact_delivery` | `fact_sales_deliveries` |
| `fact_lead` | `fact_sales_leads` |
| `fact_opportunity` | `fact_sales_opportunities` |
| `fact_productsalesdaily` | `fact_sales_product_daily` |
| `fact_inventory` | `fact_sales_inventory_snapshot` (could move to a future supply-chain department) |
| `fact_bcgmatrix` | `fact_sales_bcg_matrix` |
| `dim_invoice` (row-number `InvoiceKey` over order numbers) | `dim_sales_order`, `SalesOrderKey` = Odoo `sale.order.id` |
| `dim_crmstage` | `dim_sales_crm_stage` (`StageKey` = Odoo id, unchanged values) |
| `dim_lostreason` | `dim_sales_lost_reason` (`LostReasonKey` = Odoo id, unchanged values) |
| `dim_productcost` | `dim_sales_product_cost` (`ProductKey`, `CompanyKey`) |
| `dim_productdashboard` | `dim_sales_product_dashboard` (key `ProductMasterKey` + `CompanyKey`) |
| `dim_productdashboardgroup` | `dim_sales_product_group` (`ProductGroupKey`, deterministic from PRODUCTS.xlsx) |
| `productdashboard_meta` | `etl_sales_product_dashboard_meta` |

### Finance mart (phase 5, as agreed earlier, with conformed keys)
`dim_finance_invoice`, `bridge_finance_invoice_order`, `fact_finance_receivable_snapshot`.

### Serving views (the backend reads only these and the core `dim_*`)
`v_sales_lines`, `v_sales_documents`, `v_sales_orders`, `v_sales_targets`, `v_sales_deliveries`, `v_sales_leads`,
`v_sales_opportunities`, `v_sales_product_daily`, `v_sales_inventory`, `v_sales_bcg_matrix`,
`v_sales_product_dashboard`; finance: `v_finance_receivable_latest`, `v_finance_customer_exposure`,
`v_finance_receivable_trend`. The sales views start as 1:1 projections of their facts, so physical marts can
change later without touching the backend.

### Meta
| Old | New |
|---|---|
| `etl_run_log` | `etl_run_log` (+ job_name, department, parent_run_uid: **0028, written**) |
| `pipeline_run_log`, `pipeline_run_audit` | retired → `etl_run_log` + `etl_task_log` (Admin → ETL Runs and `etlRunTracker.ts` switch in phase 3) |
| `pipeline_load_metadata` | retired → `etl_watermark` |
| `qa_crm_*`, `qa_inventory_dataquality`, `qa_missingproductcost`, `qa_productdataquality`, `qa_productunmapped` | retired → `etl_dq_result` (QA *exports* to Excel stay in the Exports folder) |
| `_tmp_keys_*` (4 leftovers) | dropped |

---

## 3. Migration list

| # | File | Phase | Contents | Down script |
|---|---|---|---|---|
| 0028 | `0028_etl_platform_meta.sql` | 1 | etl_task_log, etl_dq_result, etl_watermark, etl_dataset_registry; etl_run_log + 3 columns, backfilled `sales` | `down/0028_*` |
| 0029 | `0029_core_dimensions.sql` | 2 | legacy dims -> `zz_legacy_*`; core raw tables, dims, maps with PKs and -1 members; stored keys (Tika 2 -> 3, 57 rows) | restores names and key values |
| 0030 | `0030_core_team_map.sql` | 3 | `raw_odoo_crm_team`, `raw_excel_odoo_teams`, `map_odoo_team_sales_team` (team as transacted, decision A) | drops them |
| 0031 | `0031_sales_mart.sql` (generated by `data/warehouse/tools/gen_0031_sales_mart.py`) | 3 | legacy sales facts/dims/raw -> `zz_legacy_*`; 17 sales mart tables with PKs; `v_sales_*` views | restores |
| 0032 | `0032_core_odoo_labels.sql` | 5 | `dim_odoo_selection_label`: Odoo's own selection labels, en + ar (**applied 2026-10-04**) | drops the table |
| 0033 | `0033_finance_receivables.sql` | 5 | finance raw, dims (`dim_finance_invoice`, `dim_finance_payment`, aging), bridge, snapshot fact, `v_finance_*` views (**applied 2026-10-04**; down + re-apply verified) | drops finance objects |
| 0034 | `0034_finance_receivable_scope.sql` | 7, at deployment | `receivable_scope`, `dim_finance_receivable_scope`, `v_finance_receivable_line`, default views = customer debt; Debt Report page grants | `down/0034_finance_receivable_scope_down.sql` |
| 0035 | `manual/0035_retire_legacy.sql` | 6, at deployment, **after** the regression is approved | drop `zz_legacy_*`, `pipeline_*`, `qa_*`, `_tmp_keys_*` | none (irreversible; the pre-rebuild dump is the rollback) |

**Applied to powerBI_Data** (no staging database; approved 2026-10-01): 0028 and 0029 on 2026-10-01 (down + re-apply
twice verified), 0030 and 0031 on 2026-10-04.

Migration 0024 (seasonality WIP in the main checkout) is not touched and its number is skipped.

---

## 4. Stored key values that change (data migration in 0029)

| Table.column | Rows | Change |
|---|---|---|
| `admin_company.etl_company_key` | 1 | 2 → 3 (Tika) |
| `salesperson_admin_profile.company_key_override` (+ `_history`) | 26 | 2 → 3 |
| `sales_team_admin_profile.company_key_override` (+ `_history`) | 26 | 2 → 3 |
| `role_data_scope` (`companyKeys` values) | 0 today | 2 → 3 if present |
| `salesperson_admin_profile.salesperson_key`, `app_user.salesperson_key`, histories | 28 + 1 | unchanged (keys frozen); 0 → -1 if present (none today) |
| `channel_key_override`, `segment_key_override`, `role_data_scope.segmentKeys` | 28 / 1 | unchanged (frozen); Unknown 1/5 → -1 if present (none today) |
| `sales_team_key_override`, `forced_closures.branch_key` | — | unchanged (Excel codes) |

The 2 → 3 swap is a plain `UPDATE ... WHERE key = 2`. That's safe because no stored value is 3 today; the migration asserts this
first and aborts otherwise.

---

## 5. Decisions needed before 0029/0030 are written

* **D1: product grain. Approved.** Outcome: Today `dim_product` mixes Excel master rows, `ODOO|<id>` rows and `RAW_FROM_ODOO|<hash>`
  rows: 1,134 Odoo products appear twice within the same company, and 78,392 of 142,384 sales lines point at a
  row with no Odoo id, although every sales line carries `OdooProductID`. Proposal:
  * `dim_product` keyed on the Odoo product id (what was sold);
  * `dim_product_master` keyed on the frozen PRODUCTS.xlsx code (the catalogue, incl. never-sold items);
  * `map_product_master` (`ProductKey`, `CompanyKey`) → `ProductMasterKey`, filled by the existing company-aware matching.

  Sales facts carry `ProductKey` and `ProductMasterKey`. Product pages read master attributes as today. Brand,
  category and product totals become part of the regression.
* **D2: staging input folder.** Production mounts `07PREPORT/Input`, where `PRODUCTS.xlsx` has an uncommitted
  edit; the worktree's `Input/` holds the committed version. Proposal: staging uses
  `C:/Users/Lenovo/etl-staging-input/`, which holds today's production `Input/` files plus the key-column edits to
  SalesTeam.xlsx, sales_targets.xlsx and BlockedCustomers.xlsx. The same edited files would be copied to
  production `Input/` in the deploy window.
* **D3: column naming.** Proposal as in section 1: PascalCase `<Entity>Key` everywhere, other sales columns
  unchanged, snake_case for new finance columns.

---

## 6. Phase 2 outcome

* **Duplicated products (1,134).** Every case is one `ODOO|<id>` catalogue row plus one `RAW_FROM_ODOO|<hash>` row for
  the same unmatched Odoo product (same name, same template). They are not variants, archived copies or Odoo
  duplicates; they come from the legacy pipeline. Keying `dim_product` on the Odoo id removes them, and no duplicate
  review CSV is needed.
* **Product matching parity.** Using the real Odoo catalogue and PRODUCTS.xlsx, `map_product_master` gives every one of
  the 142,395 current sales lines the same master product as today, and agrees on which lines are unmatched. So brand,
  category and product-master totals cannot move. (The 78,392 "lines without an Odoo id" were lines matched to
  PRODUCTS.xlsx rows, which never carried Odoo ids.)
* **Legacy rule kept.** A salesperson's team and channel count only while `Status = Active`. The effective
  `SalesTeamKey` is `-1` otherwise (`assigned_team_key` keeps the sheet value). 36 of 84 salespeople have no effective
  team today (32 blank Status, 3 Inactive, 1 Active without a TeamKey), so their sales sit in the Unknown team, exactly
  as now. (Correction 2026-10-04: the 32 with a blank Status have no TeamKey either -- no salesperson has a team and a
  blank Status -- so filling Status alone would not move them.)
* **No team = Inactive (rule added 2026-10-04).** A salesperson with no team is Inactive whatever the sheet Status says
  (see ETL.md section 1A). The 11 Odoo-only salespeople no longer get an `UNASSIGNED` team: they are Inactive with no
  team and keep their frozen keys.

## 7. Input file changes (staging copies only; production `Input/` is untouched until "deploy")

Staging input folder: `C:/Users/Lenovo/etl-staging-input/`, a copy of production `07PREPORT/Input` as of 2026-10-01
(incl. the uncommitted PRODUCTS.xlsx edit). Originals + SHA-256 sums: `~/etl-rebuild-backups/excel/original_2026-10-01/`.
Made by `data/etl/scripts/bootstrap_key_columns.py` (re-runnable on a fresh copy). At deploy, copy these five files to
production `Input/`:

| File | Change |
|---|---|
| `SalesTeam.xlsx` sheet `salesperson` | + `SalespersonKey` (frozen: today's numbers), + `ChannelKey`; + 13 rows: the 11 Odoo-only salespeople with orders (no team, Status Inactive), `Yousef Misrata` (from the targets file, team TK-MST-BC-01, Inactive), and `BIM` already in the sheet but never sold (new key 83) |
| `SalesTeam.xlsx` sheet `salesteam` | + `CompanyKey` (Majaal 1, Tika 3), + `SegmentKey` |
| `SalesTeam.xlsx` new sheets | `OdooUsers` (79 rows: odoo_user_id -> SalespersonKey), `OdooTeams` (23 rows: Odoo team id -> Excel team code, EXPORT = SALESPERSON), `channel` (2 Projects, 3 Retail, 4 Wholesales), `segment` (1 B2B, 2 B2C, 3 Backoffice, 4 Inter Company) |
| `sales_targets.xlsx` sheet `Targets` | + `SalespersonKey` (all 616 rows), + `CompanyKey` (24 rows without a company = -1). `SalesPerson 2` -> key of `Sales Person 2` |
| `PRODUCTS.xlsx` sheet `Products` | + `ProductMasterKey` (2,183 rows, today's derived keys frozen). Blank in a new row = generated `<sheet code>|<hash>` |
| `OffDays.xlsx` | + `CompanyKey` (blank = every company) |
| `BlockedCustomers.xlsx` | + `CustomerKey` (Odoo commercial partner id): 32 unique matches filled; 10 ambiguous + 1 unmatched left blank (`docs/blocked_customers_mapping_review.csv`) |

Columns were appended at the right of each sheet; no existing column moved or changed.

## 8. Readers of `pipeline_*` / `qa_*` (moved in phase 3, before 0035 drops the tables)

| Reader | Reads | Moves to |
|---|---|---|
| `backend/src/etl/services/etlRunTracker.ts` (`getMaxPipelineRunLogId`, `correlateLatestPipelineRunLog`) | `pipeline_run_log` | the job's `etl_run_log` row (counts) + `etl_task_log` |
| `backend/src/routes/admin/etlRuns.ts` + `frontend/src/lib/api.ts` types (Admin -> ETL Runs) | `pipeline_run_log`, `pipeline_run_audit` | `etl_run_log` (+ `etl_task_log` per task, `etl_dq_result`) |
| `data/warehouse/measures/refresh_status.py` (Python measures library) | `pipeline_run_log` | `etl_run_log`, same rule as `refreshStatus.ts` |
| `data/etl/scripts/backfill_etl_run_log.py` | `pipeline_run_log` | retired with it (one-off backfill, already run) |
| `data/ingestion/**` (orchestrator, scheduler, etl_executor, vendor copy) | `pipeline_*` | none: legacy stack, stopped 2026-09-30 |
| `qa_*` tables | written by the legacy exporter only; **no app reader** (`ProductDataStatus.tsx` mentions one in a comment) | `etl_dq_result`; the QA Excel exports in `Exports/` stay where a page links to them |

## 9. Backup taken before the rebuild, and how to restore it

Taken 2026-10-01 14:04 local, after the ETL was paused (section 10), as `powerbi_user`:

| Item | Value |
|---|---|
| File | `C:\Users\Lenovo\etl-rebuild-backups\powerbi_data_before_rebuild_20261001-1404.sql` |
| Size | 415,344,312 bytes |
| SHA-256 | `d219c07ddb7ec58842104f14e5f2e6e7a201e1843b9412de293da2a9d693838d` (also in `<file>.sha256`) |
| Tables | 91 `CREATE TABLE` = 91 live base tables; no views, routines, triggers or events |
| Options | `--single-transaction --quick --no-tablespaces --set-gtid-purged=OFF --default-character-set=utf8mb4` |

**Restore** (PowerShell, from any folder; each `mysql` prompts for the `powerbi_user` password). The database is
dropped first because the dump only recreates its own 91 tables: tables added by the rebuild (`dim_*` maps,
`raw_odoo_*`, `etl_*`, `zz_legacy_*`) would otherwise stay behind.

1. Keep the ETL stopped (section 10), then check the file:

```powershell
(Get-FileHash "$env:USERPROFILE\etl-rebuild-backups\powerbi_data_before_rebuild_20261001-1404.sql" -Algorithm SHA256).Hash
```

The hash must equal the SHA-256 above.

2. Recreate the database:

```powershell
& "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe" -h 127.0.0.1 -u powerbi_user -p --default-character-set=utf8mb4 -e "DROP DATABASE IF EXISTS powerBI_Data; CREATE DATABASE powerBI_Data CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
```

3. Load the dump:

```powershell
& "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe" -h 127.0.0.1 -u powerbi_user -p --default-character-set=utf8mb4 powerBI_Data -e "source C:/Users/Lenovo/etl-rebuild-backups/powerbi_data_before_rebuild_20261001-1404.sql"
```

4. Check: `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'powerBI_Data'` returns 91.

## 10. ETL paused for the rebuild (2026-10-01 14:03 local)

No run was active and nothing was queued (BullMQ queue `etl`: wait/active/delayed/prioritized all 0; last run, a
full refresh, finished 12:58 local). Stopped in the production compose project (`07PREPORT-ppl/07ps-sales-dashboard-app`):

| Container | Role | Effect of stopping |
|---|---|---|
| `etl-worker` | consumes the BullMQ queue | scheduled ticks (incremental every 3 h, full 02:00) and Control Center "Run" only queue a job; nothing executes |
| `etl-api` | Flask API that starts the Python pipeline | even a job picked up by another worker cannot run |

`frontend`, `backend` and `redis` keep running. Both containers have `restart: unless-stopped`, so they stay stopped
across Docker or Windows restarts. While stopped, the backend scheduler may leave **one** job waiting in the queue
(it never queues a second).

**Restart (only after the go-ahead).** First remove any waiting job, so it does not start the moment the worker is
back. Run this in `C:\Users\Lenovo\Desktop\07PREPORT-ppl\07ps-sales-dashboard-app`:

```powershell
docker compose exec -T redis redis-cli llen bull:etl:wait
```

If that is not 0, clear the stale job from the ETL Control Center (Cancel), or ask Claude. Then:

```powershell
docker compose start etl-api etl-worker
```

## 11. Team on facts: as transacted (decision A, 2026-10-04)

The legacy facts take the team from the document's Odoo team (matched by team name), not from the salesperson: on
today's data 32% of sales value (143.7M LYD) is on a team other than the salesperson's. Decision A keeps that, by id:
sheet `OdooTeams` (Odoo team id -> Excel code) feeds `map_odoo_team_sales_team` (migration 0030). Bootstrap and review:
`docs/odoo_team_mapping_review.csv` (25 Odoo teams: 22 matched, EXPORT -> `SALESPERSON` pending confirmation, Website and
eBay with no documents left unmapped). Rules: docs/adding-a-department.md "Org attribution rules". This corrects the
earlier "type 1" statement (impact analysis F11): current-state applies to the salesperson dimension only.

New migrations: `0030_core_team_map.sql` (raw_odoo_crm_team, raw_excel_odoo_teams, map_odoo_team_sales_team) and
`0031_sales_mart.sql` (generated by `data/warehouse/tools/gen_0031_sales_mart.py`). Renumbered again on 2026-10-04: 0032 is the core
Odoo label dimension (the finance views need it), 0033 is finance, and 0034 retires the legacy tables. **Renumbered 2026-10-04 (phase 7):** 0034 is the finance receivable scope, 0035 retires the legacy tables.
