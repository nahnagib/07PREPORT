-- Company link for Admin Salesperson/Sales Team Management -- adds company_key_override to
-- salesperson_admin_profile and sales_team_admin_profile, same overlay-column pattern as
-- channel_key_override/segment_key_override/sales_team_key_override (0016).
--
-- SCOPE, deliberately narrow -- and, unlike 0016's own history, this one is NOT superseded later
-- (confirmed with the user before implementing): channel_key_override/segment_key_override/
-- sales_team_key_override/target_override_amount all DO reclassify report/dashboard totals today
-- (see 0016's SUPERSEDED note and backend/src/measures/filters.ts's effectiveSegmentExpr
-- docstring). company_key_override is explicitly NOT given the same treatment -- it is never
-- wired into buildWhereClause's OVERRIDE_EXPR map, and Fact_*.CompanyKey per transaction remains
-- the only thing any report's Company total is ever computed from. This column exists for exactly
-- two purposes: (1) admin organizational labeling on the two Management pages, (2) an input to the
-- new cascading filter-option endpoints in backend/src/routes/filters.ts (GET /filters/
-- customer-groups /distribution-channels /branches /salespersons), which narrow dropdown
-- *options* shown to a user, never report totals. See routes/filters.ts's
-- SALESPERSON_COMPANY_MAP_SQL for the one place this column is actually read.
--
-- References Dim_Company.CompanyKey directly (the raw ETL key), NOT admin_company.company_id --
-- same convention the three existing override columns already use (reference the raw Dim_* key,
-- never the admin overlay/reference-data table's own id). No FK -- Dim_Company has no enforced
-- PK/unique key in the live warehouse (same reasoning as 0016's header for salesperson_key/
-- Dim_Salesperson). Existence is validated in application code
-- (salespersonAdminService.ts/salesTeamAdminService.ts's companyExists()) before every upsert.
--
-- NULL is a valid, permanent state, not just "not yet set" -- a salesperson/team can legitimately
-- have no company link (legacy import, shared corporate staff).
--
-- SUPERSEDED (2026-09, "Exclude NULL Company Salespersons from Cascading Filters"): the paragraph
-- above originally continued "...so a NULL-company salesperson/team must still appear under every
-- company's cascade, never excluded" -- reversed on explicit request. A company-narrowed cascade
-- (any /filters/* call with a companyKeys param) now excludes NULL-company records entirely, same
-- as anything else that doesn't match the selected company -- they stay fully visible only when no
-- companyKeys param is given at all (the fast/unnarrowed path). See routes/filters.ts's inClause
-- (the old inOrNullClause helper this comment used to reference no longer exists).
--
-- Indices added on the live tables only (not the _history tables, which are never queried by
-- company -- only by salesperson_key/sales_team_key + changed_at, per their existing indices) --
-- the cascading endpoints filter/join on company_key_override on every request.

SET NAMES utf8mb4;

ALTER TABLE salesperson_admin_profile
    ADD COLUMN company_key_override BIGINT NULL AFTER sales_team_key_override,
    ADD INDEX idx_sap_company_key_override (company_key_override);

ALTER TABLE salesperson_admin_profile_history
    ADD COLUMN company_key_override BIGINT NULL AFTER sales_team_key_override;

ALTER TABLE sales_team_admin_profile
    ADD COLUMN company_key_override BIGINT NULL AFTER segment_key_override,
    ADD INDEX idx_stap_company_key_override (company_key_override);

ALTER TABLE sales_team_admin_profile_history
    ADD COLUMN company_key_override BIGINT NULL AFTER segment_key_override;
