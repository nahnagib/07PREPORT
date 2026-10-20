-- Reverses 0053_process_nps_picking.sql: restores the 0046 v_process_nps_response and drops
-- fact_process_nps_response.PickingID. Roll the backend and ETL back first (both read / write the column).

SET NAMES utf8mb4;

CREATE OR REPLACE VIEW v_process_nps_response AS
SELECT f.response_id, f.delivery_code, f.order_ref, f.rated_at_utc, f.rated_at_local, f.RatingDateKey,
       DATE(f.rated_at_local) AS rating_date, f.DeliveryDateKey,
       CASE WHEN f.DeliveryDateKey > 0 THEN STR_TO_DATE(CAST(f.DeliveryDateKey AS CHAR), '%Y%m%d') END AS delivery_date,
       f.CompanyKey, c.Company AS company, f.company_source, f.CustomerKey, cu.customer, f.SalespersonKey, sp.salesperson,
       f.SalesTeamKey, st.SalesTeam AS sales_team, f.SegmentKey, sg.Segment AS segment, f.ChannelKey, f.SalesOrderKey,
       f.nps_level, l.level_key, l.label_en, l.label_ar,
       CASE WHEN f.nps_level = 3 THEN 1 ELSE 0 END AS is_exceeded,
       CASE WHEN f.nps_level = 2 THEN 1 ELSE 0 END AS is_met,
       CASE WHEN f.nps_level = 1 THEN 1 ELSE 0 END AS is_below,
       f.is_low_rating, f.in_low_rating_table, f.team_branch, f.has_comment
FROM fact_process_nps_response f
JOIN dim_process_nps_level l ON l.nps_level = f.nps_level
LEFT JOIN dim_company c ON c.CompanyKey = f.CompanyKey
LEFT JOIN dim_customer cu ON cu.CustomerKey = f.CustomerKey
LEFT JOIN dim_salesperson sp ON sp.SalespersonKey = f.SalespersonKey
LEFT JOIN dim_sales_team st ON st.SalesTeamKey = f.SalesTeamKey
LEFT JOIN dim_segment sg ON sg.SegmentKey = f.SegmentKey;

SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE fact_process_nps_response DROP COLUMN PickingID', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_process_nps_response' AND COLUMN_NAME = 'PickingID');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
