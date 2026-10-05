"""Read-only Odoo source.

Transport: the existing XML-RPC ``sales_pipeline.odoo.client.OdooClient`` (production is Odoo 17, which has no
JSON-2 API). ``GuardedOdooClient`` subclasses it and refuses, at ``execute_kw`` -- the one path every model
call takes -- any method that is not in ``READ_ONLY_METHODS``. create/write/unlink and every other method are
blocked in code, whatever the API user's rights are.

TODO(odoo-19): add a JSON-2 transport (POST /json/2/<model>/<method>, bearer key, named arguments) behind
this same interface when production moves to Odoo 19+. See docs/receivables-etl.md.

Safety
* Production guard: ODOO_DB must equal ODOO_PROD_DB and the host of ODOO_URL must be in ODOO_ALLOWED_HOSTS
  (ALLOW_NON_PROD=1 overrides). The hostname alone proves nothing: Odoo.sh serves the production database
  under a *.dev.odoo.com name too.
* Credentials come from the environment by profile (``default`` = ODOO_USER/ODOO_API_KEY; any other profile
  ``x`` = ODOO_X_LOGIN / ODOO_X_API_KEY / optional ODOO_X_KEY_EXPIRES). Keys are never logged or repr'd.
"""

from __future__ import annotations

import datetime as _dt
import logging
import os
from dataclasses import dataclass, field
from typing import Any, Iterable, Sequence
from urllib.parse import urlparse

from etl_platform.config import PlatformConfig
from etl_platform.notify import notify
from etl_platform.watermark import ODOO_DATETIME_FORMAT
from sales_pipeline.odoo.client import OdooApiError, OdooClient

logger = logging.getLogger(__name__)

READ_ONLY_METHODS = frozenset({"search_read", "search_count", "search", "read", "fields_get", "read_group"})


class OdooWriteBlockedError(OdooApiError):
    """A non-read-only Odoo method was attempted."""


class OdooAuthError(OdooApiError):
    """Odoo rejected the login/API key (invalid, revoked or expired)."""


class OdooGuardError(RuntimeError):
    """The configured Odoo target is not the approved production database/host."""


class OdooConfigError(RuntimeError):
    """Required Odoo settings are missing."""


# -- client ----------------------------------------------------------------------------------------------------
@dataclass
class GuardedOdooClient(OdooClient):
    def execute_kw(self, model: str, method: str, args: list[Any] | None = None, kwargs: dict[str, Any] | None = None) -> Any:
        if method not in READ_ONLY_METHODS:
            raise OdooWriteBlockedError(
                f"Blocked Odoo call {model}.{method}: the ETL is read-only (allowed: {', '.join(sorted(READ_ONLY_METHODS))})"
            )
        return super().execute_kw(model, method, args, kwargs)

    def authenticate(self) -> int:
        try:
            return super().authenticate()
        except OdooApiError as exc:
            if str(exc).startswith("Odoo authentication failed"):
                raise OdooAuthError(str(exc)) from exc
            raise

    def server_version(self) -> str:
        """``/xmlrpc/2/common version()``: unauthenticated and read-only."""
        try:
            info = self._common.version()
        except Exception as exc:  # noqa: BLE001 - informational only
            logger.warning("Could not read the Odoo server version: %s", exc)
            return "unknown"
        return str(info.get("server_version", "unknown")) if isinstance(info, dict) else str(info)


# -- guard and credentials ----------------------------------------------------------------------------------------
def check_production_target(url: str, db: str, *, prod_db: str, allowed_hosts: Sequence[str], allow_non_prod: bool) -> None:
    host = (urlparse(url).hostname or "").lower()
    if allow_non_prod:
        notify("WARNING", "ALLOW_NON_PROD=1: the Odoo production guard is disabled for this run", odoo_host=host, odoo_db=db)
        return
    problems = []
    if not url or not db:
        problems.append("ODOO_URL and ODOO_DB must be set")
    if not prod_db or not allowed_hosts:
        problems.append("ODOO_PROD_DB and ODOO_ALLOWED_HOSTS must be set (the production guard needs both)")
    if urlparse(url).scheme != "https":
        problems.append("ODOO_URL must use https")
    if prod_db and db != prod_db:
        problems.append(f"ODOO_DB '{db}' is not the production database ODOO_PROD_DB '{prod_db}'")
    if allowed_hosts and host not in {h.lower() for h in allowed_hosts}:
        problems.append(f"host '{host}' is not in ODOO_ALLOWED_HOSTS ({', '.join(allowed_hosts)})")
    if problems:
        raise OdooGuardError("Refusing to run against this Odoo target: " + "; ".join(problems) + ". Set ALLOW_NON_PROD=1 to override.")


@dataclass(frozen=True)
class OdooCredentials:
    profile: str
    login: str
    api_key: str = field(repr=False)
    key_expires: _dt.date | None = None

    @staticmethod
    def env_names(profile: str) -> tuple[str, str, str]:
        if profile == "default":
            return "ODOO_USER", "ODOO_API_KEY", "ODOO_KEY_EXPIRES"
        p = profile.upper()
        return f"ODOO_{p}_LOGIN", f"ODOO_{p}_API_KEY", f"ODOO_{p}_KEY_EXPIRES"

    @classmethod
    def from_env(cls, profile: str = "default") -> "OdooCredentials":
        login_var, key_var, expires_var = cls.env_names(profile)
        login, key = os.getenv(login_var, "").strip(), os.getenv(key_var, "").strip()
        missing = [name for name, value in ((login_var, login), (key_var, key)) if not value]
        if missing:
            raise OdooConfigError(f"Odoo credential profile '{profile}' is missing {', '.join(missing)}")
        raw_expiry = os.getenv(expires_var, "").strip()
        expires = None
        if raw_expiry:
            try:
                expires = _dt.date.fromisoformat(raw_expiry)
            except ValueError:
                raise OdooConfigError(f"{expires_var} must be a date (YYYY-MM-DD)") from None
        return cls(profile, login, key, expires)


def key_expiry_message(creds: OdooCredentials, today: _dt.date, warn_days: int) -> tuple[str, str] | None:
    """(level, message) when the key is expired or expires within ``warn_days``; None otherwise or when no
    expiry date is configured."""
    if creds.key_expires is None:
        return None
    _, key_var, expires_var = OdooCredentials.env_names(creds.profile)
    days = (creds.key_expires - today).days
    if days < 0:
        return "ERROR", f"Odoo API key for profile '{creds.profile}' expired on {creds.key_expires}: create a new key, update {key_var} and {expires_var}"
    if days <= warn_days:
        return "WARNING", f"Odoo API key for profile '{creds.profile}' expires in {days} day(s) on {creds.key_expires}: rotate it (docs/receivables-etl.md)"
    return None


# -- helpers for many2one values ---------------------------------------------------------------------------------
def m2o_id(value: Any) -> int | None:
    if isinstance(value, (list, tuple)) and value:
        return int(value[0])
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    return None


def m2o_name(value: Any) -> str | None:
    if isinstance(value, (list, tuple)) and len(value) > 1:
        return str(value[1])
    return None


def _chunked(values: Sequence[Any], size: int) -> Iterable[list[Any]]:
    for i in range(0, len(values), size):
        yield list(values[i:i + size])


# -- source -------------------------------------------------------------------------------------------------------
class OdooSource:
    mode = "xmlrpc"

    def __init__(
        self, client: GuardedOdooClient, *, profile: str = "default", company_ids: Sequence[int] = (),
        page_size: int = 2000, id_chunk_size: int = 500, lang: str = "en_US",
    ) -> None:
        self.client = client
        self.profile = profile
        self.company_ids = tuple(company_ids)
        self.page_size = page_size
        self.id_chunk_size = id_chunk_size
        self.lang = lang
        self.server_version: str | None = None
        self._fields: dict[str, dict[str, Any]] = {}
        self._reported_skips: set[tuple[str, tuple[str, ...]]] = set()

    @classmethod
    def connect(cls, config: PlatformConfig, profile: str = "default", *, today: _dt.date | None = None) -> "OdooSource":
        check_production_target(
            config.odoo_url, config.odoo_db, prod_db=config.odoo_prod_db,
            allowed_hosts=config.odoo_allowed_hosts, allow_non_prod=config.allow_non_prod,
        )
        creds = OdooCredentials.from_env(profile)
        expiry = key_expiry_message(creds, today or _dt.date.today(), config.key_expiry_warn_days)
        if expiry:
            notify(expiry[0], expiry[1], profile=profile)
        client = GuardedOdooClient(
            url=config.odoo_url, db=config.odoo_db, username=creds.login, api_key=creds.api_key,
            timeout_seconds=config.odoo_timeout_seconds, max_retries=config.odoo_max_retries,
            connect_retry_window_seconds=config.odoo_connect_retry_window_seconds,
        )
        source = cls(client, profile=profile, company_ids=config.odoo_company_ids,
                     page_size=config.odoo_page_size, id_chunk_size=config.odoo_id_chunk_size)
        source.open()
        return source

    def open(self) -> None:
        self.server_version = self.client.server_version()
        try:
            self.client.authenticate()
        except OdooAuthError:
            _, key_var, _ = OdooCredentials.env_names(self.profile)
            notify("ERROR", f"Odoo rejected the API key for credential profile '{self.profile}' (invalid, revoked or expired). "
                            f"Create a new key for the bot user and update {key_var}.", profile=self.profile)
            raise
        logger.info("Odoo source ready: mode=%s server_version=%s profile=%s", self.mode, self.server_version, self.profile)

    @property
    def context(self) -> dict[str, Any]:
        ctx: dict[str, Any] = {"lang": self.lang}
        if self.company_ids:
            ctx["allowed_company_ids"] = list(self.company_ids)
        return ctx

    def _ctx(self, include_archived: bool, company_ids: Sequence[int] | None = None) -> dict[str, Any]:
        ctx = self.context
        if include_archived:
            ctx["active_test"] = False
        if company_ids is not None:
            # company-dependent fields (credit_limit, property_payment_term_id) are read for the FIRST
            # allowed company: pass one company to get that company's values
            ctx["allowed_company_ids"] = list(company_ids)
        return ctx

    # -- fields ---------------------------------------------------------------------------------------------
    def model_fields(self, model: str) -> dict[str, Any]:
        if model not in self._fields:
            self._fields[model] = self.client.fields_get(model, attributes=["type", "relation", "store", "string"])
        return self._fields[model]

    def field_labels(self, model: str, fields: Sequence[str], lang: str) -> dict[str, Any]:
        """fields_get in one language: {field: {"string": label, "selection": [[value, label], ...]}}. Display labels
        always come from here, never from code (docs/adding-a-department.md, "Odoo labels")."""
        ctx = {**self.context, "lang": lang}
        return self.client.execute_kw(model, "fields_get", [list(fields)], {"attributes": ["string", "selection"], "context": ctx})

    def active_languages(self) -> list[str]:
        return [r["code"] for r in self.search_read_all("res.lang", [("active", "=", True)], ["code"])]

    def has_field(self, model: str, name: str) -> bool:
        return name in self.model_fields(model)

    def available_fields(self, model: str, requested: Sequence[str]) -> tuple[list[str], list[str]]:
        """Requested fields that exist on the model (order kept) and the ones skipped. Skips are a warning,
        never a failure."""
        meta = self.model_fields(model)
        present = [f for f in requested if f in meta]
        skipped = [f for f in requested if f not in meta]
        key = (model, tuple(skipped))
        if skipped and key not in self._reported_skips:
            self._reported_skips.add(key)
            notify("WARNING", f"Odoo {model}: field(s) not available and skipped: {', '.join(skipped)}", model=model)
        return present, skipped

    # -- reads ----------------------------------------------------------------------------------------------
    def search_read_all(self, model: str, domain: Sequence[Any], fields: Sequence[str], *, order: str = "id",
                        include_archived: bool = False, company_ids: Sequence[int] | None = None) -> list[dict[str, Any]]:
        """Every matching record, paged by offset in ``order`` (default id)."""
        out: list[dict[str, Any]] = []
        offset = 0
        while True:
            page = self.client.search_read(model, list(domain), list(fields), offset=offset, limit=self.page_size,
                                           order=order, context=self._ctx(include_archived, company_ids))
            out.extend(page)
            if len(page) < self.page_size:
                break
            offset += self.page_size
        logger.info("Odoo %s: %s record(s)", model, f"{len(out):,}")
        return out

    def search_read_incremental(self, model: str, domain: Sequence[Any], fields: Sequence[str], *,
                                since: _dt.datetime | None, field: str = "write_date",
                                include_archived: bool = True) -> list[dict[str, Any]]:
        """Records with ``field >= since`` (all records when ``since`` is None), paged by offset in id order.

        Not keyset paging on (write_date, id): Odoo stores write_date with microseconds but returns it truncated
        to the second, so an equality on the returned value never matches and the same boundary rows come back
        forever when a bulk import gives thousands of records the same second. Id order is stable, and a record
        modified while we page only gets a newer write_date, so it stays in the set; new records get higher ids
        and land on a later page. The caller's watermark overlap (ETL_INCREMENTAL_OVERLAP_SECONDS) re-reads the
        truncated second next time. Duplicates (a record read twice) are removed by id, keeping the last read."""
        wanted = list(dict.fromkeys([*fields, "id", field]))
        base = list(domain)
        if since is not None:
            base.append((field, ">=", since.strftime(ODOO_DATETIME_FORMAT)))
        by_id: dict[int, dict[str, Any]] = {}
        offset = 0
        while True:
            page = self.client.search_read(model, base, wanted, offset=offset, limit=self.page_size,
                                           order="id asc", context=self._ctx(include_archived))
            for rec in page:
                by_id[int(rec["id"])] = rec
            if len(page) < self.page_size:
                break
            offset += self.page_size
        out = [by_id[i] for i in sorted(by_id)]
        logger.info("Odoo %s incremental since %s: %s record(s)", model, since, f"{len(out):,}")
        return out

    def read_by_ids(self, model: str, ids: Iterable[int], fields: Sequence[str], *, include_archived: bool = True) -> list[dict[str, Any]]:
        """Lookup of specific records, in chunks of ``id_chunk_size`` ids."""
        unique_ids = sorted({int(i) for i in ids if i is not None})
        out: list[dict[str, Any]] = []
        for chunk in _chunked(unique_ids, self.id_chunk_size):
            out.extend(self.client.search_read(model, [("id", "in", chunk)], list(fields), offset=0, limit=len(chunk),
                                               order="id", context=self._ctx(include_archived)))
        return out

    def search_ids(self, model: str, domain: Sequence[Any] = (), *, include_archived: bool = True) -> list[int]:
        """All ids matching ``domain``: used by the nightly deleted-record reconciliation."""
        ids = self.client.execute_kw(model, "search", [list(domain)], {"order": "id", "context": self._ctx(include_archived)})
        return [int(i) for i in ids]
