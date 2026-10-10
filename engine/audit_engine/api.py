"""HTTP API of the audit engine, as specified in contracts/engine-api.md.

The MCP server is the only caller. It sends X-Service-Token, X-Identity-User
and X-Identity-Role, and converts paise to rupees by key name, so every money
value here is integer paise under a money key, and no other key name holds
money. Errors use {"error": {"code", "message", "next_step"}}.
"""

from __future__ import annotations

import base64
import datetime as dt
import os
from collections import Counter, defaultdict
from functools import lru_cache
from typing import Any

from fastapi import Body, FastAPI, Request
from fastapi.responses import JSONResponse

from . import __version__
from .changes import check_post_testing_changes
from .engine import STEPS, Engine, EngineError
from .evidence.service import control_summary, request_evidence, request_status, verify_evidence
from .findings_service import all_findings, confirm_finding, sign_off
from .graph import build_graph
from .integrity import integrity_report
from .outputs import draft_findings_memo, export_summary, export_workpaper
from .register_recon import dec
from .repo import (change_matches, engagements, evidence_requests, register_imports, register_recon, register_rows,
                   rp_tags, sample_meta, samples)
from .sampling import overall, select_cutoff_tod, select_credit_note_tod, select_sales_tod

app = FastAPI(title="ELEV05 audit engine", version=__version__)

AUDIT = ("auditor", "audit_manager")
CONTRACT_CODES = {"NO_ENGAGEMENT", "NOT_FOUND", "VALIDATION_FAILED", "EVIDENCE_PENDING", "PERMISSION_DENIED"}

# Plan steps in the contract's vocabulary, with the engine step that completes each.
PLAN = [
    ("open", "open_engagement", "Freeze the snapshot for a period and seed.", "open_engagement"),
    ("import", "import_register", "Carry the client's register into the workpaper as provided.", "import_register"),
    ("reconcile", "reconcile_register", "Compare the register with the system of record.", "reconcile_register"),
    ("tag", "tag_related_parties", "Tag related parties and suggest undisclosed ones.", "tag_related_parties"),
    ("detect", "run_detectors", "Run every population-level detector.", "run_detectors"),
    ("sales_tod", "select_sales_tod", "Select risk-weighted Sales TOD samples.", "select_sales_tod"),
    ("cutoff_tod", "select_cutoff_tod", "Select invoices around the period end.", "select_cutoff_tod"),
    ("credit_note_tod", "select_credit_note_tod", "Select credit notes, after period end first.", "select_credit_note_tod"),
    ("verify", "verify_evidence", "Test the evidence the client uploaded.", "verify_evidence"),
    ("changes", "check_post_testing_changes", "Detect client changes after the snapshot.", "check_post_testing_changes"),
    ("integrity", "verify_ledger_integrity", "Recompute the hash chains.", "verify_ledger_integrity"),
    ("memo", "draft_findings_memo", "Produce the findings memo.", "draft_findings_memo"),
    ("workpaper", "export_workpaper", "Produce the workpaper.", "export_workpaper"),
]
DETECTOR_CATEGORY = {"D-04": "CIRCULAR_TRADING", "D-05": "NO_MOVEMENT", "D-06": "CUTOFF",
                     "D-07": "PERIOD_END_CONCENTRATION", "D-08": "DOC_TAX_MISMATCH", "D-09": "NON_SALE_REVENUE",
                     "D-11": "CREDIT_NOTE", "D-12": "PROMOTION_DISCOUNT", "D-13": "SETTLEMENT",
                     "D-14": "DOCUMENT_INTEGRITY"}
SUBJECT_TYPES = {"gstr1_line": "gstr1", "upload": "register_row", "event": "sample", "eway_bill": "invoice",
                 "lr": "invoice", "vehicle": "invoice", "order": "invoice"}
RECON_CODES = {"Matched": "MATCHED", "Field difference": "FIELD_DIFFERENCE", "Not in system": "NOT_IN_SYSTEM",
               "Duplicate": "DUPLICATE_ROW", "Arithmetic": "ROW_ARITHMETIC", "Reversed in system": "REVERSED_IN_SYSTEM",
               "Blank row": "BLANK_ROW", "Total row": "TOTAL_ROW", "Total row differs": "TOTAL_ROW_MISMATCH"}


def recon_code(label: str | None) -> str | None:
    """The register status as a code. A row with several statuses reports its first exception."""
    if not label:
        return None
    parts = [RECON_CODES.get(p.strip(), p.strip().upper().replace(" ", "_")) for p in label.split(";")]
    return next((p for p in parts if p != "MATCHED"), parts[0])


EVIDENCE_STATUS = {"requested": "pending", "uploaded": "received", "verified": "verified",
                   "replaced after verification": "received", "declined": "declined"}


@lru_cache(maxsize=1)
def engine() -> Engine:
    return Engine()


class Denied(Exception):
    pass


def error(code: str, message: str, next_step: str = "", status: int | None = None) -> JSONResponse:
    if code not in CONTRACT_CODES:
        code = "VALIDATION_FAILED"
    status = status or {"NO_ENGAGEMENT": 409, "NOT_FOUND": 404, "PERMISSION_DENIED": 403,
                        "EVIDENCE_PENDING": 409}.get(code, 400)
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message, "next_step": next_step}})


@app.exception_handler(EngineError)
async def _engine_error(_: Request, exc: EngineError):
    return error(exc.code, exc.message, exc.next_step)


@app.exception_handler(Exception)
async def _any_error(_: Request, exc: Exception):
    return JSONResponse(status_code=500, content={"error": {"code": "INTERNAL_ERROR", "message": str(exc)[:500],
                                                            "next_step": "Retry. Engine calls are safe to repeat."}})


def who(request: Request, allowed: tuple[str, ...] = AUDIT) -> dict:
    token = engine().settings.service_token
    if token and request.headers.get("x-service-token") != token:
        raise EngineError("PERMISSION_DENIED", "The service token is missing or wrong.", "Call through the MCP server.")
    user, role = request.headers.get("x-identity-user"), request.headers.get("x-identity-role")
    if not user or not role:
        raise EngineError("PERMISSION_DENIED", "Identity headers are missing.", "Call through the MCP server.")
    if role not in allowed:
        raise EngineError("PERMISSION_DENIED", f"The {role} role may not call this endpoint.", "Use a tool of your role.")
    return {"user": user, "role": role}


def arg(body: dict | None, key: str, default=None):
    return (body or {}).get(key, default)


def _iso(v) -> Any:
    if isinstance(v, (dt.date, dt.datetime)):
        return v.isoformat()
    return v


# Engagements and plan


def header(e: dict) -> dict:
    eng = engine()
    return {"engagement_id": e["engagement_id"], "period_start": _iso(e["period_start"]),
            "period_end": _iso(e["period_end"]), "seed": e["seed"], "snapshot_seq": e["snapshot_seq"],
            "snapshot_hash": e["snapshot_hash"], "merkle_root": e.get("merkle_root"), "entity_ids": e.get("entity_ids"),
            "opened_by": e.get("opened_by"), "opened_at": e.get("opened_at"),
            "signed_off": eng.repo.is_closed(e["engagement_id"]),
            "seed_source": eng._seal_source(e)}


def plan_steps(eid: str | None) -> tuple[list[dict], str | None]:
    done = engine().repo.steps_done(eid) if eid else {}
    steps, next_tool = [], None
    for key, tool, purpose, engine_step in PLAN:
        if not eid:
            status = "ready" if key == "open" else "blocked"
        elif engine_step in done:
            status = "done"
        else:
            status = "ready"
        if status == "ready" and next_tool is None:
            next_tool = tool
        steps.append({"step": key, "tool": tool, "purpose": purpose, "status": status})
    return steps, next_tool


@app.get("/health")
def health():
    return {"status": "ok", "version": __version__}


@app.get("/plan")
def plan(request: Request, engagement_id: str | None = None):
    who(request)
    try:
        eid = engine().resolve(engagement_id)["engagement_id"]
    except EngineError as e:
        if e.code != "NO_ENGAGEMENT" or engagement_id:
            raise
        eid = None
    steps, next_tool = plan_steps(eid)
    return {"engagement_id": eid, "steps": steps, "next_tool": next_tool if eid else "open_engagement"}


@app.post("/engagements")
def open_engagement(request: Request, body: dict = Body(default={})):
    ident = who(request)
    for k in ("period_start", "period_end"):
        if not body.get(k):
            raise EngineError("VALIDATION_FAILED", f"{k} is required.", "Pass period_start and period_end as YYYY-MM-DD.")
    out = engine().open_engagement(body["period_start"], body["period_end"], body.get("seed"), body.get("entity_ids"),
                                   body.get("client_name"), ident)
    return header(engine().repo.first(engagements, engagement_id=out["engagement_id"]))


@app.post("/sampling/seal")
def post_sampling_seal(request: Request, body: dict = Body(default={})):
    """Seal the sampling seed for a register upload. The MCP server calls this as the register arrives."""
    who(request, ("client_employee",) + AUDIT)
    seal = engine().seal_sampling(body.get("upload_seq"), when="upload")
    return {"register_upload_seq": seal["register_upload_seq"], "commitment": seal["commitment"],
            "sealed_when": seal["sealed_when"], "sealed_at": seal["sealed_at"]}


@app.get("/sampling/seal")
def get_sampling_seal(request: Request, engagement_id: str | None = None):
    who(request, ("client_employee",) + AUDIT)
    return engine().sampling_seal(engagement_id)


@app.get("/engagements")
def list_engagements(request: Request):
    who(request)
    rows = engine().repo.select(engagements, order_by=engagements.c.opened_at)
    return {"engagements": [header(e) for e in rows]}


@app.get("/engagements/status")
def engagement_status(request: Request, engagement_id: str | None = None):
    ident = who(request)
    ctx = engine().ctx(engagement_id, ident)
    out = header(ctx.eng)
    steps, next_tool = plan_steps(ctx.eid)
    sev = Counter(f["severity"] for f in engine().repo.findings(ctx.eid))
    sheets = Counter(s["sheet"] for s in engine().repo.select(samples, engagement_id=ctx.eid))
    pending = sum(1 for r in request_status(ctx) if r["status"] == "requested")
    out.update({"steps": steps, "next_tool": next_tool,
                "counts": {"findings_by_severity": {k: sev.get(k, 0) for k in ("High", "Medium", "Low")},
                           "samples_by_sheet": {k: sheets.get(k, 0) for k in ("sales_tod", "cutoff_tod", "credit_note_tod")},
                           "evidence_pending": pending, "control_requests": control_summary(ctx)}})
    return out


# Steps


def run(request: Request, body: dict | None, step: str, fn=None) -> tuple[dict, Any]:
    ident = who(request)
    e = engine()
    ctx = e.ctx(arg(body, "engagement_id"), ident, allow_closed=False)
    result = e.run_step(ctx, step, fn or e.step_fn(step))
    names = {s[0]: p[0] for s in STEPS for p in PLAN if p[3] == s[0]}
    result["auto_ran"] = [names.get(x, x) for x in result.get("auto_ran", [])]
    return result, e.ctx(ctx.eid, ident)


@app.post("/register/import")
def import_register(request: Request, body: dict | None = Body(default=None)):
    r, ctx = run(request, body, "import_register")
    imp = engine().repo.first(register_imports, engagement_id=ctx.eid) or {}
    names = [n for n in (imp.get("headers") or {}).get("names", [])]
    recognised = {int(k) for k in (imp.get("column_map") or {})}
    return {"engagement_id": ctx.eid, "rows": imp.get("row_count", 0), "columns": names,
            "unrecognised_columns": [n for i, n in enumerate(names) if i not in recognised and n],
            "missing_columns": imp.get("missing_columns") or [], "file_hash": imp.get("file_hash"),
            "auto_ran": r["auto_ran"]}


@app.post("/register/reconcile")
def reconcile_register(request: Request, body: dict | None = Body(default=None)):
    r, ctx = run(request, body, "reconcile_register")
    summary = dict(r.get("by_subtype") or {})
    summary["MATCHED"] = r.get("rows_matched", 0)
    return {"engagement_id": ctx.eid, "summary": summary, "findings_created": r.get("findings_raised", 0),
            "register_total": r.get("register_total"), "ledger_total": r.get("ledger_total"), "auto_ran": r["auto_ran"]}


def register_views(ctx) -> tuple[list[str], list[dict]]:
    """Register rows as provided, with the tag, reconciliation status and finding references beside each."""
    repo = engine().repo
    imp = repo.first(register_imports, engagement_id=ctx.eid) or {}
    names = (imp.get("headers") or {}).get("names", [])
    colmap = {int(k): v for k, v in (imp.get("column_map") or {}).items()}
    bill_col = next((k for k, v in colmap.items() if v == "bill_no"), None)
    gst_col = next((k for k, v in colmap.items() if v == "gstin"), None)
    recon = {r["row_no"]: r for r in repo.select(register_recon, engagement_id=ctx.eid)}
    tags = {t["customer_id"]: t for t in repo.select(rp_tags, engagement_id=ctx.eid)}
    by_gstin = {}
    for cid, party in ctx.snap.customers.items():
        for v in party.versions:
            if v["state"].get("gstin"):
                by_gstin.setdefault(str(v["state"]["gstin"]).upper(), cid)
    out = []
    for r in repo.select(register_rows, order_by=register_rows.c.row_no, engagement_id=ctx.eid):
        kind = r["parsed"].get("_kind")
        if kind in ("preamble", "header"):
            continue
        raw = r["raw"]
        values = {}
        for i, v in enumerate(raw):
            v = dec(v)
            if isinstance(v, dt.datetime):
                v = v.strftime("%d-%m-%Y")
            elif isinstance(v, (dt.date, dt.time)):
                v = v.isoformat()
            values[names[i] if i < len(names) and names[i] else f"Column {i + 1}"] = v
        cid = None
        if bill_col is not None and bill_col < len(raw):
            invs = ctx.snap.invoices_by_no.get(str(r["parsed"].get("bill_no") or ""), [])
            cid = invs[0].get("customer_id") if invs else None
        if not cid and gst_col is not None and gst_col < len(raw) and raw[gst_col]:
            cid = by_gstin.get(str(raw[gst_col]).strip().upper())
        tag = tags.get(cid or "") or {}
        det = tag.get("detail") or {}
        rec = recon.get(r["row_no"]) or {}
        out.append({"row_no": r["row_no"], "raw": values,
                    "rp_tag": ("Related Party" if det.get("disclosed_from") else "Non Related Party") if kind == "data" else None,
                    "suggested_rp": det.get("explanation") if tag.get("tag") == "suggested" else None,
                    "recon_status": recon_code(rec.get("status")), "recon_detail": rec.get("status"),
                    "finding_ids": rec.get("finding_refs") or []})
    return names, out


@app.get("/register/rows")
def get_register_rows(request: Request, engagement_id: str | None = None, recon_status: str | None = None,
                      rp_tag: str | None = None, limit: int = 50, cursor: str | None = None):
    ident = who(request)
    ctx = engine().ctx(engagement_id, ident)
    names, rows = register_views(ctx)
    if recon_status:
        want = recon_status.upper()
        rows = [r for r in rows if r["recon_status"] == want or want in (r.get("recon_detail") or "").upper().replace(" ", "_")]
    if rp_tag:
        rows = [r for r in rows if (r["rp_tag"] or "").lower() == rp_tag.lower()]
    after = int(cursor) if cursor and cursor.isdigit() else 0
    rows = [r for r in rows if r["row_no"] > after]
    limit = max(1, min(int(limit or 50), 500))
    page = rows[:limit]
    return {"engagement_id": ctx.eid, "columns": names, "rows": page, "total_rows": len(rows),
            "next_cursor": str(page[-1]["row_no"]) if len(rows) > limit else None}


@app.post("/related-parties/tag")
def tag_related_parties(request: Request, body: dict | None = Body(default=None)):
    r, ctx = run(request, body, "tag_related_parties")
    tags = engine().repo.select(rp_tags, engagement_id=ctx.eid)
    d02 = {f["subject"]["id"]: f for f in engine().repo.findings(ctx.eid) if f["detector_id"] == "D-02"}
    suggestions = []
    for t in tags:
        if t["tag"] != "suggested":
            continue
        det = t["detail"] or {}
        sigs = sorted({s["signal"] for st in det.get("path") or [] for s in st["signals"]})
        suggestions.append({"customer_id": t["customer_id"], "name": det.get("name"), "signals": sigs,
                            "explanation": det.get("explanation"), "effective_from": det.get("suggested_from"),
                            "sales_value": (d02.get(t["customer_id"]) or {}).get("amount_impact", 0)})
    return {"engagement_id": ctx.eid, "customers": len(tags),
            "related_disclosed": sum(1 for t in tags if t["tag"] == "disclosed"),
            "related_suggested": len(suggestions), "suggestions": suggestions,
            "findings_created": r.get("findings_raised", 0), "auto_ran": r["auto_ran"]}


@app.post("/detectors/run")
def run_detectors(request: Request, body: dict | None = Body(default=None)):
    r, ctx = run(request, body, "run_detectors")
    hits = Counter(f["detector_id"] for f in engine().repo.findings(ctx.eid))
    only = arg(body, "detectors")
    results = [{"detector_id": d, "category": c, "hits": hits.get(d, 0)} for d, c in DETECTOR_CATEGORY.items()
               if not only or d in only]
    ind = r.get("indicators") or {}
    return {"engagement_id": ctx.eid, "results": results, "findings_created": r.get("findings_raised", 0),
            "indicators": {"invoices_flagged": ind.get("invoices_flagged", 0), "by_indicator": ind.get("by_indicator", {})},
            "auto_ran": r["auto_ran"]}


def sample_record(ctx, s: dict, tests: dict | None, refs: dict[str, list[str]]) -> dict:
    d = s["data"] or {}
    rec = {"sample_id": s["sample_id"], "sheet": s["sheet"], "position": s["position"],
           "subject_type": s["subject_type"], "subject_id": d.get("aggregate_id") or s["subject_id"],
           "sale_id": d.get("sale_id"), "date": d.get("date"), "customer": d.get("customer"),
           "related": d.get("related"), "taxable_value": d.get("taxable", 0), "reason_codes": s["reason_codes"],
           "reason": s["reason"], "tests": tests or {}, "result": overall(tests or {}),
           "finding_ids": sorted(set(d.get("finding_refs") or []) | set(refs.get(s["sample_id"], [])))}
    if s["subject_type"] == "credit_note":
        rec.update({"credit_note_no": d.get("credit_note_no"), "invoice_no": d.get("original_bill_no"),
                    "original_date": d.get("original_date"), "reason_given": d.get("reason_given"),
                    "approver": d.get("approver"), "return_inward_date": d.get("return_inward_date"),
                    "days_from_invoice": d.get("days_from_invoice"), "conclusion": d.get("conclusion")})
    else:
        rec.update({"invoice_no": d.get("bill_no") or s["subject_id"], "unit": d.get("unit"), "quarter": d.get("quarter"),
                    "month": d.get("month"), "job_no": d.get("job_no"), "bu": d.get("bu")})
    if s["sheet"] == "cutoff_tod":
        rec.update({k: d.get(k) for k in ("dispatch_date", "delivery_date", "terms", "control_date", "posting_date",
                                         "period_recognised", "correct_period", "conclusion", "side", "state_code",
                                         "gstin", "ledger_account")})
    # Shown as label and value pairs in the sample panel.
    labels = {"unit": "Unit", "quarter": "Quarter", "bu": "Business unit", "job_no": "Order", "related_kind": "Related party",
              "dispatch_date": "Dispatched", "delivery_date": "Delivered", "terms": "Delivery terms",
              "control_date": "Control passed", "posting_date": "Posted", "period_recognised": "Recognised in",
              "correct_period": "Belongs to", "conclusion": "Conclusion", "original_bill_no": "Original invoice",
              "original_date": "Original date", "reason_given": "Reason", "approver": "Approver",
              "return_inward_date": "Goods returned", "days_from_invoice": "Days after invoice"}
    rec["detail"] = {label: d.get(k) for k, label in labels.items() if d.get(k) not in (None, "")}
    return rec


def sheet_samples(ctx, sheet: str) -> list[dict]:
    repo = engine().repo
    tests = repo.latest_tests(ctx.eid)
    refs: dict[str, list[str]] = defaultdict(list)
    for f in repo.findings(ctx.eid):
        for sid in f.get("sample_ids") or []:
            refs[sid].append(f["finding_id"])
    rows = repo.select(samples, order_by=samples.c.position, engagement_id=ctx.eid, sheet=sheet)
    return [sample_record(ctx, s, (tests.get(s["sample_id"]) or {}).get("tests"), refs) for s in rows]


def select(request: Request, body: dict | None, sheet: str, step: str, fn):
    r, ctx = run(request, body, step, fn)
    meta = (engine().repo.first(sample_meta, engagement_id=ctx.eid, sheet=sheet) or {}).get("detail") or {}
    return {"engagement_id": ctx.eid, "sheet": sheet, "seed": ctx.eng["seed"], "snapshot_seq": ctx.eng["snapshot_seq"],
            "population": meta.get("population", 0), "samples": sheet_samples(ctx, sheet),
            "evidence_requests_created": 0 if r.get("already_done") else len(r.get("evidence_requests") or []),
            "auto_ran": r["auto_ran"]}


@app.post("/samples/sales")
def samples_sales(request: Request, body: dict | None = Body(default=None)):
    target = arg(body, "target")
    return select(request, body, "sales_tod", "select_sales_tod", lambda c: select_sales_tod(c, target))


@app.post("/samples/cutoff")
def samples_cutoff(request: Request, body: dict | None = Body(default=None)):
    after, before = arg(body, "after"), arg(body, "before")
    return select(request, body, "cutoff_tod", "select_cutoff_tod", lambda c: select_cutoff_tod(c, after, before))


@app.post("/samples/credit-notes")
def samples_credit_notes(request: Request, body: dict | None = Body(default=None)):
    return select(request, body, "credit_note_tod", "select_credit_note_tod", select_credit_note_tod)


@app.get("/samples")
def get_samples(request: Request, sheet: str, engagement_id: str | None = None):
    ident = who(request)
    ctx = engine().ctx(engagement_id, ident)
    return {"engagement_id": ctx.eid, "sheet": sheet, "samples": sheet_samples(ctx, sheet)}


# Evidence


def requests_view(ctx) -> list[dict]:
    smp = {s["sample_id"]: s for s in engine().repo.select(samples, engagement_id=ctx.eid)}
    out = []
    for r in request_status(ctx):
        s = smp.get(r["sample_id"]) or {}
        d = s.get("data") or {}
        number = d.get("credit_note_no") or d.get("bill_no") or s.get("subject_id")
        out.append({"request_id": r["request_id"], "engagement_id": ctx.eid, "sample_id": r["sample_id"],
                    "sheet": s.get("sheet"), "document_type": r["document_type"],
                    "subject": {"invoice_no": number, "date": d.get("date"), "customer": d.get("customer"),
                                "amount": d.get("taxable", 0)},
                    "status": EVIDENCE_STATUS.get(r["status"], r["status"]), "file_hash": r["file_hash"],
                    "note": r["note"]})
    return out


@app.get("/evidence/status")
def get_evidence_status(request: Request, engagement_id: str | None = None):
    ident = who(request)
    ctx = engine().ctx(engagement_id, ident)
    by_sample: dict[str, dict] = {}
    counts = Counter()
    for r in requests_view(ctx):
        entry = by_sample.setdefault(r["sample_id"], {"sample_id": r["sample_id"], "sheet": r["sheet"], "documents": []})
        entry["documents"].append({"document_type": r["document_type"], "status": r["status"], "file_hash": r["file_hash"]})
        counts[r["status"]] += 1
    return {"engagement_id": ctx.eid, "samples": list(by_sample.values()), "pending": counts["pending"],
            "received": counts["received"], "verified": counts["verified"], "declined": counts["declined"]}


@app.get("/evidence/requests")
def list_evidence_requests(request: Request, status: str | None = None, limit: int = 50, cursor: str | None = None,
                           engagement_id: str | None = None):
    ident = who(request, ("client_employee",) + AUDIT)
    e = engine()
    if engagement_id:
        targets = [engagement_id]
    else:
        targets = [x["engagement_id"] for x in e.repo.open_engagements()]
    rows = []
    for eid in targets:
        rows += requests_view(e.ctx(eid, ident))
    if status:
        rows = [r for r in rows if r["status"] == status or (status == "received" and r["status"] in ("verified", "declined"))]
    start = int(base64.urlsafe_b64decode(cursor.encode()).decode()) if cursor else 0
    limit = max(1, min(int(limit or 50), 500))
    page = rows[start:start + limit]
    nxt = base64.urlsafe_b64encode(str(start + limit).encode()).decode() if start + limit < len(rows) else None
    return {"requests": page, "next_cursor": nxt}


@app.post("/evidence/requests")
def post_evidence_requests(request: Request, body: dict = Body(default={})):
    ident = who(request)
    ctx = engine().ctx(body.get("engagement_id"), ident, allow_closed=False)
    ids = body.get("sample_ids") or ([body["sample_id"]] if body.get("sample_id") else [])
    docs = body.get("document_types") or ([body["document_type"]] if body.get("document_type") else [])
    if not ids or not docs:
        raise EngineError("VALIDATION_FAILED", "sample_ids and document_types are required.",
                          "Pass the samples and the document types to request.")
    created = [request_evidence(ctx, sid, doc, body.get("note", ""))["request_id"] for sid in ids for doc in docs]
    return {"engagement_id": ctx.eid, "requests_created": len(created), "request_ids": created}


@app.post("/evidence/verify")
def post_verify_evidence(request: Request, body: dict | None = Body(default=None)):
    ident = who(request)
    e = engine()
    ctx = e.ctx(arg(body, "engagement_id"), ident, allow_closed=False)
    out = verify_evidence(ctx, arg(body, "sample_id"))
    e.repo.mark_step(ctx.eid, "verify_evidence", {"by_status": out["by_status"]}, ident["user"])
    results = [{"sample_id": r["sample_id"], "status": r["status"], "tests": r.get("tests") or {},
                "checks": [{"check_id": c.get("check"), "result": c.get("result"), "detail": c.get("detail"),
                            "document_type": c.get("document")} for c in r.get("checks") or []]}
               for r in out["results"]]
    return {"engagement_id": ctx.eid, "results": results, "by_status": out["by_status"],
            "findings_created": out["findings_raised"], "control_requests": out["control_requests"]}


# Changes, integrity, findings


@app.post("/changes/check")
def post_changes(request: Request, body: dict | None = Body(default=None)):
    ident = who(request)
    e = engine()
    ctx = e.ctx(arg(body, "engagement_id"), ident)
    out = check_post_testing_changes(ctx)
    e.repo.mark_step(ctx.eid, "check_post_testing_changes", {"examined": out["events_examined"]}, ident["user"])
    changes = []
    for row in e.repo.select(change_matches, order_by=change_matches.c.seq, engagement_id=ctx.eid):
        det = row["detail"] or {}
        if det.get("matched"):
            changes.append({"seq": row["seq"], "event_type": det.get("event_type"),
                            "identity_user": det.get("identity_user"), "recorded_at": det.get("recorded_at"),
                            "sample_ids": det.get("sample_ids") or [], "finding_ids": det.get("finding_ids") or [],
                            "why": det.get("why")})
    return {"engagement_id": ctx.eid, "changes": changes, "findings_created": out["findings_raised"],
            "head_seq": out["head_seq"]}


@app.post("/integrity/report")
def post_integrity(request: Request, body: dict = Body(default={})):
    ident = who(request)
    e = engine()
    ctx = e.ctx(body.get("engagement_id"), ident)
    out = integrity_report(ctx, body.get("business_chain"), body.get("trail_chain"), body.get("snapshot_match"))
    e.repo.mark_step(ctx.eid, "verify_ledger_integrity", {"findings": out["findings_created"]}, ident["user"])
    return {"engagement_id": ctx.eid, "findings_created": out["findings_created"]}


def finding_record(f: dict, full: bool = False) -> dict:
    subj = dict(f["subject"])
    subj["type"] = SUBJECT_TYPES.get(subj.get("type"), subj.get("type"))
    if not subj.get("label"):
        subj["label"] = subj["id"]
    rec = {k: f.get(k) for k in ("finding_id", "engagement_id", "detector_id", "category", "subtype", "severity",
                                 "title", "amount_impact", "period_effect", "reason", "sample_ids", "status",
                                 "decided_by", "created_at", "standard_refs")}
    rec["subject"] = subj
    rec["decided_at"] = f.get("decided_at")
    rec["decision_note"] = f.get("decision_note")
    if full:
        rec["proposed_adjustment"] = [{"account": l["account"], "debit": l["debit"], "credit": l["credit"],
                                       "narration": l.get("narration", "")} for l in f.get("proposed_adjustment") or []]
        lin = dict(f.get("lineage") or {})
        lin["values"] = lin.pop("facts", {})
        rec["lineage"] = lin
    return rec


def decorated_findings(ctx) -> list[dict]:
    from .repo import finding_decisions

    latest = {}
    for d in engine().repo.select(finding_decisions, order_by=finding_decisions.c.id, engagement_id=ctx.eid):
        latest[d["finding_id"]] = d
    out = []
    for f in all_findings(ctx):
        d = latest.get(f["finding_id"])
        if d:
            f["decided_at"], f["decision_note"] = d["at"], d["note"]
        out.append(f)
    return out


@app.get("/findings")
def get_findings(request: Request, engagement_id: str | None = None, category: str | None = None,
                 severity: str | None = None, status: str | None = None, sample_id: str | None = None,
                 detector_id: str | None = None, limit: int = 50, cursor: str | None = None):
    ident = who(request)
    ctx = engine().ctx(engagement_id, ident)
    items = decorated_findings(ctx)
    if category:
        items = [f for f in items if f["category"] == category.upper()]
    if severity:
        items = [f for f in items if f["severity"].lower() == severity.lower()]
    if status:
        items = [f for f in items if f["status"] == status]
    if sample_id:
        items = [f for f in items if sample_id in (f.get("sample_ids") or [])]
    if detector_id:
        items = [f for f in items if f["detector_id"] == detector_id.upper()]
    start = int(base64.urlsafe_b64decode(cursor.encode()).decode()) if cursor else 0
    limit = max(1, min(int(limit or 50), 500))
    page = items[start:start + limit]
    nxt = base64.urlsafe_b64encode(str(start + limit).encode()).decode() if start + limit < len(items) else None
    sev = Counter(f["severity"] for f in items)
    return {"engagement_id": ctx.eid, "findings": [finding_record(f) for f in page], "next_cursor": nxt,
            "totals": {"count": len(items), "by_severity": {k: sev.get(k, 0) for k in ("High", "Medium", "Low")},
                       "by_category": dict(Counter(f["category"] for f in items))}}


def locate(finding_id: str, ident: dict):
    e = engine()
    from .repo import findings as findings_table

    row = e.repo.first(findings_table, finding_id=finding_id)
    if not row:
        raise EngineError("NOT_FOUND", f"Finding {finding_id} does not exist.", "Call get_findings for valid identifiers.")
    return e.ctx(row["engagement_id"], ident)


@app.get("/findings/{finding_id}/explain")
def explain(request: Request, finding_id: str):
    ident = who(request)
    ctx = locate(finding_id, ident)
    f = next(x for x in decorated_findings(ctx) if x["finding_id"] == finding_id)
    rec = finding_record(f, full=True)
    docs = []
    for seq in (f.get("lineage") or {}).get("event_seqs", [])[:40]:
        ev = ctx.snap.events_by_seq.get(seq) or next(iter(engine().business.events(after_seq=seq - 1, upto_seq=seq)), None)
        if ev:
            p = ev.get("payload") or {}
            ref = next((p.get(k) for k in ("invoice_no", "credit_note_no", "order_no", "lr_no", "ewb_no", "receipt_id",
                                           "journal_id", "file_name") if p.get(k)), None)
            docs.append({"seq": ev["seq"], "event_type": ev["event_type"], "document_id": ev["aggregate_id"],
                         "reference": ref or ev["aggregate_id"], "business_date": ev.get("business_date"),
                         "recorded_at": ev.get("recorded_at"), "recorded_by": (ev.get("identity") or {}).get("user"),
                         "hash": ev.get("hash")})
    rec["explanation"] = f["reason"]
    rec["documents"] = docs
    return rec


@app.post("/findings/{finding_id}/decisions")
def decide(request: Request, finding_id: str, body: dict = Body(default={})):
    ident = who(request, ("audit_manager",))
    ctx = locate(finding_id, ident)
    out = confirm_finding(ctx, finding_id, body.get("decision", ""), body.get("note") or "")
    return {"finding_id": finding_id, "engagement_id": ctx.eid, "status": out["status"],
            "decided_by": out["decided_by"], "decided_at": out["decided_at"]}


@app.post("/engagements/sign-off")
def post_sign_off(request: Request, body: dict | None = Body(default=None)):
    ident = who(request, ("audit_manager",))
    ident["note"] = arg(body, "note")
    ctx = engine().ctx(arg(body, "engagement_id"), ident)
    out = sign_off(ctx)
    if not out["closed"]:
        raise EngineError("VALIDATION_FAILED",
                          f"{len(out['undecided'])} findings have no final decision: {', '.join(out['undecided'][:20])}"
                          + (" ..." if len(out["undecided"]) > 20 else ""),
                          "Call confirm_finding with confirmed or rejected for each finding.")
    return {"engagement_id": ctx.eid, "signed_by": ident["user"],
            "signed_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}


# Graph and outputs


@app.get("/graph")
def graph(request: Request, engagement_id: str | None = None):
    ident = who(request)
    ctx = engine().ctx(engagement_id, ident)
    g = build_graph(ctx)
    cyc = {f["subject"]["id"]: f["finding_id"] for f in engine().repo.findings(ctx.eid) if f["detector_id"] == "D-04"}

    def kind(n):
        if n["is_company"]:
            return "company" if any(m["key"] in {f"CO:{x}" for x in (ctx.entities or ["E1"])} for m in n["members"]) else "entity"
        ks = set(n["kinds"]) - {"disclosed", "officer"}
        return "customer" if ks == {"customer"} else "vendor" if ks == {"vendor"} else "cluster"

    return {"engagement_id": ctx.eid,
            "nodes": [{"id": n["id"], "label": n["label"], "kind": kind(n), "related": n["related_party"]} for n in g["nodes"]],
            "edges": [{"source": e["from"], "target": e["to"], "kind": e["type"], "value": e["value"], "count": e["count"]}
                      for e in g["edges"]],
            "cycles": [{"finding_id": cyc.get(f"{c['type']}:" + ">".join(c["nodes"])), "path": c["nodes"],
                        "value": c["min_value"], "kind": c["type"]} for c in g["cycles"]]}


def file_ref(f: dict) -> dict:
    return {"file_hash": f["file_hash"], "file_name": f["file_name"], "content_type": f["content_type"]}


@app.post("/memo")
def post_memo(request: Request, body: dict | None = Body(default=None)):
    ident = who(request)
    e = engine()
    ctx = e.ctx(arg(body, "engagement_id"), ident)
    out = draft_findings_memo(ctx, arg(body, "format", "both"))
    e.repo.mark_step(ctx.eid, "draft_findings_memo", {"files": [f["file_hash"] for f in out["files"]]}, ident["user"])
    from .outputs.memo import revenue_adjustment

    fs = all_findings(e.ctx(ctx.eid, ident))
    return {"engagement_id": ctx.eid, "files": [file_ref(f) for f in out["files"]], "findings": len(fs),
            "total_adjustment": revenue_adjustment(fs), "head_hash": out["files"][0]["head_hash"] if out["files"] else None}


@app.post("/summary")
def post_summary(request: Request, body: dict | None = Body(default=None)):
    """One page for the engagement partner. It is not a step of the plan and can be produced at any time."""
    ident = who(request)
    ctx = engine().ctx(arg(body, "engagement_id"), ident)
    out = export_summary(ctx)
    return {"engagement_id": ctx.eid, "summary": out["summary"], "file": file_ref(out["file"]),
            "head_hash": out["file"]["head_hash"]}


@app.post("/workpaper")
def post_workpaper(request: Request, body: dict | None = Body(default=None)):
    ident = who(request)
    e = engine()
    ctx = e.ctx(arg(body, "engagement_id"), ident)
    out = export_workpaper(ctx)
    e.repo.mark_step(ctx.eid, "export_workpaper", {"file_hash": out["file_hash"]}, ident["user"])
    return {"engagement_id": ctx.eid, "file": file_ref(out), "sheets": out["sheets"], "head_hash": out["head_hash"]}


def main() -> None:
    import uvicorn

    addr = os.environ.get("ENGINE_ADDR", "")
    port = int(addr.rsplit(":", 1)[-1]) if addr else int(os.environ.get("ENGINE_PORT", "7002"))
    uvicorn.run("audit_engine.api:app", host=os.environ.get("ENGINE_HOST", "0.0.0.0"), port=port, workers=1)


if __name__ == "__main__":
    main()
