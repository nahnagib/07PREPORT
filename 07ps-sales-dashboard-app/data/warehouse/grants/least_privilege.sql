-- Least-privilege MySQL accounts for the 07ps stack (docs/DEPLOYMENT.md section 4).
-- TEMPLATE: replace every CHANGE_ME_* placeholder before running; never commit real passwords.
-- Run once as a DB administrator. `ps_warehouse` = your DB_NAME. Restrict '%' to the app host's
-- address (or the Docker network's gateway) wherever your network allows it.

-- 1) Application (backend + etl-worker): reads the warehouse, writes app tables (auth, admin, ETL job
--    tracking, MARCOM). Cannot create/drop tables and cannot modify the pipeline's fact/dimension tables.
CREATE USER IF NOT EXISTS 'ps_app'@'%' IDENTIFIED BY 'CHANGE_ME_APP_PASSWORD';
GRANT SELECT ON ps_warehouse.* TO 'ps_app'@'%';
GRANT INSERT, UPDATE, DELETE ON ps_warehouse.app_user       TO 'ps_app'@'%';
GRANT INSERT, UPDATE, DELETE ON ps_warehouse.revoked_tokens TO 'ps_app'@'%';
GRANT INSERT, UPDATE, DELETE ON ps_warehouse.etl_job_runs   TO 'ps_app'@'%';
-- The remaining app-owned tables (roles, role_permissions, login history, admin_* / *_admin_profile,
-- holidays/closures, MARCOM staging/data, critical-number allocation, ...) need the same
-- INSERT/UPDATE/DELETE grant. List them with:
--   SELECT table_name FROM information_schema.tables WHERE table_schema = 'ps_warehouse'
--     AND table_name NOT LIKE 'Fact\_%' AND table_name NOT LIKE 'Dim\_%'
--     AND table_name NOT LIKE 'raw\_%' AND table_name NOT LIKE 'QA\_%';
-- and generate one GRANT per table from that output for your deployment.
-- The ETL Control Center's force-reset finds and kills the pipeline's stuck lock-holding connection
-- (etlRunTracker.releaseOrphanedPipelineLock): it reads performance_schema and issues KILL on a session
-- owned by ps_etl, which needs CONNECTION_ADMIN (MySQL 8). Optional: without them force-reset still
-- resets the queue/tracker state but cannot kill the lock holder.
GRANT SELECT ON performance_schema.* TO 'ps_app'@'%';
-- GRANT CONNECTION_ADMIN ON *.* TO 'ps_app'@'%';

-- 2) ETL (etl-api): rebuilds the tables it owns. drop_recreate loads run DROP/CREATE/TRUNCATE/ALTER/INDEX
--    on Fact_*, Dim_*, raw_*, QA_* and pipeline_* / etl_run_log; it only needs to READ the app tables.
CREATE USER IF NOT EXISTS 'ps_etl'@'%' IDENTIFIED BY 'CHANGE_ME_ETL_PASSWORD';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, INDEX, LOCK TABLES ON ps_warehouse.* TO 'ps_etl'@'%';
-- MySQL cannot grant per-table CREATE/DROP by pattern for tables that do not exist yet, so a schema-level
-- grant is the tightest that works with drop_recreate loads. Give the ETL its own schema if the warehouse
-- ever shares a server with unrelated data.

-- 3) Backups: read-only, consistent snapshot (scripts/backup_db.sh).
CREATE USER IF NOT EXISTS 'ps_backup'@'localhost' IDENTIFIED BY 'CHANGE_ME_BACKUP_PASSWORD';
GRANT SELECT, SHOW VIEW, TRIGGER, LOCK TABLES, EVENT ON ps_warehouse.* TO 'ps_backup'@'localhost';
GRANT PROCESS ON *.* TO 'ps_backup'@'localhost';

-- 4) Migrations: run by an administrator (or a dedicated 'ps_migrate' account with CREATE/ALTER/INDEX),
--    never by ps_app / ps_etl.
FLUSH PRIVILEGES;
