-- 0032: Odoo's own display labels for selection fields (core, every department).
--
-- Rule (docs/adding-a-department.md, "Odoo labels"): labels of Odoo selection fields (move_type, payment_type,
-- partner_type, payment_state, state, delivery_status, ...) are never written in code. core_dims reads them with
-- fields_get(attributes=["string", "selection"]) in en_US and, when an Arabic language is active in res.lang, in
-- Arabic, and replaces this table. Facts store the technical value; views join here for label_en / label_ar.
-- Which fields: core/labels.py SELECTION_FIELDS. Idempotent. Reverse: data/warehouse/down/0032_core_odoo_labels_down.sql.

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS dim_odoo_selection_label (
    model VARCHAR(64) NOT NULL COMMENT 'Odoo model, e.g. account.move',
    field VARCHAR(64) NOT NULL COMMENT 'selection field, e.g. move_type',
    value VARCHAR(64) NOT NULL COMMENT 'technical value stored in facts and dimensions',
    label_en VARCHAR(255) NULL COMMENT 'Odoo label in en_US',
    label_ar VARCHAR(255) NULL COMMENT 'Odoo label in the active Arabic language; NULL when Arabic is not active',
    field_label_en VARCHAR(255) NULL,
    field_label_ar VARCHAR(255) NULL,
    sequence INT NOT NULL DEFAULT 0 COMMENT 'order of the value in Odoo',
    label_language_ar VARCHAR(16) NULL COMMENT 'the Arabic language code the labels were read in, e.g. ar_001',
    updated_at_utc DATETIME NOT NULL,
    PRIMARY KEY (model, field, value)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
