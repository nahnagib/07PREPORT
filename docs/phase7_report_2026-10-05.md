# Phase 7 report: Debt Report page (Finance), transfer to 07PREPORT, pre-deploy package (2026-10-05)

All work is in **`C:/Users/Lenovo/Desktop/07PREPORT` on `main` (`f67644d`), uncommitted**.

- Nothing was committed or pushed, and nothing was deployed.
- Odoo was only read. `etl-worker` and `etl-api` stay stopped, and no container was touched.
- `07PREPORT-ppl` was changed by the one authorised command only (`switch --detach`).
- **Phase 8 plan:** `docs/deployment-plan.md`, with a line-by-line checklist in §4.

## 1. Transfer of Phases 1–6 into 07PREPORT

| Step | Result |
|---|---|
| Branch map | `main` was checked out in `07PREPORT-ppl`. I stopped and reported; you chose option (a) |
| Release `main` | `git -C ../07PREPORT-ppl switch --detach main`: HEAD `f67644d` before and after, status clean before and after, now "detached HEAD" |
| Backup of `07PREPORT` | `~/etl-rebuild-backups/07PREPORT_before_transfer_20261004-2216/` (tracked diff, untracked tarball, `Input.tar.gz`, per-file checksums) |
| `git switch main` | HEAD = `f67644d`. Your `launch.json` / `tachometer.ts` edits and the three Input workbooks are byte-identical to the backup. The untracked `docs/product_pages_audit.md` was identical to `main`'s, so it was moved into the backup |
| Worktree patch | `git apply --check` was clean for 55 files (all but `etl_run_log.py`), then applied. 100 untracked files copied and byte-verified |
| `git diff --stat` | the same content as the worktree. 41 files differ only in line endings (CRLF there, LF here; `core.autocrlf=true` normalises them on commit) |
| Branches | `feature/kaizen-board` and `feature/product-pages-live` deleted with `git branch -d`. `feature/debt-receivables-etl` and `07PREPORT-etl` kept as a backup until you approve |
| Backup of the result | `~/etl-rebuild-backups/20261004-2239_transfer.{patch,_untracked.tar.gz,_untracked.list,SHA256SUMS.txt}`. Secrets scan: only the `CHANGE_ME` placeholders |

**Final state:**

```
git branch -vv
+ feature/debt-receivables-etl aa48123 (C:/Users/Lenovo/Desktop/07PREPORT-etl) Kaizen - product dashboards
* main                         f67644d [origin/main] CI: Linux rollup binary in the lockfile; race-safe etl_run_log table creation
git worktree list
C:/Users/Lenovo/Desktop/07PREPORT     f67644d [main]
C:/Users/Lenovo/Desktop/07PREPORT-etl aa48123 [feature/debt-receivables-etl]
C:/Users/Lenovo/Desktop/07PREPORT-ppl f67644d (detached HEAD)
```

### 1.1 Hand-merge of `etl_run_log.py`

The two sides made the **same** fix: race-safe `ensure_table`, the same `inspect` import and the same `has_table`
re-check. They differ only in the exception caught. Neither side touches the department/mode columns or the task log
(those live in `etl_platform/meta.py` and migration 0028). There was no conflict in meaning.

```diff
 f67644d (kept)                                          worktree (dropped, equivalent)
-from sqlalchemy.exc import OperationalError, ProgrammingError    +from sqlalchemy.exc import DBAPIError
-        except (OperationalError, ProgrammingError):              +        except DBAPIError:
             if not inspect(self.engine).has_table(TABLE_NAME):         if not inspect(self.engine).has_table(TABLE_NAME):
                 raise                                                       raise
```

**Merged result:** `main`'s version is kept unchanged, so `etl_run_log.py` has **no diff** against `main`. The
worktree's two new tests both pass against it:

- `test_ensure_table_tolerates_a_concurrent_create`;
- `test_ensure_table_still_raises_real_errors`.

`test_etl_run_log.py`: 16 passed, 3 runs out of 3.

### 1.2 Input workbooks

The ETL reads `07PREPORT/Input`: `ETL_INPUT_DIR` for local runs, and the compose mount `ETL_INPUT_HOST_DIR` in
production. The staging folder is no longer used; its last mention in a script's usage text was replaced.

| Workbook | Changed by staging? | `07PREPORT/Input` changed since the Oct 1 copy? | Action |
|---|---|---|---|
| BlockedCustomers | yes | no | staging version copied in |
| OffDays | yes | no | staging version copied in |
| PRODUCTS | yes | no (your uncommitted edit predates the copy, so staging contains it) | staging version copied in |
| SalesTeam | yes | **yes, Oct 4 12:24** | **key columns and sheets only**, merged onto your file |
| sales_targets | yes | **yes, Oct 4 12:16** | **key columns only**, merged onto your file |
| KaizenData, MARCOM template | no | – | untouched |

**What the merge kept (your Oct 4 edits, unchanged):**

- **Real people instead of placeholders:**
  - Saleh Alabeedi replaces "SalesPerson 2";
  - Mohamed Ramadan, Mohammed Alabed and Yousef Salim have targets.
- **"Sales Person 2"** removed from the org sheet. No Odoo user maps to its old key 81.
- **96 revised targets.**
- **Hussian Makey** moved to TK-WST-BB / Wholesales.
- **Blank team/status** for Abdala Baitelmal, Anas Alshlmany and Mohamed Qataf.

**What the merge added:**

- the sheets OdooUsers, OdooTeams, channel and segment;
- on the salesperson sheet: `SalespersonKey` by name, `ChannelKey` from your DistributionChannel, and 9 Odoo-only
  salespeople appended as Inactive rows (their keys are referenced by OdooUsers);
- on the salesteam sheet: `CompanyKey` / `SegmentKey`;
- on the targets sheet: `SalespersonKey` by name and `CompanyKey` by company.

**Checks:**

- No cell of yours was changed.
- Every sheet passes the ETL schemas.
- No duplicate keys; no orphan key in OdooUsers or the targets; every target row has a SalespersonKey.

**To check at the first `core_dims` run (Phase 8, step 7):**

- the three people whose team you blanked fall back to Unknown;
- Saleh Alabeedi, Mohamed Ramadan and Mohammed Alabed are now active.

### 1.3 Verification in 07PREPORT

| Check | Result |
|---|---|
| ETL `pytest` (incl. `api/tests`) | after the transfer: 381 passed, 1 skipped, plus the known `test_input_check` failure, the same as the worktree |
| Backend `vitest` / `tsc` | 432 passed (96 skipped) / clean, the same as the worktree |
| Frontend `tsc` | clean |
| `platform_selfcheck` from 07PREPORT | database reachable (MySQL 8.0.46); Odoo read-only (17.0+e); input folder `07PREPORT/Input` |

## 2. Decision A1: inter-company partners

**Config, not code:** `FINANCE_INTERCOMPANY_PARTNER_IDS` (Odoo partner ids) in `etl_platform/config.py`, added to
the three ETL env examples. The finance job resolves the ids to the commercial partner, flags their lines
`is_intercompany = 1`, and records the configured ids and names in every run's details.

| Odoo partner id | Name | Books | Lines (customer debt / other) | Open amount |
|---|---|---|---|---|
| **15907** | مديونية شركة تيكا | Majaal | 21 / 296 | −993,845.00 / +2,725,502.41 |
| **15905** | مديونية مجال | Tika | 4 / 233 | −171,800.00 / −1,188,015.97 |

**Please confirm both.**

**Re-flagged today's snapshot.** I re-ran `finance_receivables` for 2026-10-04 (22:49 local; 17,624 lines). The
end-of-extraction recount found nothing posted during the read. 554 lines are now inter-company (before: 0).

- `core_dims` was deliberately **not** re-run: its 17:01 run was reused (`ETL_CORE_DIMS_FRESH_MINUTES=720`).
- Re-running it would have pushed your new Input edits into the production dimensions ahead of Phase 8.

**Two more candidates, not flagged.** Group company Athena (company 9) has the same kind of partner:

- **9651 مديونية شركة اثينا**: Majaal, 26 lines, 88,609.50;
- **16388 مديونية اثينا**: Tika, 2 lines, −3,100.00.

Add `9651,16388` to the setting if you agree.

## 3. Decision A2: receivable scope, with numbers

**Rules.** `departments/finance/scope.py` (next to `aging.py`) is the one place they live, and it uses Odoo's
technical values:

- `customer_debt`: `out_invoice`, `out_refund`, `out_receipt`, and payments `inbound` / `customer`;
- `other_receivable`: everything else (outbound customer payments, journal entries without an invoice, vendor
  payments).

The labels (en + ar) and `is_default` are in `dim_finance_receivable_scope`.

**Migration 0034 (applied).** Down script verified, then re-applied twice (idempotent). It adds:

- the fact column and its index;
- the backfill of earlier rows;
- `v_finance_receivable_line`;
- the three default views, which now show customer debt without inter-company;
- the page grants.

**Snapshot 2026-10-04 (re-flagged), LYD, company currency:**

| Company | Scope | Inter-company | Lines | Open (net) | Overdue |
|---|---|---|---|---|---|
| Majaal | customer debt | no | 2,397 | **12,242,900.20** | 11,064,669.60 |
| Majaal | customer debt | yes | 21 | −993,845.00 | −993,845.00 |
| Majaal | other receivable | no | 9,848 | 19,521,454.33 | 19,520,544.33 |
| Majaal | other receivable | yes | 296 | 2,725,502.41 | 2,725,502.41 |
| Tika | customer debt | no | 1,042 | **15,228,674.53** | 9,922,607.53 |
| Tika | customer debt | yes | 4 | −171,800.00 | −171,800.00 |
| Tika | other receivable | no | 3,783 | 6,055,766.49 | 6,046,516.49 |
| Tika | other receivable | yes | 233 | −1,188,015.97 | −1,188,015.97 |

**What the page shows by default, compared with Odoo:**

| | Lines | Open (net) | Overdue |
|---|---|---|---|
| **Debt page default** (customer debt, no inter-company) = `v_finance_receivable_latest` | 3,439 | **27,471,574.73** | **20,987,277.13** |
| + other receivable entries | 17,070 | 53,048,795.55 | |
| + inter-company | 3,464 | 26,305,929.73 | |
| **Every scope + inter-company** | **17,624** | **53,420,636.99** | |
| **Odoo, now** (`read_group` on the same domain, per company) | 12,562 + 5,062 | 33,496,011.93 + 19,924,625.06 = **53,420,636.99** | |

**Every scope equals Odoo exactly, line for line, per company.** Check it with
`scripts/finance/check_receivable_totals.py` (new; read-only), which prints MATCH. The page shows 51.4% of the
receivable balance by default; the rest is the other receivable entries (outbound customer payments: personal
withdrawals, salaries, custody) and inter-company.

## 4. Decision A3: Aged Receivable comparison

**Open.** The exports for 2026-10-04 have not arrived; nothing was found in Downloads, Input or Claude outputs. It
did not block the page.

When they arrive, run once per company:

```bash
python scripts/finance/compare_aged_receivable.py EXPORT.xlsx --company 1 --date 2026-10-04 --out <dir>
```

The script includes every scope and inter-company, like the report. The snapshot now carries the 22:49 state, so an
export taken after that is the cleanest comparison.

## 5. The Debt Report page

### 5.1 How it fits the app (discovery)

| Area | Pattern found | How the page uses it |
|---|---|---|
| Pages | `app/(departments)/<dept>/<page>/page.tsx`, a `PermissionGuard`, then `AppHeader` → `FilterBar` (`extraFields`) → `@07ps/ui` → `BottomNavBar` | the same: `/price/debt-report` |
| Navigation | `lib/navItems.ts` feeds the sidebar, bottom nav and department hubs | one entry, `department: 'price'`. The Price "Coming soon" placeholder is now a hub (`DepartmentHubPage`), like Product / Process. The label stays "Price" |
| Filters | `FilterProvider` serves the sales dimensions; product pages keep page-local state in `FilterBar` with `onReset` / `isPristine` | page-local state: the debt dimensions are not the sales ones. No new filter mechanism |
| Charts / tables | `GroupedBarChart` (horizontal), `ComboChart`, `ChartPanel` (expand to table), `KpiTile`, `DataGrid` | the same components; no new chart library |
| API | Express router chain `requireAuth → requirePasswordChangeCleared → requirePermission → attachUserContext → resolveScopedFilters` | the same chain on `/debt-report/*` |
| Freshness | Phase 6's `/meta/freshness?department=…` | `/debt-report/meta` returns the **finance** freshness; the page never shows the sales refresh |
| Permissions | the registry (`config/permissionRegistry.ts`), synced to `pages` / `permissions` at startup; Admin implicit | `debt_report` (View + Export), granted by migration 0034 |
| Salesperson scope | `applySalespersonLock`: forces the salesperson's own key; asking for another is a 403 | the same, enforced in every query |
| Export | `DataGrid` toolbar (CSV / Excel / PDF), authorised server-side by `POST /exports/authorize` | both tables export what is filtered and sorted |
| Language | **the app is English-only by design** (`c5c0a6c` removed the EN/AR switch); Arabic data is shown with `dir="auto"` | no app-wide switch was brought back. The page has an **"Odoo labels: English / العربية"** option for Odoo's own labels (document type, journal, delivery status), with Arabic from `dim_odoo_selection_label`. Our own UI text stays English. Say if you want more |
| Formats | en-GB; `formatCompactCurrency` for cards | cards are compact; tables and tooltips use the new `formatCurrencyFull` (LYD, 3 decimals; same locale helper) |
| Mobile | the sidebar collapses below 1024 px; `FilterBar` wraps | grids use `minmax(min(100%, …))`; tables scroll inside their container |

### 5.2 Access (role → grant)

Granted by migration 0034, with a down script. Each role keeps its existing data scope (`role_data_scope`).

| Database role (`role_name`) | Label | Tier | Debt Report | Data scope applied |
|---|---|---|---|---|
| ADMIN | Admin | BI00_EXECUTIVE | view, export (also implicit) | none |
| GCEO | GCEO | BI00_EXECUTIVE | view, export | none |
| GCFO | GCFO | BI00_EXECUTIVE | view, export | none |
| GCCO | GCCO | BI00_EXECUTIVE | view, export | none |
| GCTO | GCTO | BI00_EXECUTIVE | view, export | none |
| TIKA_CEO | Tika CEO | BI03_COMPANY_EXEC | view, export | **none.** The role has no company rule, so it sees both companies, the same as on every other page today. Add `companyKeys=3` on the Roles screen if it should see Tika only |
| B2B_DIRECTOR | B2B Director | BI01_DIRECTOR_B2B | view, export | `segmentKeys=1`: the line's sales team must be B2B (the sales-line rule). Lines with no team are not shown to this role |
| B2C_DIRECTOR | B2C Director | BI02_DIRECTOR_B2C | view, export | none (no rule exists for this role) |
| SALESPERSON | Salesperson | SALESPERSON | **not granted** | if an admin enables it: the lines whose `SalespersonKey` is their own, enforced in every query (incl. the 90-day sales behind DSO) |
| EXCELLENCE_MANAGER | Excellence Manager | – | not granted | – |

### 5.3 What the page shows

- **Filters:**
  - company (Both / Majaal / Tika, from the data);
  - snapshot date (the available snapshots; latest by default);
  - salesperson and team (Excel org);
  - customer (name or Odoo id);
  - overdue status, aging bucket, delivery status (Odoo values + "No sales order"), payment term, document type
    (Odoo labels);
  - invoice size and customer size (thresholds from the backend config, shown in the option labels);
  - the two scope toggles (off by default) and the Odoo-labels language.
- **KPIs:**
  - open debt (net);
  - overdue + % of open;
  - overdue documents;
  - customers with an overdue balance;
  - overdue 90+;
  - customers over their credit limit (**0: Odoo has no partner with a credit limit > 0 in either company**; the card
    says so);
  - change in overdue for 7d / 30d (shows "available from 11 Oct 2026 / 3 Nov 2026" until then).
- **Charts:**
  - overdue by customer (top 15, value + % in the tooltip);
  - by salesperson and by team (top 15 / all);
  - aging distribution (all 8 buckets in key order; not due in blue, overdue in red);
  - trend open vs overdue (with the "needs 2 snapshots" note).
- **Tables:**
  - customer exposure: every requested column, default sort overdue descending;
  - click a row to get the documents drill-down: every requested column, with the instalment's own due date, both
    residuals with currency, salesperson and its source, and an **Odoo link** (base URL from `ODOO_WEB_BASE_URL` /
    `ODOO_URL`, new tab).

### 5.4 Endpoints and timings

**Measured on `powerBI_Data` with today's volume** (17,624 lines in the snapshot): 20 HTTP requests per endpoint
through the local server, signed in as admin.

| Endpoint | Purpose | p50 | p95 |
|---|---|---|---|
| `GET /debt-report/meta` | snapshots, options, labels, tiers, Odoo base, finance freshness | 426 ms | 619 ms |
| `GET /debt-report/overview` (default) | KPIs + 4 charts | 389 ms | 489 ms |
| `GET /debt-report/overview` (every scope) | | 1,305 ms | 1,482 ms |
| `GET /debt-report/trend` | open vs overdue per snapshot | 276 ms | 377 ms |
| `GET /debt-report/customers` (default) | exposure table | 483 ms | 596 ms |
| `GET /debt-report/customers` (every scope) | | 1,507 ms | **1,580 ms** (slowest) |
| `GET /debt-report/documents?customerKey=…` | drill-down | 9 ms | 24 ms |

**Every endpoint is under 2 s at p95.**

- **First version.** It read the 16-join line view three times per query (lines, document tiers, customer tiers).
  The default overview took 3.9 s and every scope took 11.9 s.
- **Final version.** The measures read one slim, single-pass source on the fact table (only the joins the filters
  need). The size tiers are window sums in the same pass, and the overview aggregates its rows once in Node.
- **No new index or summary table was needed.** 0034 adds `ix_ffrs_scope`.
- **Consistency.** The definitions are those of `v_finance_receivable_line`; the DB-backed tests check that both
  agree.

## 6. Local logged-in run and screenshots

**How it ran:**

- **Servers.** The read-only page server (`backend/scripts/page_server.ts`: GET only, plus the export check; no
  registry sync, no schedules) on `127.0.0.1:4500`, against `powerBI_Data`. The 07PREPORT frontend dev server on
  `:3500`.
- **Sign-in.** Tokens were signed with a random test secret made for this run (not the production one). No password
  was entered.
- **Screenshots.** Headless Edge with a throwaway profile, full page, dark theme.

**Screenshots:** `~/etl-rebuild-backups/phase7_screens/`

| File | What it shows |
|---|---|
| `admin_desktop_EN_default.png` | 1440 px, defaults: 27.5M open / 21.0M overdue / 1,935 documents / 265 customers / 4.3M 90+ |
| `admin_desktop_AR_labels_filters_drilldown.png` | filter bar open, Odoo labels in Arabic (فاتورة العميل …), drill-down of the top customer (29 lines, Odoo links) |
| `admin_desktop_EN_all_scopes.png` | both toggles on (total 53,420,636.99 = Odoo) |
| `admin_phone_EN_default.png`, `admin_phone_AR_labels_filters_drilldown.png`, `admin_phone_EN_all_scopes.png` | 390 px phone width |
| `admin_desktop_price_hub.png` | the Price hub with the Debt Report card |
| `salesperson_phone_not_enabled.png` | user 27 (Salesperson, key 34): "No access", **no request sent**; the API answers 403 |
| `browser_request_timings.json` | the page's own API calls during the run |

**Phone width.** The page has no horizontal scroll (`scrollWidth` 390 = viewport). The exposure table, 1,663 px wide,
scrolls inside its 292 px container.

**Not done live: a salesperson with the role enabled.** Enabling it means writing a grant to the production
`role_permissions` table. That write is not among the ones you approved for this phase (reads, the finance job,
migration 0034).

- **Covered instead** by the DB-backed test (real router, real `powerBI_Data`, salesperson identity faked). It shows:
  - the salesperson sees exactly their own lines (customers and totals);
  - 403 for another salesperson;
  - an empty drill-down for another salesperson's customer;
  - 403 on all five endpoints while not enabled.
- **For live screenshots,** approve this temporary grant and I'll revert it right after:

  ```sql
  INSERT INTO role_permissions (role_id, permission_id, allowed)
  SELECT r.role_id, p.permission_id, 1 FROM roles r JOIN pages g ON g.page_key = 'debt_report'
  JOIN permissions p ON p.page_id = g.page_id AND p.action = 'view' WHERE r.role_name = 'SALESPERSON';
  -- revert:
  DELETE rp FROM role_permissions rp JOIN roles r ON r.role_id = rp.role_id JOIN permissions p ON p.permission_id = rp.permission_id
  JOIN pages g ON g.page_id = p.page_id WHERE r.role_name = 'SALESPERSON' AND g.page_key = 'debt_report';
  ```

## 7. Tests

| Suite | Result |
|---|---|
| ETL `pytest` (incl. `api/tests`) | **393 passed**, 1 skipped; 1 failure, the known `test_input_check::test_wrong_case_file_name_gets_a_near_match_hint` |
| Backend `vitest` | **35 files passed** (5 skipped: the DB-backed suites, opt-in); `tsc` clean |
| Backend DB-backed, `vitest.debt-db.config.ts` (read-only on `powerBI_Data`) | **7 passed**: defaults = the three views; ~40 filter cases = direct SQL on the line view (overview + customers); toggles add exactly the other / inter-company lines; every scope = fact total = **Odoo 53,420,636.99**; drill-down sums to the exposure row; salesperson scope / 403s |
| Frontend `vitest` | **16 files passed**, incl. the new `debtReportView.test.ts` (8); `tsc` clean; `next build` compiles `/price` and `/price/debt-report` |
| `packages/ui` `vitest` | `Gauge.regression.test.tsx` **fails, pre-existing**: `packages/` is untouched by this work; the last `Gauge.tsx` change was `c5c0a6c` (2026-09-29). Not in the required suites; worth a look separately |

**New tests:**

- **ETL (+12):**
  - scope rules (9 cases);
  - scope definitions;
  - the snapshot carries the scope and its dimension, and every scope keeps the total;
  - configured inter-company partners.

  The SQLite migration translator now also applies a migration's prepared `ADD COLUMN` and skips seeds for tables the
  test database lacks.
- **Backend:**
  - `debtReport.test.ts` (parsing, SQL builder, config thresholds);
  - `debtReport.routes.test.ts`: 403 when not enabled; the lock in every query, incl. the DSO sales; 403 for another
    salesperson; B2B segment scope; 400s; finance freshness;
  - `debtReport.db.test.ts`.
- **Frontend:** `debtReportView.test.ts`.

## 8. Files (Phase 7)

**New:**

- **ETL:** `data/etl/src/departments/finance/scope.py`, `data/etl/scripts/finance/check_receivable_totals.py`.
- **Migrations:** `data/warehouse/migrations/0034_finance_receivable_scope.sql`,
  `data/warehouse/down/0034_finance_receivable_scope_down.sql`.
- **Backend:**
  - `backend/src/config/finance.ts`, `backend/src/measures/debtReport.ts`, `backend/src/routes/debtReport.ts`;
  - the three backend test files and `backend/vitest.debt-db.config.ts`;
  - `backend/scripts/debt_timing.ts`.
- **Frontend:**
  - `frontend/src/app/(departments)/price/debt-report/page.tsx`;
  - `frontend/src/lib/debt/view.ts`, `frontend/src/lib/__tests__/debtReportView.test.ts`.

**Renamed:** `migrations/manual/0034_retire_legacy.sql` → `0035_retire_legacy.sql`. References updated in
`rename-map.md`, `ETL.md` and `job_tracker.py`.

**Changed:**

- **ETL:**
  - `etl_platform/config.py`;
  - `departments/finance/{transform,jobs}.py`;
  - `tests/{test_finance_receivables,sqlite_schema}.py`.
- **Backend:** `permissionRegistry.ts`, `server.ts`, `scripts/page_server.ts` (CORS for local runs, the export check).
- **Frontend:**
  - `lib/navItems.ts`, `lib/api.ts`, `lib/hooks.ts`, `lib/format.ts`;
  - `app/(departments)/price/page.tsx` (placeholder → hub).
- **Env examples:** the three ETL ones, with `FINANCE_INTERCOMPANY_PARTNER_IDS`.
- **Docs:** `receivables-etl.md`, `deployment-plan.md`, this report.
- **`.claude/launch.json`:** two local-run entries added (`debt-backend-4500`, `debt-frontend-3500`); your existing
  entries are unchanged.

**Backups:**

- `~/etl-rebuild-backups/before_0034_20261004-2249/`: pages, permissions, role and user permissions, the finance fact,
  the invoice and payment dimensions, and the three view definitions as they were before 0034.
- The end-of-phase backup is `*_phase7.*` (section 10).

## 9. Open items

1. **A1:** confirm 15905 / 15907. Decide on the Athena partners 9651 / 16388.
2. **A3:** the Aged Receivable exports for 2026-10-04, one per company.
3. **Live screenshots of an enabled salesperson:** needs your approval for the temporary grant (§6).
4. **Tika CEO** has no company data-scope rule, so it sees both companies (on every page, not only this one). Add
   `companyKeys=3` if intended.
5. **B2B Director:** lines without a sales team are outside segment B2B, so this role does not see them: 249 lines
   (−1,744,326.17) in the default view, 3,714 lines (16.35M) with every scope.
6. **Credit limits:** none set in Odoo, so KPI 6 is 0 until finance sets limits.
7. **Language:** the page offers Odoo labels in Arabic. Our own page text stays English, as the app is English-only by
   design (`c5c0a6c`). Say if you want more.
8. **Placement:** route `/price/debt-report`, sidebar label "Price", as decided.
9. **`packages/ui` Gauge regression test:** fails on `main`, unrelated to this work.
10. **After you approve Phase 7:** you remove the `07PREPORT-etl` worktree, then I delete
    `feature/debt-receivables-etl` with `git branch -d`.

## 10. Backup of this phase

The 07PREPORT uncommitted changes (patch + untracked tarball + checksums + secrets scan), in
`~/etl-rebuild-backups/` (`20261005-0703_phase7.*`, secrets scan clean):

- `20261005-0703_phase7.patch`
- `20261005-0703_phase7_untracked.tar.gz`
- `20261005-0703_phase7_untracked.list`
- `20261005-0703_phase7.SHA256SUMS.txt`



**Phase 8 waits for your approval.**
