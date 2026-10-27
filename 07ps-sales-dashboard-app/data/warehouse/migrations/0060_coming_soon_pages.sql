-- 0060: "Coming soon" placeholder pages (2026-10-27), announced in the navigation before they are built:
--   Process: quality_assurance (Quality Assurance), customer_pulse (Customer Pulse)
--   Product: product_development_plan (Product Development Plan)
-- View + Export like every report (only View is granted to users below). The backend's registry sync (permissionRegistry.ts) also creates the pages / permissions rows at startup;
-- inserting them here makes the grant independent of the startup order.
--
-- Grant: View to every role that can already VIEW at least one report of the same department, so the people who use
-- Process / Product see the announcement there (ADMIN sees everything anyway). Admins can change it on the Roles page.
-- Idempotent. Reverse: data/warehouse/down/0060_coming_soon_pages_down.sql.

SET NAMES utf8mb4;

INSERT INTO pages (page_key, page_label, nav_group, sort_order) VALUES ('quality_assurance', 'Quality Assurance (coming soon)', 'Sales', 23)
  ON DUPLICATE KEY UPDATE page_label = VALUES(page_label);
INSERT INTO pages (page_key, page_label, nav_group, sort_order) VALUES ('customer_pulse', 'Customer Pulse (coming soon)', 'Sales', 24)
  ON DUPLICATE KEY UPDATE page_label = VALUES(page_label);
INSERT INTO pages (page_key, page_label, nav_group, sort_order) VALUES ('product_development_plan', 'Product Development Plan (coming soon)', 'Sales', 25)
  ON DUPLICATE KEY UPDATE page_label = VALUES(page_label);

INSERT IGNORE INTO permissions (page_id, action) SELECT page_id, 'view' FROM pages WHERE page_key IN ('quality_assurance', 'customer_pulse', 'product_development_plan');
INSERT IGNORE INTO permissions (page_id, action) SELECT page_id, 'export' FROM pages WHERE page_key IN ('quality_assurance', 'customer_pulse', 'product_development_plan');

-- Process placeholders -> roles that view a Process report
INSERT IGNORE INTO role_permissions (role_id, permission_id, allowed)
SELECT DISTINCT rp.role_id, np.permission_id, 1
  FROM role_permissions rp
  JOIN permissions p ON p.permission_id = rp.permission_id AND p.action = 'view'
  JOIN pages pg ON pg.page_id = p.page_id AND pg.page_key IN ('kaizen_board', 'nps_score', 'nps_followup')
  JOIN pages npg ON npg.page_key IN ('quality_assurance', 'customer_pulse')
  JOIN permissions np ON np.page_id = npg.page_id AND np.action = 'view'
 WHERE rp.allowed = 1;

-- Product placeholder -> roles that view a Product report
INSERT IGNORE INTO role_permissions (role_id, permission_id, allowed)
SELECT DISTINCT rp.role_id, np.permission_id, 1
  FROM role_permissions rp
  JOIN permissions p ON p.permission_id = rp.permission_id AND p.action = 'view'
  JOIN pages pg ON pg.page_id = p.page_id AND pg.page_key IN ('bcg_matrix', 'stock_velocity', 'pim_contribution', 'product_lifecycle')
  JOIN pages npg ON npg.page_key = 'product_development_plan'
  JOIN permissions np ON np.page_id = npg.page_id AND np.action = 'view'
 WHERE rp.allowed = 1;

-- ADMIN explicitly too (it has every action implicitly; this keeps the Roles matrix honest)
INSERT IGNORE INTO role_permissions (role_id, permission_id, allowed)
SELECT r.role_id, p.permission_id, 1
  FROM roles r
  JOIN pages pg ON pg.page_key IN ('quality_assurance', 'customer_pulse', 'product_development_plan')
  JOIN permissions p ON p.page_id = pg.page_id
 WHERE r.role_name = 'ADMIN';
