-- Salesperson Admin page: admin-editable clean display name + an audit trail for the
-- app_user.salesperson_key link.
--
-- app_user.salesperson_key ALREADY EXISTS (0009_auth_identity.sql) and deliberately has NO
-- foreign key to Dim_Salesperson -- the real Dim_Salesperson table in powerBI_Data is a raw ETL
-- dump (SalespersonKey BIGINT, no primary/unique key at all), so an FK there is structurally
-- impossible, not just omitted. This migration does not attempt one, for the same reason; the
-- new history table below is likewise unenforced on the salesperson-key side, only on user_id.
--
-- CREATE TABLE IF NOT EXISTS below, same convention as every other migration in this folder.
-- The ADD COLUMN statements are plain (no IF NOT EXISTS -- MySQL 8.0 doesn't support that clause
-- on ADD COLUMN, confirmed against this project's actual 8.0.46 instance; that's a MariaDB-only
-- extension), matching 0008_target_plan_period_columns.sql's own ADD COLUMN precedent: run this
-- file once per environment, not safe to blindly re-run like the rest of this folder is.

SET NAMES utf8mb4;

-- admin_name_override: an admin-recorded, cleaner display name than the raw ODOO name in
-- Dim_Salesperson.salesperson -- same overlay pattern (falls back to the live name when NULL,
-- handled in salespersonAdminService.ts) as team_name_override on sales_team_admin_profile.
ALTER TABLE salesperson_admin_profile
  ADD COLUMN admin_name_override VARCHAR(255) NULL AFTER salesperson_key;

ALTER TABLE salesperson_admin_profile_history
  ADD COLUMN admin_name_override VARCHAR(255) NULL AFTER salesperson_key;

-- Append-only audit trail for changes to app_user.salesperson_key (who linked/relinked/unlinked a
-- user to an ETL salesperson, and when). Separate from login_history -- that table's event_type
-- enum is auth/session events, not profile-field changes, and doesn't carry old/new values.
CREATE TABLE IF NOT EXISTS user_salesperson_change_history (
    history_id           BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id               INT NOT NULL,
    old_salesperson_key       INT NULL,
    new_salesperson_key           INT NULL,
    changed_at                        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    changed_by                              INT NULL,
    FOREIGN KEY (user_id) REFERENCES app_user(user_id),
    FOREIGN KEY (changed_by) REFERENCES app_user(user_id),
    INDEX idx_user_salesperson_change_history_user (user_id, changed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
