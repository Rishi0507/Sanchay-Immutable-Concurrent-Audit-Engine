"""D-06 Period allocation follows transfer of control, not invoice date (Ind AS 115, AS 9)."""

from __future__ import annotations

import datetime as dt

from ..findings import adjustment
from ..money import rupees
from .common import control_date, doc_ids, inv_date, order_of, related, seqs


def assess(ctx, inv: dict) -> dict:
    """Cut-off facts for one invoice. Also used by the Sales Cut-off TOD (CO-4)."""
    snap = ctx.snap
    order = order_of(ctx, inv)
    dispatch = snap.dispatch_for_invoice(inv)
    delivery = snap.delivery_for_dispatch(dispatch.get("dispatch_id")) if dispatch else None
    cdate, basis = control_date(ctx, inv)
    posting = inv.get("_business_date")
    rec = inv_date(inv)

    def period_of(day: dt.date | None) -> str | None:
        if day is None:
            return None
        if day < ctx.start:
            return "Prior period"
        if day > ctx.end:
            return "Next period"
        return "Current period"

    recognised, correct = period_of(rec), period_of(cdate)
    return {"invoice_date": inv.get("invoice_date"), "terms": (order or {}).get("delivery_terms"),
            "dispatch_date": (dispatch or {}).get("dispatched_at", "")[:10] or None,
            "delivery_date": (delivery or {}).get("delivered_at", "")[:10] or None,
            "control_date": cdate.isoformat() if cdate else None, "basis": basis, "posting_date": posting,
            "period_recognised": recognised, "correct_period": correct,
            "ok": None if correct is None else recognised == correct,
            "docs": [inv, order, dispatch, delivery]}


def detect(ctx) -> list[dict]:
    out = []
    window = dt.timedelta(days=60)
    for inv in ctx.snap.invoices:
        if inv["_reversed"] or not ctx.in_scope(inv):
            continue
        rec = inv_date(inv)
        if rec is None or not (ctx.start - window <= rec <= ctx.end + window):
            continue
        a = assess(ctx, inv)
        if a["ok"] is not False:
            continue
        in_now = a["period_recognised"] == "Current period"
        taxable = inv.get("taxable_value") or 0
        if in_now:
            sub, effect = "RECOGNISED_EARLY" if a["correct_period"] == "Next period" else "RECOGNISED_LATE", "Overstated"
            adj = adjustment([("4000", taxable, 0), ("1100", 0, taxable)],
                             f"Defer {inv['invoice_no']}: control passed on {a['control_date']}")
        else:
            sub = "RECOGNISED_LATE" if a["period_recognised"] == "Next period" else "RECOGNISED_EARLY"
            effect = "Understated"
            adj = adjustment([("1100", taxable, 0), ("4000", 0, taxable)],
                             f"Accrue {inv['invoice_no']}: control passed on {a['control_date']}")
        out.append(ctx.finding(
            category="CUTOFF", subtype=sub, subject_type="invoice", subject_id=inv["invoice_no"],
            subject_label=inv.get("customer_name"), related_party=related(ctx, inv), amount_impact=taxable,
            period_effect=effect, proposed_adjustment=adj, event_seqs=seqs(*a["docs"]),
            document_ids=doc_ids(*a["docs"]),
            facts={k: v for k, v in a.items() if k != "docs"},
            title=f"Invoice {inv['invoice_no']} recognised in the {a['period_recognised'].lower()}, control "
                  f"passed in the {a['correct_period'].lower()}",
            reason=(f"Invoice {inv['invoice_no']} is dated {a['invoice_date']} and posted {a['posting_date']} "
                    f"({a['period_recognised'].lower()}). Delivery terms are {a['terms'] or 'not recorded'}, so "
                    f"control passed on the {a['basis']}, {a['control_date']} ({a['correct_period'].lower()}). "
                    f"Revenue of Rs {rupees(taxable)} for the period ending {ctx.end} is "
                    f"{effect.lower()}.")))
    return out
