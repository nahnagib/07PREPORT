"""Input-directory resolution/validation, the fail-fast pipeline step, and the product mapper's
loud failures. Uses real .xlsx files (openpyxl via pandas) rather than mocks, since 'is this a valid
workbook' is exactly what is being checked."""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

import pandas as pd
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))

from config import input_check  # noqa: E402
from config.input_check import (  # noqa: E402
    REQUIRED_INPUT_FILES,
    InputConfigError,
    InputValidationError,
    format_report,
    inspect_input_dir,
    resolve_dir,
)
from config.settings import Settings  # noqa: E402
from sales_pipeline.pipeline import PowerBISalesPipeline  # noqa: E402
from sales_pipeline.product_name_mapper import ProductMappingError, ProductNameMapper  # noqa: E402


def _write_workbooks(folder: Path, names=REQUIRED_INPUT_FILES) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    for name in names:
        if name == "PRODUCTS.xlsx":
            df = pd.DataFrame({"OdooProductName": ["Odoo A", "Odoo B"], "ProductName": ["Clean A", "Clean B"]})
        else:
            df = pd.DataFrame({"x": [1]})
        df.to_excel(folder / name, index=False)
    pd.DataFrame({"x": [1]}).to_excel(folder / "BlockedCustomers.xlsx", index=False)


def _settings(input_dir: Path, output_dir: Path) -> Settings:
    return Settings(
        odoo_url="x", odoo_db="x", odoo_user="x", odoo_api_key="x",
        input_dir=input_dir, output_dir=output_dir, output_file="out.xlsx",
        batch_size=100, timezone="Africa/Tripoli", assume_utc_for_naive=False,
    )


def test_all_files_present_is_ok(tmp_path):
    _write_workbooks(tmp_path)
    report = inspect_input_dir(tmp_path)
    assert report.ok and report.hint == ""
    assert all(f.status == "ok" and f.size_bytes and f.modified for f in report.files)


def test_one_missing_file_is_named_and_explained(tmp_path):
    _write_workbooks(tmp_path, names=[n for n in REQUIRED_INPUT_FILES if n != "OffDays.xlsx"])
    report = inspect_input_dir(tmp_path)
    assert not report.ok
    text = format_report(report)
    assert "[MISSING    ] OffDays.xlsx" in text
    assert str(tmp_path.resolve()) in text and "exists=True" in text
    assert "[OK         ] PRODUCTS.xlsx" in text
    assert "Hint:" in text


def test_wrong_case_file_name_gets_a_near_match_hint(tmp_path):
    _write_workbooks(tmp_path, names=[n for n in REQUIRED_INPUT_FILES if n != "PRODUCTS.xlsx"])
    pd.DataFrame({"x": [1]}).to_excel(tmp_path / "Products.xlsx", index=False)
    report = inspect_input_dir(tmp_path)
    products = next(f for f in report.files if f.name == "PRODUCTS.xlsx")
    assert products.status == "missing" and products.near_matches == ["Products.xlsx"]
    assert "exact file name 'PRODUCTS.xlsx'" in products.detail
    assert "different name or letter case" in report.hint


def test_empty_directory_is_reported_as_empty_or_unmounted(tmp_path):
    report = inspect_input_dir(tmp_path)
    assert not report.ok and report.listing == []
    assert "empty" in report.hint and "mounted" in report.hint
    assert "Directory contains: (empty)" in format_report(report)


def test_nonexistent_directory(tmp_path):
    report = inspect_input_dir(tmp_path / "nope")
    assert not report.ok and not report.dir_exists
    assert "does not exist" in report.hint and "ETL_INPUT_HOST_DIR" in report.hint


def test_corrupt_xlsx_is_invalid_not_ok(tmp_path):
    _write_workbooks(tmp_path)
    (tmp_path / "SalesTeam.xlsx").write_bytes(b"this is not a workbook")
    report = inspect_input_dir(tmp_path)
    sales_team = next(f for f in report.files if f.name == "SalesTeam.xlsx")
    assert sales_team.status == "invalid_xlsx" and not report.ok
    assert "not a readable .xlsx" in report.hint


def test_truncated_xlsx_is_invalid(tmp_path):
    _write_workbooks(tmp_path)
    good = (tmp_path / "OffDays.xlsx").read_bytes()
    (tmp_path / "OffDays.xlsx").write_bytes(good[: len(good) // 2])
    assert next(f for f in inspect_input_dir(tmp_path).files if f.name == "OffDays.xlsx").status == "invalid_xlsx"


def test_listing_is_capped(tmp_path):
    for i in range(30):
        (tmp_path / f"file_{i:02}.txt").write_text("x")
    report = inspect_input_dir(tmp_path)
    assert len(report.listing) == 20 and report.listing_truncated


@pytest.mark.skipif(os.name == "nt", reason="the Windows-path-on-Linux guard only applies to POSIX runtimes")
def test_windows_path_on_linux_fails_fast_with_the_fix():
    with pytest.raises(InputConfigError) as exc:
        resolve_dir("C:/Users/Lenovo/Desktop/07PREPORT/Input", "ETL_INPUT_DIR")
    message = str(exc.value)
    assert "Windows path" in message and "ETL_INPUT_HOST_DIR" in message and "/mnt/c/" in message
    with pytest.raises(InputConfigError):
        resolve_dir("C:\\data\\Input", "ETL_INPUT_DIR")


def test_relative_values_resolve_against_etl_root_not_cwd(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    assert resolve_dir("input", "ETL_INPUT_DIR") == (input_check.ETL_ROOT / "input").resolve()


def test_settings_prefers_etl_input_dir_over_legacy_and_defaults_inside_repo(tmp_path, monkeypatch):
    monkeypatch.setenv("INPUT_DIR", str(tmp_path / "legacy"))
    monkeypatch.setenv("ETL_INPUT_DIR", str(tmp_path / "new"))
    monkeypatch.setattr("config.settings.load_dotenv", lambda *_a, **_k: None)
    assert Settings.from_env().input_dir == (tmp_path / "new").resolve()
    monkeypatch.delenv("ETL_INPUT_DIR")
    monkeypatch.delenv("INPUT_DIR")
    assert Settings.from_env().input_dir == input_check.DEFAULT_INPUT_DIR.resolve()


def test_check_writable(tmp_path):
    assert input_check.check_writable(tmp_path / "out")[0] is True
    (tmp_path / "file").write_text("x")
    ok, detail = input_check.check_writable(tmp_path / "file" / "sub")
    assert ok is False and detail


# --- the pipeline step ------------------------------------------------------------------------


def test_pipeline_constructor_no_longer_touches_input_files(tmp_path):
    PowerBISalesPipeline(_settings(tmp_path / "does-not-exist", tmp_path / "out"))  # must not raise


def test_pipeline_validation_fails_with_full_report_and_never_builds_the_mapper(tmp_path, caplog):
    pipeline = PowerBISalesPipeline(_settings(tmp_path / "in", tmp_path / "out"))
    with caplog.at_level(logging.INFO), pytest.raises(InputValidationError) as exc:
        pipeline._validate_inputs()
    assert "PRODUCTS.xlsx" in str(exc.value) and str((tmp_path / "in").resolve()) in str(exc.value)
    assert pipeline._mapper is None
    assert "ProductNameMapper ready" not in caplog.text


def test_pipeline_validation_passes_and_mapper_loads_real_mappings(tmp_path):
    _write_workbooks(tmp_path / "in")
    pipeline = PowerBISalesPipeline(_settings(tmp_path / "in", tmp_path / "out"))
    pipeline._validate_inputs()
    assert pipeline.mapper.mapping_count() == 2


def test_missing_blocked_customers_on_a_readonly_folder_explains_itself(tmp_path, monkeypatch):
    _write_workbooks(tmp_path / "in")
    (tmp_path / "in" / "BlockedCustomers.xlsx").unlink()
    pipeline = PowerBISalesPipeline(_settings(tmp_path / "in", tmp_path / "out"))

    def _boom(*_a, **_k):
        raise PermissionError("read-only file system")

    monkeypatch.setattr("sales_pipeline.pipeline.BlockedCustomersLoader.export_template", _boom)
    with pytest.raises(RuntimeError, match="read-only"):
        pipeline._validate_inputs()


# --- ProductNameMapper -------------------------------------------------------------------------


def test_mapper_missing_file_raises(tmp_path):
    with pytest.raises(ProductMappingError, match="not found"):
        ProductNameMapper(tmp_path / "PRODUCTS.xlsx")


def test_mapper_unreadable_file_raises(tmp_path):
    (tmp_path / "PRODUCTS.xlsx").write_bytes(b"garbage")
    with pytest.raises(ProductMappingError, match="could not be read"):
        ProductNameMapper(tmp_path / "PRODUCTS.xlsx")


def test_mapper_without_mapping_columns_raises(tmp_path):
    pd.DataFrame({"a": [1]}).to_excel(tmp_path / "PRODUCTS.xlsx", index=False)
    with pytest.raises(ProductMappingError, match="OdooProductName"):
        ProductNameMapper(tmp_path / "PRODUCTS.xlsx")


def test_mapper_zero_rows_from_a_valid_file_only_warns(tmp_path, caplog):
    pd.DataFrame({"OdooProductName": [], "ProductName": []}).to_excel(tmp_path / "PRODUCTS.xlsx", index=False)
    with caplog.at_level(logging.WARNING):
        mapper = ProductNameMapper(tmp_path / "PRODUCTS.xlsx")
    assert mapper.mapping_count() == 0 and "0 Odoo->clean name mappings" in caplog.text


def test_mapper_maps_names(tmp_path):
    _write_workbooks(tmp_path)
    mapper = ProductNameMapper(tmp_path / "PRODUCTS.xlsx")
    assert mapper.apply_to_series(pd.Series(["Odoo A", "unmapped"])).tolist() == ["Clean A", "unmapped"]
