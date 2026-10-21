-- A successful empty message load must be distinguishable from a source that has never existed.
-- Updated in the same transaction as the message fact; failed/skipped loads preserve the last snapshot.
CREATE TABLE IF NOT EXISTS process_nps_reach_state (
    singleton_id SMALLINT NOT NULL PRIMARY KEY,
    loaded_at_utc DATETIME NOT NULL,
    messages_loaded BIGINT NOT NULL,
    _run_id CHAR(36) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
