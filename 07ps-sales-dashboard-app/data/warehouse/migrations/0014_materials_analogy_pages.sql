-- New Sales pages: Stock Velocity, PIM Contribution, Product Lifecycle -- the "Materials Analogy"
-- module (product/inventory performance), registered under nav_group='Sales' alongside the
-- existing 8 Promotion reports rather than a new department, same pattern as
-- 0012_pipeline_pages.sql, continuing sort_order after activity_momentum (8).
--
-- Unlike the other 8 Sales pages, these 3 are static self-contained HTML files served from
-- frontend/public/reports/ (not Next.js routes wired to a live warehouse query) -- see
-- frontend/src/lib/navItems.ts's comment on this same trio. This migration only grants View/Export
-- *navigation* permission (canView(pageKey) gates whether the card renders at all, per
-- AuthProvider.tsx); it does not imply a live data connection.
--
-- A 4th report in this module, "BCG Matrix" (page_key would be 'bcg_matrix'), is expected but not
-- yet built -- do not add it here; add its own page_key/permission rows when it exists.

SET NAMES utf8mb4;

INSERT IGNORE INTO pages (page_key, page_label, nav_group, sort_order) VALUES
    ('stock_velocity',    'Stock Velocity',     'Sales', 9),
    ('pim_contribution',  'PIM Contribution',   'Sales', 10),
    ('product_lifecycle', 'Product Lifecycle',  'Sales', 11);

INSERT IGNORE INTO permissions (page_id, action)
SELECT page_id, 'view' FROM pages WHERE page_key IN ('stock_velocity', 'pim_contribution', 'product_lifecycle')
UNION ALL
SELECT page_id, 'export' FROM pages WHERE page_key IN ('stock_velocity', 'pim_contribution', 'product_lifecycle');

-- Same default role matrix as 0012_pipeline_pages.sql -- re-running these dynamic
-- (WHERE pg.nav_group = 'Sales') grants is safe: INSERT IGNORE skips every row already granted to
-- the 8 existing Sales pages, and only inserts the new grants for these 3 new page_ids.
INSERT IGNORE INTO role_permissions (role_id, permission_id, allowed)
SELECT r.role_id, p.permission_id, TRUE
FROM roles r
JOIN permissions p ON TRUE
JOIN pages pg ON pg.page_id = p.page_id
WHERE r.role_name = 'ADMIN';

INSERT IGNORE INTO role_permissions (role_id, permission_id, allowed)
SELECT r.role_id, p.permission_id, TRUE
FROM roles r
JOIN permissions p ON TRUE
JOIN pages pg ON pg.page_id = p.page_id
WHERE r.role_name IN ('GCEO', 'GCFO', 'GCCO', 'GCTO', 'TIKA_CEO', 'B2B_DIRECTOR', 'B2C_DIRECTOR')
  AND pg.nav_group = 'Sales';

INSERT IGNORE INTO role_permissions (role_id, permission_id, allowed)
SELECT r.role_id, p.permission_id, TRUE
FROM roles r
JOIN permissions p ON TRUE
JOIN pages pg ON pg.page_id = p.page_id
WHERE r.role_name = 'SALESPERSON'
  AND pg.nav_group = 'Sales'
  AND p.action = 'view';
