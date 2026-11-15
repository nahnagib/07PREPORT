# Prompt: Critical Number shares from sales_targets.xlsx

Repo: `C:\Users\Lenovo\Desktop\07PREPORT\07ps-sales-dashboard-app`. Work in a new git worktree on a new branch `feature/critical-number-target-shares` cut from `main` (currently a5f7c9b). Run `git branch -vv` before every commit. Open a PR into `main` when done; do not merge it.

## Goal

The Critical Number page must give every scope (group, company, customer group, branch, salesperson, distribution channel, and any combination of them) its own Daily Critical Number. Each scope's share comes from its full-year revenue target in `Input/sales_targets.xlsx`, not from percentages typed into the Admin panel.

```
Daily Critical Number(scope, day D) = base(D) × share(scope, year of D)
share(scope, Y) = SUM(Target_Revenue of rows in the scope, Year = Y) / SUM(Target_Revenue of all rows, Year = Y)
```

`base(D)` stays as it is: the dated value from `critical_number_history` (Admin > Critical Number), read through `backend/src/measures/criticalNumberHistory.ts`. Do not change how the base works.

## What is there today (read these first)

- `data/etl/src/departments/sales/conform.py` and `incremental.py` (`SALES_INPUT_FILES`). The ETL already loads `Input/sales_targets.xlsx` into `fact_sales_targets`, exposed as the view `v_sales_targets` (migration `0031_sales_mart.sql`). It has `Year`, `Month`, `CompanyKey`, `SegmentKey`, `SalesTeamKey`, `SalespersonKey`, `ChannelKey` and `Target_Revenue`. **No new ingestion is needed.** Confirm this, and confirm the 30-minute refresh picks up an edited xlsx. If it does not, fix that and say so in the PR.
- `backend/src/measures/criticalNumber.ts`: `sumCompanyPct`, `sumSegmentPct`, `computeScopeFactor`, `computeDailyCriticalNumberSchedule`, `computeDailyCriticalNumber`. The factor comes from `admin_company.critical_number_pct` and `admin_customer_group.critical_number_pct`, seeded in `0021_critical_number_allocation.sql` with 47.44 / 52.56 / 62.88 / 37.12.
- `backend/src/measures/filters.ts`: `Filters` and `buildWhereClause`. This clause builder works on `v_sales_targets` (same column names) and applies the salesperson admin overrides.

### Problems this change fixes

1. **Branch, Salesperson and Channel filters are ignored.** Filtering to one salesperson still shows the full company or group number.
2. **Company × Customer Group multiplies two independent shares, which is wrong.** For example, Tika + B2B gives 52.56% × 62.88% = 33.05%. The targets say 43.41%. Majaal + B2C gives 47.44% × 37.12% = 17.61%; the targets say 27.83%.
3. **The shares are typed by hand and drift from the targets.** Majaal is typed as 47.44% but the file gives 47.38%. B2B is typed as 62.88% but the file gives 62.96%.

## Required changes

1. **New share function** in `criticalNumber.ts`, e.g. `computeTargetShare(pool, filters, year)`. It runs one query on `v_sales_targets`: the scoped sum uses `buildWhereClause(filters)` and the denominator has no filters, both for `Year = ?`. It ignores `customerKeys`, because targets have no customer. Use one query with conditional SUMs, or two cheap ones, with parameters only and no string-built values.
2. **Rewrite `computeDailyCriticalNumberSchedule`** so it returns `(date) => base(date) × shareForYear(date.getUTCFullYear())`, memoised per year. A YTD or year walk must not query once per day.
3. **Edge cases:**
   - **No target rows for a year, or a total of 0:** use the latest earlier year that has targets. Log a warning and return a `shareSource` / `shareYear` flag in the `/overview` response so the page can show a small note.
   - **Scope with target 0** (e.g. Hussain.elkhateb, Majaal Signiture): return a share of 0. This is correct; do not fall back to 100%.
   - **Query failure:** keep today's behaviour. Log loudly, use factor 1, and keep the page up.
4. **Remove the old factor.** Delete `sumCompanyPct`, `sumSegmentPct` and `computeScopeFactor`, and stop reading `critical_number_pct`. Keep the DB columns (no destructive migration).
5. **Admin pages** (`frontend/src/app/admin/companies/page.tsx`, `customer-groups/page.tsx`, `companyAdminService.ts`, `customerGroupAdminService.ts`, `frontend/src/lib/api.ts`): remove the editable "Critical Number %" input. Replace it with a read-only "Share of FY target (from sales_targets.xlsx)" value computed by the same function, and keep the API compatible.
6. **Critical Number page UI:** next to the Daily Critical Number card, show the share used, e.g. "22.49% of group target · from sales_targets.xlsx 2026". Show the fallback note when `shareSource` is not the current year. Keep the existing layout and style.
7. **Tests:** update `backend/src/measures/__tests__/criticalNumber.test.ts` and `routes/__tests__/criticalNumberAdmin.routes.test.ts`. Add cases for:
   - every single filter dimension
   - Company × Segment as one joint share, not a product (Tika+B2B = 0.43408)
   - multi-select summing
   - a zero-target person
   - a missing year, which uses the fallback year
   - query failure, which gives factor 1
   - the share being queried once per year in a YTD walk
8. **Docs:** update the header comments in `criticalNumber.ts` and `criticalNumberHistory.ts` and any doc that mentions the 47.44 / 62.88 percentages. Add a short "How the Critical Number is split" note in `docs/` covering the formula, the source file, the refresh, and the fallback.

## Acceptance check (2026 data; base 556,462.28 = 169,164,533 ÷ 304)

Run against the local or test warehouse and paste the results into the PR. Each value must match to within ±1 LYD.

| Scope | Share | Daily Critical Number (LYD) |
|---|---|---|
| Group (no filter) | 100% | 556,462 |
| Majaal | 47.378% | 263,640 |
| Tika | 52.622% | 292,822 |
| B2B | 62.961% | 350,352 |
| B2C | 37.039% | 206,111 |
| Tika + B2B | 43.408% | 241,549 |
| Majaal + B2C | 27.825% | 154,838 |
| Branch MJ-BEN-BC-01 (فريق المعرض الرئيسي) | 21.541% | 119,867 |
| Branch TK-EST-BB (مبيعات المنطقة الشرقية B2B) | 26.242% | 146,028 |
| Salesperson Marwan Alabbar | 22.487% | 125,131 |
| Salesperson Balqeis khaled | 4.567% | 25,411 |
| Salesperson Abd Nasser Khair | 0.307% | 1,709 |
| Salesperson Hussain.elkhateb | 0% | 0 |

These assume the admin base is set to 556,462. If the history row active today is still 560,000, every value scales by 560,000 / 556,462. Report which base was used. Do not change the admin value in code.

The Monthly / Yearly counters and Missing Value / Days must follow the new scaled schedule automatically. Check one salesperson's Yearly target = their annual target × (working days in the year so far ÷ 304), roughly.

## Do not

- Change the ETL loaders, the xlsx format, or the 30-minute schedule (unless the xlsx refresh check above fails).
- Touch the Tachometer or any other page.
- Push to `main` or merge.
- Commit `.env` files or anything under `Input/`.
