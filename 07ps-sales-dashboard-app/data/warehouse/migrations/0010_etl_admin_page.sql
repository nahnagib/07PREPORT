-- Adds the read-only "ETL Runs" admin page (part of integrating the Odoo ETL pipeline into the
-- web app -- backend/src/etl/) to the existing pages/permissions/role_permissions model from
-- 0009_auth_identity.sql. No new tables: this page reads pipeline_run_log/pipeline_run_audit
-- directly (already populated by the vendored ETL pipeline), it doesn't need its own schema.

SET NAMES utf8mb4;

INSERT IGNORE INTO pages (page_key, page_label, nav_group, sort_order) VALUES
    ('admin_etl', 'ETL Runs', 'Administration', 13);

INSERT IGNORE INTO permissions (page_id, action)
SELECT page_id, 'view' FROM pages WHERE page_key = 'admin_etl'
UNION ALL
SELECT page_id, 'export' FROM pages WHERE page_key = 'admin_etl';

-- Same default as every other Administration page: only Admin gets it out of the box, everyone
-- else can be granted it later via Role & Permission Management without a code/schema change.
INSERT IGNORE INTO role_permissions (role_id, permission_id, allowed)
SELECT r.role_id, p.permission_id, TRUE
FROM roles r
JOIN permissions p ON TRUE
JOIN pages pg ON pg.page_id = p.page_id
WHERE r.role_name = 'ADMIN' AND pg.page_key = 'admin_etl';
