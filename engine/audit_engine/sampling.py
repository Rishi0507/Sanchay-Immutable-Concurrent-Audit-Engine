"""Sampling for the three tests of details (PRD section 12).

No model call and no wall-clock value is used (SM-1). The generator is seeded
with SHA256(seed || snapshot_seq || sheet) (SM-2). Populations are sorted by
document number before any step (SM-3), so the same seed and snapshot always
give the same samples in the same order (SM-4).
"""

from __future__ import annotations

import datetime as dt
import hashlib
import random
from collections import Counter, defaultdict

from .detectors.common import inv_date, order_of, period_invoices
from .detectors.credit_notes import in_scope_credit_notes
from .detectors.cutoff import assess
from .money import rupees
from .repo import evidence_requests, indicators, register_recon, register_rows, sample_meta, sample_tests, samples
from .snapshot import d

SHEETS = {"sales_tod": "Sales TOD", "cutoff_tod": "Sales Cut-off TOD", "credit_note_tod": "Credit Note TOD"}
TESTS = ["Occurrence", "Amount", "Party", "Ledger account", "Period", "Tax", "Evidence"]
HIT_DETECTORS = ("D-01", "D-05", "D-06", "D-08", "D-12", "D-13", "D-14")
DOCS = {"sales_tod": ["invoice", "eway_bill", "lr_copy"], "cutoff_tod": ["invoice", "eway_bill", "lr_copy"],
        "credit_note_tod": ["credit_note", "sales_return"]}


def rng_for(ctx, sheet: str) -> random.Random:
    material = f"{ctx.eng['seed']}{ctx.eng['snapshot_seq']}{SHEETS[sheet]}"
    return random.Random(int(hashlib.sha256(material.encode()).hexdigest(), 16))


def quarter_of(day: dt.date, start: dt.date) -> str:
    months = (day.year - start.year) * 12 + day.month - start.month
    return f"Q{months // 3 + 1}"


def finding_index(ctx) -> dict[str, list[dict]]:
    """Document id to findings that name it (subject or lineage)."""
    if "finding_index" in ctx.cache:
        return ctx.cache["finding_index"]
    idx: dict[str, list[dict]] = defaultdict(list)
    for f in ctx.engine.repo.findings(ctx.eid):
        keys = {f["subject"]["id"].split("#")[0]} | set(f["lineage"]["document_ids"])
        for k in keys:
            idx[k].append(f)
    ctx.cache["finding_index"] = idx
    return idx


def _related_text(ctx, cust_id: str, on: dt.date) -> tuple[str | None, str]:
    kind = ctx.is_related(cust_id, on)
    if not kind:
        return None, ""
    tag = ctx.rp_tags().get(cust_id) or {}
    det = tag.get("detail") or {}
    if kind == "disclosed":
        return kind, f"disclosed: {det.get('relationship') or 'related party'}"
    path = det.get("path") or []
    sig = ", ".join(sorted({s["signal"].replace("_", " ") for st in path[:1] for s in st["signals"]}))
    anchor = path[-1]["to"] if path else "the company"
    return kind, f"suggested: {sig} with {anchor}"


def system_tests(ctx, inv: dict | None, sheet: str = "sales_tod") -> dict[str, str]:
    """Tests from the system of record. Evidence stays pending until verify_evidence."""
    if inv is None:
        return {t: "Exception" for t in TESTS[:-1]} | {"Evidence": "Pending evidence"}
    idx = finding_index(ctx)
    fs = idx.get(str(inv["invoice_no"]), [])
    dets = {f["detector_id"] for f in fs}
    subs = {f["subtype"] for f in fs}
    postings = ctx.snap.postings_for(inv["_seq"])
    sales_cr = sum(p["credit"] - p["debit"] for p in postings if p["account"] == "4000")
    recv_dr = sum(p["debit"] - p["credit"] for p in postings if p["account"] == "1100")
    order = order_of(ctx, inv)
    party_ok = "THIRD_PARTY_PAYER" not in subs and (not order or order.get("customer_id") == inv.get("customer_id"))
    period = assess(ctx, inv)
    return {
        "Occurrence": "Exception" if "D-05" in dets else "Pass",
        "Amount": "Pass" if sales_cr == (inv.get("taxable_value") or 0) and recv_dr == (inv.get("gross") or 0)
        and "D-01" not in dets else "Exception",
        "Party": "Pass" if party_ok else "Exception",
        "Ledger account": "Pass" if postings and postings[0]["source_event_type"] == "InvoiceIssued" and sales_cr > 0
        else "Exception",
        "Period": "Pass" if period["ok"] is not False and "D-06" not in dets else "Exception",
        "Tax": "Exception" if "D-08" in dets else "Pass",
        "Evidence": "Pending evidence",
    }


def docs_for(ctx, inv: dict | None) -> list[str]:
    """Documents to request for an invoice sample. An e-way bill only where one is required or exists."""
    if inv is None:
        return ["invoice"]
    need = (inv.get("gross") or 0) > ctx.th["d05"]["eway_bill_threshold"]
    dispatch = ctx.snap.dispatch_for_invoice(inv)
    has = bool(ctx.snap.ewbs_by_invoice.get(str(inv["invoice_no"])) or
               (dispatch and ctx.snap.ewbs_by_dispatch.get(dispatch.get("dispatch_id"))))
    return ["invoice", "eway_bill", "lr_copy"] if (need or has) else ["invoice", "lr_copy"]


def overall(tests: dict[str, str]) -> str:
    vals = set(tests.values())
    if "Exception" in vals:
        return "Exception"
    if "Needs human review" in vals:
        return "Needs human review"
    if "Pending evidence" in vals:
        return "Pending evidence"
    return "Pass"


def _store(ctx, sheet: str, rows: list[dict], meta: dict) -> dict:
    repo = ctx.engine.repo
    eid = ctx.eid
    stored, reqs, tests_rows = [], [], []
    for pos, r in enumerate(rows, 1):
        sid = "smp_" + hashlib.sha256(f"{eid}|{sheet}|{r['subject_id']}|{pos}".encode()).hexdigest()[:16]
        r["sample_id"] = sid
        stored.append({"sample_id": sid, "engagement_id": eid, "sheet": sheet, "position": pos,
                       "subject_type": r["subject_type"], "subject_id": r["subject_id"], "reason": r["reason"],
                       "reason_codes": r["codes"], "score": r.get("score", 0), "data": r["data"]})
        tests_rows.append({"sample_id": sid, "engagement_id": eid, "tests": r["tests"], "flags": [],
                           "cause": "selection", "at": ctx.eng["opened_at"]})
        for doc in r.get("docs") or DOCS[sheet]:
            reqs.append({"request_id": "req_" + hashlib.sha256(f"{sid}|{doc}".encode()).hexdigest()[:16], "engagement_id": eid, "sample_id": sid, "document_type": doc,
                         "note": f"{doc.replace('_', ' ')} copy for {r['subject_id']}",
                         "created_by": ctx.identity.get("user") or "engine", "created_at": ctx.eng["opened_at"]})
    repo.insert(samples, stored)
    repo.insert(sample_tests, tests_rows)
    repo.insert(evidence_requests, reqs)
    repo.insert(sample_meta, {"engagement_id": eid, "sheet": sheet, "detail": meta})
    return {
        "sheet": SHEETS[sheet], "count": len(stored),
        "samples": [{"sample_id": r["sample_id"], "subject": r["subject_id"], "customer": r["data"].get("customer"),
                     "taxable_value": r["data"].get("taxable"), "reason": r["reason"], "score": r.get("score", 0)}
                    for r in rows],
        "population": meta["population"], "strata": meta.get("strata", {}),
        "evidence_requests": [{"request_id": q["request_id"], "sample_id": q["sample_id"],
                               "document_type": q["document_type"]} for q in reqs],
        "notification": {"audience": "client", "kind": "evidence_requested", "count": len(reqs)},
    }


def _meta(ctx, sheet: str, population: int, strata: dict, extra: dict | None = None) -> dict:
    return {"sheet": SHEETS[sheet], "seed": ctx.eng["seed"], "snapshot_seq": ctx.eng["snapshot_seq"],
            "snapshot_hash": ctx.eng["snapshot_hash"],
            "rng_material": f"SHA256({ctx.eng['seed']} || {ctx.eng['snapshot_seq']} || {SHEETS[sheet]})",
            "population": population, "strata": strata, **(extra or {})}


# Sales TOD (12.2)

def select_sales_tod(ctx, target: int | None = None) -> dict:
    th = dict(ctx.th["sampling"])
    if target:
        th["sales_target"] = max(th["sales_min"], min(th["sales_max"], int(target)))
    snap = ctx.snap
    rng = rng_for(ctx, "sales_tod")
    invs = sorted(period_invoices(ctx), key=lambda i: (str(i["invoice_no"]), i["_seq"]))
    idx = finding_index(ctx)
    ind = {r["subject_id"]: r["detail"]["indicators"] for r in ctx.engine.repo.select(indicators, engagement_id=ctx.eid)}
    items = []
    for inv in invs:
        items.append({"key": f"{inv['invoice_no']}#{inv['_aggregate_id']}", "inv": inv, "no": str(inv["invoice_no"]),
                      "date": inv_date(inv), "cust": inv.get("customer_id"), "name": inv.get("customer_name"),
                      "taxable": inv.get("taxable_value") or 0, "bu": inv.get("bu") or "", "unit": inv.get("unit") or ""})
    # Register rows that are not in the system join the population.
    recon = {r["row_no"]: r for r in ctx.engine.repo.select(register_recon, engagement_id=ctx.eid)}
    for rr in ctx.engine.repo.select(register_rows, order_by=register_rows.c.row_no, engagement_id=ctx.eid):
        if "Not in system" in (recon.get(rr["row_no"], {}).get("status") or ""):
            p = rr["parsed"]
            items.append({"key": f"register:{p.get('bill_no')}#row{rr['row_no']}", "inv": None,
                          "no": str(p.get("bill_no") or f"row {rr['row_no']}"), "date": d(p.get("date")) or ctx.end,
                          "cust": None, "name": p.get("customer"), "taxable": p.get("taxable") or 0,
                          "bu": p.get("bu") or "", "unit": "", "register_row": rr["row_no"]})
    items.sort(key=lambda x: (x["no"], x["key"]))
    if not items:
        return _store(ctx, "sales_tod", [], _meta(ctx, "sales_tod", 0, {}))
    values = sorted(x["taxable"] for x in items)
    p95 = values[min(len(values) - 1, int(0.95 * (len(values) - 1) + 0.5))]
    last_start = ctx.end - dt.timedelta(days=th["last_days"] - 1)
    for x in items:
        score, why = 0, []
        rk, rtext = _related_text(ctx, x["cust"], x["date"]) if x["cust"] else (None, "")
        x["related"], x["related_text"] = rk, rtext
        if rk == "disclosed":
            score += th["score_disclosed_rp"]
        elif rk == "suggested":
            score += th["score_suggested_rp"]
        if x["taxable"] >= p95:
            score += th["score_p95"]
        if x["date"] >= last_start:
            score += th["score_last_days"]
        fs = idx.get(x["no"], []) if x["inv"] else []
        hit_dets = sorted({f["detector_id"] for f in fs if f["detector_id"] in HIT_DETECTORS})
        if x["inv"] is None:
            hit_dets = ["D-01"]
        x["hits"] = hit_dets
        score += min(th["score_detector_hit"] * len(hit_dets), th["score_detector_cap"])
        x["indicators"] = ind.get(x["no"], [])
        if x["indicators"]:
            score += th["score_indicator"]
        x["score"] = score
    chosen: dict[str, dict] = {}
    reasons: dict[str, list[str]] = defaultdict(list)
    codes: dict[str, list[str]] = defaultdict(list)

    def take(x, code, text, cap=th["sales_max"]):
        if x["key"] not in chosen and len(chosen) >= cap:
            return False
        chosen.setdefault(x["key"], x)
        if code not in codes[x["key"]]:
            codes[x["key"]].append(code)
            reasons[x["key"]].append(f"{code} ({text})" if text else code)
        return True

    by_value = sorted(items, key=lambda x: (-x["taxable"], x["no"], x["key"]))
    for rank, x in enumerate(by_value[:th["key_items"]], 1):
        take(x, "KEY_ITEM", f"rank {rank} by value")
    rp_best = {}
    for x in items:
        if x["related"]:
            cur = rp_best.get(x["cust"])
            if cur is None or (x["score"], x["taxable"]) > (cur["score"], cur["taxable"]):
                rp_best[x["cust"]] = x
    for x in sorted(rp_best.values(), key=lambda x: (-x["score"], -x["taxable"], x["no"]))[:th["related_party_max"]]:
        take(x, "RELATED_PARTY", x["related_text"])
    for det in HIT_DETECTORS:
        cands = [x for x in items if det in x["hits"]]
        if cands:
            x = max(cands, key=lambda x: (x["score"], x["taxable"], x["no"]))
            take(x, "DETECTOR_HIT", f"{det} highest score {x['score']}")
    cust_value = Counter()
    for x in items:
        if x["cust"]:
            cust_value[x["cust"]] += x["taxable"]
    covered = {x["cust"] for x in chosen.values()}
    for cust, _ in sorted(cust_value.items(), key=lambda kv: (-kv[1], kv[0]))[:th["customer_coverage"]]:
        if cust in covered:
            continue
        x = max((x for x in items if x["cust"] == cust), key=lambda x: (x["score"], x["taxable"], x["no"]))
        if take(x, "CUSTOMER_COVERAGE", f"top {th['customer_coverage']} customer by value"):
            covered.add(cust)
    # Monetary-unit sampling for the remaining slots, spread across quarters and business units.
    target = max(th["sales_min"], min(th["sales_target"], th["sales_max"]))
    remaining = [x for x in items if x["key"] not in chosen]
    need = max(0, min(target - len(chosen), len(remaining)))
    if need:
        strata_order = sorted(remaining, key=lambda x: (quarter_of(x["date"], ctx.start), x["bu"], x["no"], x["key"]))
        weights = [max(1, int(x["taxable"] * (100 + x["score"]) / 100)) for x in strata_order]
        total = sum(weights)
        interval = total / need
        start = rng.random() * interval
        picks, cum, j = [], 0, 0
        points = [start + k * interval for k in range(need)]
        for i, w in enumerate(weights):
            cum += w
            while j < len(points) and points[j] < cum:
                picks.append(strata_order[i])
                j += 1
        seen = set()
        for x in picks:
            if x["key"] in seen:
                continue
            seen.add(x["key"])
            take(x, "MUS", f"interval Rs {rupees(int(interval))}, {quarter_of(x['date'], ctx.start)}, {x['bu'] or 'no BU'}")
        k = 0
        while len(chosen) < target and k < len(strata_order):
            x = strata_order[k]
            if x["key"] not in chosen:
                take(x, "MUS", "fill to target")
            k += 1
    # Coverage rules: at least 8 customers and both related and non-related where the population allows.
    def distinct():
        return {x["cust"] for x in chosen.values() if x["cust"]}

    all_custs = {x["cust"] for x in items if x["cust"]}
    want = min(th["min_distinct_customers"], len(all_custs))
    for cust, _ in sorted(cust_value.items(), key=lambda kv: (-kv[1], kv[0])):
        if len(distinct()) >= want:
            break
        if cust in distinct():
            continue
        x = max((x for x in items if x["cust"] == cust), key=lambda x: (x["taxable"], x["no"]))
        mus = [k for k in chosen if codes[k] == ["MUS"]]
        if mus and len(chosen) >= target:
            drop = mus[-1]
            chosen.pop(drop)
        take(x, "CUSTOMER_COVERAGE", "minimum distinct customers")
    if not any(x["related"] is None and x["cust"] for x in chosen.values()):
        nr = [x for x in by_value if x["related"] is None and x["cust"]]
        if nr:
            take(nr[0], "CUSTOMER_COVERAGE", "non-related coverage", cap=th["sales_max"] + 1)
    rows = []
    for x in sorted(chosen.values(), key=lambda x: (x["no"], x["key"])):
        notes = list(reasons[x["key"]])
        if x["date"] >= last_start:
            notes.append(f"{(ctx.end - x['date']).days} days before period end")
        if x["indicators"]:
            notes.append("indicators: " + ", ".join(sorted(set(x["indicators"]))))
        inv = x["inv"]
        tests = system_tests(ctx, inv)
        data = {"unit": x["unit"], "quarter": quarter_of(x["date"], ctx.start), "month": x["date"].strftime("%b-%y"),
                "bill_no": x["no"], "date": x["date"].isoformat(), "job_no": (inv or {}).get("order_id") or "",
                "customer": x["name"], "customer_id": x["cust"], "bu": x["bu"],
                "related": "Related Party" if ctx.disclosed(x["cust"]) else "Non Related Party",
                "related_kind": x["related"], "taxable": x["taxable"],
                "aggregate_id": (inv or {}).get("_aggregate_id"), "sale_id": (inv or {}).get("_sale_id"),
                "register_row": x.get("register_row"), "hits": x["hits"],
                "finding_refs": sorted({f["finding_id"] for f in finding_index(ctx).get(x["no"], [])})}
        rows.append({"subject_type": "invoice" if inv else "register_row", "subject_id": x["no"],
                     "reason": "; ".join(notes) + ".", "codes": codes[x["key"]], "score": x["score"], "data": data,
                     "tests": tests, "docs": docs_for(ctx, inv)})
    strata = {"by_quarter": dict(Counter(quarter_of(x["date"], ctx.start) for x in items)),
              "by_bu": dict(Counter(x["bu"] or "none" for x in items)),
              "related": sum(1 for x in items if x["related"]), "non_related": sum(1 for x in items if not x["related"]),
              "selected_by_code": dict(Counter(c for k in chosen for c in codes[k])),
              "p95_taxable": p95, "distinct_customers_selected": len(distinct())}
    return _store(ctx, "sales_tod", rows, _meta(ctx, "sales_tod", len(items), strata,
                                            {"population_value": sum(x["taxable"] for x in items)}))


# Sales cut-off TOD (12.3)

def select_cutoff_tod(ctx, after_count: int | None = None, before_count: int | None = None) -> dict:
    th = dict(ctx.th["sampling"])
    after_n = max(10, min(15, after_count or th["cutoff_after"]))
    if before_count:
        th["cutoff_before"] = max(1, min(30, int(before_count)))
    invs = [i for i in ctx.snap.invoices if not i["_reversed"] and ctx.in_scope(i) and inv_date(i)]
    invs.sort(key=lambda i: (inv_date(i), str(i["invoice_no"]), i["_seq"]))
    before = [i for i in invs if inv_date(i) <= ctx.end][-th["cutoff_before"]:]
    after = [i for i in invs if inv_date(i) > ctx.end][:after_n]
    idx = finding_index(ctx)
    rows = []
    for side, group in (("before", before), ("after", after)):
        for k, inv in enumerate(group, 1):
            a = assess(ctx, inv)
            refs = sorted({f["finding_id"] for f in idx.get(str(inv["invoice_no"]), []) if f["detector_id"] == "D-06"})
            if a["ok"] is False:
                concl = f"Exception: recognised in {a['period_recognised'].lower()}, control in {a['correct_period'].lower()}"
            elif a["ok"] is None:
                concl = f"Exception: control date not determinable ({a['basis']})"
            else:
                concl = "Recorded in the correct period"
            pos_text = (f"{len(group) - k + 1} of last {th['cutoff_before']} on or before {ctx.end}" if side == "before"
                        else f"{k} of first {after_n} after {ctx.end}")
            tests = system_tests(ctx, inv, "cutoff_tod")
            tests["Period"] = "Exception" if a["ok"] is not True else "Pass"
            rows.append({"subject_type": "invoice", "subject_id": str(inv["invoice_no"]),
                         "reason": f"CUTOFF_{side.upper()} ({pos_text}).", "codes": [f"CUTOFF_{side.upper()}"],
                         "score": 0, "tests": tests, "docs": docs_for(ctx, inv),
                         "data": {"unit": inv.get("unit") or "", "quarter": quarter_of(inv_date(inv), ctx.start),
                                  "month": inv_date(inv).strftime("%b-%y"), "bill_no": str(inv["invoice_no"]),
                                  "date": inv.get("invoice_date"), "job_no": inv.get("order_id") or "",
                                  "customer": inv.get("customer_name"), "customer_id": inv.get("customer_id"),
                                  "ledger_account": inv.get("ledger_account") or "Sales Revenue",
                                  "state_code": inv.get("place_of_supply"), "gstin": inv.get("customer_gstin"),
                                  "taxable": inv.get("taxable_value") or 0, "dispatch_date": a["dispatch_date"],
                                  "delivery_date": a["delivery_date"], "terms": a["terms"],
                                  "control_date": a["control_date"], "posting_date": a["posting_date"],
                                  "period_recognised": a["period_recognised"], "correct_period": a["correct_period"],
                                  "conclusion": concl, "side": side, "aggregate_id": inv["_aggregate_id"],
                                  "sale_id": inv["_sale_id"], "finding_refs": refs}})
    strata = {"before": len(before), "after": len(after), "after_count_requested": after_n}
    return _store(ctx, "cutoff_tod", rows, _meta(ctx, "cutoff_tod", len(invs), strata,
                                             {"note": "Selection is fully determined by the snapshot. The seed is "
                                                      "recorded but not used (CO-3)."}))


# Credit note TOD (12.4)

def select_credit_note_tod(ctx) -> dict:
    th = ctx.th["sampling"]
    rng = rng_for(ctx, "credit_note_tod")
    cns = sorted(in_scope_credit_notes(ctx), key=lambda c: (str(c.get("credit_note_no")), c["_seq"]))
    after = [c for c in cns if (d(c.get("date")) or ctx.end) > ctx.end]
    within = [c for c in cns if (d(c.get("date")) or ctx.end) <= ctx.end]
    chosen = sorted(after, key=lambda c: (-(c.get("taxable_value") or 0), str(c.get("credit_note_no"))))[
        :th["credit_note_after_max"]]
    codes = {id(c): ["POST_PERIOD"] for c in chosen}
    need = max(0, th["credit_note_total"] - len(chosen))
    last_month = ctx.end.replace(day=1)
    pool = list(within)
    while need and pool:
        weights = []
        for c in pool:
            w = c.get("taxable_value") or 1
            if ctx.is_related(c.get("customer_id"), d(c.get("date"))):
                w *= 3
            if (d(c.get("date")) or ctx.start) >= last_month:
                w *= 2
            weights.append(max(1, w))
        total = sum(weights)
        r = rng.random() * total
        acc = 0
        for i, w in enumerate(weights):
            acc += w
            if r < acc:
                c = pool.pop(i)
                chosen.append(c)
                codes[id(c)] = ["MUS"]
                need -= 1
                break
    idx = finding_index(ctx)
    rows = []
    for c in chosen:
        no = str(c.get("credit_note_no"))
        invs = ctx.snap.invoices_by_no.get(str(c.get("original_invoice_no")), [])
        inv = invs[0] if invs else None
        returns = ctx.snap.returns_by_cn.get(no, [])
        cust = ctx.snap.customer(c.get("customer_id"))
        cdate = d(c.get("date"))
        fs = [f for f in idx.get(no, []) if f["detector_id"] == "D-11"]
        days = (cdate - inv_date(inv)).days if inv and cdate and inv_date(inv) else None
        rk, rtext = _related_text(ctx, c.get("customer_id"), cdate) if cdate else (None, "")
        reason_bits = []
        if codes[id(c)] == ["POST_PERIOD"]:
            reason_bits.append(f"POST_PERIOD (dated {cdate}, after {ctx.end}, against invoice of "
                               f"{(inv or {}).get('invoice_date')})")
        else:
            reason_bits.append("MUS (weighted to related parties and the last month)")
        if rk:
            reason_bits.append(f"RELATED_PARTY ({rtext})")
        concl = ("Exception: " + "; ".join(sorted({f["subtype"].replace("_", " ").lower() for f in fs}))) if fs \
            else "No exception noted in the system of record"
        tests = {"Occurrence": "Pass" if returns else "Exception", "Amount": "Pass", "Party": "Pass",
                 "Ledger account": "Pass", "Period": "Exception" if any(f["subtype"] == "POST_PERIOD" for f in fs) else "Pass",
                 "Tax": "Pass", "Evidence": "Pending evidence"}
        rows.append({"subject_type": "credit_note", "subject_id": no, "reason": "; ".join(reason_bits) + ".",
                     "codes": codes[id(c)] + (["RELATED_PARTY"] if rk else []), "score": 0, "tests": tests,
                     "data": {"credit_note_no": no, "date": c.get("date"), "customer": cust.name if cust else c.get("customer_id"),
                              "customer_id": c.get("customer_id"),
                              "related": "Related Party" if ctx.disclosed(c.get("customer_id")) else "Non Related Party",
                              "related_kind": rk, "original_bill_no": c.get("original_invoice_no"),
                              "original_date": (inv or {}).get("invoice_date"), "reason_given": c.get("reason"),
                              "approver": c.get("approver"),
                              "return_inward_date": returns[0].get("inward_date") if returns else None,
                              "taxable": c.get("taxable_value") or 0, "days_from_invoice": days, "conclusion": concl,
                              "aggregate_id": c["_aggregate_id"], "sale_id": c["_sale_id"],
                              "finding_refs": sorted({f["finding_id"] for f in fs})}})
    strata = {"after_period_end": len(after), "within_period": len(within),
              "selected_after": sum(1 for c in chosen if codes[id(c)] == ["POST_PERIOD"]),
              "selected_within": sum(1 for c in chosen if codes[id(c)] == ["MUS"])}
    return _store(ctx, "credit_note_tod", rows, _meta(ctx, "credit_note_tod", len(cns), strata))
