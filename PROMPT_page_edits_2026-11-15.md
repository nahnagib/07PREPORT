# Prompt: Product, Salesforce and Detractor page edits (2026-11-15)

You are working in the 07Ps Sales Dashboard repo at `C:\Users\Lenovo\Desktop\07PREPORT` (app in `07ps-sales-dashboard-app/`, Next.js frontend in `frontend/src`, Node/TS backend in `backend/src`, Python ETL in `data/etl`). Read `README.md`, `CONTRIBUTING.md` and the latest entries of `CHANGELOG.md` before you start.

## Hard rules (apply to every step)

1. **Work only in the main folder** `C:\Users\Lenovo\Desktop\07PREPORT`. Do not edit the other worktrees (`07PREPORT-merged`, `07PREPORT-pdp`, `07PREPORT-l12m`, `07PREPORT-bcgcompare`, the `07PREPORT-Recovery-*` folders).
2. **No new branches.** Don't run `git checkout -b`, `git switch -c`, `git worktree add` or anything similar. Stay on the branch that is checked out now.
3. **No push.** Don't run `git push`, don't open a PR and don't call `gh`. Local commits are fine.
4. **No ETL.** Don't run any ETL job, refresh, scheduler, worker or `etlControl` endpoint, and don't touch Odoo. Use the data already in the local database and in `Input/` as it is. If a feature needs data that isn't there, stop and report it. Don't fetch the data yourself.
5. The only database change allowed is applying the app's own schema migrations to the **local** DB, and only when a step below needs it (for example the PDP tables). Report every migration you apply.
6. Keep the dark theme design tokens (`--ps-color-*`) and the existing components (`Card`, `KpiTile`, `ProductTooltip`/`TooltipRow`, help "?" icons, `ValidationStatusBar`, export buttons). Don't add new UI libraries.
7. Every change of label or definition also goes into: exports (CSV/PDF/image), visual help (`frontend/src/lib/visualHelp.ts`), the user manuals' wording if they're affected (list the changes in your report; don't regenerate PDFs), tests and `CHANGELOG.md`.

---

## Step 0 — Bring the latest page code into the main folder (do this first)

Facts:
- Main folder: branch `codex/local-pipeline-value` @ `fc55c3d` (2026-11-10), with **many uncommitted changes** (NPS SLA, productDashboard, ETL input files, and so on).
- The screens being edited (the BCG "Total SKUs / Product Status" cards, Product Lifecycle "Portfolio Freshness", `people/salesforce-performance`, the new NPS follow-up SLA cards, and the PDP module with tree, roadmap, projects, launches, feedback, policy and admin pages) live on the existing local branch **`local/bcg-pdp-preview`** @ `f44fe2b` (checked out in `Desktop\07PREPORT-merged`).
- The two branches have diverged: 18 commits on `local/bcg-pdp-preview` aren't on the current branch, and 8 commits on the current branch aren't on `local/bcg-pdp-preview`.

Do this:
1. Run `git status` and save the full list of uncommitted files in your report.
2. Preserve the uncommitted work as a local commit on the current branch: `git add -A && git commit -m "WIP: local snapshot before 2026-11-15 page edits"`. Don't stash, because a stash is easy to lose. Check first that no secrets (`.env`) are being staged.
3. `git merge --no-ff local/bcg-pdp-preview` into the current branch. This is a merge of an existing branch, so no new branch is created.
4. Resolve conflicts:
   - For the product pages (BCG, PIM, Lifecycle, Stock Velocity, PDP), `people/salesforce-performance`, `nps-followup` and `productDashboard`, prefer the `local/bcg-pdp-preview` version, **then re-apply** any real logic from the WIP snapshot that the preview branch doesn't already have.
   - For NPS SLA config (`npsSla.ts`), the ETL `input_files.py` and `inventory.py`, compare both sides line by line and keep the union of the behaviour.
   - Migration numbering: PDP migrations are `0075–0077`, after `0073/0074`. Make sure there are no duplicate numbers. Also check `other-session-2026-11-14/0074_workbook_product_exclusions*.sql` against what's already in the tree.
   - **If a conflict needs a business decision, or there are more than about 15 conflicted files with real logic on both sides, stop and report before you continue.**
5. Run backend + frontend typecheck and tests (`vitest`). The merged tree must be green before you continue. Commit the merge locally.
6. Start the app locally (see `RUN_LOCAL.md` / `local-test.cmd`) against the existing local DB, and confirm the pages look like the screenshots before you edit anything.

---

## 1. BCG Matrix page — `frontend/src/app/(departments)/product/bcg-matrix/`

### 1a. Total SKUs: full width, Critical Number style
- The "Total SKUs" card has to span the **full row width**. Today it's a small card on the left.
- Style it like the hero card on the Critical Number page (`DailyCriticalNumberCard` in `promotion/critical-number/page.tsx`): same big number size and weight, same card treatment and spacing. Extract a shared component or CSS if that's cleaner than copying.
- Keep the breakdown line "Active · Non Active · Dormant · Unclassified" and the note "Active + archived, every category". Each part of the breakdown should be a small clickable chip (see 1b).

### 1b. Clickable Product Status cards → product table page
- Make the **Active, Non Active, Dormant and Unclassified** cards clickable (the four Product Status cards, plus the chips in the Total SKUs breakdown). Use the existing `ps-card-clickable` pattern with hover, focus ring and keyboard (Enter/Space).
- Each one opens a new page, `product/bcg-matrix/products?status=active|non_active|dormant|unclassified`, that carries the current filters in the query string (company, customer group, channel, branch, anchor date / period).
- The page shows a **table of those products**: product name, internal ref/SKU, **company**, category, brand, status, units (period), units (prior period), sales value, profit, GP%, quantity on hand, last sale date and an Odoo link (`OdooLink`). Add search, column sort, a status switcher (tabs across the four statuses with counts), pagination or virtualisation for 1,500+ rows, CSV export and a back link to BCG.
- Status-specific extras:
  - **Non Active**: a sub-filter "With stock (736) / Zero stock (702)" that matches the card.
  - **Dormant**: show "archived in Odoo" and the archive date if we have it.
  - **Unclassified**: show the **exclusion rule** that matched each product (from the ProductExclusions rules).
- The counts on the table page must equal the card counts for the same filters. Add a test for this.
- Backend: reuse the existing product facts / productDashboard data. If Dormant or Unclassified rows aren't in the current endpoint, add a read-only endpoint (or extend the existing one) that reads from the tables already loaded. **No ETL.** Respect the existing permission for the BCG page.

### 1c. Company on hover
- Add **Company** to the product hover tooltip. This is the one in the screenshot with the "QUA · STARS · NEW" chips and "SALES – LAST 12 MONTHS", and also the `rowTooltipContent` / `ProductTooltip`. Put it near the header, under the product name, as a line or chip.
- Apply it in the shared tooltip component so every product hover on the Product pages shows the company.

---

## 2. PIM Contribution page — `product/pim-contribution/page.tsx`

- **Remove the "Categories" donut card** completely: the By Volume / By Value toggle, "Export image", the top-8 legend and the "Other (+34)" row.
- Remove the dead state and memo that only served it (`categoryMetric` and related), its export entry, its visual-help entry and its tests. **Keep** the Category filter and the Category level of the drill hierarchy.
- Check the remaining layout still fills the space with no empty gap.

---

## 3. Product Lifecycle page — `product/product-lifecycle/page.tsx`

### 3a. "?" definitions on every card
- Add the standard help "?" icon (same component as on "Segment Volume — Pareto") to every KPI card: Mature SKUs, Dormant (renamed, see 3b), Portfolio Freshness, plus any other KPI cards on the page.
- Write each definition **from the actual rule in the code** (backend lifecycle classification plus the frontend filters). Don't invent wording. Include the time window, for example "first sold in the last 180 days", and the denominator.
- Also add definitions for each lifecycle segment on the Pareto (Growing, Declining, Mature, New, Dormant, Never sold).

### 3b. "Discontinued" → "Dormant"
- Rename every user-facing "Discontinued" on this page to **"Dormant"**: card, Pareto x-axis, filters, legends, tooltips, exports, visual help and tests.
- Align the **definition** with the BCG page: Dormant = archived in Odoo.
  - Check the current lifecycle rule. It looks like "sold in prior period, not in current" (the card says "31.8K Unit sold in the prior period").
  - If the rules differ, change the lifecycle rule so that Dormant here matches the BCG Dormant set for the same filters. Products that would have been "Discontinued" but are not archived belong to the matching active/non-active segment.
  - Report the **before and after counts** for each segment.
- Internal enum keys may stay as they are if renaming them is risky, but no UI or export may show "Discontinued".

### 3c. Portfolio Freshness = Active + Non Active only
- Our real portfolio is **Active + Non Active**. Freshness must ignore Dormant and Unclassified.
- New rule: Freshness % = SKUs first sold in the last 180 days ÷ (Active + Non Active SKUs, after the page filters).
- Card text: the big % with a sub-line showing the split, for example "174 new SKUs · 160 Active · 14 Non Active". Make the Active/Non Active split visible either in the sub-line or as two mini figures.
- Update the "?" definition, visual help and tests. If "Mature SKUs — % of filtered portfolio" uses the same portfolio denominator, list it in the report as a follow-up. Don't change it unasked.

---

## 4. Product Development Plan — `product/product-development-plan/*`

This is a **planning** page, and the current design doesn't work well. Rebuild the experience **in the Kaizen Board style**:
- Reference implementation: `process/kaizen-board` (board, `cards`, `manage`, `manage/new`, `manage/[no]`), `components/kaizen/*` (`KaizenShell`, `KaizenCardForm`, `KaizenFilterBar`, `useUrlFilters`, `CloseCardDialog`, `KaizenBits`), `admin/kaizen-dropdowns`, `backend/src/routes/kaizen.ts`.
- Reuse those patterns and components wherever possible. Don't fork them blindly.

### 4a. Data structure from the reference files (reference only)
Read the four files in `Input/product_development/`:
- `Product_Tree.xlsm`: the product hierarchy and the fields per node.
- `RD_Scoring_Matrix.xlsx`: scoring criteria, weights and scale.
- `R_D_Policy.docx`: the stage-gate process, roles, approvals and rules.
- `Xtreme_Roadmap.pptx`: roadmap periods, brands and launches.

Use them **only to design the data model**: tables, columns, enums, dropdowns, stages, scoring weights and roles. **The app is the source of truth.**
- Every create and update happens through the app's forms.
- There is no runtime import from these files and no scheduled read. Don't add them to the ETL input-file list.
- Compare the existing PDP migrations (0075–0077) and seed with what the files actually contain. Fix missing or wrong fields with a **new** migration. Don't edit applied migrations.
- A seed with this reference data for local testing is fine. Mark it clearly as a seed.
- `PROMPT_product_development_plan.md` in the repo root holds the earlier spec. Use it as background; where it conflicts with this prompt, this prompt wins.

### 4b. Pages (Kaizen-style)
1. **Board (landing):** columns = the stage-gate stages from `R_D_Policy.docx`, in its order. Don't invent stages.
   - Each card shows: project code, product/brand, owner, score (from the scoring matrix) with a colour band, target launch date, an overdue badge and days in stage.
   - Moving between stages uses the gate rules in the policy (for example, a required approval or a minimum score). Use buttons or a dialog with a required note, like Kaizen's `CloseCardDialog`.
   - Above the board: KPI band (projects per stage, overdue, launching this quarter, average score) and the filter bar (company, brand, category, owner, stage, priority), with filters kept in the URL.
2. **List view:** the same projects as a sortable, exportable table, like `kaizen-board/cards`.
3. **Manage / New / Edit:** the form follows `KaizenCardForm`.
   - **Scoring:** criteria and weights come from the scoring matrix. The score is calculated live while the user fills the form.
   - **Product link:** a picker from the product tree.
   - Plus attachments/notes if Kaizen has them, and a history/audit trail of stage changes.
4. **Product Tree:** replace the current tree with a proper explorer.
   - Left: a collapsible, indented hierarchy (levels from `Product_Tree.xlsm`, likely Company → Category → Brand → Sub-brand → Family → Size/Product). It has search with auto-expand, expand/collapse all, a count badge per node and a marker on nodes that have active PDP projects.
   - Right: a detail panel for the selected node with its attributes, its projects in the pipeline and "New project here".
   - Users with permission can add, rename and move nodes in the app.
5. **Roadmap:** a timeline by quarter (periods from `Xtreme_Roadmap.pptx`) with one swimlane per brand/category. Projects sit by target launch date and are coloured by stage. Clicking one opens the project.
6. **Admin dropdowns:** stages, scoring criteria/weights, priorities and similar lists are editable like `admin/kaizen-dropdowns`, and only for admins.
7. Keep Launches, Feedback and Policy only if they fit this flow. Otherwise fold them into the project detail (launch and post-launch feedback as tabs) and keep Policy as a read-only help page. Explain what you merged or removed.

Permissions: reuse `product_development_plan` (view) and add edit/admin keys in `permissionRegistry.ts` if they aren't there already. Add backend route tests and DB tests like the Kaizen ones. Before you build, sketch the page layouts in your plan, and verify them in the browser afterwards.

---

## 5. Salesforce Performance page — `people/salesforce-performance/`

### 5a. "Status" → "Tiers"
- The performance classification (Top performer, On target, …) is renamed **"Tiers"** in the UI.
- That covers section titles, card captions ("No one in this status" → "No one in this tier"), the mix chart, the monthly chart legend, the filter, tooltips, the drill notes ("…was X YTD"), exports, visual help and tests.
- Internal type and key names (`PeopleStatus`, `statuses`, …) may stay as they are to limit risk. If you do rename them, rename them across backend and frontend in one step. Don't confuse this with other "status" fields such as refresh status or validation status; leave those alone.

### 5b. Add the B2B Director and B2C Director
- The two directors are **not sales people**, but they have targets, so they belong on the page.
- Find where their targets live: the sales targets input used by Critical Number / `salesPeoplePerformance` (for example `sales_targets.xlsx`) and the director scope already in `backend/src/measures/filters.ts`.
- Each director's **actual** = their channel's total (B2B or B2C) under the page filters. Use the same scope logic the app already uses for director users. Don't sum individual reps by hand if a scope helper exists.
- Show them in a separate **"Directors"** row/section above the people list, with the same card style, target vs actual, variance and tier.
- Exclude them from the people tier counts, the team totals and the "Team pulse", so nothing is double-counted.
- If their target rows are missing from the current data, **stop and report**. Don't invent targets.

### 5c. Variance spacing
- "−LYD 14.5M · -66.08%" reads as one cramped string, and it mixes two different minus signs.
- Put the amount and the percentage in **separate elements**: amount on the main line, percentage as its own pill/chip or on its own line, with real spacing (≥ 8px) and the same colour logic.
- Use one consistent minus sign (U+2212) for both.
- Apply it everywhere this pattern appears on the page, and check whether other pages use the same helper.

---

## 6. Detractor Follow-up page — `process/nps-followup/` + `components/nps-followup/*`

Add visible section labels, in the same style as the existing section titles (for example "Product Status" on BCG), and reorder the cards into this order:

1. **SLA Performance**: Close SLA missed, Contact SLA missed, Resolved last 30 days (within SLA).
2. **Status**: Open, Closed, Disputed, Not classified.
   - "Not classified" (no reason chosen) isn't an SLA metric, so it goes under Status. If the code treats it differently, say so in the report.
3. **Stages**: the kanban (New, Contacted, In progress, Resolved (30 days), Unresolved).
   - Keep the explanatory note ("New detractors appear as cases within 30 minutes…") under this label.

Keep each card's "?" help, its click-to-filter behaviour (if any) and the responsive layout. Update visual help, `FollowupHelp.tsx` and the tests (`followupSla.test.tsx` and others).

---

## Verification (required before you report)

- Backend and frontend typecheck, lint and all `vitest` suites pass. Add or adjust tests for: card-to-table count parity (1b), company in the tooltip (1c), PIM without the donut (2), Dormant naming and the freshness denominator (3), PDP routes and the scoring calculation (4), the tiers label, directors excluded from team totals and the variance markup (5), and the section order (6).
- Run the app locally against the existing DB (no ETL) and check every changed page in the browser, in dark theme, at desktop and mobile widths. Take before/after screenshots and save them in `Claude outputs/2026-11-15-page-edits/`.
- `CHANGELOG.md` entry for each section.
- Commit locally on the current branch with clear messages: one commit per section, after the Step 0 commits. **Don't push.**

## Final report

- The git state: the branch name, the commits you made, and how you resolved the conflicts in Step 0.
- Files changed, per section.
- Before/after numbers: lifecycle segment counts after the Dormant alignment, the freshness % before and after, and the directors' target and actual.
- Any migrations applied to the local DB.
- Open questions and anything you skipped because it needed data that isn't loaded or a business decision.
