"""All report calculations. Pure pandas: no Odoo calls, so it is unit-testable with any data.

Balance of a line on a past date D = its open balance now + the reconciliations made after D
(account.partial.reconcile.max_date > D). This is how Odoo's own Aged Receivable rebuilds a past date, so a
report for any past week end can be (re)produced. "Due today" is not overdue: days overdue = D - due date.
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field
from typing import Any

import pandas as pd

from settings import Bucket, Settings

EPS = 0.005


def residual_at(lines: pd.DataFrame, partials: pd.DataFrame, d: dt.date) -> pd.Series:
    later = partials[partials["max_date"] > d]
    add_d = later.groupby("debit_line")["amt_debit"].sum()
    add_c = later.groupby("credit_line")["amt_credit"].sum()
    res = (lines["residual"] + lines["line_id"].map(add_d).fillna(0.0) - lines["line_id"].map(add_c).fillna(0.0)).round(2)
    res = res.where(lines["date"] <= d, 0.0)
    return res.where(res.abs() > EPS, 0.0)


def bucket_for(days: int, buckets: list[Bucket]) -> int:
    if days <= 0:
        return 0
    for b in buckets:
        if days >= b.low and (b.high is None or days <= b.high):
            return b.key
    return buckets[-1].key


def snapshot(lines: pd.DataFrame, partials: pd.DataFrame, d: dt.date, buckets: list[Bucket]) -> pd.DataFrame:
    out = lines.copy()
    out["res"] = residual_at(lines, partials, d)
    out = out[out["res"] != 0].copy()
    out["days"] = [(d - x).days for x in out["due"]]
    out["bucket"] = [bucket_for(x, buckets) for x in out["days"]]
    return out


@dataclass
class WeekResult:
    start_date: dt.date
    end_date: dt.date
    start_overdue: float
    target: float
    collected_overdue: float
    credit_notes_overdue: float
    other_overdue: float
    collected_total: float
    new_overdue: float
    new_overdue_docs: int
    end_overdue: float
    unexplained: float

    @property
    def collection_rate(self) -> float | None:
        return self.collected_overdue / self.start_overdue if self.start_overdue else None

    @property
    def achievement(self) -> float | None:
        return self.collected_overdue / self.target if self.target else None

    @property
    def adjustments(self) -> float:
        """Credit notes and other settlements (write-offs) on the starting overdue: not cash collection."""
        return round(self.credit_notes_overdue + self.other_overdue, 2)

    @property
    def remaining(self) -> float:
        """What is left of the starting overdue at the end of the week (start - collected - adjustments)."""
        return round(self.start_overdue - self.collected_overdue - self.adjustments, 2)

    @property
    def net_change(self) -> float:
        return self.end_overdue - self.start_overdue


def week_result(lines: pd.DataFrame, partials: pd.DataFrame, w0: dt.date, w1: dt.date, target_pct: float,
                target_override: float | None = None) -> WeekResult:
    inv = lines[lines["kind"] == "invoice"]
    r0, r1 = residual_at(inv, partials, w0), residual_at(inv, partials, w1)
    od0 = (inv["due"] < w0) & (r0 > EPS)
    od1 = (inv["due"] < w1) & (r1 > EPS)
    start_set = set(inv.loc[od0, "line_id"])
    win = partials[(partials["max_date"] > w0) & (partials["max_date"] <= w1) & partials["debit_line"].isin(inv["line_id"])]
    on_od = win[win["debit_line"].isin(start_set)]
    by_class = on_od.groupby("credit_class")["amt_debit"].sum()
    start, end = float(r0[od0].sum()), float(r1[od1].sum())
    new_mask = od1 & ~inv["line_id"].isin(start_set)
    new = float(r1[new_mask].sum())
    cash, cn, other = (float(by_class.get(k, 0.0)) for k in ("cash", "credit_note", "other"))
    target = float(target_override) if target_override is not None else round(start * target_pct / 100.0, 2)
    return WeekResult(w0, w1, round(start, 2), target, round(cash, 2), round(cn, 2), round(other, 2),
                      round(float(win.loc[win["credit_class"] == "cash", "amt_debit"].sum()), 2), round(new, 2),
                      int(inv.loc[new_mask, "move_id"].nunique()), round(end, 2),
                      round(start - cash - cn - other + new - end, 2))


@dataclass
class RepReport:
    rep_id: int
    rep: str
    rep_email: str
    team: str
    channel: str
    currency: str
    as_of: dt.date
    kpi: dict[str, Any]
    aging: pd.DataFrame
    not_due: pd.DataFrame
    weeks: list[WeekResult]
    priority: pd.DataFrame
    clients: pd.DataFrame
    crossings: pd.DataFrame
    upcoming: pd.DataFrame
    credits: pd.DataFrame
    open_items: pd.DataFrame
    plan: dict[str, float]
    recommendations: list[tuple[str, str]] = field(default_factory=list)
    rep_odoo_name: str = ""

    @property
    def week(self) -> WeekResult:
        return self.weeks[0]

    @property
    def prior(self) -> WeekResult | None:
        return self.weeks[1] if len(self.weeks) > 1 else None


def _fmt(x: float, ccy: str) -> str:
    return f"{x:,.0f} {ccy}".strip()


def _action(row: pd.Series, by_bucket: dict[int, Bucket], client_worst: dict[Any, int], client_worst_days: dict[Any, int],
            client_credit: dict[Any, float], ccy: str) -> str:
    b = by_bucket[row["bucket"]]
    parts = [b.action]
    worst = client_worst.get(row["customer_id"], 0)
    if worst >= 3 and worst > row["bucket"]:
        parts.insert(0, f"إيقاف الطلبات الجديدة: لدى العميل ديون متأخرة منذ {client_worst_days[row['customer_id']]} يوم")
    nxt = by_bucket.get(row["bucket"] + 1)
    if nxt and b.high is not None and row["days"] + 7 > b.high:
        parts.append(f"تنتقل إلى فئة {nxt.label} بتاريخ {(row['due'] + dt.timedelta(days=b.high + 1)):%d/%m/%Y}")
    cr = client_credit.get(row["customer_id"], 0.0)
    if cr < -EPS:
        parts.append(f"لدى العميل رصيد دائن غير مخصص {_fmt(-cr, ccy)}: يُطلب من المالية تخصيصه أولاً")
    return "؛ ".join(parts)


def rep_report(rep_lines: pd.DataFrame, partials: pd.DataFrame, as_of: dt.date, s: Settings,
               target_override: float | None = None) -> RepReport:
    buckets = s.buckets
    by_bucket = {b.key: b for b in buckets}
    first = rep_lines.iloc[0]
    ccy = str(first["currency"])
    rep = str(first["rep"])
    override = target_override if target_override is not None else (
        s.target_overrides.get(rep.lower()) or s.target_overrides.get(str(first["rep_odoo_name"]).lower()))

    weeks = [week_result(rep_lines, partials, as_of - dt.timedelta(days=7 * (k + 1)), as_of - dt.timedelta(days=7 * k),
                         s.target_pct, override if k == 0 else None) for k in range(s.trend_weeks)]

    snap = snapshot(rep_lines, partials, as_of, buckets)
    inv = snap[(snap["kind"] == "invoice") & (snap["res"] > 0)].copy()
    cred = snap[(snap["kind"] == "credit") | (snap["res"] < 0)].copy()
    inv = inv[inv["res"] > 0]
    od = inv[inv["bucket"] > 0]
    nd = inv[inv["bucket"] == 0]
    gross, overdue = float(inv["res"].sum()), float(od["res"].sum())
    credits = float(cred["res"].sum())
    severe = float(od.loc[od["bucket"] >= 3, "res"].sum())
    kpi = {
        "gross": gross, "overdue": overdue, "not_due": float(nd["res"].sum()), "credits": credits, "net": gross + credits,
        "debtors": int(inv["customer_id"].nunique()), "overdue_clients": int(od["customer_id"].nunique()),
        "not_due_only_clients": int(len(set(nd["customer_id"]) - set(od["customer_id"]))),
        "not_due_clients": int(nd["customer_id"].nunique()),
        "invoices": int(inv["move_id"].nunique()), "overdue_invoices": int(od["move_id"].nunique()),
        "not_due_invoices": int(nd["move_id"].nunique()), "credit_docs": int(cred["move_id"].nunique()),
        "overdue_ratio": overdue / gross if gross else None, "severe": severe,
        "severe_share": severe / overdue if overdue else None,
        "weighted_days": float((od["res"] * od["days"]).sum() / overdue) if overdue else 0.0,
    }

    rows = []
    for b in buckets:
        part = od[od["bucket"] == b.key]
        amt = float(part["res"].sum())
        n = int(part["move_id"].nunique())
        rows.append({"key": b.key, "Aging Bucket": b.label, "Amount Past Due": amt,
                     "% of Overdue": amt / overdue if overdue else 0.0, "% of Outstanding": amt / gross if gross else 0.0,
                     "Invoices": n, "Clients": int(part["customer_id"].nunique()), "Avg Invoice": amt / n if n else 0.0,
                     "Risk Level": b.risk, "Recommended Action": b.action, "color": b.color})
    aging = pd.DataFrame(rows)

    nd_rows = []
    for label, lo, hi in (("تستحق خلال 7 أيام", 0, 6), ("تستحق خلال 8–30 يوم", 7, 30), ("تستحق بعد أكثر من 30 يوم", 31, None)):
        ahead = -nd["days"]
        m = (ahead >= lo) & ((ahead <= hi) if hi is not None else True)
        nd_rows.append({"Window": label, "Amount": float(nd.loc[m, "res"].sum()), "Invoices": int(nd.loc[m, "move_id"].nunique())})
    not_due = pd.DataFrame(nd_rows)

    client_credit = cred.groupby("customer_id")["res"].sum().to_dict()
    client_worst = od.groupby("customer_id")["bucket"].max().to_dict()
    client_worst_days = od.groupby("customer_id")["days"].max().to_dict()

    pr = od.sort_values(["bucket", "res"], ascending=[False, False]).head(s.priority_rows).copy()
    pr["Recommended Action"] = [_action(r, by_bucket, client_worst, client_worst_days, client_credit, ccy) for _, r in pr.iterrows()]
    pr["Aging Bucket"] = [by_bucket[k].label for k in pr["bucket"]]
    priority = pr.rename(columns={"customer": "Client", "document": "Invoice", "due": "Due Date", "res": "Outstanding",
                                  "days": "Days Overdue", "company": "Company"})

    g = od.groupby(["customer_id", "customer"]).agg(Overdue=("res", "sum"), Invoices=("move_id", "nunique"),
                                                   Oldest=("days", "max"), Worst=("bucket", "max")).reset_index()
    nd_by = nd.groupby("customer_id")["res"].sum()
    g["Not Due"] = g["customer_id"].map(nd_by).fillna(0.0)
    g["Unapplied Credit"] = g["customer_id"].map(client_credit).fillna(0.0)
    g["Total Exposure"] = g["Overdue"] + g["Not Due"]
    newest = od.groupby("customer_id")["bucket"].min()
    in_top = priority.groupby("customer_id").size()

    def flag(r: pd.Series) -> str:
        f = []
        if r["Worst"] >= 5:
            f.append("مرشح لدين معدوم: يُقترح تكوين مخصص")
        if r["Worst"] >= 4 and newest.get(r["customer_id"], 9) == 1:
            f.append("تدهور: متأخرات جديدة مع بقاء الديون القديمة")
        if r["Worst"] >= 3 and r["Not Due"] > 0:
            f.append("ما زال يشتري بالآجل رغم التأخر")
        if in_top.get(r["customer_id"], 0) >= 2:
            f.append("تسوية واحدة لكل الفواتير")
        if r["Unapplied Credit"] < -EPS:
            f.append("رصيد دائن غير مخصص: يُخصص قبل المطالبة")
        return "؛ ".join(f) or "—"

    g = g.sort_values("Overdue", ascending=False).head(10)
    g["Oldest Bucket"] = [by_bucket[k].label for k in g["Worst"]]
    g["Flag"] = [flag(r) for _, r in g.iterrows()]
    clients = g.rename(columns={"customer": "Client", "Oldest": "Oldest Days"})

    cross_rows = []
    for _, r in od.iterrows():
        b = by_bucket[r["bucket"]]
        nxt = by_bucket.get(r["bucket"] + 1)
        if nxt and nxt.key >= 3 and b.high is not None and r["days"] + 7 > b.high:
            cross_rows.append({"Client": r["customer"], "Invoice": r["document"], "Outstanding": r["res"],
                               "Days Overdue": r["days"], "Moves To": nxt.label,
                               "On": r["due"] + dt.timedelta(days=b.high + 1)})
    crossings = pd.DataFrame(cross_rows, columns=["Client", "Invoice", "Outstanding", "Days Overdue", "Moves To", "On"])
    crossings = crossings.sort_values(["On", "Outstanding"], ascending=[True, False]) if len(crossings) else crossings

    up = nd[(nd["due"] >= as_of) & (nd["due"] < as_of + dt.timedelta(days=7))].sort_values("res", ascending=False)
    upcoming = up.rename(columns={"customer": "Client", "document": "Invoice", "due": "Due Date", "res": "Outstanding"})
    credits_tbl = cred.sort_values("res").rename(columns={"customer": "Client", "document": "Document", "date": "Date",
                                                          "res": "Unapplied Amount"})

    open_items = snap.copy()
    open_items["Status"] = ["رصيد دائن" if (k == "credit" or v < 0) else ("متأخرة" if b else "غير مستحقة")
                            for k, v, b in zip(open_items["kind"], open_items["res"], open_items["bucket"])]
    open_items["Aging Bucket"] = [by_bucket[b].label if b else "غير مستحقة" for b in open_items["bucket"]]
    order = {"متأخرة": 0, "غير مستحقة": 1, "رصيد دائن": 2}
    open_items = open_items.assign(_o=open_items["Status"].map(order)).sort_values(["_o", "bucket", "res"], ascending=[True, False, False]).drop(columns="_o")

    w = weeks[0]
    upcoming_sum = float(upcoming["Outstanding"].sum()) if len(upcoming) else 0.0
    reduce_by = w.end_overdue * s.next_week_reduction_pct / 100.0
    plan = {"upcoming": upcoming_sum, "reduce_by": reduce_by, "needed": reduce_by + upcoming_sum,
            "top_share": float(priority["Outstanding"].sum()) / overdue if overdue else 0.0,
            "top_amount": float(priority["Outstanding"].sum())}

    rpt = RepReport(int(first["rep_id"]), rep, str(first["rep_email"]), str(first["team"]), str(first["channel"]), ccy,
                    as_of, kpi, aging, not_due, weeks, priority, clients, crossings, upcoming, credits_tbl, open_items, plan)
    rpt.rep_odoo_name = str(first["rep_odoo_name"] or "")
    rpt.recommendations = recommendations(rpt, s)
    return rpt


def _still_buying(hold: pd.DataFrame) -> str:
    n = int((hold["Not Due"] > 0).sum()) if len(hold) else 0
    if not n:
        return ""
    return (f" {n} of your top clients on hold {'still has' if n == 1 else 'still have'} not-yet-due invoices, "
            "so new orders went through.")


def recommendations(r: RepReport, s: Settings) -> list[tuple[str, str]]:
    c, w, k = r.currency, r.week, r.kpi
    out: list[tuple[str, str]] = []
    if w.start_overdue or w.end_overdue:
        if w.net_change > EPS:
            head = (f"Overdue grew by {_fmt(w.net_change, c)}: {_fmt(w.new_overdue, c)} became overdue this week "
                    f"against {_fmt(w.collected_overdue, c)} collected from overdue invoices.")
        elif w.net_change < -EPS:
            head = (f"Overdue fell by {_fmt(-w.net_change, c)}: collections ({_fmt(w.collected_overdue, c)}) beat "
                    f"new overdue ({_fmt(w.new_overdue, c)}). Keep the pace.")
        else:
            head = (f"Overdue did not move: {_fmt(w.collected_overdue, c)} collected and {_fmt(w.new_overdue, c)} "
                    "newly overdue cancel out.")
        out.append(("Where you stand", head + f" Next week, collect at least {_fmt(r.plan['needed'], c)} to cut "
                    f"overdue by {s.next_week_reduction_pct:.0f}% ({_fmt(r.plan['reduce_by'], c)}) and absorb "
                    f"the {_fmt(r.plan['upcoming'], c)} falling due."))
    if len(r.priority):
        out.append(("Work the priority list first",
                    f"The {len(r.priority)} priority invoices hold {_fmt(r.plan['top_amount'], c)}, "
                    f"{r.plan['top_share']:.0%} of your overdue. Visit or call these clients before anything else."))
    hold = r.clients[r.clients["Worst"] >= 3] if len(r.clients) else r.clients
    if k["severe"] > EPS:
        out.append(("Enforce credit holds",
                    f"{_fmt(k['severe'], c)} ({(k['severe_share'] or 0):.0%} of overdue) is more than 30 days past due. "
                    "Confirm with Finance that every one of these clients is blocked in Odoo, and release new tile "
                    "shipments only against payment or an approved cheque."
                    + _still_buying(hold)))
    if len(r.crossings):
        items = ", ".join(f"{x.Client} ({x.Invoice}, {x.Outstanding:,.0f}) on {x.On:%d %b}" for x in r.crossings.head(5).itertuples())
        out.append(("Beat the deadlines",
                    f"{len(r.crossings)} invoices move into a worse bucket in the next 7 days: {items}. "
                    "Collect these before they cross."))
    if r.plan["upcoming"] > EPS:
        out.append(("Call before the due date",
                    f"{_fmt(r.plan['upcoming'], c)} ({len(r.upcoming)} invoices) falls due in the next 7 days. "
                    "Phone each client 2–3 days ahead to confirm the payment date and method: it is the cheapest way "
                    "to stop next week's new overdue."))
    if k["credits"] < -EPS:
        out.append(("Clear unapplied credits",
                    f"{_fmt(-k['credits'], c)} of customer payments and credit notes is not allocated to invoices "
                    f"({k['credit_docs']} documents). Ask Finance to reconcile them: some overdue may already be paid."))
    multi = r.clients[r.clients["Flag"].str.contains("تسوية واحدة", na=False)] if len(r.clients) else r.clients
    if len(multi):
        out.append(("Settle per client, not per invoice",
                    "Negotiate one settlement (lump sum or instalments with post-dated cheques) with "
                    + ", ".join(f"{x.Client} ({x.Overdue:,.0f})" for x in multi.head(4).itertuples()) + "."))
    if k["severe"] > EPS:
        out.append(("Find hidden disputes",
                    "For each invoice over 30 days, ask whether there is a problem (breakage, shade or batch "
                    "mismatch, short delivery) and pass disputes to Operations with a 48-hour deadline. Get signed "
                    "balance confirmations from clients over 60 days."))
    return out


def team_summary(reports: list[RepReport]) -> pd.DataFrame:
    rows = []
    for r in reports:
        w = r.week
        rows.append({"Salesperson": r.rep, "Team": r.team, "Currency": r.currency, "Outstanding": r.kpi["gross"],
                     "Overdue": r.kpi["overdue"], "Not Due": r.kpi["not_due"], "Overdue Ratio": r.kpi["overdue_ratio"], "31+ Days": r.kpi["severe"],
                     "Debtors": r.kpi["debtors"], "Invoices": r.kpi["invoices"], "Start Overdue": w.start_overdue,
                     "Target": w.target, "Collected (overdue)": w.collected_overdue, "Collection Rate": w.collection_rate,
                     "Target Achievement": w.achievement, "Adjustments": w.adjustments, "Remaining From Start": w.remaining,
                     "New Overdue": w.new_overdue, "End Overdue": w.end_overdue,
                     "Net Change": w.net_change, "Total Cash Collected": w.collected_total,
                     "Unapplied Credits": r.kpi["credits"]})
    return pd.DataFrame(rows).sort_values(["Currency", "Overdue"], ascending=[True, False]) if rows else pd.DataFrame()
