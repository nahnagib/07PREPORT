from __future__ import annotations

import sys
from decimal import Decimal
from pathlib import Path

import pandas as pd
from sqlalchemy import create_engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.dialects import mysql
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

import sales_pipeline.export.database_exporter as database_exporter  # noqa: E402
from sales_pipeline.export.database_exporter import DatabaseExporter, SQLExportResult  # noqa: E402
from sales_pipeline.pipeline import PowerBISalesPipeline  # noqa: E402


def mysql_type_name(sql_type) -> str:
    return sql_type.compile(dialect=mysql.dialect()).upper()


def normalize_pair(left: pd.Series, right: pd.Series, column_name: str) -> tuple[list[str], list[str]]:
    left_norm, right_norm = PowerBISalesPipeline._normalize_compare_series(left, right, column_name)
    return left_norm.astype(str).tolist(), right_norm.astype(str).tolist()


def sqlite_exporter() -> DatabaseExporter:
    exporter = DatabaseExporter.__new__(DatabaseExporter)
    exporter.settings = SimpleNamespace(db_chunksize=1000, db_reload_mode="drop_recreate")
    exporter.logger = database_exporter.logging.getLogger(__name__)
    exporter.engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    return exporter


class FakeRowcountResult:
    def __init__(self, rowcount: int):
        self.rowcount = rowcount


class FakeMySQLConnection:
    def __init__(self, rowcounts: list[int], failures_before_success: int = 0):
        self.rowcounts = rowcounts
        self.failures_before_success = failures_before_success
        self.execute_count = 0
        self.statements: list[str] = []
        self.params: list[dict[str, object] | None] = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def execute(self, statement, params=None):
        self.execute_count += 1
        self.statements.append(str(statement))
        self.params.append(params)
        if self.failures_before_success > 0:
            self.failures_before_success -= 1
            raise OperationalError(str(statement), params, Exception("(1205, 'Lock wait timeout exceeded; try restarting transaction')"))
        return FakeRowcountResult(self.rowcounts.pop(0))


class FakeMySQLEngine:
    dialect = mysql.dialect()

    def __init__(self, rowcounts: list[int], failures_before_success: int = 0):
        self.connection = FakeMySQLConnection(rowcounts, failures_before_success)

    def begin(self):
        return self.connection


def test_mysql_dtype_map_uses_decimal_for_money_and_quantity_columns():
    df = pd.DataFrame(
        {
            "InvoiceValue": [57429.76],
            "line_total": [28131.84],
            "Value": [28131.84],
            "untaxed_total": [28131.84],
            "quantity": [12.345678],
            "Volume": [2.5],
            "Probability": [50.0],
            "is_discount": pd.Series([True], dtype="boolean"),
        }
    )

    dtype = DatabaseExporter._dtype_map(df, "mysql")

    for column in ["InvoiceValue", "line_total", "Value", "untaxed_total", "quantity", "Volume"]:
        assert isinstance(dtype[column], mysql.DECIMAL)
        assert dtype[column].precision == 20
        assert dtype[column].scale == 6

    assert isinstance(dtype["is_discount"], mysql.TINYINT)


def test_mysql_dtype_map_uses_decimal_for_product_cost_and_bcg_profit_metrics():
    df = pd.DataFrame(
        {
            "ProductCost": [40.06602],
            "avg_product_cost_YTD": [40.06602],
            "perc_gross_profit_YTD": [0.456789123],
            "gross_profit_change_pp": [0.123456789],
            "quantity_growth_pct": [0.2265625],
        }
    )

    dtype = DatabaseExporter._dtype_map(df, "mysql")

    for column in df.columns:
        assert isinstance(dtype[column], mysql.DECIMAL)
        assert dtype[column].precision == 20
        assert dtype[column].scale == 6


def test_clean_for_sql_prerounds_decimal_metrics_to_six_places():
    clean = DatabaseExporter._clean_for_sql(
        pd.DataFrame(
            {
                "avg_unit_price_YTD": [35.0671875],
                "ProductCost": [40.0660249],
                "gross_profit_change_pp": [-1.9519745],
                "Probability": [33.33333339],
            }
        )
    )

    assert clean["avg_unit_price_YTD"].iloc[0] == 35.067188
    assert clean["ProductCost"].iloc[0] == 40.066025
    assert clean["gross_profit_change_pp"].iloc[0] == -1.951975
    # Non-decimal FLOAT metrics retain their source precision.
    assert clean["Probability"].iloc[0] == 33.33333339

    mysql_clean = DatabaseExporter._clean_for_sql(
        pd.DataFrame({"avg_unit_price_YTD": [35.0671875]}),
        "mysql",
    )
    assert mysql_clean["avg_unit_price_YTD"].iloc[0] == Decimal("35.067188")


def test_clean_for_sql_canonicalizes_nullable_object_decimal_metrics():
    frame = pd.DataFrame(
        {
            "perc_gross_profit_YTD": pd.Series([pd.NA, -1.5096815, 0.7078125], dtype="object"),
        }
    )

    clean = DatabaseExporter._clean_for_sql(frame)
    mysql_clean = DatabaseExporter._clean_for_sql(frame, "mysql")

    assert pd.isna(clean["perc_gross_profit_YTD"].iloc[0])
    assert clean["perc_gross_profit_YTD"].iloc[1:].tolist() == [-1.509682, 0.707813]
    assert mysql_clean["perc_gross_profit_YTD"].iloc[1:].tolist() == [
        Decimal("-1.509682"),
        Decimal("0.707813"),
    ]


def test_mysql_dtype_map_uses_decimal_for_quotation_to_sales_order_hours():
    dtype = DatabaseExporter._dtype_map(
        pd.DataFrame({"QuotationToSalesOrderHours": [74.07611111111112], "QuotationAgeHours": [25.1234567]}),
        "mysql",
    )

    assert isinstance(dtype["QuotationToSalesOrderHours"], mysql.DECIMAL)
    assert dtype["QuotationToSalesOrderHours"].precision == 20
    assert dtype["QuotationToSalesOrderHours"].scale == 6
    assert isinstance(dtype["QuotationAgeHours"], mysql.DECIMAL)
    assert dtype["QuotationAgeHours"].precision == 20
    assert dtype["QuotationAgeHours"].scale == 6


def test_clean_for_sql_treats_object_false_as_missing_odoo_text_value():
    df = pd.DataFrame({"OrderNumber": pd.Series([False, "SO100"], dtype="object")})

    clean = DatabaseExporter._clean_for_sql(df)

    assert clean["OrderNumber"].tolist() == [None, "SO100"]


def test_mysql_dtype_map_does_not_treat_target_date_as_decimal():
    dtype = DatabaseExporter._dtype_map(pd.DataFrame({"TargetDate": pd.to_datetime(["2025-12-01"])}), "mysql")

    assert not isinstance(dtype["TargetDate"], mysql.DECIMAL)
    assert mysql_type_name(dtype["TargetDate"]) == "DATE"


def test_mysql_dtype_map_does_not_treat_target_level_as_decimal():
    dtype = DatabaseExporter._dtype_map(pd.DataFrame({"TargetLevel": ["Salesperson"]}), "mysql")

    assert not isinstance(dtype["TargetLevel"], mysql.DECIMAL)
    assert mysql_type_name(dtype["TargetLevel"]) == "TEXT"


def test_mysql_dtype_map_does_not_treat_text_source_value_as_decimal():
    dtype = DatabaseExporter._dtype_map(pd.DataFrame({"SourceValue": ["RAMAD"]}), "mysql")

    assert not isinstance(dtype["SourceValue"], mysql.DECIMAL)
    assert mysql_type_name(dtype["SourceValue"]) == "TEXT"


def test_mysql_dtype_map_keeps_sales_team_business_key_as_text():
    df = pd.DataFrame(
        {
            "sales_team_key": ["MJ-EST-BB"],
            "sales_team_segment": ["EST"],
            "sales_team_city": ["Benghazi"],
            "customer_key": ["CUST-001"],
        }
    )

    dtype = DatabaseExporter._dtype_map(df, "mysql")

    for column in df.columns:
        assert not isinstance(dtype[column], mysql.BIGINT)
        assert mysql_type_name(dtype[column]) in {"VARCHAR(255)", "TEXT"}


def test_mysql_dtype_for_key_columns_is_data_aware():
    assert mysql_type_name(DatabaseExporter._mysql_dtype_for_column("sales_team_key", pd.Series(["MJ-EST-BB"]))) == "TEXT"
    assert mysql_type_name(DatabaseExporter._mysql_dtype_for_column("SalesTeamKey", pd.Series(["MJ-BEN-BC-01"]))) == "TEXT"
    assert isinstance(DatabaseExporter._mysql_dtype_for_column("CustomerKey", pd.Series([123, 456])), mysql.BIGINT)
    assert isinstance(DatabaseExporter._mysql_dtype_for_column("CustomerKey", pd.Series(["123", "456"])), mysql.BIGINT)
    assert mysql_type_name(DatabaseExporter._mysql_dtype_for_column("CustomerKey", pd.Series(["ABC", "123"]))) == "VARCHAR(255)"
    assert isinstance(DatabaseExporter._mysql_dtype_for_column("OpportunityID", pd.Series(["20", "40"])), mysql.BIGINT)
    assert mysql_type_name(DatabaseExporter._mysql_dtype_for_column("OpportunityID", pd.Series(["ETL-20", "40"]))) == "VARCHAR(255)"


def test_mysql_dtype_map_requires_allowlisted_key_values_to_be_numeric_like():
    dtype = DatabaseExporter._dtype_map(
        pd.DataFrame(
            {
                "SalesTeamKey": ["MJ-EST-BB"],
                "CustomerKey": ["123"],
                "unlisted_key": ["123"],
                "sales_team_key": pd.Series([123], dtype="Int64"),
            }
        ),
        "mysql",
    )

    assert not isinstance(dtype["SalesTeamKey"], mysql.BIGINT)
    assert isinstance(dtype["CustomerKey"], mysql.BIGINT)
    assert mysql_type_name(dtype["unlisted_key"]) == "VARCHAR(255)"
    assert not isinstance(dtype["sales_team_key"], mysql.BIGINT)
    assert mysql_type_name(dtype["sales_team_key"]) == "TEXT"


def test_mysql_dtype_map_uses_tinyint_for_boolean_columns():
    assert isinstance(DatabaseExporter._mysql_dtype_for_column("IsActive", pd.Series([0, 1])), mysql.TINYINT)
    assert isinstance(DatabaseExporter._mysql_dtype_for_column("HasOrders", pd.Series([False, True])), mysql.TINYINT)
    assert isinstance(DatabaseExporter._mysql_dtype_for_column("is_discount", pd.Series([False, True])), mysql.TINYINT)
    assert mysql_type_name(DatabaseExporter._mysql_dtype_for_column("IssueType", pd.Series(["delivery missing sales order"]))) == "TEXT"


def test_ensure_table_columns_alters_existing_mysql_bigint_business_key_to_text(monkeypatch):
    class FakeInspector:
        def get_table_names(self, schema=None):
            return ["Fact_SalesLines"]

        def get_columns(self, table_name, schema=None):
            return [{"name": "sales_team_key", "type": mysql.BIGINT()}]

    class FakeConnection:
        def __init__(self, info_schema_rows=None):
            self.statements: list[str] = []
            self.info_schema_rows = info_schema_rows or []

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def execute(self, statement, params=None):
            statement_text = str(statement)
            if statement_text.startswith("ALTER TABLE"):
                self.statements.append(statement_text)
            return FakeResult(self.info_schema_rows)

    class FakeResult:
        def __init__(self, rows):
            self.rows = rows

        def mappings(self):
            return self

        def all(self):
            return self.rows

    class FakeEngine:
        dialect = mysql.dialect()

        def __init__(self):
            self.connection = FakeConnection()

        def begin(self):
            return self.connection

        def connect(self):
            return self.connection

    fake_engine = FakeEngine()
    exporter = DatabaseExporter.__new__(DatabaseExporter)
    exporter.engine = fake_engine
    exporter.logger = database_exporter.logging.getLogger(__name__)
    monkeypatch.setattr(database_exporter, "inspect", lambda engine: FakeInspector())

    df = pd.DataFrame({"sales_team_key": ["MJ-EST-BB"]})
    dtype = DatabaseExporter._dtype_map(df, "mysql")

    exporter._ensure_table_columns("Fact_SalesLines", df, dtype)

    assert fake_engine.connection.statements == [
        "ALTER TABLE `Fact_SalesLines` MODIFY COLUMN sales_team_key TEXT NULL"
    ]


def test_ensure_table_columns_uses_information_schema_to_find_mysql_integer_business_key(monkeypatch):
    class FakeInspector:
        def get_table_names(self, schema=None):
            return ["Fact_SalesLines"]

        def get_columns(self, table_name, schema=None):
            return [{"name": "sales_team_key", "type": mysql.VARCHAR(255)}]

    class FakeResult:
        def __init__(self, rows):
            self.rows = rows

        def mappings(self):
            return self

        def all(self):
            return self.rows

    class FakeConnection:
        def __init__(self):
            self.statements: list[str] = []

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def execute(self, statement, params=None):
            statement_text = str(statement)
            if statement_text.startswith("ALTER TABLE"):
                self.statements.append(statement_text)
            return FakeResult(
                [
                    {
                        "COLUMN_NAME": "sales_team_key",
                        "DATA_TYPE": "bigint",
                        "COLUMN_TYPE": "bigint",
                    }
                ]
            )

    class FakeEngine:
        dialect = mysql.dialect()

        def __init__(self):
            self.connection = FakeConnection()

        def begin(self):
            return self.connection

        def connect(self):
            return self.connection

    fake_engine = FakeEngine()
    exporter = DatabaseExporter.__new__(DatabaseExporter)
    exporter.engine = fake_engine
    exporter.logger = database_exporter.logging.getLogger(__name__)
    monkeypatch.setattr(database_exporter, "inspect", lambda engine: FakeInspector())

    df = pd.DataFrame({"sales_team_key": ["MJ-EST-BB"]})
    dtype = DatabaseExporter._dtype_map(df, "mysql")

    exporter._ensure_table_columns("Fact_SalesLines", df, dtype)

    assert fake_engine.connection.statements == [
        "ALTER TABLE `Fact_SalesLines` MODIFY COLUMN sales_team_key TEXT NULL"
    ]


def test_ensure_table_columns_alters_mysql_decimal_and_bool_columns(monkeypatch):
    class FakeInspector:
        def get_table_names(self, schema=None):
            return ["Fact_Targets"]

        def get_columns(self, table_name, schema=None):
            return [
                {"name": "Target_Revenue", "type": mysql.DOUBLE()},
                {"name": "IsActive", "type": mysql.VARCHAR(10)},
                {"name": "TargetDate", "type": mysql.DECIMAL(20, 6)},
                {"name": "TargetLevel", "type": mysql.DECIMAL(20, 6)},
            ]

    class FakeResult:
        def __init__(self, rows):
            self.rows = rows

        def mappings(self):
            return self

        def all(self):
            return self.rows

    class FakeConnection:
        def __init__(self):
            self.statements: list[str] = []

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def execute(self, statement, params=None):
            statement_text = str(statement)
            if statement_text.startswith("ALTER TABLE"):
                self.statements.append(statement_text)
            return FakeResult(
                [
                    {"COLUMN_NAME": "Target_Revenue", "DATA_TYPE": "double", "COLUMN_TYPE": "double"},
                    {"COLUMN_NAME": "IsActive", "DATA_TYPE": "varchar", "COLUMN_TYPE": "varchar(10)"},
                    {"COLUMN_NAME": "TargetDate", "DATA_TYPE": "decimal", "COLUMN_TYPE": "decimal(20,6)"},
                    {"COLUMN_NAME": "TargetLevel", "DATA_TYPE": "decimal", "COLUMN_TYPE": "decimal(20,6)"},
                ]
            )

    class FakeEngine:
        dialect = mysql.dialect()

        def __init__(self):
            self.connection = FakeConnection()

        def begin(self):
            return self.connection

        def connect(self):
            return self.connection

    fake_engine = FakeEngine()
    exporter = DatabaseExporter.__new__(DatabaseExporter)
    exporter.engine = fake_engine
    exporter.logger = database_exporter.logging.getLogger(__name__)
    monkeypatch.setattr(database_exporter, "inspect", lambda engine: FakeInspector())

    df = pd.DataFrame(
        {
            "Target_Revenue": [100.5],
            "IsActive": [True],
            "TargetDate": pd.to_datetime(["2025-12-01"]),
            "TargetLevel": ["Salesperson"],
        }
    )
    dtype = DatabaseExporter._dtype_map(df, "mysql")

    exporter._ensure_table_columns("Fact_Targets", df, dtype)

    assert fake_engine.connection.statements == [
        "ALTER TABLE `Fact_Targets` MODIFY COLUMN `Target_Revenue` DECIMAL(20, 6) NULL",
        "ALTER TABLE `Fact_Targets` MODIFY COLUMN `IsActive` TINYINT(1) NULL",
        "ALTER TABLE `Fact_Targets` MODIFY COLUMN `TargetDate` DATE NULL",
        "ALTER TABLE `Fact_Targets` MODIFY COLUMN `TargetLevel` TEXT NULL",
    ]


def test_incremental_window_validation_compares_affected_window_not_total_table(monkeypatch):
    exporter = sqlite_exporter()
    monkeypatch.setattr(exporter, "_ensure_run_audit_table", lambda: None)
    monkeypatch.setattr(exporter, "_ensure_load_metadata_table", lambda: None)
    monkeypatch.setattr(exporter, "_drop_retired_fact_tables", lambda: None)
    pd.DataFrame(
        [
            {"order_number": "SO100", "order_date": "2026-05-01", "Value": 10.0},
        ]
    ).to_sql("Fact_SalesLines", exporter.engine, if_exists="replace", index=False)
    changed_window = pd.DataFrame(
        [
            {"order_number": "SO200", "order_date": "2026-05-18", "Value": 20.0},
        ]
    )

    result = exporter.export_incremental({"Fact_SalesLines": changed_window}, pd.Timestamp("2026-05-17"))
    row = result.validation.iloc[0]

    assert bool(row["Matches"])
    assert row["LoadMode"] == "incremental"
    assert row["ValidationScope"] == "date_window:order_date"
    assert row["ExpectedRows"] == 1
    assert row["SQLRows"] == 1
    assert result.table_counts["Fact_SalesLines"] == 2


def test_incremental_fact_orders_removes_older_duplicate_rows_after_overlap_moves_past_key(monkeypatch):
    exporter = sqlite_exporter()
    monkeypatch.setattr(exporter, "_ensure_run_audit_table", lambda: None)
    monkeypatch.setattr(exporter, "_ensure_load_metadata_table", lambda: None)
    monkeypatch.setattr(exporter, "_drop_retired_fact_tables", lambda: None)
    pd.DataFrame(
        [
            {"order_number": "S24849", "OrderDateTime": "2024-10-14 12:39:13", "OrderValue": 4920.0},
            {"order_number": "S24849", "OrderDateTime": "2026-06-21 11:57:36", "OrderValue": 3024.0},
            {"order_number": "S24870", "OrderDateTime": "2024-10-19 10:24:57", "OrderValue": 1355.0},
            {"order_number": "S24870", "OrderDateTime": "2026-06-21 13:03:15", "OrderValue": 84.0},
        ]
    ).to_sql("Fact_Orders", exporter.engine, if_exists="replace", index=False)
    current_model = pd.DataFrame(
        [
            {"order_number": "S30000", "OrderDateTime": "2026-06-20 10:00:00", "OrderValue": 1.0},
        ]
    )

    result = exporter.export_incremental({"Fact_Orders": current_model}, pd.Timestamp("2026-06-22"))
    sql_orders = pd.read_sql_table("Fact_Orders", exporter.engine)

    assert bool(result.validation.iloc[0]["Matches"])
    assert result.validation.iloc[0]["ExpectedRows"] == 0
    assert result.validation.iloc[0]["SQLRows"] == 0
    assert result.table_counts["Fact_Orders"] == 2
    assert not sql_orders["order_number"].duplicated().any()
    assert set(sql_orders["OrderValue"].astype(float)) == {3024.0, 84.0}


def test_mysql_window_delete_uses_batches_and_commits_per_batch(monkeypatch, caplog):
    exporter = DatabaseExporter.__new__(DatabaseExporter)
    exporter.settings = SimpleNamespace(db_chunksize=1000, db_reload_mode="drop_recreate")
    exporter.logger = database_exporter.logging.getLogger(__name__)
    exporter.engine = FakeMySQLEngine([5000, 1234, 0])
    monkeypatch.setattr(exporter, "_quoted_table_name", lambda table_name: "fact_sales")

    with caplog.at_level(database_exporter.logging.INFO):
        deleted = exporter._delete_window_rows_batched("Fact_Sales", "OrderDateTime", pd.Timestamp("2026-05-17").to_pydatetime())

    assert deleted == 6234
    assert exporter.engine.connection.execute_count == 3
    assert all("LIMIT" in statement for statement in exporter.engine.connection.statements)
    assert exporter.engine.connection.params[0]["batch_size"] == 5000
    assert "Incremental SQL Fact_Sales delete batch rows=5000 batch=1" in caplog.text
    assert "Incremental SQL Fact_Sales delete batch rows=1234 batch=2" in caplog.text
    assert "Incremental SQL Fact_Sales delete completed rows=6234 batches=3" in caplog.text


def test_mysql_window_delete_retries_transient_lock_timeout(monkeypatch):
    exporter = DatabaseExporter.__new__(DatabaseExporter)
    exporter.settings = SimpleNamespace(db_chunksize=1000, db_reload_mode="drop_recreate")
    exporter.logger = database_exporter.logging.getLogger(__name__)
    exporter.engine = FakeMySQLEngine([10, 0], failures_before_success=1)
    monkeypatch.setattr(exporter, "_quoted_table_name", lambda table_name: "fact_sales")
    monkeypatch.setattr(database_exporter.time, "sleep", lambda seconds: None)

    deleted = exporter._delete_window_rows_batched("Fact_Sales", "OrderDateTime", pd.Timestamp("2026-05-17").to_pydatetime())

    assert deleted == 10
    assert exporter.engine.connection.execute_count == 3


def test_incremental_key_validation_compares_affected_keys_not_total_table(monkeypatch, caplog):
    exporter = sqlite_exporter()
    monkeypatch.setattr(exporter, "_ensure_run_audit_table", lambda: None)
    monkeypatch.setattr(exporter, "_ensure_load_metadata_table", lambda: None)
    monkeypatch.setattr(exporter, "_drop_retired_fact_tables", lambda: None)
    pd.DataFrame(
        [
            {"CustomerKey": "C100", "Customer": "Old customer"},
            {"CustomerKey": "C200", "Customer": "Before update"},
        ]
    ).to_sql("Dim_Customer", exporter.engine, if_exists="replace", index=False)
    changed_customer = pd.DataFrame([{"CustomerKey": "C200", "Customer": "After update"}])

    with caplog.at_level(database_exporter.logging.INFO):
        result = exporter.export_incremental({"Dim_Customer": changed_customer}, pd.Timestamp("2026-05-17"))
    row = result.validation.iloc[0]

    assert bool(row["Matches"])
    assert row["LoadMode"] == "incremental"
    assert row["ValidationScope"] == "key_set:CustomerKey"
    assert row["ExpectedRows"] == 1
    assert row["SQLRows"] == 1
    assert result.table_counts["Dim_Customer"] == 2
    assert "Dim_Customer: starting stale cleanup" not in caplog.text
    assert "Dim_Customer: deleted stale rows" not in caplog.text


def test_sql_row_count_error_message_lists_mismatched_tables():
    validation = pd.DataFrame(
        [
            {
                "TableName": "Fact_SalesLines",
                "LoadMode": "incremental",
                "ValidationScope": "date_window:order_date",
                "ExportRows": 7,
                "ExpectedRows": 3,
                "SQLRows": 2,
                "Matches": False,
                "Difference": -1,
            }
        ]
    )
    result = SQLExportResult(table_counts={"Fact_SalesLines": 10}, validation=validation)

    message = PowerBISalesPipeline._sql_row_count_error_message(result)

    assert "Fact_SalesLines" in message
    assert "expected=3" in message
    assert "sql=2" in message
    assert "diff=-1" in message
    assert "load_mode=incremental" in message
    assert "scope=date_window:order_date" in message


def test_incremental_fact_lead_removes_stale_rows_not_in_current_export(monkeypatch, caplog):
    exporter = sqlite_exporter()
    monkeypatch.setattr(exporter, "_ensure_run_audit_table", lambda: None)
    monkeypatch.setattr(exporter, "_ensure_load_metadata_table", lambda: None)
    monkeypatch.setattr(exporter, "_drop_retired_fact_tables", lambda: None)
    pd.DataFrame(
        [
            {"LeadID": "L100", "LeadName": "Current lead"},
            {"LeadID": "L999", "LeadName": "Stale lead"},
        ]
    ).to_sql("Fact_Lead", exporter.engine, if_exists="replace", index=False)
    current = pd.DataFrame([{"LeadID": "L100", "LeadName": "Current lead updated"}])

    with caplog.at_level(database_exporter.logging.INFO):
        result = exporter.export_incremental({"Fact_Lead": current}, pd.Timestamp("2026-05-17"))
    sql = pd.read_sql_table("Fact_Lead", exporter.engine)

    assert result.table_counts["Fact_Lead"] == 1
    assert sql["LeadID"].tolist() == ["L100"]
    assert result.validation.iloc[0]["SQLRows"] == 1
    assert "Incremental SQL Fact_Lead: starting stale cleanup key=LeadID" in caplog.text
    assert "Incremental SQL Fact_Lead: deleted stale rows=1 key=LeadID duration_seconds=" in caplog.text


def test_incremental_fact_opportunity_removes_stale_rows_not_in_current_export(monkeypatch):
    exporter = sqlite_exporter()
    monkeypatch.setattr(exporter, "_ensure_run_audit_table", lambda: None)
    monkeypatch.setattr(exporter, "_ensure_load_metadata_table", lambda: None)
    monkeypatch.setattr(exporter, "_drop_retired_fact_tables", lambda: None)
    pd.DataFrame(
        [
            {"OpportunityID": 200, "OpportunityName": "Current opportunity"},
            {"OpportunityID": 999, "OpportunityName": "Stale opportunity"},
        ]
    ).to_sql("Fact_Opportunity", exporter.engine, if_exists="replace", index=False)
    current = pd.DataFrame([{"OpportunityID": 200, "OpportunityName": "Current opportunity updated"}])

    result = exporter.export_incremental({"Fact_Opportunity": current}, pd.Timestamp("2026-05-17"))
    sql = pd.read_sql_table("Fact_Opportunity", exporter.engine)

    assert result.table_counts["Fact_Opportunity"] == 1
    assert sql["OpportunityID"].tolist() == [200]
    assert result.validation.iloc[0]["SQLRows"] == 1


def test_incremental_fact_sales_replaces_full_table_without_window_delete_or_stale_cleanup(monkeypatch, caplog):
    exporter = sqlite_exporter()
    monkeypatch.setattr(exporter, "_ensure_run_audit_table", lambda: None)
    monkeypatch.setattr(exporter, "_ensure_load_metadata_table", lambda: None)
    monkeypatch.setattr(exporter, "_drop_retired_fact_tables", lambda: None)
    pd.DataFrame(
        [
            {"SalesDocumentID": 100, "OrderNumber": "SO100", "OrderDateTime": "2026-05-01", "OrderValue": 10.0},
            {"SalesDocumentID": 101, "OrderNumber": "SO101", "OrderDateTime": "2026-05-01", "OrderValue": 11.0},
            {"SalesDocumentID": 200, "OrderNumber": "SO200", "OrderDateTime": "2026-05-18", "OrderValue": 12.0},
        ]
    ).to_sql("Fact_Sales", exporter.engine, if_exists="replace", index=False)
    current = pd.DataFrame(
        [
            {"SalesDocumentID": 101, "OrderNumber": "SO101", "OrderDateTime": "2026-05-01", "OrderValue": 11.0},
            {"SalesDocumentID": 200, "OrderNumber": "SO200", "OrderDateTime": "2026-05-18", "OrderValue": 20.0},
        ]
    )

    with caplog.at_level(database_exporter.logging.INFO):
        result = exporter.export_incremental({"Fact_Sales": current}, pd.Timestamp("2026-05-17"))
    sql = pd.read_sql_table("Fact_Sales", exporter.engine).sort_values("SalesDocumentID").reset_index(drop=True)

    assert result.table_counts["Fact_Sales"] == 2
    assert sql["SalesDocumentID"].tolist() == [101, 200]
    assert sql["OrderValue"].tolist() == [11.0, 20.0]
    assert result.validation.iloc[0]["ValidationScope"] == "full_table_replaced"
    assert result.validation.iloc[0]["ExpectedRows"] == 2
    assert result.validation.iloc[0]["SQLRows"] == 2
    assert "Replacing SQL table Fact_Sales rows=2 in incremental mode" in caplog.text
    assert "Fact_Sales delete batch" not in caplog.text
    assert "Fact_Sales: starting stale cleanup" not in caplog.text


def test_incremental_fact_sales_skips_full_replace_when_fingerprint_unchanged(monkeypatch, caplog):
    exporter = sqlite_exporter()
    monkeypatch.setattr(exporter, "_ensure_run_audit_table", lambda: None)
    monkeypatch.setattr(exporter, "_ensure_load_metadata_table", lambda: None)
    monkeypatch.setattr(exporter, "_drop_retired_fact_tables", lambda: None)
    metadata: dict[str, dict[str, object]] = {}
    monkeypatch.setattr(exporter, "get_load_metadata", lambda source_name: metadata.get(source_name))
    monkeypatch.setattr(
        exporter,
        "upsert_load_metadata",
        lambda **kwargs: metadata.__setitem__(
            kwargs["source_name"],
            {"checksum": kwargs["checksum"], "file_size": kwargs["file_size"], "status": kwargs["status"]},
        ),
    )
    current = pd.DataFrame(
        [
            {"SalesDocumentID": 101, "OrderNumber": "SO101", "OrderDateTime": "2026-05-01", "OrderValue": 11.0},
            {"SalesDocumentID": 200, "OrderNumber": "SO200", "OrderDateTime": "2026-05-18", "OrderValue": 20.0},
        ]
    )
    exporter.export_incremental({"Fact_Sales": current}, pd.Timestamp("2026-05-17"))

    with caplog.at_level(database_exporter.logging.INFO):
        result = exporter.export_incremental({"Fact_Sales": current}, pd.Timestamp("2026-05-17"))

    assert result.table_counts["Fact_Sales"] == 2
    assert result.validation.iloc[0]["ValidationScope"] == "full_table_unchanged_skipped"
    assert "Skipping unchanged SQL table Fact_Sales rows=2 in incremental mode" in caplog.text


def test_incremental_fact_sales_replaces_when_metadata_is_unchanged_but_sql_values_drifted(monkeypatch, caplog):
    exporter = sqlite_exporter()
    monkeypatch.setattr(exporter, "_ensure_run_audit_table", lambda: None)
    monkeypatch.setattr(exporter, "_ensure_load_metadata_table", lambda: None)
    monkeypatch.setattr(exporter, "_drop_retired_fact_tables", lambda: None)
    current = pd.DataFrame(
        [
            {"SalesDocumentID": 101, "OrderNumber": "SO101", "OrderDateTime": "2026-05-01", "OrderValue": 11.0},
            {"SalesDocumentID": 200, "OrderNumber": "SO200", "OrderDateTime": "2026-05-18", "OrderValue": 20.0},
        ]
    )
    stale_sql = current.copy()
    stale_sql.loc[stale_sql["SalesDocumentID"] == 200, "OrderValue"] = 12.0
    stale_sql.to_sql("Fact_Sales", exporter.engine, if_exists="replace", index=False)
    metadata = {
        "sql_table:Fact_Sales": {
            "checksum": DatabaseExporter._dataframe_fingerprint(current),
            "file_size": len(current),
            "status": "SUCCESS",
        }
    }
    monkeypatch.setattr(exporter, "get_load_metadata", lambda source_name: metadata.get(source_name))
    monkeypatch.setattr(
        exporter,
        "upsert_load_metadata",
        lambda **kwargs: metadata.__setitem__(
            kwargs["source_name"],
            {"checksum": kwargs["checksum"], "file_size": kwargs["file_size"], "status": kwargs["status"]},
        ),
    )

    with caplog.at_level(database_exporter.logging.INFO):
        result = exporter.export_incremental({"Fact_Sales": current}, pd.Timestamp("2026-05-17"))
    sql = pd.read_sql_table("Fact_Sales", exporter.engine).sort_values("SalesDocumentID").reset_index(drop=True)

    assert result.validation.iloc[0]["ValidationScope"] == "full_table_replaced"
    assert sql["OrderValue"].astype(float).tolist() == [11.0, 20.0]
    assert "stored rows differ; replacing table" in caplog.text


def test_incremental_fact_delivery_skips_full_replace_when_fingerprint_unchanged(monkeypatch, caplog):
    exporter = sqlite_exporter()
    monkeypatch.setattr(exporter, "_ensure_run_audit_table", lambda: None)
    monkeypatch.setattr(exporter, "_ensure_load_metadata_table", lambda: None)
    monkeypatch.setattr(exporter, "_drop_retired_fact_tables", lambda: None)
    metadata: dict[str, dict[str, object]] = {}
    monkeypatch.setattr(exporter, "get_load_metadata", lambda source_name: metadata.get(source_name))
    monkeypatch.setattr(
        exporter,
        "upsert_load_metadata",
        lambda **kwargs: metadata.__setitem__(
            kwargs["source_name"],
            {"checksum": kwargs["checksum"], "file_size": kwargs["file_size"], "status": kwargs["status"]},
        ),
    )
    current = pd.DataFrame(
        [
            {"DeliveryID": 1, "ScheduledDate": "2026-05-18", "DeliveryStatus": "Done"},
        ]
    )
    exporter.export_incremental({"Fact_Delivery": current}, pd.Timestamp("2026-05-17"))

    with caplog.at_level(database_exporter.logging.INFO):
        result = exporter.export_incremental({"Fact_Delivery": current}, pd.Timestamp("2026-05-17"))

    assert result.table_counts["Fact_Delivery"] == 1
    assert result.validation.iloc[0]["ValidationScope"] == "full_table_unchanged_skipped"
    assert "Skipping unchanged SQL table Fact_Delivery rows=1 in incremental mode" in caplog.text


def test_fact_sales_duplicate_key_diagnostics_warns_for_unsafe_candidates(caplog):
    exporter = sqlite_exporter()
    fact_sales = pd.DataFrame(
        [
            {"SalesDocumentID": 100, "SalesOrderID": 10, "OrderNumber": "SO10"},
            {"SalesDocumentID": 100, "SalesOrderID": 10, "OrderNumber": "SO10"},
            {"SalesDocumentID": 101, "SalesOrderID": pd.NA, "OrderNumber": "SO11"},
        ]
    )

    with caplog.at_level(database_exporter.logging.WARNING):
        exporter._log_fact_sales_duplicate_key_diagnostics(fact_sales)

    assert "Fact_Sales key diagnostic: SalesDocumentID duplicate_rows=2" in caplog.text
    assert "Fact_Sales key diagnostic: SalesOrderID duplicate_rows=2" in caplog.text
    assert "null_rows=1" in caplog.text


def test_numeric_validation_normalizes_decimal_and_float_precision():
    left, right = normalize_pair(
        pd.Series([57429.76, 28131.84]),
        pd.Series([Decimal("57429.760000"), Decimal("28131.840000")]),
        "InvoiceValue",
    )

    assert left == right


def test_boolean_semantic_columns_normalize_mysql_tinyint_values():
    left, right = normalize_pair(
        pd.Series([False, True], dtype="boolean"),
        pd.Series([0, 1], dtype="Int64"),
        "IsOpen",
    )

    assert left == right == ["false", "true"]


def test_count_column_remains_numeric_not_boolean():
    left, right = normalize_pair(pd.Series([1, 0]), pd.Series([1.0, 0.0]), "Count")

    assert left == right == ["1", "0"]


def test_datetime_validation_ignores_backend_precision_difference():
    left, right = normalize_pair(
        pd.Series(pd.to_datetime(["2026-05-04 10:11:12.123456789"])),
        pd.Series(pd.to_datetime(["2026-05-04 10:11:12.123456"])),
        "OrderDateTime",
    )

    assert left == right == ["2026-05-04 10:11:12"]
