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


def test_lists_all_five_slots_with_expected_structure(client, folders):
    inputs, _ = folders
    (inputs / "OffDays.xlsx").write_bytes(xlsx({"Sheet1": OFFDAYS}))
    body = client.get("/etl/input-files", headers=AUTH_HEADERS).get_json()
    assert body["input_dir"] == str(inputs.resolve())
    assert [f["name"] for f in body["files"]] == [
        "sales_targets.xlsx", "SalesTeam.xlsx", "OffDays.xlsx", "PRODUCTS.xlsx", "BlockedCustomers.xlsx",
    ]
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


def test_products_without_any_mapping_is_rejected(client, folders, monkeypatch):
    monkeypatch.delenv("ETL_ALLOW_EMPTY_PRODUCT_MAPPING", raising=False)
    columns = ["ProductKey", "Company", "Category", "Brand", "SubBrand", "Family", "ProductName",
               "OdooProductName", "ProductLevel", "SKU", "Size", "IsActive"]
    row = {c: ["x"] for c in columns}
    row["OdooProductName"] = [None]
    response = put(client, "PRODUCTS.xlsx", xlsx({"Sheet1": row}))
    assert response.status_code == 422
    assert "0 OdooProductName" in response.get_json()["error"]


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
