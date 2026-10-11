"""ETL Flask API (data/etl/api): /etl/run starts ETL platform jobs, never the legacy writer. No subprocess is spawned."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

API = Path(__file__).resolve().parents[1] / "api"
sys.path.insert(0, str(API))

TEST_KEY = "test-key-not-a-secret"


@pytest.fixture
def api(monkeypatch):
    import app as api_app
    import job_tracker

    started = []

    def fake_start(load_mode, output_mode, fast, extra_args, label, python_bin, job_name=None):
        job = job_tracker.Job(job_id="job-1", job_name=job_name or "", load_mode=load_mode, output_mode=output_mode, fast=fast,
                              extra_args=list(extra_args), label=label)
        started.append(job)
        return job

    monkeypatch.setitem(api_app.app.config, "ETL_API_KEY", TEST_KEY)
    monkeypatch.setattr(api_app.tracker, "start", fake_start)
    client = api_app.app.test_client()

    def post(body):
        return client.post("/etl/run", json=body, headers={"Authorization": f"Bearer {TEST_KEY}"})

    return post, started, job_tracker


def test_named_platform_job_is_started(api):
    post, started, _ = api
    r = post({"job": "finance_receivables", "label": "scheduled-finance"})
    assert r.status_code == 202 and started[-1].job_name == "finance_receivables"


@pytest.mark.parametrize("load_mode, job", [("incremental", "main"), ("full", "full_all")])
def test_legacy_load_mode_maps_to_the_platform_job(api, load_mode, job):
    post, started, _ = api
    assert post({"loadMode": load_mode}).status_code == 202
    assert started[-1].job_name == job


def test_unknown_job_and_excel_output_are_refused(api):
    post, started, _ = api
    assert post({"job": "drop_everything"}).status_code == 400
    r = post({"loadMode": "full", "outputMode": "excel"})
    assert r.status_code == 400 and "Excel" in r.get_json()["error"]
    assert not started


def test_subprocess_is_the_platform_cli(api):
    _, _, job_tracker = api
    job = job_tracker.Job(job_id="x", job_name="sales_incremental", load_mode="incremental", output_mode="sql", fast=True,
                          extra_args=["--allow-large-change"], label="scheduled-incremental")
    cmd = job_tracker.platform_command(job, "python")
    assert cmd == ["python", "-m", "etl_platform.run", "sales_incremental", "--trigger-source", "scheduled-incremental", "--allow-large-change"]
    assert "sales_pipeline.main" not in " ".join(cmd)
    legacy = job_tracker.Job(job_id="y", load_mode="full", output_mode="sql", fast=False, extra_args=[], label=None)
    assert job_tracker.platform_command(legacy, "python")[3] == "full_all"  # no job name: derived from loadMode
