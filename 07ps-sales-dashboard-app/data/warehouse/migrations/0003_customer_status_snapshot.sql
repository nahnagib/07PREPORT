-- Entity-status/state history pattern (Standards Section 6.4) applied to Customer Status - the
-- exact split the task asked for: Dim_Customer (0001) keeps only static/slow-changing
-- attributes; every refresh-dependent computed value that source Dim_Customer had baked
-- directly into the "dimension" (LY/YTD/full-year value, active/blocked flags, CustomerStatus,
-- CustomerClass_LY, Last_Purchase_Date) lives here instead, one row per customer per snapshot.
--
-- The source export only contains ONE point-in-time snapshot per customer (computed as of the
-- export's refresh date) - not yet a real history. This table is shaped to accumulate one row
-- per customer per future refresh, so history starts accruing from the first real load onward.
--
-- Corrected finding: source CustomerStatus has SIX values (Active Retained, Non Active,
-- Reactivated, Blocked, Other, New), not the four documented in Standards Section 5.5's data
-- dictionary (Active Retained / Non-Active / Reactivated / Blocked). "Other" and "New" need to
-- be added to the data dictionary - see ../README.md.

SET NAMES utf8mb4;

CREATE TABLE fact_customer_status_snapshot (
    snapshot_date              DATE NOT NULL,
    customer_key                 INT NOT NULL,
    last_purchase_date             DATE NULL,
    ly_value                        DECIMAL(16, 2) NOT NULL DEFAULT 0,
    ytd_value                        DECIMAL(16, 2) NOT NULL DEFAULT 0,
    full_2023_value                    DECIMAL(16, 2) NULL,
    full_2024_value                    DECIMAL(16, 2) NULL,
    full_2025_value                    DECIMAL(16, 2) NULL,
    has_history_before_lytd              BOOLEAN NOT NULL DEFAULT FALSE,
    has_history_post_lytd_last_year        BOOLEAN NOT NULL DEFAULT FALSE,
    is_lytd                                  BOOLEAN NOT NULL DEFAULT FALSE,
    is_ytd                                    BOOLEAN NOT NULL DEFAULT FALSE,
    is_ly_full_year                            BOOLEAN NOT NULL DEFAULT FALSE,
    is_active_ytd                                BOOLEAN NOT NULL DEFAULT FALSE,
    is_blocked                                    BOOLEAN NOT NULL DEFAULT FALSE,
    blocked_date                                   DATE NULL,
    -- Added 2026-07-05: BlockedCustomers.xlsx (manual input, see ../README.md) carries these
    -- three fields alongside BlockedDate/IsBlocked; the source export's Dim_Customer snapshot
    -- only ever exposed IsBlocked/BlockedDate, so these were missing until the ingestion-layer
    -- session traced the manual-input mapping and found the gap.
    unblocked_date                                   DATE NULL,
    blocked_reason                                     VARCHAR(255) NULL,
    notes                                                 VARCHAR(500) NULL,
    customer_class_ly                                CHAR(1) NULL,
    -- Six known values as of this export: 'Active Retained', 'Non Active', 'Reactivated',
    -- 'Blocked', 'Other', 'New'. Not constrained to an ENUM so a 7th value doesn't break loads -
    -- validated against the data dictionary at the application layer instead.
    customer_status                                   VARCHAR(30) NOT NULL,
    PRIMARY KEY (snapshot_date, customer_key),
    FOREIGN KEY (customer_key) REFERENCES dim_customer(customer_key),
    INDEX idx_customer_status_snapshot_status (snapshot_date, customer_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
