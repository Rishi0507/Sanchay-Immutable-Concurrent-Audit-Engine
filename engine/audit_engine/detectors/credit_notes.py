"""D-11 Credit notes, especially those issued after the period end (SA 560, CGST Act s.34)."""

from __future__ import annotations

from ..findings import adjustment
from ..money import rupees
from ..snapshot import d


def in_scope_credit_notes(ctx) -> list[dict]:
    """Credit notes dated in the period, or after it against an invoice of the period."""
    out = []
    for cn in ctx.snap.credit_notes:
        if cn["_reversed"] or not ctx.in_scope(cn):
            continue
        cdate = d(cn.get("date"))
        if cdate is None or cdate < ctx.start:
            continue
        invs = ctx.snap.invoices_by_no.get(str(cn.get("original_invoice_no")), [])
        inv = invs[0] if invs else None
        idate = d((inv or {}).get("invoice_date"))
        if cdate <= ctx.end or (idate and ctx.in_period(idate)):
            out.append(cn)
    return sorted(out, key=lambda c: (c.get("date") or "", str(c.get("credit_note_no"))))


def detect(ctx) -> list[dict]:
    th = ctx.th["d11"]
    out = []
    end_window = ctx.end.toordinal() - th["period_end_days"]
    for cn in in_scope_credit_notes(ctx):
        no = str(cn.get("credit_note_no"))
        cdate = d(cn.get("date"))
        invs = ctx.snap.invoices_by_no.get(str(cn.get("original_invoice_no")), [])
        inv = invs[0] if invs else None
        idate = d((inv or {}).get("invoice_date"))
        returns = ctx.snap.returns_by_cn.get(no, [])
        rel = ctx.is_related(cn.get("customer_id"), cdate)
        taxable = cn.get("taxable_value") or 0
        cust = ctx.snap.customer(cn.get("customer_id"))
        name = cust.name if cust else cn.get("customer_id")
        base = dict(subject_type="credit_note", subject_id=no, subject_label=name, related_party=bool(rel),
                    event_seqs=[cn["_seq"]] + ([inv["_seq"]] if inv else []) + [r["_seq"] for r in returns],
                    document_ids=[no, str(cn.get("original_invoice_no"))])
        facts = {"credit_note_no": no, "date": cn.get("date"), "original_invoice_no": cn.get("original_invoice_no"),
                 "invoice_date": (inv or {}).get("invoice_date"), "reason_given": cn.get("reason"),
                 "approver": cn.get("approver"), "taxable": taxable,
                 "return_inward": returns[0].get("inward_date") if returns else None}
        checks = []
        if cdate > ctx.end and idate and ctx.in_period(idate):
            checks.append(("POST_PERIOD", "Overstated",
                           f"Credit note {no} dated {cdate} reduces invoice {cn.get('original_invoice_no')} of "
                           f"{idate}, inside the period. If the reason existed at {ctx.end}, period revenue is "
                           f"overstated by Rs {rupees(taxable)} (SA 560)."))
        if not returns:
            checks.append(("NO_RETURN", "None",
                           f"Credit note {no} for Rs {rupees(taxable)} ({cn.get('reason') or 'no reason'}) has no "
                           f"sales return recorded, so no goods came back."))
        if rel:
            checks.append(("RELATED_PARTY", "None",
                           f"Credit note {no} for Rs {rupees(taxable)} is to {name}, a {rel} related party."))
        if not (cn.get("approver") or "").strip():
            checks.append(("NO_APPROVER", "None", f"Credit note {no} for Rs {rupees(taxable)} has no approver."))
        if inv and idate and idate.toordinal() > end_window and ctx.in_period(idate):
            share = taxable * 10000 // max(inv.get("taxable_value") or 1, 1)
            if share >= th["most_of_invoice_bp"]:
                checks.append(("MOST_OF_PERIOD_END_INVOICE", "Overstated" if cdate > ctx.end else "None",
                               f"Credit note {no} reverses {share / 100:.1f} percent of invoice "
                               f"{inv['invoice_no']} dated {idate}, in the last {th['period_end_days']} days of "
                               f"the period."))
        for sub, effect, text in checks:
            adj = adjustment([("4100", taxable, 0), ("1100", 0, taxable)],
                             f"Provide for credit note {no} in the period") if effect == "Overstated" else []
            out.append(ctx.finding(category="CREDIT_NOTE", subtype=sub, title=text.split(". ")[0][:140],
                                   amount_impact=taxable, period_effect=effect, proposed_adjustment=adj,
                                   facts=dict(facts, check=sub), reason=text,
                                   thresholds={"period_end_days": th["period_end_days"],
                                               "most_of_invoice_bp": th["most_of_invoice_bp"]}, **base))
    return out
