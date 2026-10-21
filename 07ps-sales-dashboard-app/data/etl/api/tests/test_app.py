"""Tests for the ETL Flask API (app.py). Mocks job_tracker.tracker so these never spawn a real
subprocess or touch data/etl/src/sales_pipeline - same no-real-execution convention as
data/ingestion/tests/test_app.py.

Run with: python -m pytest data/etl/api/tests/test_app.py -q
"""
from __future__ import annotations

import os
import sys
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("ETL_API_KEY", "test-key-123")

import pytest

from app import app as flask_app
from job_tracker import Job

AUTH_HEADERS = {"Authorization": "Bearer test-key-123"}


@pytest.fixture
def client():
    flask_app.config["TESTING"] = True
    with flask_app.test_client() as test_client:
        yield test_client


def make_job(**overrides) -> Job:
    defaults = dict(
        job_id="job-1", load_mode="incremental", output_mode="sql",
        fast=True, extra_args=[], label="test",
    )
    defaults.update(overrides)
    return Job(**defaults)


def test_health_no_auth_required(client):
    with patch("app.tracker.active_job", return_value=None):
        response = client.get("/health")
    assert response.status_code == 200
    assert response.get_json()["status"] == "ok"
    assert response.get_json()["activeJob"] is None


def test_health_reports_active_job(client):
    job = make_job(status="running")
    with patch("app.tracker.active_job", return_value=job):
        response = client.get("/health")
    assert response.status_code == 200
    assert response.get_json()["activeJob"] == {"jobId": "job-1", "status": "running"}


def test_etl_run_requires_auth(client):
    response = client.post("/etl/run", json={"loadMode": "incremental"})
    assert response.status_code == 401


def test_etl_run_rejects_wrong_key(client):
    response = client.post(
        "/etl/run", headers={"Authorization": "Bearer wrong-key"}, json={"loadMode": "incremental"}
    )
    assert response.status_code == 401


def test_etl_run_rejects_invalid_load_mode(client):
    response = client.post("/etl/run", headers=AUTH_HEADERS, json={"loadMode": "bogus"})
    assert response.status_code == 400


def test_etl_run_rejects_invalid_output_mode(client):
    response = client.post(
        "/etl/run", headers=AUTH_HEADERS, json={"loadMode": "full", "outputMode": "bogus"}
    )
    assert response.status_code == 400


def test_etl_run_success(client):
    job = make_job(status="pending")
    with patch("app.tracker.start", return_value=job) as mock_start:
        response = client.post(
            "/etl/run", headers=AUTH_HEADERS,
            json={"loadMode": "incremental", "fast": True, "label": "manual"},
        )
    assert response.status_code == 202
    assert response.get_json()["jobId"] == "job-1"
    mock_start.assert_called_once()


def test_etl_run_conflict_returns_409(client):
    active = make_job(job_id="already-running", status="running")
    with patch("app.tracker.start", side_effect=RuntimeError("A run is already active")):
        with patch("app.tracker.active_job", return_value=active):
            response = client.post("/etl/run", headers=AUTH_HEADERS, json={"loadMode": "full"})
    assert response.status_code == 409
    assert response.get_json()["activeJobId"] == "already-running"


def test_get_job_not_found(client):
    with patch("app.tracker.get", return_value=None):
        response = client.get("/etl/jobs/nope", headers=AUTH_HEADERS)
    assert response.status_code == 404


def test_get_job_running_returns_status_and_logs(client):
    job = make_job(status="running")
    job.append_line("stdout", "Pipeline step extract started")
    with patch("app.tracker.get", return_value=job):
        response = client.get("/etl/jobs/job-1", headers=AUTH_HEADERS)
    assert response.status_code == 200
    body = response.get_json()
    assert body["status"] == "running"
    assert body["lines"][0]["text"] == "Pipeline step extract started"


def test_cancel_not_found(client):
    with patch("app.tracker.cancel", side_effect=KeyError("nope")):
        response = client.post("/etl/jobs/nope/cancel", headers=AUTH_HEADERS)
    assert response.status_code == 404


def test_cancel_not_running_returns_409(client):
    with patch("app.tracker.cancel", side_effect=ValueError("completed")):
        response = client.post("/etl/jobs/job-1/cancel", headers=AUTH_HEADERS)
    assert response.status_code == 409


def test_cancel_success(client):
    job = make_job(status="running")
    job.cancel_requested = True
    with patch("app.tracker.cancel", return_value=job):
        response = client.post("/etl/jobs/job-1/cancel", headers=AUTH_HEADERS)
    assert response.status_code == 200
    assert response.get_json()["jobId"] == "job-1"


def test_reset_requires_auth(client):
    response = client.post("/etl/reset")
    assert response.status_code == 401


def test_reset_no_active_job(client):
    with patch("app.tracker.force_reset", return_value=None):
        response = client.post("/etl/reset", headers=AUTH_HEADERS)
    assert response.status_code == 200
    body = response.get_json()
    assert body["ok"] is True
    assert body["resetJobId"] is None


def test_reset_clears_active_job(client):
    job = make_job(status="cancelled")
    with patch("app.tracker.force_reset", return_value=job):
        response = client.post("/etl/reset", headers=AUTH_HEADERS)
    assert response.status_code == 200
    assert response.get_json()["resetJobId"] == "job-1"


def test_404_on_unknown_route(client):
    response = client.get("/nope")
    assert response.status_code == 404
