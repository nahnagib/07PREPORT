-- Reverses 0029_core_dimensions.sql. Idempotent. Run only while the legacy sales pipeline code is redeployed.
--   1. abort if stored CompanyKey values are ambiguous (both 2 and 3 present)
--   2. stored key values back: Tika 3 -> 2, -1 -> legacy Unknown (salesperson 0, channel 1, segment 5)
--   3. drop the core tables 0029 created
--   4. rename zz_legacy_* back to their original names
-- Steps 2-4 only run while zz_legacy_dim_company exists (i.e. 0029 was applied and not yet reversed).

SET NAMES utf8mb4;

SET @applied = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'zz_legacy_dim_company');

SET @tika2 = (SELECT
      (SELECT COUNT(*) FROM admin_company WHERE etl_company_key = 2)
    + (SELECT COUNT(*) FROM salesperson_admin_profile WHERE company_key_override = 2)
    + (SELECT COUNT(*) FROM sales_team_admin_profile WHERE company_key_override = 2)
    + (SELECT COUNT(*) FROM role_data_scope WHERE dimension = 'companyKeys' AND value = '2'));
SET @tika3 = (SELECT
      (SELECT COUNT(*) FROM admin_company WHERE etl_company_key = 3)
    + (SELECT COUNT(*) FROM salesperson_admin_profile WHERE company_key_override = 3)
    + (SELECT COUNT(*) FROM sales_team_admin_profile WHERE company_key_override = 3)
    + (SELECT COUNT(*) FROM role_data_scope WHERE dimension = 'companyKeys' AND value = '3'));
SET @s = IF(@applied AND @tika2 > 0 AND @tika3 > 0,
    'SELECT * FROM `ABORT_0029_down__stored_CompanyKey_values_2_and_3_both_present__check_manually`', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- 2. stored key values
SET @s = IF(@applied, 'UPDATE admin_company SET etl_company_key = 2 WHERE etl_company_key = 3', 'DO 0'); PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = IF(@applied, 'UPDATE admin_company_history SET etl_company_key = 2 WHERE etl_company_key = 3', 'DO 0'); PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = IF(@applied, 'UPDATE salesperson_admin_profile SET company_key_override = 2 WHERE company_key_override = 3', 'DO 0'); PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = IF(@applied, 'UPDATE salesperson_admin_profile_history SET company_key_override = 2 WHERE company_key_override = 3', 'DO 0'); PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = IF(@applied, 'UPDATE sales_team_admin_profile SET company_key_override = 2 WHERE company_key_override = 3', 'DO 0'); PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = IF(@applied, 'UPDATE sales_team_admin_profile_history SET company_key_override = 2 WHERE company_key_override = 3', 'DO 0'); PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = IF(@applied, 'UPDATE role_data_scope SET value = ''2'' WHERE dimension = ''companyKeys'' AND value = ''3''', 'DO 0'); PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = IF(@applied, 'UPDATE app_user SET salesperson_key = 0 WHERE salesperson_key = -1', 'DO 0'); PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = IF(@applied, 'UPDATE salesperson_admin_profile SET channel_key_override = 1 WHERE channel_key_override = -1', 'DO 0'); PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = IF(@applied, 'UPDATE salesperson_admin_profile_history SET channel_key_override = 1 WHERE channel_key_override = -1', 'DO 0'); PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = IF(@applied, 'UPDATE salesperson_admin_profile SET segment_key_override = 5 WHERE segment_key_override = -1', 'DO 0'); PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = IF(@applied, 'UPDATE salesperson_admin_profile_history SET segment_key_override = 5 WHERE segment_key_override = -1', 'DO 0'); PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = IF(@applied, 'UPDATE sales_team_admin_profile SET segment_key_override = 5 WHERE segment_key_override = -1', 'DO 0'); PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = IF(@applied, 'UPDATE sales_team_admin_profile_history SET segment_key_override = 5 WHERE segment_key_override = -1', 'DO 0'); PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = IF(@applied, 'UPDATE role_data_scope SET value = CASE dimension WHEN ''channelKeys'' THEN ''1'' WHEN ''segmentKeys'' THEN ''5'' ELSE ''0'' END WHERE value = ''-1'' AND dimension IN (''channelKeys'', ''segmentKeys'', ''salespersonKeys'')', 'DO 0'); PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- 3. core tables (only when the legacy copies exist to take their place)
SET @s = IF(@applied, 'DROP TABLE IF EXISTS dim_company, dim_currency, dim_payment_term, dim_customer, map_partner_customer, dim_customer_company, dim_channel, dim_segment, dim_sales_team, dim_salesperson, map_odoo_user_salesperson, dim_date, dim_offday, dim_product, dim_product_master, map_product_master', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
DROP TABLE IF EXISTS raw_odoo_res_company, raw_odoo_res_currency, raw_odoo_res_partner, raw_odoo_res_partner_company, raw_odoo_res_users,
    raw_odoo_product_product, raw_odoo_account_payment_term, raw_odoo_account_payment_term_line,
    raw_excel_salesperson, raw_excel_sales_team, raw_excel_odoo_users, raw_excel_channel, raw_excel_segment,
    raw_excel_products, raw_excel_offdays, raw_excel_blocked_customers;

-- 4. legacy names back
SET @s = (SELECT IF(COUNT(*) = 1, 'RENAME TABLE zz_legacy_dim_company TO dim_company', 'DO 0') FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'zz_legacy_dim_company'); PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) = 1, 'RENAME TABLE zz_legacy_dim_customer TO dim_customer', 'DO 0') FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'zz_legacy_dim_customer'); PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) = 1, 'RENAME TABLE zz_legacy_dim_salesperson TO dim_salesperson', 'DO 0') FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'zz_legacy_dim_salesperson'); PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) = 1, 'RENAME TABLE zz_legacy_dim_salesteam TO dim_salesteam', 'DO 0') FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'zz_legacy_dim_salesteam'); PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) = 1, 'RENAME TABLE zz_legacy_dim_distributionchannel TO dim_distributionchannel', 'DO 0') FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'zz_legacy_dim_distributionchannel'); PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) = 1, 'RENAME TABLE zz_legacy_dim_segment TO dim_segment', 'DO 0') FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'zz_legacy_dim_segment'); PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) = 1, 'RENAME TABLE zz_legacy_dim_date TO dim_date', 'DO 0') FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'zz_legacy_dim_date'); PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) = 1, 'RENAME TABLE zz_legacy_dim_product TO dim_product', 'DO 0') FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'zz_legacy_dim_product'); PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) = 1, 'RENAME TABLE zz_legacy_fact_offdays TO fact_offdays', 'DO 0') FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'zz_legacy_fact_offdays'); PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
