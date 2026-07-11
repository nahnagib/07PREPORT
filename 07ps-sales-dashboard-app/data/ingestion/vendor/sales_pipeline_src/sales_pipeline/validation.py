from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path

import pandas as pd


@dataclass(frozen=True)
class ValidationIssue:
    severity: str
    table: str
    check: str
    details: str


class ModelValidator:
    """Fast structural checks that run before export."""

    KEY_COLUMNS = {
        "Dim_Date": "DateKey",
        "Dim_Customer": "CustomerKey",
        "Dim_Salesperson": "SalespersonKey",
        "Dim_SalesTeam": "SalesTeamKey",
        "Dim_Company": "CompanyKey",
        "Dim_Product": "ProductKey",
        "Dim_DistributionChannel": "ChannelKey",
        "Dim_Segment": "SegmentKey",
        "Dim_Invoice": "InvoiceKey",
        "Dim_CRMStage": "StageID",
        "Dim_LostReason": "LostReasonID",
        "Fact_Orders": "OrderKey",
        "Fact_Lead": "LeadID",
        "Fact_Opportunity": "OpportunityID",
        "Fact_Sales": "SalesDocumentID",
        "Fact_Delivery": "DeliveryFactID",
    }
    RELATIONSHIPS = [
        ("Fact_SalesLines", "CustomerKey", "Dim_Customer", "CustomerKey"),
        ("Fact_Orders", "CustomerKey", "Dim_Customer", "CustomerKey"),
        ("Fact_Lead", "CustomerKey", "Dim_Customer", "CustomerKey"),
        ("Fact_Opportunity", "CustomerKey", "Dim_Customer", "CustomerKey"),
        ("Fact_Sales", "CustomerKey", "Dim_Customer", "CustomerKey"),
        ("Fact_Delivery", "CustomerKey", "Dim_Customer", "CustomerKey"),
        ("Fact_SalesLines", "DateKey", "Dim_Date", "DateKey"),
        ("Fact_Orders", "DateKey", "Dim_Date", "DateKey"),
        ("Fact_Sales", "DateKey", "Dim_Date", "DateKey"),
        ("Fact_Lead", "LeadCreatedDateKey", "Dim_Date", "DateKey"),
        ("Fact_Opportunity", "OpportunityCreatedDateKey", "Dim_Date", "DateKey"),
        ("Fact_Delivery", "OrderDateKey", "Dim_Date", "DateKey"),
        ("Fact_BCGMatrix", "ProductKey", "Dim_Product", "ProductKey"),
        ("Fact_BCGMatrix", "Company", "Dim_Company", "Company"),
        ("Fact_Inventory", "ProductKey", "Dim_Product", "ProductKey"),
        ("Fact_Inventory", "CompanyKey", "Dim_Company", "CompanyKey"),
        ("Fact_Inventory", "SnapshotDateKey", "Dim_Date", "DateKey"),
    ]
    KPI_COLUMNS = {
        "Fact_SalesLines": ["Value", "Quantity"],
        "Fact_Orders": ["OrderValue", "OrderVolume"],
        "Fact_Targets": ["TargetValue"],
        "Fact_Sales": ["OrderValue", "OrderVolume"],
        "Fact_Delivery": ["OrderedQuantity", "DeliveredQuantity"],
        "Fact_Opportunity": ["ExpectedRevenue", "ProratedRevenue"],
        "Fact_Inventory": ["OnHandQty", "ReservedQty", "AvailableQty", "InventoryValue"],
    }

    @classmethod
    def validate(cls, tables: dict[str, pd.DataFrame], strict: bool = False) -> list[ValidationIssue]:
        issues: list[ValidationIssue] = []
        for table_name, key in cls.KEY_COLUMNS.items():
            frame = tables.get(table_name)
            if frame is None:
                issues.append(ValidationIssue("ERROR", table_name, "table_exists", "Required modeled table is missing"))
                continue
            if key not in frame.columns:
                issues.append(ValidationIssue("ERROR", table_name, "key_exists", f"Required key column {key} is missing"))
                continue
            nulls = int(frame[key].isna().sum())
            duplicates = int(frame[key].dropna().duplicated().sum())
            if nulls:
                issues.append(ValidationIssue("ERROR" if strict else "WARNING", table_name, "null_key", f"{key} null rows={nulls}"))
            if duplicates:
                issues.append(
                    ValidationIssue(
                        "ERROR" if strict else "WARNING",
                        table_name,
                        "duplicate_key",
                        f"{key} duplicate rows={duplicates}",
                    )
                )
        for fact_name, fact_key, dim_name, dim_key in cls.RELATIONSHIPS:
            fact = tables.get(fact_name)
            dim = tables.get(dim_name)
            if fact is None or dim is None or fact_key not in fact.columns or dim_key not in dim.columns:
                continue
            dim_values = set(dim[dim_key].dropna().astype("string"))
            missing = fact[fact_key].dropna().astype("string")
            missing_count = int((~missing.isin(dim_values)).sum())
            if missing_count:
                issues.append(
                    ValidationIssue(
                        "ERROR" if strict else "WARNING",
                        fact_name,
                        "referential_integrity",
                        f"{fact_key} values missing from {dim_name}.{dim_key}: rows={missing_count}",
                    )
                )
        return issues

    @staticmethod
    def raise_for_errors(issues: list[ValidationIssue]) -> None:
        errors = [issue for issue in issues if issue.severity == "ERROR"]
        if errors:
            details = "; ".join(f"{i.table}.{i.check}: {i.details}" for i in errors)
            raise RuntimeError(f"Model structural validation failed: {details}")

    @classmethod
    def manifest(cls, tables: dict[str, pd.DataFrame]) -> dict[str, object]:
        output: dict[str, object] = {"tables": {}}
        table_output: dict[str, object] = output["tables"]  # type: ignore[assignment]
        for table_name, frame in tables.items():
            kpis = {}
            for column in cls.KPI_COLUMNS.get(table_name, []):
                if column in frame.columns:
                    kpis[column] = round(float(pd.to_numeric(frame[column], errors="coerce").fillna(0).sum()), 6)
            table_output[table_name] = {
                "rows": len(frame),
                "columns": list(map(str, frame.columns)),
                "kpis": kpis,
            }
        return output

    @staticmethod
    def write_manifest(path: Path, manifest: dict[str, object]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")

    @staticmethod
    def compare_manifest(baseline_path: Path, current: dict[str, object]) -> list[str]:
        baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
        differences: list[str] = []
        baseline_tables = baseline.get("tables", {})
        current_tables = current.get("tables", {})
        for table_name in sorted(set(baseline_tables) | set(current_tables)):
            before = baseline_tables.get(table_name)
            after = current_tables.get(table_name)
            if before is None or after is None:
                differences.append(f"{table_name}: missing from {'baseline' if before is None else 'current'}")
                continue
            if before.get("columns") != after.get("columns"):
                differences.append(f"{table_name}: schema changed")
            if before.get("rows") != after.get("rows"):
                differences.append(f"{table_name}: rows baseline={before.get('rows')} current={after.get('rows')}")
            if before.get("kpis") != after.get("kpis"):
                differences.append(f"{table_name}: KPI totals changed baseline={before.get('kpis')} current={after.get('kpis')}")
        return differences
