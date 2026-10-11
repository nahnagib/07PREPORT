"""Settings: non-secret options from config.ini, secrets from a .env file / the environment."""
from __future__ import annotations

import configparser
import datetime as dt
import os
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]


def load_env_file(path: Path) -> list[str]:
    """Minimal .env reader (KEY=VALUE, # comments, optional quotes). Existing environment variables win."""
    loaded = []
    if not path.is_file():
        return loaded
    for raw in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip().removeprefix("export ").strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        elif " #" in value:
            value = value.split(" #", 1)[0].rstrip()
        if key and key not in os.environ:
            os.environ[key] = value
            loaded.append(key)
    return loaded


def _ints(text: str) -> list[int]:
    return [int(x) for x in str(text).replace(";", ",").split(",") if x.strip()]


def _names(text: str) -> list[str]:
    return [x.strip() for x in str(text).split("|") if x.strip()]


@dataclass
class Bucket:
    key: int
    label: str
    low: int
    high: int | None
    risk: str
    color: str
    action: str


DEFAULT_BUCKETS = [
    Bucket(1, "1–15 يوم", 1, 15, "منخفضة", "#2e7d32", "تذكير ودي: رسالة واتساب/SMS مع كشف حساب"),
    Bucket(2, "16–30 يوم", 16, 30, "متوسطة", "#b8860b", "اتصال هاتفي مباشر وتحديد موعد سداد مؤكد"),
    Bucket(3, "31–60 يوم", 31, 60, "مرتفعة", "#e65100", "إيقاف البيع الآجل وزيارة العميل"),
    Bucket(4, "61–90 يوم", 61, 90, "شديدة", "#c62828", "إنذار كتابي رسمي وتجهيز ملف الإنذار القانوني"),
    Bucket(5, "أكثر من 90 يوم", 91, None, "حرجة", "#6a1b9a", "تصعيد إلى مدير المبيعات والإدارة المالية والقانونية"),
]


@dataclass
class Settings:
    # odoo
    url: str = ""
    db: str = ""
    login: str = ""
    api_key: str = field(default="", repr=False)
    credential_profile: str = ""
    company_ids: list[int] = field(default_factory=list)
    lang: str = "en_US"
    timeout: int = 60
    max_retries: int = 5
    # scope
    intercompany_partner_ids: list[int] = field(default_factory=list)
    exclude_intercompany: bool = True
    exclude_team_names: list[str] = field(default_factory=list)
    exclude_segments: list[str] = field(default_factory=list)
    sales_team_file: Path | None = None
    # report
    week_end_day: int = 5  # Saturday
    trend_weeks: int = 4
    target_pct: float = 20.0
    target_overrides: dict[str, float] = field(default_factory=dict)
    next_week_reduction_pct: float = 10.0
    priority_rows: int = 15
    reps: list[str] = field(default_factory=list)  # empty = every salesperson with debt
    min_outstanding: float = 0.0
    include_unassigned: bool = True
    output_dir: Path = HERE / "output"
    log_dir: Path = HERE / "logs"
    buckets: list[Bucket] = field(default_factory=lambda: list(DEFAULT_BUCKETS))
    # email
    email_enabled: bool = False
    email_to_rep: bool = True
    email_cc: list[str] = field(default_factory=list)
    email_summary_to: list[str] = field(default_factory=list)
    email_rep_overrides: dict[str, str] = field(default_factory=dict)
    recipients_file: Path | None = None
    email_method: str = "outlook"
    use_odoo_email_if_blank: bool = False
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_secure: bool = False
    smtp_user: str = ""
    smtp_password: str = field(default="", repr=False)
    smtp_from: str = ""
    env_files_loaded: list[str] = field(default_factory=list)


def load_settings(config_path: Path, env_file: Path | None = None) -> Settings:
    cp = configparser.ConfigParser(inline_comment_prefixes=(";",), interpolation=None)
    cp.optionxform = str  # keep the case of rep names in [targets] / [email_overrides]
    if config_path.is_file():
        cp.read(config_path, encoding="utf-8-sig")
    base = config_path.resolve().parent
    s = Settings()

    def rel(p: str) -> Path:
        q = Path(os.path.expandvars(p.strip()))
        return q if q.is_absolute() else (base / q).resolve()

    # secrets: own .env first, then the configured one (e.g. the ETL's), then the environment
    env_candidates = [env_file] if env_file else [base / ".env"]
    for extra in _names(cp.get("odoo", "env_file", fallback="")):
        env_candidates.append(rel(extra))
    for cand in env_candidates:
        if cand and Path(cand).is_file():
            load_env_file(Path(cand))
            s.env_files_loaded.append(str(cand))

    s.credential_profile = cp.get("odoo", "credential_profile", fallback="").strip().upper()
    s.url = os.getenv("ODOO_URL", "").strip()
    s.db = os.getenv("ODOO_DB", "").strip()
    prof = s.credential_profile
    if prof and os.getenv(f"ODOO_{prof}_LOGIN") and os.getenv(f"ODOO_{prof}_API_KEY"):
        s.login, s.api_key = os.environ[f"ODOO_{prof}_LOGIN"].strip(), os.environ[f"ODOO_{prof}_API_KEY"].strip()
    else:
        s.credential_profile = "DEFAULT"
        s.login = (os.getenv("ODOO_USER") or os.getenv("ODOO_USERNAME") or "").strip()
        s.api_key = os.getenv("ODOO_API_KEY", "").strip()
    s.company_ids = _ints(os.getenv("ODOO_COMPANY_IDS") or cp.get("odoo", "company_ids", fallback=""))
    s.lang = cp.get("odoo", "lang", fallback="en_US")
    s.timeout = int(os.getenv("ODOO_TIMEOUT_SECONDS") or cp.get("odoo", "timeout_seconds", fallback="60"))
    s.max_retries = int(os.getenv("ODOO_MAX_RETRIES") or cp.get("odoo", "max_retries", fallback="5"))

    s.intercompany_partner_ids = _ints(os.getenv("FINANCE_INTERCOMPANY_PARTNER_IDS")
                                       or cp.get("scope", "intercompany_partner_ids", fallback=""))
    s.exclude_intercompany = cp.getboolean("scope", "exclude_intercompany", fallback=True)
    s.exclude_team_names = _names(cp.get("scope", "exclude_team_names", fallback=""))
    s.exclude_segments = [x.lower() for x in _names(cp.get("scope", "exclude_segments", fallback=""))]
    stf = cp.get("scope", "sales_team_file", fallback="").strip()
    s.sales_team_file = rel(stf) if stf else None

    wd = cp.get("report", "week_end_day", fallback="saturday").strip().lower()
    s.week_end_day = WEEKDAYS.index(wd)
    s.trend_weeks = max(2, cp.getint("report", "trend_weeks", fallback=4))
    s.target_pct = cp.getfloat("report", "weekly_target_pct_of_overdue", fallback=20.0)
    s.next_week_reduction_pct = cp.getfloat("report", "next_week_overdue_reduction_pct", fallback=10.0)
    s.priority_rows = cp.getint("report", "priority_rows", fallback=15)
    s.reps = _names(cp.get("report", "salespeople", fallback=""))
    s.min_outstanding = cp.getfloat("report", "min_outstanding", fallback=0.0)
    s.include_unassigned = cp.getboolean("report", "include_unassigned", fallback=True)
    s.output_dir = rel(cp.get("report", "output_dir", fallback="output"))
    s.log_dir = rel(cp.get("report", "log_dir", fallback="logs"))
    if cp.has_section("targets"):
        s.target_overrides = {k.strip().lower(): float(v) for k, v in cp.items("targets") if v.strip()}

    s.email_enabled = cp.getboolean("email", "enabled", fallback=False)
    s.email_to_rep = cp.getboolean("email", "send_to_salesperson", fallback=True)
    s.email_cc = [x.strip() for x in cp.get("email", "cc", fallback="").split(",") if x.strip()]
    s.email_summary_to = [x.strip() for x in cp.get("email", "team_summary_to", fallback="").split(",") if x.strip()]
    s.email_method = cp.get("email", "method", fallback="outlook").strip().lower()
    if s.email_method not in ("outlook", "smtp"):
        raise ValueError(f"[email] method must be outlook or smtp, not '{s.email_method}'")
    rf = cp.get("email", "recipients_file", fallback="").strip()
    s.recipients_file = rel(rf) if rf else None
    s.use_odoo_email_if_blank = cp.getboolean("email", "use_odoo_email_if_blank", fallback=False)
    if cp.has_section("email_overrides"):
        s.email_rep_overrides = {k.strip().lower(): v.strip() for k, v in cp.items("email_overrides") if v.strip()}
    s.smtp_host = os.getenv("SMTP_HOST", "").strip()
    s.smtp_port = int(os.getenv("SMTP_PORT") or 587)
    s.smtp_secure = os.getenv("SMTP_SECURE", "false").strip().lower() in ("1", "true", "yes")
    s.smtp_user = os.getenv("SMTP_USER", "").strip()
    s.smtp_password = os.getenv("SMTP_PASSWORD", "")
    s.smtp_from = os.getenv("SMTP_FROM", "").strip() or s.smtp_user
    return s


def default_as_of(today: dt.date, week_end_day: int) -> dt.date:
    """The last COMPLETED week end strictly before today (run on Sunday -> yesterday's Saturday)."""
    delta = (today.weekday() - week_end_day) % 7 or 7
    return today - dt.timedelta(days=delta)
