"""Tests for post_deploy_check.py against a local stub of the backend / frontend / ETL API.

    python -m pytest scripts/test_post_deploy_check.py -q
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import post_deploy_check as smoke  # noqa: E402

SCRIPT = Path(__file__).parent / "post_deploy_check.py"


def _now_iso(minutes_ago: int = 0) -> str:
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).isoformat().replace("+00:00", "Z")


class Stub:
    """One server plays backend + frontend + ETL API; `state` toggles the failure scenarios."""

    def __init__(self) -> None:
        self.state = {
            "queue": "ok",
            "products": 2500,
            "refresh": {"status": "ok", "inconsistent": False, "message": "Last refresh ok", "action": None},
            "run_status": "success",
            "last_refresh": _now_iso(0),
        }
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):  # noqa: D401 - silence
                pass

            def _send(self, code, body):
                raw = json.dumps(body).encode() if not isinstance(body, str) else body.encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):  # noqa: N802
                s = stub.state
                if self.path == "/health":
                    self._send(200, {"status": "ok", "service": "etl-api", "dependencies": {
                        "database": {"status": "ok"}, "authStore": {"status": "ok"}, "etlQueue": {"status": s["queue"]}}})
                elif self.path == "/":
                    self._send(200, "<html></html>")
                elif self.path == "/etl/preflight":
                    self._send(200, {"ok": True, "input_dir": "/etl/input", "dir_is_dir": True, "hint": "",
                                     "files": [{"name": "PRODUCTS.xlsx", "required": True, "status": "ok"}],
                                     "output": {"dir": "/etl/output", "writable": True, "detail": ""},
                                     "productMappings": {"ok": s["products"] > 0, "count": s["products"], "detail": ""}})
                elif self.path == "/auth/me":
                    self._send(200, {"id": 1})
                elif self.path == "/filters/options":
                    self._send(200, {"options": {"businessUnits": [{"k": 1}], "customerGroups": []}})
                elif self.path == "/admin/etl/status":
                    self._send(200, {"run": {"id": 42, "status": s["run_status"], "error_message": "boom" if s["run_status"] == "failed" else None}})
                elif self.path == "/meta/refresh-status":
                    self._send(200, {"lastRefreshTime": s["last_refresh"], "refreshCheck": s["refresh"]})
                else:
                    self._send(404, {"error": "nope"})

            def do_POST(self):  # noqa: N802
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length) or b"{}")
                if self.path == "/auth/login":
                    ok = body.get("password") == "pw"
                    self._send(200 if ok else 401, {"token": "t"} if ok else {"error": "bad"})
                elif self.path == "/admin/etl/start/incremental":
                    self._send(202, {"ok": True, "runId": 42})
                else:
                    self._send(404, {})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()


@pytest.fixture
def stub():
    s = Stub()
    yield s
    s.close()


def checker(stub: Stub, **over) -> smoke.Checker:
    args = dict(backend=stub.url, frontend=stub.url, etl_api=stub.url, etl_api_key="k", admin_email="a@example.com",
                admin_password="pw", run_etl=False, etl_timeout=5, sleep=lambda _s: None)
    args.update(over)
    return smoke.Checker(**args)


def failed(c: smoke.Checker) -> list[str]:
    return [r.name for r in c.results if not r.ok]


def test_all_green(stub):
    c = checker(stub)
    assert c.run() == 0 and failed(c) == []


def test_all_green_with_etl_run_requires_a_fresh_refresh(stub):
    c = checker(stub, run_etl=True)
    assert c.run() == 0
    assert any(r.name.startswith("Last Refresh advanced") and r.ok for r in c.results)


def test_stale_last_refresh_after_etl_run_fails(stub):
    stub.state["last_refresh"] = _now_iso(120)
    c = checker(stub, run_etl=True)
    assert c.run() == 1
    assert failed(c) == ["Last Refresh advanced by this deployment's ETL run"]


def test_inconsistent_refresh_log_fails_the_deployment_with_the_specific_message(stub):
    stub.state["refresh"] = {"status": "refresh_before_data", "inconsistent": True, "action": "fix tz",
                             "message": "Last refresh 14:45, latest loaded order 14:52, difference 7 min, timezone Africa/Tripoli"}
    c = checker(stub)
    assert c.run() == 1
    bad = next(r for r in c.results if not r.ok)
    assert bad.name == "refresh-log consistency" and "difference 7 min" in bad.detail and "fix tz" in bad.detail


def test_no_refresh_log_also_fails(stub):
    stub.state["refresh"] = {"status": "no_refresh_log", "inconsistent": False, "message": "none", "action": "run ETL"}
    assert checker(stub).run() == 1


def test_zero_product_mappings_fail(stub):
    stub.state["products"] = 0
    c = checker(stub)
    assert c.run() == 1 and failed(c) == ["ETL preflight: product mappings > 0"]


def test_redis_down_fails(stub):
    stub.state["queue"] = "down"
    c = checker(stub)
    assert c.run() == 1 and "ETL queue (Redis)" in failed(c)


def test_failed_etl_run_fails_and_shows_the_error(stub):
    stub.state["run_status"] = "failed"
    c = checker(stub, run_etl=True)
    assert c.run() == 1
    assert any("error=boom" in r.detail for r in c.results if not r.ok)


def test_bad_admin_password_fails_login_and_skips_dependent_checks(stub):
    c = checker(stub, admin_password="wrong")
    assert c.run() == 1 and "admin login" in failed(c)
    assert not any(r.name == "filter options endpoint" for r in c.results)


def test_unreachable_backend_is_a_failed_check_not_a_crash():
    c = smoke.Checker(backend="http://127.0.0.1:1", frontend="http://127.0.0.1:1", etl_api=None, etl_api_key="",
                      admin_email="", admin_password="", run_etl=False, etl_timeout=1, sleep=lambda _s: None)
    c.http.timeout = 1
    assert c.run() == 1


def test_cli_exit_code_and_output(stub):
    env = {**os.environ, "BACKEND_URL": stub.url, "FRONTEND_URL": stub.url, "FRONTEND_PATH": "", "ETL_API_URL": stub.url, "ETL_API_KEY": "k",
           "SMOKE_ADMIN_EMAIL": "a@example.com", "SMOKE_ADMIN_PASSWORD": "pw"}
    ok = subprocess.run([sys.executable, str(SCRIPT)], env=env, capture_output=True, text=True)
    assert ok.returncode == 0 and "checks passed" in ok.stdout
    stub.state["refresh"] = {"status": "refresh_before_data", "inconsistent": True, "message": "x", "action": None}
    bad = subprocess.run([sys.executable, str(SCRIPT)], env=env, capture_output=True, text=True)
    assert bad.returncode == 1 and "DEPLOYMENT CHECK FAILED" in bad.stdout
