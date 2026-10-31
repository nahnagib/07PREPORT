CREATE TABLE IF NOT EXISTS dashboard_setting (
  setting_key VARCHAR(80) PRIMARY KEY,
  numeric_value DECIMAL(18,2) NOT NULL,
  updated_by BIGINT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
INSERT IGNORE INTO dashboard_setting(setting_key,numeric_value) VALUES ('daily_critical_number',560000);
