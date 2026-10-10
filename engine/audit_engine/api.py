"""HTTP API of the audit engine (contracts/engine-api). Served on engine:7002 to the MCP server.

Identity arrives in X-Identity-User and X-Identity-Role, set by the MCP server
from the bearer token. The engine checks the role again (defence in depth).
"""

from __future__ import annotations

import base64
import os
from functools import lru_cache
from typing import Any

from fastapi import Body, FastAPI, Header, Request
from fastapi.responses import JSONResponse, Response

from . import __version__
from .changes import check_post_testing_changes
from .engine import Engine, EngineError
from .evidence.service import evidence_status, request_evidence, request_status, verify_evidence
from .findings_service import confirm_finding, explain_finding, get_findings, sign_off
from .graph import build_graph
from .integrity import verify_ledger_integrity
from .outputs import draft_findings_memo, export_workpaper
from .repo import outputs
from .snapshot import d

AUDIT = ("auditor", "audit_manager")
CLIENT = ("client_employee",)

app = FastAPI(title="ELEV05 audit engine", version=__version__)


@lru_cache(maxsize=1)
def engine() -> Engine:
    return Engine()


@app.exception_handler(EngineError)
async def _engine_error(_: Request, exc: EngineError):
    return JSONResponse(status_code=exc.status, content=exc.body())


@app.exception_handler(Exception)
async def _any_error(_: Request, exc: Exception):
    return JSONResponse(status_code=500, content={"code": "INTERNAL", "message": str(exc)[:500],
                                                  "next_step": "Retry. If it persists, report the message."})


def who(user: str | None, role: str | None, allowed: tuple[str, ...]) -> dict:
    if not user or not role:
        raise EngineError("PERMISSION_DENIED", "Identity headers are missing.", "Call through the MCP server.")
    if role not in allowed:
        raise EngineError("PERMISSION_DENIED", f"Role {role} may not call this endpoint.",
                          "Use a tool listed for your role.")
    return {"user": user, "role": role}


def body_get(body: dict | None, key: str, default=None):
    return (body or {}).get(key, default)


@app.get("/health")
def health() -> dict:
    head = engine().business.head()
    return {"ok": True, "version": __version__, "head_seq": head[0]}


@app.get("/plan")
def plan(engagement_id: str | None = None, x_identity_user: str | None = Header(None),
         x_identity_role: str | None = Header(None)):
    who(x_identity_user, x_identity_role, AUDIT)
    return engine().plan(engagement_id)


@app.post("/engagements")
def open_engagement(body: dict = Body(...), x_identity_user: str | None = Header(None),
                    x_identity_role: str | None = Header(None)):
    ident = who(x_identity_user, x_identity_role, AUDIT)
    for k in ("period_start", "period_end"):
        if not body.get(k):
            raise EngineError("VALIDATION_FAILED", f"{k} is required.", "Pass period_start and period_end as YYYY-MM-DD.")
    return engine().open_engagement(body["period_start"], body["period_end"], body.get("seed"),
                                    body.get("entity_ids"), body.get("client_name"), ident)


@app.get("/engagements/status")
def engagement_status(engagement_id: str | None = None, x_identity_user: str | None = Header(None),
                      x_identity_role: str | None = Header(None)):
    who(x_identity_user, x_identity_role, AUDIT)
    return engine().status(engagement_id)


def _step(step: str, body: dict | None, user, role):
    ident = who(user, role, AUDIT)
    return engine().step(step, body_get(body, "engagement_id"), ident)


@app.post("/register/import")
def import_register(body: dict | None = Body(None), x_identity_user: str | None = Header(None),
                    x_identity_role: str | None = Header(None)):
    return _step("import_register", body, x_identity_user, x_identity_role)


@app.post("/register/reconcile")
def reconcile_register(body: dict | None = Body(None), x_identity_user: str | None = Header(None),
                       x_identity_role: str | None = Header(None)):
    return _step("reconcile_register", body, x_identity_user, x_identity_role)


@app.post("/related-parties/tag")
def tag_related_parties(body: dict | None = Body(None), x_identity_user: str | None = Header(None),
                        x_identity_role: str | None = Header(None)):
    return _step("tag_related_parties", body, x_identity_user, x_identity_role)


@app.post("/detectors/run")
def run_detectors(body: dict | None = Body(None), x_identity_user: str | None = Header(None),
                  x_identity_role: str | None = Header(None)):
    return _step("run_detectors", body, x_identity_user, x_identity_role)


@app.post("/samples/sales")
def samples_sales(body: dict | None = Body(None), x_identity_user: str | None = Header(None),
                  x_identity_role: str | None = Header(None)):
    return _step("select_sales_tod", body, x_identity_user, x_identity_role)


@app.post("/samples/cutoff")
def samples_cutoff(body: dict | None = Body(None), x_identity_user: str | None = Header(None),
                   x_identity_role: str | None = Header(None)):
    ident = who(x_identity_user, x_identity_role, AUDIT)
    e = engine()
    ctx = e.ctx(body_get(body, "engagement_id"), ident, allow_closed=False)
    after = body_get(body, "after_count")
    from .sampling import select_cutoff_tod

    return e.run_step(ctx, "select_cutoff_tod", lambda c: select_cutoff_tod(c, after))


@app.post("/samples/credit-notes")
def samples_cn(body: dict | None = Body(None), x_identity_user: str | None = Header(None),
               x_identity_role: str | None = Header(None)):
    return _step("select_credit_note_tod", body, x_identity_user, x_identity_role)


@app.get("/evidence/status")
def get_evidence_status(engagement_id: str | None = None, sample_id: str | None = None,
                        x_identity_user: str | None = Header(None), x_identity_role: str | None = Header(None)):
    ident = who(x_identity_user, x_identity_role, AUDIT)
    return evidence_status(engine().ctx(engagement_id, ident), sample_id)


@app.get("/evidence/requests")
def list_evidence_requests(engagement_id: str | None = None, status: str | None = None,
                           x_identity_user: str | None = Header(None), x_identity_role: str | None = Header(None)):
    ident = who(x_identity_user, x_identity_role, CLIENT + AUDIT)
    rows = request_status(engine().ctx(engagement_id, ident))
    if status:
        rows = [r for r in rows if r["status"] == status]
    return {"requests": rows, "next_step": "Upload each requested document with upload_evidence, passing "
                                           "sample_id, request_id and document_type."}


@app.post("/evidence/requests")
def post_evidence_request(body: dict = Body(...), x_identity_user: str | None = Header(None),
                          x_identity_role: str | None = Header(None)):
    ident = who(x_identity_user, x_identity_role, AUDIT)
    ctx = engine().ctx(body.get("engagement_id"), ident, allow_closed=False)
    if not body.get("sample_id") or not body.get("document_type"):
        raise EngineError("VALIDATION_FAILED", "sample_id and document_type are required.", "")
    return request_evidence(ctx, body["sample_id"], body["document_type"], body.get("note", ""))


@app.post("/evidence/verify")
def post_verify_evidence(body: dict | None = Body(None), x_identity_user: str | None = Header(None),
                         x_identity_role: str | None = Header(None)):
    ident = who(x_identity_user, x_identity_role, AUDIT)
    ctx = engine().ctx(body_get(body, "engagement_id"), ident, allow_closed=False)
    out = verify_evidence(ctx, body_get(body, "sample_id"))
    engine().repo.mark_step(ctx.eid, "verify_evidence", {"by_status": out["by_status"]}, ident["user"])
    return out


@app.post("/changes/check")
def post_changes(body: dict | None = Body(None), x_identity_user: str | None = Header(None),
                 x_identity_role: str | None = Header(None)):
    ident = who(x_identity_user, x_identity_role, AUDIT)
    ctx = engine().ctx(body_get(body, "engagement_id"), ident)
    out = check_post_testing_changes(ctx)
    engine().repo.mark_step(ctx.eid, "check_post_testing_changes", {"examined": out["events_examined"]}, ident["user"])
    return out


@app.post("/integrity/verify")
def post_integrity(body: dict | None = Body(None), x_identity_user: str | None = Header(None),
                   x_identity_role: str | None = Header(None)):
    ident = who(x_identity_user, x_identity_role, AUDIT)
    ctx = engine().ctx(body_get(body, "engagement_id"), ident)
    out = verify_ledger_integrity(ctx, body_get(body, "ledger_result"))
    engine().repo.mark_step(ctx.eid, "verify_ledger_integrity", {"ok": out["business"]["ok"]}, ident["user"])
    return out


@app.get("/findings")
def list_findings(engagement_id: str | None = None, category: str | None = None, severity: str | None = None,
                  status: str | None = None, detector_id: str | None = None, limit: int = 50, cursor: str | None = None,
                  x_identity_user: str | None = Header(None), x_identity_role: str | None = Header(None)):
    ident = who(x_identity_user, x_identity_role, AUDIT)
    return get_findings(engine().ctx(engagement_id, ident), category, severity, status, detector_id, limit, cursor)


@app.get("/findings/{finding_id}/explain")
def get_explain(finding_id: str, engagement_id: str | None = None, x_identity_user: str | None = Header(None),
                x_identity_role: str | None = Header(None)):
    ident = who(x_identity_user, x_identity_role, AUDIT)
    return explain_finding(engine().ctx(engagement_id, ident), finding_id)


@app.post("/findings/{finding_id}/decisions")
def post_decision(finding_id: str, body: dict = Body(...), x_identity_user: str | None = Header(None),
                  x_identity_role: str | None = Header(None)):
    ident = who(x_identity_user, x_identity_role, ("audit_manager",))
    ctx = engine().ctx(body.get("engagement_id"), ident)
    return confirm_finding(ctx, finding_id, body.get("decision", ""), body.get("note", ""))


@app.post("/engagements/sign-off")
def post_sign_off(body: dict | None = Body(None), x_identity_user: str | None = Header(None),
                  x_identity_role: str | None = Header(None)):
    ident = who(x_identity_user, x_identity_role, ("audit_manager",))
    return sign_off(engine().ctx(body_get(body, "engagement_id"), ident))


@app.post("/memo")
def post_memo(body: dict | None = Body(None), x_identity_user: str | None = Header(None),
              x_identity_role: str | None = Header(None)):
    ident = who(x_identity_user, x_identity_role, AUDIT)
    ctx = engine().ctx(body_get(body, "engagement_id"), ident)
    out = draft_findings_memo(ctx, body_get(body, "format", "both"), body_get(body, "ledger_result"))
    engine().repo.mark_step(ctx.eid, "draft_findings_memo", {"files": [f["file_hash"] for f in out["files"]]},
                            ident["user"])
    return out


@app.post("/workpaper")
def post_workpaper(body: dict | None = Body(None), x_identity_user: str | None = Header(None),
                   x_identity_role: str | None = Header(None)):
    ident = who(x_identity_user, x_identity_role, AUDIT)
    ctx = engine().ctx(body_get(body, "engagement_id"), ident)
    out = export_workpaper(ctx)
    engine().repo.mark_step(ctx.eid, "export_workpaper", {"file_hash": out["file_hash"]}, ident["user"])
    return out


@app.get("/files/{file_hash}")
def get_file(file_hash: str, x_identity_user: str | None = Header(None), x_identity_role: str | None = Header(None)):
    who(x_identity_user, x_identity_role, AUDIT)
    row = next((r for r in engine().repo.select(outputs, file_hash=file_hash)), None)
    if row is None:
        raise EngineError("NOT_FOUND", "No output with that hash.", "Call export_workpaper or draft_findings_memo.")
    media = {"xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
             "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
             "md": "text/markdown; charset=utf-8"}[row["kind"]]
    name = os.path.basename(row["path"] or f"{file_hash}.{row['kind']}")
    return Response(engine().files.get(file_hash), media_type=media,
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


# Supporting read tools (PRD 9.4).

RECORD_TYPES = {
    "invoice": lambda s: s.invoices, "order": lambda s: list(s.orders.values()),
    "dispatch": lambda s: list(s.dispatches.values()), "delivery": lambda s: [x for v in s.deliveries.values() for x in v],
    "eway_bill": lambda s: s.ewbs, "lr": lambda s: s.lrs, "receipt": lambda s: s.receipts,
    "bank_line": lambda s: s.bank_lines, "credit_note": lambda s: s.credit_notes, "sales_return": lambda s: s.sales_returns,
    "purchase": lambda s: s.purchases, "goods_receipt": lambda s: s.goods_receipts, "payment": lambda s: s.payments,
    "journal": lambda s: s.journals, "gstr1_line": lambda s: s.gstr1_lines, "enquiry": lambda s: list(s.enquiries.values()),
    "promotion": lambda s: list(s.promotions.values()), "officer": lambda s: list(s.officers.values()),
    "customer": lambda s: [dict(p.state, customer_id=k, versions=len(p.versions)) for k, p in s.customers.items()],
    "vendor": lambda s: [dict(p.state, vendor_id=k, versions=len(p.versions)) for k, p in s.vendors.items()],
}


def _page(items: list, limit: int, cursor: str | None) -> tuple[list, str | None]:
    start = int(base64.urlsafe_b64decode(cursor.encode()).decode()) if cursor else 0
    limit = max(1, min(int(limit or 50), 500))
    nxt = base64.urlsafe_b64encode(str(start + limit).encode()).decode() if start + limit < len(items) else None
    return items[start:start + limit], nxt


def _clean(doc: dict) -> dict:
    """Payload fields plus a meta object. Underscore keys are not returned: FastAPI drops keys starting with _sa."""
    out = {k: v for k, v in doc.items() if not k.startswith("_")}
    out["meta"] = {k[1:]: doc.get(k) for k in ("_seq", "_sale_id", "_business_date", "_recorded_at", "_aggregate_id",
                                               "_entity_id", "_event_type") if k in doc}
    if "_reversed" in doc:
        out["meta"]["reversed_by_seq"] = (doc["_reversed"] or {}).get("_seq")
    return out


@app.post("/records/query")
def query_records(body: dict = Body(...), x_identity_user: str | None = Header(None),
                  x_identity_role: str | None = Header(None)):
    ident = who(x_identity_user, x_identity_role, AUDIT)
    ctx = engine().ctx(body.get("engagement_id"), ident)
    rtype = body.get("record_type")
    if rtype not in RECORD_TYPES:
        raise EngineError("VALIDATION_FAILED", f"record_type must be one of {', '.join(sorted(RECORD_TYPES))}.", "")
    items = RECORD_TYPES[rtype](ctx.snap)
    filters: dict[str, Any] = body.get("filters") or {}
    date_from, date_to = d(filters.pop("date_from", None)), d(filters.pop("date_to", None))
    out = []
    for doc in items:
        if any(str(doc.get(k)) != str(v) for k, v in filters.items()):
            continue
        day = d(doc.get("invoice_date") or doc.get("date") or doc.get("order_date") or doc.get("_business_date"))
        if (date_from and (not day or day < date_from)) or (date_to and (not day or day > date_to)):
            continue
        out.append(_clean(doc))
    page, nxt = _page(out, body.get("limit", 50), body.get("cursor"))
    return {"items": page, "total": len(out), "next_cursor": nxt}


@app.get("/sales/{sale_id}/chain")
def sale_chain(sale_id: str, engagement_id: str | None = None, x_identity_user: str | None = Header(None),
               x_identity_role: str | None = Header(None)):
    ident = who(x_identity_user, x_identity_role, AUDIT)
    ctx = engine().ctx(engagement_id, ident)
    evs = ctx.snap.events_by_sale.get(sale_id)
    if not evs:
        raise EngineError("NOT_FOUND", f"No events for sale {sale_id} in the snapshot.", "Use query_records to find a sale_id.")
    return {"sale_id": sale_id, "events": evs}


@app.get("/ledger/entries")
def ledger_entries(engagement_id: str | None = None, account: str | None = None, date_from: str | None = None,
                   date_to: str | None = None, sale_id: str | None = None, limit: int = 100, cursor: str | None = None,
                   x_identity_user: str | None = Header(None), x_identity_role: str | None = Header(None)):
    ident = who(x_identity_user, x_identity_role, AUDIT)
    ctx = engine().ctx(engagement_id, ident)
    df, dt_ = d(date_from), d(date_to)
    rows = [p for p in ctx.snap.postings
            if (not account or p["account"] == account) and (not sale_id or p["sale_id"] == sale_id)
            and (not df or d(p["business_date"]) >= df) and (not dt_ or d(p["business_date"]) <= dt_)]
    page, nxt = _page(rows, limit, cursor)
    return {"items": page, "total": len(rows), "debit": sum(p["debit"] for p in rows),
            "credit": sum(p["credit"] for p in rows), "next_cursor": nxt}


@app.get("/graph")
def graph(engagement_id: str | None = None, x_identity_user: str | None = Header(None),
          x_identity_role: str | None = Header(None)):
    ident = who(x_identity_user, x_identity_role, AUDIT)
    ctx = engine().ctx(engagement_id, ident)
    g = build_graph(ctx)
    cyc_findings = {f["subject"]["id"]: f["finding_id"] for f in engine().repo.findings(ctx.eid)
                    if f["detector_id"] == "D-04"}
    cycles = [dict(c, finding_id=cyc_findings.get(f"{c['type']}:" + ">".join(c["nodes"]))) for c in g["cycles"]]
    return {"nodes": g["nodes"], "edges": g["edges"], "cycles": cycles}


def main() -> None:
    import uvicorn

    uvicorn.run("audit_engine.api:app", host=os.environ.get("ENGINE_HOST", "0.0.0.0"),
                port=int(os.environ.get("ENGINE_PORT", "7002")), workers=1)


if __name__ == "__main__":
    main()
