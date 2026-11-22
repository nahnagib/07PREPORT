-- Reverses 0080_pdt_schema.sql: drops the Product Development Plan tracker tables (pdt_*) and their data.
-- The TIKA gate module (pdp_*, 0075-0077) and the permission pages are not touched.
-- Roll the backend back first, or the dashboard and entry screens will answer 500 on the missing tables.

SET NAMES utf8mb4;

DROP TABLE IF EXISTS pdt_blocker;
DROP TABLE IF EXISTS pdt_status_update;
DROP TABLE IF EXISTS pdt_stage_history;
DROP TABLE IF EXISTS pdt_product;
DROP TABLE IF EXISTS pdt_setting;
DROP TABLE IF EXISTS pdt_dropdown_value;
