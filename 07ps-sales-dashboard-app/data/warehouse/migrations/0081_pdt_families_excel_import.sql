-- 0081: Product Development Plan tracker, round 2 (PROMPT_product_pipeline_redesign_2026-11-18; docs/product-development-standalone.md):
-- the real Xtreme pipeline maintained in Input/product_development/Product_Development_Input.xlsx.
--
--   pdt_dropdown_value  + list keys 'family' (the 8 Xtreme families, with a description) and 'project_type'
--                       (Planned / Unplanned / Innovation / Reformulation); + description column.
--                       The old 'category' values (0080) are deactivated: Family replaces Category.
--   pdt_product         code now holds the business code (XT-###). + family_id, subfamily, project_type_id, next_step,
--                       next_step_due, comment, updated_by_name, last_edited_on. Health, priority, owner and readiness
--                       may be "not set" (NULL): the file leaves them blank until the business fills them.
--                       category_id becomes optional (kept, unused).
--   pdt_status_update   health / readiness optional, + updated_by_name (the Excel "Updated by").
--   pdt_blocker         + external_id (BL-###, the Excel "ID", unique), raised_on; owner optional.
--   pdt_import_log      one row per confirmed Excel import: who, when, file, counts, products missing from the file.
--
-- Idempotent: every ALTER checks information_schema first; INSERT IGNORE for the lists.
-- Reverse: data/warehouse/down/0081_pdt_families_excel_import_down.sql.

SET NAMES utf8mb4;

-- ---------------------------------------------------------------------------------------------------------------------
-- Lists
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE pdt_dropdown_value
  MODIFY list_key ENUM('stage', 'health', 'priority', 'category', 'family', 'project_type') NOT NULL;

SET @stmt = (SELECT IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pdt_dropdown_value' AND COLUMN_NAME = 'description'),
  'DO 0', 'ALTER TABLE pdt_dropdown_value ADD COLUMN description VARCHAR(500) NULL AFTER label'));
PREPARE st FROM @stmt; EXECUTE st; DEALLOCATE PREPARE st;

INSERT IGNORE INTO pdt_dropdown_value (list_key, code, label, description, color, sort_order) VALUES
  ('family', NULL, 'Tile Fixing', 'Reliable solutions for fixing and finishing tiles on walls and floors, delivering strong adhesion and long-lasting performance.', '#5b7fd6', 1),
  ('family', NULL, 'Waterproofing', 'Protection systems that prevent water leakage and moisture damage in wet areas, roofs, foundations, and exposed structures.', '#3fa3c4', 2),
  ('family', NULL, 'Masonry & Repair Mortar', 'Products for masonry works, repairs, and structural strengthening used in construction and rehabilitation projects.', '#a07a52', 3),
  ('family', NULL, 'Flooring', 'Solutions for leveling, preparing, and protecting floors for residential, commercial, and industrial applications.', '#5bb79a', 4),
  ('family', NULL, 'Renders', 'Wall finishing products for leveling and protecting internal and external walls before painting or façade finishes.', '#c4892f', 5),
  ('family', NULL, 'Putties & Skimming', 'Finishing materials that create smooth, paint-ready walls and ceilings with a high-quality appearance.', '#b58ad6', 6),
  ('family', NULL, 'Special Paints & Primer', 'Surface preparation and coating solutions that improve adhesion and provide durable decorative and protective finishes.', '#d07a9a', 7),
  ('family', NULL, 'Specialty Construction Chemicals', 'Specialized chemical products for bonding, sealing, and technical construction applications.', '#8a94a6', 8),
  ('project_type', 'PLANNED', 'Planned', NULL, '#8a94a6', 1),
  ('project_type', 'UNPLANNED', 'Unplanned', NULL, '#8a94a6', 2),
  ('project_type', 'INNOVATION', 'Innovation', NULL, '#8a94a6', 3),
  ('project_type', 'REFORMULATION', 'Reformulation', NULL, '#8a94a6', 4);

-- Family replaces Category (0080's skincare examples).
UPDATE pdt_dropdown_value SET is_active = 0 WHERE list_key = 'category';

-- ---------------------------------------------------------------------------------------------------------------------
-- Products
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE pdt_product
  MODIFY code VARCHAR(20) NULL,
  MODIFY category_id INT NULL,
  MODIFY owner_name VARCHAR(150) NULL,
  MODIFY priority_id INT NULL,
  MODIFY health_id INT NULL,
  MODIFY readiness_pct TINYINT UNSIGNED NULL;

SET @stmt = (SELECT IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pdt_product' AND COLUMN_NAME = 'family_id'),
  'DO 0',
  'ALTER TABLE pdt_product
     ADD COLUMN family_id INT NULL AFTER name,
     ADD COLUMN subfamily VARCHAR(100) NULL AFTER family_id,
     ADD COLUMN project_type_id INT NULL AFTER actual_launch,
     ADD COLUMN next_step VARCHAR(300) NULL AFTER notes,
     ADD COLUMN next_step_due DATE NULL AFTER next_step,
     ADD COLUMN comment TEXT NULL AFTER next_step_due,
     ADD COLUMN updated_by_name VARCHAR(150) NULL AFTER comment,
     ADD COLUMN last_edited_on DATE NULL AFTER updated_by_name,
     ADD INDEX idx_pdt_product_family (family_id),
     ADD CONSTRAINT fk_pdt_product_family FOREIGN KEY (family_id) REFERENCES pdt_dropdown_value(value_id),
     ADD CONSTRAINT fk_pdt_product_project_type FOREIGN KEY (project_type_id) REFERENCES pdt_dropdown_value(value_id)'));
PREPARE st FROM @stmt; EXECUTE st; DEALLOCATE PREPARE st;

-- ---------------------------------------------------------------------------------------------------------------------
-- Status updates
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE pdt_status_update
  MODIFY health_id INT NULL,
  MODIFY readiness_pct TINYINT UNSIGNED NULL;

SET @stmt = (SELECT IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pdt_status_update' AND COLUMN_NAME = 'updated_by_name'),
  'DO 0', 'ALTER TABLE pdt_status_update ADD COLUMN updated_by_name VARCHAR(150) NULL AFTER next_step_done_at'));
PREPARE st FROM @stmt; EXECUTE st; DEALLOCATE PREPARE st;

-- ---------------------------------------------------------------------------------------------------------------------
-- Blockers & decisions
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE pdt_blocker MODIFY owner_name VARCHAR(150) NULL;

SET @stmt = (SELECT IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pdt_blocker' AND COLUMN_NAME = 'external_id'),
  'DO 0',
  'ALTER TABLE pdt_blocker
     ADD COLUMN external_id VARCHAR(20) NULL AFTER blocker_id,
     ADD COLUMN raised_on DATE NULL AFTER owner_name,
     ADD UNIQUE KEY uq_pdt_blocker_external (external_id)'));
PREPARE st FROM @stmt; EXECUTE st; DEALLOCATE PREPARE st;

-- ---------------------------------------------------------------------------------------------------------------------
-- Import history
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pdt_import_log (
    import_id       INT AUTO_INCREMENT PRIMARY KEY,
    file_name       VARCHAR(255) NOT NULL,
    file_sha256     CHAR(64) NOT NULL,
    imported_by     INT NULL,
    imported_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    counts          JSON NOT NULL,
    missing_codes   JSON NULL,
    INDEX idx_pdt_import_at (imported_at),
    FOREIGN KEY (imported_by) REFERENCES app_user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
