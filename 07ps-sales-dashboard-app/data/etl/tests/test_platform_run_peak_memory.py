"""Every ETL job ends with its peak memory (etl_platform.run), used to size the etl-api limit (docs/server-10gb-upgrade.md)."""

from __future__ import annotations

import sys
import types

from etl_platform import run


def _fake_resource(self_kib: int, children_kib: int) -> types.ModuleType:
    mod = types.ModuleType("resource")
    mod.RUSAGE_SELF, mod.RUSAGE_CHILDREN = 0, -1
    mod.getrusage = lambda who: types.SimpleNamespace(ru_maxrss=self_kib if who == 0 else children_kib)
    return mod


def test_peak_is_the_larger_of_self_and_children_in_mb(monkeypatch):
    monkeypatch.setitem(sys.modules, "resource", _fake_resource(512 * 1024, 2048 * 1024))
    monkeypatch.setattr(sys, "platform", "linux")
    assert run.peak_rss_mb() == 2048.0


def test_no_resource_module_means_no_peak(monkeypatch):
    monkeypatch.setitem(sys.modules, "resource", None)  # import fails, as on Windows
    assert run.peak_rss_mb() is None


def test_peak_line_is_logged_last_even_when_the_job_fails(monkeypatch, capsys):
    monkeypatch.setattr(run, "peak_rss_mb", lambda: 1234.4)
    assert run.main(["no_such_job"]) == run.EXIT_USAGE
    lines = [line for line in capsys.readouterr().out.splitlines() if line.strip()]
    assert lines[-1].endswith("Job no_such_job peak memory: 1234 MB")


def test_list_logs_no_peak(monkeypatch, capsys):
    monkeypatch.setattr(run, "peak_rss_mb", lambda: 1.0)
    assert run.main(["--list"]) == 0
    assert "peak memory" not in capsys.readouterr().out
