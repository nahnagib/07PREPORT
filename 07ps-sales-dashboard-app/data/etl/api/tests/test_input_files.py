"""Tests for GET/PUT /etl/input-files (input_files.py). Every test points ETL_INPUT_DIR and
ETL_INPUT_BACKUP_DIR at pytest tmp folders, so the real input workbooks are never touched, and
job_tracker.tracker is mocked -- nothing here starts a pipeline run.

Run with: python -m pytest data/etl/api/tests/test_input_files.py -q
"""
from __future__ import annotations

import io
import os
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("ETL_API_KEY", "test-key-123")

import pandas as pd
import pytest

from app import app as flask_app
from job_tracker import Job

AUTH_HEADERS = {"Authorization": "Bearer test-key-123"}

OFFDAYS = {
    "Date": ["01/01/2026", "25/12/2026"],
    "OffDayType": ["holiday", "holiday"],
    "HolidayName": ["New Year", "Independence Day"],
    "Reason": [None, None],
    "Country": ["Libya", "Libya"],
    "Company": ["Majaal", "Majaal"],
    "Branch": [None, None],
    "IsActive": [1, 1],
}


def xlsx(sheets: dict[str, dict]) -> bytes:
    buffer = io.BytesIO()
    with pd.ExcelWriter(buffer, engine="openpyxl") as writer:
        for sheet, columns in sheets.items():
            pd.DataFrame(columns).to_excel(writer, sheet_name=sheet, index=False)
    return buffer.getvalue()


@pytest.fixture
def folders(tmp_path, monkeypatch):
    inputs = tmp_path / "Input"
    backups = tmp_path / "backups"
    inputs.mkdir()
    monkeypatch.setenv("ETL_INPUT_DIR", str(inputs))
    monkeypatch.setenv("ETL_INPUT_BACKUP_DIR", str(backups))
    monkeypatch.delenv("ETL_INPUT_UPLOAD_DIR", raising=False)
    monkeypatch.delenv("ETL_INPUT_ADMIN_FILES", raising=False)
    return inputs, backups


@pytest.fixture
def client():
    flask_app.config["TESTING"] = True
    with flask_app.test_client() as test_client, patch("app.tracker.active_job", return_value=None):
        yield test_client


def put(client, name: str, body: bytes):
    return client.put(f"/etl/input-files/{name}", data=body, headers=AUTH_HEADERS, content_type="application/octet-stream")


def test_requires_auth(client, folders):
    assert client.get("/etl/input-files").status_code == 401
    assert client.put("/etl/input-files/OffDays.xlsx", data=b"x").status_code == 401


def test_lists_the_five_slots_with_expected_structure(client, folders):
    inputs, _ = folders
    (inputs / "OffDays.xlsx").write_bytes(xlsx({"Sheet1": OFFDAYS}))
    body = client.get("/etl/input-files", headers=AUTH_HEADERS).get_json()
    assert body["input_dir"] == str(inputs.resolve())
    assert [f["name"] for f in body["files"]] == [
        "sales_targets.xlsx", "SalesTeam.xlsx", "OffDays.xlsx", "BlockedCustomers.xlsx", "ProductExclusions.xlsx",
    ]  # PRODUCTS.xlsx is retired: products come from Odoo
    exclusions = next(f for f in body["files"] if f["name"] == "ProductExclusions.xlsx")
    assert exclusions["required"] is False and [x["sheet_names"] for x in exclusions["sheets"]] == [["Customers"], ["Categories"], ["Products"]]
    offdays = next(f for f in body["files"] if f["name"] == "OffDays.xlsx")
    assert offdays["exists"] is True and offdays["size_bytes"] > 0
    assert "Date" in offdays["sheets"][0]["required"]
    team = next(f for f in body["files"] if f["name"] == "SalesTeam.xlsx")
    assert team["exists"] is False and len(team["sheets"]) == 2


def test_valid_upload_replaces_in_place_and_backs_up_previous(client, folders):
    inputs, backups = folders
    old = xlsx({"Sheet1": OFFDAYS})
    (inputs / "OffDays.xlsx").write_bytes(old)
    new_rows = {k: v + [v[-1]] for k, v in OFFDAYS.items()}
    new_rows["Date"][-1] = "26/12/2026"
    new = xlsx({"Sheet1": new_rows})

    response = put(client, "OffDays.xlsx", new)

    assert response.status_code == 200, response.get_json()
    body = response.get_json()
    assert (inputs / "OffDays.xlsx").read_bytes() == new
    assert body["validation"]["counts"] == {"rows": 3}
    backup = Path(body["backup"]["path"])
    assert backup.parent == backups.resolve() and backup.read_bytes() == old
    assert backup.name.startswith("OffDays.") and backup.suffix == ".xlsx"
    assert sorted(p.name for p in inputs.iterdir()) == ["OffDays.xlsx"]  # no staging file left behind


def test_first_upload_into_empty_slot_has_no_backup(client, folders):
    inputs, _ = folders
    response = put(client, "OffDays.xlsx", xlsx({"Sheet1": OFFDAYS}))
    assert response.status_code == 200
    assert response.get_json()["backup"] is None and response.get_json()["previous"] is None
    assert (inputs / "OffDays.xlsx").is_file()


def test_missing_column_is_rejected_and_nothing_changes(client, folders):
    inputs, backups = folders
    old = xlsx({"Sheet1": OFFDAYS})
    (inputs / "OffDays.xlsx").write_bytes(old)
    renamed = {("Nation" if k == "Country" else k): v for k, v in OFFDAYS.items()}

    response = put(client, "OffDays.xlsx", xlsx({"Sheet1": renamed}))

    assert response.status_code == 422
    assert any("Country" in p for p in response.get_json()["problems"])
    assert (inputs / "OffDays.xlsx").read_bytes() == old
    assert not backups.exists()


def test_non_xlsx_is_rejected(client, folders):
    response = put(client, "OffDays.xlsx", b"Date,OffDayType\n01/01/2026,holiday\n")
    assert response.status_code == 422
    assert "not a valid .xlsx" in response.get_json()["error"]


def test_zero_parsed_rows_is_rejected(client, folders):
    not_libya = dict(OFFDAYS, Country=["Tunisia", "Tunisia"])
    response = put(client, "OffDays.xlsx", xlsx({"Sheet1": not_libya}))
    assert response.status_code == 422
    assert "0 rows" in response.get_json()["error"]


def test_sales_team_needs_both_sheets(client, folders):
    people = {"Name": ["A"], "TeamKey": ["T1"], "Status": ["ACTIVE"], "DistributionChannel": ["Retail"]}
    response = put(client, "SalesTeam.xlsx", xlsx({"salesperson": people}))
    assert response.status_code == 422
    assert any("sales team sheet" in p for p in response.get_json()["problems"])


def test_sales_team_valid(client, folders):
    people = {"Name": ["A"], "TeamKey": ["T1"], "Status": ["ACTIVE"], "DistributionChannel": ["Retail"]}
    teams = {"TeamKey": ["T1"], "TeamName": ["Team 1"], "Company": ["Majaal"], "City": ["Tripoli"], "Segment": ["Retail"], "Status": ["ACTIVE"]}
    response = put(client, "SalesTeam.xlsx", xlsx({"salesperson": people, "salesteam": teams}))
    assert response.status_code == 200, response.get_json()
    assert response.get_json()["validation"]["counts"] == {"active_salespersons": 1, "teams": 1}


def test_products_xlsx_can_no_longer_be_uploaded(client, folders):
    response = put(client, "PRODUCTS.xlsx", xlsx({"Sheet1": {"x": [1]}}))
    assert response.status_code in (400, 404, 422)
    assert not (folders[0] / "PRODUCTS.xlsx").exists()


def test_upload_blocked_while_a_run_is_active(folders):
    inputs, _ = folders
    old = xlsx({"Sheet1": OFFDAYS})
    (inputs / "OffDays.xlsx").write_bytes(old)
    running = Job(job_id="job-1", load_mode="full", output_mode="sql", fast=False, extra_args=[], label="t", status="running")
    flask_app.config["TESTING"] = True
    with flask_app.test_client() as c, patch("app.tracker.active_job", return_value=running):
        new_rows = dict(OFFDAYS, HolidayName=["X", "Y"])
        response = put(c, "OffDays.xlsx", xlsx({"Sheet1": new_rows}))
    assert response.status_code == 409
    assert (inputs / "OffDays.xlsx").read_bytes() == old


def test_identical_file_is_not_replaced(client, folders):
    inputs, backups = folders
    old = xlsx({"Sheet1": OFFDAYS})
    (inputs / "OffDays.xlsx").write_bytes(old)
    response = put(client, "OffDays.xlsx", old)
    assert response.status_code == 409
    assert not backups.exists()


def test_unknown_slot_and_oversize(client, folders):
    assert put(client, "Other.xlsx", xlsx({"Sheet1": OFFDAYS})).status_code == 404
    assert put(client, "OffDays.xlsx", b"PK" + b"0" * (5 * 1024 * 1024)).status_code == 413


def test_backup_dir_inside_input_dir_is_refused(client, folders, monkeypatch):
    inputs, _ = folders
    monkeypatch.setenv("ETL_INPUT_BACKUP_DIR", str(inputs / "backups"))
    response = put(client, "OffDays.xlsx", xlsx({"Sheet1": OFFDAYS}))
    assert response.status_code == 500
    assert not (inputs / "OffDays.xlsx").exists()


def test_read_only_input_folder_validates_then_refuses_to_write(client, folders):
    """Production mounts the input folder read-only: a bad file is still rejected with its reason, a good
    one is reported as checked (200, replaced=false, clear message) and nothing is written."""
    inputs, backups = folders
    old = xlsx({"Sheet1": OFFDAYS})
    (inputs / "OffDays.xlsx").write_bytes(old)
    real_access = os.access
    with patch("input_files.os.access", side_effect=lambda path, mode: False if Path(path) == inputs.resolve() and mode == os.W_OK else real_access(path, mode)):
        renamed = {("Nation" if k == "Country" else k): v for k, v in OFFDAYS.items()}
        bad = put(client, "OffDays.xlsx", xlsx({"Sheet1": renamed}))
        assert bad.status_code == 422 and any("Country" in p for p in bad.get_json()["problems"])
        new_rows = {k: v + [v[-1]] for k, v in OFFDAYS.items()}
        new_rows["Date"][-1] = "26/12/2026"
        good = put(client, "OffDays.xlsx", xlsx({"Sheet1": new_rows}))
        listing = client.get("/etl/input-files", headers=AUTH_HEADERS).get_json()
    assert good.status_code == 200
    body = good.get_json()
    assert body["replaced"] is False and body["read_only"] is True and "read-only" in body["message"]
    assert body["validation"]["counts"] == {"rows": 3}
    assert listing["read_only"] is True
    assert (inputs / "OffDays.xlsx").read_bytes() == old
    assert not backups.exists()


def _exclusions(categories_active="Yes", category_id=39):
    return xlsx({
        "Instructions": {"Product pages – exclusions list": ["read me"]},
        "Customers": {"Company": ["Tika"], "Odoo Partner ID": [9709], "Customer Name (reference)": ["x"], "Action": ["Keep"], "Active": ["No"]},
        "Categories": {"Company": ["All"], "Odoo Category ID": [category_id], "Category Name (reference)": ["Packaging"],
                       "Action": ["Exclude"], "Active": [categories_active]},
        "Products": {"Company": [], "Odoo Product ID": [], "Product Name (reference)": [], "Action": [], "Active": []},
        "Lists": {"Company": ["All", "Majaal", "Tika"]},
    })


def test_product_exclusions_upload_is_validated_and_counted(client, folders):
    response = put(client, "ProductExclusions.xlsx", _exclusions())
    assert response.status_code == 200, response.get_json()
    counts = response.get_json()["validation"]["counts"]
    assert counts["categories_active"] == 1 and counts["customers_ignored"] == 1 and counts["products_active"] == 0


def test_product_exclusions_upload_with_an_invalid_row_is_accepted_and_lists_the_skipped_row(client, folders):
    response = put(client, "ProductExclusions.xlsx", _exclusions(category_id="Packaging"))
    assert response.status_code == 200, response.get_json()
    validation = response.get_json()["validation"]
    assert validation["counts"]["rows_skipped"] == 1 and validation["counts"]["categories_active"] == 0
    assert validation["warnings"] == ["Categories row 2 (Packaging): Odoo Category ID must be a whole positive number (got Packaging) -- row skipped"]


def test_product_exclusions_upload_without_a_required_sheet_is_rejected_and_the_current_file_stays(client, folders):
    inputs, _ = folders
    good = put(client, "ProductExclusions.xlsx", _exclusions())
    assert good.status_code == 200
    before = (inputs / "ProductExclusions.xlsx").read_bytes()
    broken = xlsx({"Customers": {"Company": [], "Odoo Partner ID": [], "Action": [], "Active": []},
                   "Categories": {"Company": [], "Odoo Category ID": [], "Action": [], "Active": []}})
    response = put(client, "ProductExclusions.xlsx", broken)
    assert response.status_code == 422 and "Products sheet" in str(response.get_json())
    assert (inputs / "ProductExclusions.xlsx").read_bytes() == before


def _exclusions_2026_11_15(products_columns_drop: tuple[str, ...] = ()):
    """The 2026-11-15 structure: Instructions / Summary / Customers / Categories / Products / Lists, the Products sheet with
    every reference column and "Archived in Odoo", no "Price Fix (Odoo)" sheet."""
    products = {"Company": ["Majaal", "Tika"], "Odoo Product ID": [3273, 5], "Product Name (reference)": ["Design", "P5"],
                "Internal Reference (reference)": [None, None], "Category (reference)": ["Bathroom", "All"],
                "Odoo Category ID (reference)": [47, 1], "Product Type (reference)": ["Service", "Storable"],
                "Odoo Sales Price (reference)": [8274, 1], "Action": ["Exclude", "Exclude"], "Active": ["Yes", "No"],
                "Reason": ["Service", "pending"], "LYD 2026 YTD (reference)": [0, 0], "LYD 2025 (reference)": [0, 0],
                "LYD before 2025 (reference)": [0, 0], "Archived in Odoo": ["Yes", None], "Added By": ["QA", "QA"],
                "Added Date": ["2026-11-15", "2026-11-15"], "Notes": [None, None]}
    for column in products_columns_drop:
        products.pop(column)
    return xlsx({
        "Instructions": {"How to use": ["Active = No rows are ignored"]},
        "Summary": {"Sheet": ["Products"], "Rows": [2]},
        "Customers": {"Company": ["Tika"], "Odoo Partner ID": [9709], "Customer Name (reference)": ["x"], "Action": ["Keep"], "Active": ["Yes"],
                      "Reason": ["real buyer"], "Added By": [None], "Added Date": [None], "Notes": [None]},
        "Categories": {"Company": ["All"], "Odoo Category ID": [39], "Category Name (reference)": ["Packaging"], "Action": ["Exclude"],
                       "Active": ["Yes"], "Reason": ["not sold"], "Added By": [None], "Added Date": [None], "Notes": [None]},
        "Products": products,
        "Lists": {"Action": ["Exclude", "Keep"]},
    })


def test_product_exclusions_2026_11_15_structure_is_accepted(client, folders):
    response = put(client, "ProductExclusions.xlsx", _exclusions_2026_11_15())
    assert response.status_code == 200, response.get_json()
    counts = response.get_json()["validation"]["counts"]
    assert (counts["products_active"], counts["products_ignored"], counts["categories_active"], counts["customers_active"]) == (1, 1, 1, 1)
    assert counts["rows_skipped"] == 0


def test_product_exclusions_2026_11_15_without_a_required_column_is_rejected_with_a_clear_message(client, folders):
    response = put(client, "ProductExclusions.xlsx", _exclusions_2026_11_15(products_columns_drop=("Active",)))
    assert response.status_code == 422
    assert "Active" in str(response.get_json()) and "Products" in str(response.get_json())


# -- every input file replaceable from the admin side (2026-11-22) --------------------------------------------------------

TARGETS = {
    "Year": [2026], "Month": [1], "YearMonth": ["2026-01"], "TargetDate": ["2026-01-01"], "TargetLevel": ["Salesperson"],
    "Company": ["Majaal"], "SalesTeam": ["Team 1"], "SalesTeamKey": ["T1"], "Salesperson": ["A"], "SalesSegment": ["B2B"],
    "City": ["Tripoli"], "Currency": ["LYD"], "Target_Revenue": [1000], "Target_Volume": [10], "ASP_LY": [100],
    "ASP_ThisYear": [100], "DistributionChannel": ["Retail"],
}
PEOPLE = {"Name": ["A"], "TeamKey": ["T1"], "Status": ["ACTIVE"], "DistributionChannel": ["Retail"]}
TEAMS = {"TeamKey": ["T1"], "TeamName": ["Team 1"], "Company": ["Majaal"], "City": ["Tripoli"], "Segment": ["Retail"], "Status": ["ACTIVE"]}
BLOCKED = {"CustomerID": ["C1"], "CustomerName": ["X"], "IsBlocked": ["Yes"], "BlockedDate": ["01/01/2026"],
           "UnblockedDate": [None], "BlockedReason": ["overdue"], "Notes": [None]}


def _drop(columns: dict, column: str) -> dict:
    return {k: v for k, v in columns.items() if k != column}


def _with_extra_row(columns: dict) -> dict:
    """A second, different version of a one-sheet file (one more row)."""
    return {k: v + [v[-1]] for k, v in columns.items()}


# name -> (a valid file, a different valid file, the same file with one required column missing, that column)
FILE_CASES = {
    "sales_targets.xlsx": (
        lambda: xlsx({"Targets": TARGETS}), lambda: xlsx({"Targets": _with_extra_row(TARGETS)}),
        lambda: xlsx({"Targets": _drop(TARGETS, "Target_Revenue")}), "Target_Revenue",
    ),
    "SalesTeam.xlsx": (
        lambda: xlsx({"salesperson": PEOPLE, "salesteam": TEAMS}),
        lambda: xlsx({"salesperson": dict(PEOPLE, Name=["B"]), "salesteam": TEAMS}),
        lambda: xlsx({"salesperson": PEOPLE, "salesteam": _drop(TEAMS, "Segment")}), "Segment",
    ),
    "OffDays.xlsx": (
        lambda: xlsx({"Sheet1": OFFDAYS}), lambda: xlsx({"Sheet1": dict(OFFDAYS, HolidayName=["X", "Y"])}),
        lambda: xlsx({"Sheet1": _drop(OFFDAYS, "Country")}), "Country",
    ),
    "BlockedCustomers.xlsx": (
        lambda: xlsx({"BlockedCustomers": BLOCKED}), lambda: xlsx({"BlockedCustomers": _with_extra_row(BLOCKED)}),
        lambda: xlsx({"BlockedCustomers": _drop(BLOCKED, "IsBlocked")}), "IsBlocked",
    ),
    "ProductExclusions.xlsx": (
        lambda: _exclusions(categories_active="No"), lambda: _exclusions(),
        lambda: _exclusions_2026_11_15(products_columns_drop=("Active",)), "Active",
    ),
}


@pytest.fixture
def read_only_with_uploads(folders, tmp_path, monkeypatch):
    """Production: /etl/input mounted read-only, ETL_INPUT_UPLOAD_DIR=/etl/input_admin writable, ETL_INPUT_ADMIN_FILES unset."""
    inputs, backups = folders
    uploads = tmp_path / "input_admin"
    monkeypatch.setenv("ETL_INPUT_UPLOAD_DIR", str(uploads))
    real_access = os.access
    with patch("input_files.os.access",
               side_effect=lambda path, mode: False if Path(path) == inputs.resolve() and mode == os.W_OK else real_access(path, mode)):
        yield inputs, backups, uploads


def test_every_input_file_is_replaceable_when_the_input_folder_is_read_only(client, read_only_with_uploads):
    listing = client.get("/etl/input-files", headers=AUTH_HEADERS).get_json()
    assert listing["read_only"] is True
    assert {f["name"]: f["replaceable"] for f in listing["files"]} == dict.fromkeys(FILE_CASES, True)


@pytest.mark.parametrize("name", list(FILE_CASES))
def test_good_file_is_saved_in_input_admin_and_the_server_copy_is_backed_up(client, read_only_with_uploads, name):
    from config.input_check import effective_input_path

    inputs, backups, uploads = read_only_with_uploads
    server_copy, uploaded, _, _ = (f() if callable(f) else f for f in FILE_CASES[name])
    (inputs / name).write_bytes(server_copy)

    response = put(client, name, uploaded)

    body = response.get_json()
    assert response.status_code == 200 and body["replaced"] is True, body
    assert Path(body["saved_to"]) == (uploads / name).resolve()
    assert (uploads / name).read_bytes() == uploaded
    assert (inputs / name).read_bytes() == server_copy                                   # /etl/input is never written
    backup = Path(body["backup"]["path"])
    assert backup.parent == backups.resolve() and backup.read_bytes() == server_copy
    stem, suffix = os.path.splitext(name)
    assert backup.name.startswith(f"{stem}.") and backup.suffix == suffix                 # <name>.<UTC timestamp>.xlsx
    assert effective_input_path(inputs, name) == (uploads / name).resolve()
    listing = {f["name"]: f for f in client.get("/etl/input-files", headers=AUTH_HEADERS).get_json()["files"]}
    assert listing[name]["source"] == "admin_upload" and listing[name]["sha256"] == body["current"]["sha256"]


@pytest.mark.parametrize("name", list(FILE_CASES))
def test_file_missing_a_required_column_is_rejected_and_nothing_is_saved(client, read_only_with_uploads, name):
    inputs, backups, uploads = read_only_with_uploads
    server_copy, _, broken, column = (f() if callable(f) else f for f in FILE_CASES[name])
    (inputs / name).write_bytes(server_copy)

    response = put(client, name, broken)

    assert response.status_code == 422
    assert column in str(response.get_json())
    assert not (uploads / name).exists() and not backups.exists()
    assert (inputs / name).read_bytes() == server_copy


@pytest.mark.parametrize("name", list(FILE_CASES))
def test_unreadable_file_is_rejected(client, read_only_with_uploads, name):
    _, backups, uploads = read_only_with_uploads
    response = put(client, name, b"not,an,excel\nfile\n")
    assert response.status_code == 422 and "not a valid .xlsx" in response.get_json()["error"]
    assert not (uploads / name).exists() and not backups.exists()


def test_check_file_validates_but_saves_nothing(client, read_only_with_uploads):
    inputs, backups, uploads = read_only_with_uploads
    (inputs / "OffDays.xlsx").write_bytes(xlsx({"Sheet1": OFFDAYS}))
    new = xlsx({"Sheet1": dict(OFFDAYS, HolidayName=["X", "Y"])})

    good = client.put("/etl/input-files/OffDays.xlsx?check=1", data=new, headers=AUTH_HEADERS, content_type="application/octet-stream")
    bad = client.put("/etl/input-files/OffDays.xlsx?check=1", data=xlsx({"Sheet1": _drop(OFFDAYS, "Country")}),
                     headers=AUTH_HEADERS, content_type="application/octet-stream")

    assert good.status_code == 200 and good.get_json()["replaced"] is False and good.get_json()["check_only"] is True
    assert bad.status_code == 422 and "Country" in str(bad.get_json())
    assert not uploads.exists() and not backups.exists()


def test_a_second_upload_backs_up_the_previous_admin_upload(client, read_only_with_uploads):
    inputs, backups, uploads = read_only_with_uploads
    (inputs / "OffDays.xlsx").write_bytes(xlsx({"Sheet1": OFFDAYS}))
    first = xlsx({"Sheet1": dict(OFFDAYS, HolidayName=["X", "Y"])})
    second = xlsx({"Sheet1": dict(OFFDAYS, HolidayName=["P", "Q"])})
    assert put(client, "OffDays.xlsx", first).status_code == 200
    response = put(client, "OffDays.xlsx", second)
    assert response.status_code == 200
    assert Path(response.get_json()["backup"]["path"]).read_bytes() == first
    assert (uploads / "OffDays.xlsx").read_bytes() == second
    assert len(list(backups.iterdir())) == 2


def test_etl_admin_files_env_can_still_narrow_the_list(client, read_only_with_uploads, monkeypatch):
    monkeypatch.setenv("ETL_INPUT_ADMIN_FILES", "ProductExclusions.xlsx")
    listing = {f["name"]: f["replaceable"] for f in client.get("/etl/input-files", headers=AUTH_HEADERS).get_json()["files"]}
    assert listing["ProductExclusions.xlsx"] is True and listing["OffDays.xlsx"] is False


# -- ETL read order: /etl/input_admin first, else /etl/input -------------------------------------------------------------


@pytest.fixture
def two_folders(folders, tmp_path, monkeypatch):
    inputs, _ = folders
    uploads = tmp_path / "input_admin"
    uploads.mkdir()
    monkeypatch.setenv("ETL_INPUT_UPLOAD_DIR", str(uploads))
    return inputs, uploads.resolve()


def _settings_path(name: str):
    from config.settings import Settings

    settings = Settings.from_env()
    return {
        "sales_targets.xlsx": settings.targets_path, "SalesTeam.xlsx": settings.sales_team_path,
        "OffDays.xlsx": settings.offdays_path, "BlockedCustomers.xlsx": settings.blocked_customers_path,
        "ProductExclusions.xlsx": settings.product_exclusions_path,
    }[name]


@pytest.mark.parametrize("name", list(FILE_CASES))
def test_etl_reads_input_admin_before_input(two_folders, name):
    """Every reader: config.settings (legacy pipeline: build_sales_sheets) and etl_platform's ExcelSource (core_dims:
    load_org_file / load_offdays_file / load_blocked_customers_file)."""
    from config.input_check import effective_input_path
    from etl_platform.sources.excel import ExcelSource

    inputs, uploads = two_folders
    (inputs / name).write_bytes(b"server")
    assert _settings_path(name) == inputs / name                   # no admin copy: the server file
    assert ExcelSource(inputs).path(name) == inputs / name
    (uploads / name).write_bytes(b"admin")
    assert _settings_path(name) == uploads / name                  # admin copy wins
    assert ExcelSource(inputs).path(name) == uploads / name
    assert effective_input_path(inputs, name) == uploads / name
    (uploads / name).unlink()                                      # rollback: delete the admin copy
    assert _settings_path(name) == inputs / name


def test_conform_sales_reads_the_admin_targets(two_folders):
    """departments.sales.jobs.conform_sales reads sales_targets.xlsx itself (sheet Targets)."""
    import inspect

    from departments.sales import jobs

    assert 'effective_input_path(ctx.config.input_dir, "sales_targets.xlsx")' in inspect.getsource(jobs.conform_sales)


def test_core_excel_input_is_loaded_from_input_admin(two_folders):
    """The file core_dims actually parses (OffDays.xlsx through ExcelSource.read) is the admin copy."""
    from core import excel_inputs as xl
    from etl_platform.sources.excel import ExcelSource

    inputs, uploads = two_folders
    (inputs / "OffDays.xlsx").write_bytes(b"not an excel file")      # would fail to parse if it were read
    (uploads / "OffDays.xlsx").write_bytes(xlsx({"Sheet1": dict(OFFDAYS, CompanyKey=[1, 1])}))
    spec = next(s for s in xl.INPUTS if s.file == xl.OFFDAYS_FILE)
    frame = ExcelSource(inputs).read(spec.file, spec.schema)
    assert len(frame) == 2


def test_without_an_upload_folder_every_file_is_read_from_the_input_folder(folders):
    from config.input_check import effective_input_path

    inputs, _ = folders
    for name in FILE_CASES:
        assert effective_input_path(inputs, name) == inputs / name
