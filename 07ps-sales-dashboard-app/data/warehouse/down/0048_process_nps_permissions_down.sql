-- Reverses 0048_process_nps_permissions.sql: removes the NPS Score pages, their permissions and every role's grants
-- of them. Roll the backend back first: its registry sync recreates the pages at startup.

SET NAMES utf8mb4;

DELETE rp FROM role_permissions rp
JOIN permissions p ON p.permission_id = rp.permission_id
JOIN pages pg ON pg.page_id = p.page_id
WHERE pg.page_key IN ('nps_score', 'nps_comments');
DELETE p FROM permissions p JOIN pages pg ON pg.page_id = p.page_id WHERE pg.page_key IN ('nps_score', 'nps_comments');
DELETE FROM pages WHERE page_key IN ('nps_score', 'nps_comments');
