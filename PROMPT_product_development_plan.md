# PROMPT — Build the "Product Development Plan" page (Product department, TIKA only)

> Paste everything below into the coding agent working in `07ps-sales-dashboard-app`.
> Source files from the TIKA CEO are in `Input/product_development/` (repo root, one level above the app).

---

## 0. Your role and how to work

You are working in the 07PS dashboard app (`07ps-sales-dashboard-app`: Next.js frontend in `frontend/`, Express + TypeScript backend in `backend/`, MySQL warehouse with numbered migrations in `data/warehouse/migrations/` and matching reverse scripts in `data/warehouse/down/`).

Replace the "coming soon" placeholder at **Product → Product Development Plan** with a real module. The module has two halves:

1. **A read-only plan and monitoring view.** It covers the TIKA R&D policy, the Xtreme product tree, the 2023–2028 roadmap, the R&D project pipeline, KPIs, launch tracking and customer feedback.
2. **Data entry inside the app.** Every number on the view must be entered, changed and approved through the app's own forms. Nothing should be kept in Excel any more. The Excel files are used once, as a seed import.

Work in this order and stop for my review at the two checkpoints marked **⏸**:

1. Read the files in §1 and the source files in §2.
2. Write a short plan (tables, endpoints, screens, permission keys, migration numbers) to `docs/product-development-plan.md`. **⏸ Stop and show me the plan.**
3. Build the backend: migrations, services, routes and tests.
4. Build the frontend: screens and forms.
5. Build the seed import, then run it locally against the test stack. **⏸ Stop and show me the import report before anything touches production.**
6. Update the docs, the user manual section and CHANGELOG.

Work on a new branch (`feature/product-development-plan`). Do not apply migrations to production and do not push without my approval.

---

## 1. Read these first (existing patterns you must follow)

| What | Where | Why |
|---|---|---|
| Current placeholder | `frontend/src/app/(departments)/product/product-development-plan/page.tsx` | Replace it. Keep the route and the `pageKey` `product_development_plan`. |
| Nav entry | `frontend/src/lib/navItems.ts` (line with `product_development_plan`, `comingSoon: true`) | Remove `comingSoon`. Add sub-routes the same way Kaizen does. |
| Permission registry | `backend/src/config/permissionRegistry.ts` | This is the single source of truth for page keys and actions (`view`, `create`, `edit`, `delete`, `export`). |
| Placeholder migration | `data/warehouse/migrations/0060_coming_soon_pages.sql` | Shows how `pages`, `permissions` and `role_permissions` are seeded. Rename the page label (drop "(coming soon)"). |
| **Data-entry model to copy** | Kaizen Board: `backend/src/routes/kaizen.ts`, `backend/src/services/kaizen*Service.ts`, `data/warehouse/migrations/0027_kaizen_board.sql`, `frontend/src/app/(departments)/process/kaizen-board/{page.tsx,cards,manage}`, `frontend/src/components/kaizen/`, admin page `/admin/kaizen-dropdowns` | Follow these patterns: two permission pages (dashboard vs. data entry), validation errors with `code`/`field`, soft delete, Excel export, one-time admin-only Excel import, and admin-managed dropdowns. |
| Workflow with stages and owners | NPS Follow-up: `backend/src/routes/npsFollowup.ts`, migrations `0052`, `0059`, `0066`, `0072` | Shows the stage/status pattern and owner tracking. Reuse it for the gate workflow. |
| Product department UI | `frontend/src/components/product/` (`ProductUi.tsx`, `useProductFilters.ts`), the other `product/*` pages | Match the look, the filters and the PDF/Excel export behaviour. |
| Companies | `docs/rename-map.md`, `dim_company`, migration `0065_product_pages_one_company.sql`, `config/product_dashboard.json` | See §3, rule 1. |

The latest migration is **0072**. Use **0073 onward** and write a `down/` script for each one. Every migration must be idempotent (same style as 0060/0065).

---

## 2. Source data (from the TIKA CEO)

All four files are in `Input/product_development/`:

### 2.1 `R_D_Policy.docx`: TIKA R&D Policy (business rules)

- **Governance roles:** EXCO (strategic oversight, final approval), CEO (portfolio leadership), Technical Manager (owns the whole pipeline), R&D (formulation, benchmarking, documentation), Technical Support (field trials, validation), Commercial (demand, competitors, pricing), Marketing (packaging, naming, branding), QC/QA (standards compliance), Production (scale-up, manufacturability).
- **Project classification:** Planned (from the 3-year roadmap), Unplanned (urgent customer or market need), Innovation, Reformulation.
- **Decision gates:** G0 Request submission → G1 Feasibility and priority scoring → G2 Lab formulation and testing → G3 Field validation → G4 Pilot production and QC alignment → G5 Final approval and launch.
- **Unplanned projects:** fast-track evaluation, strict scoring, and CEO/EXCO approval required.
- **Fast-track:** primary feasibility within **72 hours**, quick benchmarking, emergency sourcing, parallel testing, mini trials at the customer's site.
- **Innovation ideas:** any employee may submit one. R&D classifies it as Quick win / Commercial-driven / Technical enhancement / Strategic long-term.
- **Feasibility checklist (G1):** raw material qualification, equipment capability, cost structure, standards mapping (EN/ASTM), market availability, risks and mitigation.
- **Raw material approval (QC + R&D):** purity, moisture, particle size, compatibility, stability, cost efficiency.
- **Lab formulation (G2):** benchmark against Sika, Mapei and Weber. Test adhesion, strength, flexibility, curing, workability and climatic performance.
- **Field validation (G3, led by Technical Support):** setting, bonding, flexibility, coverage, customer satisfaction.
- **Documentation package (required before G5):** TDS, MSDS, final formula, QC specs, production SOP, Method of Statement, compliance certificates.
- **Pilot scale-up (G4):** batches of **500–1,500 kg**. QC verifies, R&D approves scale accuracy, Production confirms manufacturability.
- **Launch (G5):** Marketing prepares training and communication. EXCO approval is required.
- **Capacity:** at most **6 concurrent projects**, a monthly portfolio review, a freeze on new requests in peak season, and a target mix of **50% planned / 30% unplanned / 20% innovation**.
- **KPIs:** 3 new products per quarter, 2 reformulations per quarter, field-trial success ≥80%, first-pass lab success ≥85%, on-time delivery ≥90%, cycle time ≤60 days, 0 critical documentation errors.

### 2.2 `RD_Scoring_Matrix.xlsx`: priority scoring (G1)

Each criterion is scored 0–5. `weighted = score × weight / 5`, and the total is out of 100. **The minimum to proceed is 60.** Each project also needs an evidence/justification text per criterion.

| Criterion | Weight | 0 → 5 meaning (5 is always the most favourable) |
|---|---|---|
| Strategic Alignment | 20 | No alignment / Very weak / Limited or partial / Good alignment with one pillar / Strong alignment with key pillars / Critical strategic priority |
| Revenue Potential | 20 | No commercial value / Very small / Moderate / Good return expected / High revenue potential / Major revenue generator |
| Technical Risk | 20 | Very high risk, likely to fail / High risk, sensitive to conditions / Medium-high, requires controls / Moderate, manageable / Low risk / Very low risk, highly stable |
| Development Difficulty | 20 | Very difficult, advanced chemistry / High, many iterations / Medium-high / Moderate / Low / Very easy, straightforward formula |
| Urgency | 10 | Not urgent / Low / Moderate / Needed this quarter / High urgency / Immediate need for active project |
| Production Impact | 10 | Major changes or new machinery / High impact / Medium-high / Moderate / Low / No impact on production |

Store the criteria, weights and the six meaning texts as **configuration rows**, not hard-coded values, so an admin can change them later. Keep the weight total check at 100.

### 2.3 `Product_Tree.xlsm`: the Xtreme product tree

- The **clean source is sheet `ورقة1`** (header on row 3, products from row 4). Its columns are: Product Brand, Product Family, Product Subfamily, Product Name, Product Description, Product Status, Launching Date, comment. It has 55 products, all under brand **Xtreme**.
- **Status values:** `In Market` (13), `Planned` (23), `under Development` (19). Store them as normalized codes (`in_market`, `planned`, `under_development`) and show them with proper labels.
- **`Sheet1` (F16:G24)** holds a one-line description for each of the 8 families: Tile Fixing, Waterproofing, Masonry & Repair Mortar, Flooring, Renders, Putties & Skimming, Special Paints & Primer, Specialty Construction Chemicals.
- **`TreeNodes`** is a Power Query output (Level 1 Brand → 2 Family → 3 Subfamily → 4 Product), and a VBA macro (`BuildDynamicTree`) draws it as an expand/collapse diagram. It colours nodes by level (1 blue, 2 green, 3 orange, 4 purple) and shows a tooltip on products with description, status and launch date. **Rebuild this behaviour in the web app.** Do not import the TreeNodes sheet. Compute the tree from the data.
- **Spelling clean-up during import.** Use the `ورقة1` / `Sheet1` spellings: "Waterprooing" → Waterproofing, "Masonary" → Masonry, "Specail" → Special, "Chemcails" → Chemicals, "Terrazo" → Terrazzo, "Hardner" → Hardener, "putties& skimming" → Putties & Skimming, "Cementious" → Cementitious. Print every correction in the import report.
- The `comment` value "As market needs" means the launch date is flexible. Store it as a boolean `launch_date_flexible` plus a free-text comment.

### 2.4 `Xtreme_Roadmap.pptx`: roadmap and framework (December 2025)

- **Timeline years:** 2023 Foundation, 2024 Expansion, 2025 Transformation, 2026 Portfolio, 2027 Optimization, 2028 Innovation & Advanced Systems. Store these as an editable `roadmap_year` table (year, theme, notes).
- **Project types:** NPD, Product Improvement / Optimization, Localization & Cost Optimization, Technical Support–initiated Improvement, Sales/Market Demand Request.
- **Approval structure:** Kick-off approval by the Chairman/CEO. Technical evaluation by R&D + QC + Production. Pre-launch validation by Technical Support. Final launch approval by EXCO.
- **Key principle:** every project **must link to a node of the official Product Tree**, either an existing product or a new product added to a subfamily.
- **The 7-step process in the deck** maps onto the policy gates like this. Use the gates as the stage model and show the deck's step names as sub-labels:
  1 Request submission = G0. 2 Initial evaluation and scoring = G1. 3 Kick-off (form approved, team assigned, objectives) = end of G1. 4 Development and lab testing = G2. 5 Field trials and validation = G3. *(Pilot = G4, policy only.)* 6 Final approval = G5. 7 **Project closure** (closure report, data archived, KPIs reviewed) is a final **Closed** state after G5.
- **Gap analysis (slide 9):** "Mentoring tools (product launch tracking, dashboard & customer feedback)". **"Mentoring" here means *monitoring*.** The launch-tracking and customer-feedback screens in §5 are what the CEO asked for. Store the rest of the gap analysis (5M: Methods, Machine, Manpower, Measurements, Materials) as an editable checklist with owner, status and due date.

---

## 3. Hard rules

1. **TIKA only. Majaal is not a manufacturing company and must never appear in this module.** Every table in this module carries `company_key` (FK to `dim_company`). Seed TIKA as its value and enforce it in the service layer. The page shows no company filter. Watch for the known trap in `backend/src/db/__tests__/tableNameCase.test.ts`: the legacy `Dim_Company` uses 1 Majaal / 2 Tika, while the core `dim_company` uses Odoo ids 1 Majaal / 3 Tika. **Resolve TIKA by name/Odoo id from the core `dim_company`. Never hard-code a key.** Add a test that a Majaal `company_key` is rejected.
2. **Permissions**, registered in `permissionRegistry.ts` and seeded by a migration:
   - `product_development_plan` (group `dashboard`, actions view + export): the read-only views in §5.1–5.6.
   - `product_development_entry` (group `data_entry`, actions view, create, edit, delete, export): all forms.
   - `product_development_approval` (group `data_entry`, actions view + edit): who may **approve or reject a gate**. Each gate also checks the approver's *governance role* (§4, `pdp_governance_member`), so holding the permission alone is not enough.
   - Grant View on the plan to the roles that already view Product pages (copy the 0060 grant query). Grant entry and approval to ADMIN only. I will assign the other roles on the Roles page.
3. **Audit everything.** Every row has `created_by`, `created_at`, `updated_by`, `updated_at`. Use soft delete (`deleted_at`). Every gate decision and every status change writes an append-only history row (who, when, from → to, comment). Never update or delete history rows.
4. **No Excel at runtime.** The xlsm/xlsx/docx/pptx files are read **only** by the one-time admin import (§6). After that, all changes go through the app.
5. Validate on the backend (the frontend checks are only for convenience). Errors use the Kaizen shape `{ error, code, field }`.
6. Match the existing UI style, light/dark theme, mobile layout and Excel/PDF export of the other Product pages.

---

## 4. Data model (proposal; refine it in the plan)

Use the prefix `pdp_` (product development plan). Every table also has `company_key` plus the audit columns.

| Table | Purpose / key columns |
|---|---|
| `pdp_brand` | Xtreme (more brands later). |
| `pdp_product_family` | name, description (from Sheet1), sort_order. |
| `pdp_product_subfamily` | family FK, name, sort_order. |
| `pdp_product` | subfamily FK, name, description, status (`in_market` / `planned` / `under_development` / `discontinued`), planned_launch_date, actual_launch_date, launch_date_flexible, comment, optional `dim_product` link (the matching Odoo product once it exists; nullable; with a picker). |
| `pdp_product_status_history` | Every status/launch-date change, with a reason. |
| `pdp_roadmap_year` | year, theme, notes. |
| `pdp_policy_document` + `pdp_policy_section` | The policy text, stored as versioned sections (number, title, body). The import seeds version 1.0 from the docx. Admins can publish a new version, and old versions stay readable. |
| `pdp_governance_role` / `pdp_governance_member` | The roles in §2.1 (EXCO, CEO, Chairman, Technical Manager, R&D, Technical Support, Commercial, Marketing, QC/QA, Production), each linked to app users. |
| `pdp_project` | code (auto, e.g. `RD-2026-001`), title, product FK (**required**) or a new-product proposal that creates a `planned` product on approval, classification (planned / unplanned / innovation / reformulation), project_type (the 5 deck types), innovation_category (the 4 policy categories, innovation only), requested_by, request_source (Sales / TS / R&D / QC / Commercial / Employee idea), fast_track flag, owner (Technical Manager by default), current_gate (G0–G5), state (`draft` / `submitted` / `active` / `on_hold` / `rejected` / `launched` / `closed`), target_launch_date, start_date, closed_date, objectives, team (members with roles). |
| `pdp_scoring_criterion` | name, weight, meaning_0 … meaning_5, active, sort_order (seeded from §2.2). |
| `pdp_project_score` | project, criterion, score 0–5, evidence (required), scored_by, scored_at. A project can be re-scored, so keep every scoring round (`round_no`). The latest round counts. |
| `pdp_gate_decision` | project, gate, decision (approve / reject / revise), approver, approver_governance_role, comment, decided_at. The list of approvers required per gate is configured in `pdp_gate_rule`. |
| `pdp_gate_rule` | gate, required governance roles (all/any), required checklist items. |
| `pdp_checklist_item` / `pdp_project_checklist` | Gate checklists: G1 feasibility (6 items), raw-material approval (6 tests), G5 documentation package (7 docs). Each item has status, file attachment or link, owner, date. |
| `pdp_lab_test` | project, trial no., benchmark competitor (Sika / Mapei / Weber / other), property (adhesion, strength, flexibility, curing, workability, climatic), result, target, pass/fail, **first_pass** flag. |
| `pdp_field_trial` | project, site, customer (optional Odoo customer link), date, the 5 evaluation items scored, overall pass/fail, TS lead, notes, photos. |
| `pdp_pilot_batch` | project, batch kg (validate 500–1,500), QC ok, R&D scale ok, Production manufacturability ok. |
| `pdp_launch` | product, launch date, training done, communication plan done, EXCO approval link, launch status. |
| `pdp_customer_feedback` | product, customer, date, channel, rating 1–5, category (performance / application / packaging / price / other), comment, follow-up owner, status. Reuse the NPS follow-up stage pattern. |
| `pdp_kpi_target` | kpi_code, target, period type. Seeded from §2.1 and editable. |
| `pdp_gap_item` | 5M category, item, owner, status, due date (seeded from slide 9). |
| `pdp_setting` | max_concurrent_projects = 6, mix targets 50/30/20, min_score = 60, fast_track_feasibility_hours = 72, peak_season_freeze from/to (**month-day range; ask me for the months, default empty**). |

File attachments: reuse whatever upload mechanism `marcomUpload.ts` / Kaizen uses. Do not invent a new storage.

---

## 5. Screens

Route base: `/product/product-development-plan`. Use tabs or sub-routes, the way Kaizen splits `page.tsx`, `cards` and `manage`.

### 5.1 Overview (default tab, monitoring dashboard)
- KPI tiles versus targets: new products this quarter (target 3), reformulations this quarter (2), field-trial success % (≥80), first-pass lab success % (≥85), on-time delivery % (≥90), average cycle time in days (≤60), critical documentation errors (0). Colour each tile green or red against its target. Clicking a tile drills into the projects behind it.
- Capacity gauge: active projects out of 6, the actual planned/unplanned/innovation mix next to the 50/30/20 target, and a peak-season-freeze banner when the freeze is on.
- Pipeline funnel: number of projects per gate.
- Alerts list: fast-track projects past 72 h without feasibility, projects past their target date, gates waiting for my approval, products whose launch date has passed while they are still `under_development`.
- Portfolio counts by status and family.

**KPI definitions** (put them in the doc and in an ⓘ tooltip on each tile):
- *Field-trial success* = passed trials / all trials in the period.
- *First-pass lab success* = projects whose first lab trial passed every target / projects with lab trials.
- *On-time* = projects launched on or before target_launch_date / projects launched.
- *Cycle time* = G0 submission → G5 approval, in days.
- *New products* = G5 approvals for classification ≠ reformulation in the quarter.
- *Reformulations* = G5 approvals for classification = reformulation.

### 5.2 Product Tree
An interactive tree: Brand → Family → Subfamily → Product. Expand and collapse it, colour each level like the VBA macro, and colour product nodes by status. Hover shows the description, status and launch date. Clicking a product opens a side panel with its projects, launch record and feedback. Add filters for status and family, plus search. Add Excel export and a printable PDF view. Users with entry permission can add, edit, move or retire families, subfamilies and products here.

### 5.3 Roadmap
A timeline from 2023 to 2028 with the year themes. Show products placed by planned or actual launch date (quarter granularity) and coloured by status, with flexible dates marked "as market needs". Add a family filter. A late product (planned date passed but not launched) shows a red marker.

### 5.4 Projects (pipeline)
A Kanban board by gate (G0 … G5, Closed) plus a list view with filters (classification, type, family, owner, fast-track, state).

**Project detail page.** This page is the main data-entry screen. Each section shows its form to users with permission:
- Header with the gate stepper (gate names, the deck's step sub-labels, and dates).
- **Scoring panel:** the 6 criteria with a 0–5 selector that shows each criterion's meaning text live. Show a weighted score per row, the total out of 100, and a **PASS / BELOW 60** badge. Evidence is required for every row. Keep a history of scoring rounds.
- Checklists per gate, with attachments.
- Lab tests, field trials and pilot batches (forms and tables).
- Gate decision panel: shows the required approvers, who has decided, and approve/reject/revise buttons for eligible approvers.
- Timeline/history of every change.

### 5.5 Launch tracking and customer feedback (the CEO's "monitoring tools")
- **Launches:** products launched or launching, with a readiness checklist (documentation package, training, communication, EXCO approval). Once the product is linked to `dim_product`, show its **post-launch sales from the warehouse**: monthly quantity and revenue for the first 12 months after launch, **TIKA rows only**.
- **Feedback:** a list and an entry form, average rating per product, and an open follow-ups list.

### 5.6 Policy and scoring guide
The current policy version, rendered read-only with a version selector. Under it, the scoring matrix as a reference table (criteria, weights and the six meanings), the governance roles and members, and the gap-analysis (5M) checklist.

### 5.7 Admin (entry/admin permission)
Edit the settings, KPI targets, scoring criteria (weights must total 100), gate rules, governance members, roadmap years, dropdown values and policy versions. Copy the `/admin/kaizen-dropdowns` approach.

---

## 6. Workflow and validation rules (enforce in the backend, and test each one)

1. A project cannot be created without a product-tree link, either an existing product or a new-product proposal.
2. **G0 → G1:** submitting a request is enough.
3. **G1 approval** requires a complete scoring round (all 6 criteria with evidence), all 6 feasibility checklist items done, and a **total score ≥ min_score (60)**. Below 60, the only allowed decisions are reject or revise. G1 approval is the kick-off: it needs a **Chairman/CEO** decision and requires a team and objectives.
4. **Unplanned projects** need a CEO **or** EXCO approval at G1 in addition to the normal rule. Show a "strict scoring" note.
5. **Fast-track:** when it is set, start a 72-hour clock at G0. Raise an alert if G1 feasibility is not completed in time. Allow G2 and G3 work to be recorded in parallel, but **gate approvals stay sequential**. A gate can never be skipped.
6. **Capacity:** when G1 approval would make active projects exceed `max_concurrent_projects`, block it. Allow an override only for a CEO/EXCO approver, with a required reason. Show the mix versus the 50/30/20 target, as a warning only.
7. **Peak-season freeze:** inside the configured range, new submissions are blocked unless they are flagged unplanned with CEO/EXCO approval.
8. **G2** needs at least one lab test record. A required **technical evaluation** sign-off comes from R&D + QC + Production.
9. **G3** needs at least one field trial (led by Technical Support), and the TS pre-launch validation sign-off.
10. **G4** needs at least one pilot batch of 500–1,500 kg with QC, R&D and Production confirmations.
11. **G5** needs all 7 documentation-package items attached and an **EXCO** final approval. On approval, set the linked product to `in_market`, set its `actual_launch_date`, and create its `pdp_launch` record.
12. **Closure** needs a closure report and moves the project to `closed`. It is read-only after that, except for admins.
13. A reject decision ends the project (`rejected`). A revise decision keeps it at the same gate and requires a comment.

---

## 7. Seed import (one time, admin only)

Add an admin-only endpoint and button, like `kaizenImportService`, that reads the files in `Input/product_development/` (or files uploaded through the button):
- `Product_Tree.xlsm`: sheet `ورقة1` gives brand, families, subfamilies and products. `Sheet1` gives family descriptions. Apply the spelling clean-up from §2.3.
- `RD_Scoring_Matrix.xlsx` gives the criteria, weights and meanings. Parse the nested `IF` formulas for the meaning texts, and check the result against the table in §2.2.
- `R_D_Policy.docx` gives policy version 1.0, one section per heading (21 sections).
- Roadmap years, governance roles, KPI targets, gap items and settings come from §2 directly (seed SQL).

The import must be **idempotent**, matching on natural keys, so re-running it does not create duplicates. Run it in a transaction. Return a report with rows created, updated and skipped, each spelling correction applied, and any row it could not place. **Do not treat the `.xlsm` macros as code to run.** Read cell values only (openpyxl / exceljs) and never execute VBA.

---

## 8. Tests, docs, acceptance

**Tests** (backend, same framework as `backend/src/routes/__tests__`):
- Score maths: an all-5 round gives 100, an all-0 round gives 0, and the matrix example rows produce the expected totals.
- Every workflow rule in §6, both allowed and blocked paths.
- Permission checks for all three page keys.
- Majaal is rejected.
- Import idempotency.
- Each KPI formula on a fixture.

**Frontend:** extend `frontend/src/lib/__tests__/comingSoon.test.ts` so it no longer expects this page to be a placeholder.

**Docs:**
- `docs/product-development-plan.md`: data model, workflow diagram, KPI definitions, permissions, and how to run the import.
- A new section in the user manual (see `User_Manuals/`).
- A CHANGELOG entry.

**Done when:**
- [ ] The nav item opens the real page. "(coming soon)" is gone from the nav and the Roles page.
- [ ] The tree shows 8 families and 55 products, with correct statuses and clean spellings.
- [ ] I can create a project from the app, score it, and move it through G0 → G5 → Closed, with every gate rule enforced and every decision in the history.
- [ ] The KPI tiles, capacity gauge and alerts calculate from the entered data.
- [ ] Launch tracking shows post-launch TIKA sales for a product linked to Odoo.
- [ ] Customer feedback can be entered and followed up.
- [ ] Policy v1.0 and the scoring guide are readable in the app.
- [ ] No Majaal data appears anywhere in the module.
- [ ] Every new migration has a down script, and every test passes.

---

## 9. Ask me before deciding these (list them in the plan at checkpoint 1)

1. Which app users hold each governance role (Chairman, CEO, EXCO members, Technical Manager, TS lead, QC, Production, Marketing, Commercial)?
2. Which months are TIKA's peak season for the request freeze?
3. Can a CEO/EXCO override the 6-project cap, or is it a hard block?
4. Should the policy text be editable in the app, or only replaced by uploading a new docx version?
5. Should an Arabic UI or Arabic product names be supported now?
6. Should each Xtreme product be linked to its Odoo product now, or later when products launch?
