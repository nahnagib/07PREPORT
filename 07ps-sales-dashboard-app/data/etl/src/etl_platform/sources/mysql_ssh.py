"""Read-only source: a remote MySQL database, optionally reached through an SSH tunnel.

Generic (any future MySQL source can use it). Each source is a **credential profile** whose settings are environment
variables with the profile's prefix, mirroring the Odoo profiles (``ODOO_<PROFILE>_*``). Profile ``NPS``:

  NPS_SSH_ENABLED     true (default) = tunnel; false = connect to NPS_DB_HOST directly (ETL on the same server)
  NPS_SSH_HOST / NPS_SSH_PORT / NPS_SSH_USER
  NPS_SSH_KEY_PATH    private key file (preferred; mounted read-only in the container), or
  NPS_SSH_PASSWORD
  NPS_SSH_HOST_KEY    expected server host key fingerprint (SHA256:...), and/or
  NPS_SSH_KNOWN_HOSTS a known_hosts file. One of the two is required: an unknown or different host key is refused.
  NPS_DB_HOST / NPS_DB_PORT   the MySQL address AS SEEN FROM THE SSH SERVER (127.0.0.1:3306)
  NPS_DB_NAME / NPS_DB_USER / NPS_DB_PASSWORD
  NPS_CONNECT_RETRY_WINDOW_SECONDS  network failures at connect are retried with backoff for this long (default 900)

Safety
* Read-only: every connection runs ``SET SESSION TRANSACTION READ ONLY``, and the only helpers are ``read_query``
  (one SELECT / SHOW / WITH statement) and ``read_table_incremental``. Nothing here writes to the source.
* The tunnel listens on 127.0.0.1 only, on a free port, is opened per run and always closed (context manager).
  Keepalive 30 s, connect/read timeouts.
* Host key verification is always on: the key must be in the known_hosts file or match NPS_SSH_HOST_KEY. There is no
  auto-add.
* Retries are for network failures only. A rejected SSH login, a host key mismatch, a rejected MySQL login (1045) or
  an unknown database (1049) fail at once with a message saying what to check.
* Secrets are never logged or repr'd; the log says which SSH auth method was used.
"""

from __future__ import annotations

import base64
import contextlib
import hashlib
import logging
import os
import re
import select
import socket
import socketserver
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterator, Mapping, Sequence

logger = logging.getLogger(__name__)

KEEPALIVE_SECONDS = 30
CONNECT_TIMEOUT_SECONDS = 15
READ_TIMEOUT_SECONDS = 300
_READ_ONLY_SQL = re.compile(r"^\s*(SELECT|SHOW|WITH)\b", re.I)


class MySqlSourceError(RuntimeError):
    """The source could not be read; the message says what to check."""


class MySqlSourceConfigError(MySqlSourceError):
    """Required settings of the profile are missing or invalid."""


class SshHostKeyError(MySqlSourceError):
    """The SSH server's host key is unknown or differs from the expected one."""


class SshAuthError(MySqlSourceError):
    """The SSH server rejected the login."""


class MySqlAuthError(MySqlSourceError):
    """MySQL rejected the login (1045) or the database does not exist (1049)."""


class SourceUnreachableError(MySqlSourceError):
    """A network failure (SSH server or MySQL unreachable, timeout); retried within the retry window."""


class ReadOnlyViolation(MySqlSourceError):
    """A statement that is not a single SELECT / SHOW / WITH was attempted."""


def _bool(value: str, default: bool) -> bool:
    value = (value or "").strip().lower()
    if not value:
        return default
    return value in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class MySqlSshSettings:
    profile: str
    db_name: str
    db_user: str
    db_password: str = field(repr=False)
    db_host: str = "127.0.0.1"
    db_port: int = 3306
    ssh_enabled: bool = True
    ssh_host: str = ""
    ssh_port: int = 22
    ssh_user: str = ""
    ssh_password: str = field(default="", repr=False)
    ssh_key_path: str = ""
    ssh_host_key: str = ""
    ssh_known_hosts: str = ""
    connect_retry_window_seconds: float = 900.0
    connect_timeout_seconds: int = CONNECT_TIMEOUT_SECONDS
    read_timeout_seconds: int = READ_TIMEOUT_SECONDS

    @property
    def auth_method(self) -> str:
        return "key" if self.ssh_key_path else "password"

    @classmethod
    def from_env(cls, profile: str, env: Mapping[str, str] | None = None) -> "MySqlSshSettings":
        """Reads ``<PROFILE>_*``. Raises MySqlSourceConfigError naming EVERY missing variable (never their values)."""
        env = os.environ if env is None else env
        p = profile.upper()

        def get(name: str, default: str = "") -> str:
            return (env.get(f"{p}_{name}") or default).strip()

        ssh_enabled = _bool(get("SSH_ENABLED"), True)
        required = ["DB_NAME", "DB_USER", "DB_PASSWORD"]
        if ssh_enabled:
            required += ["SSH_HOST", "SSH_PORT", "SSH_USER"]
        missing = [f"{p}_{n}" for n in required if not get(n)]
        if ssh_enabled:
            if not (get("SSH_KEY_PATH") or get("SSH_PASSWORD")):
                missing.append(f"{p}_SSH_KEY_PATH or {p}_SSH_PASSWORD")
            if not (get("SSH_HOST_KEY") or get("SSH_KNOWN_HOSTS")):
                missing.append(f"{p}_SSH_HOST_KEY or {p}_SSH_KNOWN_HOSTS")
        if missing:
            raise MySqlSourceConfigError(f"MySQL source profile '{p}' is missing: {', '.join(missing)}")
        try:
            db_port = int(get("DB_PORT", "3306"))
            ssh_port = int(get("SSH_PORT", "22"))
            window = float(get("CONNECT_RETRY_WINDOW_SECONDS", "900"))
        except ValueError:
            raise MySqlSourceConfigError(f"{p}_DB_PORT, {p}_SSH_PORT and {p}_CONNECT_RETRY_WINDOW_SECONDS must be numbers") from None
        if not (1 <= db_port <= 65535 and 1 <= ssh_port <= 65535):
            raise MySqlSourceConfigError(f"{p}_DB_PORT and {p}_SSH_PORT must be between 1 and 65535")
        key_path = get("SSH_KEY_PATH")
        if ssh_enabled and key_path and not Path(os.path.expanduser(key_path)).is_file():
            raise MySqlSourceConfigError(f"{p}_SSH_KEY_PATH does not point to an existing file")
        known_hosts = get("SSH_KNOWN_HOSTS")
        if ssh_enabled and known_hosts and not Path(os.path.expanduser(known_hosts)).is_file():
            raise MySqlSourceConfigError(f"{p}_SSH_KNOWN_HOSTS does not point to an existing file")
        return cls(
            profile=p, db_name=get("DB_NAME"), db_user=get("DB_USER"), db_password=get("DB_PASSWORD"),
            db_host=get("DB_HOST", "127.0.0.1"), db_port=db_port, ssh_enabled=ssh_enabled, ssh_host=get("SSH_HOST"),
            ssh_port=ssh_port, ssh_user=get("SSH_USER"), ssh_password=get("SSH_PASSWORD"),
            ssh_key_path=os.path.expanduser(key_path) if key_path else "", ssh_host_key=get("SSH_HOST_KEY"),
            ssh_known_hosts=os.path.expanduser(known_hosts) if known_hosts else "", connect_retry_window_seconds=max(0.0, window),
        )


# -- host key ----------------------------------------------------------------------------------------------------------
def fingerprint(key: Any) -> str:
    """OpenSSH-style SHA256 fingerprint of a paramiko key (``ssh-keygen -l``)."""
    return "SHA256:" + base64.b64encode(hashlib.sha256(key.asbytes()).digest()).decode().rstrip("=")


def _same_fingerprint(a: str, b: str) -> bool:
    norm = lambda s: s.strip().removeprefix("SHA256:").rstrip("=")  # noqa: E731
    return bool(a.strip()) and norm(a) == norm(b)


def _pinned_policy(expected: str):
    import paramiko

    class PinnedHostKeyPolicy(paramiko.MissingHostKeyPolicy):
        """A host key that is not in known_hosts is accepted only when it matches the expected fingerprint."""

        def missing_host_key(self, client, hostname, key):
            got = fingerprint(key)
            if not expected:
                raise SshHostKeyError(f"SSH host key of {hostname} is not in the known_hosts file and no expected "
                                      f"fingerprint is configured (server offers {got}). Refusing to connect.")
            if not _same_fingerprint(expected, got):
                raise SshHostKeyError(f"SSH HOST KEY MISMATCH for {hostname}: the server offers {got}, the expected key is "
                                      f"{expected}. Refusing to connect (the server was replaced, or the connection is "
                                      "intercepted). Check with the server owner before changing the expected key.")

    return PinnedHostKeyPolicy()


# -- tunnel ------------------------------------------------------------------------------------------------------------
class _ForwardServer(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


def _forward_handler(transport: Any, remote: tuple[str, int]):
    class Handler(socketserver.BaseRequestHandler):
        def handle(self) -> None:
            try:
                chan = transport.open_channel("direct-tcpip", remote, self.request.getpeername())
            except Exception as exc:  # noqa: BLE001 - surfaces to the client as a closed connection
                logger.error("SSH port forward to %s:%s refused: %s", remote[0], remote[1], exc)
                return
            try:
                while True:
                    ready, _, _ = select.select([self.request, chan], [], [], KEEPALIVE_SECONDS * 2)
                    if self.request in ready:
                        data = self.request.recv(65536)
                        if not data:
                            break
                        chan.sendall(data)
                    if chan in ready:
                        data = chan.recv(65536)
                        if not data:
                            break
                        self.request.sendall(data)
            finally:
                chan.close()

    return Handler


@contextlib.contextmanager
def ssh_tunnel(settings: MySqlSshSettings, *, client_factory: Callable[[], Any] | None = None) -> Iterator[tuple[str, int]]:
    """Opens the SSH tunnel; yields the local (host, port) that forwards to the MySQL address. Always closed."""
    import paramiko

    client = client_factory() if client_factory else paramiko.SSHClient()
    if settings.ssh_known_hosts:
        client.load_host_keys(settings.ssh_known_hosts)
    client.set_missing_host_key_policy(_pinned_policy(settings.ssh_host_key))
    auth: dict[str, Any] = {"key_filename": settings.ssh_key_path} if settings.ssh_key_path else {"password": settings.ssh_password}
    logger.info("Opening SSH tunnel for source %s: %s@%s:%s (auth=%s) -> %s:%s", settings.profile, settings.ssh_user,
                settings.ssh_host, settings.ssh_port, settings.auth_method, settings.db_host, settings.db_port)
    server = None
    try:
        try:
            client.connect(settings.ssh_host, port=settings.ssh_port, username=settings.ssh_user,
                           timeout=settings.connect_timeout_seconds, banner_timeout=settings.connect_timeout_seconds,
                           auth_timeout=settings.connect_timeout_seconds, allow_agent=False, look_for_keys=False, **auth)
        except SshHostKeyError:
            raise
        except paramiko.BadHostKeyException as exc:
            raise SshHostKeyError(f"SSH HOST KEY MISMATCH for {settings.ssh_host}: the server offers {fingerprint(exc.key)}, "
                                  f"the known_hosts file has {fingerprint(exc.expected_key)}. Refusing to connect.") from None
        except paramiko.AuthenticationException:
            raise SshAuthError(f"The SSH server rejected the login for {settings.profile}_SSH_USER using {settings.auth_method} "
                               f"authentication: check {settings.profile}_SSH_USER and "
                               f"{settings.profile}_SSH_{'KEY_PATH' if settings.auth_method == 'key' else 'PASSWORD'}.") from None
        except (OSError, EOFError, paramiko.SSHException) as exc:
            raise SourceUnreachableError(f"Cannot reach the SSH server {settings.ssh_host}:{settings.ssh_port}: "
                                         f"{type(exc).__name__}: {exc}") from None
        transport = client.get_transport()
        transport.set_keepalive(KEEPALIVE_SECONDS)
        logger.info("SSH host key verified: %s", fingerprint(transport.get_remote_server_key()))
        server = _ForwardServer(("127.0.0.1", 0), _forward_handler(transport, (settings.db_host, settings.db_port)))
        threading.Thread(target=server.serve_forever, name=f"ssh-forward-{settings.profile}", daemon=True).start()
        yield "127.0.0.1", int(server.server_address[1])
    finally:
        if server is not None:
            server.shutdown()
            server.server_close()
        client.close()
        logger.info("SSH tunnel for source %s closed", settings.profile)


# -- MySQL -------------------------------------------------------------------------------------------------------------
def mysql_error(exc: BaseException, settings: MySqlSshSettings) -> MySqlSourceError:
    """Maps a driver error to one of ours with a message that says what to check (never a secret)."""
    orig = getattr(exc, "orig", exc)
    code = orig.args[0] if getattr(orig, "args", None) else None
    p = settings.profile
    where = f"{settings.db_host}:{settings.db_port}" + (" through the SSH tunnel" if settings.ssh_enabled else "")
    if code in (2002, 2003, 2005, 2006, 2013):
        return SourceUnreachableError(f"Cannot reach MySQL at {where} (error {code}). Check {p}_DB_HOST / {p}_DB_PORT as seen "
                                      "from the SSH server, the MySQL listener, and whether SSH port forwarding is allowed.")
    if code == 1045:
        return MySqlAuthError(f"MySQL rejected the login (1045): check {p}_DB_USER / {p}_DB_PASSWORD and whether that account "
                              "may connect from the SSH server (host 127.0.0.1 / localhost).")
    if code == 1049:
        return MySqlAuthError(f"MySQL has no database named {settings.db_name!r} (1049): check {p}_DB_NAME.")
    if code in (1044, 1142, 1143):
        return MySqlAuthError(f"MySQL refused access ({code}): grant SELECT on {settings.db_name}.* to {p}_DB_USER.")
    return MySqlSourceError(f"MySQL source {p} failed: {type(orig).__name__}: {orig}")


def check_read_only(sql: str) -> None:
    body = sql.strip().rstrip(";")
    if not _READ_ONLY_SQL.match(body) or ";" in body:
        raise ReadOnlyViolation("Only one SELECT / SHOW / WITH statement may be run against a source: " + body[:80])


class MySqlSource:
    """Read-only access to one MySQL database over an open connection target (direct or tunnel)."""

    def __init__(self, settings: MySqlSshSettings, engine: Any) -> None:
        self.settings = settings
        self.engine = engine

    def read_query(self, sql: str, params: Mapping[str, Any] | None = None) -> list[dict[str, Any]]:
        from sqlalchemy import text
        from sqlalchemy.exc import DBAPIError

        check_read_only(sql)
        try:
            with self.engine.connect() as conn:
                return [dict(r._mapping) for r in conn.execute(text(sql), dict(params or {}))]
        except DBAPIError as exc:
            raise mysql_error(exc, self.settings) from None

    def read_table_incremental(self, table: str, columns: Sequence[str], *, key: str = "id", page_size: int = 5000,
                               since_column: str | None = None, since: Any = None) -> list[dict[str, Any]]:
        """Every row of ``table`` (or those with ``since_column >= since``), paged by ``key`` (keyset, ascending)."""
        ident = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
        for name in (table, key, *columns, *([since_column] if since_column else [])):
            if not ident.match(name):
                raise ReadOnlyViolation(f"Not a plain identifier: {name!r}")
        cols = ", ".join(f"`{c}`" for c in columns)
        where = f" AND `{since_column}` >= :since" if since_column else ""
        out: list[dict[str, Any]] = []
        last: Any = None
        while True:
            cond = f"`{key}` > :last" if last is not None else "1 = 1"
            rows = self.read_query(f"SELECT {cols} FROM `{table}` WHERE {cond}{where} ORDER BY `{key}` LIMIT {int(page_size)}",
                                   {"last": last, "since": since})
            out.extend(rows)
            if len(rows) < page_size:
                return out
            last = rows[-1][key]


def _engine(settings: MySqlSshSettings, host: str, port: int):
    from sqlalchemy import create_engine, event
    from sqlalchemy.engine import URL
    from sqlalchemy.pool import NullPool

    url = URL.create("mysql+pymysql", username=settings.db_user, password=settings.db_password, host=host, port=port,
                     database=settings.db_name, query={"charset": "utf8mb4"})
    engine = create_engine(url, poolclass=NullPool, pool_pre_ping=True, hide_parameters=True,
                           connect_args={"connect_timeout": settings.connect_timeout_seconds,
                                         "read_timeout": settings.read_timeout_seconds, "write_timeout": 30})

    @event.listens_for(engine, "connect")
    def _read_only(dbapi_conn, _record):  # every connection of this engine
        with dbapi_conn.cursor() as cur:
            cur.execute("SET SESSION TRANSACTION READ ONLY")
            cur.execute("SET SESSION time_zone = '+00:00'")  # TIMESTAMP columns come back in UTC

    return engine


def with_retries(fn: Callable[[], Any], *, window_seconds: float, sleep: Callable[[float], None] = time.sleep,
                 initial_delay: float = 5.0, max_delay: float = 120.0, label: str = "source") -> Any:
    """Runs ``fn``; a SourceUnreachableError is retried with exponential backoff until ``window_seconds`` have passed.
    Every other error (auth, host key, config, SQL) is raised at once."""
    started = time.monotonic()
    delay = initial_delay
    attempt = 0
    while True:
        attempt += 1
        try:
            return fn()
        except SourceUnreachableError as exc:
            elapsed = time.monotonic() - started
            if elapsed + delay > window_seconds:
                raise SourceUnreachableError(f"{exc} (gave up after {attempt} attempt(s), {elapsed:.0f}s)") from None
            logger.warning("%s unreachable on attempt %s (%s); retrying in %.0fs (retry window %.0fs)",
                           label, attempt, exc, delay, window_seconds)
            sleep(delay)
            delay = min(max_delay, delay * 2)


@contextlib.contextmanager
def open_source(settings: MySqlSshSettings, *, sleep: Callable[[float], None] = time.sleep) -> Iterator[MySqlSource]:
    """The connected read-only source (tunnel opened when enabled); everything is closed on exit."""
    stack = contextlib.ExitStack()

    def connect() -> MySqlSource:
        inner = contextlib.ExitStack()
        try:
            host, port = (inner.enter_context(ssh_tunnel(settings)) if settings.ssh_enabled
                          else (settings.db_host, settings.db_port))
            engine = _engine(settings, host, port)
            inner.callback(engine.dispose)
            source = MySqlSource(settings, engine)
            source.read_query("SELECT 1 AS ok")  # login + database checked here, inside the retry
        except BaseException:
            inner.close()
            raise
        stack.push(inner.pop_all())
        return source

    with stack:
        yield with_retries(connect, window_seconds=settings.connect_retry_window_seconds, sleep=sleep,
                           label=f"MySQL source {settings.profile}")
