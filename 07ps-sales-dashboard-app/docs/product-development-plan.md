# Product Development Plan (TIKA R&D) — implementation plan

Status: **checkpoint 1, waiting for review**. Nothing is built yet. Branch `feature/product-development-plan`
(worktree `Desktop/07PREPORT-pdp`, based on local `main` d9e9edd).

---

## 0. What the source files actually contain (read 2026-11-14)

| File | Finding | Effect on the plan |
|---|---|---|
| `Product_Tree.xlsm` / `ورقة1` | 55 products, all brand Xtreme; **8 families, 20 subfamilies**; status 13 In Market / 23 Planned / 19 under Development; 16 rows say "As market needs"; every row has a description and a launch date (first-of-month). Column K holds the status drop-down list (ignored). | Matches the brief. |
| `ورقة1` spellings | Most typos in the brief ("Waterprooing", "Specail", "Chemcails", "Terrazo") exist only in **TreeNodes**, which we don't import. `ورقة1` itself needs only: `Masonry& Repair Mortar` → `Masonry & Repair Mortar`, `putties& skimming` → `Putties & Skimming`, `Cementious Renders` → `Cementitious Renders`, `Floor Hardner` → `Floor Hardener`. | The import applies the full correction list anyway (harmless) and reports only the corrections it actually made. Not on the list, so left unchanged: `self Leveling`, `Gypsum putty`, `Anchoring system`, `Cementitious waterproofing` (casing only). See Q8. |
| `Sheet1` F16:G24 | 8 family descriptions, already spelt correctly. | Join on the cleaned family name. |
| Launch dates | **Today (2026-11-14), all 19 `under Development` products (dates 2026-01 to 2026-04) and 6 `Planned` products (2026-04 to 2026-10, 2 of them "as market needs") have a launch date in the past.** | On day one the "launch date passed" alert shows 19 products and the roadmap shows 25 red "late" markers. That is correct, but you should expect it. The CEO may want to update the dates first. |
| `RD_Scoring_Matrix.xlsx` | One sheet with 6 criteria, weights 20/20/20/20/10/10 and nested-IF meaning texts, identical to the brief. The Score column (C) is **empty: there are no example rows**. Two names have a trailing space ("Development Difficulty ", "Production Impact "). The formula's last branch is an "else", so any score other than 0–4 would show the 5 text. | We trim the names and accept whole numbers 0–5 only. The "example rows" tests use our own fixtures: all-5 = 100, all-0 = 0, and mixed rows such as 4/3/2/5/1/0 = 16+12+8+20+2+0 = 58 (BELOW 60). |
| `R_D_Policy.docx` | 1 Heading1 title and **21 Heading2 sections**, no tables. §13 *Packaging Development* is not in the brief. | One section per Heading2. Packaging is added as an optional G5 checklist item (Q9). |
| `Xtreme_Roadmap.pptx` | Slide 5 year boxes carry no year numbers, so they are mapped to 2023–2028 in order. Slide 4 "Products Map" is an embedded picture (nothing to import). Slide 9 gap items are mapped to 5M **by shape position** (below). | Seed SQL. |

Slide 9 gap items (13): **Manpower**: Technical Support Dept., R&D technicians, Sales team upskilling, R&D committee,
Production team. **Machine**: Production lines ready for 2026 plan, Lab equipment, Extension for residential buildings.
**Materials**: Suppliers (Libya, Spain, China, Turkey, Egypt), Trading-items suppliers. **Methods**: R&D policy, forms and
SOP. **Measurements**: R&D KPIs, Monitoring tools (launch tracking, dashboard, customer feedback). The "Monitoring
tools" item is this module, so it is seeded as *in progress*.

### Deviations from the brief
1. **Migrations start at 0074, not 0073.** Local `main` already has `0073_product_sku_status.sql` (unpushed, L12M work).
2. **File attachments.** Kaizen has no attachments. MARCOM stores the uploaded file in a `LONGBLOB` column (`marcom_upload_batch.original_file`, multer memory storage), so we reuse that pattern. A `pdp_attachment` table keeps the bytes in MySQL (limit 10 MB per file; pdf/docx/xlsx/png/jpg). There is no new storage service. Side effect: the database grows with the attachments.
3. **The import's server-folder mode works only locally.** `Input/product_development/` is untracked and does not exist in the production container. On production, the admin uploads the 3 files through the button. The `.pptx` is not read at runtime: its content is in seed SQL.
4. **`dim_company` is ETL-owned** (the ETL upserts it, never truncates it). The FK is safe, but on a fresh DB the Tika row may not exist when the migration runs. Seed rows are inserted with `SELECT CompanyKey FROM dim_company WHERE LOWER(Company) = 'tika'`. If that finds no row, nothing is seeded and the import seeds it later (idempotent). No key is hard-coded anywhere.

---

## 1. Migrations (all idempotent, each with `down/NNNN_*_down.sql`)

| # | File | Content |
|---|---|---|
| 0074 | `0074_pdp_schema.sql` | All `pdp_*` tables below (CREATE TABLE IF NOT EXISTS, CHECKs, FKs to `dim_company`, `app_user`, `dim_product`). |
| 0075 | `0075_pdp_seed_config.sql` | Config seed for Tika: governance roles, scoring criteria and meanings, gate rules, checklist templates, KPI targets, settings, roadmap years, gap items, dropdown values. `INSERT … SELECT … FROM dim_company` with natural-key uniques, so it is re-runnable. |
| 0076 | `0076_pdp_permissions.sql` | Renames the page label (drops "(coming soon)"), adds the `product_development_entry` and `product_development_approval` pages and permissions, View on the plan for every role that views a Product report (0060 query), entry and approval for ADMIN. |

The product tree, scoring texts (verified against the seed) and policy v1.0 come from the **import**, not SQL.

## 2. Tables

Every table has `pdp_*_id` PK, `company_key BIGINT NOT NULL` (FK `dim_company.CompanyKey`), `created_by/at`,
`updated_by/at` and, where rows can be removed, `deleted_at/deleted_by` (soft delete). History tables are insert-only:
the service never issues UPDATE/DELETE on them, and a test scans the service SQL to prove it.

**Product tree**
- `pdp_brand` (name) · `pdp_product_family` (brand FK, name, description, sort_order) · `pdp_product_subfamily` (family FK, name, sort_order)
- `pdp_product`: subfamily FK, name, description, status ENUM(`in_market`,`planned`,`under_development`,`discontinued`), planned_launch_date, actual_launch_date, launch_date_flexible, comment, `dim_product_key` NULL (FK `dim_product.ProductKey`), retired flag. Unique (company_key, subfamily, name).
- `pdp_product_history` (append-only): product, field (status / planned date / actual date / subfamily move), from → to, reason, by, at.

**Plan reference**
- `pdp_roadmap_year` (year, theme, notes) · `pdp_gap_item` (category ENUM 5M, item, owner user, status, due_date, notes)
- `pdp_policy_version` (version_label e.g. `1.0`, status draft/published, published_at/by, source filename) + `pdp_policy_section` (version FK, section_no, title, body). A published version is read-only.
- `pdp_governance_role` (code: CHAIRMAN, CEO, EXCO, TECH_MANAGER, RND, TS, COMMERCIAL, MARKETING, QC_QA, PRODUCTION; label; responsibility text from §4 of the policy) + `pdp_governance_member` (role FK, app_user FK, active, valid_from/to).

**Configuration**
- `pdp_setting` (key/value): `max_concurrent_projects`=6, `mix_target_planned/unplanned/innovation`=50/30/20, `min_score`=60, `fast_track_feasibility_hours`=72, `freeze_from_mmdd`/`freeze_to_mmdd`=empty, `capacity_override_allowed` (Q3), `pilot_kg_min/max`=500/1500.
- `pdp_kpi_target` (kpi_code, target, comparator ≥/≤/=, period QUARTER/ROLLING_12M)
- `pdp_scoring_criterion` (name, weight, meaning_0…meaning_5, active, sort_order). Saving is blocked unless the active weights total 100.
- `pdp_gate_rule` (gate G1…G5, signoff_code, label, required governance roles JSON, mode ALL/ANY, applies_to: all / unplanned only)
- `pdp_checklist_template` (list: FEASIBILITY / RAW_MATERIAL / DOCUMENTATION / LAUNCH_READINESS, gate, item label, required, sort_order)
- `pdp_dropdown_value` (list_key: project_type, request_source, competitor, lab_property, feedback_channel, feedback_category, feedback_status; label, sort, active). Copies `kaizen_dropdown_value`. **Classification, innovation category, gates and states are fixed codes**, not drop-downs, because the workflow rules depend on them.

**Projects**
- `pdp_project`: code `RD-YYYY-NNN` (per year, never reused), title, product FK **or** proposed_product_name + proposed_subfamily FK (CHECK: exactly one), classification, project_type, innovation_category (CHECK: only for innovation), requested_by (text) + request_source, fast_track, owner user, current_gate G0…G5, state ENUM(draft, submitted, active, on_hold, rejected, launched, closed), submitted_at, target_launch_date, start_date, closed_date, objectives, closure_report, capacity_override_reason, freeze_override.
- `pdp_project_member` (project, user, governance role / role text)
- `pdp_project_history` (append-only): event (created, submitted, gate_decision, state_change, field_change, scoring_round, override), from → to, comment, by, at.
- `pdp_score_round` (project, round_no, total, passed, scored_by, scored_at) + `pdp_project_score` (round, criterion, criterion_name/weight **snapshot**, score 0–5, weighted, evidence NOT NULL). The latest complete round counts. Snapshots keep old rounds correct after an admin edits the weights.
- `pdp_gate_decision` (append-only): project, gate, round (revise starts a new one), signoff_code, decision approve/reject/revise, approver user, approver_governance_role, comment, decided_at.
- `pdp_project_checklist` (project, template item, status open/done/n.a., owner, done_date, link, attachment FK, note)
- `pdp_lab_test` (project, trial_no, competitor, property, target, result, unit, pass, first_pass derived = trial_no 1)
- `pdp_field_trial` (project, site, `customer_key` NULL (Odoo customer, Tika only) or customer text, date, 5 scores 1–5: setting/bonding/flexibility/coverage/satisfaction, overall pass, ts_lead user, notes)
- `pdp_pilot_batch` (project, batch_no, kg CHECK 500–1500, qc_ok/by/at, rnd_scale_ok/by/at, production_ok/by/at)
- `pdp_documentation_error` (project, document, severity critical/minor, found_at, description, fixed_at). This feeds the "0 critical documentation errors" KPI; the brief has no data source for it otherwise.
- `pdp_attachment` (owner_type + owner_id, filename, mime, size, LONGBLOB, sha256)

**Monitoring**
- `pdp_launch` (product, project NULL, launch_date, training_done, communication_done, documentation_complete (derived), exco_decision FK, status planned/ready/launched)
- `pdp_customer_feedback` (product, customer_key or text, date, channel, rating 1–5, category, comment, followup_owner, stage/status, due_date, resolved_at) + `pdp_feedback_history` (append-only), following the NPS follow-up case + audit pattern (0052/0066).

## 3. Workflow (backend-enforced; one test per rule, allowed and blocked)

```
draft ─submit─▶ G0✓ → G1 (submitted) ─approve─▶ active@G2 ─▶ G3 ─▶ G4 ─▶ G5 ─approve─▶ launched ─close─▶ closed
                    │ reject (any gate) ─▶ rejected          revise ─▶ same gate, new round, comment required
```
Deck steps shown as sub-labels: G0 "1 Request submission", G1 "2 Evaluation & scoring / 3 Kick-off", G2 "4 Development &
lab testing", G3 "5 Field trials & validation", G4 "Pilot (policy)", G5 "6 Final approval", Closed "7 Project closure".

| Gate | Data preconditions (checked when the last required sign-off arrives) | Sign-offs (`pdp_gate_rule`) |
|---|---|---|
| G0→G1 | product link or proposal; peak-season freeze unless unplanned + CEO/EXCO override | none (submission) |
| G1 | latest round complete (6 criteria + evidence); 6 feasibility items done; team + objectives; total ≥ min_score (below it, only reject/revise); capacity ≤ max (CEO/EXCO override with reason, if Q3 allows); mix shown as a warning | **Kick-off**: ANY of Chairman, CEO. **Unplanned only**: an extra ANY of CEO, EXCO (a CEO counts for both) |
| G2 | ≥1 lab test | **Technical evaluation**: ALL of R&D, QC/QA, Production |
| G3 | ≥1 field trial with a TS lead | **Pre-launch validation**: TS |
| G4 | ≥1 batch 500–1500 kg with all 3 confirmations; raw-material approval items done | **Pilot**: Technical Manager (the brief names none; Q10) |
| G5 | all 7 documentation items done with an attachment or link | **Final launch**: EXCO → product `in_market`, `actual_launch_date`, `pdp_launch` row |
| Close | closure report | owner or Technical Manager → `closed`, read-only except Admin |

- A decision requires the `product_development_approval` Edit permission **and** an active governance membership in a role the sign-off needs. Approval is recorded as that role.
- Gates are strictly sequential: you can only decide on `current_gate`. Fast-track allows lab tests, field trials and batches to be recorded before G2/G3 are approved. The 72 h clock starts at `submitted_at`; the alert fires when the feasibility items are not all done in time.
- G1 approval of a proposal creates a `planned` product in the proposed subfamily and links it.
- "Active projects" for capacity = state `active` (G1 approved, not yet launched). `on_hold` also counts by default (it still holds R&D people); see Q11.

## 4. KPIs (period = selected quarter; ⓘ tooltip text = these lines)
- New products = G5 approvals with classification ≠ reformulation in the quarter (target 3).
- Reformulations = G5 approvals with classification = reformulation (target 2).
- Field-trial success = passed trials / trials dated in the period (≥80%).
- First-pass lab success = projects whose trial 1 passed every target / projects with a trial 1 in the period (≥85%).
- On-time = launched with G5 date ≤ target_launch_date / launched in the period (≥90%).
- Cycle time = average days from `submitted_at` to G5 approval for launches in the period (≤60).
- Critical documentation errors = `pdp_documentation_error` rows with severity critical found in the period (=0).
A tile with no data shows "—" (grey), not red.

## 5. API (`/product-development/*`, mounted like `/kaizen`)

| Area | Endpoints | Permission |
|---|---|---|
| Read views | `GET /overview?quarter=`, `/tree`, `/roadmap`, `/projects`, `/projects/:code`, `/launches`, `/launches/:id/sales`, `/feedback`, `/policy?version=`, `/reference` (criteria, roles, gaps), `/alerts` | plan View **or** entry View |
| Exports | `GET /tree/export`, `/projects/export`, `/feedback/export` (xlsx) | plan Export / entry Export |
| Tree entry | `POST/PATCH/DELETE /families`, `/subfamilies`, `/products`; `POST /products/:id/move`; `PATCH /products/:id/status` (reason required) | entry Create/Edit/Delete |
| Projects | `POST /projects`, `PATCH /projects/:code`, `POST /projects/:code/submit`, `/scores` (new round), `/checklist/:itemId`, `/lab-tests`, `/field-trials`, `/pilot-batches`, `/doc-errors`, `/members`, `/close`, `/hold`, `/resume`, `DELETE` (draft only, soft) | entry Create/Edit/Delete |
| Decisions | `POST /projects/:code/decisions` {signoff, decision, comment, overrideReason} | approval Edit + governance role |
| Launch / feedback | `PATCH /launches/:id`, `POST/PATCH /feedback`, `POST /feedback/:id/followup` | entry |
| Attachments | `POST /attachments` (multipart), `GET /attachments/:id` | entry Create / plan View |
| Admin | `GET/PUT /admin/settings`, `/kpi-targets`, `/criteria`, `/gate-rules`, `/governance`, `/roadmap-years`, `/dropdowns`, `/gaps`, `POST /admin/policy-versions` (+publish) | entry Edit, or Admin role (Q4) |
| Import | `POST /import?commit=1` (3 files, or `?source=folder` locally) | **Admin role only** (like Kaizen) |

Errors use `{ error, code, field }` (`PdpValidationError`, same as `KaizenValidationError`). Every service read and write
goes through `tikaCompanyKey()`, which resolves Tika from `dim_company` by name with Odoo id 3 as a cross-check and is
cached per process. A body carrying any other `company_key` is rejected with `company.notAllowed` (tested with Majaal = 1).

Post-launch sales: `fact_sales_product_daily` `WHERE ProductKey = ? AND CompanyKey = <tika>`, grouped by month for 12
months from `actual_launch_date` (Qty and Value). These are the same rows the Product pages use, so the numbers match Odoo.
The `dim_product` picker lists active Tika (or shared, -1) products only.

## 6. Screens (`/product/product-development-plan`, tabs as sub-routes)
`/` Overview · `/tree` · `/roadmap` · `/projects` (Kanban + list) · `/projects/[code]` (detail and entry) · `/projects/new`
· `/launches` · `/feedback` · `/policy` · `/admin` (settings, targets, criteria, gate rules, governance, roadmap years,
drop-downs, gaps, policy versions, import panel). The look and filters come from `components/product/ProductUi.tsx`, the
shell and forms from `components/kaizen/*`. `navItems.ts` drops `comingSoon`, and the sub-routes get labels and page-key
overrides (`/projects/new`, `/admin` → `product_development_entry`) the way Kaizen's `manage` does. The tree is drawn as
an expand/collapse SVG/HTML tree with level colours blue/green/orange/purple, product nodes coloured by status, a hover
card and a side panel. There is no chart library dependency, and it has Excel export and print CSS for PDF.

## 7. Import (Admin role, dry run then commit, one transaction)
1. `Product_Tree.xlsm`: ExcelJS reads cell values only (`vbaProject.bin` is never touched). Sheet `ورقة1` from row 4; `Sheet1` F17:G24 descriptions. Applies the corrections, maps the statuses, sets "As market needs" → `launch_date_flexible = 1` with the comment kept. Natural keys: family name, (family, subfamily), (subfamily, product).
2. `RD_Scoring_Matrix.xlsx`: parses the nested IF strings in column E into meaning_0…5 and compares them with the seed. A difference is reported and **does not overwrite** admin edits unless a "replace" flag is set.
3. `R_D_Policy.docx`: unzips with `jszip` (already installed under exceljs; added as an explicit dependency) and splits on Heading2 into 21 sections → version `1.0`, skipped if 1.0 already exists.
4. Report: created / updated / skipped per table, each spelling correction (sheet, cell, from → to), rows not placed. A second run reports 0 created.

## 8. Tests and docs
Backend vitest: score maths, every rule in §3 (allowed and blocked), the 3 page keys, Majaal rejected, import idempotency
(fixture copies of the 3 files in `backend/src/services/__tests__/fixtures/pdp/`; the real files are used only if they are
committed, see Q12), each KPI formula, and append-only history. Frontend: `comingSoon.test.ts` updated, tree builder and
score badge. Docs: this file becomes the module doc (data model, workflow, KPIs, permissions, import), a user-manual
section in `User_Manuals/source`, and a `CHANGELOG.md` entry.

---

## 9. Questions for you (answers change what I build)

1. **Governance members**: which app users are Chairman, CEO, EXCO members, Technical Manager, TS lead, QC/QA, Production, Marketing, Commercial, R&D? (If you prefer, I seed none and you assign them on the admin screen.)
2. **Peak-season freeze months** for TIKA? (Default: empty = no freeze.)
3. **6-project cap**: CEO/EXCO override with a reason, or a hard block?
4. **Policy text**: edited in the app (new draft version → publish), or replaced only by uploading a new docx?
5. **Arabic**: Arabic UI and/or Arabic product names now? (Default: English only, like Kaizen.)
6. **Odoo link**: link Xtreme products to `dim_product` now (I can propose matches for the 13 In Market products by name), or later as products launch?
7. **Base branch**: I branched from local `main` (includes your unpushed L12M commits and 0073). Fine, or should it be based on `origin/main`?
8. **Extra spellings**: also normalise `self Leveling` → `Self Leveling` and the capitalisation of `Gypsum putty`, `Anchoring system` and `Cementitious waterproofing`?
9. **Packaging (policy §13)**: add "Packaging artwork & TDS/MSDS alignment" as a G5 checklist item (optional, not one of the required 7)?
10. **G4 sign-off**: the brief lists no approver for the pilot gate. Is the Technical Manager right?
11. **Capacity count**: should `on_hold` projects count toward the 6?
12. **Source files**: commit the 4 CEO files to the repo (`Input/product_development/`, currently untracked) or keep them local only?
