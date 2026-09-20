-- New Sales page: BCG Matrix -- the 4th and final page in the Materials Analogy module (Stock
-- Velocity / PIM Contribution / Product Lifecycle already registered in
-- 0014_materials_analogy_pages.sql). Same nav_group='Sales' pattern, continuing sort_order after
-- product_lifecycle (11).
--
-- Ordering note: navItems.ts lists BCG Matrix *before* the other 3 Materials Analogy pages (it's
-- the classification page the other 3 build on), but sort_order here only needs to be unique and
-- monotonic for admin/reporting queries that sort by it -- the frontend tab order comes from
-- NAV_ITEMS array order, not this column.
--
-- Like the other 3, this is a real Next.js route rendering against local synthetic data
-- (lib/materialsAnalogy/shared.ts), not a live warehouse query -- this migration only grants
-- navigation permission (canView(pageKey) gates whether the card/tab renders at all).

SET NAMES utf8mb4;

INSERT IGNORE INTO pages (page_key, page_label, nav_group, sort_order) VALUES
    ('bcg_matrix', 'BCG Matrix', 'Sales', 12);

INSERT IGNORE INTO permissions (page_id, action)
SELECT page_id, 'view' FROM pages WHERE page_key = 'bcg_matrix'
UNION ALL
SELECT page_id, 'export' FROM pages WHERE page_key = 'bcg_matrix';

-- Same default role matrix as 0014_materials_analogy_pages.sql -- re-running these dynamic
-- (WHERE pg.nav_group = 'Sales') grants is safe: INSERT IGNORE skips every row already granted to
-- the other 11 Sales pages, and only inserts the new grants for this page_id.
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
