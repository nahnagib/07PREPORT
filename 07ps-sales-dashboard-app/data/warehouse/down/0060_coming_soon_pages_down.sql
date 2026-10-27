-- Reverse of 0060_coming_soon_pages.sql: removes the three placeholder pages and their grants.
SET NAMES utf8mb4;
DELETE rp FROM role_permissions rp
  JOIN permissions p ON p.permission_id = rp.permission_id
  JOIN pages pg ON pg.page_id = p.page_id
 WHERE pg.page_key IN ('quality_assurance', 'customer_pulse', 'product_development_plan');
DELETE p FROM permissions p JOIN pages pg ON pg.page_id = p.page_id
 WHERE pg.page_key IN ('quality_assurance', 'customer_pulse', 'product_development_plan');
DELETE FROM pages WHERE page_key IN ('quality_assurance', 'customer_pulse', 'product_development_plan');
