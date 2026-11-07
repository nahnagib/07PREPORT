"""Pre-aggregated tables behind the four Product pages (BCG Matrix, Stock Velocity, PIM Contribution,
Product Lifecycle), rebuilt on every ETL run from the same Fact_SalesLines rows the Sales pages read.

Products are Odoo's (sales_pipeline.odoo_products, 2026-11-03): one product = one Odoo product.product id in one
company (ProductCompanyKey 'Majaal|2163'); name, SKU, category, brand, family, size and active come from Odoo as stored,
'Unassigned' where Odoo has no value. Nothing is matched or grouped on a product name.

Tables (all full-replaced each run):
  Fact_ProductSalesDaily   one row per Company + product (ProductCompanyKey) + order date + the filter/RBAC
                           keys + IsIntercompany + UoM. Value = untaxed line total, Qty = invoiced qty
                           (same quantity as the Sales pages). Grand total == Fact_SalesLines total minus the
                           excluded companies and the not-real-sales lines (see below).
  Dim_ProductDashboard     one row per Company + product: every product sold or in stock in that company, plus the
                           active Odoo products of that company never sold, with today's stock, days of inventory,
                           stock band, lifecycle segment and BCG class. Always ONE company per row (2026-11-04: the
                           cross-company "BMH" grouping is removed); ThresholdCompany = that company.
Companies listed in config `product_pages.excluded_companies` (Athena) are left out of every table here, so the Product
pages' totals exclude them. Lines that are not real sales -- Customer Group in `product_pages_excluded_segment_keys`
(3 Backoffice, 4 Inter Company) or flagged IsIntercompany when `product_pages_exclude_intercompany` -- are dropped before
any product calculation (BCG, movement, lifecycle, first sale, frequency, velocity, PIM), so the Product pages' totals are
the Sales pages' totals minus those lines. On top of that, input file ProductExclusions.xlsx (product_exclusions.py):
  Customers   Exclude drops the customer's lines; Keep counts them even when Backoffice / Inter Company / intercompany.
  Categories  Exclude drops every product of the category AND of its sub-categories (lines, stock, catalog rows).
  Products    Exclude drops one product; Keep keeps it even when its category is excluded.
Every rule is per company (All, or the row's company), matched on Odoo ids only. Sub-categories are found by Odoo's full
category path (complete_name, "Parent / Child", the same chain as parent_path). Without the file, the category ids in
config `product_pages_excluded_category_ids` (or the old `bcg.excluded_category_ids`) are the only category rule.
Units of measure of the "unit" type (UNIT, Unit, Units, وحدة) are one label, "Unit"
(product_pages.unit_uom_names); every other UoM keeps its own name.
  QA_ProductOdooGaps       every product sold that has no Brand, Family, Size or SKU in Odoo, biggest sales first --
                           the list to fill in Odoo (also written to OUTPUT/product_odoo_gaps.csv on a full refresh).
  QA_ProductDataQuality    negative stock, products without cost, products sold in several UoMs.
  ProductDashboard_Meta    as-of date, the rules/thresholds used, and the reconciliation totals.

Every threshold comes from config/product_dashboard.json (see docs/product_data_runbook.md).
"""

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from sales_pipeline import odoo_products
from sales_pipeline.product_exclusions import ProductExclusions, log_summary
from sales_pipeline.product_matching import normalize_match_company

UNCLASSIFIED_NO_COST = "Unclassified (no cost)"
BCG_BY_CODE = {"HV/HP": "Stars", "HV/LP": "Cash Cows", "LV/HP": "Strategic", "LV/LP": "Dogs"}
MOVEMENTS = ("New", "Stable", "Improved", "Drop", "Discontinued")
GAP_ATTRIBUTES = ("Brand", "Family", "Size", "SKU")
UNIT_LABEL = "Unit"
GAP_COLUMNS = ["Company", "OdooProductID", "ProductName", "Category", "Missing", "SalesValue", "SalesValueLast12M",
               "Lines", "LastSaleDate", "AsOfDate"]
log = logging.getLogger(__name__)


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
    """Sets IsIntercompany on sales lines. Only the Product pages drop flagged lines
    (product_pages_exclude_intercompany); every other page keeps them."""

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
        "Company", "CompanyKey", "ProductCompanyKey", "ProductKey", "OrderDate", "DateKey",
        "SalespersonKey", "SegmentKey", "ChannelKey", "SalesTeamKey", "IsIntercompany", "UoM",
    ]
    PRODUCT_ATTRS = [
        "ProductKey", "ProductTemplateID", "ProductName", "OdooProductName", "Category", "CategoryID", "Brand",
        "SubBrand", "Family", "Size", "SKU", "IsActive",
    ]

    def __init__(self, config: ProductDashboardConfig, as_of: Any, exclusions: ProductExclusions | None = None) -> None:
        self.config = config
        self.as_of = pd.Timestamp(as_of).normalize()
        pages = config.section("product_pages")
        self.excluded_companies = {normalize_match_company(c) for c in pages.get("excluded_companies", [])}
        self.unit_names = {str(u).strip().casefold() for u in pages.get("unit_uom_names", [])}
        self.unit_label = str(pages.get("unit_label", UNIT_LABEL))
        self.excluded_segment_keys = {int(k) for k in config.raw.get("product_pages_excluded_segment_keys", [])}
        self.exclude_intercompany = bool(config.raw.get("product_pages_exclude_intercompany", False))
        self.excluded_sales: pd.DataFrame = pd.DataFrame()
        self.exclusions = exclusions if exclusions is not None else ProductExclusions.empty()
        if self.exclusions.source is None:
            # No ProductExclusions.xlsx: the category ids of the JSON config (old key as fallback) are the category rule.
            fallback = config.raw.get("product_pages_excluded_category_ids", config.section("bcg").get("excluded_category_ids", []))
            ids = [int(c) for c in fallback]
            self.exclusions.categories = pd.DataFrame({"Company": ["All"] * len(ids), "OdooID": pd.Series(ids, dtype="int64"),
                                                       "Action": ["Exclude"] * len(ids)})
        self.excluded_product_keys: set[str] = set()

    def uom_label(self, uom: Any) -> str:
        """One label for every unit-type UoM ('UNIT', 'Unit', 'وحدة' -> 'Unit'); any other UoM is kept as named."""
        text = "" if uom is None or (not isinstance(uom, str) and pd.isna(uom)) else str(uom)
        return self.unit_label if text.strip().casefold() in self.unit_names else text

    # ------------------------------------------------------------------ entry point
    def build(
        self,
        sales_lines: pd.DataFrame,
        dim_product: pd.DataFrame,
        fact_inventory: pd.DataFrame,
        line_costs: pd.Series | None = None,
    ) -> dict[str, pd.DataFrame]:
        log_summary(self.exclusions)
        lines = self._prepare_lines(sales_lines, line_costs)
        lines = lines[~lines["Company"].isin(self.excluded_companies)]
        lines = self._drop_non_sales(lines)
        stock = self._stock(fact_inventory)
        if not stock.empty:
            stock = stock[~stock["Company"].isin(self.excluded_companies)]
        self.excluded_product_keys = self._excluded_products(lines, dim_product, stock)
        lines = self._drop_products(lines)
        if not stock.empty:
            stock = stock[~stock["ProductCompanyKey"].isin(self.excluded_product_keys)]
        daily = self._daily(lines)
        self.assert_totals_preserved(lines, daily)
        products = self._products(lines, dim_product, stock)
        gaps = self.odoo_gaps(lines, products)
        inventory = fact_inventory
        if inventory is not None and not inventory.empty and "Company" in inventory.columns:
            inventory = inventory[~inventory["Company"].map(normalize_match_company).isin(self.excluded_companies)]
        quality = self._data_quality(products, inventory, lines)
        meta = self._meta(lines, daily, products)
        return {
            "Fact_ProductSalesDaily": daily,
            "Dim_ProductDashboard": products,
            "QA_ProductOdooGaps": gaps,
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
        out["ProductKey"] = self._col(s, "ProductKey").astype("string").fillna(odoo_products.UNKNOWN_PRODUCT_KEY)
        out["ProductCompanyKey"] = odoo_products.product_company_keys(out["Company"], out["ProductKey"])
        out["ProductName"] = self._col(s, "ProductName").astype(object)
        out["OdooProductName"] = self._col(s, "OdooProductName").astype(object)
        out["OdooProductID"] = pd.to_numeric(self._col(s, "OdooProductID"), errors="coerce").astype("Int64")
        out["OrderDate"] = pd.to_datetime(self._col(s, "order_date_date"), errors="coerce").dt.normalize()
        out["DateKey"] = pd.to_numeric(self._col(s, "DateKey"), errors="coerce").astype("Int64")
        for key in ["SalespersonKey", "SegmentKey", "ChannelKey"]:
            out[key] = pd.to_numeric(self._col(s, key), errors="coerce").astype("Int64")
        out["SalesTeamKey"] = self._col(s, "SalesTeamKey").astype("string")
        out["IsIntercompany"] = self._col(s, "IsIntercompany", False).fillna(False).astype(bool)
        # Customer ids for ProductExclusions.xlsx: the order's partner and its commercial partner (CustomerKey).
        out["OdooPartnerID"] = pd.to_numeric(self._col(s, "OdooPartnerID"), errors="coerce").astype("Int64")
        out["CustomerKey"] = pd.to_numeric(self._col(s, "CustomerKey"), errors="coerce").astype("Int64")
        out["UoM"] = self._col(s, "uom").map(self.uom_label).astype("string").fillna("")
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

    def _customer_rule(self, lines: pd.DataFrame, action: str) -> pd.Series:
        """Lines whose customer (order partner or commercial partner) has an active `action` row for the line's company."""
        hit = pd.Series(False, index=lines.index)
        for company in lines["Company"].dropna().unique():
            ids = list(self.exclusions.ids("Customers", action, str(company)))
            if ids:
                own = lines["Company"].eq(company)
                hit |= own & (lines["OdooPartnerID"].isin(ids).fillna(False) | lines["CustomerKey"].isin(ids).fillna(False))
        return hit

    def non_sales_mask(self, lines: pd.DataFrame) -> pd.Series:
        """Lines that are not real sales: an excluded Customer Group (stored SegmentKey) or, when configured, IsIntercompany
        -- unless the customer is a Customers Keep row -- plus every Customers Exclude row."""
        mask = lines["SegmentKey"].isin(list(self.excluded_segment_keys)).fillna(False).astype(bool)
        if self.exclude_intercompany:
            mask |= lines["IsIntercompany"].fillna(False).astype(bool)
        return (mask & ~self._customer_rule(lines, "Keep")) | self._customer_rule(lines, "Exclude")

    def _drop_non_sales(self, lines: pd.DataFrame) -> pd.DataFrame:
        mask = self.non_sales_mask(lines)
        self.excluded_sales = lines.loc[mask]
        if mask.any():
            by_company = self.excluded_sales.groupby("Company")[["Lines", "Qty", "Value"]].sum()
            for company, r in by_company.iterrows():
                log.info("Product pages: %s not-real-sales line(s) dropped for %s (qty %s, LYD %s; segments %s, intercompany=%s)",
                         f"{int(r['Lines']):,}", company, f"{r['Qty']:,.2f}", f"{r['Value']:,.2f}",
                         sorted(self.excluded_segment_keys), self.exclude_intercompany)
        known = set(lines["OdooPartnerID"].dropna().astype(int)) | set(lines["CustomerKey"].dropna().astype(int))
        unknown = sorted(set(self.exclusions.customers["OdooID"].astype(int)) - known)
        if unknown:
            log.warning("Product pages: ProductExclusions.xlsx Customers id(s) with no sales line in the data: %s", unknown)
        return lines.loc[~mask]

    # ------------------------------------------------------------------ product exclusions
    def _excluded_products(self, lines: pd.DataFrame, dim_product: pd.DataFrame | None, stock: pd.DataFrame) -> set[str]:
        """ProductCompanyKeys left out of every Product table: a Categories Exclude row (the category or any sub-category,
        by Odoo's full category path) or a Products Exclude row, minus the Products Keep rows -- all per company."""
        frames = [lines[["ProductCompanyKey", "Company", "ProductKey"]]]
        if not stock.empty:
            frames.append(stock[["ProductCompanyKey", "Company", "ProductKey"]])
        catalog = dim_product if dim_product is not None else pd.DataFrame()
        if not catalog.empty and "ProductCompany" in catalog.columns:
            own = catalog[catalog["ProductCompany"].notna()].copy()
            own["Company"] = own["ProductCompany"].map(normalize_match_company)
            own["ProductKey"] = own["ProductKey"].astype("string")
            own["ProductCompanyKey"] = odoo_products.product_company_keys(own["Company"], own["ProductKey"])
            frames.append(own[["ProductCompanyKey", "Company", "ProductKey"]])
        keys = pd.concat([f.astype(object) for f in frames], ignore_index=True)
        keys = keys.dropna(subset=["ProductCompanyKey"]).drop_duplicates("ProductCompanyKey").reset_index(drop=True)
        keys["pid"] = pd.to_numeric(keys["ProductKey"], errors="coerce")
        path_of: dict[int, str] = {}
        keys["Category"] = pd.NA
        if not catalog.empty and {"CategoryID", "Category", "ProductKey"} <= set(catalog.columns):
            by_product = catalog.drop_duplicates("ProductKey").assign(pid=lambda d: pd.to_numeric(d["ProductKey"], errors="coerce"))
            by_product = by_product.dropna(subset=["pid"]).drop_duplicates("pid").set_index("pid")
            keys["Category"] = keys["pid"].map(by_product["Category"])
            cats = catalog[["CategoryID", "Category"]].dropna().drop_duplicates("CategoryID")
            path_of = {int(c): str(p) for c, p in zip(cats["CategoryID"], cats["Category"])}
        unknown_categories = sorted(set(self.exclusions.categories["OdooID"].astype(int)) - set(path_of))
        if unknown_categories:
            log.warning("Product pages: excluded category id(s) not found on any product: %s", unknown_categories)
        unknown_products = sorted(set(self.exclusions.products["OdooID"].astype(int)) - set(keys["pid"].dropna().astype(int)))
        if unknown_products:
            log.warning("Product pages: ProductExclusions.xlsx Products id(s) not found: %s", unknown_products)

        excluded = pd.Series(False, index=keys.index)
        category = keys["Category"].astype("string")
        for company in keys["Company"].dropna().unique():
            hit = pd.Series(False, index=keys.index)
            for cid in self.exclusions.ids("Categories", "Exclude", str(company)):
                path = path_of.get(cid)
                if path is not None:
                    hit |= (category.eq(path) | category.str.startswith(path + " / ")).fillna(False).astype(bool)
            hit |= keys["pid"].isin(list(self.exclusions.ids("Products", "Exclude", str(company))))
            hit &= ~keys["pid"].isin(list(self.exclusions.ids("Products", "Keep", str(company))))
            excluded |= keys["Company"].eq(company) & hit
        out = set(keys.loc[excluded, "ProductCompanyKey"].astype(str))
        if out:
            log.info("Product pages: %s product(s) excluded by category / product rules: %s", f"{len(out):,}",
                     keys.loc[excluded].groupby("Company").size().to_dict())
        return out

    def _drop_products(self, lines: pd.DataFrame) -> pd.DataFrame:
        mask = lines["ProductCompanyKey"].isin(self.excluded_product_keys)
        if mask.any():
            r = lines.loc[mask].groupby("Company")[["Lines", "Qty", "Value"]].sum()
            for company, v in r.iterrows():
                log.info("Product pages: %s sales line(s) of excluded products dropped for %s (qty %s, LYD %s)",
                         f"{int(v['Lines']):,}", company, f"{v['Qty']:,.2f}", f"{v['Value']:,.2f}")
        return lines.loc[~mask]

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
        cols = ["ProductCompanyKey", "StockQty", "StockValue", "InTransitQty", "InTransitValue", "NegativeStockRows", "NegativeStockQty", "StockAgeDays"]
        if fact_inventory is None or fact_inventory.empty or "ProductCompanyKey" not in fact_inventory.columns:
            return pd.DataFrame(columns=cols + ["Company", "ProductKey", "ProductName", "OdooProductName"])
        inv = fact_inventory.copy()
        qty = pd.to_numeric(inv["OnHandQty"], errors="coerce").fillna(0.0)
        value = pd.to_numeric(inv["InventoryValue"], errors="coerce").fillna(0.0)
        positive = qty.gt(0)
        stock_class = inv["StockClass"].astype("string")
        fg = stock_class.eq("FinishedGoods")
        transit = stock_class.eq("InTransit")
        work = pd.DataFrame({
            "ProductCompanyKey": inv["ProductCompanyKey"].astype("string"),
            "Company": inv["Company"].map(normalize_match_company),
            "ProductKey": inv["ProductKey"].astype("string"),
            "ProductName": inv["ProductName"].astype(object),
            "OdooProductName": inv["OdooProductName"].astype(object),
            # Negative quants count as 0 on hand (and are listed in QA_ProductDataQuality).
            "StockQty": qty.where(fg & positive, 0.0),
            "StockValue": value.where(fg & positive, 0.0),
            "InTransitQty": qty.where(transit & positive, 0.0),
            "InTransitValue": value.where(transit & positive, 0.0),
            "NegativeStockRows": (~positive & qty.lt(0)).astype(int),
            "NegativeStockQty": qty.where(qty.lt(0), 0.0),
        })
        # Stock Aging: days since the quant arrived (Odoo in_date), finished goods on hand only, weighted by its units
        in_date = pd.to_datetime(inv["InDate"], errors="coerce") if "InDate" in inv.columns else pd.Series(pd.NaT, index=inv.index)
        age = (self.as_of - in_date.dt.normalize()).dt.days.clip(lower=0)
        aged = fg & positive & age.notna()
        work["AgedQty"] = qty.where(aged, 0.0)
        work["AgeQtyDays"] = (qty * age).where(aged, 0.0)
        work = work[stock_class.isin(["FinishedGoods", "InTransit"])]
        return work.groupby("ProductCompanyKey", as_index=False).agg(
            Company=("Company", "first"),
            ProductKey=("ProductKey", "first"),
            ProductName=("ProductName", "first"),
            OdooProductName=("OdooProductName", "first"),
            StockQty=("StockQty", "sum"),
            StockValue=("StockValue", "sum"),
            InTransitQty=("InTransitQty", "sum"),
            InTransitValue=("InTransitValue", "sum"),
            NegativeStockRows=("NegativeStockRows", "sum"),
            NegativeStockQty=("NegativeStockQty", "sum"),
            AgedQty=("AgedQty", "sum"),
            AgeQtyDays=("AgeQtyDays", "sum"),
        ).assign(StockAgeDays=lambda d: d["AgeQtyDays"].div(d["AgedQty"].where(d["AgedQty"] > 0))).drop(columns=["AgedQty", "AgeQtyDays"])

    # ------------------------------------------------------------------ product snapshot
    def _window_sum(self, lines: pd.DataFrame, start: pd.Timestamp, end: pd.Timestamp, column: str) -> pd.Series:
        mask = lines["OrderDate"].between(start, end)
        return lines.loc[mask].groupby("ProductCompanyKey")[column].sum()

    def _products(self, lines: pd.DataFrame, dim_product: pd.DataFrame, stock: pd.DataFrame) -> pd.DataFrame:
        cols = ["ProductCompanyKey", "Company", "ProductKey", "ProductName", "OdooProductName"]
        seen = pd.concat([lines[cols], stock[cols] if not stock.empty else pd.DataFrame(columns=cols)], ignore_index=True)
        catalog = dim_product.copy() if dim_product is not None else pd.DataFrame()
        if not catalog.empty and "ProductCompany" in catalog.columns:
            own = catalog[catalog["IsActive"].fillna(False).astype(bool) & catalog["ProductCompany"].notna()].copy()
            own["Company"] = own["ProductCompany"].map(normalize_match_company)
            own = own[own["Company"].isin(set(lines["Company"].dropna()))]
            own["ProductKey"] = own["ProductKey"].astype("string")
            own["ProductCompanyKey"] = odoo_products.product_company_keys(own["Company"], own["ProductKey"])
            seen = pd.concat([seen, own[cols]], ignore_index=True)
        base = seen.dropna(subset=["ProductCompanyKey"]).drop_duplicates("ProductCompanyKey").copy()
        base = base[~base["ProductCompanyKey"].isin(self.excluded_product_keys)]
        # Odoo's attributes by product id; a product missing from the catalog keeps the name its lines carry
        attrs = [c for c in self.PRODUCT_ATTRS if c not in ("ProductKey",)]
        if not catalog.empty:
            by_key = catalog.drop_duplicates("ProductKey").set_index(catalog.drop_duplicates("ProductKey")["ProductKey"].astype("string").to_numpy())
            found = base["ProductKey"].astype("string").isin(by_key.index)
            for c in attrs:
                if c in by_key.columns:
                    mapped = base["ProductKey"].astype("string").map(by_key[c])
                    base[c] = mapped.where(found, base[c] if c in base.columns else pd.NA)
        for c in attrs:
            if c not in base.columns:
                base[c] = pd.NA
        for c in odoo_products.ATTRIBUTE_FIELDS:
            base[c] = base[c].where(base[c].notna(), odoo_products.UNASSIGNED)
        base["IsActive"] = base["IsActive"].map(lambda v: pd.NA if v is None or (not isinstance(v, bool) and pd.isna(v)) else int(bool(v)))
        base = base.set_index("ProductCompanyKey")
        base["ThresholdCompany"] = base["Company"]
        return self._snapshot(base, lines, stock)

    def _snapshot(self, base: pd.DataFrame, lines: pd.DataFrame, stock: pd.DataFrame) -> pd.DataFrame:
        """Sales history, stock, days of inventory, stock band, lifecycle and BCG for `base` (indexed by
        the key that `lines` and `stock` carry in their ProductCompanyKey column)."""
        today = self.as_of
        base.index.name = "ProductCompanyKey"
        # Sales history
        g = lines.groupby("ProductCompanyKey")
        base["FirstSaleDate"] = g["OrderDate"].min()
        base["LastSaleDate"] = g["OrderDate"].max()
        uoms = lines[lines["UoM"].ne("")].groupby("ProductCompanyKey")["UoM"].agg(lambda v: sorted(set(v)))
        base["UoM"] = uoms.map(lambda v: v[0] if len(v) == 1 else None)
        base["UoMCount"] = uoms.map(len)
        base["UoMList"] = uoms.map(lambda v: " | ".join(v))

        lookback = self.config.lookback_days
        start_lb = today - pd.Timedelta(days=lookback - 1)
        base["QtyLookback"] = self._window_sum(lines, start_lb, today, "Qty")
        base["AvgDailySales"] = base["QtyLookback"].fillna(0.0) / float(lookback)

        # Stock + days of inventory
        base = base.join(stock.set_index("ProductCompanyKey")[["StockQty", "StockValue", "InTransitQty", "InTransitValue", "NegativeStockRows", "NegativeStockQty", "StockAgeDays"]], how="left")
        for c in ["StockQty", "StockValue", "InTransitQty", "InTransitValue", "NegativeStockQty", "QtyLookback"]:
            base[c] = pd.to_numeric(base[c], errors="coerce").fillna(0.0)
        base["NegativeStockRows"] = pd.to_numeric(base["NegativeStockRows"], errors="coerce").fillna(0).astype(int)
        base["DaysOfInventory"] = base["StockQty"].div(base["AvgDailySales"].where(base["AvgDailySales"] > 0))
        base["StockBand"] = self._stock_band(base)
        base["StockAgeDays"] = pd.to_numeric(base["StockAgeDays"], errors="coerce").where(base["StockQty"] > 0)
        base["StockAgeBucket"] = self.aging_bucket(base["StockAgeDays"])

        # Lifecycle
        base["LifecycleSegment"] = self._lifecycle(base, lines)

        # BCG (YTD and LYTD, calendar)
        base = base.join(self._bcg(lines, base), how="left")
        base = base.reset_index()
        base["AsOfDate"] = today
        for c in ["FirstSaleDate", "LastSaleDate"]:
            base[c] = pd.to_datetime(base[c], errors="coerce")
        return base

    def aging_bucket(self, age_days: pd.Series) -> pd.Series:
        """Stock Aging bucket label of each age (config stock.aging_buckets: ages up to max_days; null = no limit)."""
        buckets = self.config.section("stock").get("aging_buckets", [])
        out = pd.Series(pd.NA, index=age_days.index, dtype="object")
        free = age_days.notna()
        for b in buckets:
            limit = b.get("max_days")
            hit = free & (age_days.le(float(limit)) if limit is not None else True)
            out[hit] = b["label"]
            free &= ~hit
        return out

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
            g = window.groupby("ProductCompanyKey")[["Value", "Qty", "CostValue", "UncostedQty", "Lines"]].sum().reindex(products.index).fillna(0.0)
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
        # Excluded categories are dropped from every Product table before this (ProductExclusions.xlsx); the column stays
        # for the table schema and the API, always False.
        out["BcgExcludedCategory"] = False
        out["BcgMovement"] = self._movement(out, products)
        return out

    def _movement(self, b: pd.DataFrame, products: pd.DataFrame) -> pd.Series:
        """Product Movement, on VOLUME: invoiced quantity YTD vs the same calendar period last year (QtyYTD vs QtyLYTD),
        for every product sold in either period. In this order:
          Discontinued  archived in Odoo (product.product active = False; archiving a template archives its variants)
                        -- we stopped supplying it, whatever it sold
          New           first sale within lifecycle.new_first_sale_within_days, or nothing sold last year (LYTD qty <= 0)
          Improved      volume growth > +bcg.movement_stable_band_pct
          Drop          volume growth < -band (a product that sold last year and nothing this year, still active, is -100%)
          Stable        within +-band, or no positive volume in either period (returns only)
        Not sold in either period -> no movement (None)."""
        band = float(self.config.section("bcg").get("movement_stable_band_pct", 10))
        new_days = int(self.config.section("lifecycle").get("new_first_sale_within_days", 180))
        qty_y = pd.to_numeric(b["QtyYTD"], errors="coerce").fillna(0.0)
        qty_l = pd.to_numeric(b["QtyLYTD"], errors="coerce").fillna(0.0)
        sold = b["BcgClassYTD"].notna() | b["BcgClassLYTD"].notna()
        first = pd.to_datetime(products["FirstSaleDate"], errors="coerce")
        is_new_product = first.notna() & first.ge(self.as_of - pd.Timedelta(days=new_days - 1))
        archived = pd.to_numeric(products["IsActive"], errors="coerce").eq(0)
        growth = (qty_y - qty_l).div(qty_l.where(qty_l > 0)) * 100
        return pd.Series(np.select(
            [
                archived,
                is_new_product | (qty_l.le(0) & qty_y.gt(0)),
                growth.gt(band),
                growth.lt(-band),
            ],
            ["Discontinued", "New", "Improved", "Drop"],
            default="Stable",
        ), index=b.index).where(sold, None)

    # ------------------------------------------------------------------ logs
    def odoo_gaps(self, lines: pd.DataFrame, products: pd.DataFrame) -> pd.DataFrame:
        """Every product sold (any date) that has no Brand, Family, Size or SKU in Odoo, per company, largest sales
        first: the list to fill in Odoo. One row per Company + Odoo product."""
        sold = lines[lines["ProductKey"].astype(str).ne(odoo_products.UNKNOWN_PRODUCT_KEY)]
        if sold.empty or products.empty:
            return pd.DataFrame(columns=GAP_COLUMNS)
        start_12m = self.as_of - pd.DateOffset(months=12) + pd.Timedelta(days=1)
        g = sold.groupby("ProductCompanyKey")
        totals = pd.DataFrame({
            "SalesValue": g["Value"].sum(),
            "Lines": g["Lines"].sum(),
        })
        totals["SalesValueLast12M"] = sold[sold["OrderDate"].between(start_12m, self.as_of)].groupby("ProductCompanyKey")["Value"].sum()
        p = products.set_index("ProductCompanyKey").join(totals, how="inner")
        missing = pd.DataFrame({
            a: (p[a].isna() | p[a].astype(str).eq(odoo_products.UNASSIGNED)) if a in p.columns else True for a in GAP_ATTRIBUTES
        }, index=p.index)
        p = p[missing.any(axis=1)].copy()
        if p.empty:
            return pd.DataFrame(columns=GAP_COLUMNS)
        p["Missing"] = missing.loc[p.index].apply(lambda r: ", ".join(a for a in GAP_ATTRIBUTES if r[a]), axis=1)
        p["OdooProductID"] = pd.to_numeric(p["ProductKey"], errors="coerce").astype("Int64")
        p["SalesValueLast12M"] = p["SalesValueLast12M"].fillna(0.0)
        p["AsOfDate"] = self.as_of
        out = p.reset_index()[GAP_COLUMNS]
        return out.sort_values(["SalesValue", "SalesValueLast12M", "OdooProductID"], ascending=[False, False, True]).reset_index(drop=True)

    def _data_quality(self, products: pd.DataFrame, fact_inventory: pd.DataFrame, lines: pd.DataFrame) -> pd.DataFrame:
        rows: list[dict[str, Any]] = []
        if fact_inventory is not None and not fact_inventory.empty:
            inv = fact_inventory[pd.to_numeric(fact_inventory["OnHandQty"], errors="coerce").lt(0)]
            for _, r in inv.iterrows():
                rows.append({"Check": "NegativeStock", "Company": normalize_match_company(r.get("Company")), "ProductCompanyKey": r.get("ProductCompanyKey"),
                             "ProductName": r.get("ProductName"), "Detail": f"{r.get('LocationName')}: on hand {float(r['OnHandQty']):,.2f} (counted as 0)",
                             "Qty": float(r["OnHandQty"]), "Value": float(pd.to_numeric(r.get("InventoryValue"), errors="coerce") or 0.0)})
        for _, r in products[products["NoCostYTD"].fillna(False)].iterrows():
            rows.append({"Check": "NoCost", "Company": r["Company"], "ProductCompanyKey": r["ProductCompanyKey"], "ProductName": r["ProductName"],
                         "Detail": "Sold this year without a standard cost in Odoo -> BCG 'Unclassified (no cost)'",
                         "Qty": float(r["QtyYTD"]), "Value": float(r["ValueYTD"])})
        for _, r in products[pd.to_numeric(products["UoMCount"], errors="coerce").fillna(0).gt(1)].iterrows():
            rows.append({"Check": "MixedUoM", "Company": r["Company"], "ProductCompanyKey": r["ProductCompanyKey"], "ProductName": r["ProductName"],
                         "Detail": f"Sold in several units of measure: {r['UoMList']} -- quantities are never summed across them",
                         "Qty": None, "Value": None})
        out = pd.DataFrame(rows, columns=["Check", "Company", "ProductCompanyKey", "ProductName", "Detail", "Qty", "Value"])
        out["AsOfDate"] = self.as_of
        return out

    def _meta(self, lines: pd.DataFrame, daily: pd.DataFrame, products: pd.DataFrame) -> pd.DataFrame:
        return pd.DataFrame([{
            "AsOfDate": self.as_of,
            # Whole seconds: MySQL DATETIME rounds fractional seconds, so .5s+ read back one second later and
            # failed the SQL/DataFrame mirror validation about every other run.
            "BuiltAtUtc": pd.Timestamp.now(tz="UTC").tz_localize(None).floor("s"),
            "ConfigFingerprint": self.config.fingerprint,
            "ConfigJson": json.dumps(self.config.raw, ensure_ascii=False),
            "LookbackDays": self.config.lookback_days,
            "SalesLinesValue": float(lines["Value"].sum()),
            "SalesLinesQty": float(lines["Qty"].sum()),
            "SalesLinesCount": int(len(lines)),
            "DailyValue": float(daily["Value"].sum()),
            "Products": int(len(products)),
            "UnassignedBrandProducts": int(products["Brand"].astype(str).eq(odoo_products.UNASSIGNED).sum()),
            "UnassignedCategoryProducts": int(products["Category"].astype(str).eq(odoo_products.UNASSIGNED).sum()),
        }])
