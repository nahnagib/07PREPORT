-- Reverses 0047_process_nps_level_labels.sql: the labels of 0046 again. Roll the ETL back first (nps.py upserts the
-- labels on every run).

SET NAMES utf8mb4;

UPDATE dim_process_nps_level SET label_en = 'Exceeded expectations', label_ar = 'فاقت التوقعات', updated_at_utc = UTC_TIMESTAMP() WHERE nps_level = 3;
UPDATE dim_process_nps_level SET label_en = 'Met expectations', label_ar = 'في مستوى التوقعات', updated_at_utc = UTC_TIMESTAMP() WHERE nps_level = 2;
UPDATE dim_process_nps_level SET label_en = 'Below expectations', label_ar = 'أقل من المتوقع', updated_at_utc = UTC_TIMESTAMP() WHERE nps_level = 1;
