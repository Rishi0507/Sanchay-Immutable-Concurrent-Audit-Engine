"""D-13 Cash settlement: bank evidence, payer identity, round trips and unpaid period-end sales."""

from __future__ import annotations

import datetime as dt
from collections import defaultdict

from ..money import rupees
from ..related_parties import resolve
from ..snapshot import d, normalise_account
from .common import inv_date, period_invoices, related


def detect(ctx) -> list[dict]:
    snap, th = ctx.snap, ctx.th["d13"]
    out = []
    res = resolve(ctx)
    cluster_of = res["cluster_of"]
    covered = {(ln.get("date") or "")[:7] for ln in snap.bank_lines if ctx.in_scope(ln)}
    by_utr = defaultdict(list)
    by_amount = defaultdict(list)
    for ln in snap.bank_lines:
        if ln.get("direction") == "CR" and ctx.in_scope(ln):
            if ln.get("utr"):
                by_utr[ln["utr"]].append(ln)
            by_amount[ln.get("amount")].append(ln)
    in_period_nos = {str(i.get("invoice_no")) for i in period_invoices(ctx)}
    holder_of: dict[str, str] = {}
    for k, rec in sorted(res["records"].items()):
        for (kind, value) in rec.obs:
            if kind == "bank":
                holder_of.setdefault(value, k)
    payments_by_day = defaultdict(list)
    for p in snap.payments:
        if d(p.get("date")):
            payments_by_day[d(p.get("date"))].append(p)
    snap_date = ctx.snapshot_date

    receipts = [r for r in snap.receipts if ctx.in_scope(r)
                and (ctx.in_period(r.get("date")) or any(str(x) in in_period_nos for x in r.get("invoice_refs") or []))]
    for r in sorted(receipts, key=lambda x: (x.get("date") or "", x.get("receipt_id") or "")):
        cust = snap.customer(r.get("customer_id"))
        name = cust.name if cust else r.get("customer_id")
        refs = [str(x) for x in r.get("invoice_refs") or []]
        rdate = d(r.get("date"))
        rel = ctx.is_related(r.get("customer_id"), rdate) is not None
        base = dict(subject_type="invoice", subject_id=refs[0] if refs else r.get("receipt_id"), subject_label=name,
                    related_party=rel, event_seqs=[r["_seq"]], document_ids=refs + [r.get("receipt_id")])
        if (r.get("date") or "")[:7] in covered:
            match = by_utr.get(r.get("utr")) or [
                ln for ln in by_amount.get(r.get("amount"), [])
                if abs((d(ln.get("date")) - rdate).days) <= 3
                and normalise_account(ln.get("counterparty_account")) == normalise_account(r.get("payer_account"))]
            if not match:
                out.append(ctx.finding(
                    category="SETTLEMENT", subtype="NO_BANK_LINE", amount_impact=r.get("amount") or 0,
                    title=f"Receipt {r.get('receipt_id')} of Rs {rupees(r.get('amount') or 0)} is not on the bank statement",
                    facts={"receipt_id": r.get("receipt_id"), "utr": r.get("utr"), "date": r.get("date")},
                    reason=(f"Receipt {r.get('receipt_id')} dated {r.get('date')} for Rs {rupees(r.get('amount') or 0)} "
                            f"from {r.get('payer_name')} (UTR {r.get('utr')}) against {', '.join(refs)} has no "
                            f"matching credit on the imported bank statement for that month."), **base))
        own = set()
        if cust:
            for v in cust.versions:
                for b in v["state"].get("bank_accounts") or []:
                    own.add(normalise_account(b.get("account_no")))
        payer = normalise_account(r.get("payer_account"))
        if payer and payer not in own:
            holder = holder_of.get(payer)
            who = res["records"][holder].label if holder else "an unknown holder"
            out.append(ctx.finding(
                category="SETTLEMENT", subtype="THIRD_PARTY_PAYER", amount_impact=r.get("amount") or 0,
                title=f"{name} paid from an account that is not its own ({who})",
                facts={"receipt_id": r.get("receipt_id"), "payer_account": r.get("payer_account"),
                       "payer_name": r.get("payer_name"), "account_holder": who},
                reason=(f"Receipt {r.get('receipt_id')} of Rs {rupees(r.get('amount') or 0)} for {', '.join(refs)} "
                        f"came from account {r.get('payer_account')} in the name of {r.get('payer_name')}, held by "
                        f"{who}. The customer master lists no such account for {name}."), **base))
        # Receipt followed by a similar payment to a linked party within the window.
        ckey = f"C:{r.get('customer_id')}"
        payer_holder = holder_of.get(payer)
        linked = {cluster_of.get(ckey)} | ({cluster_of.get(payer_holder)} if payer_holder else set())
        nearby = [p for k in range(th["payment_window_days"] + 1) if rdate
                  for p in payments_by_day.get(rdate + dt.timedelta(days=k), [])]
        for p in nearby:
            pdate = d(p.get("date"))
            amt, pa = r.get("amount") or 0, p.get("amount") or 0
            if not amt or abs(pa - amt) * 10000 > amt * th["similar_amount_bp"]:
                continue
            vkey = f"V:{p.get('vendor_id')}"
            pholder = holder_of.get(normalise_account(p.get("payee_account")), vkey)
            if cluster_of.get(vkey) in linked or cluster_of.get(pholder) in linked:
                vend = snap.vendors.get(p.get("vendor_id"))
                out.append(ctx.finding(
                    category="SETTLEMENT", subtype="ROUND_TRIP_PAYMENT", amount_impact=amt,
                    title=f"Receipt from {name} followed by a payment of Rs {rupees(pa)} to a linked party",
                    facts={"receipt_id": r.get("receipt_id"), "payment_id": p.get("payment_id"),
                           "receipt_amount": amt, "payment_amount": pa, "days": (pdate - rdate).days,
                           "vendor": vend.name if vend else p.get("vendor_id")},
                    reason=(f"{name} paid Rs {rupees(amt)} on {rdate} ({r.get('receipt_id')}). "
                            f"{(pdate - rdate).days} day(s) later the company paid Rs {rupees(pa)} to "
                            f"{vend.name if vend else p.get('vendor_id')} ({p.get('payment_id')}), which shares "
                            f"identifiers with the customer. The money may have gone back where it came from."),
                    **dict(base, event_seqs=[r["_seq"], p["_seq"]], document_ids=base["document_ids"] + [p.get("payment_id")])))
    # Period-end invoices unpaid at the snapshot date.
    paid = defaultdict(int)
    for r in snap.receipts:
        refs = r.get("invoice_refs") or []
        for x in refs:
            paid[str(x)] += (r.get("amount") or 0) // max(len(refs), 1)
    credited = defaultdict(int)
    for cn in snap.credit_notes:
        if not cn["_reversed"]:
            credited[str(cn.get("original_invoice_no"))] += cn.get("gross") or 0
    window_start = ctx.end - dt.timedelta(days=th["period_end_days"] - 1)
    for inv in period_invoices(ctx):
        idate = inv_date(inv)
        if idate < window_start:
            continue
        age = (snap_date - idate).days
        outstanding = (inv.get("gross") or 0) - paid[str(inv["invoice_no"])] - credited[str(inv["invoice_no"])]
        if outstanding > 100 and age > th["unpaid_days"]:
            out.append(ctx.finding(
                category="SETTLEMENT", subtype="UNPAID_PERIOD_END", subject_type="invoice",
                subject_id=inv["invoice_no"], subject_label=inv.get("customer_name"), related_party=related(ctx, inv),
                amount_impact=outstanding, title=f"Period-end invoice {inv['invoice_no']} unpaid after {age} days",
                event_seqs=[inv["_seq"]], document_ids=[inv["invoice_no"]],
                thresholds={"unpaid_days": th["unpaid_days"], "period_end_days": th["period_end_days"]},
                facts={"invoice_date": inv.get("invoice_date"), "outstanding": outstanding, "age_days": age,
                       "snapshot_date": snap_date.isoformat()},
                reason=(f"Invoice {inv['invoice_no']} dated {idate}, in the last {th['period_end_days']} days of the "
                        f"period, still has Rs {rupees(outstanding)} outstanding at the snapshot date {snap_date}, "
                        f"{age} days later. A sale that is never collected may not have been a real sale.")))
    return out
