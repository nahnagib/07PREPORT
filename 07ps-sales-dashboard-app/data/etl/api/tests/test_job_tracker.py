"""Tests for JobTracker.force_reset() (job_tracker.py) -- the admin override for a stuck "active
job" slot. Exercises the tracker directly, with a fake subprocess.Popen stand-in, so these never
spawn a real process.

Run with: python -m pytest data/etl/api/tests/test_job_tracker.py -q
"""
from __future__ import annotations

import os
import sys
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from job_tracker import Job, JobTracker


class FakeProcess:
    def __init__(self, running: bool = True) -> None:
        self.running = running
        self.terminate_called = False

    def poll(self):
        return None if self.running else 0

    def terminate(self) -> None:
        self.terminate_called = True
        self.running = False


def make_tracker_with_active_job(status: str = "running", process: FakeProcess | None = None) -> tuple[JobTracker, Job]:
    tracker = JobTracker()
    job = Job(job_id="stuck-job", load_mode="full", output_mode="sql", fast=False, extra_args=[], label="test")
    job.status = status
    job.process = process
    tracker._jobs[job.job_id] = job
    tracker._active_job_ids["main"] = job.job_id
    return tracker, job


def test_force_reset_returns_none_when_nothing_active():
    tracker = JobTracker()
    assert tracker.force_reset() is None


def test_force_reset_terminates_still_running_process():
    process = FakeProcess(running=True)
    tracker, job = make_tracker_with_active_job(status="running", process=process)

    reset_job = tracker.force_reset()

    assert reset_job is job
    assert process.terminate_called is True
    assert job.cancel_requested is True
    assert job.status == "cancelled"
    assert job.finished_at is not None


def test_force_reset_frees_the_active_slot_immediately():
    tracker, job = make_tracker_with_active_job(status="running", process=FakeProcess(running=True))

    assert tracker.active_job() is job
    tracker.force_reset()
    assert tracker.active_job() is None


def test_force_reset_does_not_touch_already_terminal_process():
    process = FakeProcess(running=False)
    tracker, job = make_tracker_with_active_job(status="running", process=process)

    tracker.force_reset()

    # poll() reported the process already exited -- terminate() should not be called on a dead
    # process (harmless on most platforms, but there is no reason to touch it).
    assert process.terminate_called is False
    assert tracker.active_job() is None


def test_force_reset_allows_a_new_job_to_start_afterward():
    tracker, _job = make_tracker_with_active_job(status="running", process=FakeProcess(running=True))
    tracker.force_reset()

    # start() should no longer see a blocking active job -- the background thread is patched out
    # so this only exercises the "already active" guard, not a real subprocess launch.
    with patch("job_tracker.threading.Thread") as mock_thread:
        started = tracker.start(
            load_mode="incremental", output_mode="sql", fast=True, extra_args=[], label="next",
            python_bin=sys.executable,
        )
        mock_thread.assert_called_once()
    assert started.job_id != "stuck-job"


def test_a_sales_build_runs_next_to_a_main_lane_job_but_never_next_to_another_build(monkeypatch):
    """Two lanes: sales_build (the backend's etl-long queue) may start while the 30-minute refresh runs; a second build or
    a second main-lane job may not. A fresh tracker: no state shared with other tests."""
    import pytest

    import job_tracker as jt

    monkeypatch.setattr(jt, "_run_job", lambda job, python_bin: None)  # the job stays "running": no subprocess
    t = jt.JobTracker()
    refresh = t.start("incremental", "sql", False, [], "r", "python", job_name="refresh_30m")
    build = t.start("incremental", "sql", False, [], "b", "python", job_name="sales_build")
    with pytest.raises(RuntimeError):
        t.start("incremental", "sql", False, [], "b2", "python", job_name="sales_build")
    with pytest.raises(RuntimeError):
        t.start("full", "sql", False, [], "f", "python", job_name="full_all")
    assert t.active_job("main") is refresh and t.active_job("long") is build
    assert t.active_job() is not None  # input uploads wait for any run
    t.force_reset()
    assert t.active_job() is None
