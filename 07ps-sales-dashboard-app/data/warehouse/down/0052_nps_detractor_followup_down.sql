-- Reverse of 0052_nps_detractor_followup.sql. DROPS every follow-up case, its history and the reason list: export
-- them first (Detractor Follow-up > Export) if they are needed. The EXCELLENCE_MANAGER grants on nps_score /
-- nps_comments (View) are removed too.

SET NAMES utf8mb4;

DELETE rp FROM role_permissions rp
JOIN permissions p ON p.permission_id = rp.permission_id
JOIN pages pg ON pg.page_id = p.page_id
WHERE pg.page_key IN ('nps_followup', 'nps_followup_reasons');

DELETE rp FROM role_permissions rp
JOIN roles r ON r.role_id = rp.role_id
JOIN permissions p ON p.permission_id = rp.permission_id
JOIN pages pg ON pg.page_id = p.page_id
WHERE r.role_name = 'EXCELLENCE_MANAGER' AND pg.page_key IN ('nps_score', 'nps_comments');

DELETE p FROM permissions p JOIN pages pg ON pg.page_id = p.page_id WHERE pg.page_key IN ('nps_followup', 'nps_followup_reasons');
DELETE FROM pages WHERE page_key IN ('nps_followup', 'nps_followup_reasons');

DROP TABLE IF EXISTS nps_followup_audit;
DROP TABLE IF EXISTS nps_followup_case;
DROP TABLE IF EXISTS nps_followup_reason;
