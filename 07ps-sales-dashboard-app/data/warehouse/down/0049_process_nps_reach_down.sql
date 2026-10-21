-- Reverses 0049_process_nps_reach.sql: drops the message reach views, fact, error-group dimension and raw copy, and
-- forgets their datasets. Roll the backend and ETL back first. The source table is not touched.

SET NAMES utf8mb4;

DROP VIEW IF EXISTS v_process_nps_message_error;
DROP VIEW IF EXISTS v_process_nps_reach;
DROP TABLE IF EXISTS fact_process_nps_message;
DROP TABLE IF EXISTS dim_process_nps_failure_group;
DROP TABLE IF EXISTS raw_nps_whatsapp_message;
DELETE FROM etl_dataset_registry WHERE dataset IN ('raw_nps_whatsapp_message', 'dim_process_nps_failure_group', 'fact_process_nps_message');
