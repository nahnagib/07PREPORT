-- Sample seed data for local development, pending real Odoo/Excel access from a server
-- environment (see tech-stack-decision.md Section 4). Deliberately small and obviously
-- fake so nobody mistakes it for a real reconciliation baseline.

INSERT INTO dim_business_unit (business_unit_code, business_unit_name) VALUES
    ('MAJAAL', 'Majaal - Ceramics Manufacturing'),
    ('TIKA', 'Tika - Chemical Solutions');

INSERT INTO dim_branch (branch_code, branch_name, region, business_unit_code) VALUES
    ('TRP-01', 'Tripoli Showroom', 'West', 'MAJAAL'),
    ('BEN-01', 'Benghazi Showroom', 'East', 'MAJAAL'),
    ('TRP-02', 'Tripoli Plant', 'West', 'TIKA');

INSERT INTO dim_employee (employee_code, employee_name, role_tier, is_salesperson, branch_code, business_unit_code) VALUES
    ('EMP-001', 'Sample Salesperson A', 'SALESPERSON', TRUE, 'TRP-01', 'MAJAAL'),
    ('EMP-002', 'Sample Salesperson B', 'SALESPERSON', TRUE, 'BEN-01', 'MAJAAL'),
    ('EMP-010', 'Sample Sales Director', 'BI01_DIRECTOR_B2B', FALSE, NULL, 'MAJAAL');

INSERT INTO dim_product (sku, product_name, business_unit_code, category) VALUES
    ('MJ-TILE-001', 'Porcelain Tile 60x60', 'MAJAAL', 'Tiles'),
    ('TK-CHEM-001', 'Industrial Adhesive 20L', 'TIKA', 'Adhesives');

INSERT INTO dim_customer (customer_code, customer_name, customer_group, distribution_channel, branch_code, business_unit_code) VALUES
    ('CUST-001', 'Sample Contractor LLC', 'Contractors', 'B2B', 'TRP-01', 'MAJAAL'),
    ('CUST-002', 'Sample Retail Client', 'Retail', 'B2C', 'BEN-01', 'MAJAAL');

-- A small date range covering "today" for local testing.
INSERT INTO dim_date (date_key, calendar_date, year, month, month_name, day, day_of_week, fiscal_year, is_month_end)
SELECT
    TO_CHAR(d, 'YYYYMMDD')::INT,
    d,
    EXTRACT(YEAR FROM d)::SMALLINT,
    EXTRACT(MONTH FROM d)::SMALLINT,
    TO_CHAR(d, 'Month'),
    EXTRACT(DAY FROM d)::SMALLINT,
    EXTRACT(ISODOW FROM d)::SMALLINT,
    EXTRACT(YEAR FROM d)::SMALLINT,
    (d = (date_trunc('month', d) + interval '1 month - 1 day'))
FROM generate_series(DATE '2026-01-01', DATE '2026-12-31', INTERVAL '1 day') AS d;

INSERT INTO dim_calendar_flags (date_key, is_working_day, is_holiday, is_forced_closure, business_unit_code, note)
SELECT date_key,
       EXTRACT(ISODOW FROM calendar_date) NOT IN (5, 6), -- Fri/Sat weekend example - confirm actual BMH weekly rest days
       FALSE, FALSE, NULL, NULL
FROM dim_date;

INSERT INTO fact_sales (date_key, customer_id, product_id, employee_id, branch_code, business_unit_code, value, volume)
SELECT 20260101 + n, 1, 1, 1, 'TRP-01', 'MAJAAL', 1000 + n * 25, 40 + n
FROM generate_series(0, 30) AS n;

INSERT INTO fact_target_plan (date_key, business_unit_code, branch_code, employee_id, target_grain, target_value, target_volume, source_file)
VALUES (20260101, 'MAJAAL', 'TRP-01', 1, 'ANNUAL', 500000, 20000, 'sample_targets_2026.xlsx');

INSERT INTO refresh_log (source, started_at, finished_at, row_count, status)
VALUES ('odoo', now() - interval '20 minutes', now() - interval '15 minutes', 31, 'SUCCESS');
