"""Reading, explaining and deciding findings (PRD 15.3, 9.5)."""

from __future__ import annotations

import base64
import datetime as dt
from collections import defaultdict

from .findings import STANDARD_REFS
from .repo import engagement_events, finding_decisions, samples

SEVERITY_ORDER = {"High": 0, "Medium": 1, "Low": 2}
DECISIONS = ("confirmed", "rejected", "needs_info")


def sample_links(ctx) -> dict[str, list[str]]:
    """finding_id -> sample ids, from sample finding refs and finding lineage."""
    rows = ctx.engine.repo.select(samples, engagement_id=ctx.eid)
    by_doc = defaultdict(set)
    out = defaultdict(set)
    for s in rows:
        by_doc[str(s["subject_id"])].add(s["sample_id"])
        for ref in (s["data"] or {}).get("finding_refs") or []:
            out[ref].add(s["sample_id"])
    for f in ctx.engine.repo.findings(ctx.eid):
        for sid in f.get("sample_ids") or []:
            out[f["finding_id"]].add(sid)
        if f["subject"]["type"] in ("invoice", "credit_note"):
            for sid in by_doc.get(f["subject"]["id"].split("#")[0], ()):
                out[f["finding_id"]].add(sid)
    return {k: sorted(v) for k, v in out.items()}


def all_findings(ctx) -> list[dict]:
    links = sample_links(ctx)
    items = []
    for f in ctx.engine.repo.findings(ctx.eid):
        f = dict(f)
        f["sample_ids"] = sorted(set(f.get("sample_ids") or []) | set(links.get(f["finding_id"], [])))
        items.append(f)
    items.sort(key=lambda f: (SEVERITY_ORDER[f["severity"]], f["detector_id"], -abs(f["amount_impact"]), f["finding_id"]))
    return items


def get_findings(ctx, category: str | None = None, severity: str | None = None, status: str | None = None,
                 detector_id: str | None = None, limit: int = 50, cursor: str | None = None) -> dict:
    items = all_findings(ctx)
    if category:
        items = [f for f in items if f["category"] == category.upper()]
    if severity:
        items = [f for f in items if f["severity"].lower() == severity.lower()]
    if status:
        items = [f for f in items if f["status"] == status]
    if detector_id:
        items = [f for f in items if f["detector_id"] == detector_id.upper()]
    start = int(base64.urlsafe_b64decode(cursor.encode()).decode()) if cursor else 0
    limit = max(1, min(int(limit or 50), 500))
    page = items[start:start + limit]
    nxt = base64.urlsafe_b64encode(str(start + limit).encode()).decode() if start + limit < len(items) else None
    compact = [{"finding_id": f["finding_id"], "detector_id": f["detector_id"], "category": f["category"],
                "subtype": f["subtype"], "severity": f["severity"], "title": f["title"], "subject": f["subject"],
                "amount_impact": f["amount_impact"], "period_effect": f["period_effect"], "status": f["status"],
                "sample_ids": f["sample_ids"]} for f in page]
    counts = defaultdict(int)
    for f in items:
        counts[f["severity"]] += 1
    return {"items": compact, "total": len(items), "by_severity": dict(counts), "next_cursor": nxt}


def explain_finding(ctx, finding_id: str) -> dict:
    from .engine import EngineError

    f = next((x for x in all_findings(ctx) if x["finding_id"] == finding_id), None)
    if f is None:
        raise EngineError("NOT_FOUND", f"Finding {finding_id} does not exist in this engagement.",
                          "Call get_findings to list finding IDs.")
    events = []
    for seq in f["lineage"]["event_seqs"][:50]:
        ev = ctx.snap.events_by_seq.get(seq)
        if ev is None:
            ev = next(iter(ctx.engine.business.events(after_seq=seq - 1, upto_seq=seq)), None)
        if ev:
            events.append({"seq": ev["seq"], "event_type": ev["event_type"], "aggregate_id": ev["aggregate_id"],
                           "business_date": ev["business_date"], "recorded_at": ev["recorded_at"],
                           "identity": ev.get("identity"), "hash": ev["hash"]})
    decisions = [{"decision": r["decision"], "note": r["note"], "by": r["identity"], "role": r["role"], "at": r["at"]}
                 for r in ctx.engine.repo.select(finding_decisions, order_by=finding_decisions.c.id,
                                                 finding_id=finding_id)]
    return {"finding": f, "reason": f["reason"], "lineage": f["lineage"], "events": events,
            "standard_refs": f["standard_refs"] or STANDARD_REFS.get(f["category"], []),
            "proposed_adjustment": f["proposed_adjustment"], "decisions": decisions,
            "status_text": "Pending auditor confirmation" if f["status"] == "proposed" else f["status"]}


def confirm_finding(ctx, finding_id: str, decision: str, note: str = "") -> dict:
    from .engine import EngineError

    if ctx.identity.get("role") != "audit_manager":
        raise EngineError("PERMISSION_DENIED", "Only the audit_manager role may confirm or reject findings.",
                          "Ask a human audit manager to review the finding.")
    if decision not in DECISIONS:
        raise EngineError("VALIDATION_FAILED", f"decision must be one of {', '.join(DECISIONS)}.", "")
    if ctx.engine.repo.is_closed(ctx.eid):
        raise EngineError("ENGAGEMENT_CLOSED", "The engagement is signed off.", "")
    if not any(f["finding_id"] == finding_id for f in ctx.engine.repo.findings(ctx.eid)):
        raise EngineError("NOT_FOUND", f"Finding {finding_id} does not exist.", "Call get_findings.")
    ctx.engine.repo.insert(finding_decisions, {
        "finding_id": finding_id, "engagement_id": ctx.eid, "decision": decision, "note": note,
        "identity": ctx.identity.get("user"), "role": ctx.identity.get("role"),
        "at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")})
    return {"finding_id": finding_id, "status": decision}


def sign_off(ctx) -> dict:
    from .engine import EngineError

    if ctx.identity.get("role") != "audit_manager":
        raise EngineError("PERMISSION_DENIED", "Only the audit_manager role may sign off.", "")
    undecided = [f["finding_id"] for f in ctx.engine.repo.findings(ctx.eid) if f["status"] in ("proposed", "needs_info")]
    if undecided:
        return {"closed": False, "undecided": undecided,
                "next_step": "Call confirm_finding with confirmed or rejected for each listed finding."}
    if not ctx.engine.repo.is_closed(ctx.eid):
        ctx.engine.repo.insert(engagement_events, {
            "engagement_id": ctx.eid, "kind": "closed", "step": "sign_off_engagement", "detail": {},
            "identity": ctx.identity.get("user"),
            "at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")})
    return {"closed": True, "undecided": []}
