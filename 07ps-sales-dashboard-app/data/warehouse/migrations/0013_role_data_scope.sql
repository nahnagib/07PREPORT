-- Role-based row-level data scope: a generic (role_id, dimension, value) rule table, keyed on the
-- same 5 filter dimensions already defined in backend/src/measures/filters.ts (companyKeys,
-- segmentKeys, channelKeys, salesTeamKeys, salespersonKeys) rather than a one-off hardcoded rule.
-- No rows for a role = unrestricted (today's behavior, unchanged) -- purely additive. Multiple rows
-- per (role_id, dimension) express an IN (...) restriction (e.g. Branch IN [X, Y]).
--
-- Enforced in backend/src/middleware/scopeContext.ts's applyRoleDataScope, the same choke point
-- that already enforces the SALESPERSON-tier lock (applySalespersonLock) -- see that file's header
-- comment for why this is the one place a role-level restriction needs to be applied.

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS role_data_scope (
    scope_id     INT AUTO_INCREMENT PRIMARY KEY,
    role_id      INT NOT NULL,
    dimension    ENUM('companyKeys', 'segmentKeys', 'channelKeys', 'salesTeamKeys', 'salespersonKeys') NOT NULL,
    value        VARCHAR(64) NOT NULL,
    created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_role_data_scope (role_id, dimension, value),
    FOREIGN KEY (role_id) REFERENCES roles(role_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Concrete case: B2B Director role's data scope -- Customer Group = B2B (SegmentKey 1, see
-- backend/src/measures/filters.ts's docstring for the confirmed segment-key mapping).
INSERT IGNORE INTO role_data_scope (role_id, dimension, value)
SELECT role_id, 'segmentKeys', '1' FROM roles WHERE role_name = 'B2B_DIRECTOR';

-- Defensive, idempotent re-grant: 0009_auth_identity.sql and 0012_pipeline_pages.sql already grant
-- B2B_DIRECTOR View+Export on every Sales-group page. INSERT IGNORE makes re-running this safe
-- regardless of whether those grants are already present in a given environment.
INSERT IGNORE INTO role_permissions (role_id, permission_id, allowed)
SELECT r.role_id, p.permission_id, TRUE
FROM roles r
JOIN permissions p ON TRUE
JOIN pages pg ON pg.page_id = p.page_id
WHERE r.role_name = 'B2B_DIRECTOR'
  AND pg.nav_group = 'Sales';
