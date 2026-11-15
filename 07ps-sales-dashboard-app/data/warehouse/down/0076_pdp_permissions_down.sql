-- Reverses 0076_pdp_permissions.sql: removes the entry and approval pages (with their role grants and user overrides)
-- and puts the "(coming soon)" label back on product_development_plan (0060's state; its View grants stay).
-- Roll the backend back first: its registry sync would otherwise recreate the two pages at startup.

SET NAMES utf8mb4;

DELETE up FROM user_permissions up
  JOIN permissions p ON p.permission_id = up.permission_id
  JOIN pages pg ON pg.page_id = p.page_id
 WHERE pg.page_key IN ('product_development_entry', 'product_development_approval');
DELETE rp FROM role_permissions rp
  JOIN permissions p ON p.permission_id = rp.permission_id
  JOIN pages pg ON pg.page_id = p.page_id
 WHERE pg.page_key IN ('product_development_entry', 'product_development_approval');
DELETE p FROM permissions p
  JOIN pages pg ON pg.page_id = p.page_id
 WHERE pg.page_key IN ('product_development_entry', 'product_development_approval');
DELETE FROM pages WHERE page_key IN ('product_development_entry', 'product_development_approval');

UPDATE pages SET page_label = 'Product Development Plan (coming soon)' WHERE page_key = 'product_development_plan';
