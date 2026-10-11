-- Per-salesperson target-override seasonality (2026-09). Scope: applies ONLY to
-- salesperson_admin_profile.target_override_amount (0016_admin_salesperson_profile.sql) -- the one
-- place in the system a genuinely ANNUAL target figure exists. Real, non-override targets already
-- come in monthly from Fact_Targets (ETL-sourced, already non-uniform per salesperson/month) and are
-- entirely unaffected by this table.
--
-- Before this migration, an override was split flat: target_override_amount / 12 for every month
-- (backend/src/measures/tachometer.ts's fetchMonthlyOverrideAmounts). This table lets an admin
-- record each overridden salesperson's own monthly share of that annual figure instead, so a
-- heavy-Q4 salesperson's override isn't misrepresented as flat when checked against a monthly/daily
-- figure.
--
-- Storage shape: one row per (salesperson_key, month), not a JSON array column on
-- salesperson_admin_profile. Every consumer of a target figure (tachometer.ts) already reads
-- Fact_Targets one target_year/target_month at a time -- a relational per-month row lets the override
-- path be read/summed the exact same way, and keeps validation (12 rows, weights summing to 100%)
-- enforced once in application code (backend/src/lib/seasonality.ts) rather than parsed out of JSON
-- on every read. MySQL 8's CHECK constraints can't validate a cross-row aggregate ("do this
-- salesperson's 12 rows sum to 100"), so that invariant is application-level only -- same reasoning
-- 0016 gives for target_override_amount's own "> 0" rule not being a DB constraint either.
--
-- FK to salesperson_admin_profile (not Dim_Salesperson) with ON DELETE CASCADE: a seasonality
-- profile has no meaning without the override row it belongs to (see lib/seasonality.ts's module
-- docstring) -- if that profile row is ever deleted, its seasonality rows should disappear with it.
--
-- weight_pct is a percentage (0-100, e.g. 8.3333 for an even Jan share), NOT a 0-1 fraction, to
-- match how the admin UI collects and displays it (running-sum-to-100% validation).
--
-- No default rows are seeded for existing overrides here -- an override with no rows in this table
-- is read as an even 12-way split at query time (backend/src/lib/seasonality.ts's
-- EVEN_SPLIT_SEASONALITY_PCT), mathematically identical to this override's pre-seasonality behavior,
-- so nothing changes for an override an admin hasn't revisited yet. Editing that override going
-- forward requires an explicit, validated seasonality profile (see salespersonAdminService.ts).

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS salesperson_target_seasonality (
    salesperson_key BIGINT NOT NULL,
    month           TINYINT NOT NULL,
    weight_pct      DECIMAL(7, 4) NOT NULL,
    PRIMARY KEY (salesperson_key, month),
    FOREIGN KEY (salesperson_key) REFERENCES salesperson_admin_profile(salesperson_key) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
