# Adding a department to the ETL platform

Status: conventions approved 2026-10-01. The step-by-step walkthrough with `departments/_template` is added in
phase 6; the rules below already apply to every new table.

## 1. Conventions (all departments)

### Join keys
* A join key is always named **`<Entity>Key`** (PascalCase): `CustomerKey`, `CompanyKey`, `SalespersonKey`,
  `SalesTeamKey`, `ChannelKey`, `SegmentKey`, `ProductKey`, `ProductMasterKey`, `CurrencyKey`, `PaymentTermKey`,
  `DateKey`. The same name means the same key in every table, so any fact joins to any dimension the same way:
  `fact_x.CustomerKey = dim_customer.CustomerKey`.
* Date keys on a fact say which date they are: `OrderDateKey`, `DueDateKey`, `SnapshotDateKey`, all yyyymmdd and all
  joining to `dim_date.DateKey`.
* Keys are **deterministic**: an Odoo id (commercial partner, company, product variant, currency, payment term), a
  frozen code kept in an Excel input (salesperson, team, channel, segment, product master), or yyyymmdd. Never a
  row number, never a name. A key is never reused or renumbered.
* **No NULL keys in facts.** Every dimension has an Unknown/Unassigned member, `-1` (text keys: `'-1'`). A fact row
  whose source id does not resolve gets `-1`, and the task reports it with
  `ctx.record_fallback("<table>.<Key>", source_ids)`; the count and sample ids land in `etl_task_log`.
* **Customer = commercial partner.** Resolve any Odoo partner id through `map_partner_customer`; a salesperson
  through `map_odoo_user_salesperson`; a product's catalogue entry through `map_product_master`.

### Org attribution rules (every fact, every department)

| Attribute on a fact | Rule | Source |
|---|---|---|
| **SalesTeamKey** | **As transacted:** the document's Odoo team (`crm.team` id on the order, lead, invoice, ...) mapped to the Excel org code through sheet **`OdooTeams`** of `SalesTeam.xlsx` (`map_odoo_team_sales_team`). `crm.team` is a lookup id only, never matched by name. | order `team_id`, lead `team_id`, invoice `team_id` |
| | Document has **no** Odoo team, or its `OdooTeams` row says **`SALESPERSON`** (e.g. EXPORT, an Odoo team with no Excel team): what the legacy pipeline did **for that fact** (measured 2026-10-04, `TEAM_FALLBACK_TO_SALESPERSON` in `departments/sales/conform.py`): sales lines and orders → the salesperson's effective team (`dim_salesperson.SalesTeamKey`); documents, deliveries, leads and opportunities → `'-1'` Unknown. A new department chooses per fact (`KeyMaps.teams(..., person_fallback=)`). Finance receivables: the salesperson's team (an invoice with no team, and every payment, nets with its salesperson's invoices); salesperson = `invoice_user_id`, else the customer's salesperson of record (`docs/receivables-etl.md`). | |
| | Odoo team **not listed** in `OdooTeams` → `'-1'` Unknown, reported as a warning (team ids and value). | |
| **SegmentKey** | follows the **team** (`dim_sales_team.SegmentKey` of the fact's team) | |
| **ChannelKey** | follows the **salesperson** (`dim_salesperson.ChannelKey`) | |
| **SalespersonKey** | the document's user (order `user_id`, lead `user_id`, invoice `invoice_user_id`) through sheet `OdooUsers` (`map_odoo_user_salesperson`) | |
| **Delivery keys** | from the delivery's **sale order** only; a picking without one (receipts, internal moves) keeps every org key `-1`, as in the legacy pipeline | |

**Salesperson status rule (applies everywhere).** A salesperson with **no team** (blank `TeamKey` in `SalesTeam.xlsx`)
is **Inactive** -- a former salesperson -- whatever the `Status` column says. Applied by the ETL when building
`dim_salesperson` (`core/transforms/org.py`, `effective_status`); the Excel file is not edited. `dim_salesperson.status`
is the effective status. Anyone whose sheet `Status` says Active but who has no team is listed by the data-quality
warning `warn:salesperson_active_status_without_team` (and a WARNING notification) so the sheet can be cleaned up.
A salesperson **with** a team but a blank `Status` is not counted as active (legacy rule, unchanged).

The salesperson **dimension** is current-state: `dim_salesperson.SalesTeamKey` / `ChannelKey` are the person's team and
channel today (they count only while the effective status is Active, so a salesperson without a team has team `'-1'`
and channel `-1`). Facts take the team from the document (above), so this rule does not move a fact's team; it moves a
fact's **channel** (which follows the salesperson) to `-1` for people without a team. A **fact's** team is as-transacted (the document's team), so a
salesperson's history is NOT moved to their current team. (Correction: an earlier impact analysis, F11, called the org
assignment "type 1"; that holds for the salesperson dimension only, not for the team on facts.)
Implemented once in `core/resolve.py` (`KeyMaps`) and used by every department, so sales and debt roll up to the same
teams and people.

### Odoo labels (every department)

Never hard-code a display label for an Odoo selection field: `move_type`, `payment_type`, `partner_type`,
`payment_state`, `state`, `delivery_status`, and any future one.

- **Source.** Labels are read from Odoo with `fields_get(attributes=["string", "selection"])` (`OdooSource.field_labels`).
- **Languages.** Read in `en_US` and, when an Arabic language is active in `res.lang`, in Arabic.
- **Storage.** Labels go in the core dimension **`dim_odoo_selection_label`** (`model`, `field`, `value`, `label_en`,
  `label_ar`), loaded by `core_dims` (`core/labels.py`).
  - To add a field, list it in `SELECTION_FIELDS`.
  - When Arabic is not active, `label_ar` stays NULL, a WARNING is logged, and the runbook should say so.
- **Facts keep technical values and keys only.** Dimensions keep technical values too. Views and pages join
  `dim_odoo_selection_label` for the label.
- **Record names** (journals and the like) are read in both languages in the same way (e.g.
  `dim_finance_payment.journal_name_en` / `journal_name_ar`).
- **Our own concepts** that are not Odoo fields (aging bucket names, `salesperson_source`) are named in code and
  documented as ours.
- **Example (receivables).**
  - An invoice or credit note shows Odoo's `move_type` label: Customer Invoice / فاتورة العميل.
  - A payment shows `payment_type` (Send / Receive), `partner_type` (Customer / Vendor) and the journal name.
  - No invented "Invoice", "Credit Note", "Unapplied Payment" or "Journal Entry".

### Column names
* Columns that already exist in a sales table keep their name (the backend and the regression depend on them).
* Every **new non-key column** is snake_case: `residual_company_ccy`, `days_past_due`, `credit_limit`.
* Amounts are `DECIMAL(20,6)` (LYD has 3 decimals); Odoo ids `BIGINT`; text utf8mb4 / utf8mb4_unicode_ci.

### Table names and layers (one database, separated by prefix)
| Layer | Name | Load |
|---|---|---|
| Raw | `raw_<source>_<entity>` (`raw_odoo_account_move`, `raw_excel_targets`) + `_extracted_at`, `_run_id`, `_source_write_date`, `_deleted_at` | Odoo: incremental upsert by id. Excel: replaced as a whole |
| Core | `dim_*`, `map_*` (shared; owned by `core/`) | upsert, never dropped |
| Mart | `fact_<dept>_*`, `dim_<dept>_*`, `bridge_<dept>_*` | atomic swap, or snapshot delete + insert |
| Serving | `v_<dept>_*` (what pages and API routes read) | migration |
| Meta | `etl_*` | migration |

### Schema and integrity
* Every table is created by a numbered migration in `data/warehouse/migrations/` with a matching `down/` script.
  Every table has a primary key. pandas never creates or alters a table.
* No FOREIGN KEY constraints (warehouse convention). Declare an `orphan` check for every fact -> dimension key on the
  dataset (`etl_platform.quality.orphan`); orphans fail the run and the error lists the ids.
* Department-only dimensions are `dim_<dept>_*`. A dimension that a second department needs moves to `core/`.

### Sources
* Odoo is read-only: use `ctx.odoo(profile)` (allowlisted read methods only). A department with its own bot user
  gets its own credential profile: `ODOO_<PROFILE>_LOGIN`, `ODOO_<PROFILE>_API_KEY`, optional
  `ODOO_<PROFILE>_KEY_EXPIRES`.
* Excel inputs are read through a declared `SheetSchema` (`etl_platform.sources.excel`); key columns live in the file.

### Jobs
* A department job depends on `core_dims` (`JobSpec(depends_on_jobs=("core_dims",))`) and is registered in
  `departments/<dept>/jobs.py`, which the platform discovers automatically.
* Before loading facts with dates outside `dim_date`, call `core.jobs.ensure_date_range(conn, start, end)`.
