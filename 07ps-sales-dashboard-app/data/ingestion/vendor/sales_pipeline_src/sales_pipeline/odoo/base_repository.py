from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from typing import Any

import pandas as pd

from sales_pipeline.odoo.client import OdooClient, OdooApiError


@dataclass(frozen=True)
class FieldSpec:
    model: str
    field: str
    exists: bool
    used_by_pipeline: bool
    notes: str = ""


class OdooRepositoryBase:
    def __init__(self, client: OdooClient, batch_size: int = 500) -> None:
        self.client = client
        self.batch_size = batch_size
        self.logger = logging.getLogger(self.__class__.__module__)

    def fields_get(self, model: str) -> dict[str, Any]:
        try:
            return self.client.fields_get(model, attributes=["string", "type", "relation"])
        except OdooApiError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise OdooApiError(f"Could not inspect fields for {model}: {exc}") from exc

    def available_fields(self, model: str, requested: list[str]) -> tuple[list[str], pd.DataFrame, dict[str, Any]]:
        meta = self.fields_get(model)
        rows = []
        available = []
        for field in requested:
            exists = field in meta
            if exists:
                available.append(field)
            rows.append(
                {
                    "Model": model,
                    "Field": field,
                    "ExistsInOdoo": bool(exists),
                    "UsedByPipeline": True,
                    "Notes": "" if exists else "Missing in fields_get; skipped gracefully",
                }
            )
        return available, pd.DataFrame(rows), meta

    def search_read_all(
        self,
        model: str,
        domain: list[Any],
        fields: list[str],
        order: str = "id",
        context: dict[str, Any] | None = None,
    ) -> pd.DataFrame:
        total = self.client.search_count(model, domain, context=context)
        self.logger.info("%s rows available: %s", model, f"{total:,}")
        if total == 0:
            return pd.DataFrame(columns=fields)
        rows: list[dict[str, Any]] = []
        pages = math.ceil(total / self.batch_size)
        for page in range(pages):
            offset = page * self.batch_size
            self.logger.info("Fetching %s batch %s/%s offset=%s limit=%s", model, page + 1, pages, offset, self.batch_size)
            rows.extend(self.client.search_read(model, domain, fields, offset=offset, limit=self.batch_size, order=order, context=context))
        return pd.DataFrame(rows, columns=fields)


def flatten_many2one_columns(df: pd.DataFrame, field_meta: dict[str, Any]) -> pd.DataFrame:
    out = df.copy()
    for col in list(out.columns):
        meta = field_meta.get(col, {})
        if meta.get("type") == "many2one":
            out[f"{col}_id"] = out[col].apply(lambda value: value[0] if isinstance(value, (list, tuple)) and value else pd.NA)
            out[col] = out[col].apply(lambda value: value[1] if isinstance(value, (list, tuple)) and len(value) > 1 else (pd.NA if value in (False, None) else value))
    return out


def flatten_many2many(value: Any) -> str:
    if isinstance(value, list):
        return ", ".join(str(v) for v in value)
    if value in (False, None):
        return ""
    return str(value)
