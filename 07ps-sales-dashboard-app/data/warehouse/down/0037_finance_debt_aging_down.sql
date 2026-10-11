-- Reverses 0037_finance_debt_aging.sql: drops the Aging Map settings. No snapshot or dimension row is touched; the
-- Debt Report's /aging endpoint fails until 0037 is applied again (every other Debt Report endpoint keeps working).

DROP TABLE IF EXISTS cfg_finance_aging_setting;
DROP TABLE IF EXISTS cfg_finance_aging_zone;
DROP TABLE IF EXISTS cfg_finance_payment_term_days;
