#!/usr/bin/env python3
"""Post-deploy smoke check. Exits non-zero (fails the deployment) if anything below fails.

Checks, in order:
  1. backend /health            -> database, auth store and ETL queue (Redis) all reachable
  2. frontend                   -> serves a page
  3. ETL API /health + /etl/preflight -> input files found, output dir writable, product mappings > 0
  4. admin login + /auth/me     -> credentials work, admin role
  5. /filters/options           -> cascading-filter endpoint answers with options
  6. one incremental ETL run    -> (--run-etl) queued via the admin API and must finish "success"
  7. /meta/refresh-status       -> refresh log consistent with the loaded data (status "ok"),
                                   and, after step 6, a refresh recorded *after* this script started

Configuration (environment; secrets are never accepted as command-line arguments):
  BACKEND_URL           default http://127.0.0.1:4000
  FRONTEND_URL          default http://127.0.0.1:3000
  FRONTEND_PATH         default /Dashboard   (the Next.js basePath; a bare / is a 404 by design)
  ETL_API_URL           default http://127.0.0.1:5001   (skip with --skip-etl-api)
  ETL_API_KEY           bearer key of the ETL API       (needed for /etl/preflight)
  SMOKE_ADMIN_EMAIL     an Admin-role account
  SMOKE_ADMIN_PASSWORD  its password

Usage:
  python scripts/post_deploy_check.py --run-etl
  python scripts/post_deploy_check.py            # everything except the ETL run (checks the current log)

Only the Python standard library is used, so it runs on the deploy host and in CI without installs.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable


@dataclass
class Result:
    name: str
    ok: bool
    detail: str = ""
    warn: bool = False


@dataclass
class Http:
    timeout: float = 20.0

    def request(self, method: str, url: str, *, token: str | None = None, headers: dict[str, str] | None = None,
                body: dict | None = None) -> tuple[int, Any]:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Accept", "application/json")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        if token:
            req.add_header("Authorization", f"Bearer {token}")
        for key, value in (headers or {}).items():
            req.add_header(key, value)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return resp.status, _parse(resp.read())
        except urllib.error.HTTPError as exc:
            return exc.code, _parse(exc.read())


def _parse(raw: bytes) -> Any:
    text = raw.decode("utf-8", errors="replace")
    try:
        return json.loads(text)
    except ValueError:
        return text


@dataclass
class Checker:
    backend: str
    frontend: str
    etl_api: str | None
    etl_api_key: str
    admin_email: str
    admin_password: str
    run_etl: bool
    etl_timeout: float
    http: Http = field(default_factory=Http)
    results: list[Result] = field(default_factory=list)
    started_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    sleep: Callable[[float], None] = time.sleep

    def record(self, name: str, ok: bool, detail: str = "", warn: bool = False) -> bool:
        self.results.append(Result(name, ok, detail, warn))
        print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" -- {detail}" if detail else ""), flush=True)
        return ok

    def guarded(self, name: str, fn: Callable[[], None]) -> None:
        try:
            fn()
        except Exception as exc:  # noqa: BLE001 - a crashed check is a failed check, never a crashed script
            self.record(name, False, f"{type(exc).__name__}: {exc}")

    # -- individual checks -------------------------------------------------------------------

    def check_backend_health(self) -> None:
        status, body = self.http.request("GET", f"{self.backend}/health")
        deps = (body or {}).get("dependencies", {}) if isinstance(body, dict) else {}
        self.record("backend /health reachable", status in (200, 503), f"HTTP {status}")
        for name, label in (("database", "DB connectivity"), ("authStore", "auth store"), ("etlQueue", "ETL queue (Redis)")):
            state = (deps.get(name) or {}).get("status")
            self.record(label, state == "ok", f"status={state}" + (f" error={deps[name].get('error')}" if state != "ok" and name in deps else ""))

    def check_frontend(self) -> None:
        try:
            with urllib.request.urlopen(self.frontend, timeout=self.http.timeout) as resp:
                self.record("frontend serves a page", resp.status < 400, f"HTTP {resp.status} {self.frontend}")
        except urllib.error.HTTPError as exc:
            self.record("frontend serves a page", False, f"HTTP {exc.code} {self.frontend}")

    def check_etl_api(self) -> None:
        if not self.etl_api:
            self.record("ETL API", True, "skipped (--skip-etl-api)", warn=True)
            return
        status, body = self.http.request("GET", f"{self.etl_api}/health")
        self.record("ETL API /health", status == 200, f"HTTP {status}")
        if not self.etl_api_key:
            self.record("ETL preflight", False, "ETL_API_KEY not set for this script")
            return
        status, pre = self.http.request("GET", f"{self.etl_api}/etl/preflight", headers={"Authorization": f"Bearer {self.etl_api_key}"})
        if status != 200 or not isinstance(pre, dict):
            self.record("ETL preflight", False, f"HTTP {status}")
            return
        files = pre.get("files", [])
        bad = [f"{f['name']}={f['status']}" for f in files if f.get("required") and f.get("status") != "ok"]
        self.record("ETL preflight: input files found", pre.get("dir_is_dir") is True and not bad,
                    f"dir={pre.get('input_dir')}" + (f" problems: {', '.join(bad)}" if bad else "") + (f" hint: {pre.get('hint')}" if pre.get("hint") else ""))
        mappings = pre.get("productMappings") or {}
        count = mappings.get("count")
        self.record("ETL preflight: product mappings > 0", bool(mappings.get("ok")) and (count or 0) > 0,
                    f"count={count}" + (f" ({mappings.get('detail')})" if mappings.get("detail") else ""))
        out = pre.get("output") or {}
        self.record("ETL preflight: output dir writable", bool(out.get("writable")), out.get("detail") or str(out.get("dir")))

    def login(self) -> str | None:
        if not (self.admin_email and self.admin_password):
            self.record("admin login", False, "SMOKE_ADMIN_EMAIL / SMOKE_ADMIN_PASSWORD not set")
            return None
        status, body = self.http.request("POST", f"{self.backend}/auth/login", body={"email": self.admin_email, "password": self.admin_password})
        token = body.get("token") if isinstance(body, dict) else None
        self.record("admin login", status == 200 and bool(token), f"HTTP {status}")
        if not token:
            return None
        status, me = self.http.request("GET", f"{self.backend}/auth/me", token=token)
        self.record("session valid (/auth/me)", status == 200, f"HTTP {status}")
        # Admin-only route: 200 proves the account really has the Admin role the ETL start needs.
        status, _ = self.http.request("GET", f"{self.backend}/admin/etl/status", token=token)
        self.record("account has the Admin role (/admin/etl/status)", status == 200, f"HTTP {status}")
        return token

    def check_filter_options(self, token: str) -> None:
        status, body = self.http.request("GET", f"{self.backend}/filters/options", token=token)
        options = (body or {}).get("options") if isinstance(body, dict) else None
        non_empty = isinstance(options, dict) and any(options.get(k) for k in options)
        self.record("filter options endpoint", status == 200 and non_empty,
                    f"HTTP {status}, groups with options: {sum(1 for v in (options or {}).values() if v)}" if isinstance(options, dict) else f"HTTP {status}")

    def run_incremental_etl(self, token: str) -> None:
        status, body = self.http.request("POST", f"{self.backend}/admin/etl/start/incremental", token=token)
        if status != 202 or not isinstance(body, dict) or "runId" not in body:
            self.record("start incremental ETL run", False, f"HTTP {status}: {body if isinstance(body, str) else json.dumps(body)[:300]}")
            return
        run_id = body["runId"]
        self.record("start incremental ETL run", True, f"runId={run_id}")
        deadline = time.monotonic() + self.etl_timeout
        last = None
        while time.monotonic() < deadline:
            status, st = self.http.request("GET", f"{self.backend}/admin/etl/status", token=token)
            run = (st or {}).get("run") if isinstance(st, dict) else None
            if status == 200 and run and run.get("id") == run_id:
                last = run
                if run.get("status") in ("success", "failed", "cancelled"):
                    break
            self.sleep(10)
        ok = bool(last) and last.get("status") == "success"
        detail = f"status={last.get('status') if last else 'unknown (timed out)'}"
        if last and last.get("error_message"):
            detail += f" error={str(last['error_message'])[:300]}"
        self.record("incremental ETL run finished successfully", ok, detail)

    def check_refresh_status(self, token: str) -> None:
        status, body = self.http.request("GET", f"{self.backend}/meta/refresh-status", token=token)
        if status != 200 or not isinstance(body, dict) or "refreshCheck" not in body:
            self.record("refresh-log consistency", False, f"HTTP {status}, no refreshCheck in response (backend older than this check?)")
            return
        check = body["refreshCheck"]
        self.record("refresh-log consistency", check.get("status") == "ok" and not check.get("inconsistent"),
                    f"{check.get('status')}: {check.get('message')}" + (f" | action: {check.get('action')}" if check.get("action") else ""))
        if self.run_etl:
            finished = _iso(body.get("lastRefreshTime"))
            fresh = finished is not None and finished >= self.started_at - timedelta(minutes=1)
            self.record("Last Refresh advanced by this deployment's ETL run", fresh,
                        f"lastRefreshTime={body.get('lastRefreshTime')} (script started {self.started_at.isoformat(timespec='seconds')})")

    # -- driver ------------------------------------------------------------------------------

    def run(self) -> int:
        self.guarded("backend health", self.check_backend_health)
        self.guarded("frontend", self.check_frontend)
        self.guarded("ETL API", self.check_etl_api)
        token: str | None = None
        try:
            token = self.login()
        except Exception as exc:  # noqa: BLE001
            self.record("admin login", False, f"{type(exc).__name__}: {exc}")
        if token:
            self.guarded("filter options", lambda: self.check_filter_options(token))
            if self.run_etl:
                self.guarded("ETL run", lambda: self.run_incremental_etl(token))
            self.guarded("refresh status", lambda: self.check_refresh_status(token))
        failed = [r for r in self.results if not r.ok]
        print(f"\n{len(self.results) - len(failed)}/{len(self.results)} checks passed")
        if failed:
            print("DEPLOYMENT CHECK FAILED:\n  - " + "\n  - ".join(f"{r.name}: {r.detail}" for r in failed))
        return 1 if failed else 0


def _iso(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--run-etl", action="store_true", help="trigger one incremental ETL run and require it to succeed")
    parser.add_argument("--skip-etl-api", action="store_true", help="do not call the ETL API directly (health + preflight)")
    parser.add_argument("--etl-timeout", type=float, default=3600, help="seconds to wait for the ETL run (default 3600)")
    args = parser.parse_args(argv)
    env = os.environ.get
    checker = Checker(
        backend=env("BACKEND_URL", "http://127.0.0.1:4000").rstrip("/"),
        frontend=env("FRONTEND_URL", "http://127.0.0.1:3000").rstrip("/") + env("FRONTEND_PATH", "/Dashboard"),
        etl_api=None if args.skip_etl_api else env("ETL_API_URL", "http://127.0.0.1:5001").rstrip("/"),
        etl_api_key=env("ETL_API_KEY", ""),
        admin_email=env("SMOKE_ADMIN_EMAIL", ""),
        admin_password=env("SMOKE_ADMIN_PASSWORD", ""),
        run_etl=args.run_etl,
        etl_timeout=args.etl_timeout,
    )
    return checker.run()


if __name__ == "__main__":
    sys.exit(main())
