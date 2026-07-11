BEN MOUSSA HOLDING

07 Ps PROJECT

Promotion (Sales) Dashboard Migration Plan

Power BI → Web Application

Scope: Tachometer, Critical Number, Revenue Trend, Invoices Engine, Customer Growth

Governed by: 07 Ps Phase 1 – Architecture Standards

Version: 1.0   |   Status: Draft for Review


## Table of Contents


## 1. Purpose & Scope

This plan defines how the Promotion (Sales) dashboard — the current Power BI report covering Tachometer, Critical Number, Revenue Trend, Invoices Engine, and Customer Growth — is converted into the new AI-developed web application, using the Phase 1 standards document ("07 Ps Phase 1 – Architecture Standards") as its governing rulebook.

Sales is deliberately the first department migrated. It is the most mature, best-documented dashboard in the current system, which makes it the ideal proving ground for the data layer, component library, and RBAC model that every later department (Production, Supply Chain, HR, HSE, Excellence, Finance) will then reuse rather than reinvent.


### 1.1 In Scope

- All five existing pages: Tachometer, Critical Number, Revenue Trend, Invoices Engine, Customer Growth, including their drill-down/detail views (e.g., Invoice Class drill-down, Customer Status Details View).
- The underlying Sales, Invoice, and Customer data model, extended only as far as needed to serve these five pages (a Target/Plan fact table and a proper Calendar dimension, per Section 6 of the Phase 1 document).
- Role-based access for the existing BI 00–03 tiers and the Salesperson "own data only" restriction.

### 1.2 Out of Scope

- Production, Supply Chain, HR, HSE, Excellence, and full Finance dashboards — these follow in later phases, reusing the foundation this plan builds.
- Any redesign of the KPI logic itself. Formulas, thresholds, and definitions already documented in the current manual (e.g., Variance % = (Actual − Target) ÷ Target, the green/yellow/red 10% thresholds, Churn/Retention/Acquisition/Growth rate formulas) are carried over unchanged — this is a platform migration, not a metrics redesign.

### 1.3 Timeline Note

The 07 Ps program's previously stated "Final Deadline: August 2026" appears to refer to the wider Notion-tracked project rather than this specific migration, and today's date leaves well under two months to that date. The phased plan below assumes a realistic delivery window is agreed separately; Section 9 presents the work in relative, sequential phases (P0–P5) rather than fixed calendar dates so it can be compressed or extended once a target date is confirmed. If August 2026 is in fact a hard constraint for the Sales migration alone, scope should be re-cut immediately (see Section 9.3, Compressed-Timeline Option) rather than compressing testing or the parallel run, which is where cut corners would surface as bad numbers in front of ExCo.


## 2. Guiding Principles

Every decision in this plan traces back to the Phase 1 standards document. Four principles carry the most weight for a migration specifically:

- Same numbers, new skin, first: the first release must reproduce today's KPI values exactly before any new capability is added. A stakeholder should not be able to tell the platform changed by looking at the numbers — only at the delivery vehicle.
- Foundation before pages: the data warehouse layer, shared component library, and RBAC manifest (Sections 5 and 6 of the Phase 1 document) are built once, ahead of the first page, not discovered page-by-page. Sales pays this cost so later departments don't have to.
- Parallel run, not a leap: Power BI stays live and remains the system of record until the web version has been reconciled against it for a full operating cycle (see Section 10).
- One dashboard, one set of standards: every page follows the design, filter, and platform standards already ratified in Phase 1 — no page-specific exceptions without a documented, sponsor-approved reason.

## 3. Current State Recap

A short recap of what is being migrated, to keep this plan self-contained.


| Page | Core Function | Key Dependencies |
| --- | --- | --- |
| Tachometer | YTD/MTD Value, Volume, ASP gauges vs target; role-scoped Salesperson view | Sales fact, Target/Plan values (currently Excel-sourced), Employee/Salesperson dimension |
| Critical Number | Required daily pace vs annual target; working-day/holiday/closure counters | Sales fact, Target/Plan values, Calendar/working-day reference data (currently ad hoc lists) |
| Revenue Trend | MoM Value/Volume/ASP vs last year vs target; YTD/MTD variance KPI cards | Sales fact, Target/Plan values, Date dimension |
| Invoices Engine | Invoice counts, efficiency ratios, sales trend, invoice classification (A–D) with year drill-down | Invoice-grain data (currently likely derived from the Sales fact), Date dimension |
| Customer Growth | New/Total customers, Customer Status (Active/Non-Active/Reactivated/Blocked), rates, contribution, category performance, customer-level detail view | Customer dimension, Sales fact, a derived customer status calculation |

Two data gaps flagged in the Phase 1 Database Review are directly on the critical path for this migration and are called out again here because they block Tachometer and Critical Number specifically:

- No governed Target/Plan fact table — targets currently live in Excel inputs.
- Working-day/holiday/forced-closure logic is not yet part of a conformed Calendar dimension.
Both are addressed in Phase P1 of this plan (Section 6.2) precisely because Tachometer and Critical Number cannot be correctly reproduced in the web app without them.


## 4. Migration Strategy & Approach


### 4.1 Overall Approach — Strangler Pattern

The web application is built page-by-page alongside the live Power BI report (a "strangler fig" migration), rather than a big-bang rebuild-and-switch. Each page goes through the same four states before it is considered migrated:

- Built — the page exists in the web app, reading from the new data layer.
- Reconciled — its numbers match Power BI for the same filters and date range, across at least one full MTD and one full YTD cycle.
- Piloted — a small group of real users (their own Sales Team + one Director) use the web version for daily work while Power BI stays as the fallback.
- Cut over — Power BI access for that page's audience is turned off; the web version becomes the system of record for that page.

### 4.2 Why Sales Goes First

- It is the most complete and best-documented dashboard today, minimizing requirements-gathering risk.
- It already exercises the hardest platform capabilities the standards document defines — RBAC down to an individual Salesperson, drill-down, multi-page filter synchronization, target-vs-actual visuals — so building it first de-risks every later department.
- It has an existing, motivated sponsor group (CFO Sponsor, Sales/B2B/B2C Directors) already used to reviewing dashboard output, which shortens the validation loop in Section 10.

## 5. Target Architecture for the Sales Dashboard

The web version of Sales is built on three layers, matching the Phase 1 recommendation that both Power BI (during transition) and the new app read from one shared computation layer rather than two divergent paths.


| Layer | Responsibility | Sales-Specific Additions Needed |
| --- | --- | --- |
| Data Warehouse | Single governed source of Sales, Invoice, Customer, Target/Plan, and Calendar data | New Target/Plan fact table; Calendar dimension gains is_working_day / is_holiday / is_forced_closure attributes; confirm/formalize an invoice-grain fact |
| API / Semantic Layer | Exposes KPI-ready measures (Value, Volume, ASP, Variance %, Churn/Retention/Growth rates) with RLS enforced server-side | Implements the exact formulas already defined in the current manual, unchanged, as versioned measures |
| Web Application | Renders the 5 pages using the shared component library and design tokens from the Phase 1 standards | Tachometer gauges, Critical Number counters, MoM trend charts, invoice drill-down, customer status detail view |

Row-Level Security is enforced at the API/semantic layer, not only in the UI, so a restricted user cannot see another scope's data via export either — this is a direct carry-over of Section 5.2 of the Phase 1 standards.


### 5.1 Component Reuse Map

Mapping today's pages onto the shared component library defined in Phase 1 Section 3.20, so nothing is built as a one-off:


| Existing Visual | Shared Component |
| --- | --- |
| Tachometer gauges + reference metric tiles | Gauge component + KPI tile component (Section 3.6) |
| Critical Number donut counters | Ring/donut progress component |
| MoM Value/Volume/ASP line-and-target charts | Trend chart component (Actual/Last Year/Target 3-series convention, Section 3.7) |
| Invoices Classification donut + Sales Trend combo chart | Donut component + combo bar/line chart component |
| Customer Status tiles, Rates tiles, Contribution donut, Category Performance bar chart | KPI tile, rate tile, donut, and horizontal bar components |
| Customers Table / Customer Status Details View | Data table component with sticky header, frozen first column, totals row (Section 3.8) |


## 6. Workstreams & Phases

Six sequential phases, P0 through P5. Each phase has an explicit exit criterion — the next phase does not start until the current one's exit criterion is met, since skipping ahead is how numbers stop matching.


### 6.1 Phase P0 — Discovery & Sign-off

- Confirm and lock the KPI catalog and data dictionary entries for every metric on all 5 pages (Value, Volume, ASP, Critical Number, Missing Days/Value YTD, MoM variances, invoice classes A–D, the 4 customer statuses, Churn/Retention/Acquisition/Growth rates) against Phase 1 Section 5.5–5.6.
- Confirm the RBAC manifest for Sales: BI 00/01/02/03 tiers, Sales Director/Manager, and the Salesperson own-data-only rule.
- Exit criterion: KPI catalog and RBAC manifest signed off by the Data Analyst and the relevant Department Head/Sales Director.

### 6.2 Phase P1 — Data Foundation

- Stand up the Target/Plan fact table (replacing the Excel-input target values) and the extended Calendar dimension (working day / holiday / forced closure flags).
- Confirm or build the invoice-grain fact needed for Invoices Engine's per-invoice efficiency metrics.
- Point the semantic layer's measures at the warehouse, implementing each formula from the KPI catalog exactly as documented today.
- Exit criterion: every KPI in the catalog can be queried from the warehouse/semantic layer and matches the current Power BI value for a fixed test filter set (one full YTD, one full MTD).

### 6.3 Phase P2 — Platform Shell & Component Library

- Build the shared header, navigation/tab bar, filters sidebar, and the component set mapped in Section 5.1, using the design tokens and color system from Phase 1 Section 3.9–3.10.
- Implement the filter behavior from Phase 1 Section 4 in full: global vs. local persistence, MTD/YTD date logic, reset, role-based locking for Salespersons.
- Implement loading/empty/error states and the Last Update / Last Refresh Time footer pattern (Phase 1 Sections 3.21–3.23).
- Exit criterion: an empty shell — header, nav, filters, and states — is demonstrable end-to-end with no live pages yet, and passes the Phase 1 design checklist.

### 6.4 Phase P3 — Page-by-Page Build

Pages are built in the order below — each order choice is deliberate (see rationale column):


| Order | Page | Rationale |
| --- | --- | --- |
| 1 | Revenue Trend | Simplest data shape (three MoM trend charts + six variance cards); validates the trend-chart and Target/Plan fact end-to-end before harder pages depend on it |
| 2 | Tachometer | Reuses the same Value/Volume/ASP/target logic just proven in Revenue Trend, adds the gauge component and Salesperson RBAC lock |
| 3 | Critical Number | Depends on the extended Calendar dimension from P1; reuses the gauge/ring pattern from Tachometer |
| 4 | Invoices Engine | Introduces the invoice-grain fact and the drill-down interaction pattern |
| 5 | Customer Growth | Most complex page (status derivation, rates, drill-down detail view with filter-reset behavior); built last so it inherits every pattern already proven |

- Exit criterion (per page): the page renders correctly across desktop/tablet/mobile breakpoints, every filter behaves per Section 4, and every KPI matches Power BI for the P0 test filter set.

### 6.5 Phase P4 — Parallel Run & Reconciliation

- All 5 pages run live in the web app alongside Power BI for a full operating cycle (recommend one full month, spanning at least one MTD and one YTD reporting close).
- A daily reconciliation check compares every KPI card value between the two systems for a fixed set of filter combinations (All / single Business Unit / single Salesperson) and logs any mismatch.
- Pilot users (Sales Team + one Director) use the web app for real daily work; Power BI remains their fallback and system of record during this phase.
- Exit criterion: zero unresolved reconciliation mismatches for two consecutive weeks, and pilot users sign off that the web app is usable for daily work.

### 6.6 Phase P5 — Cutover & Decommission

- Switch the web app to system-of-record for Sales; update the RBAC manifest so BI 00–03 tiers, Directors, and Salespersons authenticate against the web app.
- Keep Power BI accessible read-only for a further short window (recommend 2–4 weeks) as a safety net, then formally retire the Sales Power BI report.
- Archive the final reconciliation log as part of the audit trail (Phase 1 Section 5.12).
- Exit criterion: Power BI Sales report retired; web app is the sole system of record; audit trail archived.

## 7. Team & Roles (RACI)

Roles reuse the existing Roles & Responsibilities table from the 07 Ps BI Report documentation, extended with migration-specific responsibilities.


| Role | Responsible For | RACI |
| --- | --- | --- |
| CFO Sponsor (Mr. Ahmad Layas) | Data access, system support, final validation of reconciled numbers | Accountable |
| Project Initiator (Mr. Bilal Fakhouri) | Strategy, KPI approval, go/no-go at each phase gate | Accountable |
| Data Analyst (Nahla Burweiss) | KPI catalog, data dictionary, requirements, coordination across P0–P5 | Responsible |
| Sales Director(s) / Department Head | Defines KPI acceptance, approves each migrated page, pilot participation | Consulted / Responsible for sign-off |
| Development team (web app) | Builds data layer, component library, and the 5 pages per Sections 5–6 | Responsible |
| Salesperson end users (pilot group) | Daily use during P4 parallel run, feedback | Consulted |
| ExCo / BI 00 tier | Informed at each phase gate; final go-live approval at P5 | Informed / Accountable at cutover |


## 8. Indicative Timeline

Presented as relative sequential durations rather than fixed dates, per the timeline note in Section 1.3. Durations assume a small, focused team already familiar with the current Power BI report.


| Phase | Focus | Indicative Duration | Depends On |
| --- | --- | --- | --- |
| P0 | Discovery & sign-off | 1–2 weeks | — |
| P1 | Data foundation (Target/Plan fact, Calendar dimension, invoice grain) | 2–4 weeks | P0 sign-off |
| P2 | Platform shell & component library | 2–3 weeks | Can overlap with late P1 |
| P3 | Page-by-page build (5 pages) | 4–6 weeks | P1 + P2 complete |
| P4 | Parallel run & reconciliation | 4 weeks minimum (1 full operating cycle) | P3 complete for all 5 pages |
| P5 | Cutover & decommission | 2–4 weeks (incl. safety-net window) | P4 exit criterion met |

Indicative total: roughly 15–23 weeks end-to-end, depending on team size and how much of P1/P2 can run in parallel. This is presented so it can be compared honestly against any hard deadline rather than silently compressed.


### 8.1 Compressed-Timeline Option

If a hard deadline forces compression, the recommended order of sacrifice is:

- 1st: Reduce parallel-run duration (P4) toward a strict two-week minimum, never below it — this is the safety net that catches wrong numbers before ExCo sees them.
- 2nd: Reduce the page build order's cushion in P3 by running two pages in parallel once the pattern from Revenue Trend/Tachometer is proven, instead of the recommended fully sequential order.
- Never compress: P1's data foundation work or P4's reconciliation discipline — both are where migration errors actually originate, and cutting them only defers the cost to a post-launch incident with ExCo-visible wrong numbers.

## 9. Testing & Validation Strategy


### 9.1 Reconciliation Testing

- Fixed test filter matrix: All / Majaal only / Tika only / a single named Salesperson, each run for both MTD and YTD date ranges — 8 combinations minimum, checked against every KPI card on every page.
- Automated daily comparison job during P4 flags any variance beyond a small rounding tolerance (e.g., 0.5%) for manual review, rather than relying on a human to eyeball two screens.

### 9.2 Functional Testing

- Every filter behavior in Phase 1 Section 4 is tested explicitly: default values, reset, global persistence across pages, local reset on entering Customer Status Details View, Salesperson lock, multi-select on Customer Group.
- Drill-down interactions (Invoices Engine year → Invoice Class, Customer Growth group/category → customer names) are tested for both the "enabled" and "not yet enabled" states, since the current system deliberately behaves differently in each (cross-filter vs. drill-down).

### 9.3 Non-Functional Testing

- Performance budgets from Phase 1 Section 5.15 (page load < 3s, filter response < 1.5s) verified under a realistic data volume (multi-year Sales history, full Customer base).
- Responsive/accessibility testing across the desktop/tablet/mobile breakpoints and the WCAG AA checks defined in Phase 1 Section 3.15–3.17 and 5.10.

### 9.4 User Acceptance

- Pilot Sales Team and Director sign-off during P4 is a named exit criterion, not an informal check-in — captured in writing alongside the reconciliation log.

## 10. Risks & Mitigation (Migration-Specific)

These are additional to, and should be read alongside, the platform-wide risk register in the Phase 1 standards document (its Section 9).


| Risk | Impact | Mitigation |
| --- | --- | --- |
| Target/Plan values migrate out of Excel incorrectly | Tachometer and Critical Number show wrong pace-vs-target from day one | Reconcile the new Target/Plan fact against the current Excel inputs line-by-line before P1 exit, not just at KPI level |
| Users trust the wrong system during parallel run | Two versions of "the truth" circulate inside Sales/ExCo | Communicate clearly that Power BI is system-of-record until P5 cutover is formally announced; label the web app pilot pages accordingly |
| Reconciliation surfaces a long-standing bug in the current Power BI logic itself | Ambiguity over which system is "right" | Escalate to the Data Analyst and Sales Director for a documented decision before changing either system; do not silently pick one |
| Salesperson RBAC lock is mis-scoped in the new system | A salesperson sees another's data, or is locked out of their own | Explicit RBAC test cases per Section 9.2, sign-off from Sales Director before P4 pilot begins |
| Timeline pressure compresses P4/P1 | Wrong numbers reach ExCo after cutover | Follow the compression order in Section 8.1; never skip reconciliation or the data foundation |


## 11. Definition of Done

The Sales/Promotion migration is complete when all of the following are true:

- All 5 pages (Tachometer, Critical Number, Revenue Trend, Invoices Engine, Customer Growth) and their drill-down/detail views are live in the web app.
- Every KPI matches Power BI within tolerance across the full P4 parallel-run cycle, with the reconciliation log archived.
- RBAC (BI 00–03, Director, Salesperson own-data) is verified and signed off by the Sales Director.
- The design, filter, and platform standards from the Phase 1 document are met — verifiable against the same checklist used for every future department.
- The Power BI Sales report is formally retired (or downgraded to a documented, time-boxed read-only fallback).
- The data warehouse extensions built in P1 (Target/Plan fact, Calendar dimension, invoice grain) are documented in the data dictionary and available for reuse by the next department migration.

## 12. Next Steps

- Confirm the target delivery window against the indicative timeline in Section 8, and formally decide whether the compressed-timeline option is needed.
- Kick off Phase P0 — lock the KPI catalog, data dictionary entries, and RBAC manifest for Sales with the Data Analyst and Sales Director.
- Assign the development team and confirm the target data warehouse platform before P1 begins.
- Schedule the P0 → P1 phase-gate review with the Project Initiator and CFO Sponsor.
End of migration plan.
