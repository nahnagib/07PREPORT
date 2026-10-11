"""The email body (Arabic, right-to-left, simple). Built from plain tables with inline styles so it shows the same in
Outlook (classic and new), Outlook on the web and Gmail. The full detail is in the attached Excel workbook."""
from __future__ import annotations

import datetime as dt
import html

import pandas as pd

from engine import RepReport

DAYS_AR = ["الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت", "الأحد"]
CCY_AR = {"LYD": "د.ل", "USD": "دولار", "EUR": "يورو"}

FONT = "font-family:Tahoma,Arial,sans-serif;"
TABLE = f"border-collapse:collapse;width:100%;max-width:640px;{FONT}font-size:14px;"
TH = "background:#25313f;color:#ffffff;padding:8px 10px;text-align:right;font-weight:bold;border:1px solid #25313f;"
TD = "padding:8px 10px;border:1px solid #dde2e8;text-align:right;"
TDN = "padding:8px 10px;border:1px solid #dde2e8;text-align:left;direction:ltr;white-space:nowrap;"
TOT = "background:#eef1f5;font-weight:bold;"


def esc(v) -> str:
    return html.escape("" if v is None else str(v))


def ccy_ar(c: str) -> str:
    return CCY_AR.get(c, c)


def num(v, dec: int = 0) -> str:
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return "—"
    return f"{v:,.{dec}f}"


def pct(v, dec: int = 1) -> str:
    return "—" if v is None or (isinstance(v, float) and pd.isna(v)) else f"{v * 100:.{dec}f}%"


def day_ar(d: dt.date) -> str:
    return f"{DAYS_AR[d.weekday()]} {d:%d/%m/%Y}"


def _row(cells: list[str], style: str = "", num_cols: tuple[int, ...] = ()) -> str:
    return "<tr>" + "".join(f'<td style="{TDN if i in num_cols else TD}{style}">{c}</td>' for i, c in enumerate(cells)) + "</tr>"


def _head(cols: list[str]) -> str:
    return "<tr>" + "".join(f'<th style="{TH}">{esc(c)}</th>' for c in cols) + "</tr>"


def render_rep(r: RepReport, generated: dt.datetime, scope_note: str = "") -> str:
    k, w, p = r.kpi, r.week, r.prior
    c = ccy_ar(r.currency)
    week_from, week_to = w.start_date + dt.timedelta(days=1), w.end_date
    gross = k["gross"]

    status = "".join([
        _head(["البند", f"المبلغ ({c})", "النسبة", "عدد الفواتير", "عدد العملاء"]),
        _row(["إجمالي الديون", num(gross), "100%", num(k["invoices"]), num(k["debtors"])], TOT, (1, 2, 3, 4)),
        _row(["<span style='color:#c62828'>المتأخرات (تجاوزت تاريخ الاستحقاق)</span>", num(k["overdue"]),
              pct(k["overdue"] / gross if gross else None), num(k["overdue_invoices"]), num(k["overdue_clients"])], "", (1, 2, 3, 4)),
        _row(["<span style='color:#2e7d32'>غير مستحقة بعد</span>", num(k["not_due"]),
              pct(k["not_due"] / gross if gross else None), num(k["not_due_invoices"]), num(k["not_due_clients"])], "", (1, 2, 3, 4)),
    ])

    start = w.start_overdue
    coll_rows = [
        _head(["البند", f"المبلغ ({c})", "النسبة"]),
        _row([f"المتأخرات في بداية الأسبوع ({day_ar(w.start_date)})", num(start), "100%" if start else "—"], TOT, (1, 2)),
        _row(["<b style='color:#2e7d32'>المحصّل منها خلال الأسبوع</b>", f"<b>{num(w.collected_overdue)}</b>",
              f"<b>{pct(w.collection_rate)}</b>"], "", (1, 2)),
    ]
    if abs(w.adjustments) >= 0.5:
        coll_rows.append(_row(["إشعارات دائنة وتسويات عليها", num(w.adjustments), pct(w.adjustments / start if start else None)], "", (1, 2)))
    coll_rows += [
        _row(["المتبقي منها", num(w.remaining), pct(w.remaining / start if start else None)], "", (1, 2)),
        _row(["<span style='color:#c62828'>متأخرات جديدة دخلت خلال الأسبوع</span>", num(w.new_overdue), ""], "", (1, 2)),
        _row([f"إجمالي المتأخرات في نهاية الأسبوع ({day_ar(w.end_date)})", num(w.end_overdue), ""], TOT, (1, 2)),
    ]
    collection = "".join(coll_rows)

    notes = [f"إجمالي المتأخرات = المتبقي ({num(w.remaining)}) + المتأخرات الجديدة ({num(w.new_overdue)}) = {num(w.remaining + w.new_overdue)}"]
    if p is not None and p.collection_rate is not None:
        notes.append(f"للمقارنة: نسبة التحصيل في الأسبوع السابق {pct(p.collection_rate)} "
                     f"({num(p.collected_overdue)} من أصل {num(p.start_overdue)}).")
    if w.target:
        notes.append(f"المستهدف الأسبوعي {num(w.target)}، نسبة التحقيق {pct(w.achievement, 0)}.")

    return f"""<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>تقرير التحصيل الأسبوعي</title></head>
<body dir="rtl" style="margin:0;padding:16px;background:#ffffff;color:#1f2933;{FONT}font-size:14px;line-height:1.6;text-align:right;">
<div dir="rtl" style="max-width:640px;">
<p style="margin:0 0 4px;font-size:18px;font-weight:bold;">تقرير التحصيل الأسبوعي</p>
<p style="margin:0 0 16px;color:#5f6b7a;">المندوب: <b style="color:#1f2933;">{esc(r.rep)}</b><br>
الفترة: من {day_ar(week_from)} إلى {day_ar(week_to)}<br>العملة: {esc(c)}</p>

<p style="margin:16px 0 6px;font-size:15px;font-weight:bold;">الوضع كما في {day_ar(r.as_of)}</p>
<table dir="rtl" cellpadding="0" cellspacing="0" style="{TABLE}">{status}</table>

<p style="margin:20px 0 6px;font-size:15px;font-weight:bold;">التحصيل الأسبوعي</p>
<table dir="rtl" cellpadding="0" cellspacing="0" style="{TABLE}">{collection}</table>
<p style="margin:6px 0 0;color:#5f6b7a;font-size:13px;">{'<br>'.join(esc(n) for n in notes)}</p>

<p style="margin:20px 0 0;color:#5f6b7a;font-size:13px;">التفاصيل الكاملة (أعمار الديون، الفواتير ذات الأولوية، العملاء، كل الفواتير) في ملف Excel المرفق.<br>
المحصّل = الدفعات المسددة خلال الأسبوع على الفواتير التي كانت متأخرة في بداية الأسبوع فقط.<br>
تقرير آلي من نظام Odoo — {generated:%d/%m/%Y %H:%M}</p>
</div></body></html>"""


def render_team(summary: pd.DataFrame, as_of: dt.date, generated: dt.datetime) -> str:
    parts = []
    for ccy, part in summary.groupby("Currency"):
        c = ccy_ar(ccy)
        rows = [_head(["المندوب", "إجمالي الديون", "المتأخرات", "غير مستحقة", "عدد الفواتير", "عدد العملاء",
                       "متأخرات بداية الأسبوع", "المحصّل منها", "نسبة التحصيل", "متأخرات جديدة", "متأخرات نهاية الأسبوع"])]
        for _, x in part.iterrows():
            rows.append(_row([esc(x["Salesperson"]), num(x["Outstanding"]), num(x["Overdue"]), num(x["Not Due"]), num(x["Invoices"]),
                              num(x["Debtors"]), num(x["Start Overdue"]), num(x["Collected (overdue)"]), pct(x["Collection Rate"]),
                              num(x["New Overdue"]), num(x["End Overdue"])], "", tuple(range(1, 11))))
        t = part.sum(numeric_only=True)
        rows.append(_row(["الإجمالي", num(t["Outstanding"]), num(t["Overdue"]), num(t["Not Due"]), num(t["Invoices"]), num(t["Debtors"]),
                          num(t["Start Overdue"]), num(t["Collected (overdue)"]),
                          pct(t["Collected (overdue)"] / t["Start Overdue"] if t["Start Overdue"] else None),
                          num(t["New Overdue"]), num(t["End Overdue"])], TOT, tuple(range(1, 11))))
        parts.append(f'<p style="margin:16px 0 6px;font-size:15px;font-weight:bold;">العملة: {esc(c)}</p>'
                     f'<table dir="rtl" cellpadding="0" cellspacing="0" style="{TABLE}max-width:100%;font-size:13px;">{"".join(rows)}</table>')
    week_from = as_of - dt.timedelta(days=6)
    return f"""<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>ملخص التحصيل الأسبوعي</title></head>
<body dir="rtl" style="margin:0;padding:16px;background:#ffffff;color:#1f2933;{FONT}font-size:14px;line-height:1.6;text-align:right;">
<p style="margin:0 0 4px;font-size:18px;font-weight:bold;">ملخص التحصيل الأسبوعي — كل المندوبين</p>
<p style="margin:0 0 8px;color:#5f6b7a;">الفترة: من {day_ar(week_from)} إلى {day_ar(as_of)}</p>
{''.join(parts)}
<p style="margin:16px 0 0;color:#5f6b7a;font-size:13px;">عدد العملاء في الإجمالي قد يتكرر إذا تعامل العميل مع أكثر من مندوب. التفاصيل في ملف Excel المرفق.<br>
تقرير آلي من نظام Odoo — {generated:%d/%m/%Y %H:%M}</p></body></html>"""
