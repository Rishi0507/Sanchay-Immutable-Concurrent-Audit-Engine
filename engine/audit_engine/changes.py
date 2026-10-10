"""Change detection after testing begins (PRD 16.3, detector D-15)."""

from __future__ import annotations

import datetime as dt
import re

from .repo import change_matches, evidence_results, sample_tests, samples
from .snapshot import _doc, d

WATCHED = ("DocumentReversed", "CreditNoteIssued", "SalesReturnRecorded", "CustomerUpdated", "JournalPosted",
           "DispatchRecorded", "EWayBillGenerated", "LorryReceiptRecorded", "DeliveryRecorded", "ReceiptRecorded",
           "InvoiceIssued", "SalesRegisterUploaded", "RelatedPartyListUploaded", "EvidenceUploaded", "Gstr1Filed")


def _index(ctx) -> dict:
    rows = ctx.engine.repo.select(samples, order_by=samples.c.sample_id, engagement_id=ctx.eid)
    by_sale, by_invoice, by_cust, by_cn, by_agg = {}, {}, {}, {}, {}
    for s in rows:
        data = s["data"] or {}
        sid = s["sample_id"]
        if data.get("sale_id"):
            by_sale.setdefault(data["sale_id"], set()).add(sid)
        if data.get("aggregate_id"):
            by_agg.setdefault(data["aggregate_id"], set()).add(sid)
        if s["subject_type"] in ("invoice", "register_row"):
            by_invoice.setdefault(str(s["subject_id"]), set()).add(sid)
        if s["subject_type"] == "credit_note":
            by_cn.setdefault(str(s["subject_id"]), set()).add(sid)
            if data.get("original_bill_no"):
                by_invoice.setdefault(str(data["original_bill_no"]), set()).add(sid)
        if data.get("customer_id"):
            by_cust.setdefault(data["customer_id"], set()).add(sid)
    return {"rows": rows, "sale": by_sale, "invoice": by_invoice, "customer": by_cust, "cn": by_cn, "agg": by_agg}


def match(ctx, ev: dict, idx: dict) -> tuple[set[str], str] | None:
    """Return (affected sample ids, explanation) or None when the event does not touch testing."""
    t, p = ev["event_type"], ev.get("payload") or {}
    snap_date = ctx.snapshot_date
    bdate = d(ev.get("business_date"))
    if t == "DocumentReversed":
        target = p.get("target_aggregate_id")
        doc = ctx.snap.by_aggregate.get(target)
        hit = set(idx["agg"].get(target, set()))
        if doc and doc.get("_sale_id"):
            hit |= idx["sale"].get(doc["_sale_id"], set())
        if doc and doc.get("credit_note_no"):
            hit |= idx["cn"].get(str(doc["credit_note_no"]), set())
        if hit:
            return hit, f"reverses {target} ({(doc or {}).get('invoice_no') or (doc or {}).get('credit_note_no') or ''}): {p.get('reason')}"
        return None
    if t == "CreditNoteIssued":
        hit = idx["invoice"].get(str(p.get("original_invoice_no")), set())
        return (hit, f"credit note {p.get('credit_note_no')} against sampled invoice {p.get('original_invoice_no')}") if hit else None
    if t == "SalesReturnRecorded":
        cn = next((c for c in ctx.snap.credit_notes if str(c.get("credit_note_no")) == str(p.get("credit_note_no"))), None)
        hit = set(idx["cn"].get(str(p.get("credit_note_no")), set()))
        if cn:
            hit |= idx["invoice"].get(str(cn.get("original_invoice_no")), set())
        return (hit, f"sales return against {p.get('credit_note_no')}") if hit else None
    if t == "CustomerUpdated":
        hit = idx["customer"].get(p.get("customer_id"), set())
        fields = ", ".join(sorted((p.get("changes") or {}).keys()))
        return (hit, f"customer {p.get('customer_id')} master changed ({fields})") if hit else None
    if t == "JournalPosted":
        lines = p.get("lines") or []
        touches = [l for l in lines if str(l.get("account")) in ("4000", "1100")]
        if not touches:
            return None
        text = " ".join([p.get("narration") or ""] + [str(l.get("ref") or "") for l in lines])
        hit = set()
        for no, sids in idx["invoice"].items():
            if no and re.search(re.escape(no), text):
                hit |= sids
        in_period = bdate and ctx.in_period(bdate)
        if hit or in_period:
            return hit, (f"journal {p.get('journal_id')} posts to {'/'.join(sorted({str(l['account']) for l in touches}))}"
                         f"{' dated in the audited period' if in_period else ''}: {p.get('narration')}")
        return None
    if t in ("DispatchRecorded", "EWayBillGenerated", "LorryReceiptRecorded", "DeliveryRecorded", "ReceiptRecorded"):
        hit = idx["sale"].get(ev.get("sale_id"), set()) if ev.get("sale_id") else set()
        if hit and bdate and bdate <= snap_date:
            return hit, f"{t} for a sampled sale, dated {bdate}, on or before the snapshot date {snap_date}"
        return None
    if t == "InvoiceIssued":
        if bdate and ctx.in_period(bdate):
            return idx["invoice"].get(str(p.get("invoice_no")), set()), \
                f"invoice {p.get('invoice_no')} dated {bdate}, inside the audited period, added after testing began"
        return None
    if t in ("SalesRegisterUploaded", "RelatedPartyListUploaded"):
        kind = "register" if t == "SalesRegisterUploaded" else "related-party list"
        used = ctx.eng["register_upload_seq"] if t == "SalesRegisterUploaded" else ctx.eng["rp_upload_seq"]
        used_ev = ctx.snap.events_by_seq.get(used) or {}
        old = (used_ev.get("payload") or {}).get("file_hash")
        same = old == p.get("file_hash")
        return set(), (f"new {kind} uploaded ({p.get('file_name')}); "
                       + ("identical to the version tested" if same else
                          f"differs from the version tested ({(old or '')[:12]} vs {(p.get('file_hash') or '')[:12]})"))
    if t == "EvidenceUploaded":
        prior = [r for r in idx["evidence_results"]
                 if r["request_id"] == p.get("request_id") and r["upload_seq"] < ev["seq"]]
        if prior:
            return {p.get("sample_id")}, f"evidence for {p.get('request_id')} replaced after it was verified (E-8)"
        return None
    if t == "Gstr1Filed":
        period = d((p.get("return_period") or "") + "-01")
        if period and ctx.in_period(period):
            return set(), f"GSTR-1 for {p.get('return_period')}, inside the audited period, filed or revised after testing began"
        return None
    return None


def check_post_testing_changes(ctx) -> dict:
    repo = ctx.engine.repo
    done = {r["seq"] for r in repo.select(change_matches, engagement_id=ctx.eid)}
    idx = _index(ctx)
    idx["evidence_results"] = repo.select(evidence_results, engagement_id=ctx.eid)
    all_f = repo.findings(ctx.eid)
    by_doc = {}
    for f in all_f:
        for k in {f["subject"]["id"].split("#")[0]} | set(f["lineage"]["document_ids"]):
            by_doc.setdefault(k, set()).add(f["finding_id"])
    sample_docs = {s["sample_id"]: str(s["subject_id"]) for s in idx["rows"]}
    examined, matches, findings, new_tests, new_rows = 0, [], [], [], []
    latest = repo.latest_tests(ctx.eid)
    for ev in ctx.engine.business.events(after_seq=ctx.eng["snapshot_seq"], types=WATCHED):
        examined += 1
        if ev["seq"] in done:
            continue
        m = match(ctx, ev, idx)
        if m is None:
            continue  # not persisted: it may match once samples exist
        hit, why = m
        affected_findings = sorted({fid for sid in hit for fid in by_doc.get(sample_docs.get(sid, ""), set())})
        ident = ev.get("identity") or {}
        doc = _doc(ev)
        f = ctx.finding(
            category="POST_TESTING_CHANGE", subtype=ev["event_type"].upper(), subject_type="event",
            subject_id=str(ev["seq"]), subject_label=ev["event_type"], amount_impact=_amount(ev),
            title=f"{ev['event_type']} by {ident.get('user')} after testing began: {why}"[:180],
            event_seqs=[ev["seq"]], document_ids=[ev["aggregate_id"]] + [sample_docs.get(s, "") for s in hit],
            sample_ids=sorted(hit),
            facts={"seq": ev["seq"], "event_type": ev["event_type"], "identity": ident, "recorded_at": ev["recorded_at"],
                   "business_date": ev["business_date"], "affected_samples": sorted(hit),
                   "affected_findings": affected_findings, "snapshot_seq": ctx.eng["snapshot_seq"]},
            reason=(f"Event {ev['seq']} ({ev['event_type']}) was appended by {ident.get('user')} ({ident.get('role')}) "
                    f"at {ev['recorded_at']}, after the snapshot at sequence {ctx.eng['snapshot_seq']}: {why}. "
                    + (f"Samples affected: {', '.join(sorted(hit))}; their tests revert to Pending evidence. "
                       if hit else "No sample is directly affected. ")
                    + (f"Findings affected: {', '.join(affected_findings)}." if affected_findings else "")))
        findings.append(f)
        matches.append({"seq": ev["seq"], "event_type": ev["event_type"], "identity": ident, "sample_ids": sorted(hit),
                        "finding_ids": [f["finding_id"]] + affected_findings, "why": why})
        for sid in sorted(hit):
            prev = (latest.get(sid) or {}).get("tests") or {}
            tests = {k: "Pending evidence" for k in (prev or {"Evidence": None})}
            flags = list((latest.get(sid) or {}).get("flags") or []) + [
                {"check": "CH-2", "result": "changed", "detail": f"Changed after testing: event {ev['seq']} {why}"}]
            new_tests.append({"sample_id": sid, "engagement_id": ctx.eid, "tests": tests, "flags": flags,
                              "cause": f"post_testing_change:{ev['seq']}",
                              "at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")})
            latest[sid] = new_tests[-1]
        new_rows.append({"engagement_id": ctx.eid, "seq": ev["seq"], "detail": {
            "matched": True, "finding": f["finding_id"], "event_type": ev["event_type"],
            "identity_user": ident.get("user"), "recorded_at": ev["recorded_at"], "sample_ids": sorted(hit),
            "finding_ids": [f["finding_id"]] + affected_findings, "why": why}})
    ctx.engine.save_findings(findings)
    repo.insert(sample_tests, new_tests)
    repo.insert(change_matches, new_rows)
    changed = sorted({sid for m in matches for sid in m["sample_ids"]})
    head = ctx.engine.business.head()[0]
    return {"events_examined": examined, "new_matches": matches, "findings_raised": len(findings),
            "samples_changed_after_testing": changed, "head_seq": head}


def _amount(ev: dict) -> int:
    p = ev.get("payload") or {}
    for k in ("taxable_value", "amount", "gross"):
        if isinstance(p.get(k), int):
            return p[k]
    if ev["event_type"] == "JournalPosted":
        return sum(int(l.get("credit") or 0) for l in p.get("lines") or [] if str(l.get("account")) == "4000")
    return 0


def changed_samples(ctx) -> dict[str, list[str]]:
    """Sample id -> change descriptions, for the workpaper and memo."""
    out = {}
    for sid, row in ctx.engine.repo.latest_tests(ctx.eid).items():
        notes = [f["detail"] for f in (row.get("flags") or []) if f.get("check") == "CH-2"]
        if notes:
            out[sid] = notes
    return out
