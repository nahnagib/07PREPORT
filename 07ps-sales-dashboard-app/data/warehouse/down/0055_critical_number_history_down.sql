-- Reverses 0055_critical_number_history.sql: drops critical_number_history.
--
-- Every value an admin entered is lost; the backend then falls back to LYD 560,000 for every day (with an error in the
-- log). Export the table first if its history matters.

SET NAMES utf8mb4;

DROP TABLE IF EXISTS critical_number_history;
