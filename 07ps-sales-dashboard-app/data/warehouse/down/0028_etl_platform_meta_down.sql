-- Reverses 0028_etl_platform_meta.sql. Idempotent.
-- Drops the platform meta tables and the three etl_run_log columns 0028 added. etl_run_log itself (0022) and
-- every row in it stay; rows written by the platform keep their status/timestamps, so "Last Refresh" is
-- unaffected by the rollback.

SET NAMES utf8mb4;

DROP TABLE IF EXISTS etl_dataset_registry;
DROP TABLE IF EXISTS etl_watermark;
DROP TABLE IF EXISTS etl_dq_result;
DROP TABLE IF EXISTS etl_task_log;

SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE etl_run_log DROP INDEX idx_etl_run_log_job_status_finished', 'DO 0')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'etl_run_log' AND INDEX_NAME = 'idx_etl_run_log_job_status_finished');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE etl_run_log DROP INDEX idx_etl_run_log_dept_status_finished', 'DO 0')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'etl_run_log' AND INDEX_NAME = 'idx_etl_run_log_dept_status_finished');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE etl_run_log DROP COLUMN parent_run_uid', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'etl_run_log' AND COLUMN_NAME = 'parent_run_uid');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE etl_run_log DROP COLUMN department', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'etl_run_log' AND COLUMN_NAME = 'department');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE etl_run_log DROP COLUMN job_name', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'etl_run_log' AND COLUMN_NAME = 'job_name');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
