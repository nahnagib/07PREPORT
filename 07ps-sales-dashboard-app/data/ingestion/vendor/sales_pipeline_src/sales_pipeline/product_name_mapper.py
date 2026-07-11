from __future__ import annotations

from pathlib import Path
from typing import Union

import pandas as pd

PathLike = Union[str, Path]


class ProductNameMapper:
    """Applies Odoo product name aliases from PRODUCTS.xlsx to a Series.

    Reads the OdooProductName → ProductName mapping from the manual product
    master. Names that have no mapping pass through unchanged so every Odoo
    product row stays in the ETL regardless of master coverage.
    """

    def __init__(self, products_path: PathLike) -> None:
        self._mapping: dict[str, str] = {}
        path = Path(products_path)
        if path.exists():
            try:
                df = pd.read_excel(path)
                df.columns = [str(c).strip() for c in df.columns]
                df = df.rename(columns={
                    "Odoo Name": "OdooProductName",
                    "Odoo Nmae": "OdooProductName",
                    "OdooProduct Name": "OdooProductName",
                })
                if "OdooProductName" in df.columns and "ProductName" in df.columns:
                    pairs = df[["OdooProductName", "ProductName"]].dropna(subset=["OdooProductName", "ProductName"])
                    for odoo_name, product_name in zip(pairs["OdooProductName"].astype(str), pairs["ProductName"].astype(str)):
                        odoo_name = odoo_name.strip()
                        product_name = product_name.strip()
                        if odoo_name and product_name:
                            self._mapping[odoo_name] = product_name
            except Exception:  # noqa: BLE001
                pass

    def mapping_count(self) -> int:
        return len(self._mapping)

    def apply_to_series(self, series: pd.Series) -> pd.Series:
        """Map Odoo product names to canonical names; unmapped values pass through."""
        return series.map(lambda v: self._mapping.get(str(v).strip(), v) if pd.notna(v) else v)
