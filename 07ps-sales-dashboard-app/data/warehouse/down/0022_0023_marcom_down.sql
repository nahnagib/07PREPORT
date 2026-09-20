-- Manual down-migration for 0022 + 0023 (the repo has no down-migration convention; this is
-- provided for dev/test databases only -- it DESTROYS all uploaded MARCOM data).
SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS marcom_staged_upload;
DROP TABLE IF EXISTS marcom_event;
DROP TABLE IF EXISTS marcom_trade_monthly;
DROP TABLE IF EXISTS marcom_web_monthly;
DROP TABLE IF EXISTS marcom_social_monthly;
DROP TABLE IF EXISTS marcom_campaign_media;
DROP TABLE IF EXISTS marcom_campaign;
DROP TABLE IF EXISTS marcom_spend_monthly;
DROP TABLE IF EXISTS marcom_brand;
DROP TABLE IF EXISTS marcom_upload_batch;
SET FOREIGN_KEY_CHECKS = 1;
DELETE rp FROM role_permissions rp JOIN permissions p ON p.permission_id = rp.permission_id
  JOIN pages pg ON pg.page_id = p.page_id
  WHERE pg.page_key IN ('marcom_spending','marcom_media_campaigns','marcom_digital','marcom_trade','admin_marcom_upload');
DELETE up FROM user_permissions up JOIN permissions p ON p.permission_id = up.permission_id
  JOIN pages pg ON pg.page_id = p.page_id
  WHERE pg.page_key IN ('marcom_spending','marcom_media_campaigns','marcom_digital','marcom_trade','admin_marcom_upload');
DELETE p FROM permissions p JOIN pages pg ON pg.page_id = p.page_id
  WHERE pg.page_key IN ('marcom_spending','marcom_media_campaigns','marcom_digital','marcom_trade','admin_marcom_upload');
DELETE FROM pages WHERE page_key IN ('marcom_spending','marcom_media_campaigns','marcom_digital','marcom_trade','admin_marcom_upload');
