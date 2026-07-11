from __future__ import annotations

import logging
import os
from pathlib import Path

import pandas as pd
import pytest

from config.settings import Settings
from sales_pipeline.pipeline import PowerBISalesPipeline
from sales_pipeline.reference_cache import ReferenceDataCache
from sales_pipeline.validation import ModelValidator


def test_reference_cache_reuses_value_until_source_changes(tmp_path: Path) -> None:
    source = tmp_path / "source.xlsx"
    source.write_bytes(b"v1")
    calls = 0

    def loader() -> pd.DataFrame:
        nonlocal calls
        calls += 1
        return pd.DataFrame({"value": [calls]})

    cache = ReferenceDataCache(tmp_path / "cache")
    first = cache.load("source", source, loader)
    second = cache.load("source", source, loader)

    assert calls == 1
    pd.testing.assert_frame_equal(first, second)

    source.write_bytes(b"version-two")
    third = cache.load("source", source, loader)
    assert calls == 2
    assert third.iloc[0, 0] == 2


def test_reference_cache_uses_content_hash_not_modified_time(tmp_path: Path) -> None:
    source = tmp_path / "sales_targets.xlsx"
    source.write_bytes(b"same-content")
    calls = 0

    def loader() -> pd.DataFrame:
        nonlocal calls
        calls += 1
        return pd.DataFrame({"value": [calls]})

    cache = ReferenceDataCache(tmp_path / "cache")
    first = cache.load("targets", source, loader)
    os.utime(source, (source.stat().st_atime + 60, source.stat().st_mtime + 60))
    second = cache.load("targets", source, loader)

    assert calls == 1
    pd.testing.assert_frame_equal(first, second)


def test_reference_cache_metadata_is_updated_after_successful_load_only(tmp_path: Path) -> None:
    source = tmp_path / "PRODUCTS.xlsx"
    source.write_bytes(b"products")
    cache_dir = tmp_path / "cache"
    cache = ReferenceDataCache(cache_dir)

    def failing_loader() -> pd.DataFrame:
        raise RuntimeError("load failed")

    with pytest.raises(RuntimeError, match="load failed"):
        cache.load("product_master", source, failing_loader)

    assert not list(cache_dir.glob("*"))

    cache.load("product_master", source, lambda: pd.DataFrame({"ok": [1]}))
    assert (cache_dir / "product_master.pickle").exists()


class _FakeMetadataExporter:
    def __init__(self, previous: dict[str, dict[str, object]] | None = None) -> None:
        self.previous = previous or {}
        self.upserts: list[dict[str, object]] = []

    def get_load_metadata(self, source_name: str) -> dict[str, object] | None:
        return self.previous.get(source_name)

    def upsert_load_metadata(self, **kwargs: object) -> None:
        self.upserts.append(kwargs)


def _settings_for_input_dir(tmp_path: Path) -> Settings:
    input_dir = tmp_path / "Input"
    output_dir = tmp_path / "Exports"
    input_dir.mkdir()
    output_dir.mkdir()
    return Settings(
        odoo_url="http://example.test",
        odoo_db="db",
        odoo_user="user",
        odoo_api_key="key",
        input_dir=input_dir,
        output_dir=output_dir,
        output_file="SalesModel_OneOutput.xlsx",
        batch_size=10,
        timezone="Africa/Tripoli",
        assume_utc_for_naive=False,
        db_type="sqlite",
        db_url=f"sqlite:///{output_dir / 'test.db'}",
    )


def _write_required_input_files(settings: Settings) -> None:
    for path in [
        settings.targets_path,
        settings.sales_team_path,
        settings.offdays_path,
        settings.products_path,
        settings.blocked_customers_path,
    ]:
        path.write_bytes(f"{path.name}:v1".encode("utf-8"))


def test_full_mode_does_not_force_unchanged_excel_reload(tmp_path: Path, caplog) -> None:
    settings = _settings_for_input_dir(tmp_path)
    _write_required_input_files(settings)
    pipeline = PowerBISalesPipeline(settings)
    previous = {
        name: pipeline._file_metadata(path)
        for name, path in pipeline._excel_source_paths().items()
    }

    caplog.set_level(logging.INFO, logger="sales_pipeline.pipeline")
    pipeline._audit_excel_sources(_FakeMetadataExporter(previous), load_mode="full")

    assert "sales_targets.xlsx unchanged; skipping Excel reload" in caplog.text
    assert "changed or full mode" not in caplog.text


def test_modified_target_file_is_detected_and_metadata_updates_after_success(tmp_path: Path, caplog) -> None:
    settings = _settings_for_input_dir(tmp_path)
    _write_required_input_files(settings)
    pipeline = PowerBISalesPipeline(settings)
    previous = {
        name: pipeline._file_metadata(path)
        for name, path in pipeline._excel_source_paths().items()
    }
    settings.targets_path.write_bytes(b"sales_targets.xlsx:v2")
    exporter = _FakeMetadataExporter(previous)

    caplog.set_level(logging.INFO, logger="sales_pipeline.pipeline")
    pipeline._audit_excel_sources(exporter, load_mode="full")
    assert "sales_targets.xlsx changed; current file will be loaded" in caplog.text

    assert exporter.upserts == []
    pipeline._write_excel_source_metadata(exporter, load_mode="full")
    target_upsert = next(item for item in exporter.upserts if item["source_name"] == "sales_targets.xlsx")
    assert target_upsert["checksum"] == pipeline._file_metadata(settings.targets_path)["checksum"]


def test_model_validator_reports_duplicate_and_null_keys() -> None:
    issues = ModelValidator.validate(
        {"Dim_Date": pd.DataFrame({"DateKey": [20260101, 20260101, pd.NA]})},
        strict=True,
    )

    date_issues = {(issue.check, issue.severity) for issue in issues if issue.table == "Dim_Date"}
    assert ("duplicate_key", "ERROR") in date_issues
    assert ("null_key", "ERROR") in date_issues


def test_model_validator_null_keys_are_warnings_outside_strict_mode() -> None:
    issues = ModelValidator.validate(
        {"Dim_Date": pd.DataFrame({"DateKey": [20260101, pd.NA]})},
        strict=False,
    )

    null_issue = next(issue for issue in issues if issue.table == "Dim_Date" and issue.check == "null_key")
    assert null_issue.severity == "WARNING"


def test_validation_manifest_detects_schema_row_and_kpi_changes(tmp_path: Path) -> None:
    baseline = ModelValidator.manifest({"Fact_SalesLines": pd.DataFrame({"Value": [10.0], "DateKey": [20260101]})})
    path = tmp_path / "baseline.json"
    ModelValidator.write_manifest(path, baseline)
    current = ModelValidator.manifest({"Fact_SalesLines": pd.DataFrame({"Value": [11.0, 2.0], "Other": [1, 2]})})

    differences = ModelValidator.compare_manifest(path, current)

    assert any("schema changed" in item for item in differences)
    assert any("rows baseline=1 current=2" in item for item in differences)
    assert any("KPI totals changed" in item for item in differences)
