"""Read-only Odoo client over XML-RPC (Odoo 14-18; production is Odoo 17).

Only read methods are allowed: anything else is refused before it reaches Odoo, whatever rights the API user
has. Credentials are never logged. Transient network errors are retried with exponential back-off.
"""
from __future__ import annotations

import logging
import socket
import time
import xmlrpc.client
from typing import Any, Iterable, Sequence
from urllib.parse import urlparse

log = logging.getLogger("ar_weekly.odoo")

READ_ONLY_METHODS = frozenset({"search_read", "search_count", "search", "read", "fields_get", "read_group"})


class OdooError(RuntimeError):
    pass


class OdooAuthError(OdooError):
    pass


def _transport(url: str, timeout: int) -> xmlrpc.client.Transport:
    base = xmlrpc.client.SafeTransport if urlparse(url).scheme == "https" else xmlrpc.client.Transport

    class _T(base):  # type: ignore[misc, valid-type]
        def make_connection(self, host):  # noqa: ANN001
            conn = super().make_connection(host)
            conn.timeout = timeout
            return conn

    return _T()


class OdooClient:
    def __init__(self, url: str, db: str, login: str, api_key: str, *, company_ids: Sequence[int] = (),
                 lang: str = "en_US", timeout: int = 60, max_retries: int = 5) -> None:
        if not (url and db and login and api_key):
            raise OdooError("Odoo URL, database, login and API key are all required (see README, section 2)")
        self.url = url.rstrip("/")
        self.db = db
        self.login = login
        self._key = api_key
        self.company_ids = list(company_ids)
        self.lang = lang
        self.max_retries = max(1, max_retries)
        self._common = xmlrpc.client.ServerProxy(f"{self.url}/xmlrpc/2/common", allow_none=True,
                                                 transport=_transport(self.url, timeout))
        self._models = xmlrpc.client.ServerProxy(f"{self.url}/xmlrpc/2/object", allow_none=True,
                                                 transport=_transport(self.url, timeout))
        self.uid: int | None = None
        self._fields_cache: dict[str, dict[str, Any]] = {}

    def __repr__(self) -> str:  # never show the key
        return f"OdooClient(url={self.url!r}, db={self.db!r}, login={self.login!r})"

    # -- connection ---------------------------------------------------------------------------------------------
    def _retry(self, fn, what: str):
        for attempt in range(1, self.max_retries + 1):
            try:
                return fn()
            except xmlrpc.client.Fault as exc:  # an Odoo-side error: retrying will not help
                raise OdooError(f"{what}: Odoo returned an error: {exc.faultString.strip().splitlines()[-1]}") from None
            except (socket.timeout, TimeoutError, ConnectionError, OSError, xmlrpc.client.ProtocolError) as exc:
                if isinstance(exc, xmlrpc.client.ProtocolError) and exc.errcode < 500 and exc.errcode != 429:
                    raise OdooError(f"{what}: HTTP {exc.errcode} {exc.errmsg}") from None
                if attempt == self.max_retries:
                    raise OdooError(f"{what}: failed after {attempt} attempts: {exc}") from None
                wait = min(60, 2 ** attempt)
                log.warning("%s failed (%s), retrying in %ss (%s/%s)", what, exc, wait, attempt, self.max_retries)
                time.sleep(wait)

    def server_version(self) -> str:
        info = self._retry(lambda: self._common.version(), "version")
        return str(info.get("server_version", "unknown")) if isinstance(info, dict) else str(info)

    def authenticate(self) -> int:
        uid = self._retry(lambda: self._common.authenticate(self.db, self.login, self._key, {}), "login")
        if not uid:
            raise OdooAuthError("Odoo rejected the login or API key. Check ODOO_DB, the login and the API key "
                                "(Odoo: Preferences > Account Security > API Keys).")
        self.uid = int(uid)
        return self.uid

    # -- calls --------------------------------------------------------------------------------------------------
    def context(self, **extra: Any) -> dict[str, Any]:
        ctx: dict[str, Any] = {"lang": self.lang, "active_test": False}
        if self.company_ids:
            ctx["allowed_company_ids"] = self.company_ids
        ctx.update(extra)
        return ctx

    def call(self, model: str, method: str, args: list | None = None, kwargs: dict | None = None) -> Any:
        if method not in READ_ONLY_METHODS:
            raise OdooError(f"Refused: '{method}' is not a read method (this tool never writes to Odoo)")
        if self.uid is None:
            self.authenticate()
        kw = dict(kwargs or {})
        kw.setdefault("context", self.context())
        return self._retry(lambda: self._models.execute_kw(self.db, self.uid, self._key, model, method, args or [], kw),
                           f"{model}.{method}")

    def fields(self, model: str) -> dict[str, Any]:
        if model not in self._fields_cache:
            self._fields_cache[model] = self.call(model, "fields_get", [], {"attributes": ["type", "relation", "string"]})
        return self._fields_cache[model]

    def keep_available(self, model: str, wanted: Sequence[str]) -> list[str]:
        have = self.fields(model)
        missing = [f for f in wanted if f not in have]
        if missing:
            log.info("%s: fields not in this Odoo version, skipped: %s", model, ", ".join(missing))
        return [f for f in wanted if f in have]

    def search_read_all(self, model: str, domain: list, fields: Sequence[str], *, batch: int = 2000,
                        order: str = "id") -> list[dict[str, Any]]:
        fields = self.keep_available(model, fields)
        rows: list[dict[str, Any]] = []
        offset = 0
        while True:
            page = self.call(model, "search_read", [domain],
                             {"fields": list(fields), "offset": offset, "limit": batch, "order": order})
            rows.extend(page)
            if len(page) < batch:
                break
            offset += batch
        log.info("%s: %s rows", model, len(rows))
        return rows

    def read_ids(self, model: str, ids: Iterable[int], fields: Sequence[str], *, chunk: int = 1000,
                 skip_denied: bool = False) -> list[dict[str, Any]]:
        """Read records by id. With skip_denied, records the API user may not read (record rules, other companies)
        are left out instead of failing the whole read: the batch is split until the denied ids are isolated."""
        ids = sorted({int(i) for i in ids if i})
        if not ids:
            return []
        fields = list(self.keep_available(model, fields))
        rows: list[dict[str, Any]] = []
        denied: list[int] = []

        def read(part: list[int]) -> None:
            try:
                rows.extend(self.call(model, "read", [part], {"fields": fields}))
            except OdooError as exc:
                if not skip_denied or "access" not in str(exc).lower() and "cookies" not in str(exc).lower() \
                        and "not allowed" not in str(exc).lower():
                    raise
                if len(part) == 1:
                    denied.append(part[0])
                    return
                mid = len(part) // 2
                read(part[:mid])
                read(part[mid:])

        for i in range(0, len(ids), chunk):
            read(ids[i:i + chunk])
        if denied:
            log.warning("%s: %s record(s) not readable by the API user, left out: %s", model, len(denied), denied[:20])
        return rows

    def count(self, model: str, domain: list) -> int:
        return int(self.call(model, "search_count", [domain]))


def m2o_id(v: Any) -> int | None:
    return int(v[0]) if isinstance(v, (list, tuple)) and v else (int(v) if isinstance(v, int) and v else None)


def m2o_name(v: Any) -> str | None:
    return str(v[1]) if isinstance(v, (list, tuple)) and len(v) > 1 else None
