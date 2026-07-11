-- Minimal RBAC scaffold - Standards Section 5.2. Schema only, no auth logic (hashing, sessions,
-- JWT issuance, etc.) - that's Phase P2 API work, deferred per this session's scope and the
-- open RLS-mechanism question (see docs/tech-stack-decision.md: MySQL has no native
-- Row-Level-Security like the Postgres approach this schema replaces, so the actual enforcement
-- mechanism is designed when the API layer is (re)built for MySQL, not guessed here).

SET NAMES utf8mb4;

CREATE TABLE role_tier (
    role_code            VARCHAR(30) PRIMARY KEY,
    role_label             VARCHAR(60) NOT NULL,
    scope_description        VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO role_tier (role_code, role_label, scope_description) VALUES
    ('BI00_EXECUTIVE',    'Executive (BI 00)',        'All departments, all companies, ExCo dashboard'),
    ('BI01_DIRECTOR_B2B', 'Director (BI 01)',          'Sales-related dashboards scoped to B2B channel'),
    ('BI02_DIRECTOR_B2C', 'Director (BI 02)',           'Sales-related dashboards scoped to B2C channel'),
    ('BI03_COMPANY_EXEC', 'Company Executive (BI 03)',   'All dashboards scoped to a single company'),
    ('DEPARTMENT_HEAD',   'Department Head',              'Their own department dashboard only'),
    ('SALESPERSON',       'Individual Contributor',         'Own data only, all other filters locked');

CREATE TABLE dashboard (
    dashboard_code       VARCHAR(30) PRIMARY KEY,
    dashboard_name          VARCHAR(100) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO dashboard (dashboard_code, dashboard_name) VALUES ('SALES', 'BMH – Sales Dashboard');

CREATE TABLE role_dashboard_access (
    role_code            VARCHAR(30) NOT NULL,
    dashboard_code          VARCHAR(30) NOT NULL,
    allowed                    BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY (role_code, dashboard_code),
    FOREIGN KEY (role_code) REFERENCES role_tier(role_code),
    FOREIGN KEY (dashboard_code) REFERENCES dashboard(dashboard_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO role_dashboard_access (role_code, dashboard_code, allowed)
SELECT role_code, 'SALES', TRUE FROM role_tier;

CREATE TABLE app_user (
    user_id               INT AUTO_INCREMENT PRIMARY KEY,
    email                    VARCHAR(255) NOT NULL UNIQUE,
    display_name               VARCHAR(150) NOT NULL,
    company_scope                 ENUM('ALL', 'MAJAAL', 'TIKA') NOT NULL DEFAULT 'ALL',
    -- Standards Section 4.10 / 5.2: a Salesperson user is scoped to exactly one salesperson_key;
    -- NULL for every other role tier.
    salesperson_key                 INT NULL,
    is_active                         BOOLEAN NOT NULL DEFAULT TRUE,
    created_at                          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (salesperson_key) REFERENCES dim_salesperson(salesperson_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Many-to-many: a user can hold more than one role tier (e.g. a Department Head who is also
-- given BI03 company-wide visibility) without changing this schema.
CREATE TABLE user_role (
    user_id               INT NOT NULL,
    role_code                VARCHAR(30) NOT NULL,
    PRIMARY KEY (user_id, role_code),
    FOREIGN KEY (user_id) REFERENCES app_user(user_id),
    FOREIGN KEY (role_code) REFERENCES role_tier(role_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
