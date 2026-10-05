# Receivables ETL (Debt report): runbook

Finance department job `finance_receivables` (`data/etl/src/departments/finance/`). It snapshots every open customer
receivable from Odoo once a day, conformed with sales through the core dimensions.

## 1. What it loads

| Object | Content |
|---|---|
| `raw_odoo_account_move_line` | the open receivable journal items read in the last run (replaced each run) |
| `raw_odoo_account_move` | their journal entries (invoices, credit notes, payments, journal entries) |
| `raw_odoo_account_payment` | the `account.payment` records of the payment lines |
| `raw_odoo_account_journal` | their journals, with the name in English and Arabic |
| `raw_odoo_sale_order_invoice` | sale order ↔ invoice links (`sale.order.invoice_ids`) |
| `dim_finance_aging_bucket` | the 8 aging buckets (`departments/finance/aging.py`, the one place they are defined; these names are ours) |
| `dim_finance_invoice` | one row per `account.move` seen: technical `move_type`, `state`, `payment_state`, `delivery_status`, `has_sales_order`, and the conformed keys |
| `dim_finance_payment` | one row per `account.payment` (`PaymentKey`, −1 = not a payment line): technical `payment_type`, `partner_type`, `state`, journal name (en, ar), memo, dates |
| `dim_odoo_selection_label` (core) | Odoo's own labels for every selection value, `label_en` and `label_ar` |
| `bridge_finance_invoice_order` | invoice → sales order (`SalesOrderKey` = `dim_sales_order`) |
| `fact_finance_receivable_snapshot` | **one row per open receivable line per snapshot date** (PK `SnapshotDateKey, line_id`) |
| `dim_finance_receivable_scope` | the two receivable scopes, our labels (en + ar), `is_default` (`scope.py`) |
| `v_finance_receivable_line` | every snapshot, every scope, inter-company included, Odoo's labels (en + ar): what the Debt Report API reads |
| `v_finance_receivable_latest` | the latest snapshot, default scope (customer debt, no inter-company), Odoo's labels (en + ar) |
| `v_finance_customer_exposure` | latest snapshot per company + customer: open, overdue, not due, 90+, credit limit and ratio, `sales_last_90d`, DSO |
| `v_finance_receivable_trend` | open and overdue amounts per snapshot date, company and bucket |

**Inter-company receivables** are flagged `is_intercompany = 1`:

- the customer is the partner of one of our own in-scope companies (Majaal ↔ Tika); or
- the customer is one of the partners in `FINANCE_INTERCOMPANY_PARTNER_IDS` (config, Odoo partner ids; decision A1 of
  2026-10-04): `15905,15907`, the inter-company balance partners مديونية مجال and مديونية شركة تيكا.

The default `v_finance_*` views leave them out; the fact keeps them.

**Receivable scope** (0034; decision A2): every line carries `receivable_scope`, decided from Odoo's technical values
in `departments/finance/scope.py`, the one place the rules live (next to `aging.py`):

| Scope | Lines |
|---|---|
| `customer_debt` (default) | `move_type` `out_invoice` / `out_refund` / `out_receipt`; payments Receive / Customer (`inbound` / `customer`) |
| `other_receivable` | everything else: Send / Customer payments, journal entries without an invoice, vendor payments |

Inter-company stays a separate flag. `v_finance_receivable_line` holds every snapshot, every scope and inter-company
included, and is what the Debt Report API reads. `v_finance_receivable_latest`, `v_finance_customer_exposure` and
`v_finance_receivable_trend` show the default only: customer debt, inter-company excluded. With every scope and
inter-company included, the totals equal Odoo's open receivable lines: check with
`scripts/finance/check_receivable_totals.py`, which must print MATCH.

## 2. Rules

Source: the receivables spec of 2026-10-01; the code is in `transform.py`.

- **Grain.** Open receivable lines: `account_type = asset_receivable`, posted, not reconciled, `amount_residual != 0`,
  companies `ODOO_COMPANY_IDS`. This is the same basis as Odoo's Aged Receivable report.
- **Due date.** `date_maturity`, else `invoice_date_due`, else the line date. For instalment terms each instalment
  line has its own `date_maturity`. `invoice_date_due` (the last instalment) is kept as
  `dim_finance_invoice.invoice_final_due_date` and never used for aging.
- **Days past due.** Snapshot date (Africa/Tripoli) − due date. **Due today is not overdue.**
- **Buckets.**

  | Key | Bucket | Days past due |
  |---|---|---|
  | 1 | Not due 60+ | −61 or less |
  | 2 | Not due 31-60 | −60 to −31 |
  | 3 | Not due 16-30 | −30 to −16 |
  | 4 | Not due 0-15 | −15 to 0 |
  | 5 | Overdue 1-30 | 1 to 30 |
  | 6 | Overdue 31-60 | 31 to 60 |
  | 7 | Overdue 61-90 | 61 to 90 |
  | 8 | Overdue 90+ | 91 or more |

- **Document labels come from Odoo, never from code** (`docs/adding-a-department.md`, "Odoo labels").
  - Facts and dimensions keep the technical values. The views add Odoo's labels in English and Arabic, from
    `dim_odoo_selection_label`.
  - Invoices and credit notes show Odoo's `move_type` label (Customer Invoice / فاتورة العميل; Customer Credit Note).
  - Payment lines show `payment_type` (Send / Receive), `partner_type` (Customer / Vendor) and the journal name.
  - `v_finance_receivable_latest.document_label_en` / `document_label_ar` combine them.
  - Arabic is active in Odoo (`ar_001`), so both languages are stored. If Arabic were deactivated, `label_ar` would
    stay NULL and `core_dims` would log a WARNING.
  - Amounts keep Odoo's sign: credit notes and inbound payments are negative.
- **Amounts.** `residual_company_ccy` (`amount_residual`, in the company currency `dim_company.CurrencyKey`) and
  `residual_doc_ccy` (`amount_residual_currency`, in `CurrencyKey`).
- **Customer.** The line partner's commercial partner (`map_partner_customer`, as in sales).
- **Salesperson.** The invoice's `invoice_user_id` through sheet `OdooUsers`. With no invoice user: the customer's
  salesperson of record (`partner.user_id`, also through `OdooUsers`). The column `salesperson_source` says which
  one was used: `invoice_user` | `customer` | `none`.
- **Team.** The invoice's Odoo team through sheet `OdooTeams`. With no team, or a team marked SALESPERSON: the
  salesperson's effective team, as for sales lines and orders. An Odoo team missing from the sheet goes to `'-1'`.
- **Payment term.** The invoice's term, else the customer's default term for that company.
- **Delivery status (customer invoices only), in Odoo's own values.**
  - The invoice's orders come from `sale.order.invoice_ids`, else from the `invoice_origin` names in the same company.
  - The rollup stays in Odoo's `delivery_status` values: every order `full` → `full`; none delivered (`pending` or
    empty) → `pending`; anything else → `partial`.
  - No order → NULL with `has_sales_order = 0`.
  - The label comes from `dim_odoo_selection_label` (`sale.order` / `delivery_status`).

## 3. Odoo access, credentials and rotation

The job reads Odoo only: the client allows `search_read`, `search_count`, `search`, `read`, `fields_get` and
`read_group`, and refuses everything else. It runs only against the production database
(`ODOO_DB = ODOO_PROD_DB`, host in `ODOO_ALLOWED_HOSTS`) unless `ALLOW_NON_PROD=1`.

**Credential profile `debt`.** Until it is configured, the job uses the default read-only ETL credentials and logs a
WARNING on every run. Switching is a config change only: set the three variables and restart nothing else.

| Variable | Value |
|---|---|
| `ODOO_DEBT_LOGIN` | the bot user's login |
| `ODOO_DEBT_API_KEY` | its API key (secret store only: never in code, logs, files or tickets) |
| `ODOO_DEBT_KEY_EXPIRES` | the key's expiry date, `YYYY-MM-DD`. The job warns 14 days before (`ODOO_KEY_EXPIRY_WARN_DAYS`) and fails after it |

Shared settings: `ODOO_URL`, `ODOO_DB`, `ODOO_PROD_DB`, `ODOO_ALLOWED_HOSTS`, `ODOO_COMPANY_IDS=1,3`.

**Creating the bot user (Odoo admin, once).** I did not create it, as agreed.

1. **Create the user.** Settings → Users → New: name "ETL Debt Bot", an email login that nobody uses to log in, user
   type **Internal User**.
2. **Access rights:**
   - Accounting: **Read-only**
   - Sales: **User: All Documents** (for `sale.order.invoice_ids` and delivery status)
   - Contacts: read
   - no other groups
3. **Companies.** Allowed companies: Majaal (1) and TIKA (3). Default company: Majaal. Partner 3575 is on 72
   receivable lines but is not readable by the current ETL user. It should become readable once the bot user has
   both companies; check it after switching. Until then those lines go to customer `-1`, the agreed fallback.
4. **Password.** Set a long random password, store it nowhere, and use it only for the next step.
5. **API key.** Log in once as the bot → Preferences → Account Security → New API Key. Name it
   "dashboard-etl <date>". Copy it straight into the secret store as `ODOO_DEBT_API_KEY`.
6. **Expiry.** Set `ODOO_DEBT_KEY_EXPIRES` to 3 months ahead.
7. **Lock it down.** Log out. Optionally reset the password to a new random value nobody keeps.

**Quarterly rotation.** When the 14-day warning appears, or every 3 months:

1. Create a new key (step 5).
2. Update `ODOO_DEBT_API_KEY` and `ODOO_DEBT_KEY_EXPIRES`.
3. Check the next run's log: no WARNING about the credentials.
4. Delete the old key in Odoo (Preferences → Account Security).

A rejected key fails the run with an ERROR naming `ODOO_DEBT_API_KEY`.

## 4. Running

```bash
cd 07ps-sales-dashboard-app/data/etl
python -m etl_platform.run finance_receivables --trigger-source manual
```

- **Schedule.** Daily at **06:30 Africa/Tripoli** (`departments/finance/jobs.py` `SCHEDULE`). The orchestration wires
  it in phase 6.
- **Dependencies.** It depends on `core_dims`, which is reused when it succeeded within `ETL_CORE_DIMS_FRESH_MINUTES`.
- **Re-runs.** A re-run on the same day replaces that day's snapshot in one transaction; nothing else changes.
- **Logged per run** (`etl_task_log.details`):
  - the API mode and Odoo version, and the credential profile used;
  - rows per `move_type`, and payment lines per `payment_type` / `partner_type` (rows, net);
  - `bridged_orders_not_in_fact_sales_orders` (information);
  - net open amount (with and without inter-company) and overdue amount;
  - salesperson source counts and skipped fields.

  Duration is in `etl_run_log`.
- **Freshness is per department.** The run is logged with `department = 'finance'`. The sales "Last Refresh" only
  reads sales runs, so a finance run never changes it.

**Checks, all in the load transaction.** A failure rolls back that day's snapshot.

| Check | When | Severity |
|---|---|---|
| every fact and invoice-dimension key exists in its dimension (`orphan:*`) | every run | fail |
| bridge: the invoiced order is in the full Odoo sale order list (`dim_sales_order`, every `sale.order` read by `sales_full`) | every run | **warn** |
| at least 1 row (`sanity:receivable_rows`) | from the 2nd snapshot | fail |
| no missing or unknown due date (`sanity:receivable_due_date*`) | from the 2nd snapshot | fail |
| net open amount within ±50% of the previous snapshot (`sanity:receivable_open_amount_change`) | from the 2nd snapshot | fail; `--allow-large-change` turns it into a warning for one run |

## 5. History, past dates and backfill

Snapshots start with the first run (2026-10-04); history builds up one day at a time.

`--date YYYY-MM-DD` only **labels** the snapshot. Odoo is always read as it is now, so a past date would hold today's
open items aged as of that date. The job logs a WARNING and sets `snapshot_is_today = false` in the run details. Use
`--date` only to re-run today after midnight, never to "rebuild" the past.

**A backfill could be done later.** The residual of each receivable line *as of date D* is its amount minus the
reconciliations up to D (`account.partial.reconcile` with `max_date <= D`). That is how Odoo's Aged Receivable
computes a past date.

1. Read the receivable lines posted on or before D.
2. Read their `account.partial.reconcile` rows with `max_date <= D`.
3. Compute the residual at D.
4. Drop the lines with a zero residual.
5. Load the rows with the same transform, `SnapshotDateKey = D`.

This needs read access to `account.partial.reconcile`, which is covered by Accounting read-only. Validate each
backfilled date against the Aged Receivable report for D.

## 6. Validation against Odoo's Aged Receivable

1. In Odoo: Accounting → Reporting → Aged Receivable. Set **At** = the snapshot date, pick one company and the
   posted entries only (the default), and export to XLSX.
2. Run the comparison:

   ```bash
   python scripts/finance/compare_aged_receivable.py EXPORT.xlsx --company 1 --date 2026-10-04 --out <dir>
   ```

3. It re-ages the snapshot into Odoo's columns (Not due, 1-30, 31-60, 61-90, 91-120, Older), matches customers by
   name, and lists every customer whose figures differ, as well as customers present on one side only. Inter-company
   rows are included because the report includes them.
4. Explain differences before changing any logic. Usual causes:
   - a different "At" date or company;
   - lines on a contact rather than the commercial partner (name mismatch);
   - unposted entries included in the report;
   - partners the ETL user cannot read: these appear as Unknown here.

## 7. Known points (snapshot of 2026-10-04, run `17107826`)

- **Volume.** 17,634 open lines, net 53,477,866.99.
  - By `move_type`: `out_invoice` 2,295, `out_refund` 484, `entry` 14,855.
  - Of the entries, 7,341 are payment lines: Send / Customer 6,643 (+53,657,983.84); Receive / Customer 695
    (−8,295,525.19); Send / Vendor 3 (+21,760.00).
- **Outbound customer payments.** These are mostly personal withdrawals, salaries, custody and inter-company balances
  posted against partners. Finance review: `docs/finance_outbound_payments_review.md`. Totals are Odoo's, unchanged.
- **A posting during an extraction can be missed.** On 2026-10-04 the Tika invoice INV/2026/10/0105 (line 1472248,
  160.00) was created at 16:31:10 UTC and posted at 16:31:27 UTC, during the extraction (16:29:03–16:34:21 UTC).
  - The line read had already passed its id range: the highest id read was 1472171, and the read finished at
    16:33:19 UTC. Odoo's `create_date`/`write_date` are transaction-start times, so its commit came after the page
    holding it was read.
  - It is in the domain and readable: no domain or record-rule exclusion. Every other partner matched Odoo exactly,
    so no row was skipped by paging.
  - The next snapshot includes it. Phase 6 adds an end-of-extraction recount, which reports any such difference.
- **Unknown customer.** One partner (id 3575, 72 lines, −1,390.00) is not readable by the ETL user. 42 lines (−66,279.38)
  have no partner. Both go to customer `-1`.
- **Salesperson fallbacks.** 1,868 lines have an invoice user that is not in `OdooUsers`. 5,186 lines have no
  salesperson at all (`salesperson_source = none`).
