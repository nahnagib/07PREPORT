-- 0048: NPS Score permissions (Process department).
--   nps_score     the page (View + Export)
--   nps_comments  the detractor list with the customers' free-text comments (personal free text, decision D6): View shows them,
--                 Export downloads them
-- Granted to ADMIN only. Other roles get them on the Roles page. pages / permissions rows are also kept by the
-- backend's registry sync at startup (permissionRegistry.ts); inserting them here makes the grant independent of the
-- startup order. Idempotent. Reverse: data/warehouse/down/0048_process_nps_permissions_down.sql.

SET NAMES utf8mb4;

INSERT INTO pages (page_key, page_label, nav_group, sort_order) VALUES ('nps_score', 'NPS Score', 'Sales', 19)
  ON DUPLICATE KEY UPDATE page_label = VALUES(page_label);
INSERT INTO pages (page_key, page_label, nav_group, sort_order) VALUES ('nps_comments', 'NPS Score comments', 'Sales', 20)
  ON DUPLICATE KEY UPDATE page_label = VALUES(page_label);
INSERT IGNORE INTO permissions (page_id, action) SELECT page_id, 'view' FROM pages WHERE page_key = 'nps_score';
INSERT IGNORE INTO permissions (page_id, action) SELECT page_id, 'export' FROM pages WHERE page_key = 'nps_score';
INSERT IGNORE INTO permissions (page_id, action) SELECT page_id, 'view' FROM pages WHERE page_key = 'nps_comments';
INSERT IGNORE INTO permissions (page_id, action) SELECT page_id, 'export' FROM pages WHERE page_key = 'nps_comments';
INSERT IGNORE INTO role_permissions (role_id, permission_id, allowed)
SELECT r.role_id, p.permission_id, 1
FROM roles r
JOIN pages pg ON pg.page_key IN ('nps_score', 'nps_comments')
JOIN permissions p ON p.page_id = pg.page_id
WHERE r.role_name = 'ADMIN';
