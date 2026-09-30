"""Pre-aggregated tables behind the four Product pages (BCG Matrix, Stock Velocity, PIM Contribution,
Product Lifecycle), rebuilt on every ETL run from the same Fact_SalesLines rows the Sales pages read.

Tables (all full-replaced each run):
  Fact_ProductSalesDaily   one row per Company + product (ProductMatchKey) + order date + the filter/RBAC
                           keys + IsIntercompany + UoM. Value = untaxed line total, Qty = invoiced qty
                           (same quantity as the Sales pages). Grand total == Fact_SalesLines total.
  Dim_ProductDashboard     one row per Company + product: every PRODUCTS.xlsx row (zero sales included)
                           plus every Unmapped product seen in sales or stock, with today's stock,
                           days of inventory, stock band, lifecycle segment and BCG class.
                           ProductGroupKey = the product's BMH group (see Dim_ProductDashboardGroup).
  Dim_ProductDashboardGroup  the BMH view (no company filter): one row per ProductGroupKey = normalized
                           sheet ProductName across companies, so a product both companies sell (Majaal
                           "Cemair" + Tika "Cem Air", both named "Cemair" in the sheet) appears once. Stock,
                           days of inventory, stock band, lifecycle and BCG are recomputed from the combined
                           lines and stock -- never averaged. Unmapped products are not grouped (key =
                           their ProductMatchKey). A shared product uses the thresholds of its lead company
                           (larger YTD value, else larger all-time value) -- column ThresholdCompany.
  QA_ProductUnmapped       Odoo names (sales or stock) with no PRODUCTS.xlsx row -- the list to add to the sheet.
  QA_ProductDataQuality    negative stock, products without cost, products sold in several UoMs.
  ProductDashboard_Meta    as-of date, the rules/thresholds used, and the reconciliation totals.

Every threshold comes from config/product_dashboard.json (see docs/product_data_runbook.md).
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from sales_pipeline.product_matching import group_key, normalize_match_company

UNCLASSIFIED_NO_COST = "Unclassified (no cost)"
BCG_BY_CODE = {"HV/HP": "Stars", "HV/LP": "Cash Cows", "LV/HP": "Strategic", "LV/LP": "Dogs"}
BCG_RANK = {"Dogs": 0, "Cash Cows": 1, "Strategic": 1, "Stars": 2}


@dataclass(frozen=True)
class ProductDashboardConfig:
    raw: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def load(cls, path: str | Path) -> "ProductDashboardConfig":
        with open(path, encoding="utf-8") as handle:
            return cls(json.load(handle))

    def section(self, name: str) -> dict[str, Any]:
        return dict(self.raw.get(name, {}))

    @property
    def lookback_days(self) -> int:
        return int(self.section("days_of_inventory").get("lookback_days", 90))

    def per_company(self, section: str, key: str) -> dict[str, float]:
        return {normalize_match_company(k): float(v) for k, v in self.section(section).get(key, {}).items()}

    @property
    def fingerprint(self) -> str:
        return hashlib.sha1(json.dumps(self.raw, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()[:12]


class IntercompanyFlagger:
    """Sets IsIntercompany on sales lines. Information only -- nothing is filtered on it."""

    def __init__(self, partner_ids: set[int], names: set[str]) -> None:
        self.partner_ids = partner_ids
        self.names = names

    @staticmethod
    def _norm(value: Any) -> str:
        return " ".join(str(value).split()).casefold() if value is not None and not pd.isna(value) else ""

    @classmethod
    def from_config(cls, path: str | Path) -> "IntercompanyFlagger":
        section = ProductDashboardConfig.load(path).section("intercompany_customers")
        return cls({int(v) for v in section.get("partner_ids", [])}, {cls._norm(v) for v in section.get("names", [])})

    def flag(self, sales: pd.DataFrame) -> pd.DataFrame:
        out = sales.copy()
        partner = pd.to_numeric(out.get("OdooPartnerID", pd.Series(pd.NA, index=out.index)), errors="coerce")
        by_id = partner.isin(list(self.partner_ids))
        customer = out.get("customer", pd.Series(pd.NA, index=out.index))
        by_name = customer.map(self._norm).isin(self.names)
        out["IsIntercompany"] = (by_id | by_name).astype(bool)
        return out


class ProductDashboardBuilder:
    DAILY_GRAIN = [
        "Company", "CompanyKey", "ProductMatchKey", "OrderDate", "DateKey",
        "SalespersonKey", "SegmentKey", "ChannelKey", "SalesTeamKey", "IsIntercompany", "IsMappedProduct", "UoM",
    ]
    PRODUCT_ATTRS = [
        "ProductKey", "SheetProductKey", "ProductName", "OdooProductName", "Category", "Brand", "SubBrand",
        "Family", "Size", "SKU", "ProductLevel", "IsActive",
    ]

    def __init__(self, config: ProductDashboardConfig, as_of: Any) -> None:
        self.config = config
        self.as_of = pd.Timestamp(as_of).normalize()

    # ------------------------------------------------------------------ entry point
    def build(
        self,
        sales_lines: pd.DataFrame,
        dim_product: pd.DataFrame,
        fact_inventory: pd.DataFrame,
        line_costs: pd.Series | None = None,
    ) -> dict[str, pd.DataFrame]:
        lines = self._prepare_lines(sales_lines, line_costs)
        daily = self._daily(lines)
        self.assert_totals_preserved(lines, daily)
        stock = self._stock(fact_inventory)
        products = self._products(lines, dim_product, stock)
        groups = self._groups(lines, products, stock)
        master_keys = set(dim_product.loc[dim_product["ProductSource"].astype("string").eq("Input Master"), "ProductMatchKey"].astype(str))
        unmapped = self._unmapped(lines, stock, master_keys)
        quality = self._data_quality(products, fact_inventory, lines)
        meta = self._meta(lines, daily, products)
        return {
            "Fact_ProductSalesDaily": daily,
            "Dim_ProductDashboard": products,
            "Dim_ProductDashboardGroup": groups,
            "QA_ProductUnmapped": unmapped,
            "QA_ProductDataQuality": quality,
            "ProductDashboard_Meta": meta,
        }

    # ------------------------------------------------------------------ sales
    @staticmethod
    def _col(df: pd.DataFrame, name: str, default: Any = pd.NA) -> pd.Series:
        return df[name] if name in df.columns else pd.Series(default, index=df.index)

    def _prepare_lines(self, sales_lines: pd.DataFrame, line_costs: pd.Series | None) -> pd.DataFrame:
        s = sales_lines
        out = pd.DataFrame(index=s.index)
        out["Company"] = self._col(s, "company_final", self._col(s, "Company")).map(normalize_match_company)
        out["CompanyKey"] = pd.to_numeric(self._col(s, "CompanyKey"), errors="coerce").astype("Int64")
        out["ProductMatchKey"] = self._col(s, "ProductMatchKey").astype("string")
        out["ProductKey"] = self._col(s, "ProductKey").astype("string")
        out["OdooProductName"] = self._col(s, "OdooProductName").astype("string")
        out["OdooProductID"] = pd.to_numeric(self._col(s, "OdooProductID"), errors="coerce").astype("Int64")
        out["OrderDate"] = pd.to_datetime(self._col(s, "order_date_date"), errors="coerce").dt.normalize()
        out["DateKey"] = pd.to_numeric(self._col(s, "DateKey"), errors="coerce").astype("Int64")
        for key in ["SalespersonKey", "SegmentKey", "ChannelKey"]:
            out[key] = pd.to_numeric(self._col(s, key), errors="coerce").astype("Int64")
        out["SalesTeamKey"] = self._col(s, "SalesTeamKey").astype("string")
        out["IsIntercompany"] = self._col(s, "IsIntercompany", False).fillna(False).astype(bool)
        out["IsMappedProduct"] = self._col(s, "IsMappedProduct", False).fillna(False).astype(bool)
        out["UoM"] = self._col(s, "uom").astype("string").fillna("")
        out["Value"] = pd.to_numeric(self._col(s, "untaxed_total"), errors="coerce").fillna(0.0)
        out["Qty"] = pd.to_numeric(self._col(s, "quantity"), errors="coerce").fillna(0.0)
        out["QtyOrdered"] = pd.to_numeric(self._col(s, "qty_ordered"), errors="coerce").fillna(0.0)
        out["QtyDelivered"] = pd.to_numeric(self._col(s, "qty_delivered"), errors="coerce").fillna(0.0)
        cost = pd.to_numeric(line_costs, errors="coerce") if line_costs is not None else pd.Series(np.nan, index=s.index)
        has_cost = cost.gt(0)
        out["CostValue"] = (out["Qty"] * cost).where(has_cost, 0.0)
        out["CostedQty"] = out["Qty"].where(has_cost, 0.0)
        out["UncostedQty"] = out["Qty"].where(~has_cost, 0.0)
        out["Lines"] = 1
        return out

    def _daily(self, lines: pd.DataFrame) -> pd.DataFrame:
        sums = ["Value", "Qty", "QtyOrdered", "QtyDelivered", "CostValue", "CostedQty", "UncostedQty", "Lines"]
        daily = lines.groupby(self.DAILY_GRAIN, dropna=False, as_index=False)[sums].sum()
        return daily.reset_index(drop=True)

    @staticmethod
    def assert_totals_preserved(before: pd.DataFrame, after: pd.DataFrame) -> None:
        """The product aggregation must not create or lose value, quantity or lines."""
        for column in ["Value", "Qty", "Lines"]:
            a = float(before[column].sum())
            b = float(after[column].sum())
            if abs(a - b) > 0.005:
                raise AssertionError(f"Fact_ProductSalesDaily {column} total {b} != Fact_SalesLines total {a}")

    # ------------------------------------------------------------------ stock
    def _stock(self, fact_inventory: pd.DataFrame) -> pd.DataFrame:
        cols = ["ProductMatchKey", "StockQty", "StockValue", "InTransitQty", "InTransitValue", "NegativeStockRows", "NegativeStockQty"]
        if fact_inventory is None or fact_inventory.empty or "ProductMatchKey" not in fact_inventory.columns:
            return pd.DataFrame(columns=cols + ["Company", "OdooProductName"])
        inv = fact_inventory.copy()
        qty = pd.to_numeric(inv["OnHandQty"], errors="coerce").fillna(0.0)
        value = pd.to_numeric(inv["InventoryValue"], errors="coerce").fillna(0.0)
        positive = qty.gt(0)
        stock_class = inv["StockClass"].astype("string")
        fg = stock_class.eq("FinishedGoods")
        transit = stock_class.eq("InTransit")
        work = pd.DataFrame({
            "ProductMatchKey": inv["ProductMatchKey"].astype("string"),
            "Company": inv["Company"].map(normalize_match_company),
            "OdooProductName": inv["OdooProductName"].astype("string"),
            # Negative quants count as 0 on hand (and are listed in QA_ProductDataQuality).
            "StockQty": qty.where(fg & positive, 0.0),
            "StockValue": value.where(fg & positive, 0.0),
            "InTransitQty": qty.where(transit & positive, 0.0),
            "InTransitValue": value.where(transit & positive, 0.0),
            "NegativeStockRows": (~positive & qty.lt(0)).astype(int),
            "NegativeStockQty": qty.where(qty.lt(0), 0.0),
        })
        work = work[stock_class.isin(["FinishedGoods", "InTransit"])]
        return work.groupby("ProductMatchKey", as_index=False).agg(
            Company=("Company", "first"),
            OdooProductName=("OdooProductName", "first"),
            StockQty=("StockQty", "sum"),
            StockValue=("StockValue", "sum"),
            InTransitQty=("InTransitQty", "sum"),
            InTransitValue=("InTransitValue", "sum"),
            NegativeStockRows=("NegativeStockRows", "sum"),
            NegativeStockQty=("NegativeStockQty", "sum"),
        )

    # ------------------------------------------------------------------ product snapshot
    def _window_sum(self, lines: pd.DataFrame, start: pd.Timestamp, end: pd.Timestamp, column: str) -> pd.Series:
        mask = lines["OrderDate"].between(start, end)
        return lines.loc[mask].groupby("ProductMatchKey")[column].sum()

    def _products(self, lines: pd.DataFrame, dim_product: pd.DataFrame, stock: pd.DataFrame) -> pd.DataFrame:
        master = dim_product[dim_product["ProductSource"].astype("string").eq("Input Master")].copy()
        master["IsMapped"] = True
        master_keys = set(master["ProductMatchKey"].astype(str))
        base = master[["ProductMatchKey", "Company", *self.PRODUCT_ATTRS, "IsMapped"]].copy()
        base["Company"] = base["Company"].map(normalize_match_company)
        # Show the sheet's ProductName exactly as typed (Dim_Product.ProductName is re-cased by the
        # ETL's display normalizer, e.g. "CemAir" -> "Cemair").
        if "ProductNameRaw" in master.columns:
            raw = master["ProductNameRaw"].astype("string").str.strip()
            base["ProductName"] = raw.where(raw.notna() & raw.ne(""), base["ProductName"]).to_numpy()

        # Unmapped products seen in sales or stock get a row too (they are part of every total).
        seen = pd.concat([
            lines.loc[~lines["ProductMatchKey"].astype(str).isin(master_keys), ["ProductMatchKey", "Company", "OdooProductName"]],
            stock.loc[~stock["ProductMatchKey"].astype(str).isin(master_keys), ["ProductMatchKey", "Company", "OdooProductName"]],
        ], ignore_index=True).dropna(subset=["ProductMatchKey"]).drop_duplicates("ProductMatchKey")
        if not seen.empty:
            extra = seen.copy()
            extra["ProductName"] = extra["OdooProductName"].astype("string").str.replace(r"^\s*\[[^\]]*\]\s*", "", regex=True).str.strip()
            extra["IsMapped"] = False
            extra["IsActive"] = pd.NA
            extra["ProductKey"] = pd.NA
            base = pd.concat([base, extra[["ProductMatchKey", "Company", "OdooProductName", "ProductName", "IsMapped", "IsActive", "ProductKey"]]], ignore_index=True)
        base = base.drop_duplicates("ProductMatchKey").set_index("ProductMatchKey")
        mapped = base["IsMapped"].fillna(False).astype(bool)
        gkey = base["ProductName"].map(group_key)
        base["ProductGroupKey"] = gkey.where(mapped & gkey.ne(""), pd.Series(base.index, index=base.index))
        base["ThresholdCompany"] = base["Company"]
        return self._snapshot(base, lines, stock)

    def _snapshot(self, base: pd.DataFrame, lines: pd.DataFrame, stock: pd.DataFrame) -> pd.DataFrame:
        """Sales history, stock, days of inventory, stock band, lifecycle and BCG for `base` (indexed by
        the key that `lines` and `stock` carry in their ProductMatchKey column)."""
        today = self.as_of
        base.index.name = "ProductMatchKey"
        # Sales history
        g = lines.groupby("ProductMatchKey")
        base["FirstSaleDate"] = g["OrderDate"].min()
        base["LastSaleDate"] = g["OrderDate"].max()
        uoms = lines[lines["UoM"].ne("")].groupby("ProductMatchKey")["UoM"].agg(lambda v: sorted(set(v)))
        base["UoM"] = uoms.map(lambda v: v[0] if len(v) == 1 else None)
        base["UoMCount"] = uoms.map(len)
        base["UoMList"] = uoms.map(lambda v: " | ".join(v))

        lookback = self.config.lookback_days
        start_lb = today - pd.Timedelta(days=lookback - 1)
        base["QtyLookback"] = self._window_sum(lines, start_lb, today, "Qty")
        base["AvgDailySales"] = base["QtyLookback"].fillna(0.0) / float(lookback)

        # Stock + days of inventory
        base = base.join(stock.set_index("ProductMatchKey")[["StockQty", "StockValue", "InTransitQty", "InTransitValue", "NegativeStockRows", "NegativeStockQty"]], how="left")
        for c in ["StockQty", "StockValue", "InTransitQty", "InTransitValue", "NegativeStockQty", "QtyLookback"]:
            base[c] = pd.to_numeric(base[c], errors="coerce").fillna(0.0)
        base["NegativeStockRows"] = pd.to_numeric(base["NegativeStockRows"], errors="coerce").fillna(0).astype(int)
        base["DaysOfInventory"] = base["StockQty"].div(base["AvgDailySales"].where(base["AvgDailySales"] > 0))
        base["StockBand"] = self._stock_band(base)

        # Lifecycle
        base["LifecycleSegment"] = self._lifecycle(base, lines)

        # BCG (YTD and LYTD, calendar)
        base = base.join(self._bcg(lines, base), how="left")
        base = base.reset_index()
        base["AsOfDate"] = today
        for c in ["FirstSaleDate", "LastSaleDate"]:
            base[c] = pd.to_datetime(base[c], errors="coerce")
        return base

    # ------------------------------------------------------------------ BMH view (grouped across companies)
    def _groups(self, lines: pd.DataFrame, products: pd.DataFrame, stock: pd.DataFrame) -> pd.DataFrame:
        key_of = products.set_index("ProductMatchKey")["ProductGroupKey"].astype(str)
        glines = lines.copy()
        mk = glines["ProductMatchKey"].astype(str)
        glines["ProductMatchKey"] = mk.map(key_of).fillna(mk)
        self.assert_totals_preserved(lines, glines)
        gstock = stock.copy()
        if not gstock.empty:
            sk = gstock["ProductMatchKey"].astype(str)
            gstock["ProductMatchKey"] = sk.map(key_of).fillna(sk)
            num = ["StockQty", "StockValue", "InTransitQty", "InTransitValue", "NegativeStockRows", "NegativeStockQty"]
            gstock = gstock.groupby("ProductMatchKey", as_index=False)[num].sum()

        members = products.copy()
        members["Company"] = members["Company"].astype("string")
        # Lead company = larger YTD value, then larger all-time value, then name: its thresholds apply.
        ytd_start = pd.Timestamp(year=self.as_of.year, month=1, day=1)
        by_ytd = lines[lines["OrderDate"].between(ytd_start, self.as_of)].groupby("ProductMatchKey")["Value"].sum()
        by_all = lines.groupby("ProductMatchKey")["Value"].sum()
        members["_ytd"] = members["ProductMatchKey"].astype(str).map(by_ytd).fillna(0.0)
        members["_all"] = members["ProductMatchKey"].astype(str).map(by_all).fillna(0.0)
        members = members.sort_values(["ProductGroupKey", "_ytd", "_all", "Company"], ascending=[True, False, False, True])

        def first_filled(v: pd.Series) -> Any:
            v = v.dropna()
            v = v[v.astype(str).str.strip().ne("")]
            return v.iloc[0] if len(v) else pd.NA

        agg: dict[str, Any] = {
            "Companies": ("Company", lambda v: " + ".join(sorted(set(v.dropna())))),
            "CompanyCount": ("Company", lambda v: int(v.dropna().nunique())),
            "ThresholdCompany": ("Company", "first"),
            "MemberKeys": ("ProductMatchKey", lambda v: ",".join(sorted(v.astype(str)))),
            "IsMapped": ("IsMapped", lambda v: bool(v.fillna(False).astype(bool).any())),
            "IsActive": ("IsActive", lambda v: pd.to_numeric(v, errors="coerce").max()),
        }
        for c in self.PRODUCT_ATTRS:
            if c != "IsActive" and c in members.columns:
                agg[c] = (c, first_filled)
        base = members.groupby("ProductGroupKey", sort=True).agg(**agg)
        base["Company"] = base["Companies"]
        out = self._snapshot(base, glines, gstock if not gstock.empty else stock.iloc[0:0])
        return out.rename(columns={"ProductMatchKey": "ProductGroupKey"})

    def _stock_band(self, p: pd.DataFrame) -> pd.Series:
        over = self.config.per_company("days_of_inventory", "overstock_days")
        risk = self.config.per_company("days_of_inventory", "stockout_risk_days")
        company = p["ThresholdCompany"].astype("string")
        over_t = company.map(over)
        risk_t = company.map(risk)
        doh = p["DaysOfInventory"]
        stock = p["StockQty"]
        return pd.Series(np.select(
            [
                stock.gt(0) & p["AvgDailySales"].le(0),          # stock, no sales in look-back
                stock.le(0) & p["AvgDailySales"].le(0),
                doh.gt(over_t),
                doh.lt(risk_t),
            ],
            ["NoMovement", "NoStockNoSales", "Overstock", "StockOutRisk"],
            default="Normal",
        ), index=p.index)

    def _lifecycle(self, p: pd.DataFrame, lines: pd.DataFrame) -> pd.Series:
        cfg = self.config.section("lifecycle")
        today = self.as_of
        window = int(cfg.get("trend_window_days", 90))
        growth = float(cfg.get("growth_threshold_pct", 20)) / 100.0
        new_days = int(cfg.get("new_first_sale_within_days", 180))
        dead_days = int(cfg.get("discontinued_no_sales_days", 365))
        last_start = today - pd.Timedelta(days=window - 1)
        prev_end = last_start - pd.Timedelta(days=1)
        prev_start = prev_end - pd.Timedelta(days=window - 1)
        last_qty = self._window_sum(lines, last_start, today, "Qty").reindex(p.index).fillna(0.0)
        prev_qty = self._window_sum(lines, prev_start, prev_end, "Qty").reindex(p.index).fillna(0.0)
        first = pd.to_datetime(p["FirstSaleDate"], errors="coerce")
        last = pd.to_datetime(p["LastSaleDate"], errors="coerce")
        inactive = pd.to_numeric(p["IsActive"], errors="coerce").eq(0)
        # A product with no sale in the whole history is its own segment, never Discontinued.
        never_sold = first.isna() & last.isna()
        no_recent = last.lt(today - pd.Timedelta(days=dead_days - 1))
        is_new = first.notna() & first.ge(today - pd.Timedelta(days=new_days - 1))
        change = (last_qty - prev_qty).div(prev_qty.where(prev_qty > 0))
        return pd.Series(np.select(
            [
                never_sold,
                inactive | no_recent,
                is_new,
                prev_qty.le(0) & last_qty.gt(0),
                change.gt(growth),
                change.lt(-growth),
            ],
            ["Never sold", "Discontinued", "New", "Growing", "Growing", "Declining"],
            default="Mature",
        ), index=p.index)

    def _bcg(self, lines: pd.DataFrame, products: pd.DataFrame) -> pd.DataFrame:
        cfg = self.config.section("bcg")
        vol_t = self.config.per_company("bcg", "volume_threshold")
        profit_t = float(cfg.get("profit_threshold_pct", 35)) / 100.0
        excluded = {str(c) for c in cfg.get("excluded_categories", [])}
        today = self.as_of
        ytd_start = pd.Timestamp(year=today.year, month=1, day=1)
        try:
            lytd_end = today.replace(year=today.year - 1)
        except ValueError:
            lytd_end = today.replace(year=today.year - 1, day=28)
        lytd_start = pd.Timestamp(year=today.year - 1, month=1, day=1)
        out = pd.DataFrame(index=products.index)
        for label, start, end in (("YTD", ytd_start, today), ("LYTD", lytd_start, lytd_end)):
            window = lines[lines["OrderDate"].between(start, end)]
            g = window.groupby("ProductMatchKey")[["Value", "Qty", "CostValue", "UncostedQty", "Lines"]].sum().reindex(products.index).fillna(0.0)
            out[f"Value{label}"] = g["Value"]
            out[f"Qty{label}"] = g["Qty"]
            has_sales = g["Lines"].gt(0)
            no_cost = has_sales & g["UncostedQty"].gt(0)
            gp = (g["Value"] - g["CostValue"]).div(g["Value"].where(g["Value"] != 0))
            out[f"GrossProfitPct{label}"] = (gp * 100).where(has_sales & ~no_cost)
            vclass = np.where(g["Qty"] >= products["ThresholdCompany"].map(vol_t).fillna(np.inf), "HV", "LV")
            pclass = np.where(gp >= profit_t, "HP", "LP")
            code = pd.Series(vclass, index=products.index) + "/" + pd.Series(pclass, index=products.index)
            cls = code.map(BCG_BY_CODE)
            cls = cls.where(~no_cost, UNCLASSIFIED_NO_COST).where(has_sales, None)
            out[f"BcgClass{label}"] = cls
            out[f"NoCost{label}"] = no_cost
        cat = products["Category"].astype("string")
        out["BcgExcludedCategory"] = cat.isin(list(excluded)).fillna(False)
        out["BcgMovement"] = self._movement(out, products)
        return out

    def _movement(self, b: pd.DataFrame, products: pd.DataFrame) -> pd.Series:
        ytd, lytd = b["BcgClassYTD"], b["BcgClassLYTD"]
        new_days = int(self.config.section("lifecycle").get("new_first_sale_within_days", 180))
        first = pd.to_datetime(products["FirstSaleDate"], errors="coerce")
        is_new_product = first.notna() & first.ge(self.as_of - pd.Timedelta(days=new_days - 1))
        rank_y = ytd.map(BCG_RANK)
        rank_l = lytd.map(BCG_RANK)
        return pd.Series(np.select(
            [
                ytd.isna() & lytd.notna(),
                ytd.notna() & (lytd.isna() | is_new_product),
                rank_y.isna() | rank_l.isna() | (ytd == lytd),
                rank_y > rank_l,
                rank_y < rank_l,
            ],
            ["Lost", "New", "Stable", "Improved", "Declined"],
            default="Stable",
        ), index=b.index).where(ytd.notna() | lytd.notna(), None)

    # ------------------------------------------------------------------ logs
    def _unmapped(self, lines: pd.DataFrame, stock: pd.DataFrame, master_keys: set[str]) -> pd.DataFrame:
        cols = ["Source", "Company", "OdooProductName", "ProductMatchKey", "OdooProductIDs", "Lines", "Value", "Qty", "UoM",
                "FirstSeen", "LastSeen", "StockQty", "StockValue", "AsOfDate"]
        um = lines[~lines["IsMappedProduct"]]
        sales = um.groupby(["Company", "ProductMatchKey"], as_index=False).agg(
            OdooProductName=("OdooProductName", "first"),
            OdooProductIDs=("OdooProductID", lambda v: ",".join(str(int(x)) for x in sorted(set(v.dropna())))),
            Lines=("Lines", "sum"), Value=("Value", "sum"), Qty=("Qty", "sum"),
            UoM=("UoM", lambda v: " | ".join(sorted(set(x for x in v if x)))),
            FirstSeen=("OrderDate", "min"), LastSeen=("OrderDate", "max"),
        )
        sales["Source"] = "Sales"
        st = stock[~stock["ProductMatchKey"].astype(str).isin(master_keys)].copy() if not stock.empty else stock.copy()
        st = st[(st["StockQty"] > 0) | (st["InTransitQty"] > 0)] if not st.empty else st
        st["Source"] = "Stock"
        out = pd.concat([sales, st[[c for c in ["Source", "Company", "OdooProductName", "ProductMatchKey", "StockQty", "StockValue"] if c in st.columns]]], ignore_index=True)
        out["AsOfDate"] = self.as_of
        for c in cols:
            if c not in out.columns:
                out[c] = pd.NA
        return out[cols].sort_values(["Source", "Company", "Value"], ascending=[True, True, False], na_position="last").reset_index(drop=True)

    def _data_quality(self, products: pd.DataFrame, fact_inventory: pd.DataFrame, lines: pd.DataFrame) -> pd.DataFrame:
        rows: list[dict[str, Any]] = []
        if fact_inventory is not None and not fact_inventory.empty:
            inv = fact_inventory[pd.to_numeric(fact_inventory["OnHandQty"], errors="coerce").lt(0)]
            for _, r in inv.iterrows():
                rows.append({"Check": "NegativeStock", "Company": normalize_match_company(r.get("Company")), "ProductMatchKey": r.get("ProductMatchKey"),
                             "ProductName": r.get("ProductName"), "Detail": f"{r.get('LocationName')}: on hand {float(r['OnHandQty']):,.2f} (counted as 0)",
                             "Qty": float(r["OnHandQty"]), "Value": float(pd.to_numeric(r.get("InventoryValue"), errors="coerce") or 0.0)})
        for _, r in products[products["NoCostYTD"].fillna(False)].iterrows():
            rows.append({"Check": "NoCost", "Company": r["Company"], "ProductMatchKey": r["ProductMatchKey"], "ProductName": r["ProductName"],
                         "Detail": "Sold this year without a standard cost in Odoo -> BCG 'Unclassified (no cost)'",
                         "Qty": float(r["QtyYTD"]), "Value": float(r["ValueYTD"])})
        for _, r in products[pd.to_numeric(products["UoMCount"], errors="coerce").fillna(0).gt(1)].iterrows():
            rows.append({"Check": "MixedUoM", "Company": r["Company"], "ProductMatchKey": r["ProductMatchKey"], "ProductName": r["ProductName"],
                         "Detail": f"Sold in several units of measure: {r['UoMList']} -- quantities are never summed across them",
                         "Qty": None, "Value": None})
        out = pd.DataFrame(rows, columns=["Check", "Company", "ProductMatchKey", "ProductName", "Detail", "Qty", "Value"])
        out["AsOfDate"] = self.as_of
        return out

    def _meta(self, lines: pd.DataFrame, daily: pd.DataFrame, products: pd.DataFrame) -> pd.DataFrame:
        return pd.DataFrame([{
            "AsOfDate": self.as_of,
            "BuiltAtUtc": pd.Timestamp.now(tz="UTC").tz_localize(None),
            "ConfigFingerprint": self.config.fingerprint,
            "ConfigJson": json.dumps(self.config.raw, ensure_ascii=False),
            "LookbackDays": self.config.lookback_days,
            "SalesLinesValue": float(lines["Value"].sum()),
            "SalesLinesQty": float(lines["Qty"].sum()),
            "SalesLinesCount": int(len(lines)),
            "DailyValue": float(daily["Value"].sum()),
            "UnmappedValue": float(lines.loc[~lines["IsMappedProduct"], "Value"].sum()),
            "MasterProducts": int(products["IsMapped"].fillna(False).sum()),
            "UnmappedProducts": int((~products["IsMapped"].fillna(False).astype(bool)).sum()),
        }])
