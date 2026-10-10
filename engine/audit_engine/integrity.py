"""Tamper evidence (PRD 16.2, detector D-16)."""

from __future__ import annotations

import datetime as dt

from . import chain


def _ledger(ctx, path: str) -> dict | None:
    url = ctx.engine.settings.ledger_url
    if not url:
        return None
    try:
        import httpx

        r = httpx.get(url.rstrip("/") + path, timeout=30)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        return {"ok": None, "error": str(e)[:200]}


def verify_ledger_integrity(ctx, ledger_result: dict | None = None) -> dict:
    """Recompute the business chain, compare the snapshot hash and Merkle root, and take the trail result
    from the ledger core (directly or as passed by the MCP server)."""
    events = list(ctx.engine.business.events())
    biz = chain.verify_chain(events)
    by_seq = {e["seq"]: e for e in events}
    snap_seq = ctx.eng["snapshot_seq"]
    at_snap = by_seq.get(snap_seq)
    snapshot_hash_ok = bool(at_snap) and at_snap["hash"] == ctx.eng["snapshot_hash"] and \
        chain.event_hash(at_snap) == ctx.eng["snapshot_hash"]
    prefix = [e for e in events if e["seq"] <= snap_seq]
    prefix_ok = chain.verify_chain(prefix)["ok"]
    merkle_now = chain.merkle_root([e["hash"] for e in prefix])
    merkle_ok = merkle_now == ctx.eng.get("merkle_root") if ctx.eng.get("merkle_root") else None
    ledger_biz = (ledger_result or {}).get("business") or _ledger(ctx, "/verify")
    trail = (ledger_result or {}).get("trail") or _ledger(ctx, "/trail/verify")
    findings = []
    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if not biz["ok"]:
        findings.append(ctx.finding(
            category="LEDGER_INTEGRITY", subtype="BUSINESS_CHAIN_BROKEN", subject_type="chain",
            subject_id=f"business:{biz['first_bad_seq']}", title=f"Business chain breaks at sequence {biz['first_bad_seq']}",
            event_seqs=[biz["first_bad_seq"]], facts=dict(biz, checked_at=now),
            reason=(f"Recomputing the business chain fails at sequence {biz['first_bad_seq']}: {biz['reason']}. "
                    f"A stored event was altered or removed after it was appended.")))
    if not snapshot_hash_ok or not prefix_ok or merkle_ok is False:
        findings.append(ctx.finding(
            category="LEDGER_INTEGRITY", subtype="SNAPSHOT_ALTERED", subject_type="chain",
            subject_id=f"snapshot:{snap_seq}", title=f"History before the snapshot at {snap_seq} has changed",
            event_seqs=[snap_seq], facts={"snapshot_seq": snap_seq, "stored_snapshot_hash": ctx.eng["snapshot_hash"],
                                          "current_hash_at_snapshot": (at_snap or {}).get("hash"),
                                          "prefix_chain_ok": prefix_ok, "merkle_ok": merkle_ok,
                                          "merkle_now": merkle_now, "merkle_stored": ctx.eng.get("merkle_root")},
            reason=(f"The hash at the snapshot sequence {snap_seq} or the Merkle root over events up to it no longer "
                    f"matches what was recorded when the engagement opened (TE-4). Events tested by the audit were "
                    f"changed afterwards.")))
    if ledger_biz and ledger_biz.get("ok") is False:
        findings.append(ctx.finding(
            category="LEDGER_INTEGRITY", subtype="LEDGER_CORE_REPORTS_BREAK", subject_type="chain",
            subject_id=f"ledger:{ledger_biz.get('first_bad_seq')}", title="Ledger core reports a broken business chain",
            facts=ledger_biz, reason=f"The ledger core's verification reports a break at {ledger_biz.get('first_bad_seq')}."))
    if trail and trail.get("ok") is False:
        findings.append(ctx.finding(
            category="LEDGER_INTEGRITY", subtype="TRAIL_CHAIN_BROKEN", subject_type="chain",
            subject_id=f"trail:{trail.get('first_bad_seq')}", title=f"Audit trail breaks at {trail.get('first_bad_seq')}",
            facts=trail, reason=f"The audit trail chain fails verification at {trail.get('first_bad_seq')}."))
    ctx.engine.save_findings(findings)
    return {"business": {"ok": biz["ok"], "first_bad_seq": biz["first_bad_seq"], "head_seq": biz["head_seq"],
                         "head_hash": biz["head_hash"], "reason": biz["reason"]},
            "ledger_core": ledger_biz, "trail": trail or {"ok": None, "note": "Trail verified by the ledger core; not configured here."},
            "snapshot_hash_ok": snapshot_hash_ok and prefix_ok, "merkle_root": merkle_now, "merkle_ok": merkle_ok,
            "findings_raised": len(findings), "checked_at": now}
