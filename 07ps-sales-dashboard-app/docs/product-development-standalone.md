# Product Development Plan: dashboard + data entry & follow-up (standalone build)

Status: **plan, awaiting approval** (2026-11-18). Branch `feature/product-development-standalone` from `main` 0e5255c.
Brief: `PROMPT_product_development_standalone_2026-11-15.md`; visual target: `Input/product_development_draft/*.png`.

## 0. What changed from the brief

The brief assumed a "coming soon" placeholder and free migration numbers from 0075. `main` already carries the TIKA R&D
gate module (`components/pdp/*`, `routes/productDevelopment.ts`, `pdp_*` tables, migrations **0075–0077**), and 0078/0079
are taken too. Agreed on 2026-11-18: **the draft dashboard becomes the landing page and the gate module stays** as
sub-pages. Nothing in the gate module is deleted.

| | Before | After |
|---|---|---|
| `/product/product-development-plan` | gate module Overview | **new Dashboard** (this build) |
| `/product/product-development-plan/entry` | — | **new Data entry & follow-up** |
| `/product/product-development-plan/gates` | — | gate module Overview (moved, unchanged) |
| `/tree`, `/roadmap`, `/projects…`, `/launches`, `/feedback`, `/policy`, `/admin` | gate module | unchanged |

Tab strip (PdpPage): **Dashboard · Data entry & follow-up** · Gate overview · Product Tree · Roadmap · Projects · Launches ·
Customer Feedback · Policy & Scoring Guide · Administration. The gate module's TIKA-only company rule does not apply to
the new screens.

## 1. Tables (prefix `pdt_` = "product development tracker", no clash with `pdp_*`)

| Table | Purpose / key columns |
|---|---|
| `pdt_dropdown_value` | `list_key` ENUM(category, priority, health, stage), `code` (fixed for stage/health/priority: the rules use the code, admins edit label, colour, order, active), `label`, `color`, `sort_order`, `is_active`. Categories are free to add/delete (delete refused while used). Seeded by the migration: stages IDEA, RESEARCH, DEVELOPMENT, TESTING, LAUNCH_READY, LAUNCHED (draft colours); health ON_TRACK green, AT_RISK amber, BLOCKED red; priority HIGH, MEDIUM, LOW; categories Skincare, Sun care, Sets & kits, Sustainability, Body care. |
| `pdt_setting` | key/value: `stale_days` 14, `roadmap_months` 4, `upcoming_window_days` 90, `followup_due_soon_days` 7, `launch_soon_days` 30, `launch_soon_min_readiness` 80. |
| `pdt_product` | `product_id` AUTO_INCREMENT; `code` = `P-` + 3-digit id (stored, unique, never reused); `name`, `category_id`, `owner_user_id` (FK app_user, nullable) + `owner_name` (display, required), `priority_id`, `stage_id`, `health_id`, `readiness_pct` 0–100, `target_launch`, `actual_launch`, `description`, `notes`, `health_review_required` flag, `stage_since`, `last_update_at`, created/updated by+at, `deleted_at/by` (soft delete). DB CHECKs mirror the API rules where possible. |
| `pdt_stage_history` | product, `from_stage_id` (NULL on creation), `to_stage_id`, `changed_at`, `changed_by`, `comment`. Days in each stage = difference between consecutive rows (current stage up to today). |
| `pdt_status_update` | product, `update_date`, `health_id`, `readiness_pct`, `summary`, `next_step`, `next_step_due`, `next_step_done_at`, created by/at, soft delete. |
| `pdt_blocker` | product, `type` ENUM(BLOCKER, DECISION), `title`, `required_action`, `owner_user_id` + `owner_name`, `due_date`, `status` ENUM(OPEN, IN_PROGRESS, RESOLVED, CANCELLED), `resolution_note` (required to resolve), `resolved_at`, created/updated by+at, soft delete. |

Every create / edit / delete / stage change also goes to the existing `audit_log` (`writeAuditLog`, as Kaizen does);
the drawer shows "Last updated by … on …" from `updated_by/updated_at`.

## 2. Migrations

- **0080_pdt_schema.sql**: all tables above, default dropdown values and settings (INSERT IGNORE; idempotent), page label
  refresh. Down: `data/warehouse/down/0080_pdt_schema_down.sql` (drops the `pdt_*` tables only).
- No permission migration is needed if decision 1 below is "reuse" (the pages and grants exist since 0077). If a separate
  key is chosen: **0081_pdt_permissions.sql** + down.
- Clash note: `feature/product-development-plan` used 0075/0076, and those numbers are now on `main` as the gate module
  (0075–0077). This build starts at **0080**, the next free number on `main`.
- Demo data is **not** in a migration (see §6).

## 3. Business rules (backend, `services/pdt/rules.ts`, pure functions, unit-tested)

- **Active** = stage ≠ LAUNCHED (and not deleted). Today = the server's business date.
- KPIs on the filtered set: Active; On track = active ∧ ON_TRACK; Need attention = active ∧ (AT_RISK ∨ BLOCKED);
  Upcoming launches = active ∧ today ≤ target_launch ≤ today + `upcoming_window_days` (boundary day counted);
  Launched = stage LAUNCHED.
- Product validation: name unique among non-deleted products (case-insensitive); readiness 100 only in LAUNCH_READY /
  LAUNCHED; target launch required for every stage except IDEA; actual launch required when stage = LAUNCHED.
- Stage change only through `POST …/stage` (or pipeline drag, which calls the same endpoint) with a required comment;
  writes `pdt_stage_history`. The product form does not change the stage of an existing product.
- Status update: writes `pdt_status_update` and copies health + readiness onto the product (`last_update_at` = update date).
- **Blocker rule**: an unresolved *Blocker* (status OPEN or IN_PROGRESS) forces health = BLOCKED (the API answers with
  `healthForced: true`, the UI says so); setting another health while one is unresolved is refused
  (`health.blockedByBlocker`). When the last one is resolved/cancelled, the product gets `health_review_required` and the
  owner is asked to pick the new health; it stays BLOCKED until they do. *Decision needed* items never change health.
- Stale: active product with `last_update_at` (or created date if none) older than `stale_days` → "No update" marker.
- Overdue: blocker due date < today and unresolved; next step due < today and not done.
- Roadmap: `roadmap_months` calendar months from the current month, active products only, grouped by target month;
  footer counts active products outside the window.

## 4. Endpoints (`routes/productDevelopmentTracker.ts`, mounted at `/product-development/tracker`)

| Method + path | Permission |
|---|---|
| `GET /options` (dropdowns, settings, owner picker = active app users) | plan View or entry View |
| `GET /dashboard?<filters>` → KPIs, pipeline, tracker rows, roadmap, open blockers | plan View |
| `GET /dashboard/export?<filters>` (.xlsx: tracker, roadmap, blockers sheets) | plan Export or entry Export |
| `GET /products?<filters>`, `GET /products/:code` (+ history, updates, blockers, audit line) | plan View or entry View |
| `POST /products`, `PATCH /products/:code`, `DELETE /products/:code` (soft) | entry Create / Edit / Delete |
| `POST /products/:code/stage` `{ toStage, comment }` | entry Edit |
| `POST /products/:code/updates`, `PATCH /updates/:id` (incl. mark next step done), `DELETE /updates/:id` | entry Create / Edit / Delete |
| `GET /blockers?…`, `POST /blockers`, `PATCH /blockers/:id`, `POST /blockers/:id/resolve`, `DELETE /blockers/:id` | entry View / Create / Edit / Edit / Delete |
| `GET /followup?owner=&product=`, `GET /followup/export` | entry View / Export |
| `GET/POST/PATCH/DELETE /admin/dropdowns`, `PUT /admin/settings` | Admin role only (as Kaizen dropdowns) |

Filters (shared by every section): `stages, owners, categories, priorities, health, launchFrom, launchTo, search`.
Errors: `{ error, code, field }` like Kaizen (404 for `*.notFound`, 400 otherwise).

## 5. Screens (frontend)

- `components/pdt/` (new): `Dashboard.tsx` (filters bar, 5 KPI cards, pipeline kanban with clickable stage headers and
  cards, tracker table with sort + Excel/PDF, launch roadmap, blockers & decisions), `ProductDrawer.tsx` (edit form for
  entry Edit, otherwise read-only; stage timeline with days per stage; updates; blockers; "Last updated by"),
  `Entry.tsx` with sub-tabs **Products · Status updates · Blockers & decisions · Follow-up board**, forms with field-level
  errors, `api.ts`/`hooks.ts`.
- Pages: `product-development-plan/page.tsx` → Dashboard; `…/entry/page.tsx` → Entry; `…/gates/page.tsx` → the gate
  Overview. PdpPage gets the two new tabs (Entry tab only with entry View).
- Admin: new adminOnly tab **Product Development Settings** at `/admin/product-development-settings` (dropdown lists +
  follow-up settings), Kaizen-dropdowns style.
- `navItems.ts`: ROUTE_PAGE_KEYS `/product/product-development-plan/entry` → `product_development_entry`; SUB_PAGES
  labels for Data entry & follow-up and Gate overview. (The nav entry already has no `comingSoon`.)
- Look: Product page chrome and tokens, light + dark, kanban scrolls sideways on phones, table becomes cards under 640 px;
  empty state when there are no products. PDF via `exportProductPdf`, Excel via the server export.

## 6. Demo seed (local test stack only)

`backend/scripts/pdtDemoSeed.ts` (`npm run pdt:demo-seed` / `pdt:demo-unseed`), with the same refusal guard as the MARCOM
demo seed (refuses NODE_ENV=production / non-local DB without `--i-know-this-is-dev`). Seeds the 8 products of brief §4
(owners as names, no app users created), one stage-history row each, one recent status update each (so nothing shows
"No update"), and the 3 open items. To keep the draft's health values, item 1 (*Stability report pending*) is a
**Blocker**, items 2 and 3 are **Decision needed** (a Blocker on Mineral SPF 50 / Refill Collection would force them to
Blocked). Expected with today = 18 Nov 2026: Active 7, On track 4, Need attention 3, Upcoming 4, Launched 1; roadmap
Nov–Feb 5 products, footer "2 active product(s)…"; 3 open, none overdue yet (first is due today).

## 7. Tests

Vitest: rules (KPI counts, 90-day boundary both sides, stale and overdue, readiness/target/actual-launch validation,
blocker → Blocked and health review), service tests for stage history and days-in-stage, route tests for permissions
(plan-View-only user gets 403 on every write; entry user can write; Admin-only settings). Frontend: section render +
empty state.

## 8. Decisions for you

1. **Entry permission key**: reuse the existing `product_development_entry` (the brief's name; already granted to ADMIN
   by 0077; the same people can then also enter gate-module data), **or** a new `product_development_tracker_entry` so the
   two can be granted separately (+ migration 0081). *Recommended: reuse* — one Product Development data-entry role.
2. The gate module's Overview moves from `/product/product-development-plan` to `/gates`; old bookmarks to the landing
   page now open the new dashboard. OK?
