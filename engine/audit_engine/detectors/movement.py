"""D-05 Turnover with no physical movement behind it."""

from __future__ import annotations

from collections import defaultdict

from ..money import rupees
from .common import (control_date, doc_ids, ewbs_of, inv_date, order_of, period_invoices, related,
                     reverse_invoice_adjustment, seqs)


def detect(ctx) -> list[dict]:
    snap, th = ctx.snap, ctx.th["d05"]
    out = []
    for inv in period_invoices(ctx):
        order = order_of(ctx, inv)
        dispatch = snap.dispatch_for_invoice(inv)
        delivery = snap.delivery_for_dispatch(dispatch.get("dispatch_id")) if dispatch else None
        lrs = snap.lrs_by_dispatch.get(dispatch.get("dispatch_id"), []) if dispatch else []
        ewbs = ewbs_of(ctx, inv, dispatch)
        rel = related(ctx, inv)
        missing = []
        if not order:
            missing.append("sales order")
        if not dispatch:
            missing.append("dispatch")
        if not lrs:
            missing.append("lorry receipt")
        if not delivery:
            missing.append("proof of delivery")
        value = inv.get("gross") or 0
        if value > th["eway_bill_threshold"] and not ewbs:
            missing.append(f"e-way bill (value Rs {rupees(value)} above Rs {rupees(th['eway_bill_threshold'])})")
        lineage_docs = [inv, order, dispatch, delivery, *lrs, *ewbs]
        if missing:
            no_goods = not dispatch and not delivery
            out.append(ctx.finding(
                category="NO_MOVEMENT", subtype="MISSING_DOCUMENTS", subject_type="invoice",
                subject_id=inv["invoice_no"], subject_label=inv.get("customer_name"), related_party=rel,
                title=f"Invoice {inv['invoice_no']} has no {', '.join(m.split(' (')[0] for m in missing)}",
                amount_impact=inv.get("taxable_value") or 0,
                period_effect="Overstated" if no_goods else "None",
                proposed_adjustment=reverse_invoice_adjustment(inv, f"Reverse {inv['invoice_no']}: no goods moved")
                if no_goods else [],
                event_seqs=seqs(*lineage_docs), document_ids=doc_ids(*lineage_docs),
                thresholds={"eway_bill_threshold": th["eway_bill_threshold"]},
                facts={"missing": missing, "customer": inv.get("customer_name")},
                reason=(f"Invoice {inv['invoice_no']} dated {inv.get('invoice_date')} for Rs "
                        f"{rupees(inv.get('taxable_value') or 0)} to {inv.get('customer_name')} has no "
                        f"{'; no '.join(missing)} in the system of record. "
                        + ("Nothing shows that goods left the premises, so the sale may not have occurred."
                           if no_goods else "The movement of goods is not fully evidenced."))))
        # Quantities: invoice against dispatch.
        if dispatch:
            inv_q, dsp_q = defaultdict(int), defaultdict(int)
            for it in inv.get("items") or []:
                inv_q[it.get("item")] += it.get("qty") or 0
            for it in dispatch.get("items") or []:
                dsp_q[it.get("item")] += it.get("qty") or 0
            diffs = [f"{k}: invoiced {inv_q.get(k, 0)}, dispatched {dsp_q.get(k, 0)}"
                     for k in sorted(set(inv_q) | set(dsp_q)) if inv_q.get(k, 0) != dsp_q.get(k, 0)]
            if diffs:
                short = sum(max(0, inv_q[k] - dsp_q.get(k, 0)) * next(
                    (it.get("rate") or 0 for it in inv.get("items") or [] if it.get("item") == k), 0) for k in inv_q)
                out.append(ctx.finding(
                    category="NO_MOVEMENT", subtype="QTY_MISMATCH", subject_type="invoice",
                    subject_id=inv["invoice_no"], subject_label=inv.get("customer_name"), related_party=rel,
                    title=f"Invoice {inv['invoice_no']} quantities differ from the dispatch",
                    amount_impact=short, period_effect="Overstated" if short else "None",
                    event_seqs=seqs(inv, dispatch), document_ids=doc_ids(inv, dispatch),
                    facts={"differences": diffs},
                    reason=f"Invoice {inv['invoice_no']} and dispatch {dispatch.get('dispatch_id')} disagree: "
                           + "; ".join(diffs) + "."))
        # Contradictions between linked documents.
        contra = []
        if dispatch:
            vehicle = (dispatch.get("vehicle_no") or "").replace(" ", "").upper()
            for lr in lrs:
                lv = (lr.get("vehicle_no") or "").replace(" ", "").upper()
                if vehicle and lv and lv != vehicle:
                    contra.append(f"LR {lr.get('lr_no')} vehicle {lv} differs from dispatch vehicle {vehicle}")
            for e in ewbs:
                ev = (e.get("vehicle_no") or "").replace(" ", "").upper()
                if vehicle and ev and ev != vehicle:
                    contra.append(f"e-way bill {e.get('ewb_no')} vehicle {ev} differs from dispatch vehicle {vehicle}")
            if delivery and delivery.get("delivered_at") and dispatch.get("dispatched_at") and \
                    delivery["delivered_at"] < dispatch["dispatched_at"]:
                contra.append(f"delivered {delivery['delivered_at']} before dispatch {dispatch['dispatched_at']}")
            if order and order.get("customer_id") != inv.get("customer_id"):
                contra.append(f"order customer {order.get('customer_id')} differs from invoice customer "
                              f"{inv.get('customer_id')}")
        if contra:
            out.append(ctx.finding(
                category="NO_MOVEMENT", subtype="CONTRADICTION", subject_type="invoice",
                subject_id=inv["invoice_no"], subject_label=inv.get("customer_name"), related_party=rel,
                title=f"Movement documents for {inv['invoice_no']} contradict each other",
                amount_impact=inv.get("taxable_value") or 0, period_effect="None",
                event_seqs=seqs(*lineage_docs), document_ids=doc_ids(*lineage_docs),
                facts={"contradictions": contra},
                reason=f"For invoice {inv['invoice_no']}: " + "; ".join(contra) + "."))
    return out
