-- Reverses 0046_process_nps.sql: drops the NPS Score views, facts, level dimension and raw copies, and forgets the
-- process_nps datasets. Roll the backend and ETL images back first (they read and write these tables). The source
-- database is not touched; re-applying 0046 and running process_nps reloads everything from it.

SET NAMES utf8mb4;

DROP VIEW IF EXISTS v_process_nps_low_rating;
DROP VIEW IF EXISTS v_process_nps_trend;
DROP VIEW IF EXISTS v_process_nps_summary;
DROP VIEW IF EXISTS v_process_nps_comment;
DROP VIEW IF EXISTS v_process_nps_response;
DROP TABLE IF EXISTS fact_process_nps_comment;
DROP TABLE IF EXISTS fact_process_nps_response;
DROP TABLE IF EXISTS dim_process_nps_level;
DROP TABLE IF EXISTS raw_nps_sync_state;
DROP TABLE IF EXISTS raw_nps_low_rating;
DROP TABLE IF EXISTS raw_nps_rating;
DELETE FROM etl_dataset_registry WHERE dataset IN ('raw_nps_rating', 'raw_nps_low_rating', 'raw_nps_sync_state',
  'dim_process_nps_level', 'fact_process_nps_response', 'fact_process_nps_comment');
