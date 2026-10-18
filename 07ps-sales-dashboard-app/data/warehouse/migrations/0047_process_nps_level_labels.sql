-- 0047: NPS Score -- the three rating levels are shown on the standard NPS scale (decision of 2026-10-18, step 2).
-- The customer answers with stars; the levels keep their keys (nps_level 1 / 2 / 3, level_key below / met / exceeded,
-- source_text) and change their LABELS only:
--   nps_level 3  ***  فاقت التوقعات       Promoters   المروجون     (standard NPS score 9-10)
--   nps_level 2  **   في مستوى التوقعات   Passives    المحايدون    (7-8)
--   nps_level 1  *    أقل من المتوقع      Detractors  المنتقدون    (0-6)
-- departments/process/nps.py carries the same labels (the ETL upserts this dimension on every run).
-- Requires 0046. Idempotent. Reverse: data/warehouse/down/0047_process_nps_level_labels_down.sql.

SET NAMES utf8mb4;

UPDATE dim_process_nps_level SET label_en = 'Promoters', label_ar = 'المروجون', updated_at_utc = UTC_TIMESTAMP() WHERE nps_level = 3;
UPDATE dim_process_nps_level SET label_en = 'Passives', label_ar = 'المحايدون', updated_at_utc = UTC_TIMESTAMP() WHERE nps_level = 2;
UPDATE dim_process_nps_level SET label_en = 'Detractors', label_ar = 'المنتقدون', updated_at_utc = UTC_TIMESTAMP() WHERE nps_level = 1;
