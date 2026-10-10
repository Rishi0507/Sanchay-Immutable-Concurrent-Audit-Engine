"""D-08 Inconsistencies across statutory documents and tax filings."""

from __future__ import annotations

from collections import defaultdict

from .. import gstin as gst
from ..money import rupees
from ..snapshot import d
from .common import doc_ids, ewbs_of, inv_date, period_invoices, related, seqs


def tax_base(inv: dict) -> int:
    return sum(inv.get(k) or 0 for k in ("taxable_value", "packing", "freight", "insurance"))


def detect(ctx) -> list[dict]:
    snap = ctx.snap
    out = []
    invoices = period_invoices(ctx)
    filed_periods = {ln["return_period"] for ln in snap.gstr1_lines if ctx.in_scope(ln)}
    filed_periods |= {f.get("return_period") for f in snap.gstr1_filings if ctx.in_scope(f)}
    bad_gstins: dict[tuple[str, str], list[dict]] = defaultdict(list)

    for inv in invoices:
        rel = related(ctx, inv)
        no = inv["invoice_no"]
        g = inv.get("customer_gstin")
        errs = gst.structure_errors(g)
        if errs:
            bad_gstins[(inv.get("customer_id"), gst.normalise(g) or "")].append(inv)
        own = ctx.snap.company_state(inv.get("_entity_id"))
        pos = str(inv.get("place_of_supply") or gst.state_of(g) or "")
        if own and pos:
            intra = pos == own
            if intra and (inv.get("igst") or 0) > 0:
                problem = f"IGST of Rs {rupees(inv['igst'])} charged although supplier state {own} equals place of supply {pos}"
            elif not intra and ((inv.get("cgst") or 0) + (inv.get("sgst") or 0)) > 0:
                problem = (f"CGST and SGST of Rs {rupees((inv.get('cgst') or 0) + (inv.get('sgst') or 0))} charged "
                           f"although supplier state {own} differs from place of supply {pos}")
            else:
                problem = None
            if problem:
                tax = (inv.get("igst") or 0) + (inv.get("cgst") or 0) + (inv.get("sgst") or 0)
                out.append(ctx.finding(
                    category="DOC_TAX_MISMATCH", subtype="WRONG_TAX_TYPE", subject_type="invoice", subject_id=no,
                    subject_label=inv.get("customer_name"), related_party=rel, amount_impact=tax,
                    title=f"Invoice {no}: wrong tax type for the place of supply", event_seqs=[inv["_seq"]],
                    document_ids=[no], facts={"supplier_state": own, "place_of_supply": pos},
                    reason=f"Invoice {no}: {problem} (IGST Act s.10)."))
        if not inv.get("irn"):
            out.append(ctx.finding(
                category="DOC_TAX_MISMATCH", subtype="E_INVOICE_MISSING", subject_type="invoice", subject_id=no,
                subject_label=inv.get("customer_name"), related_party=rel,
                amount_impact=inv.get("taxable_value") or 0, title=f"Invoice {no} has no IRN",
                event_seqs=[inv["_seq"]], document_ids=[no], facts={},
                reason=f"Invoice {no} to a registered customer carries no invoice reference number (CGST Rules r.48)."))
        period = (inv.get("invoice_date") or "")[:7]
        lines = snap.gstr1_by_invoice.get(str(no), [])
        if not lines:
            if period in filed_periods:
                out.append(ctx.finding(
                    category="DOC_TAX_MISMATCH", subtype="MISSING_IN_GSTR1", subject_type="invoice", subject_id=no,
                    subject_label=inv.get("customer_name"), related_party=rel,
                    amount_impact=inv.get("taxable_value") or 0,
                    title=f"Invoice {no} is not reported in GSTR-1 for {period}", event_seqs=[inv["_seq"]],
                    document_ids=[no], facts={"return_period": period, "tax_base": tax_base(inv)},
                    reason=(f"GSTR-1 for {period} is filed but does not include invoice {no} "
                            f"(tax base Rs {rupees(tax_base(inv))}, CGST Act s.37).")))
        else:
            ln = lines[0]
            diffs = []
            if abs((ln.get("taxable_value") or 0) - tax_base(inv)) > 100:
                diffs.append(f"taxable value GSTR-1 Rs {rupees(ln.get('taxable_value') or 0)} vs invoice "
                             f"Rs {rupees(tax_base(inv))}")
            for k in ("cgst", "sgst", "igst"):
                if abs((ln.get(k) or 0) - (inv.get(k) or 0)) > 100:
                    diffs.append(f"{k.upper()} GSTR-1 Rs {rupees(ln.get(k) or 0)} vs invoice Rs {rupees(inv.get(k) or 0)}")
            if gst.normalise(ln.get("gstin")) != gst.normalise(g):
                diffs.append(f"GSTIN GSTR-1 {ln.get('gstin')} vs invoice {g}")
            if str(ln.get("place_of_supply") or "") != pos:
                diffs.append(f"place of supply GSTR-1 {ln.get('place_of_supply')} vs invoice {pos}")
            if ln.get("invoice_date") != inv.get("invoice_date"):
                diffs.append(f"date GSTR-1 {ln.get('invoice_date')} vs invoice {inv.get('invoice_date')}")
            if len(lines) > 1:
                diffs.append(f"reported {len(lines)} times in GSTR-1")
            if diffs:
                out.append(ctx.finding(
                    category="DOC_TAX_MISMATCH", subtype="GSTR1_VALUE", subject_type="invoice", subject_id=no,
                    subject_label=inv.get("customer_name"), related_party=rel,
                    amount_impact=abs((ln.get("taxable_value") or 0) - tax_base(inv)),
                    title=f"GSTR-1 line for {no} differs from the invoice", event_seqs=[inv["_seq"], ln["_seq"]],
                    document_ids=[no], facts={"differences": diffs, "return_period": ln.get("return_period")},
                    reason=f"Invoice {no} and its GSTR-1 line for {ln.get('return_period')} differ: " + "; ".join(diffs) + "."))
        dispatch = snap.dispatch_for_invoice(inv)
        for e in ewbs_of(ctx, inv, dispatch):
            if str(e.get("invoice_no")) != str(no) and not (inv.get("_sale_id") and e.get("_sale_id") == inv["_sale_id"]):
                continue
            diffs = []
            if abs((e.get("value") or 0) - (inv.get("gross") or 0)) > 100 and str(e.get("invoice_no")) == str(no):
                diffs.append(f"value e-way bill Rs {rupees(e.get('value') or 0)} vs invoice Rs {rupees(inv.get('gross') or 0)}")
            if e.get("recipient_gstin") and gst.normalise(e.get("recipient_gstin")) != gst.normalise(g):
                diffs.append(f"recipient GSTIN e-way bill {e.get('recipient_gstin')} vs invoice {g}")
            own_g = snap.company_gstin(inv.get("_entity_id"))
            if own_g and e.get("supplier_gstin") and gst.normalise(e["supplier_gstin"]) != own_g:
                diffs.append(f"supplier GSTIN e-way bill {e.get('supplier_gstin')} vs company {own_g}")
            if diffs:
                out.append(ctx.finding(
                    category="DOC_TAX_MISMATCH", subtype="EWAY_BILL_MISMATCH", subject_type="invoice",
                    subject_id=f"{no}#{e.get('ewb_no')}", subject_label=inv.get("customer_name"), related_party=rel,
                    amount_impact=abs((e.get("value") or 0) - (inv.get("gross") or 0)),
                    title=f"E-way bill {e.get('ewb_no')} differs from invoice {no}",
                    event_seqs=seqs(inv, e), document_ids=[no, e.get("ewb_no")], facts={"differences": diffs},
                    reason=f"E-way bill {e.get('ewb_no')} and invoice {no} differ: " + "; ".join(diffs)
                           + " (CGST Rules r.138)."))

    for (cid, g), invs in sorted(bad_gstins.items()):
        errs = gst.structure_errors(g)
        out.append(ctx.finding(
            category="DOC_TAX_MISMATCH", subtype="INVALID_GSTIN", subject_type="customer", subject_id=cid or g,
            subject_label=invs[0].get("customer_name"), related_party=related(ctx, invs[0]),
            amount_impact=sum(i.get("taxable_value") or 0 for i in invs),
            title=f"Customer GSTIN {g or '(blank)'} is not structurally valid",
            event_seqs=[i["_seq"] for i in invs], document_ids=[i["invoice_no"] for i in invs] + [cid or ""],
            facts={"gstin": g, "errors": errs, "invoices": len(invs)},
            reason=(f"GSTIN {g or '(blank)'} used on {len(invs)} invoice(s) to {invs[0].get('customer_name')} fails "
                    f"validation: {'; '.join(errs)}. Input tax credit for the customer and the GSTR-1 return are "
                    f"at risk (CGST Act s.31).")))

    # GSTR-1 lines with no invoice, and period totals against the ledger.
    numbers = {str(i.get("invoice_no")) for i in snap.invoices}
    reported = defaultdict(lambda: [0, 0])
    for ln in snap.gstr1_lines:
        if not ctx.in_scope(ln) or not ctx.in_period(d((ln.get("return_period") or "") + "-01")):
            continue
        reported[ln["return_period"]][0] += ln.get("taxable_value") or 0
        reported[ln["return_period"]][1] += sum(ln.get(k) or 0 for k in ("cgst", "sgst", "igst"))
        if str(ln.get("invoice_no")) not in numbers:
            out.append(ctx.finding(
                category="DOC_TAX_MISMATCH", subtype="GSTR1_WITHOUT_INVOICE", subject_type="gstr1_line",
                subject_id=str(ln.get("invoice_no")), amount_impact=ln.get("taxable_value") or 0,
                title=f"GSTR-1 {ln['return_period']} reports {ln.get('invoice_no')}, which is not in the system",
                event_seqs=[ln["_seq"]], document_ids=[str(ln.get("invoice_no"))],
                facts={"return_period": ln["return_period"], "gstin": ln.get("gstin")},
                reason=(f"GSTR-1 for {ln['return_period']} reports invoice {ln.get('invoice_no')} to {ln.get('gstin')} "
                        f"for Rs {rupees(ln.get('taxable_value') or 0)}, but no such invoice exists.")))
    ledger = defaultdict(lambda: [0, 0])
    for po in snap.postings:
        if ctx.entities and po["entity_id"] not in ctx.entities:
            continue
        if po["source_event_type"] not in ("InvoiceIssued", "DocumentReversed"):
            continue
        if po["source_event_type"] == "DocumentReversed":
            target = snap.events_by_seq[po["seq"]]["payload"].get("target_aggregate_id", "")
            tdoc = snap.by_aggregate.get(target)
            if not tdoc or tdoc["_event_type"] != "InvoiceIssued":
                continue
        period = (po["business_date"] or "")[:7]
        if po["account"] in ("4000", "4200"):
            ledger[period][0] += po["credit"] - po["debit"]
        elif po["account"] in ("2100", "2101", "2102"):
            ledger[period][1] += po["credit"] - po["debit"]
    for period in sorted(set(reported) | {p for p in ledger if p in filed_periods and ctx.in_period(d(p + "-01"))}):
        r_val, r_tax = reported.get(period, [0, 0])
        l_val, l_tax = ledger.get(period, [0, 0])
        if abs(r_val - l_val) > 100 or abs(r_tax - l_tax) > 100:
            out.append(ctx.finding(
                category="DOC_TAX_MISMATCH", subtype="GSTR1_TOTAL", subject_type="period", subject_id=period,
                amount_impact=abs(r_val - l_val), title=f"GSTR-1 total for {period} differs from the ledger",
                facts={"return_period": period, "gstr1_value": r_val, "ledger_value": l_val, "gstr1_tax": r_tax,
                       "ledger_tax": l_tax},
                reason=(f"GSTR-1 for {period} reports a taxable value of Rs {rupees(r_val)} and tax of "
                        f"Rs {rupees(r_tax)}. The ledger records Rs {rupees(l_val)} and Rs {rupees(l_tax)} from "
                        f"invoices dated in that month. Difference Rs {rupees(r_val - l_val)}.")))
    return out
