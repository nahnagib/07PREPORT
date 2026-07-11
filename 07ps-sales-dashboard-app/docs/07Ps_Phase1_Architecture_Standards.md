BEN MOUSSA HOLDING

07 Ps PROJECT

Phase 1 — Foundation

Dashboard & Platform Architecture Standards

Prepared for: Majaal (Ceramics Manufacturing) & Tika (Chemical Solutions)

Document Owner: Data Analyst, Ben Moussa Holding

Version: 1.0   |   Status: Draft for Review


## Table of Contents


## 1. Executive Summary

This document is the Phase 1 (Foundation) deliverable of the 07 Ps Project for Ben Moussa Holding Group. It defines the design, filtering, platform, and data standards that every future AI-generated dashboard must follow, and it reviews whether the current database can support the remaining six phases of the program.

No application code, and no redesign of existing dashboards, is produced in this phase. The output is a standards foundation — a rulebook — that later phases will build on.


### 1.1 Project Context

Ben Moussa Holding Group currently operates two companies:

- Majaal: Ceramics Manufacturing
- Tika: Chemical Solutions
Reporting today is delivered through Power BI, documented in the "07 P's BI Report – Performance Dashboard Manual Guide." That system already contains five operational pages — Tachometer, Critical Number, Revenue Trend, Invoices Engine, and Customer Growth — plus a role-based licensing structure spanning BI 00–BI 03 tiers, a star-schema data model, and a scheduled (non-real-time) refresh cycle.

The long-term objective is to replace this Power BI layer with a modern, AI-developed web application that reproduces the same reporting capability while remaining extensible to all future business functions and the remaining six "Ps" of the program (see the 7P Department Mapping in Section 2).


### 1.2 Purpose of This Document

This document provides the complete set of standards that AI-assisted development will follow when generating every future dashboard, so that:

- Every dashboard in the system looks and behaves as if it belongs to one unified platform, regardless of which department or phase produced it.
- Filters, states, and interactions are predictable and identical across pages.
- KPI, naming, security, and governance rules are defined once and inherited everywhere.
- The underlying database is assessed for scalability before six more phases are layered on top of it.

### 1.3 Deliverables Covered in This Document


| # | Deliverable | Section |
| --- | --- | --- |
| 1 | Dashboard Design Standards | 3 |
| 2 | Filter Standards | 4 |
| 3 | Platform Standards | 5 |
| 4 | Database Review | 6 |
| 5 | Future Scalability Recommendations | 7 |
| 6 | Best Practices | 8 |
| 7 | Risks & Mitigation | 9 |
| 8 | Recommendations & Next Steps | 10 |


## 2. Current State Assessment

Before defining new standards, it is important to record what already exists, since the future platform must remain compatible with — or deliberately improve upon — this baseline.


### 2.1 Existing Reporting Landscape (Power BI)

The current Power BI system ("07 P's BI REPORT") is a centralized initiative delivering department-focused dashboards plus a central executive (ExCo) dashboard from a single source of truth. It replaces manual reporting with automated, standardized, scalable analytics.


#### 2.1.1 Pages currently in production


| Page | Primary Purpose |
| --- | --- |
| Tachometer | YTD/MTD Value, Volume and ASP performance vs target, shown as gauge visuals with color-coded (green/yellow/red) zones. |
| Critical Number | Translates the annual target into a required daily value; tracks working-day consumption, missing days/value, and forced closures. |
| Revenue Trend | Month-over-month Value, Volume, and ASP trend lines (actual vs last year vs target) with YTD/MTD variance KPI cards. |
| Invoices Engine | Invoice count, efficiency (avg lines/volume/sales per invoice), sales trend, and invoice classification by value band (A–D). |
| Customer Growth | New/total customer counts, customer status (active/non-active/reactivated/blocked), churn/retention/acquisition/growth rates, top-10 contribution, and category performance. |


#### 2.1.2 Common conventions already in use

These conventions recur across all five existing pages and are treated as a starting baseline for the standards in Section 3–5:

- A consistent header bar with the BMH logo, page title, and partner/company logos (Majaal, Tika, Athens, SMG) on the right.
- A left-hand vertical Filters Panel present on every page (Business Unit, Customer Group, Distribution Channel, POS, Branch, Sales Person, Specific Date From/To).
- A bottom-of-page pair of timestamps — Last Update and Last Refresh Time — on every page.
- A bottom page-navigator bar to move between pages.
- A scheduled (non-real-time) refresh five times per day: 9:00 AM, 12:00 PM, 3:00 PM, 6:00 PM, 9:00 PM, with tolerance of up to 30 minutes.
- A red/yellow/green semantic color scale applied consistently to target-vs-actual visuals (green = at/above target, yellow = within 10% below, red = more than 10% below).
- An "i" interactivity icon marking visuals that support click-through / drill-down.
- Role-based data scoping — e.g., salespersons see only their own data on the Tachometer page.
Observation: these conventions are strong and well-documented candidates for formalization — Section 3 turns them into an explicit design system rather than an implicit convention that only the original report author holds in memory.


### 2.2 Existing Platform Governance


| Area | Current State |
| --- | --- |
| Data Sources | Odoo ERP (Sales, HR, Finance, Production), Excel (targets, finance inputs), manual logs (per department, where applicable). |
| Data Model | Star Schema — Fact tables: Sales, Production, Finance; Dimension tables: Date, Product, Customer, Employee. |
| Security | Row-Level Security (RLS) in Power BI. |
| KPI Governance | Standardized definitions (informal / document-based), department sign-off before publishing. |
| Licensing / Access Tiers | BI 00 (GCEO/GCCO/GCFO), BI 01 (B2B Directors), BI 02 (B2C Directors), BI 03 (Tika CEO/GCTO). |
| Refresh Cadence | 5x daily scheduled refresh, not real-time; delay tolerance up to 30 minutes. |
| Tracking / PM Tool | Notion workspace. |


### 2.3 7P Department Mapping (Program Scope)

The 07 Ps Project maps the marketing 7P framework to a department and a dashboard purpose. This mapping defines the full surface area the platform standards in this document must eventually support, even though only foundational standards — not department dashboards — are in scope for Phase 1.


| P Model | Department | Dashboard Purpose |
| --- | --- | --- |
| Business (ExCo) | ExCo | Consolidated executive view |
| Promotion | Sales | Sales performance, targets, revenue trends |
| Product | Production | Volume, efficiency, quality, utilization |
| Place | Supply Chain | Procurement, inventory, logistics |
| People | HR | Headcount, turnover, recruitment, training |
| Physical Evidence | HSE | Incidents, safety, compliance |
| Process | Excellence | Efficiency, KPIs, improvements |
| Price | Finance | Revenue, expenses, cash flow |

Implication for Phase 1: every standard defined in Sections 3–5 must be generic enough to serve Sales, Production, Supply Chain, HR, HSE, Excellence, and Finance dashboards alike — not just the sales-oriented pages that exist today.


## 3. Dashboard Design Standards

This section is the UI/UX contract that every AI-generated dashboard must satisfy. It formalizes the conventions already observed in the current Power BI system (Section 2.1.2) and extends them so they hold for every department in the 7P mapping, on every device.


### 3.1 Overall Dashboard Layout

Every dashboard page uses a fixed three-zone layout:

- Header zone: fixed height, spans full width — branding, page title, global actions.
- Filter zone: a persistent left sidebar (desktop/tablet) or a collapsible top drawer (mobile).
- Content zone: a responsive grid of cards, KPIs, charts and tables — the only zone that scrolls.
The header and filter zone never scroll with the content; only the content zone scrolls. This mirrors the existing Power BI pages, where the filters panel and header remain visible while the visuals area is explored.


### 3.2 Header Design

- Left: Company/group logo (BMH) is always present; a secondary logo for the active business unit (Majaal or Tika) appears when a single business unit is selected.
- Center or left-adjacent: Page title in the platform's H1 style — must match the approved dashboard naming convention (Section 3.24).
- Right: Partner/company badge row (kept for continuity with the current system) and a global action cluster: refresh indicator, export, and (new) notifications bell.
- Height is fixed at 64px (desktop) / 56px (mobile) so vertical rhythm is identical across every dashboard.

### 3.3 Navigation Style

- Primary navigation is a persistent bottom (or top, platform-configurable) tab bar listing sibling pages within the same dashboard — direct continuation of the current page-navigator bar.
- Secondary navigation between dashboards (e.g., Sales → Production) is a top-level app switcher in the header, organized by the 7P/department mapping.
- Breadcrumbs are mandatory on any drill-down or detail view (e.g., the Customer Status Details View) so users always have a one-click way back to the summary page.
- The currently active page/tab is always visually distinct (filled/dark background), matching the existing black-highlight tab convention.

### 3.4 Sidebar (Filters Panel) Behavior

- The filters sidebar is collapsible but defaults to expanded on desktop and collapsed on tablet/mobile.
- Filter order is standardized top-to-bottom: Company/Business Unit → Customer Group → Distribution Channel → POS → Branch → Sales Person/Owner → Specific Date (From/To) — matching the existing panel order so users' muscle memory transfers across pages.
- A sticky footer inside the sidebar always shows Last Update and Last Refresh Time (see Section 3.19 and Section 4).
- Locked/disabled filters (e.g., role-restricted filters) are shown greyed out rather than hidden, so users understand scope restrictions exist rather than assuming a filter is simply unavailable.

### 3.5 Card Design

- All cards use a consistent rounded-corner container (8px radius), a soft drop shadow, and a neutral light background — consistent with the rounded KPI/gauge cards already used across every existing page.
- Card padding is fixed at 16px on all sides; internal spacing between a card's label and value is 4px.
- Every card carries exactly one primary metric or visual — never mixed unrelated metrics in a single card.

### 3.6 KPI Cards

- Primary value is large and bold (28–36px); its label sits directly below in small, muted grey text (12–14px) — the same value-over-label hierarchy used in every existing KPI/tachometer card.
- Color-coding follows the single semantic scale defined in Section 3.9 (green/yellow/red) whenever a KPI is compared against a target; KPIs with no target use neutral grey/white.
- Variance KPI cards additionally show a signed percentage (e.g., +8.20% / -4.50%) with the sign driving color, consistent with the Revenue Trend page's variance cards.

### 3.7 Charts Layout

- Chart area always includes: title (top-left), a legend (top-right or inline), axis labels, and — where interactive — the standard "i" interactivity icon next to the title.
- Actual vs Last-Year vs Target series always use the same three-color convention across every chart in the platform: Actual = blue, Last Year = grey, Target = red (as already established in the Revenue Trend page).
- Combination charts (bar + line) are permitted only when the two series share a clear causal or ratio relationship (e.g., Sales Value bars with # of Invoices line) — never combined arbitrarily.
- Drill-down must be explicitly enabled via the visual's own control before a click changes the chart's grain; until enabled, a click only cross-filters other visuals on the page. This exact behavior, and the required tooltip "Click to turn on Drill down," is carried over unchanged from the current Invoices Engine and Customer Growth pages.

### 3.8 Tables Layout

- Tables are used only for entity-level, row-based data (e.g., a Customers Table) — never as a substitute for a KPI card or a chart.
- Column headers are sticky on scroll; the first column (entity name) is frozen on wide tables.
- A totals row, where meaningful, is pinned to the bottom of the table and visually distinguished (bold, shaded) exactly as in the existing Customers Table.
- Tables support column-level sort; multi-column sort is a Phase 2+ capability and is out of scope here.

### 3.9 Color System

A single semantic palette is shared by every dashboard. Decorative color choices are not permitted outside this palette.


| Token | Hex | Usage |
| --- | --- | --- |
| Brand Navy | #1B2A49 | Headers, primary text, active navigation |
| Brand Blue | #2E5AAC | Actual-value series, links, primary buttons |
| Neutral Grey | #595959 / #F2F2F2 | Secondary text / card & table backgrounds |
| Success Green | #2E7D32 | Target achieved or exceeded |
| Watch Amber | #B8860B | Within 10% below target |
| Alert Red | #C0392B | More than 10% below target / negative variance |
| Last-Year Grey | #8C8C8C | Historical comparison series only |

The green/yellow(amber)/red thresholds (on-target, within 10%, beyond 10%) are inherited unchanged from the Tachometer and ASP indicator logic already in production, and must remain the single source of truth for any future traffic-light visual.


### 3.10 Typography

- Single typeface family across the platform (a geometric sans, matching the current BMH wordmark style) with a maximum of four weights: Regular, Medium, Semibold, Bold.
- Type scale: H1 28–32px, H2 22–24px, H3 18–20px, Body 14–15px, Caption/label 11–12px.
- Numeric KPI values always use tabular (monospaced-width) figures so columns of numbers align.

### 3.11 Icons

- One icon library only, line-style (not mixed line/solid), 20px default size.
- Reserved icons carried over from the current system: the circular "i" for interactivity/drill-down, the home icon and refresh icon in the top-left utility cluster of the Critical Number page.
- Icons are never the sole carrier of meaning — always paired with a text label or accessible tooltip.

### 3.12 Company Branding

- BMH group branding is present on every page header; the specific business-unit logo (Majaal/Tika) reflects the current Business Unit filter selection and updates dynamically.
- The partner logo row (Athens, SMG, etc.) from the current manual guide's page footers/headers is retained as a fixed brand strip and is not user-configurable.

### 3.13 White Space Rules

- Minimum 16px gutter between cards/charts in the content grid; minimum 24px margin between the content zone and the sidebar/header.
- No dashboard may exceed roughly 70% visual density (ink-to-whitespace ratio) per screen — if a page needs more than ~8–10 cards/charts, it must be split into a summary page plus a drill-down/detail page (as already done for Customer Status → Customer Status Details View).

### 3.14 Grid System

- A 12-column responsive grid underlies the content zone. KPI cards typically span 2–3 columns; primary trend charts span 6–8 columns; detail tables span the full 12 columns.
- Row heights are standardized in three sizes — compact (KPI row), medium (single chart), tall (combination chart / classification donut) — so any two dashboards built by different teams remain visually aligned.

### 3.15 Responsive Behavior

- Breakpoints: Desktop ≥ 1280px, Tablet 768–1279px, Mobile < 768px.
- Above 1280px, the grid renders as designed; between 768–1279px, charts collapse from multi-column to full-width stacked; below 768px, KPI cards collapse to a 2-column grid and charts to single column.

### 3.16 Mobile Support

- Filters move from a persistent sidebar to a bottom-sheet / drawer triggered by a filter icon in the header.
- Only the top 3–5 KPIs and the single most important chart are shown "above the fold"; secondary visuals are reachable by scroll, not hidden.
- Tables switch to a card-per-row layout on mobile (no horizontal scrolling tables).

### 3.17 Tablet Support

- Sidebar remains visible but collapses to icon-only by default, expandable on tap.
- Chart grid reduces from the desktop's multi-column arrangement to at most 2 columns.

### 3.18 Desktop Standards

- Minimum supported width 1280px; layouts are optimized up to 1920px, beyond which content is centered with max-width constraints rather than stretched.

### 3.19 Dark Mode Strategy

- Dark mode is a platform-level toggle (not per-dashboard). Color tokens are defined as light/dark pairs from the start (e.g., Brand Navy background becomes off-white text) so no dashboard needs bespoke dark-mode work.
- The green/amber/red semantic scale keeps the same hue in dark mode but with adjusted luminance for contrast (WCAG AA minimum against the dark background).

### 3.20 Component Consistency

- A single shared component library (buttons, cards, filter chips, KPI tiles, chart wrappers, tables, gauges) is the only building block set future dashboards may use — no one-off bespoke components per department.
- Any new component proposed by a department must be reviewed and added to the shared library before use, never built inline for a single page.

### 3.21 Loading States

- Every card/chart shows a skeleton placeholder (matching its final shape) while data loads — never a blank white card or a generic spinner alone.
- If a refresh is in progress, the page shows a subtle top-of-page progress bar rather than blocking the whole screen.

### 3.22 Empty States

- When a filter combination returns no data, the affected card/chart shows a short explanatory message (e.g., "No invoices for the selected filters") plus a one-click "Reset filters" action — never an empty chart frame with no explanation.

### 3.23 Error States

- Data or refresh errors are shown inline on the affected card only (not as a full-page failure) with a retry action, and are also logged per Section 5.11 (Logging).
- A stale-data banner appears automatically if Last Refresh Time exceeds the expected schedule by more than one missed cycle, extending today's manual "always check Last Refresh Time" guidance into an automated signal.

### 3.24 Export Buttons

- Every dashboard exposes a standard export control in the header-right action cluster, supporting at minimum PDF (full page) and Excel/CSV (underlying table data of the active visual).
- Exports always stamp the applied filters and the Last Refresh Time on the exported artifact so a downloaded file is self-describing.

### 3.25 Print Layout

- A dedicated print stylesheet removes the sidebar and navigation chrome, forces a white background, and reflows the content grid to a single column sized for A4/Letter.
- Filter context and Last Update / Last Refresh Time are always printed as a footer line, since a printed page has no interactive way to reveal them.

### 3.26 Dashboard Naming Convention

Every dashboard, page, and visual title follows one naming grammar:

- Dashboard (app) name: [Company/Group] – [Department] Dashboard, e.g., "BMH – Sales Dashboard."
- Page name: Short, 1–3 word noun phrases matching the pattern already in production — Tachometer, Critical Number, Revenue Trend, Invoices Engine, Customer Growth — never a full sentence or a verb phrase.
- Visual/card title: Metric + Period, e.g., "YTD Value," "MoM ASP," "Avg Sales per Invoice" — matching current conventions exactly.
- Internal object naming: snake_case for tables/fields in the data layer (e.g., invoice_class, ytd_value), PascalCase for measures (e.g., YTD Value, Missing Value YTD) — see also Section 5.5 Data Dictionary.

## 4. Filter Standards

The filter experience must be identical in every dashboard. This section formalizes the filter set already observed across the Tachometer, Critical Number, Revenue Trend, Invoices Engine, and Customer Growth pages into one platform-wide contract.


### 4.1 Global vs. Local Filters

- Global filters: apply platform-wide and persist as the user moves between pages within the same dashboard: Company/Business Unit, Customer Group, Specific Date (From/To).
- Local filters: are scoped to a single page or visual and reset when the user leaves that page: Distribution Channel, POS, Branch, Sales Person, and the detail-view Status slicer (as seen in the Customer Status Details View, which explicitly resets on entry).
This mirrors an explicit distinction already present in the source system: the Customer Growth filters panel documents that Business Unit and Customer Group are dynamic/global while Distribution Channel, POS, Branch and Sales Person are locked/local on the Critical Number page, and the Customer filter is scoped to "this report page" only on the Customer Growth page.


### 4.2 Default Filters

- Company/Business Unit defaults to "All" (both Majaal and Tika) unless the signed-in user's role scopes them to one company.
- Specific Date defaults to From = start of the current fiscal year, To = the latest date with a successful refresh (i.e., "today" per Last Update).
- Customer Group, Distribution Channel, Branch, and Sales Person default to "All."

### 4.3 Required vs. Optional Filters

- Required: Specific Date (From/To) is always present and always has a valid value — a dashboard may never render with a null date range.
- Optional: every dimensional filter (Customer Group, Distribution Channel, Branch, Sales Person, Customer, Product, Region) may be left at "All" and is never mandatory for the page to render.

### 4.4 Date Filter Behavior

- A single From/To "Specific Date" control drives every time-based calculation on the page; there is no separate hidden date filter.
- MTD (Month-to-Date): from the start of the selected month up to the selected date.
- YTD (Year-to-Date): from the start of the selected year up to the selected date.
- Trend charts always render a full 12 months on the x-axis: actual values up to the latest available month, and target-only values for future months — preserving full-year visibility even mid-year, exactly as implemented on the Revenue Trend page.

### 4.5 Company / Business Unit Filter

- Values: Majaal, Tika, All. Selecting a single company automatically swaps the business-unit logo in the header (Section 3.12) and scopes every KPI, chart, and table on the page.

### 4.6 Business Unit Filter

Used interchangeably with "Company" in the current system; standardized going forward as a single filter labeled "Business Unit / Company" to avoid duplicate, redundant controls (see also Section 5.4, Naming Conventions).


### 4.7 Product Filter

Not present in the current Power BI pages (which are sales/customer-centric) but required for the Production (Product) dashboard defined in the 7P mapping. Standard: single-select-with-search dropdown, defaulting to "All," scoped by the active Business Unit.


### 4.8 Customer Filter

- A dedicated Customer search filter, added platform-wide per the Customer Growth page's "Important Update," allows direct search and analysis of an individual customer across every visual on a page.
- Customer-level filters apply only to the current report page and are not synchronized across pages by default (see Section 4.11) — a deliberate, documented exception to global-filter persistence, retained to prevent an accidental single-customer lens leaking into unrelated dashboards.

### 4.9 Region Filter

Not present today; to be introduced as an optional dimensional filter (values sourced from the Branch/Distribution dimension) once Supply Chain and multi-region reporting are built in later phases.


### 4.10 Salesperson Filter

- Standard multi-select-with-search dropdown, defaulting to "All."
- Role-based restriction: for users in a Salesperson role, every other filter is locked except their own name, and the dashboard shows only their own data — a security rule inherited unchanged from the current Tachometer page and generalized into the RBAC model in Section 5.2.

### 4.11 Search Behavior

- Any filter with more than ~15 possible values (Customer, Salesperson, Product, Branch) must offer type-to-search inside the dropdown; filters with fewer values (Company, Customer Group, Distribution Channel) use a plain multi-select list.

### 4.12 Multi-Select Rules

- Customer Group is multi-select (as already implemented); Business Unit, Distribution Channel, Branch, and Sales Person are single-select-or-All by default, with multi-select available where a future department explicitly requires cross-segment comparison.
- A multi-select filter with zero values selected is always treated as "All," never as "none" (which would silently blank every visual).

### 4.13 Reset Filters

- Every filter panel includes a single "Reset filters" action that restores all defaults defined in Section 4.2 in one click.
- Empty-state cards/charts (Section 3.22) always surface this same reset action inline, not only in the sidebar.

### 4.14 Saved Filters

Not present in the current system. Standard for future phases: users may save a named combination of filter values as a personal view; saved views are personal by default and are never treated as a change to platform-wide defaults.


### 4.15 Filter Synchronization Across Pages

- Global filters (Section 4.1) persist automatically when navigating between sibling pages of the same dashboard (e.g., Tachometer → Critical Number → Revenue Trend).
- Local filters do not carry over and reset to their defaults on navigation — this includes the explicit reset-on-entry behavior already required for the Customer Status Details View.
- Filters never persist across different dashboards/departments (e.g., moving from the Sales dashboard to the Production dashboard always starts from default filters).

### 4.16 Performance Considerations

- Filter panels query dimension tables only (never the fact table directly) to populate their value lists, so opening a filter never triggers a full fact-table scan.
- Changing a filter should not force a full-page reload; only the visuals dependent on the changed filter re-query, following the same interactive cross-filter model already used in Power BI.
- Filter value lists are cached and refreshed on the same 5x-daily schedule as the underlying data (Section 5.14), not queried live on every page open.

## 5. Platform Standards

Beyond visual design and filtering, a set of cross-cutting platform standards must be fixed before development starts, so that every dashboard generated across all seven phases behaves consistently at the system level.


### 5.1 Navigation Rules & Dashboard Hierarchy

The platform has three navigation levels, mirroring the 7P mapping in Section 2.3:

- Level 1 — ExCo: the consolidated executive view; entry point for GCEO/GCCO/GCFO-tier users.
- Level 2 — Department Dashboard: one per 7P department (Sales, Production, Supply Chain, HR, HSE, Excellence, Finance).
- Level 3 — Pages within a dashboard: e.g., within Sales: Tachometer, Critical Number, Revenue Trend, Invoices Engine, Customer Growth.
- A user always knows their position in this hierarchy via the header (Level 2 dashboard name) plus the tab bar (Level 3 page name), plus breadcrumbs on any drill-down (Level 4, e.g., Customer Status Details).

### 5.2 User Roles & Permissions

The current BI-license tiers and department access roles are adopted as the baseline RBAC model and extended to the web platform:


| Tier | Example Roles | Scope |
| --- | --- | --- |
| Executive (BI 00) | GCEO, GCCO, GCFO | All departments, all companies, ExCo dashboard |
| Director (BI 01 / BI 02) | B2B Directors, B2C Directors | Sales-related dashboards scoped to their channel |
| Company Executive (BI 03) | Tika CEO, GCTO | All dashboards scoped to a single company |
| Department Head | HR Manager, Production Head, HSE Committee, CFO, Excellence Manager | Their own department dashboard only, per Section 5's Role-Based Access table |
| Individual Contributor | Salesperson | Own data only, all other filters locked (Section 4.10) |

- Permissions are enforced with Row-Level Security at the data layer (not just hidden UI elements), so a restricted user cannot see another scope's data even via export or API.
- Every dashboard/page declares its allowed roles in a manifest at build time, generated from the same Role-Based Access table maintained by the platform owner — this keeps AI-generated dashboards from accidentally shipping without an access rule.

### 5.3 Dashboard Hierarchy Ownership & Sign-off

- Each department dashboard has one accountable Department Head who defines its KPIs and approves it before go-live, per the existing Roles & Responsibilities table.
- The Data Analyst role coordinates requirements, data modeling, and cross-department consistency; the CFO Sponsor owns data access and system support; the Project Initiator owns KPI approval and strategic alignment.

### 5.4 Naming Conventions

Naming rules apply at every layer of the stack so that AI-generated code, data, and UI never drift into inconsistent terms:


| Layer | Convention | Example |
| --- | --- | --- |
| Dashboard/app | [Group] – [Department] Dashboard | BMH – Sales Dashboard |
| Page | 1–3 word noun phrase | Revenue Trend |
| Visual/KPI title | Metric + Period | YTD Value, MoM ASP |
| Database table | snake_case, singular domain noun | invoice, customer, sales_target |
| Database field | snake_case | invoice_class, ytd_value |
| Measure/DAX-equivalent | Pascal Case With Spaces | Missing Value YTD |
| Filter label | Title Case, business term not DB term | Distribution Channel (not dist_chnl) |


### 5.5 Data Dictionary

A living data dictionary is a required deliverable of every future phase before its dashboards are built. Minimum fields per entry:

- Business term and definition (plain language, department-approved).
- Underlying table.field it maps to.
- Unit of measure and expected range.
- Owning department and last-reviewed date.
Starter entries already implied by the current system include: Value (sales revenue), Volume (quantity sold), ASP = Value ÷ Volume, Critical Number (required daily value to stay on annual pace), Missing Days YTD, Missing Value YTD, Invoice Class A–D (>50K, 25–50K, 5–25K, <5K), and the four Customer Status categories (Active Retained, Non-Active, Reactivated, Blocked). These must be transcribed into the formal data dictionary rather than left only in page-level documentation.


### 5.6 KPI Definition Standards

- Every KPI must state, at minimum: formula, time-grain (Daily/MTD/YTD), comparison basis (vs Target, vs Last Year, vs Last Period), and color-coding rule if any.
- Variance KPIs always use the same formula platform-wide: Variance % = (Actual − Target) ÷ Target, with positive = above target and negative = below target, exactly as defined on the Revenue Trend page.
- A KPI may not be redefined per department; if two departments need a similarly named but differently calculated metric, they must use visibly distinct names (e.g., "Sales ASP" vs "Production ASP").

### 5.7 Business Terminology Glossary

A shared glossary prevents the same word meaning different things in different dashboards. Minimum starter terms (carried from the current manual): YTD, LYTD, MTD, LMTD, FLY (Full Last Year), FLM (Full Last Month), FY Target, FM Target, Working Day, Forced Closure Day, Churn Rate, Retention Rate, Customer Acquisition Rate, Customer Growth Rate.


### 5.8 Component Library

See Section 3.20. Governance rule: the component library is versioned; a breaking change to a shared component requires regression-checking every dashboard that consumes it before release, not just the page that requested the change.


### 5.9 Error Handling

- Three tiers of error are distinguished and handled differently: (1) data/refresh errors — inline card-level message + retry (Section 3.23); (2) permission errors — a clear "you do not have access to this view" screen, never a blank or broken page; (3) system errors — a generic fallback screen with an incident reference number for support.
- No error may expose raw database errors, stack traces, or internal table/field names to an end user.

### 5.10 Accessibility

- Minimum WCAG 2.1 AA: 4.5:1 text contrast, all interactive elements keyboard-reachable, all icons paired with text or aria-labels (Section 3.11).
- Color is never the only signal — the green/amber/red target status is always paired with a numeric value or label (already true of every existing KPI card, which show the number alongside the color).

### 5.11 Logging

- Every dashboard load, filter change, export, and drill-down interaction is logged with user id, role, timestamp, dashboard/page, and applied filters — feeding both the audit trail (5.12) and platform usage analytics.
- Refresh jobs log start time, end time, row counts, and success/failure per source (Odoo, Excel, manual logs), extending the existing Last Update/Last Refresh Time display into a queryable history rather than only the latest value.

### 5.12 Audit Trail

- Changes to KPI definitions, filter defaults, access roles, and dashboard structure are versioned with who/when/what-changed — required given the platform's future scale across seven departments and two companies.
- Audit records are retained for a minimum of 24 months and are exportable for compliance/HSE review.

### 5.13 Notifications

- System notifications (bell icon, Section 3.2) cover: refresh failures, stale-data warnings (Section 3.23), threshold breaches (e.g., a KPI crossing into red), and access-request approvals.
- Notifications are role-scoped — a Salesperson is notified only about their own thresholds; a Department Head about their whole department; ExCo about cross-department exceptions.

### 5.14 Export Standards

See Section 3.24. Platform-wide rule: every export (PDF, Excel, CSV) embeds the filter context and Last Refresh Time in the file itself (header/footer or a dedicated metadata sheet) so a downloaded report is self-describing weeks later.


### 5.15 Performance Standards

- Target initial page load: under 3 seconds on a standard broadband connection for a page with up to ~10 KPI cards and 3 charts.
- Target filter-change response: under 1.5 seconds for a re-query against the recommended data-warehouse layer (Section 6).
- Any visual expected to exceed these budgets (e.g., a full customer-level table with 10,000+ rows) must implement pagination or virtualization rather than rendering the entire result set.

### 5.16 Caching Strategy

- Aggregated KPI values are cached at the same cadence as the source refresh (5x/day) — there is no benefit to querying the warehouse more often than the source data changes.
- Filter value lists (Section 4.16) and the data dictionary/glossary are cached with a longer TTL (e.g., 24 hours) since they change far less often than transactional data.
- Cache invalidation is tied explicitly to the scheduled refresh job completing successfully — a failed refresh must not silently serve stale cache without the stale-data banner (Section 3.23) appearing.

### 5.17 Version Control

- All dashboard definitions, KPI formulas, and component-library code are stored in a version-controlled repository, with department sign-off (Section 5.3) required before merging a change that affects a published dashboard.
- Semantic versioning is applied to the shared component library and to the data model (schema) so downstream dashboards can pin a known-compatible version during the transition from Power BI.

### 5.18 Documentation Standards

- Every dashboard ships with an accompanying short "About this page" write-up (purpose, refresh schedule, filters, important notes, tips & best practices) — precisely the structure already used for each page in the current manual guide, and to be reused as the documentation template for every future AI-generated dashboard.
- Documentation is generated/updated alongside the dashboard itself as part of the same build, not as a separate manual step performed after the fact — reducing the risk of the documentation drifting from the live dashboard.

## 6. Database Review

The current database was designed primarily to feed the existing Power BI dashboards. This section assesses whether that structure is scalable enough for the remaining six phases of the 07 Ps Project, which will add Production, Supply Chain, HR, HSE, Excellence, and full Finance reporting on top of today's Sales-and-Customer-centric model.


### 6.1 Current Architecture Summary


| Component | Current State |
| --- | --- |
| Sources | Odoo ERP (Sales, HR, Finance, Production modules), Excel (targets, finance inputs), manual logs where applicable |
| Model type | Star Schema |
| Fact tables | Sales, Production, Finance |
| Dimension tables | Date, Product, Customer, Employee |
| Security | Row-Level Security (RLS) |
| Refresh | Scheduled, 5x/day, up to 30-minute delay tolerance |


### 6.2 Strengths

- A true star schema is already in place rather than a flat/denormalized export — this is the correct foundational shape for BI workloads and should be preserved, not discarded, in the future architecture.
- Conformed Date, Product, Customer, and Employee dimensions already exist, which is exactly the reusable backbone needed to bring new fact tables (HR, HSE, Supply Chain) online without re-inventing shared dimensions.
- A working RLS model already exists and maps cleanly onto the multi-tier BI-license structure (BI 00–BI 03), which the web platform's RBAC (Section 5.2) can inherit directly.
- The 5x-daily refresh discipline, and the practice of surfacing Last Update/Last Refresh Time on every page, is a mature operational habit that should be retained as-is.

### 6.3 Identified Weaknesses

- Fact-table coverage is narrower than the program's scope: only Sales, Production, and Finance facts exist today; HR, HSE, Supply Chain, and Excellence have no corresponding fact tables yet, meaning four of the seven planned department dashboards currently have no dimensional model to draw from.
- No visible fact table for Targets: Value/Volume/ASP targets currently appear to live in Excel inputs rather than a governed target/plan fact table, which is a scalability and single-source-of-truth risk once every department needs its own targets (Critical Number-style logic) rather than only Sales.
- No explicit Invoice-grain fact: the Invoices Engine page's line/volume/value-per-invoice metrics imply an invoice (and invoice-line) grain that may currently be derived on top of the Sales fact rather than modeled as its own fact table — this should be confirmed and, if needed, formalized.
- Working-day / calendar-exception data appears to live outside the Date dimension: Weekly Rest Days, Official Holidays, and Forced Closure Days (used by the Critical Number page) look like separate reference lists rather than attributes on a conformed Date/Calendar dimension, risking inconsistent working-day counts if any two dashboards calculate them independently.
- Customer Status is calculation-derived, not stored: Active Retained / Non-Active / Reactivated / Blocked status is computed live by comparing YTD vs LYTD purchase behavior. This is reasonable at current scale but will not scale cleanly once HR (employee status), HSE (incident status), and Supply Chain (vendor status) need similar current/historical-state comparisons — a general "entity status/state" pattern should be standardized once, not re-derived per domain.
- Manual logs are an ungoverned source: "Logs (if applicable per department)" as a source type is acceptable as an interim measure but is the weakest link in data quality and lineage; it does not currently have a defined validation or ingestion standard.
- No explicit data-warehouse layer between Odoo and the BI tool: Power BI appears to model directly against extracts of the source systems. This is workable for one reporting layer but becomes fragile once a second consumer (the new web application) needs the same numbers — two systems querying two different transformation paths is a classic source of "why don't the numbers match" incidents.

### 6.4 Should a Data Warehouse / Dimensional Model Be Introduced?

Yes. The recommendation is not to replace the existing star schema thinking — it is already correct — but to relocate it out of the BI tool and into a proper managed data warehouse layer that both Power BI (during transition) and the new web application can query identically.

- Introduce a dedicated analytical data warehouse (cloud or on-prem, to be selected based on existing infrastructure and budget) as the single computation layer for every fact and dimension.
- Keep the star-schema approach, but expand it deliberately: add Target/Plan, Invoice, HR/Employee-event, HSE/Incident, and Supply Chain/Procurement fact tables as each phase is built, all conformed to the existing Date, Product, Customer, and Employee dimensions plus a new shared Branch/Location dimension.
- Model working-day/holiday/closure data as attributes of a proper Calendar dimension (is_working_day, is_holiday, is_forced_closure flags) rather than as separate ad hoc lists, so every department's "pace vs target" logic (the Critical Number pattern) reads from one governed source.
- Introduce a lightweight "entity status/state history" pattern (a slowly changing dimension, Type 2) that can serve Customer Status today and Employee Status, Vendor Status, or Asset Status in later phases without re-deriving the same logic four separate times.
- Replace ungoverned manual logs with a structured intake (even a simple validated spreadsheet template or lightweight form) that lands in the warehouse through the same pipeline as ERP data, rather than being consumed ad hoc.

### 6.5 Best Practices for Supporting Future Dashboards

- One conformed dimension per business concept, reused by every fact table — never a department-specific copy of Date, Product, Customer, or Employee.
- Every new fact table is designed against the KPI Definition Standards (Section 5.6) before it is built, so the grain of the table matches the grain the KPI actually needs (e.g., invoice-line grain if per-line efficiency metrics are required).
- Historize slowly-changing attributes (customer group, employee department, branch hierarchy) with Type 2 tracking so historical dashboards remain accurate even after a customer or employee is reclassified.
- Keep the refresh cadence and RLS approach that already work well; extend both to every new fact table rather than inventing a different refresh or security pattern per department.
- Establish the data dictionary (Section 5.5) and KPI catalog (Section 5.6) as build gates — no fact table or dashboard ships without its dictionary entries and KPI formulas approved first.

## 7. Future Scalability Recommendations

These recommendations look beyond Phase 1 and describe how the platform should evolve as Phases 2–7 add Production, Supply Chain, HR, HSE, Excellence, and full Finance dashboards.


### 7.1 Architecture

- Adopt the data warehouse layer described in Section 6.4 before, or in parallel with, the first non-Sales dashboard build, so departments 2 through 7 are never built directly against source ERP tables.
- Design the web application's own data-access layer to read exclusively from the warehouse (never from Odoo directly), so the eventual Power BI retirement is a switch of presentation layer only, not a re-plumbing of the whole pipeline.

### 7.2 Platform

- Build the shared component library (Section 3.20/5.8) and design tokens (Section 3.9–3.10) before the second department dashboard, so Sales does not become a one-off that later dashboards must awkwardly retrofit into.
- Stand up the RBAC/permissions manifest model (Section 5.2) generically enough that adding a new department (e.g., HSE) is a configuration change, not a code change.

### 7.3 Governance

- Assign a Department Head and complete the data dictionary/KPI catalog for each department before its dashboard enters development — mirroring the sign-off discipline already used for Sales.
- Run a lightweight architecture review (reusing this document as the checklist) at the start of each of the remaining six phases, updating Sections 3–6 as new patterns are discovered rather than letting each phase invent its own standards.

### 7.4 Scale & Volume

- Plan capacity assuming all seven departments, both companies, and multiple years of history are queried simultaneously by ExCo dashboards — the heaviest realistic workload — rather than sizing only for today's single-department load.
- Introduce incremental refresh / partitioning by date on large fact tables (Sales, Invoices, Production) as history accumulates, consistent with the mitigation already identified for Power BI performance issues in Section 9.

## 8. Best Practices


### 8.1 Design & Development

- No dashboard ships without passing the Section 3 design checklist and the Section 4 filter checklist — treat both as a literal pre-release checklist, not aspirational guidance.
- Reuse before building: check the shared component library and existing KPI catalog before creating a new visual type or metric definition.
- Every new KPI is validated against at least one prior period of known-good data before going live, matching the existing "department sign-off" governance step.

### 8.2 Data

- Always distinguish between "latest successful refresh" and "live data" in both the UI (Section 3.23) and in any conversation about the numbers — this single discipline, already present on every existing page, is one of the most important habits to carry forward.
- Financial reports remain the final, official source of truth for statutory/financial purposes; BI dashboards are indicative/operational tools — this existing rule is retained unchanged.

### 8.3 Operations

- Treat the data dictionary, KPI catalog, and this standards document as living artifacts with a named owner and a review cadence (e.g., each phase kickoff), not a one-time deliverable that goes stale.
- Track every phase, task, and sign-off in the existing Notion workspace so the standards defined here and the delivery plan remain in the same system of record.

## 9. Risks & Mitigation

The two risks already identified for the current Power BI system remain valid for the new platform and are carried forward, alongside additional risks specific to standardizing and scaling across seven departments.


| Risk | Impact | Mitigation |
| --- | --- | --- |
| Data access delays (Odoo/external sources) | Dashboards show stale or incomplete data at refresh time | Use dev snapshots, API fallback, early IT escalation (existing mitigation, retained) |
| Power BI / platform performance issues under large or complex models | Slow dashboards, poor adoption | Optimize the model, use incremental refresh, schedule off-peak refreshes (existing mitigation, retained); apply the same principle to the new warehouse layer |
| Standards drift across seven departments built by different teams/AI sessions | Dashboards stop looking/behaving like one platform, defeating the purpose of Phase 1 | Treat Sections 3–5 as a mandatory pre-release checklist; version the component library; require sign-off referencing this document for every new dashboard |
| Fact-table gaps (HR, HSE, Supply Chain, Excellence) block later phases | Phases 2–7 stall waiting on data modeling that should have started earlier | Begin the warehouse expansion (Section 6.4) ahead of each phase's dashboard build, not concurrently with it |
| Manual/ungoverned log sources | Data quality and lineage risk, harder to audit | Replace with structured, validated intake feeding the same pipeline as ERP data |
| Running two parallel reporting systems during transition (Power BI + new web app) | Numbers may disagree between systems, eroding trust | Both systems read from the same warehouse layer as soon as it exists, rather than each having its own transformation path |
| Role/permission misconfiguration as RBAC scales to more departments | Data exposed to, or hidden from, the wrong users | Enforce RLS at the data layer (not just UI), require an access manifest per dashboard, and audit access changes (Section 5.12) |


## 10. Recommendations & Next Steps


### 10.1 Immediate (before Phase 2 begins)

- Formally adopt Sections 3–5 of this document as the binding standard for all future AI-generated dashboards.
- Stand up the data dictionary and KPI catalog (Section 5.5–5.6), seeded with the terms already identified from the current Power BI manual.
- Commission the data-warehouse expansion described in Section 6.4, prioritizing a Target/Plan fact table and a proper Calendar dimension, since both are prerequisites for any department beyond Sales to reuse the Critical Number pattern.

### 10.2 Short-Term (during Phase 2)

- Build the shared component library and design tokens before building the first non-Sales department dashboard.
- Confirm and formalize the RBAC manifest model so department access can be configured rather than coded per dashboard.

### 10.3 Ongoing

- Review this standards document at the start of every subsequent phase and update it with any new pattern discovered, so the foundation keeps pace with the platform it is meant to govern.
- Maintain the existing operational disciplines that already work well — the 5x-daily refresh cadence, Last Update/Last Refresh Time transparency, and department sign-off — unchanged, since Phase 1's goal is to formalize and extend proven practice, not to discard it.
End of Phase 1 deliverable.
