"""D-09 Revenue entries that did not originate from a sale."""

from __future__ import annotations

from collections import defaultdict

from ..findings import adjustment
from ..money import rupees


def detect(ctx) -> list[dict]:
    snap = ctx.snap
    by_seq = defaultdict(list)
    for po in snap.postings:
        if ctx.entities and po["entity_id"] not in ctx.entities:
            continue
        if not ctx.in_period(po["business_date"]):
            continue
        by_seq[po["seq"]].append(po)
    out = []
    for seq, lines in sorted(by_seq.items()):
        sales_credit = sum(p["credit"] - p["debit"] for p in lines if p["account"] == "4000")
        if sales_credit <= 0:
            continue
        ev = snap.events_by_seq[seq]
        src = lines[0]["source_event_type"]
        debit_accounts = sorted({p["account"] for p in lines if p["debit"] > 0})
        reasons = []
        if src != "InvoiceIssued":
            reasons.append(f"source is {src}, not InvoiceIssued")
        if not lines[0]["sale_id"]:
            reasons.append("no sale_id")
        if src == "InvoiceIssued" and any(a != "1100" for a in debit_accounts if a != "4900"):
            reasons.append(f"debit to {', '.join(debit_accounts)} rather than Trade Receivables (1100)")
        if not reasons:
            continue
        payload = ev.get("payload") or {}
        subject = payload.get("journal_id") or payload.get("invoice_no") or ev.get("aggregate_id")
        kind = "journal" if src == "JournalPosted" else "event"
        sub = {"9000": "CREDIT_FROM_SUSPENSE", "1000": "CREDIT_FROM_BANK", "1100": "MANUAL_RECEIVABLE"}.get(
            debit_accounts[0] if len(debit_accounts) == 1 else "", "NON_INVOICE_CREDIT")
        reverse = [(p["account"], 0, p["debit"]) for p in lines if p["debit"] > 0 and p["account"] != "4000"]
        adj = adjustment([("4000", sales_credit, 0)] + reverse, f"Reverse {subject}: revenue not from a sale")
        narration = payload.get("narration")
        out.append(ctx.finding(
            category="NON_SALE_REVENUE", subtype=sub, subject_type=kind, subject_id=str(subject),
            subject_label=narration, amount_impact=sales_credit, period_effect="Overstated", proposed_adjustment=adj,
            title=f"Sales credited Rs {rupees(sales_credit)} by {src} {subject}", event_seqs=[seq],
            document_ids=[str(subject)],
            facts={"source_event_type": src, "debit_accounts": debit_accounts, "narration": narration,
                   "approver": payload.get("approver"), "checks": reasons, "business_date": lines[0]["business_date"]},
            reason=(f"{src} {subject} dated {lines[0]['business_date']} credits Sales Revenue (4000) by "
                    f"Rs {rupees(sales_credit)}: {'; '.join(reasons)}."
                    + (f" Narration: \"{narration}\"." if narration else "")
                    + (" No approver is recorded." if src == "JournalPosted" and not payload.get("approver") else ""))))
    return out
