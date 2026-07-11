from __future__ import annotations

import logging
import time
import xmlrpc.client
from dataclasses import dataclass
from urllib.parse import urlparse
from typing import Any


class OdooApiError(RuntimeError):
    """Raised when Odoo authentication or RPC calls fail."""


@dataclass
class OdooClient:
    url: str
    db: str
    username: str
    api_key: str
    timeout_seconds: int = 60
    max_retries: int = 5

    def __post_init__(self) -> None:
        self.url = self.url.rstrip("/")
        self.uid: int | None = None
        transport_cls = TimeoutSafeTransport if urlparse(self.url).scheme == "https" else TimeoutTransport
        transport = transport_cls(timeout=self.timeout_seconds)
        self._common = xmlrpc.client.ServerProxy(f"{self.url}/xmlrpc/2/common", allow_none=True, transport=transport)
        self._models = xmlrpc.client.ServerProxy(f"{self.url}/xmlrpc/2/object", allow_none=True, transport=transport)
        self._logger = logging.getLogger(__name__)

    def authenticate(self) -> int:
        last_exc: Exception | None = None
        for attempt in range(1, self.max_retries + 1):
            try:
                uid = self._common.authenticate(self.db, self.username, self.api_key, {})
                break
            except (OSError, TimeoutError, xmlrpc.client.ProtocolError) as exc:
                last_exc = exc
                self._logger.warning(
                    "Odoo authentication network request failed on attempt %s/%s for %s: %s",
                    attempt,
                    self.max_retries,
                    self.url,
                    exc,
                )
                if attempt < self.max_retries:
                    time.sleep(min(30, 2 * attempt))
            except xmlrpc.client.Fault as exc:
                raise OdooApiError(f"Odoo authentication RPC fault: {exc.faultString}") from exc
            except Exception as exc:  # noqa: BLE001
                raise OdooApiError(f"Odoo authentication request failed: {exc}") from exc
        else:
            raise OdooApiError(
                "Odoo authentication request failed after "
                f"{self.max_retries} attempt(s) for {self.url}: {last_exc}. "
                "Check internet/DNS/VPN/firewall connectivity and ODOO_URL in .env."
            ) from last_exc
        if not uid:
            raise OdooApiError("Odoo authentication failed. Check ODOO_DB, ODOO_USER, and ODOO_API_KEY.")
        self.uid = int(uid)
        return self.uid

    def execute_kw(self, model: str, method: str, args: list[Any] | None = None, kwargs: dict[str, Any] | None = None) -> Any:
        if self.uid is None:
            self.authenticate()
        args = args or []
        kwargs = kwargs or {}
        last_exc: Exception | None = None
        for attempt in range(1, self.max_retries + 1):
            try:
                return self._models.execute_kw(self.db, self.uid, self.api_key, model, method, args, kwargs)
            except (OSError, TimeoutError, xmlrpc.client.ProtocolError) as exc:
                last_exc = exc
                wait_s = min(30, 2 * attempt)
                self._logger.warning("Odoo RPC %s.%s failed on attempt %s/%s: %s", model, method, attempt, self.max_retries, exc)
                time.sleep(wait_s)
            except xmlrpc.client.Fault as exc:
                raise OdooApiError(f"Odoo RPC fault in {model}.{method}: {exc.faultString}") from exc
        raise OdooApiError(f"Odoo RPC {model}.{method} failed after {self.max_retries} attempts: {last_exc}") from last_exc

    def fields_get(self, model: str, attributes: list[str] | None = None) -> dict[str, Any]:
        kwargs: dict[str, Any] = {}
        if attributes:
            kwargs["attributes"] = attributes
        return self.execute_kw(model, "fields_get", [], kwargs)

    def search_count(self, model: str, domain: list[Any], context: dict[str, Any] | None = None) -> int:
        kwargs: dict[str, Any] = {}
        if context:
            kwargs["context"] = context
        return int(self.execute_kw(model, "search_count", [domain], kwargs))

    def search_read(
        self,
        model: str,
        domain: list[Any],
        fields: list[str],
        offset: int = 0,
        limit: int = 500,
        order: str = "id",
        context: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        kwargs: dict[str, Any] = {"fields": fields, "offset": offset, "limit": limit, "order": order}
        if context:
            kwargs["context"] = context
        return self.execute_kw(
            model,
            "search_read",
            [domain],
            kwargs,
        )


class TimeoutTransport(xmlrpc.client.Transport):
    def __init__(self, timeout: int) -> None:
        super().__init__()
        self.timeout = timeout

    def make_connection(self, host: str):  # type: ignore[no-untyped-def]
        conn = super().make_connection(host)
        conn.timeout = self.timeout
        return conn


class TimeoutSafeTransport(xmlrpc.client.SafeTransport):
    def __init__(self, timeout: int) -> None:
        super().__init__()
        self.timeout = timeout

    def make_connection(self, host: str):  # type: ignore[no-untyped-def]
        conn = super().make_connection(host)
        conn.timeout = self.timeout
        return conn
