"""Evidence requests, status and verification (PRD 14.1, 14.3, detector D-10)."""

from __future__ import annotations

import datetime as dt
import math
from collections import defaultdict

from rapidfuzz.distance import JaroWinkler

from .. import gstin as gst
from ..money import rupees
from ..repo import evidence_requests, evidence_results, extraction_cache, sample_tests, samples
from ..sampling import overall
from ..snapshot import _doc, d, ts
from .extract import extract, perceptual_hash

EDIT_TOOLS = ("photoshop", "gimp", "sejda", "ilovepdf", "pdf editor", "pdfescape", "smallpdf", "canva", "phantompdf",
              "nitro pro", "pdf-xchange editor", "inkscape", "paint")


def uploads(ctx) -> list[dict]:
    """All EvidenceUploaded events, including those after the snapshot (evidence intake, EN-4)."""
    seen = {}
    for ev in ctx.engine.business.events(types=("EvidenceUploaded",)):
        seen[ev["seq"]] = _doc(ev)
    return sorted(seen.values(), key=lambda x: x["_seq"])


def _norm_name(s) -> str:
    import re

    return re.sub(r"[^a-z0-9]", "", str(s or "").lower())


def request_status(ctx, sample_id: str | None = None) -> list[dict]:
    reqs = ctx.engine.repo.select(evidence_requests, order_by=evidence_requests.c.request_id, engagement_id=ctx.eid)
    if sample_id:
        reqs = [r for r in reqs if r["sample_id"] == sample_id]
    ups = defaultdict(list)
    for u in uploads(ctx):
        if u.get("request_id"):
            ups[u["request_id"]].append(u)
        ups[(u.get("sample_id"), u.get("document_type"))].append(u)
    verified = defaultdict(set)
    for r in ctx.engine.repo.select(evidence_results, engagement_id=ctx.eid):
        verified[r["request_id"]].add(r["upload_seq"])
    out = []
    for r in reqs:
        u = ups.get(r["request_id"]) or ups.get((r["sample_id"], r["document_type"]), [])
        latest = u[-1] if u else None
        if not latest:
            status = "requested"
        elif latest["_seq"] in verified[r["request_id"]]:
            status = "verified"
        elif verified[r["request_id"]]:
            status = "replaced after verification"
        else:
            status = "uploaded"
        out.append({"request_id": r["request_id"], "sample_id": r["sample_id"], "document_type": r["document_type"],
                    "note": r["note"], "status": status, "file_hash": latest.get("file_hash") if latest else None,
                    "file_name": latest.get("file_name") if latest else None,
                    "upload_seq": latest["_seq"] if latest else None, "uploads": len(u)})
    return out


def evidence_status(ctx, sample_id: str | None = None) -> dict:
    rows = request_status(ctx, sample_id)
    counts = defaultdict(int)
    for r in rows:
        counts[r["status"]] += 1
    return {"requests": rows, "by_status": dict(counts)}


def request_evidence(ctx, sample_id: str, document_type: str, note: str = "") -> dict:
    from ..engine import EngineError

    s = ctx.engine.repo.first(samples, sample_id=sample_id)
    if not s or s["engagement_id"] != ctx.eid:
        raise EngineError("NOT_FOUND", f"Sample {sample_id} does not exist.", "Call get_evidence_status to list samples.")
    existing = [r for r in ctx.engine.repo.select(evidence_requests, engagement_id=ctx.eid, sample_id=sample_id)
                if r["document_type"] == document_type]
    import hashlib

    rid = "req_" + hashlib.sha256(f"{sample_id}|{document_type}|{len(existing)}".encode()).hexdigest()[:16]
    ctx.engine.repo.insert(evidence_requests, {
        "request_id": rid, "engagement_id": ctx.eid, "sample_id": sample_id, "document_type": document_type,
        "note": note or f"Follow-up request for {document_type}", "created_by": ctx.identity.get("user"),
        "created_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")})
    return {"request_id": rid, "notification": {"audience": "client", "kind": "evidence_requested", "count": 1}}


def _extract_cached(ctx, file_hash: str, doc_type: str) -> dict:
    repo = ctx.engine.repo
    hit = repo.first(extraction_cache, file_hash=file_hash, document_type=doc_type)
    if hit:
        return hit["result"]
    data = ctx.engine.files.get(file_hash)
    s = ctx.engine.settings
    res = extract(data, doc_type, s.ollama_url, s.ollama_model)
    res["phash"] = perceptual_hash(data)
    repo.insert(extraction_cache, {"file_hash": file_hash, "document_type": doc_type, "result": res})
    return res


def _v(ex: dict | None, field: str):
    if not ex:
        return None
    f = ex["fields"].get(field)
    return f["value"] if f else None


def verify_evidence(ctx, sample_id: str | None = None) -> dict:
    from ..engine import EngineError

    repo = ctx.engine.repo
    all_samples = repo.select(samples, order_by=samples.c.sample_id, engagement_id=ctx.eid)
    if not all_samples:
        raise EngineError("VALIDATION_FAILED", "No samples have been selected.",
                          "Call select_sales_tod, select_cutoff_tod or select_credit_note_tod first.")
    targets = [s for s in all_samples if not sample_id or s["sample_id"] == sample_id]
    if sample_id and not targets:
        raise EngineError("NOT_FOUND", f"Sample {sample_id} does not exist.", "Call get_evidence_status.")
    status = request_status(ctx)
    by_sample = defaultdict(list)
    for r in status:
        by_sample[r["sample_id"]].append(r)
    if sample_id and not any(r["upload_seq"] for r in by_sample[sample_id]):
        raise EngineError("EVIDENCE_PENDING", f"No evidence has been uploaded for {sample_id}.",
                          "Wait for the client to upload, or call request_evidence for a follow-up.")
    all_ups = uploads(ctx)
    hash_samples = defaultdict(set)
    text_samples = defaultdict(set)
    phashes = []
    for u in all_ups:
        hash_samples[u["file_hash"]].add(u["sample_id"])
    prior_results = defaultdict(list)
    for r in repo.select(evidence_results, order_by=evidence_results.c.id, engagement_id=ctx.eid):
        prior_results[r["request_id"]].append(r)
    latest_tests = repo.latest_tests(ctx.eid)
    req_meta = {r["request_id"]: r for r in repo.select(evidence_requests, engagement_id=ctx.eid)}
    th = ctx.th["evidence"]
    findings, results, new_results, new_tests = [], [], [], []
    extracted_all: dict[str, dict] = {}
    for r in status:
        if r["upload_seq"]:
            ex = _extract_cached(ctx, r["file_hash"], r["document_type"])
            extracted_all[r["request_id"]] = ex
            if ex.get("text_hash"):
                text_samples[ex["text_hash"]].add(r["sample_id"])
            if ex.get("phash"):
                phashes.append((ex["phash"], r["sample_id"], r["file_hash"]))

    sample_by_id = {x["sample_id"]: x for x in all_samples}
    for s in targets:
        sid = s["sample_id"]
        reqs = by_sample.get(sid, [])
        uploaded = [r for r in reqs if r["upload_seq"]]
        if not uploaded:
            results.append({"sample_id": sid, "status": "Pending evidence", "checks": []})
            continue
        if all(r["status"] == "verified" for r in uploaded):
            last = latest_tests.get(sid)
            results.append({"sample_id": sid, "status": overall(last["tests"]) if last else "Pass",
                            "checks": (last or {}).get("flags") or [], "already_verified": True})
            continue
        sor = _sor_for(ctx, s)
        docs = {r["document_type"]: (r, extracted_all.get(r["request_id"])) for r in uploaded}
        checks: list[dict] = []

        def fail(code: str, doc: str, text: str, impact: int = 0):
            checks.append({"check": code, "document": doc, "result": "fail", "detail": text, "impact": impact})

        low = []
        for doc, (req, ex) in docs.items():
            if ex is None:
                continue
            if ex["low_confidence"]:
                low.append(f"{doc}: {', '.join(ex['low_confidence'])}")
            # E-8: replaced after it had been verified.
            prev = prior_results.get(req["request_id"], [])
            if prev and prev[-1]["upload_seq"] != req["upload_seq"]:
                fail("E-8", doc, f"{doc.replace('_', ' ')} replaced after verification: file "
                                 f"{prev[-1]['file_hash'][:12]} (event {prev[-1]['upload_seq']}) replaced by "
                                 f"{req['file_hash'][:12]} (event {req['upload_seq']}).")
            # E-3: reused evidence.
            others = (hash_samples[req["file_hash"]] | text_samples.get(ex.get("text_hash"), set())) - {sid}
            if ex.get("phash"):
                import imagehash

                me = imagehash.hex_to_hash(ex["phash"])
                for ph, other_sid, fh in phashes:
                    if other_sid != sid and (me - imagehash.hex_to_hash(ph)) <= th["phash_max_distance"]:
                        others.add(other_sid)
            mine = _subject_key(s)
            others = {o for o in others if _subject_key(sample_by_id.get(o)) != mine}
            if others:
                fail("E-3", doc, f"{doc.replace('_', ' ')} file is also used as evidence for {', '.join(sorted(others))}.")
            # E-7: made to order.
            meta = ex.get("metadata") or {}
            producer = f"{meta.get('producer', '')} {meta.get('creator', '')}".lower()
            tool = next((t for t in EDIT_TOOLS if t in producer), None)
            created = meta.get("creation_date")
            requested = (req_meta.get(req["request_id"]) or {}).get("created_at")
            if tool:
                fail("E-7", doc, f"{doc.replace('_', ' ')} PDF was produced by an editing tool "
                                 f"({meta.get('producer') or meta.get('creator')}).")
            elif created and requested and created[:19] > requested[:19].replace("Z", ""):
                fail("E-7", doc, f"{doc.replace('_', ' ')} PDF was created on {created}, after the evidence request "
                                 f"of {requested}.")
        _content_checks(ctx, s, sor, docs, fail, th)
        tests = dict((latest_tests.get(sid) or {}).get("tests") or {})
        failed = {c["check"] for c in checks}
        missing = [r["document_type"] for r in reqs if not r["upload_seq"]]
        if failed:
            tests["Evidence"] = "Exception"
        elif low:
            tests["Evidence"] = "Needs human review"
        elif missing:
            tests["Evidence"] = "Pending evidence"
        else:
            tests["Evidence"] = "Pass"
        if failed & {"E-2", "E-4", "E-6"} and "Occurrence" in tests:
            tests["Occurrence"] = "Exception"
        if any(c["check"] == "E-1" and "amount" in c["detail"] for c in checks):
            tests["Amount"] = "Exception"
        if any(c["check"] == "E-1" and ("customer" in c["detail"] or "GSTIN" in c["detail"]) for c in checks):
            tests["Party"] = "Exception"
        flags = checks + ([{"check": "EV-4", "result": "review", "detail": "; ".join(low)}] if low else [])
        new_tests.append({"sample_id": sid, "engagement_id": ctx.eid, "tests": tests, "flags": flags,
                          "cause": "verify_evidence", "at": _now()})
        for doc, (req, ex) in docs.items():
            new_results.append({"engagement_id": ctx.eid, "request_id": req["request_id"], "sample_id": sid,
                                "upload_seq": req["upload_seq"], "file_hash": req["file_hash"],
                                "extracted": {k: v for k, v in (ex or {}).items() if k != "metadata"} | {
                                    "metadata": (ex or {}).get("metadata")},
                                "checks": [c for c in checks if c["document"] == doc], "at": _now()})
        subject_no = s["subject_id"]
        for c in checks:
            findings.append(ctx.finding(
                category="EVIDENCE_SUSPECT", subtype=c["check"].replace("-", "") + "_" + _CHECK_NAMES[c["check"]],
                subject_type="sample", subject_id=f"{sid}:{c['check']}:{c['document']}", subject_label=subject_no,
                amount_impact=c.get("impact") or (s["data"] or {}).get("taxable") or 0,
                title=f"{subject_no}: {c['detail']}"[:180],
                event_seqs=[docs[c["document"]][0]["upload_seq"]] + ([sor["_seq"]] if sor else []),
                document_ids=[subject_no] + ([str(sor.get("invoice_no"))] if sor and sor.get("invoice_no") else []),
                evidence_hashes=[docs[c["document"]][0]["file_hash"]], sample_ids=[sid],
                thresholds={k: th[k] for k in ("confidence_min", "phash_max_distance", "ewb_km_per_day", "max_speed_kmph")},
                facts={"check": c["check"], "document": c["document"], "sample_id": sid},
                reason=f"Sample {sid} ({subject_no}), {c['document'].replace('_', ' ')}: {c['detail']} (SA 500, SA 240)."))
        results.append({"sample_id": sid, "subject": subject_no, "status": overall(tests), "tests": tests,
                        "checks": flags})
    repo.insert(evidence_results, new_results)
    repo.insert(sample_tests, new_tests)
    ctx.engine.save_findings(findings)
    by = defaultdict(int)
    for r in results:
        by[r["status"]] += 1
    return {"results": results, "by_status": dict(by), "findings_raised": len(findings),
            "pending": [r["sample_id"] for r in results if r["status"] == "Pending evidence"]}


_CHECK_NAMES = {"E-1": "DISAGREES_WITH_RECORD", "E-2": "DOCUMENTS_DISAGREE", "E-3": "REUSED_EVIDENCE",
                "E-4": "OTHER_TRANSACTION", "E-5": "EWAY_BILL_VALIDITY", "E-6": "INFEASIBLE_DELIVERY",
                "E-7": "MADE_TO_ORDER", "E-8": "REPLACED_AFTER_VERIFICATION"}


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _subject_key(s: dict | None) -> str | None:
    """Two samples of the same transaction (for example Sales TOD and Cut-off TOD) may share documents."""
    if not s:
        return None
    return (s["data"] or {}).get("aggregate_id") or f"{s['subject_type']}:{s['subject_id']}"


def _sor_for(ctx, s: dict) -> dict | None:
    data = s["data"] or {}
    if s["subject_type"] == "credit_note":
        return next((c for c in ctx.snap.credit_notes if c["_aggregate_id"] == data.get("aggregate_id")), None)
    agg = data.get("aggregate_id")
    if agg:
        doc = ctx.snap.by_aggregate.get(agg)
        if doc and doc["_event_type"] == "InvoiceIssued":
            return doc
    invs = ctx.snap.invoices_by_no.get(str(s["subject_id"]), [])
    return invs[0] if invs else None


def _content_checks(ctx, s, sor, docs, fail, th) -> None:
    snap = ctx.snap
    tol = th["amount_tolerance"]
    inv_ex = (docs.get("invoice") or (None, None))[1]
    ewb_ex = (docs.get("eway_bill") or (None, None))[1]
    lr_ex = (docs.get("lr_copy") or (None, None))[1]
    cn_ex = (docs.get("credit_note") or (None, None))[1]
    ret_ex = (docs.get("sales_return") or (None, None))[1]
    if s["subject_type"] == "credit_note":
        if sor and cn_ex:
            if _v(cn_ex, "credit_note_no") and str(_v(cn_ex, "credit_note_no")).upper() != str(sor.get("credit_note_no")).upper():
                fail("E-1", "credit_note", f"credit note number on the copy {_v(cn_ex, 'credit_note_no')} differs from "
                                           f"{sor.get('credit_note_no')}")
            if _v(cn_ex, "taxable_value") is not None and abs(_v(cn_ex, "taxable_value") - (sor.get("taxable_value") or 0)) > tol:
                fail("E-1", "credit_note", f"amount on the copy Rs {rupees(_v(cn_ex, 'taxable_value'))} differs from "
                                           f"the system Rs {rupees(sor.get('taxable_value') or 0)}")
            if _v(cn_ex, "original_invoice_no") and str(_v(cn_ex, "original_invoice_no")).upper() != str(sor.get("original_invoice_no")).upper():
                fail("E-1", "credit_note", f"original invoice on the copy {_v(cn_ex, 'original_invoice_no')} differs "
                                           f"from {sor.get('original_invoice_no')}")
        if sor and ret_ex and _v(ret_ex, "credit_note_no") and \
                str(_v(ret_ex, "credit_note_no")).upper() != str(sor.get("credit_note_no")).upper():
            fail("E-2", "sales_return", f"return document refers to {_v(ret_ex, 'credit_note_no')}, not "
                                           f"{sor.get('credit_note_no')}")
        return
    inv_no = str(sor.get("invoice_no")) if sor else str(s["subject_id"])
    if inv_ex:
        ev_no = _v(inv_ex, "invoice_no")
        if ev_no and str(ev_no).upper() != inv_no.upper():
            if snap.invoices_by_no.get(str(ev_no)):
                fail("E-4", "invoice", f"invoice copy is for {ev_no}, another invoice in the system, not {inv_no}")
            else:
                fail("E-1", "invoice", f"invoice number on the copy {ev_no} differs from {inv_no}")
        if sor:
            for field, key, label in (("taxable_value", "taxable_value", "taxable amount"), ("gross", "gross", "gross amount"),
                                      ("igst", "igst", "IGST amount"), ("cgst", "cgst", "CGST amount"),
                                      ("sgst", "sgst", "SGST amount")):
                v = _v(inv_ex, field)
                if v is not None and abs(v - (sor.get(key) or 0)) > tol:
                    fail("E-1", "invoice", f"{label} on the copy Rs {rupees(v)} differs from the system "
                                           f"Rs {rupees(sor.get(key) or 0)}", abs(v - (sor.get(key) or 0)))
            if _v(inv_ex, "invoice_date") and _v(inv_ex, "invoice_date") != sor.get("invoice_date"):
                fail("E-1", "invoice", f"date on the copy {_v(inv_ex, 'invoice_date')} differs from the system "
                                       f"{sor.get('invoice_date')}")
            g = _v(inv_ex, "customer_gstin")
            if g and gst.normalise(g) != gst.normalise(sor.get("customer_gstin")):
                fail("E-1", "invoice", f"customer GSTIN on the copy {g} differs from the system {sor.get('customer_gstin')}")
            nm = _v(inv_ex, "customer_name")
            if nm and JaroWinkler.similarity(_norm_name(nm), _norm_name(sor.get("customer_name"))) < 0.9:
                fail("E-1", "invoice", f"customer on the copy \"{nm}\" differs from the system \"{sor.get('customer_name')}\"")
    dispatch = snap.dispatch_for_invoice(sor) if sor else None
    delivery = snap.delivery_for_dispatch(dispatch.get("dispatch_id")) if dispatch else None
    if ewb_ex:
        eno = _v(ewb_ex, "ewb_no")
        if eno:
            sys_ewbs = [e for e in snap.ewbs if str(e.get("ewb_no")) == str(eno)]
            if sys_ewbs and not any(str(e.get("invoice_no")) == inv_no or
                                    (sor and e.get("_sale_id") and e.get("_sale_id") == sor.get("_sale_id"))
                                    for e in sys_ewbs):
                fail("E-4", "eway_bill", f"e-way bill {eno} belongs to invoice {sys_ewbs[0].get('invoice_no')} in the "
                                         f"system, not {inv_no}")
        einv = _v(ewb_ex, "invoice_no")
        if einv and str(einv).upper() != inv_no.upper() and not (sor and sor.get("_sale_id") and any(
                str(i.get("invoice_no")) == str(einv) for i in snap.invoices_by_sale.get(sor["_sale_id"], []))):
            fail("E-2", "eway_bill", f"e-way bill refers to invoice {einv}, not {inv_no}")
        val = _v(ewb_ex, "value")
        if sor and val is not None and abs(val - (sor.get("gross") or 0)) > tol and str(einv or inv_no) == inv_no:
            fail("E-2", "eway_bill", f"e-way bill value Rs {rupees(val)} differs from invoice value "
                                     f"Rs {rupees(sor.get('gross') or 0)}", abs(val - (sor.get("gross") or 0)))
        # E-5 validity covers the journey.
        gen, until = ts(_v(ewb_ex, "generated_at")), ts(_v(ewb_ex, "valid_until"))
        dist = _v(ewb_ex, "distance_km") or (dispatch or {}).get("distance_km")
        if until and dist:
            start = gen or ts((dispatch or {}).get("dispatched_at"))
            if start:
                need_days = max(1, math.ceil(dist / th["ewb_km_per_day"]))
                covers = dt.datetime.combine(start.date() + dt.timedelta(days=need_days), dt.time(23, 59, 59))
                if until < covers - dt.timedelta(hours=24):
                    fail("E-5", "eway_bill", f"e-way bill valid until {until} does not cover {dist} km from {start} "
                                             f"({need_days} day(s) needed at {th['ewb_km_per_day']} km per day)")
            delivered = ts((delivery or {}).get("delivered_at"))
            if delivered and until < delivered:
                fail("E-5", "eway_bill", f"e-way bill expired at {until}, before delivery at {delivered}")
    if lr_ex:
        lno = _v(lr_ex, "lr_no")
        if lno:
            sys_lrs = [l for l in snap.lrs if str(l.get("lr_no")) == str(lno)]
            if sys_lrs and dispatch and not any(l.get("dispatch_id") == dispatch.get("dispatch_id") for l in sys_lrs):
                other = next((i for i in snap.invoices if i.get("dispatch_id") == sys_lrs[0].get("dispatch_id")), {})
                fail("E-4", "lr_copy", f"LR {lno} belongs to {other.get('invoice_no') or sys_lrs[0].get('dispatch_id')} in "
                                  f"the system, not {inv_no}")
    # E-2 across the set: vehicle and dates.
    vehicles = {k: _v(x, "vehicle_no") for k, x in (("invoice", inv_ex), ("eway_bill", ewb_ex), ("lr_copy", lr_ex)) if x}
    vs = {k: v for k, v in vehicles.items() if v}
    if len(set(vs.values())) > 1:
        fail("E-2", "lr_copy" if "lr_copy" in vs else "eway_bill",
             "vehicle numbers differ across documents: " + ", ".join(f"{k.replace('_', ' ')} {v}" for k, v in vs.items()))
    lr_date = d(_v(lr_ex, "date")) if lr_ex else None
    inv_date = d(_v(inv_ex, "invoice_date")) if inv_ex else d((sor or {}).get("invoice_date"))
    if lr_date and inv_date and abs((lr_date - inv_date).days) > 3:
        fail("E-2", "lr_copy", f"LR dated {lr_date} is {abs((lr_date - inv_date).days)} days from the invoice date {inv_date}")
    # E-6 delivery feasible for the stated distance.
    if dispatch and delivery:
        dist = (_v(ewb_ex, "distance_km") if ewb_ex else None) or dispatch.get("distance_km")
        t0, t1 = ts(dispatch.get("dispatched_at")), ts(delivery.get("delivered_at"))
        if dist and t0 and t1:
            hours = (t1 - t0).total_seconds() / 3600
            if hours <= 0 or dist / hours > th["max_speed_kmph"]:
                fail("E-6", "lr_copy" if lr_ex else ("eway_bill" if ewb_ex else "invoice"),
                     f"{dist} km delivered in {hours:.1f} hours ({dist / max(hours, 0.01):.0f} km per hour, limit "
                     f"{th['max_speed_kmph']})")
