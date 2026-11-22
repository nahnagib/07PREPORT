-- Reverses 0081_pdt_families_excel_import.sql: drops the import log and the round-2 columns, makes the round-1 columns
-- required again and removes the family / project type lists. Roll the backend back first.
-- Rows with a "not set" value (NULL health / priority / owner / readiness / category) would block the MODIFY ... NOT NULL
-- below, so they are removed first: run it only on a test database, or after exporting the Excel file.

SET NAMES utf8mb4;

DROP TABLE IF EXISTS pdt_import_log;

SET @stmt = (SELECT IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pdt_blocker' AND COLUMN_NAME = 'external_id'),
  'ALTER TABLE pdt_blocker DROP INDEX uq_pdt_blocker_external, DROP COLUMN external_id, DROP COLUMN raised_on', 'DO 0'));
PREPARE st FROM @stmt; EXECUTE st; DEALLOCATE PREPARE st;

SET @stmt = (SELECT IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pdt_status_update' AND COLUMN_NAME = 'updated_by_name'),
  'ALTER TABLE pdt_status_update DROP COLUMN updated_by_name', 'DO 0'));
PREPARE st FROM @stmt; EXECUTE st; DEALLOCATE PREPARE st;

SET @stmt = (SELECT IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pdt_product' AND COLUMN_NAME = 'family_id'),
  'ALTER TABLE pdt_product DROP FOREIGN KEY fk_pdt_product_family, DROP FOREIGN KEY fk_pdt_product_project_type,
     DROP INDEX idx_pdt_product_family, DROP COLUMN family_id, DROP COLUMN subfamily, DROP COLUMN project_type_id,
     DROP COLUMN next_step, DROP COLUMN next_step_due, DROP COLUMN comment, DROP COLUMN updated_by_name, DROP COLUMN last_edited_on',
  'DO 0'));
PREPARE st FROM @stmt; EXECUTE st; DEALLOCATE PREPARE st;

-- Products / updates / blockers with values round 1 cannot hold.
DELETE b FROM pdt_blocker b JOIN pdt_product p ON p.product_id = b.product_id
 WHERE p.category_id IS NULL OR p.owner_name IS NULL OR p.priority_id IS NULL OR p.health_id IS NULL OR p.readiness_pct IS NULL;
DELETE FROM pdt_blocker WHERE owner_name IS NULL;
DELETE u FROM pdt_status_update u JOIN pdt_product p ON p.product_id = u.product_id
 WHERE p.category_id IS NULL OR p.owner_name IS NULL OR p.priority_id IS NULL OR p.health_id IS NULL OR p.readiness_pct IS NULL;
DELETE FROM pdt_status_update WHERE health_id IS NULL OR readiness_pct IS NULL;
DELETE h FROM pdt_stage_history h JOIN pdt_product p ON p.product_id = h.product_id
 WHERE p.category_id IS NULL OR p.owner_name IS NULL OR p.priority_id IS NULL OR p.health_id IS NULL OR p.readiness_pct IS NULL;
DELETE FROM pdt_product WHERE category_id IS NULL OR owner_name IS NULL OR priority_id IS NULL OR health_id IS NULL OR readiness_pct IS NULL;

-- MySQL refuses NULL -> NOT NULL on a foreign-key column while key checks are on (error 1832); no row is NULL by now.
SET FOREIGN_KEY_CHECKS = 0;
ALTER TABLE pdt_blocker MODIFY owner_name VARCHAR(150) NOT NULL;
ALTER TABLE pdt_status_update MODIFY health_id INT NOT NULL, MODIFY readiness_pct TINYINT UNSIGNED NOT NULL;
ALTER TABLE pdt_product
  MODIFY code VARCHAR(12) NULL,
  MODIFY category_id INT NOT NULL,
  MODIFY owner_name VARCHAR(150) NOT NULL,
  MODIFY priority_id INT NOT NULL,
  MODIFY health_id INT NOT NULL,
  MODIFY readiness_pct TINYINT UNSIGNED NOT NULL DEFAULT 0;
SET FOREIGN_KEY_CHECKS = 1;

DELETE FROM pdt_dropdown_value WHERE list_key IN ('family', 'project_type');
UPDATE pdt_dropdown_value SET is_active = 1 WHERE list_key = 'category';
SET @stmt = (SELECT IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pdt_dropdown_value' AND COLUMN_NAME = 'description'),
  'ALTER TABLE pdt_dropdown_value DROP COLUMN description', 'DO 0'));
PREPARE st FROM @stmt; EXECUTE st; DEALLOCATE PREPARE st;
ALTER TABLE pdt_dropdown_value MODIFY list_key ENUM('stage', 'health', 'priority', 'category') NOT NULL;
