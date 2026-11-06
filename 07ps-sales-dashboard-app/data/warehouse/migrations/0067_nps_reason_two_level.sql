-- 0067: NPS detractor follow-up -- reasons become two levels, CATEGORY -> SUB-REASON (2026-11-06; docs/nps-followup.md,
-- "Stage, status and reasons").
--
--   dim_nps_reason  an APPLICATION table (the ETL never reloads it; managed on the follow-up's Reasons screen). One row
--                   per sub-reason, plus one row per category with sub_reason_en NULL: the "Not specified" row that
--                   migrated cases without a known sub-reason point to, and the only row of "Other" (requires_note =
--                   a short note is required, nps_followup_case.reason_note). reason_key is the stable key
--                   ('delivery.late'; a category row's key is its category_key). People pick a sub-reason (or Other);
--                   the category rows are never offered in the picker except Other.
--   nps_followup_case.reason_id now points to dim_nps_reason; the category is that row's category_key.
--   nps_followup_case.reason_note  the note an "Other" reason requires (VARCHAR 200).
--   nps_reason_legacy_map  old reason name -> new reason_key (decisions 2026-11-06), with the old id and the number of
--                   cases that used it when this migration ran (cases_before) -- the record of the move.
--
-- The old list nps_followup_reason (0052) is kept, unused and unchanged, until it is dropped by a later migration.
-- A case whose old reason is NOT in the map stops the migration (error "Unknown column
-- 'unmapped_legacy_reason_see_0067'") before anything is moved: add it to the map first, never guess.
--
-- Idempotent: the move runs only while the case's reason FK still points to nps_followup_reason. Requires 0052, 0066.
-- Reverse: down/0067_nps_reason_two_level_down.sql.

SET NAMES utf8mb4;

-- ---------------------------------------------------------------------------
-- 1. The two-level list.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dim_nps_reason (
    reason_id       BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    reason_key      VARCHAR(80) NOT NULL,
    category_key    VARCHAR(40) NOT NULL,
    category_en     VARCHAR(100) NOT NULL,
    category_ar     VARCHAR(100) NOT NULL,
    sub_reason_en   VARCHAR(100) NULL,
    sub_reason_ar   VARCHAR(100) NULL,
    category_sort   INT NOT NULL DEFAULT 0,
    sort_order      INT NOT NULL DEFAULT 0,
    requires_note   BOOLEAN NOT NULL DEFAULT FALSE,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_by      INT NULL,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by      INT NULL,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_dim_nps_reason_key (reason_key),
    INDEX idx_dim_nps_reason_category (category_key, sort_order),
    FOREIGN KEY (created_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Category rows (sub_reason NULL = "Not specified"; Other = the category itself, with a required note).
INSERT IGNORE INTO dim_nps_reason (reason_key, category_key, category_en, category_ar, sub_reason_en, sub_reason_ar, category_sort, sort_order, requires_note) VALUES
    ('quality', 'quality', 'Product Quality', 'جودة المنتج', NULL, NULL, 1, 0, FALSE),
    ('availability', 'availability', 'Product Availability', 'توفر المنتجات', NULL, NULL, 2, 0, FALSE),
    ('range', 'range', 'Product Range', 'تنوع المنتجات', NULL, NULL, 3, 0, FALSE),
    ('pricing', 'pricing', 'Pricing', 'الأسعار', NULL, NULL, 4, 0, FALSE),
    ('delivery', 'delivery', 'Delivery & Logistics', 'التوصيل والخدمات اللوجستية', NULL, NULL, 5, 0, FALSE),
    ('service', 'service', 'Customer Service', 'خدمة العملاء', NULL, NULL, 6, 0, FALSE),
    ('sales', 'sales', 'Sales Experience', 'تجربة البيع', NULL, NULL, 7, 0, FALSE),
    ('claims', 'claims', 'Claims & After-Sales', 'الشكاوى وخدمة ما بعد البيع', NULL, NULL, 8, 0, FALSE),
    ('technical', 'technical', 'Technical Support', 'الدعم الفني', NULL, NULL, 9, 0, FALSE),
    ('billing', 'billing', 'Billing & Payments', 'الفواتير والمدفوعات', NULL, NULL, 10, 0, FALSE),
    ('other', 'other', 'Other', 'أخرى', NULL, NULL, 11, 0, TRUE);

INSERT IGNORE INTO dim_nps_reason (reason_key, category_key, category_en, category_ar, sub_reason_en, sub_reason_ar, category_sort, sort_order) VALUES
    ('quality.defective', 'quality', 'Product Quality', 'جودة المنتج', 'Defective products', 'منتجات معيبة', 1, 1),
    ('quality.performance', 'quality', 'Product Quality', 'جودة المنتج', 'Poor performance', 'أداء ضعيف', 1, 2),
    ('quality.inconsistent', 'quality', 'Product Quality', 'جودة المنتج', 'Inconsistent quality', 'جودة غير ثابتة', 1, 3),
    ('availability.out_of_stock', 'availability', 'Product Availability', 'توفر المنتجات', 'Out-of-stock items', 'أصناف غير متوفرة في المخزون', 2, 1),
    ('availability.assortment', 'availability', 'Product Availability', 'توفر المنتجات', 'Limited assortment', 'تشكيلة محدودة', 2, 2),
    ('availability.discontinued', 'availability', 'Product Availability', 'توفر المنتجات', 'Discontinued products', 'منتجات متوقفة', 2, 3),
    ('range.brands', 'range', 'Product Range', 'تنوع المنتجات', 'Missing brands', 'علامات تجارية غير متوفرة', 3, 1),
    ('range.designs', 'range', 'Product Range', 'تنوع المنتجات', 'Missing designs', 'تصاميم غير متوفرة', 3, 2),
    ('range.sizes', 'range', 'Product Range', 'تنوع المنتجات', 'Missing sizes', 'مقاسات غير متوفرة', 3, 3),
    ('range.colors', 'range', 'Product Range', 'تنوع المنتجات', 'Missing colors', 'ألوان غير متوفرة', 3, 4),
    ('range.specifications', 'range', 'Product Range', 'تنوع المنتجات', 'Missing specifications', 'مواصفات غير متوفرة', 3, 5),
    ('pricing.high', 'pricing', 'Pricing', 'الأسعار', 'High prices', 'أسعار مرتفعة', 4, 1),
    ('pricing.uncompetitive', 'pricing', 'Pricing', 'الأسعار', 'Uncompetitive offers', 'عروض غير منافسة', 4, 2),
    ('pricing.discounts', 'pricing', 'Pricing', 'الأسعار', 'Unclear discounts', 'خصومات غير واضحة', 4, 3),
    ('delivery.late', 'delivery', 'Delivery & Logistics', 'التوصيل والخدمات اللوجستية', 'Late deliveries', 'تأخر التوصيل', 5, 1),
    ('delivery.damaged', 'delivery', 'Delivery & Logistics', 'التوصيل والخدمات اللوجستية', 'Damaged goods', 'بضائع تالفة', 5, 2),
    ('delivery.incomplete', 'delivery', 'Delivery & Logistics', 'التوصيل والخدمات اللوجستية', 'Incomplete deliveries', 'توصيل غير مكتمل', 5, 3),
    ('service.responsiveness', 'service', 'Customer Service', 'خدمة العملاء', 'Poor responsiveness', 'ضعف الاستجابة', 6, 1),
    ('service.unprofessional', 'service', 'Customer Service', 'خدمة العملاء', 'Unprofessional treatment', 'تعامل غير مهني', 6, 2),
    ('service.follow_up', 'service', 'Customer Service', 'خدمة العملاء', 'Lack of follow-up', 'غياب المتابعة', 6, 3),
    ('sales.incorrect_info', 'sales', 'Sales Experience', 'تجربة البيع', 'Incorrect information', 'معلومات غير صحيحة', 7, 1),
    ('sales.product_knowledge', 'sales', 'Sales Experience', 'تجربة البيع', 'Insufficient product knowledge', 'معرفة غير كافية بالمنتج', 7, 2),
    ('sales.misleading', 'sales', 'Sales Experience', 'تجربة البيع', 'Misleading commitments', 'التزامات مضللة', 7, 3),
    ('sales.displays', 'sales', 'Sales Experience', 'تجربة البيع', 'Poor product displays', 'عرض ضعيف للمنتجات', 7, 4),
    ('sales.samples', 'sales', 'Sales Experience', 'تجربة البيع', 'Limited samples', 'عينات محدودة', 7, 5),
    ('sales.assistance', 'sales', 'Sales Experience', 'تجربة البيع', 'Inadequate assistance', 'مساعدة غير كافية', 7, 6),
    ('claims.unresolved', 'claims', 'Claims & After-Sales', 'الشكاوى وخدمة ما بعد البيع', 'Unresolved complaints', 'شكاوى لم تُحل', 8, 1),
    ('claims.rejected', 'claims', 'Claims & After-Sales', 'الشكاوى وخدمة ما بعد البيع', 'Rejected claims', 'مطالبات مرفوضة', 8, 2),
    ('claims.slow', 'claims', 'Claims & After-Sales', 'الشكاوى وخدمة ما بعد البيع', 'Slow resolution', 'بطء المعالجة', 8, 3),
    ('technical.advice', 'technical', 'Technical Support', 'الدعم الفني', 'Insufficient technical advice', 'استشارة فنية غير كافية', 9, 1),
    ('technical.recommendations', 'technical', 'Technical Support', 'الدعم الفني', 'Incorrect recommendations', 'توصيات غير صحيحة', 9, 2),
    ('technical.delayed', 'technical', 'Technical Support', 'الدعم الفني', 'Delayed assistance', 'تأخر المساعدة', 9, 3),
    ('billing.invoice_errors', 'billing', 'Billing & Payments', 'الفواتير والمدفوعات', 'Invoice errors', 'أخطاء في الفواتير', 10, 1),
    ('billing.refund_delays', 'billing', 'Billing & Payments', 'الفواتير والمدفوعات', 'Refund delays', 'تأخر استرداد المبالغ', 10, 2),
    ('billing.payment_disputes', 'billing', 'Billing & Payments', 'الفواتير والمدفوعات', 'Payment disputes', 'خلافات على المدفوعات', 10, 3);

-- ---------------------------------------------------------------------------
-- 2. Old reason -> new reason (decisions 2026-11-06). Sub-reasons are never guessed: no sure sub-reason -> the
--    category's "Not specified" row.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nps_reason_legacy_map (
    legacy_name_en      VARCHAR(100) NOT NULL PRIMARY KEY,
    reason_key          VARCHAR(80) NOT NULL,
    legacy_reason_id    BIGINT NULL,
    cases_before        INT NULL,
    mapped_at           DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO nps_reason_legacy_map (legacy_name_en, reason_key) VALUES
    ('Late delivery', 'delivery.late'),
    ('Damaged product', 'delivery.damaged'),
    ('Wrong or missing item', 'delivery.incomplete'),
    ('Driver behaviour', 'delivery'),
    ('Product quality', 'quality'),
    ('Price or invoice issue', 'billing'),
    ('Customer service', 'service'),
    ('Other', 'other');

-- ---------------------------------------------------------------------------
-- 3. Move the cases (only while their FK still points to the old list).
-- ---------------------------------------------------------------------------
SET @old_fk = (SELECT COUNT(*) FROM information_schema.REFERENTIAL_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'nps_followup_case' AND REFERENCED_TABLE_NAME = 'nps_followup_reason');

-- stop when a case uses an old reason the map does not know (e.g. one added on the Reasons screen)
SET @unmapped = IF(@old_fk = 0, 0, (SELECT COUNT(*) FROM nps_followup_case c
    JOIN nps_followup_reason r ON r.reason_id = c.reason_id
    LEFT JOIN nps_reason_legacy_map m ON m.legacy_name_en = r.name_en
   WHERE m.legacy_name_en IS NULL));
SET @s = IF(@unmapped > 0, 'SELECT unmapped_legacy_reason_see_0067 FROM nps_followup_case', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

UPDATE nps_reason_legacy_map m
  LEFT JOIN nps_followup_reason r ON r.name_en = m.legacy_name_en
   SET m.legacy_reason_id = r.reason_id,
       m.cases_before = (SELECT COUNT(*) FROM nps_followup_case c WHERE c.reason_id = r.reason_id),
       m.mapped_at = UTC_TIMESTAMP()
 WHERE @old_fk > 0;

SET @s = IF(@old_fk > 0, 'ALTER TABLE nps_followup_case DROP FOREIGN KEY fk_nps_followup_case_reason', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- old ids and new ids overlap (both start at 1): take the case -> new id pairs first, then set them by case_id
DROP TEMPORARY TABLE IF EXISTS tmp_nps_reason_move;
CREATE TEMPORARY TABLE tmp_nps_reason_move AS
  SELECT c.case_id, d.reason_id AS new_reason_id
    FROM nps_followup_case c
    JOIN nps_reason_legacy_map m ON m.legacy_reason_id = c.reason_id
    JOIN dim_nps_reason d ON d.reason_key = m.reason_key
   WHERE @old_fk > 0;
UPDATE nps_followup_case c JOIN tmp_nps_reason_move t ON t.case_id = c.case_id SET c.reason_id = t.new_reason_id;
DROP TEMPORARY TABLE tmp_nps_reason_move;

SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE nps_followup_case ADD CONSTRAINT fk_nps_followup_case_reason_dim FOREIGN KEY (reason_id) REFERENCES dim_nps_reason(reason_id)', 'DO 0')
  FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'nps_followup_case' AND CONSTRAINT_NAME = 'fk_nps_followup_case_reason_dim');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ---------------------------------------------------------------------------
-- 4. The note an "Other" reason requires.
-- ---------------------------------------------------------------------------
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE nps_followup_case ADD COLUMN reason_note VARCHAR(200) NULL AFTER reason_id', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nps_followup_case' AND COLUMN_NAME = 'reason_note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
