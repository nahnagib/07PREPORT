# Tech Stack Decision — 07 Ps Sales Dashboard Web App (Phase P1/P2)

Status: Proposed for review · Owner: Data Analyst (Nahla Burweiss) · Scope: platform-wide decision, not a Sales-page decision

This document records the stack chosen for the foundation of the 07 Ps platform and why, per the kickoff prompt's requirement that every choice trace back to `07Ps_Phase1_Architecture_Standards.md` and be justified against the alternative. Inputs confirmed directly by the Data Analyst before this was written:

- **Hosting:** Libyan Spider (Libyan hosting provider — shared cPanel hosting, VPS with root access, and a Docker/Node/Python-capable "jPaaS" platform).
- **Odoo/Excel access:** Odoo API and the target Excel files are both reachable from the Data Analyst's local machine today; no server-side DB replica or IT-provisioned service account yet.
- **Team:** No dedicated dev team — an AI coding assistant will write and maintain the code. Preference stated for **Node.js** and **Python**.
- **Design tokens:** Resolved by extracting colors directly from the company's own logo files rather than inheriting the Standards doc's placeholder hex values or Majaal's print brand guide wholesale (see §7 below).

---

## 1. Frontend — Next.js (React + TypeScript) + Tailwind CSS

**Choice:** Next.js 14 (App Router), TypeScript, Tailwind CSS for utility styling on top of a CSS-variable token layer.

**Why this and not the alternative:**
Section 3.20 requires "a single shared component library... the only building block set future dashboards may use," and Section 3.14/3.15 require a 12-column responsive grid with three fixed breakpoints. React's component model is the natural fit for a shared, versioned component library (Section 5.17 — semantic versioning of the component library); a plain server-rendered stack (e.g., Django templates, Blazor Server) would fight the "one component library, reused everywhere" requirement because there's no natural unit of reuse smaller than a whole page. Vue and Svelte were considered — either would satisfy the component-library requirement about as well as React — but React/Next.js was preferred because it is the deepest, best-documented target for AI-assisted code generation (directly serving the "future AI sessions building other departments" requirement in the kickoff prompt) and gives first-class TypeScript support, which Section 5.4's strict naming/typing discipline benefits from.

Tailwind was chosen over hand-rolled CSS/Sass or a heavier component framework (MUI, Ant Design) because Section 3.9–3.10 define an exact, closed design-token set (colors, 4 type weights, fixed spacing/radius values) — Tailwind's config file is a direct, literal encoding of a token file, whereas a pre-built component framework would need every default overridden to match Sections 3.5–3.11, fighting the framework instead of using it.

Dark mode (Section 3.19) is implemented as CSS-variable light/dark pairs switched by a single `data-theme` attribute, not a second stylesheet — so no component ever needs bespoke dark-mode code, per the standard's explicit intent.

## 2. Backend / API layer — Node.js (Express + TypeScript), RLS mechanism to be redesigned for MySQL

**Choice:** Node.js/Express (TypeScript) REST API as the semantic layer between the warehouse and the web app. The framework choice below is unaffected by the MySQL correction in §3; the specific RLS *enforcement mechanism* described here (Postgres session variables + `CREATE POLICY`) is not — MySQL has no equivalent primitive, so this is flagged for redesign in Phase P2, not silently carried over as if it still applied. See §3's "known gap" note and §8.

**Why this and not the alternative:** Section 5.2 is explicit: "Permissions are enforced with Row-Level Security **at the data layer** (not just hidden UI elements)... a restricted user cannot see another scope's data even via export or API." Two ways to satisfy that were considered:
1. Enforce scoping only in application code (every query manually filtered by role/salesperson). Rejected — this is exactly the anti-pattern Section 5.2 calls out; one forgotten `WHERE` clause in one future department's query (built by a different AI session) leaks data, and there is no database-level backstop.
2. Enforce scoping with native Postgres Row-Level Security policies, with the API setting the authenticated user's role/company/salesperson-id as session variables before every query. Chosen — the restriction is structurally impossible to bypass from any code path (API, export job, or a future BI tool re-pointed at the same warehouse per Section 7.1), because the database itself refuses rows outside policy, regardless of which application wrote the query.

Node/Express (not NestJS, not a heavier framework) was chosen to match the stated Node.js preference and because the API's job here is intentionally narrow in Phase P1/P2 — auth, RLS session-scoping middleware, filter-value-list endpoints (Section 4.16), and refresh-metadata endpoints (Section 3.23/5.11). A full framework's extra structure (DI containers, decorators) isn't earning its complexity yet; it can be introduced in Phase P3 if the KPI-measure layer grows large enough to need it, without changing the RLS approach.

## 3. Database / warehouse — MySQL 8 (superseded from PostgreSQL)

**Choice, updated 2026-07-05:** MySQL 8, not PostgreSQL as originally proposed below. **One-line reason: this is the current production system's existing infrastructure** — the Data Analyst confirmed the live BI/Odoo environment already runs on MySQL, so the warehouse targets it directly rather than introducing a second database engine into production. Credentials have not been provided yet; this session's schema work (`data/warehouse/migrations/`) was validated against a local/throwaway MySQL 8 instance loaded with a real slice of the current data export, not against production.

**Known gap this reopens:** the original Postgres choice below was justified specifically by native Row-Level Security (`CREATE POLICY`), which directly satisfied Section 5.2's server-side-RLS requirement with no extra framework. MySQL has no equivalent primitive. Per the Data Analyst's explicit decision, the RLS *enforcement mechanism* for MySQL (view-based, application-middleware-based, or otherwise) is deferred to Phase P2 API work — not guessed at schema time. Section 5.2's requirement itself doesn't change: whatever mechanism is chosen must still make scoping "structurally impossible to bypass from any code path," not just an application-layer `WHERE` clause left to convention. See §8 for what's deferred and why.

<details>
<summary>Original PostgreSQL rationale (superseded, kept for context)</summary>

Section 6.4 asks for "a proper managed data warehouse layer" that's "star-schema-friendly" and can host a new Target/Plan fact and an extended Calendar dimension — it does not ask for petabyte-scale columnar storage, and the current data volumes (Sales/Invoice history for two companies) are nowhere near the scale where Snowflake/BigQuery's cost and operational overhead would be justified. Postgres was chosen over MySQL/MariaDB specifically because native Row-Level Security is a first-class Postgres feature (`CREATE POLICY`), which directly satisfies Section 5.2's server-side-RLS requirement with no extra framework; MySQL has no equivalent, and RLS in MySQL means hand-built view/filter logic — trading away exactly the guarantee Section 5.2 exists to provide. Postgres also has the best ecosystem fit with a Libyan Spider VPS deployment (installs cleanly via Docker, no proprietary licensing, no cloud egress dependency for a warehouse that must run reliably 5x/day per Section 5.14).

This reasoning was sound given the assumption that the database choice was still open. It stopped applying once the Data Analyst confirmed MySQL is the existing production system — at that point, "which database has the better RLS story" is no longer the deciding question; "don't run two database engines in production" is.

</details>

## 4. Data ingestion / ETL — Python

**Choice:** Python (pandas + `xmlrpc.client` for Odoo's native RPC API + `openpyxl`/pandas for Excel) as a separate ingestion service, scheduled 5x/day, writing into the Postgres warehouse — never queried live by the web app (Section 7.1: "the web application's own data-access layer reads exclusively from the warehouse, never from Odoo directly").

**Why this and not the alternative:** This was the stated team preference, and it is also the stronger technical fit: Odoo's own API is XML-RPC/JSON-RPC based and Odoo's official client libraries and community tooling are overwhelmingly Python-first (Odoo itself is a Python/PostgreSQL application), so talking to it in its native ecosystem avoids an extra RPC-client abstraction layer that a Node ingestion job would need. Pandas also makes the Excel-target reconciliation Section 6.2/P1 calls out ("reconcile the new Target/Plan fact against the current Excel inputs line-by-line") straightforward. Keeping ingestion as its own Python service (not inside the Node API) also matches Section 6.3's warning against "no explicit data-warehouse layer between Odoo and the BI tool" — ingestion, warehouse, and API are three distinct layers on purpose, so a future second consumer (e.g., Power BI during the parallel run, per the Migration Plan §5) can read the same warehouse without touching ingestion code at all.

**Access caveat (per the Data Analyst's answer):** Odoo API and target Excel files are currently reachable only from the Data Analyst's local machine, not from a server. The ingestion service is built against real Odoo XML-RPC calls and real Excel parsing (not mocked), but is config-driven (host/db/user/API-key via environment variables) so it can run: (a) locally today for development/seeding, and (b) unchanged from the VPS once Odoo is reachable from there (VPN, IP allowlist, or a read replica — an infrastructure decision for IT, not a code change).

## 5. Hosting — Libyan Spider VPS (root access) + Docker Compose

**Choice:** A Libyan Spider VPS plan with root access, running the stack under Docker Compose (frontend container, API container, MySQL container — updated per §3, Python ingestion/scheduler container, Nginx reverse proxy + TLS).

**Why this and not the alternative:** Libyan Spider offers three tiers that could host this: shared cPanel hosting, jPaaS (their Docker/Node/Python platform-as-a-service), and VPS/dedicated with root access. Shared cPanel hosting was ruled out — cPanel's Node.js support (via Passenger) is built for a single app process per domain and has no first-class way to run Postgres or a background Python scheduler alongside it, which this platform needs all three of simultaneously. jPaaS is a reasonable alternative (it explicitly supports Docker/Node/Python) and should be revisited if the Data Analyst would rather not manage a VM directly. VPS with root access was chosen as the primary recommendation because it gives full control over Postgres configuration (needed for RLS policies and scheduled jobs), a persistent Python scheduler process for the 5x/day refresh (Section 5.14), and a straightforward Docker Compose deployment that isn't tied to a platform-specific deploy format — this also keeps the deployment portable if Libyan Spider is ever swapped for another provider.

## 6. Auth / RBAC — JWT-based auth with a role-manifest table, mapped 1:1 to the existing BI tiers

**Choice:** Server-issued JWTs carrying `role`, `company_scope` (Majaal/Tika/All), and `salesperson_id` (when applicable) claims, checked by API middleware. The role-manifest table design below is unaffected by the §3 MySQL correction; the specific "session variables consumed by RLS policies" enforcement described in the original rationale is Postgres-specific and needs a MySQL-native replacement (view-based row filtering, or enforcement entirely in the API's query-building layer, backstopped by tests) — that redesign is Phase P2 work, per §3 and §8, not decided here.

**Why the manifest shape itself still holds:** Section 5.2 requires "every dashboard/page declares its allowed roles in a manifest at build time, generated from the same Role-Based Access table." A generic manifest (`role_tier` / `dashboard` / `role_dashboard_access` — see `data/warehouse/migrations/0006_platform_rbac.sql`) was chosen over hardcoding role checks per page/component, because it is the only approach that lets adding a new department (Section 7.2: "adding a new department is a configuration change, not a code change") be a data change instead of a redeploy. The six existing tiers (BI 00 Executive, BI 01/02 Director, BI 03 Company Executive, Department Head, Salesperson) map directly to seed rows in this table; the Salesperson "own data only" rule (Section 4.10) is modeled by scoping `app_user.salesperson_key` to exactly one salesperson — but *how* that scoping gets enforced against every query (the RLS-equivalent guarantee) is exactly the open question flagged in §3, and is schema-only (no auth logic) as of this session.

## 7. Design tokens — extracted from the actual BMH/Majaal/Tika logo assets

Section 3.9's color table (Brand Navy #1B2A49, Brand Blue #2E5AAC, etc.) appears to be a placeholder proposal rather than a value derived from BMH's real visual identity. Two real brand sources exist in the project folder: the BMH group logo lockup (`logos/BMH/BMH logos.png`, pure black/white — Majaal, Tika, Athens, and SMG all render in black in the shared lockup) and Majaal's own `Majaal Visual Brand Guidlines.pdf`, which mandates a strict grayscale palette (`#FFFFFF` → `#000000`) for exactly the reason a luxury-goods brand often does — but Tika's individual logo file (`logos/Tika/tikalogo.png`) is not grayscale; it uses a navy-blue wordmark with a small red accent mark.

**Decision (per the Data Analyst's direction to derive tokens from the logos, not invent or import a print guide wholesale):**
- **Neutral/base scale** (backgrounds, body text, borders, chrome): taken from the shared BMH group lockup and Majaal's documented grayscale ramp — White `#FFFFFF`, Ash Grey `#B0B0B0`, Granite Grey `#666666`, Iron Grey `#333333`, Charcoal `#1A1A1A`, Black `#000000`. This is the platform default and what renders when Business Unit = "All".
- **Tika accent** (used when Business Unit = Tika): Navy `#003366` (primary actions, links, "Actual" series) with the logo's red mark `#CC0033` reserved for the semantic Alert Red role, replacing the Standards doc's invented `#C0392B` — they are the same hue family, so this is a refinement, not a conflict.
- **Majaal accent** (used when Business Unit = Majaal): Charcoal `#1A1A1A`, consistent with Majaal's own ratified brand guide, so this app never contradicts a document Majaal has already signed off on for its own identity.
- **Semantic traffic-light scale** (Section 3.9's green/amber/red target-status logic) is kept functionally independent of brand accent — Success Green `#2E7D32` and Watch Amber `#B8860B` are retained from the Standards doc as-is, since no logo asset provides a green or amber and this scale's job is universal meaning (on/under target), not brand expression.

This is implemented as light/dark CSS-variable pairs in `frontend/src/styles/tokens.css` (see Section 3.19). Athens and SMG partner logos referenced in the standards (Section 3.12/2.1.2) were not provided in this session's logo folder and are stubbed with placeholder slots in the header partner-badge row pending the actual files.

## 8. What was deliberately deferred

- **The MySQL Row-Level-Security enforcement mechanism (added 2026-07-05).** Confirmed as a real gap, not resolved by picking a workaround here: MySQL has no `CREATE POLICY` equivalent. Options for Phase P2 include MySQL views parameterized per role/company/salesperson, or enforcement entirely inside the API's query-building layer with strong test coverage as the backstop. This needs to be designed alongside the actual API code, not guessed at schema time — the warehouse schema itself (`data/warehouse/migrations/`) doesn't assume either approach.
- A component framework upgrade (NestJS, tRPC, GraphQL) — Section 5's requirements are met by the current Express + RLS-middleware shape; revisit only if Phase P3's measure layer outgrows it.
- Managed cloud warehouse (Snowflake/BigQuery) — revisit only if data volume or concurrent ExCo-wide queries (Section 7.4) exceed what a well-indexed MySQL instance on the VPS can serve within Section 5.15's performance budgets.
- CI deployment automation to the actual Libyan Spider VPS — the CI pipeline in this repo runs lint/build/test only; wiring a deploy step needs the VPS's real SSH/deploy credentials, which is an infrastructure step for the Data Analyst/IT, not a code decision.
