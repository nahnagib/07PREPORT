from __future__ import annotations

from pathlib import Path

from sqlalchemy import text

from config.settings import Settings
from sales_pipeline.export import DatabaseExporter
from sales_pipeline.pipeline import PowerBISalesPipeline


def _settings() -> Settings:
    return Settings(
        odoo_url="x",
        odoo_db="x",
        odoo_user="x",
        odoo_api_key="x",
        input_dir=Path("Input"),
        output_dir=Path("Exports"),
        output_file="out.xlsx",
        batch_size=100,
        timezone="Africa/Tripoli",
        assume_utc_for_naive=False,
        db_url="sqlite+pysqlite:///:memory:",
    )


def _seed_common_tables(exporter: DatabaseExporter) -> None:
    with exporter.engine.begin() as conn:
        conn.execute(
            text(
                """
                CREATE TABLE raw_sale_order (
                    id INTEGER,
                    name TEXT,
                    date_order TEXT,
                    state TEXT,
                    invoice_status TEXT,
                    amount_total REAL
                )
                """
            )
        )
        conn.execute(
            text(
                """
                INSERT INTO raw_sale_order (id, name, date_order, state, invoice_status, amount_total)
                VALUES (101, 'SO101', '2026-05-18 10:00:00', 'sale', 'invoiced', 125.0)
                """
            )
        )
        conn.execute(
            text(
                """
                CREATE TABLE raw_sale_order_line (
                    id INTEGER,
                    order_id_id INTEGER,
                    price_total REAL
                )
                """
            )
        )
        conn.execute(text("INSERT INTO raw_sale_order_line (id, order_id_id, price_total) VALUES (1, 101, 125.0)"))
        conn.execute(
            text(
                """
                CREATE TABLE Fact_Orders (
                    order_number TEXT,
                    OrderDateTime TEXT,
                    OrderValue REAL
                )
                """
            )
        )
        conn.execute(text("INSERT INTO Fact_Orders (order_number, OrderDateTime, OrderValue) VALUES ('SO101', '2026-05-18 12:00:00', 125.0)"))
        conn.execute(
            text(
                """
                CREATE TABLE Fact_SalesLines (
                    order_number TEXT,
                    order_date TEXT,
                    Value REAL
                )
                """
            )
        )
        conn.execute(text("INSERT INTO Fact_SalesLines (order_number, order_date, Value) VALUES ('SO101', '2026-05-18', 125.0)"))


def _pipeline(settings: Settings) -> PowerBISalesPipeline:
    pipeline = PowerBISalesPipeline(settings)
    pipeline._latest_odoo_sale_order_end = {
        "id": 101,
        "name": "SO101",
        "date_order": "2026-05-18 10:00:00",
        "state": "sale",
        "invoice_status": "invoiced",
    }
    return pipeline


def test_sales_freshness_uses_existing_fact_sales_identifier_column() -> None:
    settings = _settings()
    exporter = DatabaseExporter(settings)
    _seed_common_tables(exporter)
    with exporter.engine.begin() as conn:
        conn.execute(
            text(
                """
                CREATE TABLE Fact_Sales (
                    SalesOrderID INTEGER,
                    OrderDateTime TEXT,
                    OrderValue REAL
                )
                """
            )
        )
        conn.execute(text("INSERT INTO Fact_Sales (SalesOrderID, OrderDateTime, OrderValue) VALUES (101, '2026-05-18 12:00:00', 125.0)"))

    _pipeline(settings)._validate_sales_freshness(exporter)


def test_sales_freshness_falls_back_to_latest_date_without_identifier_column() -> None:
    settings = _settings()
    exporter = DatabaseExporter(settings)
    _seed_common_tables(exporter)
    with exporter.engine.begin() as conn:
        conn.execute(
            text(
                """
                CREATE TABLE Fact_Sales (
                    OrderDateTime TEXT,
                    OrderValue REAL
                )
                """
            )
        )
        conn.execute(text("INSERT INTO Fact_Sales (OrderDateTime, OrderValue) VALUES ('2026-05-18 12:00:00', 125.0)"))

    _pipeline(settings)._validate_sales_freshness(exporter)
