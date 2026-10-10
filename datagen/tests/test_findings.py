import pytest

from audit_engine.engine import EngineError
from audit_engine.findings_service import confirm_finding, explain_finding, get_findings, sign_off


def test_findings_list_and_explain(planted_engine):
    planted_engine.step("run_detectors")
    ctx = planted_engine.ctx()
    page = get_findings(ctx, limit=5)
    assert page["total"] > 20 and len(page["items"]) == 5 and page["next_cursor"]
    nxt = get_findings(ctx, limit=5, cursor=page["next_cursor"])
    assert nxt["items"][0]["finding_id"] != page["items"][0]["finding_id"]
    high = get_findings(ctx, severity="High", limit=500)["items"]
    assert all(f["severity"] == "High" for f in high)
    ex = explain_finding(ctx, page["items"][0]["finding_id"])
    assert ex["reason"] and ex["standard_refs"] and ex["status_text"] == "Pending auditor confirmation"
    assert ex["events"] and ex["events"][0]["hash"]


def test_only_manager_confirms(planted_engine):
    ctx = planted_engine.ctx(identity={"user": "agent", "role": "auditor"})
    fid = get_findings(ctx, limit=1)["items"][0]["finding_id"]
    with pytest.raises(EngineError) as e:
        confirm_finding(ctx, fid, "confirmed", "looks right")
    assert e.value.code == "PERMISSION_DENIED"
    mctx = planted_engine.ctx(identity={"user": "partner", "role": "audit_manager"})
    assert confirm_finding(mctx, fid, "confirmed", "agreed")["status"] == "confirmed"
    assert explain_finding(mctx, fid)["decisions"][0]["by"] == "partner"
    assert get_findings(mctx, status="confirmed")["total"] == 1
    out = sign_off(mctx)
    assert out["closed"] is False and out["undecided"]
