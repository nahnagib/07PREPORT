# Salesforce Performance

People → Salesforce Performance (`/Dashboard/people/salesforce-performance`).
The backend syncs the `sales_people_performance` permission at startup. Admins can view it immediately;
other roles require an explicit View grant in Roles & Permissions. No warehouse migration is needed.

## Who is on the page

Only people with a positive prorated YTD target. Anyone whose YTD target is missing, zero or negative
is removed by the API, so they never appear in a card, ranking, chart, table, CSV/PDF export, total or
percentage. There is no "No target" status. Total sales people = the sum of the five status cards.
Vacant target seats, including "Sales Person 1" and "Salers Person 3", are excluded from the report,
contribution totals, and salesperson picker. A named salesperson with a positive target stays in the
report even when their actual sales are zero.
The roster otherwise includes people with current-year sales or targets and people with sales in the
same period last year (they stay only if they also have a target). Non-positive salesperson IDs are excluded.

## Statuses and benchmarks

Achievement is actual sales value / prorated YTD target. The exact, unrounded value determines the
status. Ranges are continuous; exactly 100% is On target.

| Status | Person achievement | Team distribution benchmark |
| --- | --- | --- |
| Top performer | >110% | ≥20% of people |
| On target | ≥100% and ≤110% | ≥50% |
| Behind target | >90% and <100% | ≤15% |
| Need attention | >50% and ≤90% | ≤10% |
| Critical | ≤50%, including negative net sales | ≤5% |

Benchmark share = people in the status / people on the page.

## Page order

1. **Team status**: Total and one card per status. Each card shows headcount, the YTD variance in LYD
   (Σ actual − Σ target) and the variance as a percentage of the combined YTD target.
   Clicking a card filters the contributions, sales charts and details table to that status.
2. **Top people by category**: one card under each status card with the #1 person only, always ranked by
   variance % to YTD target: the highest for Top performer and On target, the most negative (the person
   needing the most attention) for Behind target, Need attention and Critical. Each card shows the variance %,
   the variance in LYD, actual of target and a progress bar. Name search limits the ranking to matching people.
   The first slot is **Team pulse** (everyone on the page, or the selected person): YTD achievement, gap to
   YTD target, required monthly run-rate = (full-year target − YTD actual) / months left against the running
   rate = YTD actual / months elapsed (the anchor month counts by elapsed days), and YTD actual of full-year target.
3. **Status mix** (grouped bars) | **MoM performance by status** (lines).
   Status mix shows headcount, share of the team, the benchmark and the gap in percentage points.
   It defaults to YTD. In a month view, each person's status uses month actual / monthly target, and the
   headcount includes everyone in scope with a target that month. The current month uses the target prorated
   to the as-of date. Selecting a person shows their status row with the same team denominator.
   MoM shows Σ actual / Σ target for the people in each status that month.
4. **Person contribution** (donut) | **Actual vs target by month**. The donut splits the selection's YTD
   actual by company, then segment, sales team and person (click a slice or list row; breadcrumb goes back up).
   Selecting a person opens the donut on their main team (where most of their YTD actual is), with their slice
   pulled out and the others dimmed, and a row with their share of Team, Segment, Company, Group and Total.
   Going up keeps the slices that contain them highlighted; "Show everyone" returns to the top level.
   A Group level is shown first only when the data spans more than one group (today there is one holding
   group). Sales use each sale's company and effective (override-aware) segment and team; each person's
   YTD target is split across them in proportion to their YTD target plan. Net-negative slices are listed without a share.
5. **Performance details** table, last.

A selected person (top-people card or table row) narrows the charts and the table to that person.

## Filtering and months

The shared Company, Customer Group/segment, Distribution Channel, Branch, Salesperson and anchor
date filters apply to the whole page. The date is an as-of date: YTD always starts on January 1 of
the anchor year. The anchor month is partial, with a prorated target.

## Implementation and verification

`GET /sales-people-performance/overview?anchorDate=YYYY-MM-DD` accepts the shared dimension filters and
returns the statuses, the people (with monthly figures) and `contributions`: YTD actual and allocated
target per person × company × segment × team. `GET /sales-people-performance/contributions/:personKey`
still exists for a single person's contribution within the authorized scope; the page no longer calls it.
Both enforce authentication, password-change clearance, page View permission and data scope.

YTD/monthly measures reuse the Tachometer's `computeBreakdown` for warehouse sales, admin overrides
and target proration. Query count is bounded by months in the year, independent of team size.

Tests cover status boundaries, exclusion of people without a target, target allocation across
companies/segments/teams, best/worst person per status, status mix shares summing to 100%, monthly
achievement per status, the drill-down, page order, HTTP permissions and scope, and the bottom
navigator's active tab.
