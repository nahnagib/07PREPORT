# MARCOM KPI service and data endpoints — Phase 3

Everything the four MARCOM report pages show is computed in `backend/src/marcomKpi/` from the
`marcom_*` tables. Pages (Phase 4) render these payloads; they contain no formulas or thresholds.

## Module map

| File | Role |
|---|---|
| `rat.ts` | Exact BigInt rational arithmetic. All maths runs on it (no floats); one conversion to `number` at output |
| `formulas.ts` | Every formula, one line each (inputs are already-summed numerators/denominators) |
| `thresholds.ts` | **The only place RAG thresholds live**, with inclusive/exclusive flags per boundary |
| `kpi.ts` | The KPI shape, exact classification, month-over-month trend helper |
| `spending.ts` `campaigns.ts` `digital.ts` `trade.ts` | Pure page builders: rows in → chart-ready payload out |
| `db.ts` | The only SQL. `runCurrent` always adds `is_current = 1`; values are bound parameters |
| `params.ts` | Query-string validation → 400 |
| `pages.ts` | Loads rows (1–3 data queries per page) and wraps the payload with filters + freshness |
| `routes/marcomKpi.ts` | Routes + per-page permission gates |

Guards: a test scans `marcomKpi/` so no file other than `db.ts` may contain SQL or a `marcom_*` table name.

## Rules that are enforced

- **Sum first, then divide.** Never average ratios across months, brands or platforms (tests prove it with 10× vs 1× months).
- **Exact comparisons.** Thresholds are compared on exact fractions (`Rat.cmp` cross-multiplies), so CTR of exactly 5% is Yellow
  and 5.000000000000000001% is Green even though both display "5%". Rounding is display-only and never changes a status.
- **Zero / missing denominators** → `{ value: null, status: "na" }`. No NaN/Infinity anywhere (tests walk whole payloads).
- **Followers are snapshots**: per platform, the latest month ≤ `toMonth`, with `asOf`. Never summed across months.
- **Only `is_current` rows** are read: superseded and rolled-back rows can never reach a KPI.
- **Raw numbers only.** No formatted strings. `percent` KPIs are in **percentage points** (`5.28` = 5.28%), `ratio` is the X of "1 : X",
  `lyd` is LYD, `minutes` is minutes.

## The KPI object

```json
{ "value": 5.6, "status": "green", "unit": "ratio", "direction": "higher_better", "previous": 3, "delta": 2.6 }
```
`status`: `green | yellow | red | neutral | na`. `unit`: `ratio | percent | lyd | minutes | count | days`.
`previous`/`delta` appear only where documented: ROI YTD card (previous = LYTD), and on pages 3–4 as
**last month in range vs the previous month with data** (`meta.deltaBasis = "lastMonthVsPreviousMonth"`); omitted with fewer than two months.

## Thresholds (`thresholds.ts`)

| KPI | Green | Yellow | Red |
|---|---|---|---|
| ROI (X in 1:X) | X > 5 | 3 ≤ X ≤ 5 | X < 3 |
| CAC % of invoice | ≤ 3% | > 3% and ≤ 5% | > 5% |
| CPC (LYD) | < 2.5 | 2.5–5 inclusive | > 5 |
| CTR, Engagement rate | > 5% | 3%–5% inclusive | < 3% |
| Avg session (min) | > 3 | 1–3 inclusive | < 1 |
| Compliance, Giveaways, Printed, Attendance | > 90% | 80%–90% inclusive | < 80% |
| Bounce rate, Budget utilization, Brand growth, Campaign rate | none → `neutral` (`overBudget: true` when > 100%) | | |

To change one, edit `thresholds.ts` only (percent rules hold the **fraction**, e.g. `'0.05'`).

The campaign "rate %" is `campaignRate()` in `formulas.ts` (Revenue ÷ Spend); flip that one line to change the direction.

## Endpoints

`GET /marcom/kpi/{spending|campaigns|digital|trade}` — login + that page's own view permission
(`marcom_spending`, `marcom_media_campaigns`, `marcom_digital`, `marcom_trade`). The upload permission neither grants nor is needed.

| Param | Pages | Default | Validation |
|---|---|---|---|
| `year` | all | year of the latest uploaded data | integer 2020–2100 |
| `fromMonth` | all | 1 | 1–12, ≤ `toMonth` |
| `toMonth` | all | latest uploaded month of that year | 1–12 |
| `brandIds` (repeat, `[]`, or comma list) | spending, campaigns, trade | all | whole numbers that exist |
| `platforms` | digital | all five | Facebook, Google, LinkedIn, Instagram, TikTok |
| `status` | campaigns | all | Planned, Ongoing, Completed, On Hold |
| `completedOnly` | trade | false | true / false |

Bad input → `400 { error, code: "BAD_PARAMS" }`. Unknown params are ignored. No data at all → `200` with `hasData: false`,
complete empty structures and `meta.missing: [..., "data"]`.

Every response: `{ page, filters (as applied, brands resolved to {id,name}), freshness, hasData, meta: { missing[], ... }, period, ...payload }`.
`meta.missing` may contain `lastYearData` (page 1: prior-year rows not uploaded — `roi.lytd` is then `null`) and `data`.
"YTD"/"LYTD" cards cover `fromMonth..toMonth` (= YTD when `fromMonth` is 1).

### Payload contents

**spending** — `totals.{spend,revenueAttributed,companyRevenue}` (`total` + monthly `series`);
`roi` = `{ ytd, lytd, monthly[{month,current,currentStatus,lastYear,lastYearStatus}], bands{greenAbove,redBelow} }`;
`budgetUtilization` / `brandGrowth` / `cac` / `cpc` = `{ overall, brands[] }` (budget rows carry `spend, budget, overBudget`;
growth rows `revenueCurrent, revenueLastYear`; CAC rows are a KPI in LYD whose `status` is the %-of-invoice status, plus `pctOfInvoice`,
`weightedAvgInvoice`, `newCustomers`; CPC rows `socialPostCost, clicks`).

**campaigns** (campaigns overlapping the period) — `totals{spend,revenue,rate}`; `spendVsRevenue[]` sorted by revenue desc;
`roiByCampaign{bands,campaigns[]}`; `timeline[{name,brand,status,start,end,durationDays,spend,revenue,roi,roiStatus,rate}]` and `today`
(Africa/Tripoli); `coverageByType{totalUnits,types[5]}`; `costByType{totalCost,types[5]{cost,units,costPerUnit}}`. All five media types are always present.

**digital** — `followers{platforms[{platform,value,asOf}],total,metaTotal}`; `ctr` and `engagementRate` = `{ overall, byPlatform[] }`;
`engagementMonthly[{year,month,paid,organic,organicShare}]`; `bounceRate{kpi,series}`; `avgSession{kpi,series[{value,status}]}`.

**trade** — `compliance`, `giveawaysStock`, `printedStock` = `{ headline (latest month, with asOf/previous/delta), average, series[{value,status}] }`;
`attendance{kpi,actual,expected,series}`; `eventsByTypeMonthly[{month,total,byType{8 types}}]` (by Planned Date; Cancelled excluded, or Completed-only);
`eventsTimeline[{...,overdue}]` (`overdue` = not Completed/Cancelled and planned < today); `eventsMonthlySummary[{month,planned,completed,completionPct}]`
(planned = non-cancelled events planned that month).

## Query cost

Per request: brand list (1) + latest-period lookup only when `year`/`toMonth` are omitted (4 tiny `MAX` queries) + 1–3 data queries +
freshness (2). Nothing loops per brand/month/campaign (asserted ≤ 8 MARCOM queries in a test). Indexes:
`(is_current, year, month)` on the month tables, `(brand_id, year, month)` on spend, `(start_date, end_date)` on campaigns,
`(brand_id, planned_date)` on events (migrations 0022/0023).

EXPLAIN on 240,000-row copies of the two heaviest tables (page 1 spend, page 3 social):

```
spending: table=t type=range key=idx_marcom_spend_brand_period rows=32 Extra=Using index condition; Using where; Using filesort
          table=b type=eq_ref key=PRIMARY rows=1
social  : table=t type=range key=idx_marcom_social_current rows=40 Extra=Using index condition; Using where; Using filesort
```
(At the 80-row demo size the optimizer correctly prefers a table scan.)

## Demo data (dev only)

```bash
npm run marcom:demo-seed   --workspace backend      # 4 brands, Jan–Aug 2026 + 2025 backfill, 8 campaigns, 20 events…
npm run marcom:demo-unseed --workspace backend      # removes it (rolls the demo batches back)
```
Refuses when `NODE_ENV=production`, when `DB_HOST` is not localhost/127.0.0.1, or when `DB_NAME` doesn't contain dev/test/demo/local/sandbox
(override for an ordinary-named local DB: `-- --i-know-this-is-dev`). Also refuses to seed next to real uploads. It loads four workbooks through the normal
validate → commit path (batches named `DEMO SEED n-4 (...)`), so history, rollback and freshness behave like real data.
The numbers are designed so every RAG KPI shows Green, Yellow and Red (including exact boundaries), Brand B is over budget,
Brand C has negative growth, one campaign has zero spend (`n/a`), and there are overdue and future events.
