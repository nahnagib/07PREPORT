# How the Critical Number is split

Since 2026-11-09, every scope on the Critical Number page gets its own Daily Critical Number. A scope is any filter
selection: group, company, customer group, branch, salesperson, distribution channel, or any combination of them.

## Formula

```
Daily Critical Number(scope, day D) = base(D) × share(scope, year of D)

share(scope, Y) = SUM(Target_Revenue of the scope's rows, Year = Y)
                / SUM(Target_Revenue of all rows,      Year = Y)
```

- **base(D)** is the group-wide value active on day D: Admin > Critical Number (`critical_number_history`, read
  through `backend/src/measures/criticalNumberHistory.ts`). The targets never change it. They only split it.
- **share** is `computeTargetShare` in `backend/src/measures/criticalNumber.ts`. It is one query on
  `v_sales_targets`: the scope's sum uses the page's filters, and the total uses none.
- **Company × Customer Group is one joint share** read from the targets, not the product of two shares. For 2026:
  - Tika + B2B = 43.41% of the file. The old typed factors gave 52.56% × 62.88% = 33.05%.
  - Majaal + B2C = 27.83% of the file. The old factors gave 17.61%.
- **Multi-select sums** the selected members.
- **A scope whose target is 0 gets 0.** For example, a salesperson with no target has a Daily Critical Number of 0.
- **The Customer filter is ignored**, because targets have no customer.
- **Salesperson admin overrides apply to the targets too.** These are the segment, branch and channel overrides in
  `salesperson_admin_profile` (`measures/filters.ts`). A reclassified salesperson's target moves with their actual
  sales, so actual and target always cover the same people.
- **The Monthly and Yearly counters and Missing Value / Missing Days follow automatically.** They add up each working
  day's own scaled value. A salesperson's Yearly target to date ≈ their annual target × working days so far ÷ 304, at
  base 556,462.28 = 169,164,533 ÷ 304.

The page shows the share under the Daily Critical Number, e.g. "22.49% of group target · from sales_targets.xlsx
2026". Admin > Companies and Admin > Customer Groups show each row's share as a read-only column, "Share of FY target
(from sales_targets.xlsx)", computed by the same function.

The old hand-typed "Critical Number %" is retired: `admin_company.critical_number_pct` and
`admin_customer_group.critical_number_pct` from migration 0021. The columns stay in the database (no destructive
migration). The app no longer reads or writes them.

## Source file

`Input/sales_targets.xlsx`, sheet `Targets`. The sales ETL loads it into `fact_sales_targets` (view `v_sales_targets`)
on every sales build (`data/etl/src/departments/sales/jobs.py` `conform_sales`). No separate import is needed.

## When an edited file shows up

| `ETL_SALES_MODE` | What rewrites the live `fact_sales_targets` | Visible on the page |
|---|---|---|
| `shadow` (production today) | Sales Refresh `main` (08:50, 11:50, 14:50, 17:50, 20:50) and the 02:00 Full Refresh | at the next of those runs, so within about 3 hours |
| `incremental` | the 30-minute `sales_build`: the file's size or modification time is part of its input signature (`SALES_INPUT_FILES`) | within about 30 minutes |
| `legacy` | Sales Refresh and the 02:00 Full Refresh | as for `shadow` |

In shadow mode the 30-minute build does notice the edited file, but it writes only the `shd_*` copies. The page reads
the live tables. This change does not touch the ETL or the schedule.

The page reads the targets on every load (no cache), so a reload after the next refresh shows the new shares.

## Fallback

| Case | Daily Critical Number | Shown on the page |
|---|---|---|
| The day's year has targets (total > 0) | base × share of that year | "x% of group target · from sales_targets.xlsx Y" |
| That year has no targets, or they total 0 | base × share of the **latest earlier year** with targets; a warning is logged | the same line with that year, plus a note |
| No year up to the day's year has targets | base × 1 (not split); a warning is logged | "Group value (100%)" plus a note |
| The `v_sales_targets` query fails | base × 1 (not split); logged as an error; the page stays up | "Group value (100%)" plus a note |

The `/critical-number/overview` response carries `share`, `shareYear` and `shareSource`
(`current` / `fallback` / `missing` / `error`).

## Checking it against the warehouse

Read-only test of the acceptance table:

```
DB_HOST=... DB_USER=... DB_PASSWORD=... DB_NAME=powerBI_Data npx vitest run -c vitest.cn-db.config.ts
```

Run it from `backend/`. It prints every scope's share and Daily Critical Number.
