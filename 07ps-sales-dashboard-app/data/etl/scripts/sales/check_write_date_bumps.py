"""Phase B check (read-only): do the events that change stored computed sales fields move write_date?

  python scripts/sales/check_write_date_bumps.py [--days 3] [--env-file .env]

The incremental sales extract reads sale.order and sale.order.line by write_date (a changed order also re-reads all its
lines). A stored computed field that Odoo recomputes WITHOUT touching write_date would be missed. For each event of the
last --days days this compares the event time with the write_date of the affected line AND of its order:

  delivery validated     stock.picking done (sale_id set)       -> sale lines of its moves   (qty_delivered)
  invoice created        customer invoice/refund created (draft) -> sale lines it invoices (qty_invoiced: drafts count)
  invoice posted         customer invoice/refund posted          -> sale lines it invoices    (qty_invoiced, invoice_status)
  invoice cancelled      customer invoice/refund cancelled       -> the same                  (qty_invoiced, invoice_status)
  order confirmed        sale.order state sale                   -> the order and its lines   (state)
  order cancelled        sale.order state cancel                 -> the order and its lines   (state)

Odoo stamps write_date with the START time of the transaction, while date_done / the chatter time are taken later in
the same transaction. So the reference time of an event is the event record's own write_date (= its transaction start)
when the record was not written again after the event; otherwise the event time minus 60 s. An event is CAUGHT when the
sale line's or its order's write_date is >= that reference (same transaction or later). Event times: picking date_done;
invoice / order: the last state change in the chatter (mail.tracking.value on 'state').
"""

from __future__ import annotations

import argparse
import datetime as _dt
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "src"), str(ROOT)]

from etl_platform.config import PlatformConfig  # noqa: E402
from etl_platform.sources.odoo import OdooSource, m2o_id  # noqa: E402

FMT = "%Y-%m-%d %H:%M:%S"
SLACK = _dt.timedelta(seconds=1)
FALLBACK = _dt.timedelta(seconds=60)


def reference(event_time, record_write_date):
    """Transaction start of the event: the record's write_date if it was not written after the event, else event - 60 s."""
    rw = ts(record_write_date)
    return rw if rw is not None and rw <= event_time + SLACK else event_time - FALLBACK


def ts(v):
    return _dt.datetime.strptime(v[:19], FMT) if v else None


def read(client, model, domain, fields, limit=0):
    return client.search_read(model, domain, fields, limit=limit, order="id", context={"active_test": False})


def state_change_times(client, model, ids, new_value=None):
    """{record id: time of its latest state change} from the chatter's tracking values. The labels are in the users'
    language (Arabic here), so they are not matched: the records are selected by their CURRENT state, and their latest
    state change is the change into it."""
    if not ids:
        return {}
    msgs = read(client, "mail.message", [("model", "=", model), ("res_id", "in", list(ids))], ["id", "res_id", "date"])
    by_msg = {m["id"]: (m["res_id"], m["date"]) for m in msgs}
    out = {}
    if not by_msg:
        return out
    tv = read(client, "mail.tracking.value", [("mail_message_id", "in", list(by_msg)), ("field_id.name", "=", "state")],
              ["mail_message_id", "new_value_char"])
    for t in tv:
        rid, when = by_msg[m2o_id(t["mail_message_id"])]
        out[rid] = max(out.get(rid, ts(when)), ts(when))
    return out


def judge(name, events, lines, orders):
    """events: [(event time, [sale line ids])]."""
    caught = missed = 0
    examples = []
    line_only = order_only = 0
    for when, line_ids in events:
        for lid in line_ids:
            line = lines.get(lid)
            if not line:
                continue
            lw = ts(line["write_date"])
            ow = ts(orders.get(m2o_id(line["order_id"]), {}).get("write_date"))
            l_ok = lw is not None and lw >= when - SLACK
            o_ok = ow is not None and ow >= when - SLACK
            if l_ok or o_ok:
                caught += 1
                line_only += l_ok and not o_ok
                order_only += o_ok and not l_ok
            else:
                missed += 1
                if len(examples) < 5:
                    examples.append((lid, str(when), line["write_date"], orders.get(m2o_id(line["order_id"]), {}).get("write_date")))
    verdict = "OK" if missed == 0 and caught else ("NO DATA" if not caught and not missed else "MISSED")
    print(f"{name:20} lines checked {caught + missed:6,}  caught {caught:6,}  missed {missed:4}  "
          f"(line write_date only {line_only}, order write_date only {order_only})  {verdict}")
    for e in examples:
        print(f"    line {e[0]}: event {e[1]}, line write_date {e[2]}, order write_date {e[3]}")
    return missed


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=3)
    ap.add_argument("--env-file", default=str(ROOT / ".env"))
    args = ap.parse_args()
    client = OdooSource.connect(PlatformConfig.from_env(args.env_file)).client
    since = (_dt.datetime.now(_dt.timezone.utc) - _dt.timedelta(days=args.days)).strftime(FMT)
    events: dict[str, list] = defaultdict(list)

    # deliveries validated
    picks = read(client, "stock.picking", [("state", "=", "done"), ("date_done", ">=", since), ("sale_id", "!=", False)],
                 ["id", "date_done", "move_ids", "write_date"])
    moves = {m["id"]: m for m in read(client, "stock.move", [("picking_id", "in", [p["id"] for p in picks])], ["id", "sale_line_id"])}
    for p in picks:
        lids = [m2o_id(moves[m]["sale_line_id"]) for m in p["move_ids"] if m in moves and moves[m]["sale_line_id"]]
        events["delivery validated"].append((reference(ts(p["date_done"]), p["write_date"]), lids))

    # invoices created (Odoo 17 counts draft invoices in qty_invoiced: the line changes when the invoice is CREATED)
    new_invs = read(client, "account.move", [("move_type", "in", ["out_invoice", "out_refund"]), ("create_date", ">=", since)],
                    ["id", "create_date"])
    amls = read(client, "account.move.line", [("move_id", "in", [i["id"] for i in new_invs]), ("sale_line_ids", "!=", False)],
                ["move_id", "sale_line_ids"])
    by_move = defaultdict(list)
    for a in amls:
        by_move[m2o_id(a["move_id"])].extend(a["sale_line_ids"])
    for i in new_invs:
        events["invoice created"].append((ts(i["create_date"]), by_move.get(i["id"], [])))

    # invoices posted / cancelled
    for label, state in (("invoice posted", "posted"), ("invoice cancelled", "cancel")):
        invs = read(client, "account.move", [("move_type", "in", ["out_invoice", "out_refund"]), ("state", "=", state),
                                             ("write_date", ">=", since)], ["id", "write_date"])
        when = state_change_times(client, "account.move", [i["id"] for i in invs], {state, "posted" if state == "posted" else "cancelled"})
        amls = read(client, "account.move.line", [("move_id", "in", [i["id"] for i in invs]), ("sale_line_ids", "!=", False)],
                    ["move_id", "sale_line_ids"])
        by_move = defaultdict(list)
        for a in amls:
            by_move[m2o_id(a["move_id"])].extend(a["sale_line_ids"])
        for i in invs:
            t = when.get(i["id"])
            if t and t >= ts(since):  # only state changes inside the window, with a known time
                events[label].append((reference(t, i["write_date"]), by_move.get(i["id"], [])))

    # orders confirmed / cancelled
    for label, state in (("order confirmed", "sale"), ("order cancelled", "cancel")):
        sos = read(client, "sale.order", [("state", "=", state), ("write_date", ">=", since)], ["id", "order_line", "write_date"])
        when = state_change_times(client, "sale.order", [s["id"] for s in sos], {state, "sales order" if state == "sale" else "cancelled"})
        for s in sos:
            t = when.get(s["id"])
            if t and t >= ts(since):
                events[label].append((reference(t, s["write_date"]), s["order_line"]))

    all_lines = {l for evs in events.values() for _, ls in evs for l in ls}
    lines = {l["id"]: l for l in read(client, "sale.order.line", [("id", "in", list(all_lines))], ["id", "order_id", "write_date"])}
    orders = {o["id"]: o for o in read(client, "sale.order", [("id", "in", list({m2o_id(l["order_id"]) for l in lines.values()}))],
                                         ["id", "write_date"])}
    print(f"Events since {since} UTC (sale line / order write_date vs the event's transaction start):")
    missed = sum(judge(k, events[k], lines, orders) for k in
                 ("delivery validated", "invoice created", "invoice posted", "invoice cancelled", "order confirmed",
                  "order cancelled"))
    return 1 if missed else 0


if __name__ == "__main__":
    sys.exit(main())
