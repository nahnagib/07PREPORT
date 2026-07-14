-- New Sales pages: Pipeline Health, Pipeline Trend, Activity Momentum -- same nav_group='Sales'
-- pattern as 0009_auth_identity.sql's tachometer/critical_number/revenue_trend/invoices_engine/
-- customer_growth rows, continuing sort_order after customer_growth (5).

SET NAMES utf8mb4;

INSERT IGNORE INTO pages (page_key, page_label, nav_group, sort_order) VALUES
    ('pipeline_health',    'Pipeline Health',       'Sales', 6),
    ('pipeline_trend',     'Pipeline Trend',        'Sales', 7),
    ('activity_momentum',  'Activity Momentum',     'Sales', 8);

INSERT IGNORE INTO permissions (page_id, action)
SELECT page_id, 'view' FROM pages WHERE page_key IN ('pipeline_health', 'pipeline_trend', 'activity_momentum')
UNION ALL
SELECT page_id, 'export' FROM pages WHERE page_key IN ('pipeline_health', 'pipeline_trend', 'activity_momentum');

-- Same default role matrix as 0009_auth_identity.sql -- re-running these dynamic
-- (WHERE pg.nav_group = 'Sales') grants is safe: INSERT IGNORE skips every row already granted to
-- the 5 existing Sales pages, and only inserts the new grants for these 3 new page_ids.
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
