# Phase P1/P2 Delivery Status — Mapped to Standards Sections

Scope: this session delivered the platform foundation only (Migration Plan Phases P1 and P2).
No Sales pages (Tachometer, Critical Number, Revenue Trend, Invoices Engine, Customer Growth)
were built — that is Phase P3, and depends on everything below being reconciled and signed off.

## 1. Tech stack decision → `docs/tech-stack-decision.md`

Every choice (Next.js/TS/Tailwind frontend, Node/Express + Postgres-native RLS backend,
PostgreSQL warehouse, Python ingestion, Libyan Spider VPS + Docker Compose hosting, JWT/manifest
RBAC, logo-derived design tokens) is written up there with its "why this, not the alternative"
reasoning and its Standards section citation. Not repeated here.

## 2. Project scaffold → repo root, `frontend/`, `backend/`, `packages/ui/`, `data/`

| Delivered | Standards section |
| --- | --- |
| `packages/ui` as its own package (`@07ps/ui`), semantically versioned at 0.1.0 | 5.17 (version control / semver of component library), 3.20/5.8 (single shared component library) |
| npm workspaces linking `frontend`, `backend`, `packages/ui` | 5.17 |
| ESLint + Prettier (Node/TS) and Ruff + Black (Python), enforced in CI | 5.4 (naming/consistency), 7.2 ("configuration change, not a code change" implies consistent tooling) |
| `.github/workflows/ci.yml` — lints frontend/backend/UI, lints+formats Python, and applies every SQL migration against a real throwaway Postgres instance | 5.17, 9 (risk: "standards drift across seven departments... version the component library") |
| `docs/07Ps_Phase1_Architecture_Standards.md` and `docs/Sales_Promotion_Dashboard_Migration_Plan.md` — converted from the source .docx to Markdown and committed alongside the code | Kickoff prompt requirement #3 ("version-controlled alongside the code, not just living in a separate file share") |

## 3. Database connection / schema → `data/warehouse/`

| Delivered | Standards section |
| --- | --- |
| `dim_date`, `dim_business_unit`, `dim_product`, `dim_customer`, `dim_employee` (existing conformed dimensions, preserved) | 6.1, 6.2 |
| `dim_branch` — new shared Branch/Location dimension | 6.4 |
| `fact_sales`, `fact_production`, `fact_finance` (existing facts, relocated into the warehouse) | 6.1, 6.2, 7.1 |
| `fact_invoice_line` — new invoice-grain fact (previously only implied/derived) | 6.3 weakness, Migration Plan 6.2 (Phase P1 exit criterion item) |
| `fact_target_plan` — new Target/Plan fact table, replacing Excel-only targets | 6.3/6.4 blocking gap #1, Migration Plan 6.2 |
| `dim_calendar_flags` (`is_working_day` / `is_holiday` / `is_forced_closure`) | 6.3/6.4 blocking gap #2, Migration Plan 6.2 |
| `entity_status_history` — generic Type-2 SCD pattern for Customer Status today, Employee/Vendor/Asset status later | 6.4, 6.5 |
| `role_tier`, `dashboard`, `role_dashboard_access` — RBAC manifest, seeded for the Sales dashboard and all 6 existing role tiers | 5.2, 7.2, Migration Plan 6.1 (P0 exit criterion) |
| `refresh_log` | 3.23, 5.11, 5.14 |
| `0007_rls_policies.sql` — Postgres-native RLS enabled + FORCED on every fact table and `dim_employee`, with a shared `ps_row_allowed()` predicate covering company scope and the Salesperson own-data rule | 5.2 (server-side enforcement, not UI-only), 4.10 |
| `data/warehouse/seed/seed.sql` — small, obviously-fake sample data so the schema is runnable today | Kickoff prompt requirement #4 ("even if seeded with sample data pending real Odoo access") |
| `data/ingestion/` — real Odoo XML-RPC connector + real Excel parsing, config-driven, 5x-daily scheduler (9/12/3/6/9), `refresh_log` writes | 7.1, 6.1, 5.14, 5.11 |

**Verification performed in this session:** all 7 migration files and the seed script were checked
for balanced syntax with `sqlparse` (no local Postgres was available in this sandbox to run them
directly); `.github/workflows/ci.yml`'s `sql` job applies every migration + seed against a real
`postgres:16` service container on every push, so the first CI run is the actual functional proof.
Python ingestion modules were compiled (`py_compile`) and linted clean with Ruff/Black.

## 4. Design layout foundation → `frontend/`

| Delivered | Standards section |
| --- | --- |
| `frontend/src/styles/tokens.css` — light/dark CSS-variable token pairs, colors derived from the BMH/Majaal/Tika logo files (see tech-stack-decision.md §7), not the Standards doc's placeholder hex values | 3.9, 3.19 |
| `packages/ui/src/tokens/` — the same tokens as typed TS constants, consumed by both the shared component library and `tailwind.config.ts` so nothing can drift | 3.9, 3.10 |
| `Header` — BMH logo always present, Majaal/Tika logo swaps on Business Unit selection, partner badge row (Athens/SMG stubbed — files not provided this session), refresh/export/notification icons, dark-mode toggle | 3.2, 3.12, 5.13 |
| `SidebarFilters` — fixed order (Business Unit → Customer Group → Distribution Channel → POS → Branch → Salesperson → Specific Date), locked/greyed-out state demo for the Salesperson role, sticky Last Update/Refresh footer, Reset Filters | 3.4, 4.1–4.13 |
| `NavTabBar` — bottom tab bar listing the 5 Sales pages (disabled — Phase P3 builds them), active-tab styling | 3.3 |
| `LoadingSkeleton`, `EmptyState`, `ErrorState`, `StaleDataBanner` — from `@07ps/ui`, wired into the demo page's state switcher | 3.21, 3.22, 3.23, 5.9 |
| `RefreshFooter` | 3.19, 5.11 |
| `KpiTile`, `Card`, `Gauge`, `DataTable`, `FilterSelect`, `SemanticBadge` in `@07ps/ui` | 3.5, 3.6, 3.7, 3.8, 3.9, 5.10, 4.11/4.12 |
| No Sales pages built | Migration Plan 6.3 exit criterion (explicit non-goal for this phase) |

## 5. Open items requiring the Data Analyst / IT (not resolved in this session)

- Odoo's exact `sale.order.line` field customizations need confirming during Phase P0 sign-off
  before `scheduler.py`'s marked `TODO` (Odoo row → `fact_sales`/`fact_invoice_line` mapping) can
  be completed.
- Athens and SMG partner logo image files were not included in this session's logo folder — the
  header's partner badge row is text-stubbed pending the actual files.
- Network path from the Libyan Spider VPS to Odoo (VPN / IP allowlist / replica) is an
  infrastructure decision for IT, not resolved by this codebase.
- The current Excel target-file template's exact column layout should be confirmed against
  `data/ingestion/excel_ingest.py`'s `REQUIRED_COLUMNS` during Phase P0.

## 6. Tachometer page (backend wiring + UI) → `backend/src/measures/`, `backend/src/routes/`, `frontend/src/`

Scope: this session built the Tachometer page end-to-end — the first live Sales page (Phase P3
start), gated to run only against throwaway/validation data. The other four Sales pages (Critical
Number, Revenue Trend, Invoices Engine, Customer Growth) are not built; their nav tabs exist,
visible but disabled.

**Status-check answers requested at the start of this task, stated plainly:**

- The warehouse schema and Tachometer measures layer (`data/warehouse/measures/`) are validated
  against real historical data (the actual `SalesModel_OneOutput.xlsx` export loaded directly into
  the throwaway MySQL warehouse), not against any live system — see
  `data/ingestion/tachometer_kpi_validation.md`.
- There is no live Odoo connection anywhere in this stack, backend or frontend.
- The Google Drive input-intake decision is closed as an actually-implemented synced local folder
  (`INPUT_DIR` env var pointed at a Drive-synced path), not merely a decision on paper — see
  `data/ingestion/README.md` §"Google Drive intake." No OAuth/Drive-API integration exists or was
  built.
- This page runs against the throwaway/validation MySQL warehouse (`ps_warehouse`, direct real-data
  loads bypassing the mocked-Odoo pipeline — see `tachometer_kpi_validation.md`), never production.
  This is stated in the UI itself via a persistent banner directly under the header (not just in
  code comments), per this section's own requirement.

**Note:** §2–4 above (Postgres/RLS-based schema and scaffold) describe an earlier point in this
project, since superseded by the MySQL pivot recorded in `tech-stack-decision.md` and
`data/warehouse/README.md`. That supersession is not rewritten into §2–4 here — flagged, not
silently corrected — since this section documents what changed *this* session (the RLS→MySQL
scope-enforcement port specifically), not the entire schema's history.

| Delivered | Standards section |
| --- | --- |
| `backend/src/measures/classify.ts`, `filters.ts`, `tachometer.ts`, `refreshStatus.ts` — 1:1 TypeScript port of the validated Python measures layer (`data/warehouse/measures/`), same function names/semantics, not re-derived | Kickoff requirement (treat Python + 40 tests as reference spec) |
| Architecture fork resolved by explicit user confirmation: port to TypeScript running against MySQL directly (not Python-as-internal-service) | Kickoff requirement (ask, don't silently choose) |
| 40 Python tests ported 1:1 to Vitest (`src/measures/__tests__/`), including the exact-10%-below `classify_vs_target` boundary case and all 5 Salesperson-lock RBAC cases — all 40 passing | Kickoff requirement (port test cases, not just logic) |
| `backend/src/middleware/scopeContext.ts` replaces the Postgres `SET LOCAL`/RLS approach with `applySalespersonLock()` enforced in the API layer; a cross-scope request throws `SalespersonLockError` → HTTP 403, never a silent redirect | 5.2 ("RLS-equivalent enforced server-side, not just hidden in the UI") |
| REST endpoints: `/filters/business-units,customer-groups,distribution-channels,branches,salespersons`, `/meta/refresh-status`, `/tachometer/overview` (YTD/MTD Value, Volume, ASP + LYTD/LMTD/FLY/FLM/FY-FM-Target + target-to-date + classification + variance) | Kickoff requirement (expose the listed endpoint set) |
| `packages/ui/src/components/Gauge.tsx` evolved from a ring/donut design to a semicircular needle gauge with a grey to-date-target marker and red/yellow/green zone arcs, matching the Tachometer manual exactly; disclosed as a deliberate evolution of the one shared Gauge, not a new one-off component, since nothing else depended on the old shape yet | 3.9 (single semantic color scale), 3.20/5.8 (one shared component library) |
| `packages/ui/src/components/GaugeCard.tsx` — composite (Card + Gauge + LoadingSkeleton + ErrorState + reference-metric tiles), reused for both the four gauges and the two ASP cards so ASP uses the *same* color-logic component, not a second implementation | Kickoff requirement (ASP cards "same color logic/component as gauges, not a separate implementation") |
| `frontend/src/app/page.tsx` — real Tachometer content (Header BU-logo swap wired to the Company filter, persistent validation-data banner, stale-data banner, four `GaugeCard`s with reference tiles, two ASP `GaugeCard`s, dev-role switcher, `EmptyState`/inline `ErrorState`-per-card/`LoadingSkeleton` wired to live fetch state) | 3.1–3.9, 3.21–3.23, Tachometer manual |
| `frontend/src/components/SidebarFilters.tsx` rewritten: real filter value-lists (Customer Group wired to `dim_segment`, not `CustomerSegment`), no POS filter (confirmed unused in real data), Salesperson lock rendered as greyed-out/disabled with the signed-in salesperson pre-selected and not editable, single "Specific Date" anchor input (see correction note below) | 3.4, 4.1–4.13, 4.10/5.2 |
| Responsive behavior implemented via CSS breakpoints in `globals.css` (Desktop ≥1280px full grid; Tablet 768–1279px icon-only-collapsible sidebar + 2-column gauge grid; Mobile <768px bottom-sheet filters via a header-triggered drawer + single-column gauges) | 3.15, 3.16, 3.17 |
| `backend/src/routes/devAuth.ts` + `frontend/src/lib/DevAuthProvider.tsx` — dev-only, production-disabled token mint, clearly labeled everywhere, built solely so the Salesperson RBAC lock could be demonstrated end-to-end against the real backend rather than only faked visually | Not a standards item — disclosed as necessary, out-of-scope-but-minimal infrastructure |

**Correction made and disclosed, not silently applied:** the manual's "Specific Date From/To"
filter is implemented as a single date input, not two independent From/To pickers. The backend's
`mtdWindow`/`ytdWindow` (data/warehouse/measures/filters.py, ported to filters.ts) only ever take
one anchor date — MTD is month-start→anchor, YTD is year-start→anchor. A two-input range picker
would have implied a backend parameter that doesn't exist.

**Tika logo quality (flagged per this task's requirement, user confirmed to proceed):** the only
available Tika asset (`frontend/public/logos/tika/tikalogo.png`) is 147×45px and GIF-format data
saved with a `.png` extension. Per the user's explicit confirmation this session, it is used as-is
in the header rather than a text fallback, flagged prominently here: this asset should be replaced
with a real, higher-resolution Tika mark before any real header/print use (Section 3.24/3.25 —
Export Buttons / Print Layout — since no section is actually dedicated to asset/logo quality
despite 3.2's in-text reference implying one).

**Verification performed in this session:** all 40 backend measures tests pass (`vitest run`,
re-confirmed after the devAuth/server.ts sync fix below); `backend/src` type-checks clean
(`tsc --noEmit`); the backend was smoke-tested end-to-end against the real throwaway MySQL
warehouse (executive role, Salesperson-locked role, cross-scope 403, no-auth 401 — all matching
`tachometer_kpi_validation.md`'s numbers exactly). The frontend's new/changed files
(`SidebarFilters.tsx`, `page.tsx`, `layout.tsx`, `lib/api.ts`, `lib/hooks.ts`, `lib/format.ts`,
`lib/DevAuthProvider.tsx`) were type-checked clean against the real `@07ps/ui` package sources in
an isolated harness (avoiding this sandbox's FUSE-mount npm slowness) — a full `next build` was not
run, since installing the whole monorepo's `node_modules` through the FUSE-mounted path repeatedly
timed out; this is a real gap versus a true production build check and should be re-run at a real
`next build` before deployment sign-off.

**Bug caught and fixed during this task, not left silent:** `packages/ui/src/components/index.ts`
was missing its `export * from './GaugeCard';` line on disk (a recurrence of the Edit-tool
truncation/desync issue already seen elsewhere this project) — GaugeCard existed and compiled fine
on its own but wasn't actually reachable via `@07ps/ui`'s public import surface until this was
caught by the typecheck harness and fixed. Separately, `backend/src/routes/devAuth.ts` and the
devAuth-aware `server.ts` had been built and tested in a scratch `/tmp` copy in this session but had
never been synced into this deliverable's real `backend/src/` — fixed and re-verified (40/40 tests,
clean `tsc`) as part of this update.

## 8. Tachometer design-quality pass (gauge bug fix + modernization) -> `packages/ui/`, `frontend/src/`

Scope: this pass fixed a real rendering bug and modernized the Tachometer page's visual polish.
No filters, pages, or data sources changed - same validation-data warehouse and endpoints as before.

**Screenshot caveat, confirmed per this task's own instruction:** the reference dashboard used for
style inspiration was NOT adopted wholesale. Not adopted: its extra pages (Pipeline Health,
Pipeline Trend, Activity Momentum, BCG1, Stock Velocity, PIM, TT Forced Closure), its extra filters
(Segment/Customer/Customer Status/Sales Team), and its "Phase 1 - live from
SalesModel_OneOutput.xlsx" header claim. Only the visual/interaction patterns explicitly listed
(icon+label+pill header row, progress bar under the headline, spacing/elevation/typography
discipline) were adopted. This page's own "running on validation data" banner is unchanged.

**The gauge bug, root-caused:** `Gauge.tsx` rendered its own raw, unformatted value via an internal
`<text>` positioned at `y = cy + 28 = 128`, inside a viewBox that was only 124 units tall - the
label's own baseline sat past the SVG's visible box. At the same time, `GaugeCard.tsx` separately
rendered a second, properly-formatted HTML label immediately underneath with a negative top margin
specifically to pull it close to the gauge. Two independently-positioned elements, in two different
coordinate systems, both showing "the number" a few pixels apart - that produced the overlap. Not a
color/spacing issue; fixed structurally, not patched per-instance.

| Delivered | Standards section |
| --- | --- |
| `Gauge.tsx`: viewBox grew 124 -> 150 units tall, value label moved to `y = cy + 42 = 142` (safe margin verified against the new height), new `valueLabel` prop makes the gauge the ONE place a value label renders | Kickoff requirement ("fix it structurally... every page that will ever use this component inherits the fix") |
| `GaugeCard.tsx` no longer renders its own separate label div - passes `actualLabel` straight into `Gauge`'s `valueLabel` prop instead | same |
| `Gauge.regression.test.tsx` (new) - renders the real component via `ReactDOMServer`, asserts exactly one `<text>` node exists and its y-coordinate is safely inside the viewBox with margin, across 3 cases (with target, no target, no `valueLabel` passed). No headless browser (Puppeteer/Playwright/Chromium) is available in this sandbox, so this is the DOM-structural equivalent of a screenshot diff, not a pixel-level one - flagged as a real gap, not silently substituted. Verified the check is discriminating (not tautological) by reconstructing the exact original buggy values (viewBox 124, y=128, fontSize 15) in a throwaway copy and confirming the check's own margin assertion catches it (128 > 124-4) | Kickoff requirement ("visual regression check... so this bug can't silently reappear") |
| `Select.tsx` (new) - styled dropdown (button + popover listbox, search, multi-select, keyboard/click-outside close) replacing the native `<select>` Screenshot A showed unstyled | Kickoff requirement + Standards 3.9/3.10 tokens only, no ad hoc values |
| `DateInput.tsx` (new) - styled wrapper (border/background/focus ring/calendar icon) around the native `<input type=date>`, keeping the browser's own date-picker popup rather than building a full custom calendar widget from scratch (see "ask before you assume" below) | same |
| `ProgressBar.tsx` (new) - takes the identical `actual`/`targetToDate`/`status` props as `Gauge`, so it is a second *view*, never a second *calculation*, of the same `classifyVsTarget` result | Kickoff requirement item 5 |
| `SemanticBadge.tsx` wording tightened to "On Target" / "Watch" / "Critical" / "No Target" - still driven by the exact same `status` prop as the gauge and progress bar in the same card, so the pill can never disagree with the gauge's color | Kickoff requirement item 3 |
| `GaugeCard.tsx` redesigned: icon + title + status pill header row, gauge (single value label), progress bar, reference-metric tiles shrunk to 11px/muted so the gauge's 26px headline label dominates each card (Standards 3.10 type scale + tabular-nums) | Kickoff requirement items 4, 6 |
| `lucide-react` added as the one icon library (line-style, Standards Section 3.11) to both `packages/ui` and `frontend` | Standards 3.11 |
| `SidebarFilters.tsx` and the dev role-switcher in `page.tsx` now use `Select`/`DateInput` instead of native controls | Kickoff requirement item 2 |
| Dark-mode contrast bug found and fixed: `--ps-color-accent` (used by `NavTabBar`'s active tab, `EmptyState`'s button, and this pass's new `Select`/`DateInput` focus rings) had no dark-mode override for the default/Majaal business unit, so it stayed near-black (`#1a1a1a`) against the dark theme's `#14161a` surface - nearly invisible. Added a lighter tint (`#6f9ceb`, from Standards 3.9's Brand Blue family) under `[data-theme='dark']`, distinct from Tika's existing dark accent. This is a pre-existing gap surfaced by actually checking dark mode end-to-end, not introduced by this pass | Kickoff requirement ("confirm dark mode actually works end-to-end") |

**Not adopted, explicitly flagged per the "ask before you assume" instructions:**

- **The 6-month trend sparkline** was not built. It is listed in Section 2 as an adoptable pattern
  but is not in Section 3's actual "what to actually change" list or Section 4's deliverables list,
  and a real sparkline needs monthly historical time-series data the current
  `/tachometer/overview` endpoint doesn't return - building it would mean either a new endpoint
  (explicitly out of scope: "no new endpoints needed for this pass") or fabricating trend data that
  isn't real. Flagging this rather than silently adding an endpoint or silently faking a chart.
- **No charting-library swap was needed.** The bug was a layout/coordination defect (two
  independent text renderers), not a limitation of drawing arcs/needles in raw SVG - fixing it did
  not reveal any reason to move off hand-written SVG.
- **No Standards Section 3 token conflicted with the reference dashboard's polish.** Every new
  color, spacing, and type-scale value used here already exists in `tokens.css`/Standards 3.9-3.10;
  nothing needed to be added or overridden to match the requested look, except the dark-mode
  `--ps-color-accent` fix above, which is a bug fix (a token with no working dark value), not a new
  token or a standards deviation.
- **`DateInput` wraps the native date input rather than building a full custom calendar-grid
  picker.** The Tachometer page only ever needs one anchor date (not a true range - see
  `SidebarFilters.tsx`'s existing correction note), so a full custom calendar widget would be a much
  larger, separate piece of work relative to what this page actually needs. The browser's native
  date-picker popup is retained; only its surrounding chrome was restyled.

**Before/after images:** `tachometer_screenshots/before_light.png` and `after_light.png` (plus
`_dark` variants) render the actual `Gauge` component's real SVG output for the same MTD Value
scenario described in the bug report - `before` reconstructs the original bug exactly (raw
unformatted number + a second overlapping label, viewBox 124, y=128), `after` is the real fixed
component. `tachometer_screenshots/mockup_light.html` and `mockup_dark.html` render the real
`GaugeCard`/`Select`/`DateInput` component markup with the real `tokens.css`/`globals.css`, openable
directly in a browser - no headless browser/Puppeteer is available in this sandbox to produce a
true pixel screenshot of the full live page, so these are the most accurate substitute available
without one. Flagged rather than silently skipped: a full `next dev` + live-browser screenshot pass
(e.g. via Claude in Chrome against the running app) would be a good, better follow-up once the
local MySQL/backend setup from the prior session is confirmed running.

## 9. Majaal logo bug investigation + Tachometer drill-down (clickable gauge cards) -> `packages/ui/`, `frontend/src/`, `backend/src/`

**Majaal logo bug report** ("when someone select Majaal but the Majaal's logo and colors [don't
show]", confirmed as "logo doesn't appear at all"): investigated via a jsdom-based interaction
simulation (real `MouseEvent('click')` dispatch against the actual `SidebarFilters` -> `page.tsx`'s
`handleFiltersChange` -> `BusinessUnitProvider` -> `Header` chain, not just a static code read).
Result: the on-disk code is provably correct -- selecting Majaal in the styled Business Unit
dropdown sets `filters.companyKey = 1`, `businessUnit` becomes `'majaal'`, and `Header` renders a
second `<img src="/logos/majaal/majaal-mark-dark.png" alt="Majaal">` tag alongside the BMH mark.
This rules out a React/component-logic bug. If the logo still doesn't appear in the running app,
the remaining candidates are environmental, not code: (1) the dev server needs a restart to pick up
this session's file syncs, (2) a hard browser refresh (Ctrl+Shift+R) to clear a stale bundle/cache,
or (3) an actual 404 on that image path in the real dev server (check the browser DevTools Network
tab when selecting Majaal -- a 404 vs. a JS console error vs. nothing at all each points to a
different next step, and would need the user's own DevTools or explicit permission to control their
browser to pin down further).

**Clickable gauge cards -> drill-down/breakdown detail page**, per the confirmed scope ("a
table/chart breaking the selected metric down by Salesperson, Branch, or Customer Group ... built
by extending existing validated queries with grouping, no new data source"):

- `backend/src/measures/tachometer.ts` -- added `fetchValueVolumeGrouped` /
  `fetchTargetForMonthsGrouped` (same `fact_order`/`fact_target_plan` tables and `buildWhereClause`
  filter logic as the existing card queries, just with a `GROUP BY` + a `LEFT JOIN` to the relevant
  dimension table for a display name) and `computeBreakdown(pool, anchor, filters, period, metric,
  groupBy)`, which reuses `classifyVsTarget`, `variancePct`, and `monthElapsedFraction` unchanged --
  every breakdown row is classified by the exact same function the top-level gauge uses, so a row's
  status pill can never disagree with how the aggregate would be classified.
- `backend/src/routes/tachometer.ts` -- new `GET /tachometer/breakdown?metric=&groupBy=&anchorDate=`
  route, mounted behind the same `requireAuth, attachUserContext, resolveScopedFilters` middleware
  chain as `/overview`, validating `metric` (`ytdValue`/`ytdVolume`/`mtdValue`/`mtdVolume`) and
  `groupBy` (`salesperson`/`salesTeam`/`segment`) query params.
- `frontend/src/lib/api.ts` -- `fetchTachometerBreakdown` + `TachometerBreakdown`/`BreakdownRow`
  types, following the existing client conventions.
- `frontend/src/lib/hooks.ts` -- `useTachometerBreakdown`, mirroring `useTachometerOverview`'s
  loading/error/retry shape.
- `packages/ui/src/components/Card.tsx` -- widened to extend `React.HTMLAttributes<HTMLDivElement>`
  (purely additive) so a card can accept `onClick`/`onKeyDown`/`tabIndex`/`role` for the clickable
  variant below.
- `packages/ui/src/components/GaugeCard.tsx` -- new optional `onClick` prop: when passed, the whole
  card becomes a keyboard-accessible control (`role="button"`, `tabIndex=0`, Enter/Space activate
  it, `aria-label` changes to "<title>, view breakdown by dimension"), styled via a new
  `.ps-card-clickable` CSS class (hover elevation + `:focus-visible` outline in
  `frontend/src/styles/globals.css`). Cards without `onClick` are unaffected.
- `packages/ui/src/components/DataTable.tsx` -- added an optional per-column `render(row)` function
  (falls back to the previous `String(row[key])` behavior) so the breakdown table can render a real
  `SemanticBadge` status pill instead of a plain string. `DataTable` was scaffolded in an earlier
  session but not yet used anywhere in the frontend, so this is the component's first real consumer.
- `frontend/src/app/page.tsx` -- the 4 clickable gauge cards (YTD Value, YTD Volume, MTD Value, MTD
  Volume -- **not** the 2 ASP cards, matching the user's own count of "4 gauge card") now navigate to
  `/tachometer/{metric}?anchorDate=...&companyKey=...&...` on click, carrying forward the exact
  filters/anchorDate the summary page is currently showing.
- `frontend/src/app/tachometer/[metric]/page.tsx` (new route) -- the detail page: a breadcrumb back
  to the Tachometer summary (Standards Section 3.3), an enlarged `GaugeCard` for the clicked metric
  (fed from the same `/overview` computation, so it can never disagree with the card that was
  clicked), a Group-by toggle (Salesperson / Branch / Customer Group), and a `DataTable` breakdown
  with Actual / Target-to-date / Variance / Status-pill columns.

**Scope call-out, not a silent decision**: filters/anchorDate are carried to the detail page via URL
query params rather than shared React state, since the summary page's filters live in local
component state scoped to `page.tsx`. The summary page itself was **not** changed to read/write
filters via the URL in this pass -- the breadcrumb "back" link returns to the plain Tachometer
summary (filters reset to default there, same as before this pass). Making the summary page's own
filters URL-persisted would be a reasonable follow-up but is a separate scope change, not bundled in
here silently.

**Verification**: `tsc --noEmit` run against both the backend (`backend/tsconfig.json`) and a full
frontend + `packages/ui` isolated harness (mirroring `frontend/tsconfig.json`'s compiler options,
with `next/navigation`, `next/link`, `next/image` type-stubbed since this sandbox cannot install a
real Next.js toolchain) -- both are clean, zero errors, after fixing two real type issues caught by
the check itself (a `keyof TachometerOverview` union that needed narrowing to the 4 gauge-card keys,
and `DataTable`'s generic constraint needing an index signature on the breakdown row type). All 10
touched/added files verified byte-identical between the outputs scratch copy and the user's real
workspace folder via `diff`, and each file's tail verified to end cleanly (no truncation from the
known Edit-tool truncation bug that hit this pass once -- caught immediately by the same tsc run,
since the corrupted file failed to compile, and fixed via full-file recovery from the intact copy).

**Not done in this pass, flagged rather than silently skipped**: no automated test exists yet for
`computeBreakdown`'s SQL/grouping logic specifically (it would need a mocked `mysql2` `Pool` or a
real test database connection, neither set up in this sandbox) -- `classifyVsTarget`/`variancePct`/
`monthElapsedFraction`, which `computeBreakdown` reuses unchanged, already have their own passing
unit tests from an earlier session. A real end-to-end check (clicking a gauge card in the running
app, confirming the breakdown table renders real rows against the local MySQL warehouse) still
needs the user's own `npm run dev` + browser, or explicit permission to drive it via Claude in
Chrome.

## 10. Tachometer modernization pass (icon nav rail, compact numbers, decorative polish) -> `packages/ui/`, `frontend/src/`

Triggered by: "let make the design modern, this will be our main page to the whole company, even
the numbers use unit instead (M, K)." Applied to both the Tachometer summary page and the
`/tachometer/[metric]` drill-down page, so they stay visually consistent.

**STANDARDS DEVIATION - explicit and user-approved, not silent**: Standards Section 3.3 specifies
"Primary nav: persistent bottom tab bar." The user's own modern-look reference showed a dark
left icon-only nav rail instead. Since this is a real conflict between the reference image and the
written standards, the user was asked directly which to build (rather than quietly picking the
nicer-looking option) and chose the icon rail. `frontend/src/components/IconNavRail.tsx` is the new
component (dark Brand-Navy `#1B2A49` background, lucide icons, only "Tachometer" links anywhere real
- the other four sales pages stay disabled placeholders, unchanged from before). The old
`NavTabBar.tsx` is left in the codebase, unused by either page, in case a future call reverts this.

**Compact K/M number formatting**: `frontend/src/lib/format.ts` gained
`formatCompactCurrency`/`formatCompactVolume` (e.g. "LYD 40.4M", "293.8K", one decimal place,
matching internal shorthand). Applied to every headline number and every LYTD/FLY/FY-Target-style
reference tile on both pages, plus the breakdown table's Actual/Target-to-date columns. ASP values
were deliberately left at full precision (they're small per-unit prices, e.g. "LYD 137.5" - never in
the thousands/millions, so compacting would make them harder to read, not easier). Nothing is lost:
every compact string carries the exact full-precision value as a native `title` tooltip (hover to
see it) - `GaugeCard`'s `ReferenceMetric` gained an optional `fullValue` field and both `GaugeCard`/
`StatCard` gained an optional `actualFullValue` prop for the headline number's tooltip.

**Other polish, all additive**:
- `packages/ui/src/components/DecorativeWave.tsx` (new) - a subtle, status-tinted decorative wave
  behind each card's reference-metric row (`aria-hidden`, `pointer-events: none`, ~10% opacity -
  purely visual, never the only signal; the SemanticBadge above each card already carries the real
  status). Shared by `GaugeCard` and `StatCard`.
- `packages/ui/src/components/DataTable.tsx` - rows now carry a `ps-datatable-row` class with a
  subtle hover background (`frontend/src/styles/globals.css`).
- `frontend/src/components/ValidationStatusBar.tsx` (new) - merges what used to be two stacked
  banners (the always-on "not connected to live Odoo" disclaimer + the conditional stale-data
  warning) into one consolidated bar that tints amber when stale. Neither piece of required
  information was removed, just combined into one row. Added to the drill-down page too (it
  previously had no such disclaimer at all).
- `frontend/src/components/Header.tsx` - Export is now a filled dark pill button with a label
  (matching the modern reference); Refresh/Notifications switched from emoji glyphs to lucide icons.
- `frontend/src/components/SidebarFilters.tsx` - added a small "Clear all" quick link next to the
  "Filters" heading, in addition to the existing full-width "Reset filters" button lower down.
- `frontend/src/styles/tokens.css` - added `--ps-color-nav-rail-bg`/`-icon`/`-icon-active`/
  `-active-bg` tokens backing the new rail (Brand Navy, previously documented in Standards Section
  3.9 but unused in code until now).

**Verification**: `tsc --noEmit` clean across backend + the full frontend/`packages/ui` isolated
harness after these changes. All 14 touched/added files verified byte-identical between the outputs
scratch copy and the user's real workspace folder via `diff`, each file's tail checked to end
cleanly.

**Not done this pass, flagged rather than silently skipped**: the mockup's top toolbar (date picker
+ refresh + Export grouped together above the filters) was not fully replicated pixel-for-pixel -
Export/Refresh/Notifications stayed in the existing `Header` row (now restyled) rather than being
relocated into a new toolbar, to avoid duplicating controls that already exist there. Worth a
follow-up if the exact toolbar arrangement from the reference image matters more than it currently
reads as optional polish.

## 11. UI Improvements pass (uniform cards, gauge scale/target labels, Performance Summary, interactive DataGrid, drill-down page reorg) -> `packages/ui/`, `frontend/src/`

Triggered by the 9-part "UI Improvements for Tachometer Dashboard" request. One upfront decision
was confirmed with the user before building: the interactive table would use two new npm
dependencies (`@tanstack/react-table` for grid logic, `xlsx`/SheetJS for real .xlsx export) rather
than a from-scratch table, matching the "feel like Power BI/AG Grid" ask. **Run `npm install` at
the repo root again before starting the dev server** - same as the earlier `lucide-react` addition,
these two are new entries in `packages/ui/package.json`'s `dependencies`.

**1. Card layout & consistency**: every KPI card on the summary page (`GaugeCard` and `StatCard`
alike) now renders inside an identical `aspectRatio: '1/1'` box (`CARD_BOX` in `page.tsx`), and both
components' root `Card` stretches to `width:100%, height:100%` internally - so all 6 cards (4 gauge
+ 2 ASP) are now exactly the same width and height, closer to square, regardless of which component
is inside. The ASP column's grid width was also changed from a narrower `0.7fr` (an earlier pass's
choice) to an equal `1fr`, per "make the ASP cards exactly the same width."

**2. Gauge improvements**: `Gauge.tsx` now renders the to-date-target's actual number next to the
grey marker line (inside the arc face, positioned to never clip the canvas edge) plus a native
`<title>` tooltip on the marker line itself as a hover fallback. The gauge's scale is now
advertised as Target x0.5 (left label) to Target x1.5 (right label) - shown as small numbers at
each end of the arc - which also means the target marker always sits at dead-center of the gauge,
since the target is exactly the midpoint of that range. **One disclosed, deliberate safety net**:
if `actual` itself falls outside that x0.5-x1.5 window (common in the real data - e.g. an actual at
12% of target), the *invisible geometry bounds* (not the advertised on-screen labels) quietly widen
just enough to keep the needle from being falsely pinned at an edge that would otherwise misread as
"half of target." The labels always show the literal Target x0.5/x1.5 numbers regardless - nothing
is hidden, only the needle's placement safety-nets outward for extreme misses. Flagging this
explicitly in case a strictly literal x0.5/x1.5 clamp (needle pins at the edge, no exceptions) is
preferred instead.

**3. KPI card information hierarchy**: reordered to KPI name -> current value (now its own large
28px line above the gauge, previously only shown inside the gauge's own SVG) -> gauge (now a pure
visual via a new `showValueLabel={false}` option on `Gauge`, since the value already has its own
line) -> target (surfaced via the gauge's marker+label+tooltip for `GaugeCard`; a small dedicated
"Target: X" line for `StatCard`, which has no gauge to embed it in) -> supporting numbers, pinned to
the bottom of the card via `marginTop: 'auto'` so cards with different content still align.

**4. Performance Summary section**: new section below the KPI grid on the summary page - KPIs On
Target, Critical KPIs, Average Performance %, Overall Health Score, Best/Worst Performing KPI - all
computed client-side in `page.tsx` (`computePerformanceSummary`) from the same 6 cards already on
the page. No new backend endpoint; every card's status still comes from the server's
`classifyVsTarget`. The one new number is a display-only variance % for the 2 ASP cards (the
`AspCard` API type has no `variancePct` field, unlike `TachometerCard`) - computed with the exact
same `(actual-target)/target` formula the backend already uses elsewhere, purely for ranking
best/worst in this summary, never for classification.

**5-7. Drill-down (`/tachometer/[metric]`) page reorganized**: Breadcrumb -> Summary KPI Card ->
Large Interactive Chart -> Performance Insights -> Interactive Table (was: small card, big gap,
straight to the table). The "large chart" is a new hand-rolled `BreakdownBarChart.tsx` (horizontal
bars, not an SVG/library chart - consistent with how `Gauge.tsx` is also hand-rolled rather than
pulling in a charting library for something this shape-simple), sized to ~58% of content width on
desktop (100% on phones, see `.ps-breakdown-chart` in `globals.css`) so it reads as the primary
visual, showing the same rows as the table below rather than a second data source. Performance
Insights (Total Groups, On Target, Critical, Top/Needs-Attention Performer) are computed the same
client-side way as the summary page's Performance Summary, scoped to this metric's breakdown.

**6. Interactive DataGrid**: new `packages/ui/src/components/DataGrid.tsx` (built on
`@tanstack/react-table`) replaces the plain `DataTable` on the breakdown page. Supports: global
search across all columns, per-column filter inputs, click-header-to-sort, drag-and-drop column
reordering (native HTML5 drag events), drag-to-resize column edges, per-column pin/freeze (left,
via TanStack's built-in column-pinning state + sticky CSS), pagination with a rows-per-page
selector, and Export to CSV / Export to Excel (`xlsx`, a real binary `.xlsx` file, not just
CSV-with-an-xlsx-extension) / Copy to clipboard (tab-separated, pastes cleanly into
Excel/Sheets) - all four always operate on the current filtered+sorted result set, not just the
visible page, matching "export what I'm looking at." The old `DataTable.tsx` is left in place,
unused by either page now, in case a simpler table is wanted again elsewhere.

**9. Design language**: card border-radius widened from 8px to 14px (within the requested 12-16px
range) via the `--ps-card-radius` token, shadow softened/deepened (`--ps-card-shadow`/
`-shadow-hover`), and every card now has a subtle hover lift (`.ps-card:hover` in `globals.css`) -
on top of the icon-rail/decorative-wave/hover-row polish already done in an earlier pass this
session (see §10).

**8. Responsive**: the equal 3-column summary grid and the aspect-ratio card boxes both scale
naturally as the existing tablet/mobile breakpoints collapse the grid to 2 then 1 column (cards
stay square, just bigger on narrower screens). The breakdown chart drops its 58%-width constraint
below 768px. `DataGrid` has its own horizontal-scroll wrapper so resized/many columns never break
page layout on small screens.

**Verification**: `tsc --noEmit` clean across the full frontend + `packages/ui` isolated harness
(after installing `@tanstack/react-table`/`xlsx` into it and fixing one real lucide-react
`size: number|string` type mismatch the check itself caught - same known pattern as earlier
passes). All 11 touched/new files verified byte-identical between the outputs scratch copy and the
user's real workspace folder via `diff`. One instance of the known Edit-tool silent-truncation bug
hit `packages/ui/package.json` mid-pass (caught via a byte-level check immediately after editing,
before it could propagate) and was fixed via a full heredoc rewrite, re-verified as valid JSON.

**Not done this pass, flagged rather than silently skipped**: true drag-and-drop column reordering
in `DataGrid` uses native HTML5 drag events (functional, but visually plainer than a library like
`dnd-kit` would give - no drop-indicator animation). Column pin/freeze only supports the left side
(not right) since nothing on this page needs a right-pinned column yet. Neither gap blocks the
requested functionality; both are candidates for a follow-up if the plain HTML5 drag feel isn't
polished enough.

## 12. Complete UI Redesign (full rebuild) -> `packages/ui/`, `frontend/src/`, `backend/src/`

Triggered by an explicit instruction to stop iterating on the existing layout/component structure
and rebuild the Tachometer UI from scratch, comparable to Microsoft Fabric/Power BI/Tableau/
Datadog/Grafana Cloud/Stripe Dashboard, while keeping all existing backend logic, calculations, and
data bindings untouched. One upfront decision was confirmed with the user before building: Recharts
(over Chart.js) for the new Trend Section and the breakdown page's enhanced chart, since both need
zoom/tooltips/legend/toggle-series/export-image. **Run `npm install` at the repo root again before
starting the dev server** - `recharts` is a new entry in `packages/ui/package.json`'s
`dependencies`, alongside the earlier `@tanstack/react-table`/`xlsx`/`lucide-react` additions.

**New backend endpoint**: `GET /tachometer/trend` (`backend/src/measures/tachometer.ts`'s
`fetchMonthlySeries`, `backend/src/routes/tachometer.ts`) returns a monthly time series
(Jan..current month) of Value/Volume/ASP actual-vs-target, reusing `fetchValueVolume`/
`fetchTargetForMonths`/`classifyVsTarget`/`asp`/`monthElapsedFraction` unchanged - one more
grouped-fetch pattern (by calendar month instead of by filter dimension), not a new query strategy.
This was explicitly out of scope in the prior UI Improvements pass ("sparkline skipped - needs a
new endpoint") and is now built because the redesign's Trend Section genuinely cannot exist without
real time-series data.

**New design tokens** (`frontend/src/styles/tokens.css`): an 8px spacing scale
(`--ps-space-1`...`--ps-space-8`) and soft status-tinted background/border pairs
(`--ps-color-success-bg`/`-watch-bg`/`-alert-bg` + `-border` variants, plus `--ps-color-accent-bg`),
each with light- and dark-theme values, so every new chip/badge/insight-card accent uses a subtle
tint rather than a heavy saturated fill.

**New components** (`packages/ui/src/components/`), all additive - every superseded component
(`Gauge`, `GaugeCard`, `StatCard`, `BreakdownBarChart`) is left in place, unused, per this session's
running convention of not deleting components in case a future session needs to revert:
- `RadialGauge.tsx` - a larger, clearer gauge reusing `Gauge.tsx`'s exact polar-geometry math and
  Target x0.5/x1.5 scale (including its disclosed safety-extension for badly-missed targets, see
  §11 item 2) but with a bigger arc, a soft drop-shadow, and explicit "Min - 50% of Target"/"Max -
  150% of Target" captions so the scale formula is legible at a glance, not just inferable.
- `BulletChart.tsx` - the new ASP visualization (a standard enterprise-BI "bullet chart": a
  qualitative red/yellow/green range track, a solid measure bar for the actual value, and a tick for
  the to-date target), replacing the plain green `ProgressBar` and using the identical Target
  x0.5/x1.5 scale as `RadialGauge` so ASP cards are measured on the same scale as Value/Volume.
- `KpiCard.tsx` - the single KPI card component replacing both `GaugeCard` and `StatCard`; only a
  `variant` prop ('gauge' | 'bullet') changes which visual fills the center slot, so ASP cards now
  have identical height/width/padding/typography/visual weight to Value/Volume cards, directly
  addressing that explicit complaint. Bottom row is Target / Variance / Last Year (three
  `ReferenceMetric` tiles) plus an optional Trend-arrow tile (`KpiTrend`, vs last year - a distinct
  signal from the target-based Variance tile).
- `TrendChart.tsx` - a generic Recharts line/area chart (actual vs target) with a toggleable legend,
  hover tooltips, a `Brush` for zoom, and a native-browser (no extra library) SVG->PNG "Export
  image" button. Powers the four new Trend Section charts: Revenue, Volume, ASP, and Monthly
  Achievement % (computed client-side as `value/targetValue * 100` per month, target line at 100%).
- `BreakdownChart.tsx` - a Recharts horizontal grouped-bar chart (actual, colored by status, next to
  a thinner neutral target bar) replacing `BreakdownBarChart.tsx` on the drill-down page, with the
  same legend/tooltip/brush/export-image interactivity as `TrendChart`.
- `InsightCard.tsx` - an icon-led, status-tinted summary tile for the Performance Summary section
  and the breakdown page's Quick Insights panel (distinct from the older, plainer `KpiTile`).
- `FilterChip.tsx` / `CollapsibleSection.tsx` - small sidebar primitives: a removable active-filter
  chip, and a collapsible group wrapper so the sidebar's 6 filter groups (Business Unit / Customer
  Group / Distribution Channel / Branch / Salesperson / Date) don't force one long unbroken scroll.

**New page-level components** (`frontend/src/components/`), also additive alongside the originals
(`Header.tsx`, `SidebarFilters.tsx` left unused):
- `AppSidebar.tsx` - modernized sidebar: each filter group is now a `CollapsibleSection`, an active-
  filter `FilterChip` row sits above them for an at-a-glance summary, and the old two overlapping
  reset actions ("Clear all" link + "Reset filters" button) are now one "Reset All" button.
- `AppHeader.tsx` - modernized header: same brand-logo lockup/dark-mode toggle as `Header.tsx`, plus
  an inline compact date selector, a refresh button (spins while a refresh is in flight, tooltip
  shows last-refresh time), a notification bell with an unread-count badge (still a visual
  affordance - no notification backend exists), and a profile chip showing the dev sign-in role
  (there is no real user-identity system in this build; see `DevAuthProvider`).

**`DataGrid.tsx` enhanced in place** (not rebuilt, since it already satisfied nearly every
"professional data grid" requirement): added a sticky header (works on both axes at once with the
existing column-pin sticky-left behavior) via an internal `maxBodyHeight`-bounded scroll container,
and enabled multi-column sort (`enableMultiSort`, shift-click a second/third header; a small
numbered badge shows each column's position in the active sort once more than one column is
sorted).

**Page rebuilds**: `frontend/src/app/page.tsx` and `frontend/src/app/tachometer/[metric]/page.tsx`
were rebuilt in full (not iterated), per the explicit "do not preserve the current component
structure" instruction.
- The summary page is now a single 12-column CSS Grid: `AppSidebar` spans columns 1-3 across both
  KPI rows; the 6 `KpiCard`s occupy columns 4-12 in two rows of three (Value/ASP/Volume x YTD/MTD -
  the exact arrangement the user specified back in the original layout-correction request);
  Performance Summary (now `InsightCard` tiles), the Trend Section (four `TrendChart`s), and a new
  Top/Bottom Performance section (a `BreakdownChart` ranking all 6 KPIs by variance vs target, using
  a target-of-0% baseline as the "on target" reference line) each span the full 12 columns below.
- The breakdown/detail page is now Breadcrumb -> Large KPI Summary Card (`KpiCard`) -> Large
  Interactive Chart (`BreakdownChart`, ~58% width via the existing `.ps-breakdown-chart` responsive
  class) -> Quick Insights Panel (`InsightCard`s) -> Interactive Data Table (`DataGrid`, unchanged
  from §11 plus the sticky-header/multi-sort additions above).

**Verification**: `tsc --noEmit` clean across both the backend and the frontend+`packages/ui`
isolated harnesses (the frontend harness needed `recharts` installed, plus its usual node_modules
stub-restoration step after that install pruned the hand-placed `@07ps/ui`/`next` stubs - the same
routine as every prior dependency addition this session). Two real type errors were caught and
fixed by the check itself: Recharts' `Legend onClick` payload type didn't match a plain
`{dataKey?: string|number}` handler signature (narrowed to `unknown` instead, in both `TrendChart`
and `BreakdownChart`), and `KpiCard.tsx` re-declaring a `ReferenceMetric` interface identical to
`GaugeCard.tsx`'s caused a duplicate-export ambiguity in the `export *` barrel (fixed by importing
and re-exporting `GaugeCard`'s `ReferenceMetric` instead of redeclaring it). All touched/new files
were also re-verified byte-identical between the outputs scratch copy and the user's real workspace
folder via `diff -rq` across `packages/ui/src`, `frontend/src`, and `backend/src` in full.

**A sandbox quirk surfaced and worked around this pass, worth flagging**: the bash-side mount of the
user's real workspace folder was repeatedly observed to silently truncate or lag behind edits made
via the file-editing tool on several of this pass's larger files (`KpiCard.tsx`, `TrendChart.tsx`,
`BreakdownChart.tsx`, `DataGrid.tsx`, `page.tsx`, the breakdown detail page, `hooks.ts`, `api.ts`) -
confirmed each time by reading the file through the file tool directly (always correct) versus
through the bash mount (sometimes stale/truncated). Every instance was caught via the routine
line-count/tail verification this session already does after every edit, and fixed by writing the
verified-correct content directly into every copy (the user's real workspace folder, the outputs
scratch copy, and the typecheck harness) rather than trusting a `cp` sourced from the bash mount.
No data was actually lost - the user's real file (as edited via the file tool) was confirmed correct
every time this was checked - but this is a meaningfully different failure mode from the
already-documented Edit-tool truncation bug and is worth knowing about if a future session sees
`tsc` errors that don't match what a direct file read shows.

**Not done this pass, flagged rather than silently skipped**: no live-browser screenshot pass was
taken of the finished redesign (same headless-browser limitation as §11's note) - the layout,
component wiring, and `tsc` cleanliness are verified, but a visual QA pass in the actual running app
is a good next step before presenting to executives. A full `next build` (not just `tsc --noEmit`)
also still hasn't been run in this sandbox, per the same carried-over open item as §11/§13. The
Monthly Achievement % definition (`value / targetValue * 100`, Value-based only) is a judgment call
since the manual doesn't define a combined Value+Volume achievement formula - worth confirming
whether Volume should factor in too.

## 13. Open items requiring the Data Analyst / IT (carried over + new)

- Odoo's exact `sale.order.line` field customizations still need confirming during Phase P0
  sign-off — unchanged from §5, not touched this session.
- Athens and SMG partner logo image files are still not provided — the header's partner badge row
  remains text-stubbed.
- The Tika logo (147×45px GIF-as-`.png`) should be replaced with a real, higher-resolution asset
  before any real header/print use — see §6.
- No real login/identity system exists yet. `DevAuthProvider`/`devAuth.ts` are dev-only,
  production-disabled stand-ins built solely to exercise the Salesperson RBAC lock end-to-end; a
  real authentication system must replace them before real users or real data are involved.
- A full `next build` (not just `tsc --noEmit`) should be run against the frontend before
  deployment sign-off — this sandbox's FUSE-mounted npm install made a full monorepo build
  impractical within the session; see the Verification note in §6.
- The other four Sales pages (Critical Number, Revenue Trend, Invoices Engine, Customer Growth)
  remain unbuilt — their nav tabs are visible but disabled, per this task's explicit instruction
  not to build them yet.
- ~~The 6-month trend sparkline from the reference dashboard was not built this pass~~ - built in
  §12 (`GET /tachometer/trend` + the summary page's Trend Section). Kept here struck through rather
  than deleted, per this doc's own convention of not silently dropping a previously-flagged item.
- No headless browser (Puppeteer/Playwright/Chromium) is available in this sandbox - the
  before/after "screenshots" for this pass are a real rendered PNG of the Gauge component itself
  (accurate) plus self-contained HTML mockups of the full card/filters layout (accurate markup +
  CSS, but not screenshotted). A live-browser pass against the running app would be a better
  follow-up.

- `computeBreakdown`'s grouped SQL (backend/src/measures/tachometer.ts) has no automated test yet --
  needs either a mocked mysql2 Pool or a real test-database connection to verify the GROUP BY/JOIN
  queries against actual data; not set up in this sandbox this pass.
- The Tachometer summary page's filters/anchorDate are not persisted in the URL -- the new
  drill-down page had to carry them forward as one-off query params instead of shared state. Worth
  a follow-up if deep-linking into the summary page with pre-set filters becomes a real need.

- The Tachometer modernization pass's icon nav rail is a confirmed deviation from Standards Section
  3.3's persistent-bottom-tab-bar rule (see §10) - worth updating the Standards doc itself if this
  becomes the permanent direction, rather than leaving the written standard and the built app
  disagreeing indefinitely.

- The gauge's Target x0.5/x1.5 scale-safety-extension (see §11 item 2) is a disclosed judgment call,
  not something explicitly specified either way - worth a quick confirm from whoever owns the
  Tachometer manual on whether a strict literal clamp (no extension) is actually preferred for
  badly-missed targets.
- DataGrid's column drag-reorder is native-HTML5-based (functional, plainer visuals) rather than a
  dedicated drag library - fine for now, a candidate for polish later if it feels rough in practice.

## 14. Tachometer rebuild (dark-theme pass) -> `packages/ui/`, `frontend/src/`

Full "destroy and rebuild" of the Tachometer summary page per a new written spec plus a screenshot
of the app's actual running state (top filter strip + tab nav, distinct from §12's 12-column-grid
rebuild). New/changed pieces:

- **Dark navy theme as default.** `tokens.css` gained a dedicated `--ps-color-page-bg` token
  (`#0b111e` dark / `#f5f6f8` light), now separate from `--ps-card-bg` so cards read as "slightly
  lighter" against the page canvas instead of blending into one flat surface color.
  `ThemeProvider.tsx`'s initial state flipped from `'light'` to `'dark'` — dark is now the
  first-run experience; light remains fully supported, one toggle click away.
- **`KpiCard.tsx`** gained an achievement-% `ProgressBar` row and an optional `sparklineValues`
  prop (renders a `Sparkline`) — purely additive, existing `referenceMetrics`/`trend` props and
  every existing call site are unchanged.
- **`AspMiniCard.tsx`** (new, `packages/ui`) — the compact ASP card for the mockup's "sleek
  vertical stack": headline ASP number + a real status pill (colored from `classifyVsTarget`'s
  actual result, never hardcoded green regardless of what the mockup's example screenshot showed).
- **`PerformanceReportTable.tsx`** (new, `packages/ui`) — lightweight Metric/Actual/Target/
  Variance%/Variance LY/Trend[/Status] table, deliberately simpler than the TanStack-powered
  `DataGrid` since this is a fixed summary strip, not an interactive grid.
- **`TopTabBar.tsx`** (new, `frontend/src/components`) — 12-item horizontal page tab strip under
  the header; only Tachometer is a real link, the rest are disabled with a "not built yet" tooltip
  (same convention as `IconNavRail.tsx`).
- **`BottomNavBar.tsx`** (new) — fixed, translucent, blurred bottom nav bar with the 5 items the
  spec named explicitly; gold underline + filled icon + white text on the active tab, muted/
  softly-illuminating-on-hover inactive tabs.
- **`FilterBar.tsx`** (new) — horizontal filter strip replacing `AppSidebar`'s left column on this
  page. `AppSidebar.tsx`/`IconNavRail.tsx` are left in place, unused, per this session's convention.
- **`page.tsx`** rebuilt to the mockup's exact 3-part "Layout Matrix": Header → TopTabBar →
  FilterBar → a 3-column grid (Value | ASP vertical stack | Volume, YTD row over MTD row, ASP
  spanning both rows as one 2-card stack) → two side-by-side `PerformanceReportTable`s → fixed
  `BottomNavBar`. The previous pass's Performance Summary / Trend charts / Top-Bottom-Performance
  sections are no longer rendered on this page (the mockup's Layout Matrix only calls for these
  three parts) — their components remain in `packages/ui`, unused, not deleted.

**Two disclosed departures from the mockup, both to avoid fabricating data:**

1. The mockup shows "Customer" and "Customer Status" filter dropdowns and a two-box date range.
   This warehouse has never had those dimensions or a true range (only 5 filter dims + one anchor
   date are backed by the schema/API). Rather than silently drop them or wire up fake controls,
   `FilterBar.tsx` renders them as visibly disabled fields with a tooltip explaining why — the same
   "disabled + honest tooltip" pattern already used for not-yet-built nav pages.
2. The mockup's example table rows ("Region 1 ASP YTD", "Region 2 ASP YTD", ...) imply a
   per-region breakdown this data model doesn't expose (no Region dimension exists). The two
   Performance Report tables are populated entirely from the 6 real overview cards' own fields
   (`actual`/`targetToDate`/`variancePct`/`lastYearSamePeriod`/`fullLastPeriodActual`/
   `fullPeriodTarget`) instead — "Full Last Year Value"/"Full Last Month Value" rows are new, but
   every number in them is a real field already returned by `GET /tachometer/overview`, not an
   invented one.

**Verification.** `tsc --noEmit` passes clean against the frontend harness after this pass. No
headless browser is available in this sandbox (see §13), so this pass was verified by typecheck +
direct code review, not a rendered screenshot — same limitation flagged in §13, not new to this
pass.

**A sandbox quirk surfaced again this pass, worth flagging once more:** when syncing verified files
into the typecheck harness via `cp` from the bash-mounted project path, two files
(`AppHeader.tsx`, `ThemeProvider.tsx`) arrived silently truncated mid-line even though the Read
tool confirmed the real file (ground truth) was complete and correct. This is the same bash-mount
staleness/corruption category documented in §12, not a new bug — the fix was, again, to heredoc the
verified-correct content directly into the harness rather than trust the `cp`. No data loss
occurred in the actual project files at any point.

### 14.1 Compact-cards follow-up fix

Immediate follow-up after a user screenshot showed the YTD Value / YTD Volume cards rendering far
larger than intended, with a lot of dead vertical space around the gauge. Root cause: `CARD_BOX` in
`page.tsx` used `aspectRatio: '4/5'` inside a `1fr` grid column, so the card's height scaled up
directly with however wide its column happened to render — on a normal desktop width that produced
a visibly oversized card, independent of anything inside `KpiCard.tsx` itself.

Fix, `packages/ui/KpiCard.tsx`:
- Card padding tightened from the 16px-all-around default to `8px 16px`.
- Header-to-headline spacing tightened (`--ps-space-2` -> `--ps-space-1`).
- Headline value font size 30px -> 22px.
- `RadialGauge` size 172 -> 140; `BulletChart` width 220 -> 180.
- Achievement-bar row and bottom tile-row spacing tightened to match.

Fix, `frontend/src/app/page.tsx`:
- `CARD_BOX` dropped the `aspectRatio` entirely in favor of `maxWidth: 300` + `margin: '0 auto'`,
  so every Value/Volume card is now a fixed, compact size and centered in its grid cell regardless
  of column width.
- The metrics grid's `gridTemplateRows` changed from `repeat(2, 1fr)` (stretch) to `repeat(2, auto)`
  with `alignItems: 'start'`, so row height now follows the (much smaller) card content instead of
  forcing every cell to match the tallest sibling.

Every KPI card (YTD/MTD x Value/Volume) goes through this same component and grid slot, so the
"identical dimensions across cards" requirement holds automatically — there's only one card
component and one sizing rule to keep in sync. `tsc --noEmit` passes clean against the frontend
harness after this fix; verified via typecheck + code review, same no-headless-browser caveat as
§14.

### 14.2 "Goldilocks" size follow-up (second round)

A second screenshot showed §14.1's fix had swung too far the other way — cards now read as
cramped, hurting gauge/label legibility. Eased every dimension back up partway toward the original,
landing at a size between the two prior passes:

- `KpiCard.tsx`: padding `8px/16px` -> `16px/24px`; headline font `22px` -> `26px`; `RadialGauge`
  size `140` -> `160` (`BulletChart` width `180` -> `200`); achievement-% text `12.5px` -> `14px`;
  bottom reference-tile text `11px`/`9px` -> `12.5px`/`10px`; matching spacing bumps throughout.
- `AspMiniCard.tsx` scaled up in step so the center ASP stack stays proportional to the taller
  Value/Volume cards beside it: padding `12px/14px` -> `18px/20px`, title `11.5px` -> `13px`,
  headline value `22px` -> `26px`, target caption `10.5px` -> `12px`.
- `page.tsx`: `CARD_BOX.maxWidth` `300` -> `360`; the ASP middle grid column `220px` -> `260px`;
  the gap between the two `AspMiniCard`s `--ps-space-3` (16px) -> `--ps-space-4` (24px).

Still a single shared `KpiCard` component and one `CARD_BOX` sizing rule for all four Value/Volume
cards, so consistency across cards remains automatic. `tsc --noEmit` clean; verified via typecheck
+ code review (no headless browser in this sandbox, per §13/§14).

### 14.3 Design-system enforcement pass (third round)

A third round of feedback flagged inconsistent card styling, poor spacing, and misaligned visual
hierarchy across sections — most visibly the "Breakdown by Salesperson" area on the drill-down
detail page. Root cause: `frontend/src/app/tachometer/[metric]/page.tsx` had never been migrated
to the dark-theme system built in §14 — it was still on the old `IconNavRail` layout with its own
ad hoc magic-number card sizing, while `frontend/src/app/page.tsx` had moved on to
`TopTabBar`/`FilterBar`/`BottomNavBar` and a shared `CARD_BOX` sizing rule. The two pages had
simply drifted apart.

**New shared config — `packages/ui/src/theme.ts`.** A centralized JS-side config for the numeric
values `tokens.css`'s CSS custom properties can't express as JS-consumable numbers: gauge/bullet
pixel sizes, a metric card's max-width, and the font-size scales for `KpiCard`, `AspMiniCard`, and
`PerformanceReportTable`. Exported from the package barrel (`packages/ui/src/index.ts`) as
`theme`. `KpiCard.tsx`, `AspMiniCard.tsx`, and `PerformanceReportTable.tsx` now all read their
sizing from this one object instead of re-picking their own literals — the direct fix for "eliminate
magic numbers via a centralized theme configuration object."

Note: this codebase already had an older `packages/ui/src/tokens/` directory (`colors.ts` /
`spacing.ts` / `typography.ts`) from before the dark-theme rebuild. It's out of sync with the
current tokens (its `cardRadius` is still `8px` against the live `14px` scale, and its
`fontFamily` still leads with Cairo rather than Inter) and nothing in the current codebase imports
from it. Left in place per this session's "don't delete superseded work" convention rather than
silently rewritten — flagged here as a real inconsistency worth reconciling or removing in a
future pass.

**Card uniformity.** `AspMiniCard.tsx`'s outer card now uses the same `--ps-card-radius` (14px)
and `--ps-card-shadow` as `KpiCard`/`PerformanceReportTable`, instead of the smaller
`--ps-card-radius-sm` (10px) it had before — it now sits at the same visual depth as the primary
metric cards flanking it. Its soft status-tinted background/border is kept (a deliberate,
disclosed distinction from a plain metric card, not an inconsistency to remove).

**Breakdown detail page chrome rebuild.** `frontend/src/app/tachometer/[metric]/page.tsx`:
`IconNavRail` swapped for `TopTabBar` + `BottomNavBar` (`active="Tachometer"`, same nav chrome the
summary page uses); the KPI summary card's slot now uses `theme.metricCard.maxWidth` instead of a
hardcoded `width:340`/`aspectRatio:'4/5'`, so a YTD Value card is identically sized on both pages;
the breadcrumb's padding/radius moved from raw pixel literals onto the `--ps-space-*`/
`--ps-card-radius-sm` token scale. Most importantly: the `BreakdownChart` block and the "Full
Breakdown" `DataGrid` table are each now wrapped in a proper Card shell
(`--ps-card-radius`/`--ps-card-shadow`/`--ps-card-bg`/`--ps-color-border`, plus a
`PerformanceReportTable`-style header row for the table) instead of a bare/under-styled `<div>` —
this is the direct fix for the "Breakdown by Salesperson" hierarchy problem, since that section
previously had no real card depth of its own. `IconNavRail.tsx` is left in place, unused, per this
session's convention.

**`MetricCard` naming.** The brief asked for a shared `MetricCard` component. `KpiCard` already is
that one shared primary-metric-card component (used identically for every Value/Volume card on
both pages) — it wasn't renamed, since a rename would touch every call site for no behavioral gain.
Disclosed here rather than silently reinterpreted.

Synced into the `/tmp/frontend_typecheck` harness (`theme.ts`, `index.ts`,
`components/KpiCard.tsx`, `components/AspMiniCard.tsx`, `components/PerformanceReportTable.tsx`,
`app/tachometer/[metric]/page.tsx`) via the established heredoc + byte-length verification
workflow (§13/§14's sandbox-mount-staleness note still applies to `cp`-based syncs). `tsc -p
tsconfig.json --noEmit` clean.

### 14.4 Local dev verification round — dark-mode depth fix + ASP column re-layout

After §14.3 shipped, the user ran it locally (`next dev` + `tsx watch` backend, both fresh starts)
and reported the cards still read as inconsistent — the ASP cards in particular still looked
"small"/disconnected. Two genuinely separate root causes, neither of them a caching issue (the
terminal output showed both dev servers doing real fresh compiles from current source):

1. **`--ps-card-shadow` is invisible in dark mode.** Its dark-theme value is a black shadow
   (`0 2px 8px rgba(0,0,0,0.45)…`) sitting on a near-black page canvas
   (`--ps-color-page-bg: #0b111e`) — it was applying correctly, just imperceptible. So
   §14.3's fix of giving `AspMiniCard` the same shadow as `KpiCard` had zero visible effect, and
   `KpiCard`'s own shared `Card.tsx` shell had never had a border at all (it relied on the
   `--ps-card-bg` vs `--ps-color-page-bg` lightness step alone, which is subtle enough to read as
   "flat" too). Fix: `packages/ui/src/components/Card.tsx` now also sets
   `border: '1px solid var(--ps-color-border)'` — a neutral 1px border, the same mechanism
   `AspMiniCard` already used (as a status-colored variant), so every card built on the shared
   `Card` shell now has a depth cue that actually renders on a dark surface, independent of
   whether the shadow is perceptible. The shadow itself is left in place, not removed.
2. **The ASP column's layout, not just its styling, was the "small" complaint.** In
   `frontend/src/app/page.tsx`, the two `AspMiniCard`s previously shared one flex column
   (`gridRow: '1 / 3'`, `justifyContent: 'center'`) spanning both grid rows. Since the KPI cards
   either side are much taller (gauge + bottom-tile row), centering that flex column left the ASP
   pair floating in a lot of dead space, with no vertical alignment to either KPI row. Fix: each
   `AspMiniCard` now sits in its own grid cell matching its row (`YTD Actual ASP` at `gridRow: 1`,
   `MTD Actual ASP` at `gridRow: 2`, both `gridColumn: 2`), each vertically centered only within
   its own row. YTD ASP now lines up with YTD Value/Volume, MTD ASP with MTD Value/Volume.

Synced into `/tmp/frontend_typecheck` (`components/Card.tsx`, `app/page.tsx`) via the same
heredoc + byte-verification workflow; `tsc -p tsconfig.json --noEmit` clean.

### 14.5 Eternal-skeleton bug — devAuth token failure was never surfaced past the loading state

After §14.4, the user restarted `next dev` cleanly (confirmed via terminal output: fresh compile,
`Ready in 5.9s`) but every KPI card sat as an empty grey skeleton indefinitely, `Last Refreshed: —`
never populated, and only the frontend terminal was confirmed running (no backend terminal
confirmed alongside it). This was investigated as three separate questions:

**Was the backend running?** Not confirmed in that test — only one terminal was up. This alone is
sufficient to explain the symptom (see the frontend-bug finding below for exactly why), and is the
most likely proximate cause of that specific test run.

**The port-3000 conflict.** `frontend/package.json`'s `dev` script is plain `next dev` with no
`--port` override, and `backend/.env`'s `PORT=4000` is what `backend/src/server.ts` actually binds
to (`app.listen(Number(process.env.PORT ?? 4000), ...)`) — nothing in this codebase ever binds to
3000 except Next.js itself. So "port 3000 in use, trying 3001" was Next.js finding some other
process already on 3000, not a backend misconfiguration. The most common cause is a `next dev`
process from an earlier terminal session that wasn't fully killed (e.g. closing a terminal window
without Ctrl+C, or a crashed session leaving the Node process orphaned). This could not be
confirmed directly from this sandbox (it reflects the user's local Windows machine, not this
environment) -- see the report below for the exact commands to identify/kill it if it recurs.
Separately confirmed: `frontend/src/lib/api.ts`'s `API_BASE` falls back to the fixed
`http://localhost:4000` (not a relative same-origin path), so the frontend landing on 3001 instead
of 3000 does *not* by itself break the API calls -- but it **would** break CORS if the backend were
running with its default `.env`'s `FRONTEND_ORIGIN=http://localhost:3000` (an exact-origin allowlist
that a same-machine 3001 wouldn't match). Flagged as a second, independent possible contributor,
not confirmed as the actual cause of this specific test run.

**The real, codebase-level bug (Standards Section 3.23 gap).** Traced the KPI cards' data path:
`page.tsx` -> `useTachometerOverview`/`useFilterOptions`/`useRefreshStatus`/`useTachometerTrend`
(`frontend/src/lib/hooks.ts`) -> `token` from `useDevAuth()` (`DevAuthProvider.tsx`) ->
`fetchDevToken` (`lib/api.ts`) -> `POST /dev/auth/token`. Found: every one of those hooks' `load()`
started with `if (!token) return;` -- correct while auth is still in flight on first mount, but if
the token mint itself fails for *any* reason (backend down, CORS block, non-2xx), `token` stays
`null` forever, and `load()` just keeps returning early *without ever setting `loading` to `false`
or setting an `error`*. Initial state is `{loading:true, error:null}`, so every one of these hooks
-- and every KPI card, ASP card, filter dropdown, and the refresh-status readout -- froze at that
initial state permanently. `DevAuthProvider` itself *does* correctly catch its own token-mint
failure into its own `error` state, but nothing downstream ever read it, and neither
`page.tsx` nor the breakdown detail page destructured it from `useDevAuth()` at all -- so the one
real error that explained everything was captured but effectively invisible.

Fix (`frontend/src/lib/hooks.ts`, `DevAuthProvider.tsx`, both `page.tsx` files):
- `DevAuthProvider` now exposes `retryAuth()` (re-mints the token for the current role) alongside
  its existing `error`, and `console.error`s the raw underlying error the moment the mint fails.
- Every hook in `hooks.ts` now takes `authError` and `retryAuth` in addition to `token`. A new
  `authGate()` helper: if there's no token *and* `authError` is set, the hook resolves its own state
  to that same error (instead of freezing) -- so the card renders the ErrorState+Retry UI it
  already supported, never an infinite skeleton. Each hook's returned `retry()` now calls
  `retryAuth()` instead of a no-op `load()` when there's no token, so clicking Retry on *any* card
  actually re-attempts the thing that's really broken (the token mint), and once it succeeds every
  dependent hook re-fires automatically (they all depend on `token` in their `useCallback` deps).
- `frontend/src/lib/api.ts`'s `request()` now wraps the raw `fetch()` call itself in a try/catch
  (previously a network-level throw -- backend down, CORS block -- happened *before* the
  `!res.ok` check, i.e. before there was ever a `Response` to inspect) and `console.error`s the
  real underlying error + the exact URL attempted, for both network failures and non-2xx
  responses, so any future occurrence is diagnosable from the browser console alone.

Both `page.tsx` (summary) and `frontend/src/app/tachometer/[metric]/page.tsx` (detail) updated to
destructure `error`/`retryAuth` from `useDevAuth()` and thread them into every hook call site.

**Preventing the missed-terminal step.** Added a root-level `npm run dev` script
(`package.json`) using `concurrently` to run `dev:backend` and `dev:frontend` together in one
terminal/command, so starting only the frontend can no longer happen by accident.
`concurrently@^8.2.2` added as a root devDependency and installed (`package-lock.json` updated).

**Verification.** `tsc -p tsconfig.json --noEmit` clean against the full set of changed files
(`hooks.ts`, `DevAuthProvider.tsx`, `api.ts`, both `page.tsx` files), synced into
`/tmp/frontend_typecheck` via the established heredoc workflow. A full live browser
end-to-end run (start both servers, watch a card's skeleton resolve to real numbers, stop the
backend and watch the error+retry state appear, restart and confirm recovery) could **not** be
completed inside this sandbox: attempting to boot the real backend here failed immediately with
`Error: You installed esbuild for another platform than the one you're currently using` --
`node_modules` in this mount was installed on the user's Windows machine (`@esbuild/win32-x64`),
and this sandbox is Linux (`@esbuild/linux-x64`). This is a pre-existing artifact of the sandbox
mount, unrelated to this fix, and was *not* worked around by force-installing a Linux esbuild
binary into the real `node_modules`, since that risks corrupting the lockfile/optionalDependencies
resolution the user's own Windows `npm install` depends on. Two things were confirmed by direct
code inspection instead: `backend/src/db/pool.ts` uses `mysql.createPool` (lazy -- does not
eagerly connect, so the backend process itself boots and listens on :4000 even without a reachable
database), and `backend/src/routes/devAuth.ts` never touches the database at all -- so the token
mint succeeding or failing is purely a function of whether the backend process is reachable, not of
database/warehouse state. The live stop-backend/restart-backend demonstration described in the next
status update should be run by the user locally, where the real dev environment (matching
Windows `node_modules`) is available.
