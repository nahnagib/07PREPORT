-- 0077: Product Development Plan permissions (backend/src/config/permissionRegistry.ts is the source of truth; its
-- startup sync creates the same pages/permissions rows, inserted here so the grants below have something to point at).
--
--   product_development_plan      dashboard   View, Export        the read-only views (no longer "coming soon")
--   product_development_entry     data entry  View, Create, Edit, Delete, Export   every form
--   product_development_approval  data entry  View, Edit          approve / reject / revise a gate; the API also
--                                                                 requires the approver's governance role for that gate
-- Grants: View on the plan to every role that views a Product report (same query as 0060; re-run safe); entry and
-- approval to ADMIN only (other roles are assigned on the Roles page).
-- Idempotent. Reverse: data/warehouse/down/0077_pdp_permissions_down.sql.

SET NAMES utf8mb4;

INSERT INTO pages (page_key, page_label, nav_group, sort_order) VALUES ('product_development_plan', 'Product Development Plan', 'Sales', 25)
  ON DUPLICATE KEY UPDATE page_label = VALUES(page_label);
INSERT INTO pages (page_key, page_label, nav_group, sort_order) VALUES ('product_development_entry', 'Product Development Plan: data entry', 'Data Entry', 26)
  ON DUPLICATE KEY UPDATE page_label = VALUES(page_label);
INSERT INTO pages (page_key, page_label, nav_group, sort_order) VALUES ('product_development_approval', 'Product Development Plan: gate approvals', 'Data Entry', 27)
  ON DUPLICATE KEY UPDATE page_label = VALUES(page_label);

INSERT IGNORE INTO permissions (page_id, action)
SELECT pg.page_id, a.action FROM pages pg
JOIN (SELECT 'view' AS action UNION ALL SELECT 'export') a
WHERE pg.page_key = 'product_development_plan';

INSERT IGNORE INTO permissions (page_id, action)
SELECT pg.page_id, a.action FROM pages pg
JOIN (SELECT 'view' AS action UNION ALL SELECT 'create' UNION ALL SELECT 'edit' UNION ALL SELECT 'delete' UNION ALL SELECT 'export') a
WHERE pg.page_key = 'product_development_entry';

INSERT IGNORE INTO permissions (page_id, action)
SELECT pg.page_id, a.action FROM pages pg
JOIN (SELECT 'view' AS action UNION ALL SELECT 'edit') a
WHERE pg.page_key = 'product_development_approval';

-- Plan View -> roles that view a Product report
INSERT IGNORE INTO role_permissions (role_id, permission_id, allowed)
SELECT DISTINCT rp.role_id, np.permission_id, 1
  FROM role_permissions rp
  JOIN permissions p ON p.permission_id = rp.permission_id AND p.action = 'view'
  JOIN pages pg ON pg.page_id = p.page_id AND pg.page_key IN ('bcg_matrix', 'stock_velocity', 'pim_contribution', 'product_lifecycle')
  JOIN pages npg ON npg.page_key = 'product_development_plan'
  JOIN permissions np ON np.page_id = npg.page_id AND np.action = 'view'
 WHERE rp.allowed = 1;

-- ADMIN: every action of the three pages (all-access in code too; this keeps the Roles matrix honest)
INSERT IGNORE INTO role_permissions (role_id, permission_id, allowed)
SELECT r.role_id, p.permission_id, 1
  FROM roles r
  JOIN pages pg ON pg.page_key IN ('product_development_plan', 'product_development_entry', 'product_development_approval')
  JOIN permissions p ON p.page_id = pg.page_id
 WHERE r.role_name = 'ADMIN';
