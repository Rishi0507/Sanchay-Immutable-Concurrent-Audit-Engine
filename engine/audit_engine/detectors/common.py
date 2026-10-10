"""Helpers shared by detectors. Detectors read the snapshot only (DT-1, DT-2)."""

from __future__ import annotations

import datetime as dt

from ..findings import adjustment
from ..snapshot import d, ts


def period_invoices(ctx) -> list[dict]:
    key = "period_invoices"
    if key not in ctx.cache:
        ctx.cache[key] = sorted(ctx.snap.invoices_in_period(ctx.start, ctx.end, ctx.entities),
                                key=lambda i: (str(i.get("invoice_no")), i["_seq"]))
    return ctx.cache[key]


def inv_date(inv: dict) -> dt.date | None:
    return d(inv.get("invoice_date")) or d(inv.get("_business_date"))


def related(ctx, inv: dict) -> bool:
    return ctx.is_related(inv.get("customer_id"), inv_date(inv)) is not None


def order_of(ctx, inv: dict) -> dict | None:
    oid = inv.get("order_id")
    return ctx.snap.orders.get(oid) if oid else None


def ewbs_of(ctx, inv: dict, dispatch: dict | None) -> list[dict]:
    found = list(ctx.snap.ewbs_by_invoice.get(str(inv.get("invoice_no")), []))
    if dispatch is not None:
        for e in ctx.snap.ewbs_by_dispatch.get(dispatch.get("dispatch_id"), []):
            if e not in found:
                found.append(e)
    return found


def control_date(ctx, inv: dict) -> tuple[dt.date | None, str]:
    """Transfer of control (D-06): dispatch for ex-works, delivery for delivered terms."""
    order = order_of(ctx, inv)
    dispatch = ctx.snap.dispatch_for_invoice(inv)
    delivery = ctx.snap.delivery_for_dispatch(dispatch.get("dispatch_id")) if dispatch else None
    terms = (order or {}).get("delivery_terms")
    if terms == "DELIVERED":
        if delivery:
            return d(delivery.get("delivered_at")), "delivery date (delivered terms)"
        return None, "delivered terms, no delivery record"
    if dispatch:
        return d(dispatch.get("dispatched_at")), "dispatch date (ex-works terms)" if terms else "dispatch date"
    if delivery:
        return d(delivery.get("delivered_at")), "delivery date"
    return None, "no dispatch or delivery"


def reverse_invoice_adjustment(inv: dict, narration: str) -> list[dict]:
    recov = (inv.get("packing") or 0) + (inv.get("freight") or 0) + (inv.get("insurance") or 0)
    return adjustment([("4000", inv.get("taxable_value") or 0, 0), ("4200", recov, 0), ("2100", inv.get("cgst") or 0, 0),
                       ("2101", inv.get("sgst") or 0, 0), ("2102", inv.get("igst") or 0, 0),
                       ("1100", 0, inv.get("gross") or 0)], narration)


def doc_ids(*docs) -> list[str]:
    out = []
    for doc in docs:
        if not doc:
            continue
        for k in ("invoice_no", "order_id", "dispatch_id", "ewb_no", "lr_no", "pod_ref", "credit_note_no",
                  "journal_id", "receipt_id", "payment_id", "purchase_id"):
            if doc.get(k):
                out.append(str(doc[k]))
    return out


def seqs(*docs) -> list[int]:
    return [doc["_seq"] for doc in docs if doc and "_seq" in doc]


__all__ = ["period_invoices", "inv_date", "related", "order_of", "ewbs_of", "control_date",
           "reverse_invoice_adjustment", "doc_ids", "seqs", "d", "ts", "adjustment"]
