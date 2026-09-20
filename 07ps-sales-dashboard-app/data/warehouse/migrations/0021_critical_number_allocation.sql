-- Critical Number percentage-breakdown allocation, extending the existing admin_company /
-- admin_customer_group reference-data tables (0018_reference_data_admin.sql) rather than adding a
-- new table -- every company/customer-group an admin already manages through those CRUD
-- endpoints/admin pages automatically gets a critical_number_pct column (default 0), so a newly
-- created company/group is guaranteed a row here with no extra wiring, satisfying the "new company/
-- group always has a defined share, default 0% until set" requirement without a second admin
-- surface to keep in sync.
--
-- Used by backend/src/measures/criticalNumber.ts's computeDailyCriticalNumber to scale the flat
-- 560,000 Daily Critical Number by the active Company/Customer Group filter selection: no filter on
-- a dimension leaves that dimension's factor at 1 (100%); one or more selected values sum that
-- dimension's critical_number_pct/100 across the selection (so selecting every company/group in a
-- dimension is equivalent to no filter, when percentages sum to 100); Company and Customer Group
-- factors multiply together (nested cascade), not add. See that function's docstring for the exact
-- rule and worked examples.
--
-- Deliberately reuses admin_company/admin_customer_group instead of a standalone allocation table:
-- both already have full CRUD (companyAdminService.ts/customerGroupAdminService.ts), an admin page
-- each, and per-row history auditing -- a percentage is just one more attribute of the same
-- company/customer-group record, not a separate concept needing its own lifecycle.

SET NAMES utf8mb4;

ALTER TABLE admin_company
  ADD COLUMN critical_number_pct DECIMAL(6,3) NOT NULL DEFAULT 0 AFTER display_order;

ALTER TABLE admin_company_history
  ADD COLUMN critical_number_pct DECIMAL(6,3) NULL AFTER display_order;

ALTER TABLE admin_customer_group
  ADD COLUMN critical_number_pct DECIMAL(6,3) NOT NULL DEFAULT 0 AFTER display_order;

ALTER TABLE admin_customer_group_history
  ADD COLUMN critical_number_pct DECIMAL(6,3) NULL AFTER display_order;

-- Seed the confirmed business breakdown (2026-09 Critical Number dynamic-filter pass: Majaal
-- 47.44% / Tika 52.56% of company split, B2B 62.88% / B2C 37.12% of customer-group split). Matched
-- case-insensitively against name/etl_*_name since Dim_Company/Dim_Segment casing is mixed in the
-- live warehouse (see criticalNumber.ts's offDayMatchesScope docstring for the same "Majaal" vs
-- "TIKA" casing note) -- a row that doesn't match either literal here just keeps its 0 default
-- until an admin sets a real value, per this feature's "default 0% until configured" requirement.
UPDATE admin_company SET critical_number_pct = 47.44
  WHERE UPPER(name) = 'MAJAAL' OR UPPER(etl_company_name) = 'MAJAAL';
UPDATE admin_company SET critical_number_pct = 52.56
  WHERE UPPER(name) = 'TIKA' OR UPPER(etl_company_name) = 'TIKA';

UPDATE admin_customer_group SET critical_number_pct = 62.88
  WHERE UPPER(name) = 'B2B' OR UPPER(etl_segment_name) = 'B2B';
UPDATE admin_customer_group SET critical_number_pct = 37.12
  WHERE UPPER(name) = 'B2C' OR UPPER(etl_segment_name) = 'B2C';
