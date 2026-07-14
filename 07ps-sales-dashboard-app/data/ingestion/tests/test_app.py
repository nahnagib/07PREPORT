"""Tests for the ETL Flask API (app.py). Mocks etl_executor's functions so these never touch a
real database or the real pipeline - same no-network-calls convention as
test_odoo_mock_extract.py.

Run with: PYTHONPATH=.:vendor:vendor/sales_pipeline_src python3 -m pytest tests/test_app.py -q
"""
from __future__ import annotations

import os
import sys
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("ETL_API_KEY", "test-key-123")

import pytest

from app import app as flask_app

AUTH_HEADERS = {"Authorization": "Bearer test-key-123"}


@pytest.fixture
def client():
    flask_app.config["TESTING"] = True
    with flask_app.test_client() as test_client:
        yield test_client


def test_health_no_auth_required(client):
    with patch("etl_executor.check_db_connection", return_value=True):
        response = client.get("/health")
    assert response.status_code == 200
    assert response.get_json()["status"] == "ok"


def test_health_reports_degraded_when_db_down(client):
    with patch("etl_executor.check_db_connection", return_value=False):
        response = client.get("/health")
    assert response.status_code == 503
    assert response.get_json()["status"] == "degraded"


def test_etl_run_requires_auth(client):
    response = client.post("/etl/run")
    assert response.status_code == 401


def test_etl_run_rejects_wrong_key(client):
    response = client.post("/etl/run", headers={"Authorization": "Bearer wrong-key"})
    assert response.status_code == 401


def test_etl_run_success(client):
    fake_result = {
        "job_id": "abc", "started_at": "2026-07-14T00:00:00Z",
        "status": "SUCCESS", "rows_loaded": 10, "row_errors": 0, "duration_minutes": 1.5,
    }
    with patch("etl_executor.run_full_refresh", return_value=fake_result):
        response = client.post("/etl/run", headers=AUTH_HEADERS)
    assert response.status_code == 200
    assert response.get_json()["job_id"] == "abc"


def test_etl_run_reports_pipeline_error(client):
    with patch("etl_executor.run_full_refresh", side_effect=RuntimeError("boom")):
        response = client.post("/etl/run", headers=AUTH_HEADERS)
    assert response.status_code == 500
    assert "boom" in response.get_json()["error"]


def test_load_export_requires_xlsx_path(client):
    response = client.post("/etl/load-export", headers=AUTH_HEADERS, json={})
    assert response.status_code == 400


def test_load_export_rejects_missing_sheets(client):
    with patch("etl_executor.load_export", side_effect=ValueError("Export is missing required sheet(s): ['Fact_Sales']")):
        response = client.post(
            "/etl/load-export", headers=AUTH_HEADERS, json={"xlsx_path": "/tmp/bad.xlsx"}
        )
    assert response.status_code == 400


def test_load_export_success(client):
    fake_result = {
        "job_id": "def", "started_at": "2026-07-14T00:00:00Z", "clean": True,
        "inserted": {"Dim_Product": 5}, "skipped": {}, "total_errors": 0, "errors": {},
    }
    with patch("etl_executor.load_export", return_value=fake_result):
        response = client.post(
            "/etl/load-export", headers=AUTH_HEADERS, json={"xlsx_path": "/tmp/x.xlsx"}
        )
    assert response.status_code == 200
    assert response.get_json()["status"] == "success"


def test_404_on_unknown_route(client):
    response = client.get("/nope")
    assert response.status_code == 404
