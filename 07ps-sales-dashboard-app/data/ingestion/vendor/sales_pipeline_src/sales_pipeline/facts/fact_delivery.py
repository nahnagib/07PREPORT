from __future__ import annotations

import pandas as pd

from sales_pipeline.crm.crm_cleaner import date_key
from sales_pipeline.facts.quotation_classification import add_delivery_classification


DELIVERY_STATUSES = {"Not Delivered", "Started", "Partially Delivered", "Fully Delivered"}


class DeliveryFactBuilder:
    COLUMNS = [
        "DeliveryFactID",
        "PickingID",
        "DeliveryID",
        "DeliveryReference",
        "SalesOrderID",
        "OrderNumber",
        "JourneyKey",
        "QuotationID",
        "SourceQuotationID",
        "OpportunityID",
        "LeadID",
        "CustomerID",
        "Customer",
        "CustomerKey",
        "Salesperson",
        "SalespersonKey",
        "SalesTeam",
        "SalesTeamKey",
        "SalesSegment",
        "SegmentKey",
        "Company",
        "CompanyKey",
        "OrderDate",
        "OrderDateKey",
        "ScheduledDate",
        "ScheduledDateKey",
        "DoneDate",
        "DoneDateKey",
        "DeliveryDate",
        "DeliveryStatus",
        "IsRealSalesOrder",
        "IsRealDelivery",
        "DeliveryClassification",
        "PickingState",
        "OrderedQuantity",
        "DeliveredQuantity",
        "RemainingQuantity",
        "DeliveryProgressPercent",
        "Count",
    ]

    SALES_CONTEXT_COLUMNS = [
        "OrderID",
        "OrderNumber",
        "JourneyKey",
        "QuotationID",
        "SourceQuotationID",
        "OpportunityID",
        "LeadID",
        "CustomerID",
        "Customer",
        "CustomerKey",
        "Salesperson",
        "SalespersonKey",
        "SalesTeam",
        "SalesTeamKey",
        "SalesSegment",
        "SegmentKey",
        "Company",
        "CompanyKey",
        "OrderDate",
        "OrderDateTime",
        "SalesOrderDate",
        "IsRealSalesOrder",
        "OrderVolume",
    ]

    def build(self, pickings: pd.DataFrame, moves: pd.DataFrame, fact_sales: pd.DataFrame) -> pd.DataFrame:
        sales_orders = self._sales_orders(fact_sales)
        picking_rows = self._picking_rows(pickings, moves, sales_orders)
        no_picking_rows = self._sales_orders_without_pickings(sales_orders, picking_rows)
        parts = []
        for frame in [picking_rows, no_picking_rows]:
            if frame.empty:
                continue
            part = frame.copy()
            for col in self.COLUMNS:
                if col not in part.columns:
                    part[col] = pd.NA
            parts.append(part)
        out = pd.concat([part.dropna(axis=1, how="all") for part in parts], ignore_index=True) if parts else pd.DataFrame(columns=self.COLUMNS)
        if out.empty:
            return pd.DataFrame(columns=self.COLUMNS)
        for col in self.COLUMNS:
            if col not in out.columns:
                out[col] = pd.NA

        out["DeliveryStatus"] = out["DeliveryStatus"].where(out["DeliveryStatus"].isin(DELIVERY_STATUSES), "Not Delivered")
        out["RemainingQuantity"] = (pd.to_numeric(out["OrderedQuantity"], errors="coerce").fillna(0) - pd.to_numeric(out["DeliveredQuantity"], errors="coerce").fillna(0)).clip(lower=0)
        ordered = pd.to_numeric(out["OrderedQuantity"], errors="coerce").fillna(0)
        delivered = pd.to_numeric(out["DeliveredQuantity"], errors="coerce").fillna(0)
        out["DeliveryProgressPercent"] = 0.0
        nonzero = ordered.gt(0)
        out.loc[nonzero, "DeliveryProgressPercent"] = (delivered[nonzero] / ordered[nonzero] * 100).clip(upper=100).round(2)
        out["Count"] = 1
        out["DeliveryDate"] = out["DoneDate"]
        out["OrderDate"] = pd.to_datetime(out["OrderDate"], errors="coerce").dt.normalize()
        out["OrderDateKey"] = date_key(out["OrderDate"])
        out["ScheduledDateKey"] = date_key(out["ScheduledDate"])
        out["DoneDateKey"] = date_key(out["DoneDate"])
        out = add_delivery_classification(out)

        for col in self.COLUMNS:
            if col not in out.columns:
                out[col] = pd.NA
        return out[self.COLUMNS]

    def project(self, delivery: pd.DataFrame) -> pd.DataFrame:
        out = add_delivery_classification(delivery)
        for col in self.COLUMNS:
            if col not in out.columns:
                out[col] = pd.NA
        return out[self.COLUMNS]

    def _picking_rows(self, pickings: pd.DataFrame, moves: pd.DataFrame, sales_orders: pd.DataFrame) -> pd.DataFrame:
        if pickings.empty:
            return pd.DataFrame(columns=self.COLUMNS)

        out = pickings.copy()
        out["PickingID"] = pd.to_numeric(out.get("id", pd.Series(pd.NA, index=out.index)), errors="coerce").astype("Int64")
        out["DeliveryID"] = out["PickingID"]
        out["DeliveryReference"] = out.get("name", pd.Series(pd.NA, index=out.index))
        out["SalesOrderID"] = pd.to_numeric(out.get("sale_id_id", pd.Series(pd.NA, index=out.index)), errors="coerce").astype("Int64")
        out["OrderNumber"] = out.get("sale_id", pd.Series(pd.NA, index=out.index)).combine_first(out.get("origin", pd.Series(pd.NA, index=out.index)))
        out["ScheduledDate"] = pd.to_datetime(out.get("scheduled_date", pd.Series(pd.NaT, index=out.index)), errors="coerce")
        out["DoneDate"] = pd.to_datetime(out.get("date_done", pd.Series(pd.NaT, index=out.index)), errors="coerce")
        out["PickingState"] = out.get("state", pd.Series(pd.NA, index=out.index))

        quantities = self._move_quantities(moves)
        if not quantities.empty:
            out = out.merge(quantities, on="PickingID", how="left", validate="1:1")
        else:
            out["OrderedQuantity"] = pd.NA
            out["DeliveredQuantity"] = pd.NA
            out["HasMoveStarted"] = False
            out["HasMixedMoveStatus"] = False

        out = self._attach_sales_context(out, sales_orders)
        out["DeliveryStatus"] = out.apply(self._delivery_status_from_row, axis=1)
        out["DeliveryFactID"] = "PICK-" + out["PickingID"].astype("string")
        return out

    def _sales_orders_without_pickings(self, sales_orders: pd.DataFrame, picking_rows: pd.DataFrame) -> pd.DataFrame:
        if sales_orders.empty:
            return pd.DataFrame(columns=self.COLUMNS)
        picked_order_ids = set(
            pd.to_numeric(picking_rows.get("SalesOrderID", pd.Series(dtype="object")), errors="coerce")
            .dropna()
            .astype(int)
            .tolist()
        )
        missing = sales_orders.loc[~pd.to_numeric(sales_orders["OrderID"], errors="coerce").isin(picked_order_ids)].copy()
        if missing.empty:
            return pd.DataFrame(columns=self.COLUMNS)
        out = pd.DataFrame()
        out["DeliveryFactID"] = "NO-PICK-" + missing["OrderID"].astype("string")
        out["PickingID"] = pd.NA
        out["DeliveryID"] = pd.NA
        out["DeliveryReference"] = pd.NA
        out["SalesOrderID"] = missing["OrderID"]
        for col in [
            "OrderNumber",
            "JourneyKey",
            "QuotationID",
            "SourceQuotationID",
            "OpportunityID",
            "LeadID",
            "CustomerID",
            "Customer",
            "CustomerKey",
            "Salesperson",
            "SalespersonKey",
            "SalesTeam",
            "SalesTeamKey",
            "SalesSegment",
            "SegmentKey",
            "Company",
            "CompanyKey",
            "OrderDate",
            "IsRealSalesOrder",
        ]:
            out[col] = missing.get(col, pd.Series(pd.NA, index=missing.index)).to_numpy()
        out["ScheduledDate"] = pd.NaT
        out["DoneDate"] = pd.NaT
        out["DeliveryStatus"] = "Not Delivered"
        out["PickingState"] = pd.NA
        out["OrderedQuantity"] = pd.to_numeric(missing.get("OrderVolume", pd.Series(pd.NA, index=missing.index)), errors="coerce")
        out["DeliveredQuantity"] = 0.0
        return out

    @staticmethod
    def _sales_orders(fact_sales: pd.DataFrame) -> pd.DataFrame:
        if fact_sales.empty:
            return pd.DataFrame(columns=DeliveryFactBuilder.SALES_CONTEXT_COLUMNS)
        out = fact_sales.loc[fact_sales.get("SalesDocumentType", pd.Series(index=fact_sales.index)).eq("Sales Order")].copy()
        for col in DeliveryFactBuilder.SALES_CONTEXT_COLUMNS:
            if col not in out.columns:
                out[col] = pd.NA
        order_datetime = pd.to_datetime(out["OrderDateTime"], errors="coerce").combine_first(
            pd.to_datetime(out["SalesOrderDate"], errors="coerce")
        )
        out["OrderDate"] = pd.to_datetime(out["OrderDate"], errors="coerce").combine_first(order_datetime).dt.normalize()
        return out[DeliveryFactBuilder.SALES_CONTEXT_COLUMNS].dropna(subset=["OrderID"]).drop_duplicates("OrderID")

    @staticmethod
    def _move_quantities(moves: pd.DataFrame) -> pd.DataFrame:
        if moves.empty or "picking_id_id" not in moves.columns:
            return pd.DataFrame(columns=["PickingID", "OrderedQuantity", "DeliveredQuantity", "HasMoveStarted", "HasMixedMoveStatus"])
        out = moves.copy()
        out["PickingID"] = pd.to_numeric(out["picking_id_id"], errors="coerce").astype("Int64")
        demand_col = "product_uom_qty" if "product_uom_qty" in out.columns else "product_qty"
        done_col = "quantity_done" if "quantity_done" in out.columns else ("quantity" if "quantity" in out.columns else demand_col)
        out["_DemandQty"] = pd.to_numeric(out.get(demand_col, pd.Series(0, index=out.index)), errors="coerce").fillna(0)
        out["_DoneQty"] = pd.to_numeric(out.get(done_col, pd.Series(0, index=out.index)), errors="coerce").fillna(0)
        state = out.get("state", pd.Series(pd.NA, index=out.index)).astype("string").str.strip().str.lower()
        if done_col == demand_col:
            out["_DoneQty"] = out["_DemandQty"].where(state.eq("done"), 0)
        out["_HasMoveStarted"] = state.isin(["assigned", "partially_available", "done"]) | out["_DoneQty"].gt(0)
        grouped = out.dropna(subset=["PickingID"]).groupby("PickingID", as_index=False).agg(
            OrderedQuantity=("_DemandQty", "sum"),
            DeliveredQuantity=("_DoneQty", "sum"),
            HasMoveStarted=("_HasMoveStarted", "max"),
            MoveStateCount=("state", lambda s: s.astype("string").str.lower().nunique()),
        )
        grouped["HasMixedMoveStatus"] = grouped["MoveStateCount"].gt(1)
        return grouped.drop(columns=["MoveStateCount"])

    @staticmethod
    def _attach_sales_context(pickings: pd.DataFrame, sales_orders: pd.DataFrame) -> pd.DataFrame:
        out = pickings.copy()
        if sales_orders.empty:
            return out
        by_id = sales_orders.rename(columns={"OrderID": "SalesOrderID"})
        out = out.merge(by_id, on="SalesOrderID", how="left", validate="m:1", suffixes=("", "_sales"))
        unmatched = out["OrderNumber_sales"].isna() if "OrderNumber_sales" in out.columns else pd.Series(False, index=out.index)
        if unmatched.any():
            by_number = sales_orders.drop_duplicates("OrderNumber")
            fallback = out.loc[unmatched, ["OrderNumber"]].merge(by_number, on="OrderNumber", how="left", validate="m:1", suffixes=("", "_sales"))
            for col in DeliveryFactBuilder.SALES_CONTEXT_COLUMNS:
                if col == "OrderNumber":
                    continue
                target_col = "SalesOrderID" if col == "OrderID" else col
                fallback_col = col
                if fallback_col in fallback.columns:
                    out.loc[unmatched, target_col] = fallback[fallback_col].to_numpy()
        for col in DeliveryFactBuilder.SALES_CONTEXT_COLUMNS:
            if col == "OrderID":
                continue
            sales_col = f"{col}_sales"
            if sales_col in out.columns:
                out[col] = out[sales_col].combine_first(out.get(col, pd.Series(pd.NA, index=out.index)))
        out = out.drop(columns=[c for c in out.columns if c.endswith("_sales")], errors="ignore")
        return out

    @staticmethod
    def _delivery_status_from_row(row: pd.Series) -> str:
        total_qty = pd.to_numeric(pd.Series([row.get("OrderedQuantity")]), errors="coerce").fillna(0).iloc[0]
        delivered_qty = pd.to_numeric(pd.Series([row.get("DeliveredQuantity")]), errors="coerce").fillna(0).iloc[0]
        state = str(row.get("PickingState") or "").strip().lower()
        started = bool(row.get("HasMoveStarted")) or state in {"assigned", "partially_available", "done"}
        mixed = bool(row.get("HasMixedMoveStatus")) or state == "partially_available"

        if total_qty > 0:
            if delivered_qty >= total_qty:
                return "Fully Delivered"
            if delivered_qty > 0:
                return "Partially Delivered"
            if started:
                return "Started"
            return "Not Delivered"

        if state in {"draft", "cancel", "waiting", "confirmed", ""}:
            return "Not Delivered"
        if mixed:
            return "Partially Delivered"
        if state == "assigned":
            return "Started"
        if state == "done":
            return "Fully Delivered"
        return "Not Delivered"
