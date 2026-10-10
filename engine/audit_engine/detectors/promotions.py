"""D-12 Promotions and discounts that drive demand."""

from __future__ import annotations

from ..money import rupees
from ..snapshot import d
from .common import inv_date, order_of, period_invoices, related


def detect(ctx) -> list[dict]:
    snap = ctx.snap
    out = []
    for inv in period_invoices(ctx):
        order = order_of(ctx, inv)
        items = (order or {}).get("items") or inv.get("items") or []
        scheme_id = (order or {}).get("scheme_id")
        approver = (order or {}).get("approver")
        day = d((order or {}).get("order_date")) or inv_date(inv)
        cust = inv.get("customer_id")
        no = inv["invoice_no"]
        rel = related(ctx, inv)
        max_bp = max((it.get("discount_bp") or 0 for it in items), default=0)
        discount = inv.get("discount") or 0
        issues = []
        if max_bp > 0 or discount > 0:
            promo = snap.promotions.get(scheme_id) if scheme_id else None
            if not scheme_id:
                issues.append(("NO_SCHEME", f"discount of {max_bp / 100:.1f} percent with no scheme", discount))
            elif promo is None:
                issues.append(("UNKNOWN_SCHEME", f"scheme {scheme_id} does not exist", discount))
            else:
                if max_bp > (promo.get("discount_bp") or 0):
                    excess = discount - discount * (promo.get("discount_bp") or 0) // max(max_bp, 1)
                    issues.append(("ABOVE_SCHEME", f"discount {max_bp / 100:.1f} percent above scheme {scheme_id} "
                                                   f"rate {(promo.get('discount_bp') or 0) / 100:.1f} percent", excess))
                vf, vt = d(promo.get("valid_from")), d(promo.get("valid_to"))
                if day and ((vf and day < vf) or (vt and day > vt)):
                    issues.append(("OUTSIDE_SCHEME_DATES", f"order dated {day} outside scheme {scheme_id} "
                                                           f"({promo.get('valid_from')} to {promo.get('valid_to')})",
                                   discount))
                elig = promo.get("eligible_customers")
                if elig is not None and cust not in elig:
                    issues.append(("INELIGIBLE_CUSTOMER", f"customer is not eligible for scheme {scheme_id}", discount))
        if day:
            below = []
            for it in items:
                lst = snap.price_on(it.get("item"), day)
                if lst and (it.get("rate") or 0) < lst:
                    below.append((it.get("item"), it.get("rate"), lst, (lst - it.get("rate")) * (it.get("qty") or 0)))
            if below and not (approver or "").strip():
                gap = sum(b[3] for b in below)
                text = ", ".join(f"{b[0]} at Rs {rupees(b[1])} against list Rs {rupees(b[2])}" for b in below)
                issues.append(("BELOW_PRICE_LIST", f"rate below the price list with no approver: {text}", gap))
        for sub, text, impact in issues:
            out.append(ctx.finding(
                category="PROMOTION_DISCOUNT", subtype=sub, subject_type="invoice", subject_id=no,
                subject_label=inv.get("customer_name"), related_party=rel, amount_impact=int(impact),
                title=f"Invoice {no}: {text}"[:160], event_seqs=[inv["_seq"]] + ([order["_seq"]] if order else []),
                document_ids=[no] + ([order["order_id"]] if order else []) + ([scheme_id] if scheme_id else []),
                facts={"scheme_id": scheme_id, "discount_bp": max_bp, "order_date": str(day) if day else None,
                       "approver": approver},
                reason=f"Invoice {no} to {inv.get('customer_name')} (order {(order or {}).get('order_id', 'none')}): "
                       f"{text}."))
    return out
