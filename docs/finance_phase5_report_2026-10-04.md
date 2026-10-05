# Phase 5 report — finance receivables (Debt report), 2026-10-04

Branch `feature/debt-receivables-etl`, worktree `07PREPORT-etl`. Nothing committed. Runbook:
`docs/receivables-etl.md`.

## Status

| Item | Result |
|---|---|
| Migrations `0032_core_odoo_labels.sql` + `0033_finance_receivables.sql` (finance renumbered, section 7) | applied to `powerBI_Data`; down + re-apply (twice) verified |
| Job `finance_receivables` (department `finance`) | live run **success**: run `e7ec684b`, 509 s including a fresh `core_dims` |
| Snapshot 2026-10-04 | **17,628 rows**, net open **53,448,991.99**, overdue **46,974,739.39** |
| Orphan checks (fact, invoice dimension, bridge → invoice) | all **pass** |
| Bridge check (invoiced order in `fact_sales_orders`) | **warn**: 762 links / 742 orders (section 4) |
| Sanity checks | not run: they apply from the second snapshot |
| Completeness vs Odoo (`read_group` on the same lines, per company + partner) | **matches** on 1,662 of 1,663 partners. The exception is one 160.00 Tika line missing from the snapshot (section 3) |
| Aged Receivable comparison | **waiting for your export**. The script is ready: `scripts/finance/compare_aged_receivable.py` |
| Sales "Last Refresh" unaffected | **pass**: still the sales run (11:26 UTC); finance is logged as `department = 'finance'` |
| Credentials | default read-only ETL credentials + WARNING on every run (`ODOO_DEBT_*` not set yet); switching is config-only |
| Tests | ETL 378 passed (+30 finance tests); the only failure is the old `test_input_check`. Backend 428 passed |

## 1. What was built

- **Code:** `departments/finance/` holds `aging.py` (the 8 buckets, the one place they are defined), `transform.py`
  (pure rules) and `jobs.py` (extract, load, checks).
- **Tables:** `raw_odoo_account_move_line`, `raw_odoo_account_move`, `raw_odoo_sale_order_invoice`,
  `dim_finance_aging_bucket`, `dim_finance_invoice`, `bridge_finance_invoice_order` and
  `fact_finance_receivable_snapshot`.
  - The fact's keys: `SnapshotDateKey`, `DueDateKey`, `InvoiceDateKey`, `CustomerKey`, `CompanyKey`,
    `SalespersonKey`, `SalesTeamKey`, `CurrencyKey`, `PaymentTermKey`, `AgingBucketKey`, plus `move_id`.
  - Measures: `residual_company_ccy`, `residual_doc_ccy`, `days_past_due`.
  - Also `delivery_status`, `is_intercompany` and `salesperson_source`.
- **Views:** `v_finance_receivable_latest`, `v_finance_customer_exposure` (credit limit from `dim_customer_company`;
  `sales_last_90d` and DSO from `fact_sales_lines` on `CustomerKey` + `CompanyKey`) and `v_finance_receivable_trend`.
  All three exclude inter-company rows.
- **Core reuse:** `dim_payment_term` (with `max_days`, `is_instalment`), `dim_currency`, `dim_customer`,
  `dim_customer_company`, `dim_salesperson`, `dim_sales_team`, `dim_company` and `dim_date`.
- **Tests:**
  - an instalment invoice, aged per instalment and never by the last due date;
  - a credit note due today (not overdue, negative);
  - a foreign-currency unapplied payment (no maturity → line date; both currencies);
  - an invoice with no sales order;
  - inter-company;
  - aging boundaries at −61/−60/−31/−30/−16/−15/0/1/30/31/60/61/90/91;
  - a same-day re-run that replaces the day;
  - the second snapshot running the sanity checks, where a large change fails and rolls back;
  - the debt credential profile being picked up once configured;
  - the Aged Receivable parser and comparison.

## 2. First snapshot (2026-10-04)

| Document type | Majaal rows | Majaal net | Tika rows | Tika net |
|---|---|---|---|---|
| Invoice | 1,438 | 18,798,593.63 | 852 | 16,987,710.68 |
| Credit Note | 456 | −899,089.39 | 27 | −257,405.00 |
| Unapplied Payment | 5,994 | 38,638,704.84 | 1,347 | 6,745,513.81 |
| Journal Entry | 4,675 | −23,024,557.15 | 2,839 | −3,540,479.44 |

| Bucket | Rows | Net |
|---|---|---|
| Not due 60+ | 21 | 780,720.00 |
| Not due 31-60 | 72 | 2,223,406.00 |
| Not due 16-30 | 112 | 1,936,186.60 |
| Not due 0-15 | 155 | 1,533,940.00 |
| Overdue 1-30 | 794 | 7,223,366.98 |
| Overdue 31-60 | 1,123 | 8,885,977.41 |
| Overdue 61-90 | 520 | 5,697,632.59 |
| Overdue 90+ | 14,831 | 25,167,762.41 |

- **Due dates.** 7,695 lines have no `date_maturity` (payments, journal entries) and are aged by the invoice due
  date, then the line date. No row lacks a due date.
- **Salesperson source.**
  - Invoice user: 11,842 rows (40.0M).
  - Customer of record: 600 rows (2.6M).
  - None: 5,186 rows (10.8M), mostly journal entries and payments of customers with no salesperson.
- **Inter-company.** 0 rows. No open receivable has Majaal's or Tika's own partner as the customer. The flag and
  the view filter are tested.

## 3. Reconciliation so far

**Odoo's own totals.** `read_group` sums the same open receivable lines per company and partner. Read right after
the run:

| Company | Lines (Odoo / snapshot) | Residual (Odoo / snapshot) |
|---|---|---|
| Majaal | 12,563 / 12,563 | 33,513,651.93 / 33,513,651.93 |
| Tika | 5,066 / 5,065 | 19,935,500.06 / 19,935,340.06 |

The one difference is a single Tika line of 160.00 for partner 19503 that is not in the snapshot. Odoo was read
again after the snapshot run, so the likeliest explanation is that the line was posted or changed in between. Its
creation time has not been checked.

**Aged Receivable.** Pending your export for 2026-10-04, per company. Run it with:

```bash
python scripts/finance/compare_aged_receivable.py EXPORT.xlsx --company 1 --date 2026-10-04 --out <dir>
```

Every differing customer will be explained. The script uses Odoo's columns: Not due, 1-30, 31-60, 61-90, 91-120,
Older. A same-day export avoids the timing effect above.

## 4. Findings that need your decision

1. **"Unapplied Payment" mixes two kinds of payment.** Of 7,341 payment lines:
   - 695 are *inbound* customer payments (−8,295,525.19): true unapplied payments;
   - 6,640 are *outbound* customer payments (+53,704,808.88), mostly from the salespeople's cash journals
     ("Cash - …");
   - the rest are 3 outbound customer payments (−46,825.04) and 3 outbound supplier payments (+21,760.00).

   Odoo counts the outbound ones as amounts customers owe, so totals are right either way. But the label would
   mislead the Debt page.
   - **Proposed:** keep "Unapplied Payment" for inbound, and use **"Outbound Payment"** for outbound.
   - Your call. I have not changed the spec's mapping.
2. **Team when the invoice has no team.** Implemented as the salesperson's effective team, as for sales lines and
   orders, so payments, which have no team, net against their salesperson's invoices. The alternative is Unknown.
   Please confirm.
3. **Salesperson fallback.** The invoice user, else the customer's salesperson of record (the spec's
   `partner.user_id` rule, through `OdooUsers`). `salesperson_source` records which one was used. Please confirm.
4. **Bridge warning.** 762 invoice → order links point to 742 orders that are not in `fact_sales_orders`:
   - 758 are in `dim_sales_order` and `fact_sales_documents`;
   - 671 are confirmed orders the legacy logic does not count as "real sales orders" (`IsRealSalesOrder = 0`);
   - 86 are real sales orders not in the orders fact;
   - 1 is a quotation, and 4 links are to orders not in the sales extraction.

   This is a property of the legacy orders fact, not an error. The check stays a warning; checking against
   `dim_sales_order` instead would be cleaner, if you prefer.
5. **Unknown customer.** One partner (id 3575: 72 lines, −1,390.00) is not readable by the ETL user. It is the same
   partner as in the sales deliveries. 42 lines (−66,279.38) have no partner. Both sit on customer `-1`. The bot
   user's access (Contacts read, both companies) should be checked against partner 3575.
6. **Salesperson fallbacks.** 1,868 lines have an invoice user not in `OdooUsers`: users 8, 10, 18, 26, 45, 87, 110
   and others. Several are in `docs/odoo_user_second_accounts_review.csv`; the rest can be added to that review.

## 5. Phase 4 follow-ups done

- **Report.** `regression_report_2026-10-04.md` now records the approvals. Section 4b states exactly which measures
  see cancelled documents:
  - 76 of the BIM documents are used by no measure;
  - 8 cancelled *real* quotations (63,859.00) count in the pipeline-trend quotation figures for 2023–24, as a
    salesperson split only;
  - no reported total changes;
  - the pipeline "quotation value" includes cancelled real quotations in general: 459 documents, 16.48M, the legacy
    behaviour. Changing that is your call.
- **Dropped:** `zz_baseline_*` (22) and `zz_regression_window`.
- **Kept:** `zz_legacy_*` (34) and the Oct 1 dump. Retiring `zz_legacy_*` is migration **0033** in the plan; 0032 is
  finance.
- **Review file:** `docs/odoo_user_second_accounts_review.csv`.
  - All four users are archived in Odoo and have **no sales orders** (order value 0.00).
  - Their weight is in CRM only: 70 leads/opportunities, 2.61M expected revenue.
  - RAMAD (user 10) has two candidates: Abdelrahman Ramad (4) and Mohamed Ramadan (45).
- **User 19:** left alone.

## 6. Not done in Phase 5

These belong to Phase 6:

- wiring the 06:30 schedule into the orchestration (the job carries `SCHEDULE`);
- per-department freshness in the app;
- the backend endpoints for the Debt page.

## 7. Follow-up round (decisions of 2026-10-04)

**Odoo labels everywhere (done).**

- New core dimension `dim_odoo_selection_label` (migration 0032), loaded by `core_dims` with `fields_get`.
  - Arabic (`ar_001`) is active, so both `label_en` and `label_ar` are stored: 47 values over `account.move`,
    `account.payment`, `sale.order`, `stock.picking` and `crm.lead`.
  - Surrounding spaces in some Arabic translations are trimmed.
- The finance fact keeps keys and technical values only.
  - `document_type` is gone; `PaymentKey` was added.
  - The new `dim_finance_payment` holds `payment_type`, `partner_type`, `state`, the journal name in en/ar, and the memo.
  - Delivery status now holds Odoo's own values (`full` / `partial` / `pending`; NULL plus `has_sales_order = 0`
    when there is no order).
- `v_finance_receivable_latest` shows Odoo's labels: `move_type`; `payment_type` + `partner_type` + journal for
  payments; `payment_state`; `delivery_status`; all in English and Arabic.
- The rule is written in `docs/adding-a-department.md` ("Odoo labels").
- Because the finance views need the label table, migrations were renumbered: 0032 labels, 0033 finance, 0034
  retire. The finance objects were dropped and re-created; the snapshot of 2026-10-04 was reloaded (run `17107826`:
  17,634 rows, net 53,477,866.99).
- **Sales still has legacy labels written in code** (not changed; they feed pages). For Phase 6:
  - `v_sales_deliveries.DeliveryStatus` ("Fully Delivered", …);
  - `v_sales_documents.SalesDocumentType` ("Quotation" / "Sales Order");
  - `v_sales_leads.LeadType` ("Systematic").

  Every other sales state column already holds Odoo's technical value.

**Decisions 2 and 3.** Confirmed and unchanged.

**Decision 4: bridge check.**

- The bridge is now validated as a warning against the full Odoo sale order list: `dim_sales_order`, every
  `sale.order` read by `sales_full`, unfiltered. The platform keeps no separate raw sale order table; this dimension is
  that list.
- First run: 6 bridged orders (ids 83249–83269) are not in it yet. They were created after the afternoon sales run;
  the next sales run picks them up.
- For information, the run details carry `bridged_orders_not_in_fact_sales_orders` (the legacy "real sales order"
  rule).

**Decision 5: unknown customers.** The `-1` fallback is kept.

- Partner 3575 is noted in the runbook: it should become readable once the bot user has both companies.
- The 42 lines without a partner are listed in `finance_outbound_payments_review.md` section 9 and in
  `finance_receivable_lines_without_partner.csv`.

**The 160.00 Tika line is explained.** Invoice INV/2026/10/0105 (line 1472248) was created at 16:31:10 UTC and posted
at 16:31:27 UTC, during the extraction (16:29:03–16:34:21 UTC).

- The line read had already passed its id range: the highest id read was 1472171, and the read finished at
  16:33:19 UTC.
- Odoo stamps `create_date`/`write_date` at transaction start, so the commit came later.
- It matches the domain and is readable: no domain or record-rule exclusion.
- Every other partner matched exactly, so no paging skip.
- Phase 6 adds an end-of-extraction recount, so this kind of difference is reported automatically.

**Outbound payments review.** `docs/finance_outbound_payments_review.md` (+ CSV).

- 6,643 Send / Customer payment lines (+53,657,983.84) are mostly personal withdrawals (28.7%), salaries (14.0%),
  project and custody advances, and inter-company balances, posted against staff, owner and custody partners.
- 47 (1.27M) have a matching unreconciled inbound payment within ±7 days.
- The partners مديونية شركة تيكا / مديونية مجال are inter-company balances that `is_intercompany` does not catch (they
  are not the companies' own partners). A configurable list is proposed.

**Cancelled quotations leave the pipeline.** Done in the backend (`excludeCancelledDocumentsClause`). Documented as an
intended change in `regression_report_2026-10-04.md` section 9: 2026 YTD trend quotations −36 documents / −59,735.00.

**Still waiting:**

- the Aged Receivable exports (2026-10-04, per company); the comparison runs as soon as they arrive;
- your answers in `odoo_user_second_accounts_review.csv` (`OdooUsers` unchanged).
