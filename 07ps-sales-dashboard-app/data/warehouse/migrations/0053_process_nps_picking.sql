-- 0053: NPS Score -- the Odoo picking of each rating (docs/nps-etl.md, "Odoo links"; NPS page round 4).
--
--   fact_process_nps_response.PickingID   the Odoo stock.picking id of the matched delivery: the same name match the
--                                         company rule uses (delivery_code = fact_sales_deliveries.DeliveryReference,
--                                         narrowed by the customer, then by the company name), -1 when no single
--                                         picking matches. The NPS page and the follow-up case card link the delivery
--                                         code to that picking in Odoo; SalesOrderKey (already stored) links the order.
--   v_process_nps_response                recreated with PickingID (otherwise unchanged from 0046).
--
-- Requires 0046. Idempotent. The next process_nps run fills the column (full reload). Reverse:
-- data/warehouse/down/0053_process_nps_picking_down.sql.

SET NAMES utf8mb4;

SET @s = (SELECT IF(COUNT(*) = 0,
    'ALTER TABLE fact_process_nps_response ADD COLUMN PickingID BIGINT NOT NULL DEFAULT -1 COMMENT ''Odoo stock.picking id of the matched delivery; -1 no single match'' AFTER SalesOrderKey',
    'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_process_nps_response' AND COLUMN_NAME = 'PickingID');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

CREATE OR REPLACE VIEW v_process_nps_response AS
SELECT f.response_id, f.delivery_code, f.order_ref, f.rated_at_utc, f.rated_at_local, f.RatingDateKey,
       DATE(f.rated_at_local) AS rating_date, f.DeliveryDateKey,
       CASE WHEN f.DeliveryDateKey > 0 THEN STR_TO_DATE(CAST(f.DeliveryDateKey AS CHAR), '%Y%m%d') END AS delivery_date,
       f.CompanyKey, c.Company AS company, f.company_source, f.CustomerKey, cu.customer, f.SalespersonKey, sp.salesperson,
       f.SalesTeamKey, st.SalesTeam AS sales_team, f.SegmentKey, sg.Segment AS segment, f.ChannelKey, f.SalesOrderKey,
       f.PickingID,
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
