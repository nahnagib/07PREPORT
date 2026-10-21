-- 0055: Admin-editable Daily Critical Number (2026-10-21).
--
-- The company-wide Daily Critical Number (the baseline daily sales target of the Critical Number page) was a code
-- constant, LYD 560,000. It becomes an admin-owned, dated history: every change is a NEW row with the date it applies
-- from, and nothing is ever updated or deleted, so a past day always keeps the value that was active on it.
--
--   Value on day D = the row with the latest effective_from <= D (several rows on one date: the newest row wins).
--   A day before the earliest row uses the earliest row (the seed below carries the old constant).
--
-- Read by backend/src/measures/criticalNumberHistory.ts (getCriticalNumber / loadCriticalNumberHistory) on every
-- Critical Number request; written only by Admin > Critical Number (backend/src/routes/admin/criticalNumber.ts, Admin
-- role only). Company / Customer Group shares (admin_company / admin_customer_group critical_number_pct, 0021) still
-- scale this base value; they are not part of this table.
--
-- Seed: the old constant, effective from the start of the current year, so the page shows exactly the same figures
-- right after deploy. Idempotent: the table is created only when missing and the seed is inserted only when the table
-- is empty. Reverse: data/warehouse/down/0055_critical_number_history_down.sql.

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS critical_number_history (
    id               INT AUTO_INCREMENT PRIMARY KEY,
    value_lyd        DECIMAL(16, 2) NOT NULL COMMENT 'company-wide Daily Critical Number in LYD, before Company / Customer Group scaling',
    effective_from   DATE NOT NULL COMMENT 'first day this value applies to; it applies until the next row''s effective_from',
    created_by       INT NULL COMMENT 'app_user who made the change; NULL for the migration seed',
    created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    note             VARCHAR(500) NULL,
    FOREIGN KEY (created_by) REFERENCES app_user(user_id),
    INDEX idx_critical_number_history_effective (effective_from, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO critical_number_history (value_lyd, effective_from, created_by, note)
SELECT 560000.00, MAKEDATE(YEAR(CURDATE()), 1), NULL, 'Initial value (was the fixed LYD 560,000 constant)'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM critical_number_history);
