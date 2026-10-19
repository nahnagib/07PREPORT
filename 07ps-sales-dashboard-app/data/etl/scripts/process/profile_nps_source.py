"""Phase 0 (NPS Score): read-only profile of the NPS source database, reached through an SSH tunnel.

  python scripts/process/profile_nps_source.py
  python scripts/process/profile_nps_source.py --reach-only [--recheck-minutes 5]   # whatsapp_outbound_messages only

Throwaway discovery script. It is not part of the ETL, and nothing in src/ imports it.
- **Source:** reads only, inside a READ ONLY session, and never writes (not even to `sync_state`).
- **Warehouse:** reads only from the local warehouse (DB_* from data/etl/.env) for the key match rates.
- **Output:** written to scripts/process/output/ (gitignored). Mobile numbers and e-mail addresses are masked.
  Secrets are never printed.

Settings come from the NPS_* variables in data/etl/.env:
- SSH: NPS_SSH_ENABLED, NPS_SSH_HOST, NPS_SSH_PORT, NPS_SSH_USER, NPS_SSH_PASSWORD or NPS_SSH_KEY_PATH,
  NPS_SSH_HOST_KEY.
- Database: NPS_DB_HOST, NPS_DB_PORT, NPS_DB_NAME, NPS_DB_USER, NPS_DB_PASSWORD.

Host key: the server key must be in ~/.ssh/known_hosts (or NPS_SSH_KNOWN_HOSTS), or its fingerprint must equal
NPS_SSH_HOST_KEY (SHA256:...). Otherwise the script refuses to connect.
"""

from __future__ import annotations

import base64
import collections
import contextlib
import datetime as _dt
import hashlib
import os
import re
import select
import socket
import socketserver
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
for p in (ROOT, ROOT / "src"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

import paramiko  # noqa: E402
import pymysql  # noqa: E402
from dotenv import load_dotenv  # noqa: E402
from sqlalchemy import create_engine, text  # noqa: E402

from etl_platform.config import PlatformConfig  # noqa: E402

OUT_DIR = Path(__file__).resolve().parent / "output"
TABLES = ("nps_rating_full_data", "low_rating_data")
PERSONAL = {"mobile_number", "recipient_email"}  # stats only, never selected as values

# --------------------------------------------------------------------------------------------- output / masking
_lines: list[str] = []
PHONE = re.compile(r"(?<!\d)(?:\+?\d[\d\s\-]{6,}\d)(?!\d)")
EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
ARABIC_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789")


def mask(value) -> str:
    s = "" if value is None else str(value)
    s = EMAIL.sub("<email>", s)
    return PHONE.sub("<phone>", s)


def out(*parts) -> None:
    line = " ".join(str(p) for p in parts)
    print(line, flush=True)
    _lines.append(line)


def section(title: str) -> None:
    out("")
    out("=" * 100)
    out(title)
    out("=" * 100)


# --------------------------------------------------------------------------------------------- tunnel
def env(name: str, default: str | None = None) -> str:
    return (os.getenv(name) or default or "").strip()


def require(names: list[str]) -> None:
    missing = [n for n in names if not env(n)]
    if missing:
        raise SystemExit("Missing in data/etl/.env: " + ", ".join(missing))


def fingerprint(key: paramiko.PKey) -> str:
    return "SHA256:" + base64.b64encode(hashlib.sha256(key.asbytes()).digest()).decode().rstrip("=")


class _PinnedKeyPolicy(paramiko.MissingHostKeyPolicy):
    """Accepts a host key that is not in known_hosts only when its SHA256 fingerprint equals NPS_SSH_HOST_KEY."""

    def __init__(self, expected: str):
        self.expected = expected.strip()

    def missing_host_key(self, client, hostname, key):
        got = fingerprint(key)
        if not self.expected:
            raise paramiko.SSHException(f"Host key of {hostname} is not in known_hosts and NPS_SSH_HOST_KEY is not set (server offers {got}).")
        if got.rstrip("=") != self.expected.rstrip("="):
            raise paramiko.SSHException(f"HOST KEY MISMATCH for {hostname}: server offers {got}, NPS_SSH_HOST_KEY expects {self.expected}. Refusing to connect.")


class _Forwarder(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


def _handler(transport: paramiko.Transport, remote: tuple[str, int]):
    class Handler(socketserver.BaseRequestHandler):
        def handle(self):
            chan = transport.open_channel("direct-tcpip", remote, self.request.getpeername())
            try:
                while True:
                    r, _, _ = select.select([self.request, chan], [], [], 60)
                    if self.request in r:
                        data = self.request.recv(65536)
                        if not data:
                            break
                        chan.sendall(data)
                    if chan in r:
                        data = chan.recv(65536)
                        if not data:
                            break
                        self.request.sendall(data)
            finally:
                chan.close()
    return Handler


@contextlib.contextmanager
def tunnel():
    db_host, db_port = env("NPS_DB_HOST", "127.0.0.1"), int(env("NPS_DB_PORT", "3306"))
    if env("NPS_SSH_ENABLED", "true").lower() in ("0", "false", "no"):
        yield db_host, db_port
        return
    require(["NPS_SSH_HOST", "NPS_SSH_PORT", "NPS_SSH_USER"])
    if not (env("NPS_SSH_PASSWORD") or env("NPS_SSH_KEY_PATH")):
        raise SystemExit("Missing in data/etl/.env: NPS_SSH_PASSWORD or NPS_SSH_KEY_PATH")
    client = paramiko.SSHClient()
    known = env("NPS_SSH_KNOWN_HOSTS") or str(Path.home() / ".ssh" / "known_hosts")
    if Path(known).is_file():
        client.load_host_keys(known)
    client.set_missing_host_key_policy(_PinnedKeyPolicy(env("NPS_SSH_HOST_KEY")))
    auth = {"key_filename": os.path.expanduser(env("NPS_SSH_KEY_PATH"))} if env("NPS_SSH_KEY_PATH") else {"password": env("NPS_SSH_PASSWORD")}
    out(f"SSH: {env('NPS_SSH_USER')}@{env('NPS_SSH_HOST')}:{env('NPS_SSH_PORT')} auth={'key' if 'key_filename' in auth else 'password'}")
    client.connect(env("NPS_SSH_HOST"), port=int(env("NPS_SSH_PORT")), username=env("NPS_SSH_USER"), timeout=15,
                   banner_timeout=15, auth_timeout=15, allow_agent=False, look_for_keys=False, **auth)
    transport = client.get_transport()
    transport.set_keepalive(30)
    out(f"SSH host key verified: {fingerprint(transport.get_remote_server_key())}")
    server = _Forwarder(("127.0.0.1", 0), _handler(transport, (db_host, db_port)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield "127.0.0.1", server.server_address[1]
    finally:
        server.shutdown()
        server.server_close()
        client.close()


# --------------------------------------------------------------------------------------------- profile
def main() -> int:
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--reach-only", action="store_true", help="profile whatsapp_outbound_messages only")
    parser.add_argument("--recheck-minutes", type=float, default=5, help="minutes between the two reads of the deletion check (0 = skip)")
    args = parser.parse_args()
    load_dotenv(ROOT / ".env")
    require(["NPS_DB_USER", "NPS_DB_PASSWORD"])
    OUT_DIR.mkdir(exist_ok=True)
    with tunnel() as (host, port):
        src = pymysql.connect(host=host, port=port, user=env("NPS_DB_USER"), password=env("NPS_DB_PASSWORD"),
                              database=env("NPS_DB_NAME", "xtremech_nps_dashboard"), charset="utf8mb4",
                              connect_timeout=15, read_timeout=300, cursorclass=pymysql.cursors.DictCursor)
        try:
            with src.cursor() as cur:
                cur.execute("SET SESSION TRANSACTION READ ONLY")
            if not args.reach_only:
                profile(src)
            profile_reach(src, args.recheck_minutes)
        finally:
            src.close()
    path = OUT_DIR / f"nps_profile_{_dt.datetime.now():%Y%m%d_%H%M%S}.txt"
    path.write_text("\n".join(_lines), encoding="utf-8")
    print(f"\nReport written to {path}")
    return 0


def q(conn, sql: str, args=None) -> list[dict]:
    assert sql.lstrip().upper().startswith(("SELECT", "SHOW", "WITH")), sql
    with conn.cursor() as cur:
        cur.execute(sql, args)
        return list(cur.fetchall())


def profile(src) -> None:
    section("0. Server, tables, schema")
    out(q(src, "SELECT @@version AS version, @@global.time_zone AS global_tz, @@session.time_zone AS session_tz, "
               "@@system_time_zone AS system_tz, NOW() AS now_, UTC_TIMESTAMP() AS utc_now")[0])
    for t in q(src, "SHOW FULL TABLES"):
        out("  table:", list(t.values()))
    columns: dict[str, list[str]] = {}
    for t in (*TABLES, "sync_state"):
        cols = q(src, f"SHOW FULL COLUMNS FROM `{t}`")
        columns[t] = [c["Field"] for c in cols]
        out(f"\n  {t}:")
        for c in cols:
            out(f"    {c['Field']:<22} {c['Type']:<16} null={c['Null']:<3} key={c['Key']:<4} default={c['Default']} extra={c['Extra']}")
        for idx in q(src, f"SHOW INDEX FROM `{t}`"):
            out(f"    index {idx['Key_name']}({idx['Column_name']}) unique={not idx['Non_unique']}")
    out("\n  triggers:", q(src, "SELECT TRIGGER_NAME, EVENT_MANIPULATION, EVENT_OBJECT_TABLE FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()"))
    out("  events:", q(src, "SELECT EVENT_NAME, STATUS, INTERVAL_VALUE, INTERVAL_FIELD, LAST_EXECUTED FROM information_schema.EVENTS WHERE EVENT_SCHEMA = DATABASE()"))
    out("  views/routines:", q(src, "SELECT ROUTINE_NAME, ROUTINE_TYPE FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE()"))

    section("10. sync_state")
    for r in q(src, "SELECT * FROM sync_state"):
        out(" ", {k: mask(v) for k, v in r.items()})

    rows: dict[str, list[dict]] = {}
    for t in TABLES:
        section(f"1-2. {t}: counts, dates, nulls, distincts, top values")
        cols = columns[t]
        out(q(src, f"SELECT COUNT(*) n, MIN(id) min_id, MAX(id) max_id, MIN(create_date) min_create, MAX(create_date) max_create, "
                   f"MIN(updated_at) min_upd, MAX(updated_at) max_upd, MIN(scheduled_date) min_sched, MAX(scheduled_date) max_sched FROM `{t}`")[0])
        out("  rows per month (create_date):")
        for r in q(src, f"SELECT DATE_FORMAT(create_date, '%Y-%m') m, COUNT(*) n FROM `{t}` GROUP BY m ORDER BY m"):
            out(f"    {r['m']}: {r['n']}")
        out("  rows per month (updated_at):")
        for r in q(src, f"SELECT DATE_FORMAT(updated_at, '%Y-%m') m, COUNT(*) n FROM `{t}` GROUP BY m ORDER BY m"):
            out(f"    {r['m']}: {r['n']}")
        total = q(src, f"SELECT COUNT(*) n FROM `{t}`")[0]["n"] or 1
        out("  column            nulls  null%   blank  distinct")
        for c in cols:
            r = q(src, f"SELECT SUM(`{c}` IS NULL) nulls, SUM(TRIM(CAST(`{c}` AS CHAR)) = '') blanks, COUNT(DISTINCT `{c}`) d FROM `{t}`")[0]
            out(f"    {c:<18} {int(r['nulls'] or 0):>6} {100 * int(r['nulls'] or 0) / total:5.1f}% {int(r['blanks'] or 0):>6} {r['d']:>8}")
        for c in ("failure_type", "failure_reason", "company_id", "company_name", "team_id", "team_name", "team_branch",
                  "email_notification", "created_name", "created_id", "salesperson_name"):
            if c not in cols:
                continue
            out(f"  top 20 {c}:")
            for r in q(src, f"SELECT `{c}` v, COUNT(*) n FROM `{t}` GROUP BY `{c}` ORDER BY n DESC LIMIT 20"):
                out(f"    {r['n']:>7}  {mask(r['v'])}")
        if "recipient_email" in cols:
            out("  recipient_email domains:", q(src, f"SELECT SUBSTRING_INDEX(recipient_email, '@', -1) d, COUNT(*) n FROM `{t}` GROUP BY d ORDER BY n DESC LIMIT 10"))
        if "mobile_number" in cols:
            out("  mobile_number shape (length / prefix 3):", q(src, f"SELECT CHAR_LENGTH(mobile_number) len, LEFT(mobile_number, 3) p, COUNT(*) n FROM `{t}` GROUP BY len, p ORDER BY n DESC LIMIT 8"))
        sel = ", ".join(f"`{c}`" for c in cols if c not in PERSONAL)
        rows[t] = q(src, f"SELECT {sel} FROM `{t}`")

    full, low = rows["nps_rating_full_data"], rows["low_rating_data"]
    section("3. body: samples and where the 0-10 score is")
    score_hunt(full, low, columns)
    section("4. low_rating_data vs nps_rating_full_data")
    overlap(full, low)
    section("5-6. ids: whole numbers, matches in the warehouse, order match")
    match_rates(full, low)
    section("7. delivery_code / order_id multiplicity")
    multiplicity(full)
    section("8-9. timezone and updated_at behaviour")
    timestamps(src, full, low)


def body_text(r) -> str:
    return (r.get("body") or "").translate(ARABIC_DIGITS)


SCORE_RULES = {
    "whole body is a number 0-10": re.compile(r"^\s*(10|[0-9])\s*$"),
    "N/10 or N من 10": re.compile(r"(?<!\d)(10|[0-9])\s*(?:/|من|out of)\s*10(?!\d)", re.I),
    "rating/score/تقييم: N": re.compile(r"(?:rating|rate|score|nps|تقييم|التقييم|درجة)\D{0,15}?(?<!\d)(10|[0-9])(?!\d)", re.I),
    "first standalone 0-10 number": re.compile(r"(?<![\d.])(10|[0-9])(?![\d.])"),
}


def score_hunt(full, low, columns) -> None:
    for t, data in (("nps_rating_full_data", full), ("low_rating_data", low)):
        bodies = [r for r in data if (r.get("body") or "").strip()]
        out(f"\n  {t}: {len(data)} rows, {len(bodies)} with a non-blank body")
        lens = sorted(len(r["body"]) for r in bodies) or [0]
        out(f"  body length: min {lens[0]}, median {lens[len(lens) // 2]}, max {lens[-1]}")
        out("  most frequent bodies:")
        for b, n in collections.Counter(mask(r["body"]).strip() for r in bodies).most_common(25):
            out(f"    {n:>6}  {b[:160]!r}")
        out("  30 samples (spread over the ids):")
        step = max(1, len(bodies) // 30)
        for r in bodies[::step][:30]:
            out(f"    id={r['id']} {mask(r['body'])[:300]!r}")
        for name, rule in SCORE_RULES.items():
            hits = [rule.search(body_text(r)) for r in bodies]
            vals = collections.Counter(int(m.group(1)) for m in hits if m)
            out(f"  rule [{name}]: {sum(1 for m in hits if m)}/{len(bodies)} hit = {100 * sum(1 for m in hits if m) / max(1, len(bodies)):.1f}%  "
                f"distribution {dict(sorted(vals.items()))}")
    # any column that only holds small integers could be the score
    out("\n  columns holding only values 0-10 (score candidates):")
    for t, data in (("nps_rating_full_data", full), ("low_rating_data", low)):
        for c in columns[t]:
            if c in PERSONAL or c == "id":
                continue
            vals = {str(r.get(c)).strip() for r in data if r.get(c) not in (None, "")}
            if vals and len(vals) <= 11 and all(re.fullmatch(r"(10|[0-9])(\.0+)?", v) for v in vals):
                out(f"    {t}.{c}: {sorted(vals)}")


def overlap(full, low) -> None:
    fid = {r["id"]: r for r in full}
    same_id = [r for r in low if r["id"] in fid]
    out(f"  low rows {len(low)}, ids also in full: {len(same_id)}")
    shared = [c for c in low[0].keys() if c in full[0]] if low and full else []
    agree = collections.Counter()
    for r in same_id:
        for c in shared:
            agree[c] += str(r[c]) == str(fid[r["id"]][c])
    out("  for the same id, columns equal (count):", dict(agree))
    key = lambda r: (str(r.get("order_id")), str(r.get("delivery_code")), str(r.get("create_date")))  # noqa: E731
    fkeys = collections.Counter(key(r) for r in full)
    out(f"  low rows whose (order_id, delivery_code, create_date) exists in full: {sum(1 for r in low if fkeys[key(r)])}")
    by_order = collections.Counter(str(r.get("order_id")) for r in full)
    out(f"  low rows whose order_id exists in full: {sum(1 for r in low if by_order[str(r.get('order_id'))])}")
    for r in low[:5]:
        f = fid.get(r["id"])
        out(f"    low id={r['id']} order={r.get('order_id')} code={r.get('delivery_code')} created={r.get('create_date')} | "
            f"full same id: order={f and f.get('order_id')} code={f and f.get('delivery_code')} created={f and f.get('create_date')}")


def _whole(vals) -> str:
    vals = [v for v in vals if v is not None]
    bad = [v for v in vals if float(v) != int(float(v))]
    return f"{len(vals) - len(bad)}/{len(vals)} whole" + (f", e.g. {bad[:5]}" if bad else "")


def match_rates(full, low) -> None:
    config = PlatformConfig.from_env()
    wh = create_engine(config.database_url)
    with wh.connect() as c:
        def ids(sql):
            return {int(r[0]) for r in c.execute(text(sql))}
        companies = ids("SELECT CompanyKey FROM dim_company")
        partners = ids("SELECT partner_id FROM map_partner_customer")
        raw_partners = ids("SELECT id FROM raw_odoo_res_partner")
        users = ids("SELECT odoo_user_id FROM map_odoo_user_salesperson")
        raw_users = {int(i): (n, p) for i, n, p in c.execute(text("SELECT id, name, partner_id FROM raw_odoo_res_users"))}
        teams = ids("SELECT odoo_team_id FROM map_odoo_team_sales_team")
        raw_teams = ids("SELECT id FROM raw_odoo_crm_team")
        orders = {str(n): (int(k), int(co), int(cu)) for k, n, co, cu in
                  c.execute(text("SELECT SalesOrderKey, order_number, CompanyKey, CustomerKey FROM dim_sales_order"))}
        cust_of = {int(p): int(k) for p, k in c.execute(text("SELECT partner_id, CustomerKey FROM map_partner_customer"))}
        sp_of = {int(u): int(s) for u, s in c.execute(text("SELECT odoo_user_id, SalespersonKey FROM map_odoo_user_salesperson"))}
        order_sp = {int(k): (int(s) if s is not None else None, str(t)) for k, s, t in
                    c.execute(text("SELECT SalesOrderKey, MAX(SalespersonKey), MAX(SalesTeamKey) FROM fact_sales_orders WHERE SalesOrderKey IS NOT NULL GROUP BY SalesOrderKey"))}
        team_of = {int(t): str(k) for t, k in c.execute(text("SELECT odoo_team_id, SalesTeamKey FROM map_odoo_team_sales_team"))}
    out(f"  ODOO_COMPANY_IDS = {list(config.odoo_company_ids)}; dim_company keys = {sorted(companies)}")
    for t, data in (("nps_rating_full_data", full), ("low_rating_data", low)):
        n = len(data) or 1
        out(f"\n  {t} ({len(data)} rows)")

        def rate(label, col, known, extra=None):
            vals = [r.get(col) for r in data]
            present = [int(float(v)) for v in vals if v is not None]
            hit = [v for v in present if v in known]
            miss = collections.Counter(v for v in present if v not in known)
            out(f"    {label:<44} null {len(vals) - len(present):>6} | match {len(hit):>6}/{len(present):<6} "
                f"= {100 * len(hit) / max(1, len(present)):5.1f}% | distinct unmatched {len(miss)} e.g. {miss.most_common(8)}")
        for col in ("company_id", "partner_id", "salesperson_id", "team_id", "created_id"):
            out(f"    {col}: {_whole(r.get(col) for r in data)}")
        rate("company_id -> dim_company.CompanyKey", "company_id", companies)
        rate("company_id -> ODOO_COMPANY_IDS", "company_id", set(config.odoo_company_ids))
        rate("partner_id -> map_partner_customer", "partner_id", partners)
        rate("partner_id -> raw_odoo_res_partner (any partner)", "partner_id", raw_partners)
        rate("salesperson_id -> map_odoo_user_salesperson", "salesperson_id", users)
        rate("salesperson_id -> raw_odoo_res_users.id", "salesperson_id", set(raw_users))
        rate("created_id -> raw_odoo_res_users.id", "created_id", set(raw_users))
        rate("team_id -> map_odoo_team_sales_team", "team_id", teams)
        rate("team_id -> raw_odoo_crm_team", "team_id", raw_teams)
        # user id or employee id? for ids that exist in res.users, does the user's name equal salesperson_name?
        same_name = [r for r in data if r.get("salesperson_id") is not None and int(float(r["salesperson_id"])) in raw_users]
        eq = sum(1 for r in same_name if (raw_users[int(float(r["salesperson_id"]))][0] or "").strip().lower() == (r.get("salesperson_name") or "").strip().lower())
        out(f"    salesperson_id found in res.users AND res.users.name == salesperson_name: {eq}/{len(same_name)} (diagnostic only; keys never match by name)")
        # order
        oid = [str(r.get("order_id") or "").strip() for r in data]
        hit = [(r, orders[o]) for r, o in zip(data, oid) if o in orders]
        out(f"    order_id -> dim_sales_order.order_number: {len(hit)}/{sum(1 for o in oid if o)} non-blank "
            f"({100 * len(hit) / max(1, sum(1 for o in oid if o)):.1f}%); blank {sum(1 for o in oid if not o)}; "
            f"unmatched e.g. {[o for o in oid if o and o not in orders][:8]}")
        out(f"    order_id shapes: {collections.Counter(re.sub(r'[0-9]', '9', o) for o in oid).most_common(8)}")
        if hit:
            co = sum(1 for r, (_, c_, _) in hit if r.get("company_id") is not None and int(float(r["company_id"])) == c_)
            cu = sum(1 for r, (_, _, k) in hit if r.get("partner_id") is not None and cust_of.get(int(float(r["partner_id"]))) == k)
            sp = sum(1 for r, (k, _, _) in hit if r.get("salesperson_id") is not None and k in order_sp
                     and sp_of.get(int(float(r["salesperson_id"]))) == order_sp[k][0])
            tm = sum(1 for r, (k, _, _) in hit if r.get("team_id") is not None and k in order_sp
                     and team_of.get(int(float(r["team_id"]))) == order_sp[k][1])
            out(f"    for matched orders, NPS row agrees with the order: company {co}/{len(hit)}, customer (commercial partner) {cu}/{len(hit)}, "
                f"salesperson {sp}/{len(hit)}, team {tm}/{len(hit)}")
        out(f"    ({n} rows)")


def multiplicity(full) -> None:
    codes = collections.Counter(str(r.get("delivery_code")) for r in full if r.get("delivery_code") not in (None, ""))
    out(f"  delivery_code: {len(codes)} distinct over {sum(codes.values())} non-blank; codes used more than once: "
        f"{sum(1 for v in codes.values() if v > 1)}; max per code {max(codes.values(), default=0)}")
    out(f"  delivery_code shapes: {collections.Counter(re.sub(r'[0-9]', '9', c) for c in codes).most_common(6)}")
    orders = collections.Counter(str(r.get("order_id")) for r in full if r.get("order_id") not in (None, ""))
    out(f"  order_id: {len(orders)} distinct over {sum(orders.values())}; ratings per order: {dict(sorted(collections.Counter(orders.values()).items()))}")
    dup = [o for o, n in orders.items() if n > 1][:3]
    for o in dup:
        rs = [r for r in full if str(r.get("order_id")) == o]
        out(f"    order {o}: " + "; ".join(f"id={r['id']} code={r.get('delivery_code')} created={r.get('create_date')} sched={r.get('scheduled_date')} body={mask(r.get('body'))[:40]!r}" for r in rs))


def timestamps(src, full, low) -> None:
    out("  source clock:", q(src, "SELECT NOW() now_, UTC_TIMESTAMP() utc_, TIMEDIFF(NOW(), UTC_TIMESTAMP()) offset_")[0])
    for t, data in (("nps_rating_full_data", full), ("low_rating_data", low)):
        out(f"\n  {t}")
        hours = collections.Counter(r["create_date"].hour for r in data if isinstance(r.get("create_date"), _dt.datetime))
        out(f"    create_date hour-of-day histogram: {dict(sorted(hours.items()))}")
        diffs = [(r["updated_at"] - r["create_date"]).total_seconds() / 3600 for r in data
                 if isinstance(r.get("updated_at"), _dt.datetime) and isinstance(r.get("create_date"), _dt.datetime)]
        if diffs:
            s = sorted(diffs)
            out(f"    updated_at - create_date (hours): min {s[0]:.2f}, p10 {s[len(s) // 10]:.2f}, median {s[len(s) // 2]:.2f}, "
                f"p90 {s[9 * len(s) // 10]:.2f}, max {s[-1]:.2f}")
        upd = collections.Counter(str(r.get("updated_at")) for r in data)
        out(f"    distinct updated_at values {len(upd)}; most common {upd.most_common(5)}")
        if data and "scheduled_date" in data[0]:
            sd = [r for r in data if isinstance(r.get("scheduled_date"), _dt.datetime) and isinstance(r.get("create_date"), _dt.datetime)]
            d = sorted((r["create_date"] - r["scheduled_date"]).total_seconds() / 86400 for r in sd)
            if d:
                out(f"    create_date - scheduled_date (days): min {d[0]:.2f}, median {d[len(d) // 2]:.2f}, max {d[-1]:.2f}")
            sh = collections.Counter(r["scheduled_date"].strftime("%H:%M") for r in sd)
            out(f"    scheduled_date most common times: {sh.most_common(5)}")
        if "notification_date" in (data[0] if data else {}):
            nd = sorted((r["notification_date"] - r["create_date"]).total_seconds() / 3600 for r in data
                        if isinstance(r.get("notification_date"), _dt.datetime) and isinstance(r.get("create_date"), _dt.datetime))
            if nd:
                out(f"    notification_date - create_date (hours): min {nd[0]:.2f}, median {nd[len(nd) // 2]:.2f}, max {nd[-1]:.2f}")
        ids = sorted(r["id"] for r in data)
        if ids:
            out(f"    id range {ids[0]}..{ids[-1]}, rows {len(ids)}, gaps (missing ids inside the range) {ids[-1] - ids[0] + 1 - len(ids)}")


# --------------------------------------------------------------------------------------------- reach (whatsapp_outbound_messages)
REACH_TABLE = "whatsapp_outbound_messages"
REACH_COLUMNS = ("id", "create_date", "company_name", "template_name", "state", "mobile_number", "failure_type",
                 "failure_reason", "first_seen_at", "updated_at")
KNOWN_STATES = ("delivered", "read", "sent", "error")


def _local(at, tz):
    return None if not isinstance(at, _dt.datetime) else at.replace(tzinfo=_dt.timezone.utc).astimezone(tz).replace(tzinfo=None)


def _hist(values, label) -> None:
    s = sorted(values)
    if not s:
        out(f"    {label}: no values")
        return
    out(f"    {label}: n {len(s)}, min {s[0]:.2f}, p10 {s[len(s) // 10]:.2f}, median {s[len(s) // 2]:.2f}, "
        f"p90 {s[9 * len(s) // 10]:.2f}, max {s[-1]:.2f}")


def profile_reach(src, recheck_minutes: float) -> None:
    """Task A of the reach go-live: read-only profile of whatsapp_outbound_messages. Mobile numbers are compared in
    memory and counted, never printed."""
    import time
    from zoneinfo import ZoneInfo

    from departments.process import whatsapp as wa

    config = PlatformConfig.from_env()
    tz = ZoneInfo(config.business_timezone)
    reach = wa.ReachConfig.from_env()
    if not q(src, "SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s", (REACH_TABLE,))[0]["n"]:
        section(f"R. {REACH_TABLE}: NOT FOUND in the source")
        return

    section(f"R0. {REACH_TABLE}: schema")
    cols = q(src, f"SHOW FULL COLUMNS FROM `{REACH_TABLE}`")
    for c in cols:
        out(f"    {c['Field']:<16} {c['Type']:<20} null={c['Null']:<3} key={c['Key']:<4} default={c['Default']} extra={c['Extra']}")
    for idx in q(src, f"SHOW INDEX FROM `{REACH_TABLE}`"):
        out(f"    index {idx['Key_name']}({idx['Column_name']}) unique={not idx['Non_unique']}")
    missing = [c for c in REACH_COLUMNS if c not in {x["Field"] for x in cols}]
    extra = [x["Field"] for x in cols if x["Field"] not in REACH_COLUMNS]
    out(f"  columns missing vs announced: {missing or 'none'}; extra columns: {extra or 'none'}")
    out("  server:", q(src, "SELECT @@global.time_zone global_tz, @@session.time_zone session_tz, @@system_time_zone system_tz, "
                           "NOW() now_, UTC_TIMESTAMP() utc_now, TIMEDIFF(NOW(), UTC_TIMESTAMP()) offset_")[0])
    out(f"  config: business timezone {config.business_timezone}; NPS_REACH_TEMPLATE_MATCH={reach.template_match!r}; "
        f"NPS_REACH_EXCLUDED_NUMBERS: {len(reach.excluded_numbers)} configured; NPS_REACH_START={reach.start or '(empty = all)'}")

    rows = q(src, f"SELECT {', '.join(f'`{c}`' for c in REACH_COLUMNS)} FROM `{REACH_TABLE}`")
    for r in rows:
        r["_state"] = str(r.get("state") or "").strip().lower()
        r["_local"] = _local(r.get("create_date"), tz)
        r["_feedback"] = wa.is_feedback_template(r.get("template_name"), reach.template_match)
        r["_test"] = wa.is_excluded_number(r.get("mobile_number"), reach.excluded_numbers)
        r["_scope"] = r["_feedback"] and not r["_test"] and (reach.start is None or (r["_local"] is not None and r["_local"].date() >= reach.start))

    section("R1. counts and dates")
    out(q(src, f"SELECT COUNT(*) n, COUNT(DISTINCT id) distinct_ids, MIN(id) min_id, MAX(id) max_id, "
               f"MIN(create_date) min_create, MAX(create_date) max_create, SUM(create_date IS NULL) null_create, "
               f"MIN(first_seen_at) min_first_seen, MAX(first_seen_at) max_first_seen, "
               f"MIN(updated_at) min_upd, MAX(updated_at) max_upd FROM `{REACH_TABLE}`")[0])
    out("  null / blank per column:")
    for c in REACH_COLUMNS:
        r = q(src, f"SELECT SUM(`{c}` IS NULL) nulls, SUM(TRIM(CAST(`{c}` AS CHAR)) = '') blanks, COUNT(DISTINCT `{c}`) d FROM `{REACH_TABLE}`")[0]
        out(f"    {c:<16} nulls {int(r['nulls'] or 0):>7}  blanks {int(r['blanks'] or 0):>7}  distinct {r['d']:>7}")
    out("  mobile_number shape (length / first 3 chars, counts only):",
        q(src, f"SELECT CHAR_LENGTH(mobile_number) len, LEFT(mobile_number, 3) p, COUNT(*) n FROM `{REACH_TABLE}` GROUP BY len, p ORDER BY n DESC LIMIT 8"))
    out(f"  distinct mobile numbers: {len({wa.digits(r.get('mobile_number')) for r in rows})}")
    latest = max((r["create_date"] for r in rows if isinstance(r.get("create_date"), _dt.datetime)), default=None)
    if latest:
        cutoff = (latest - _dt.timedelta(days=30)).date()
        out(f"  rows per day, last 30 days up to {latest.date()} (create_date as stored):")
        for r in q(src, f"SELECT DATE(create_date) d, COUNT(*) n FROM `{REACH_TABLE}` WHERE create_date >= %s GROUP BY d ORDER BY d", (cutoff,)):
            out(f"    {r['d']}: {r['n']}")
        out("  rows per month before that:")
        for r in q(src, f"SELECT DATE_FORMAT(create_date, '%%Y-%%m') m, COUNT(*) n FROM `{REACH_TABLE}` WHERE create_date < %s GROUP BY m ORDER BY m", (cutoff,)):
            out(f"    {r['m']}: {r['n']}")
    out("  rows per day of first_seen_at (when the developer's sync saw them), last 15 days:")
    for r in q(src, f"SELECT DATE(first_seen_at) d, COUNT(*) n FROM `{REACH_TABLE}` GROUP BY d ORDER BY d DESC LIMIT 15"):
        out(f"    {r['d']}: {r['n']}")

    section("R2. company_name and template_name")
    for c in ("company_name", "template_name"):
        out(f"  {c}:")
        for r in q(src, f"SELECT `{c}` v, COUNT(*) n, MIN(create_date) first_, MAX(create_date) last_ FROM `{REACH_TABLE}` GROUP BY `{c}` ORDER BY n DESC"):
            out(f"    {r['n']:>7}  {mask(r['v'])!r}  ({r['first_']} .. {r['last_']})")
    out("  company_name -> CompanyKey (transform.COMPANY_BY_SOURCE_NAME):",
        dict(collections.Counter(f"{mask(r.get('company_name'))!r} -> {COMPANY.get(str(r.get('company_name') or '').strip().upper(), -1)}" for r in rows)))

    section("R3. state")
    for r in q(src, f"SELECT state v, COUNT(*) n FROM `{REACH_TABLE}` GROUP BY state ORDER BY n DESC"):
        flag = "" if str(r["v"] or "").strip().lower() in KNOWN_STATES else "   <-- UNEXPECTED"
        out(f"    {r['n']:>7}  {r['v']!r}{flag}")
    out("  Feedback messages per month (create_date as stored) x state x failure_type x mobile_number present:")
    for (m, s, ft, has), n in sorted(collections.Counter(
            (f"{r['create_date']:%Y-%m}", r["_state"], r.get("failure_type"), r.get("mobile_number") not in (None, ""))
            for r in rows if r["_feedback"] and isinstance(r.get("create_date"), _dt.datetime)).items(), key=str):
        out(f"    {m}  {s:<10} {str(ft):<24} mobile={'yes' if has else 'NULL':<4} {n:>6}")
    out("  first create_date of each state (all templates):",
        {r["state"]: str(r["f"]) for r in q(src, f"SELECT state, MIN(create_date) f FROM `{REACH_TABLE}` GROUP BY state")})
    out("  phone_invalid rows by mobile_number present:",
        q(src, f"SELECT mobile_number IS NOT NULL has_mobile, COUNT(*) n, MIN(create_date) first_, MAX(create_date) last_ "
               f"FROM `{REACH_TABLE}` WHERE failure_type = 'phone_invalid' GROUP BY has_mobile"))
    out("  state x template is Feedback:")
    for (s, f), n in sorted(collections.Counter((r["_state"], r["_feedback"]) for r in rows).items()):
        out(f"    {s!r:<14} feedback={f!s:<5} {n:>7}")

    section("R4. failure_type / failure_reason and FAILURE_GROUPS")
    by_value = collections.Counter((r["_state"], r.get("failure_type"), r.get("failure_reason")) for r in rows
                                   if r["_state"] == "error" or r.get("failure_type") not in (None, "") or r.get("failure_reason") not in (None, ""))
    groups = collections.Counter()
    out("  count  state      group                  failure_type | failure_reason")
    for (s, ft, fr), n in by_value.most_common():
        g = wa.failure_group(ft, fr, "error")  # the group it would land in as an error
        if s == "error":
            groups[g] += n
        out(f"  {n:>6}  {s:<10} {g if s == 'error' else '(' + g + ' if error)':<22} {mask(ft)!r} | {mask(fr)[:220]!r}")
    out(f"  error rows per group: {dict(groups)}; in 'other': {groups.get('other', 0)} of {sum(groups.values())}")
    out(f"  distinct failure_type values: {len({ft for _, ft, _ in by_value})}; distinct failure_reason values: {len({fr for _, _, fr in by_value})}")
    out("  numeric codes found in the failure text:",
        dict(collections.Counter(m for (s, ft, fr), n in by_value.items() for m in re.findall(r"(?<!\d)\d{3,6}(?!\d)", f"{ft or ''} {fr or ''}") for _ in range(n)).most_common(20)))

    section("R5. filters: template and test numbers")
    out(f"  not a Feedback template (would be filtered by NPS_REACH_TEMPLATE_MATCH={reach.template_match!r}): {sum(not r['_feedback'] for r in rows)} of {len(rows)}")
    out(f"  test numbers (NPS_REACH_EXCLUDED_NUMBERS, {len(reach.excluded_numbers)} configured): {sum(r['_test'] for r in rows)} rows, "
        f"of which Feedback {sum(r['_test'] and r['_feedback'] for r in rows)}")
    out(f"  before NPS_REACH_START: {sum(r['_feedback'] and not r['_test'] and not r['_scope'] for r in rows)}")
    out(f"  in reach scope: {sum(r['_scope'] for r in rows)}")
    out(f"  numbers that receive more than one Feedback message: "
        f"{sum(1 for n in collections.Counter(wa.digits(r.get('mobile_number'))[-9:] for r in rows if r['_feedback']).values() if n > 1)}")

    section("R6. timezone of create_date")
    out("  source clock:", q(src, "SELECT @@session.time_zone tz, NOW() now_, UTC_TIMESTAMP() utc_, TIMEDIFF(NOW(), UTC_TIMESTAMP()) offset_")[0])
    out(f"  create_date hour-of-day (as stored): {dict(sorted(collections.Counter(r['create_date'].hour for r in rows if isinstance(r.get('create_date'), _dt.datetime)).items()))}")
    _hist([(r["first_seen_at"] - r["create_date"]).total_seconds() / 3600 for r in rows
           if isinstance(r.get("first_seen_at"), _dt.datetime) and isinstance(r.get("create_date"), _dt.datetime)],
          "first_seen_at - create_date (hours); first_seen_at is the MySQL server clock (NOW())")
    ratings = q(src, "SELECT mobile_number, create_date FROM nps_rating_full_data WHERE create_date IS NOT NULL")
    sent_to = collections.defaultdict(list)
    for r in rows:
        if r["_feedback"] and isinstance(r.get("create_date"), _dt.datetime):
            sent_to[wa.digits(r.get("mobile_number"))[-9:]].append(r["create_date"])
    gaps, matched = [], 0
    for r in ratings:
        cands = [m for m in sent_to.get(wa.digits(r.get("mobile_number"))[-9:], []) if abs((r["create_date"] - m).total_seconds()) < 3 * 86400]
        if cands:
            matched += 1
            m = min(cands, key=lambda m: abs((r["create_date"] - m).total_seconds()))
            gaps.append((r["create_date"] - m).total_seconds() / 3600)
    out(f"  ratings (create_date = UTC, checked on step 1) with a Feedback message to the same number within 3 days: {matched} of {len(ratings)}")
    _hist(gaps, "rating create_date - nearest message create_date (hours)")
    out(f"    by whole hour: {dict(sorted(collections.Counter(int(g // 1) for g in gaps).items()))}")
    out(f"    negative (rating before its message): {sum(g < 0 for g in gaps)}; within 0..2 h: {sum(0 <= g < 2 for g in gaps)}; "
        f"within -3..-1 h: {sum(-3 <= g < -1 for g in gaps)}")

    section("R7. does updated_at move?")
    out(q(src, f"SELECT SUM(updated_at > first_seen_at) moved, SUM(updated_at = first_seen_at) same, SUM(updated_at < first_seen_at) before_, "
               f"COUNT(*) n FROM `{REACH_TABLE}`")[0])
    for r in q(src, f"SELECT state, SUM(updated_at > first_seen_at) moved, COUNT(*) n FROM `{REACH_TABLE}` GROUP BY state ORDER BY n DESC"):
        out(f"    {r['state']!r:<14} moved {int(r['moved'] or 0):>7} of {r['n']}")
    _hist([(r["updated_at"] - r["first_seen_at"]).total_seconds() / 3600 for r in rows
           if isinstance(r.get("updated_at"), _dt.datetime) and isinstance(r.get("first_seen_at"), _dt.datetime) and r["updated_at"] > r["first_seen_at"]],
          "updated_at - first_seen_at for moved rows (hours)")
    out("  updated_at per day, last 15 days:")
    for r in q(src, f"SELECT DATE(updated_at) d, COUNT(*) n FROM `{REACH_TABLE}` GROUP BY d ORDER BY d DESC LIMIT 15"):
        out(f"    {r['d']}: {r['n']}")
    out(f"  distinct updated_at values: {len({r['updated_at'] for r in rows})}; most common: "
        f"{collections.Counter(str(r['updated_at']) for r in rows).most_common(5)}")

    section("R8. ids, duplicates, gaps, deletions")
    ids = sorted(r["id"] for r in rows)
    out(f"  rows {len(ids)}, distinct ids {len(set(ids))}, range {ids[0] if ids else None}..{ids[-1] if ids else None}, "
        f"missing ids inside the range {(ids[-1] - ids[0] + 1 - len(set(ids))) if ids else 0}")
    out("  NOTE: the ids look like source (Odoo whatsapp.message) ids, so gaps can be messages of other templates/companies never copied.")
    if recheck_minutes > 0:
        before = {r["id"]: (r["_state"], r["updated_at"]) for r in rows}
        out(f"  second read in {recheck_minutes:g} minutes ...")
        time.sleep(recheck_minutes * 60)
        after = {r["id"]: (str(r["state"] or "").strip().lower(), r["updated_at"])
                 for r in q(src, f"SELECT id, state, updated_at FROM `{REACH_TABLE}`")}
        changed = [i for i in before.keys() & after.keys() if before[i] != after[i]]
        out(f"  after {recheck_minutes:g} min: rows {len(after)}; new {len(after.keys() - before.keys())}; "
            f"gone (deleted) {len(before.keys() - after.keys())}; changed state/updated_at {len(changed)}; "
            f"state transitions {dict(collections.Counter(f'{before[i][0]}->{after[i][0]}' for i in changed))}")

    section("R9. reconciliation preview (weekly e-mail rule: Feedback template, test numbers out, from NPS_REACH_START)")
    today = _dt.datetime.now(tz).date()
    last7 = today - _dt.timedelta(days=7)
    for label, keep in (("all data in scope", lambda r: True),
                        (f"last 7 days ({last7} .. {today - _dt.timedelta(days=1)}, Tripoli date)", lambda r: r["_local"] is not None and last7 <= r["_local"].date() < today)):
        out(f"  {label}:")
        counts = collections.Counter((str(r.get("company_name") or "").strip().upper() or "(blank)", r["_state"]) for r in rows if r["_scope"] and keep(r))
        for co in sorted({c for c, _ in counts}):
            cells = {s: counts.get((co, s), 0) for s in KNOWN_STATES}
            other = sum(n for (c, s), n in counts.items() if c == co and s not in KNOWN_STATES)
            out(f"    {co:<8} total {sum(n for (c, _), n in counts.items() if c == co):>6} | " + "  ".join(f"{s} {n:>5}" for s, n in cells.items()) + f"  other {other}")

    section("R10. response-rate preview: Feedback messages in scope vs ratings in fact_process_nps_response, per company and month")
    wh = create_engine(config.database_url)
    with wh.connect() as c:
        rated = collections.Counter((int(k), str(m)) for k, m, n in c.execute(text(
            "SELECT CompanyKey, DATE_FORMAT(rated_at_local, '%Y-%m'), 1 FROM fact_process_nps_response")))
    sent = collections.Counter((COMPANY.get(str(r.get("company_name") or "").strip().upper(), -1), f"{r['_local']:%Y-%m}", r["_state"])
                               for r in rows if r["_scope"] and r["_local"] is not None)
    out("  company month    | messages delivered read  sent error other | ratings  ratings/(delivered+read)")
    for co, m in sorted({(k, mm) for k, mm, _ in sent} | set(rated)):
        st = {s: sent.get((co, m, s), 0) for s in KNOWN_STATES}
        total = sum(n for (k, mm, _), n in sent.items() if k == co and mm == m)
        reached = st["delivered"] + st["read"]
        out(f"  {co:>3} {m}  | {total:>8} {st['delivered']:>9} {st['read']:>4} {st['sent']:>5} {st['error']:>5} {total - sum(st.values()):>5} | "
            f"{rated.get((co, m), 0):>7}  {(100 * rated.get((co, m), 0) / reached) if reached else float('nan'):6.1f}%"
            + ("   <-- ratings > delivered+read" if rated.get((co, m), 0) > reached else ""))


from departments.process.transform import COMPANY_BY_SOURCE_NAME as COMPANY  # noqa: E402


if __name__ == "__main__":
    try:
        sys.exit(main())
    except paramiko.AuthenticationException:
        print("SSH login rejected: check NPS_SSH_USER and NPS_SSH_PASSWORD / NPS_SSH_KEY_PATH.", file=sys.stderr)
    except paramiko.SSHException as exc:
        print(f"SSH failed: {exc}", file=sys.stderr)
    except (socket.timeout, TimeoutError, OSError) as exc:
        print(f"Cannot reach the SSH server: {exc}", file=sys.stderr)
    except pymysql.err.OperationalError as exc:
        code = exc.args[0] if exc.args else None
        hint = {2003: "MySQL unreachable through the tunnel (NPS_DB_HOST/NPS_DB_PORT as seen from the SSH server)",
                2013: "MySQL connection lost", 1045: "MySQL login rejected (NPS_DB_USER / NPS_DB_PASSWORD)",
                1049: "unknown database (NPS_DB_NAME)"}.get(code, "see the error")
        print(f"MySQL error {code}: {hint}", file=sys.stderr)
    sys.exit(1)
