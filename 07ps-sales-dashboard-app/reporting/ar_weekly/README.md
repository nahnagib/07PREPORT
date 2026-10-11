# Weekly Sales Collection & Aging Report (live from Odoo)

One report per salesperson every week, read live from Odoo through the API:

- KPI cards: outstanding, overdue, not due, debtors, invoices, overdue ratio, plus unapplied credits
- overdue aging in 5 buckets (1–15, 16–30, 31–60, 61–90, 90+ days) with risk level and action
- the weekly collection tracker (Sunday → Saturday) against the prior week, with a 4-week trend
- the priority invoice list, client exposure, invoices about to move into a worse bucket, invoices falling due next week
- recommendations computed from the figures

Each run writes an **HTML report** (also used as the email body) and an **Excel workbook** per salesperson, and a
team summary. Optionally it emails each salesperson their own report. The tool **only reads** from Odoo: any call
that is not a read is blocked in code.

```
reporting/ar_weekly/
  ar_weekly.py        entry point (python ar_weekly.py --help)
  config.ini          settings (no secrets)
  odoo_api.py         read-only XML-RPC client (Odoo 14–18; production is 17)
  extract.py          reads receivable lines, reconciliations, invoices, payments, partners, users
  engine.py           all the calculations (no Odoo calls, unit-tested)
  render_html.py      HTML report + team summary
  render_excel.py     Excel workbooks
  mailer.py           optional email (SMTP)
  demo_odoo.py        sample data, for --demo and the tests
  tests/test_report.py
  setup.cmd  run_weekly.cmd  install_schedule.cmd
```

## 1. Set up (once)

Python 3.10 or newer must be installed. In this folder, double-click **`setup.cmd`** or run it from a terminal. It
creates `.venv` and installs pandas and openpyxl.

## 2. Odoo credentials

Nothing new is needed: the tool reads the ETL's `07ps-sales-dashboard-app/data/etl/.env` (`ODOO_URL`, `ODOO_DB`,
`ODOO_USER`, `ODOO_API_KEY`). When the finance bot user exists (`ODOO_DEBT_LOGIN` / `ODOO_DEBT_API_KEY`, see
`docs/receivables-etl.md` §3) it uses that one automatically.

To use other credentials, create a `.env` file **in this folder** (it is read first and is git-ignored):

```
ODOO_URL=https://yourcompany.odoo.com
ODOO_DB=yourcompany-production
ODOO_USER=bot@yourcompany.ly
ODOO_API_KEY=xxxxxxxx
```

The API user needs **Accounting: Read-only** (it reads `account.move.line`, `account.partial.reconcile`,
`account.move`, `account.payment`, `account.journal`) and read access to contacts and users, for companies 1 and 3.

Test the connection:

```
run_weekly.cmd --check
```

## 3. Run

```
run_weekly.cmd                         last completed week (ending Saturday), every salesperson
run_weekly.cmd --rep Marwan            one salesperson (name contains, or the Odoo user id)
run_weekly.cmd --as-of 2026-10-03      a specific week end; past weeks can be produced at any time
run_weekly.cmd --demo                  sample data, no Odoo needed
```

Output goes to `output/<week-end date>/`:

- `AR_Weekly_<name>_<currency>_<date>.html` and `.xlsx`
- `AR_Weekly_TEAM_<date>.html` and `.xlsx`

`output/kpi_history.csv` keeps one row per salesperson per week, which you can use for trend charts or Power BI.
Logs are in `logs/`.

## 4. Email (optional)

**Who gets what** is set in **`07PREPORT\Input\AR_Report_Recipients.xlsx`**, one row per salesperson:

| Column | What to enter |
|---|---|
| Odoo User ID | Already filled. This is how the row is matched to Odoo (the most reliable way). |
| Salesperson Name (Odoo) | Already filled. If you add a row without an ID, the name must match the Odoo user name. Spaces and upper/lower case are ignored. |
| **Email** | Where the report goes. For several addresses, separate them with commas. |
| CC | Optional, e.g. the team leader. |
| **Send Report** | Yes or No. With No, the report is still produced in `output\`, just not emailed. |
| Weekly Target | Optional fixed weekly collection target for that person. When empty, the target is 20% of their starting overdue. |
| Team, Odoo Email (reference) | For your information only. These are never used to send. |

The **Team Summary** sheet lists the managers who receive the summary of all salespeople.

- **Create the file:** `run_weekly.cmd --make-recipients` creates it from `Input\SalesTeam.xlsx`. It is already created.
- **Add new salespeople:** `run_weekly.cmd --update-recipients` appends every salesperson who has debt in Odoo and is
  missing from the file. It also fills in their Odoo email as a reference. It never changes your existing rows.
- **Close the file in Excel before a run.** Excel locks it while it's open.

**To turn email on:**

1. Fill the `SMTP_*` settings in the `.env` file (the same names the dashboard uses).
2. In `config.ini`, under `[email]`, set `enabled = true`.
3. Check the plan without sending anything:

   ```
   run_weekly.cmd --dry-run-email
   ```

   The log ends with an *Email plan*: each salesperson with the address their report goes to, or the reason it won't
   be sent (not in the file, Send = No, no email).

4. Send for real with `run_weekly.cmd --send`.

## 5. Schedule it weekly

Run **`install_schedule.cmd`** once. It creates the Windows task *07PREPORT\AR Weekly Report*, which runs every
**Sunday at 07:30** for the week that ended on Saturday, with `--send` (emails go out only if `[email] enabled = true`).

- **Run it now to test:** `schtasks /Run /TN "07PREPORT\AR Weekly Report"`
- **Change the day or time:** edit `/D` and `/ST` in `install_schedule.cmd` and run it again.
- **Run it while you are signed out:** open Task Scheduler, open the task, and choose *Run whether user is logged on
  or not*. The PC must be on at that time.
- **Run it on a server:** schedule `python ar_weekly.py --send` there instead, using cron or the dashboard's job
  scheduler.

## 6. How the figures are computed

These are the same rules as the Debt Report (`docs/receivables-etl.md`), so the two agree.

| Item | Rule |
|---|---|
| Debt | Open **customer receivable lines**: customer invoices, credit notes and receipts, and inbound customer payments. Instalments age separately, each by its own `date_maturity`. |
| Due date | `date_maturity`, else the invoice due date, else the line date. |
| Days overdue | Week-end date − due date. **Due today is not overdue.** |
| Outstanding / overdue / not due | Open invoice lines only (positive balances). |
| Unapplied credits | Payments and credit notes not yet matched to an invoice. **Net = outstanding + unapplied credits**, which is the Debt Report figure. |
| Customer | The commercial partner (a contact's lines count under its company). |
| Salesperson | The invoice's salesperson (`invoice_user_id`), else the customer's salesperson. Names come from `Input/SalesTeam.xlsx` when the person is mapped there. |
| Left out | Inter-company customers (own companies plus `intercompany_partner_ids`), teams in the *Backoffice* / *Inter Company* segments, and the excluded team names. These are all set in `config.ini`. |
| Currency | Each currency is reported separately and is never converted. |
| Past balances | Today's open balance plus every reconciliation made after that date. This is how Odoo's Aged Receivable rebuilds a past date, so any past week can be re-run. |
| Collected | Bank or cash payments reconciled during the week to invoices that were **already overdue at the start of the week**. Payments on not-yet-due invoices are shown separately as *total cash collected*. |
| Collection rate | Collected ÷ starting overdue. |
| New overdue | Invoices that crossed their due date during the week, at their week-end balance. |
| Check | Start − collected − credit notes − other settlements + new overdue = end. The report shows ✔ when this holds. |
| Weekly target | 20% of the starting overdue (`weekly_target_pct_of_overdue`), or a fixed amount per person under `[targets]`. |

**Limits.**

- A payment that is in Odoo but not yet matched to an invoice does not count as *collected* until Finance reconciles
  it. It shows under *Unapplied credits*.
- A reconciliation that is undone later, or an entry backdated into a closed week, changes that week's figures on a
  re-run. This is the same as in Odoo's own report.

## 7. Tests

```
.venv\Scripts\python.exe tests\test_report.py
```

The tests check three things on the sample data:

- rebuilt past balances equal the true history;
- every week reconciles to zero;
- the KPIs add up, and the scope rules (inter-company, excluded teams, outbound payments, currencies) hold.

## 8. Troubleshooting

| Message | Fix |
|---|---|
| `Odoo rejected the login or API key` | The key expired or was revoked. Create a new one in Odoo (Preferences → Account Security). |
| `Access Denied` / `not allowed to access` on a model | Give the API user Accounting read-only for both companies. |
| `Sales team file not found` | Check `sales_team_file` in `config.ini`. Without the file, only team names are excluded, not whole segments. |
| `Could not read ... SalesTeam.xlsx` | The file is open in Excel with a lock. Close it and run again. |
| A salesperson is missing | They have no open debt and no activity that week, or their team is excluded. Run with `-v` to see the extract counts. |
