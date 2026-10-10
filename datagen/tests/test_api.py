import pytest
from fastapi.testclient import TestClient

from audit_engine import api
from elev_datagen.harness import engine_for

TOKEN = "test-service-token"
AUD = {"X-Service-Token": TOKEN, "X-Identity-User": "agent-1", "X-Identity-Role": "auditor"}
MGR = {"X-Service-Token": TOKEN, "X-Identity-User": "partner", "X-Identity-Role": "audit_manager"}
CLI = {"X-Service-Token": TOKEN, "X-Identity-User": "client.ops", "X-Identity-Role": "client_employee"}


@pytest.fixture(scope="module")
def monkeypatch_module():
    mp = pytest.MonkeyPatch()
    yield mp
    mp.undo()


@pytest.fixture(scope="module")
def client(datasets, tmp_path_factory, monkeypatch_module):
    e = engine_for(datasets / "planted", tmp_path_factory.mktemp("api") / "a.db")
    e.settings.service_token = TOKEN
    monkeypatch_module.setattr(api, "engine", lambda: e)
    return TestClient(api.app)


def test_service_token_and_identity(client):
    r = client.get("/plan", headers={"X-Identity-User": "x", "X-Identity-Role": "auditor"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "PERMISSION_DENIED"
    r = client.post("/engagements", json={"period_start": "2025-04-01", "period_end": "2026-03-31"}, headers=CLI)
    assert r.status_code == 403


def test_plan_before_engagement(client):
    r = client.get("/plan", headers=AUD).json()
    assert r["next_tool"] == "open_engagement"
    assert r["steps"][0] == {"step": "open", "tool": "open_engagement", "purpose": r["steps"][0]["purpose"], "status": "ready"}
    assert all(s["status"] == "blocked" for s in r["steps"][1:])
    r = client.post("/detectors/run", json={}, headers=AUD)
    assert r.status_code == 409 and r.json()["error"]["code"] == "NO_ENGAGEMENT"


def test_full_flow_contract_shapes(client):
    r = client.post("/engagements", json={"period_start": "2025-04-01", "period_end": "2026-03-31", "seed": "s1"},
                    headers=AUD)
    assert r.status_code == 200, r.text
    eng = r.json()
    assert eng["engagement_id"].startswith("eng_") and len(eng["engagement_id"]) == 20 and eng["signed_off"] is False
    assert client.get("/engagements", headers=AUD).json()["engagements"][0]["engagement_id"] == eng["engagement_id"]

    s = client.post("/samples/sales", json={"target": 28}, headers=AUD).json()
    assert s["sheet"] == "sales_tod" and len(s["samples"]) == 28 and s["evidence_requests_created"] > 0
    assert set(s["auto_ran"]) >= {"import", "reconcile", "tag", "detect"}
    smp = s["samples"][0]
    assert smp["sample_id"].startswith("smp_") and smp["reason_codes"] and "Evidence" in smp["tests"]
    assert "taxable_value" in smp and "invoice_no" in smp

    c = client.post("/samples/cutoff", json={"after": 12}, headers=AUD).json()
    assert c["sheet"] == "cutoff_tod" and sum(1 for x in c["samples"] if x["side"] == "after") == 12
    n = client.post("/samples/credit-notes", json={}, headers=AUD).json()
    assert n["sheet"] == "credit_note_tod" and n["samples"][0]["credit_note_no"]
    assert client.get("/samples", params={"sheet": "sales_tod"}, headers=AUD).json()["samples"][0]["sample_id"] == smp["sample_id"]

    reqs, cursor = [], None
    while True:
        page = client.get("/evidence/requests", params={"limit": 500, **({"cursor": cursor} if cursor else {})},
                          headers=CLI).json()
        reqs += page["requests"]
        cursor = page["next_cursor"]
        if not cursor:
            break
    assert reqs and reqs[0]["status"] == "pending" and reqs[0]["request_id"].startswith("req_")
    assert {r["document_type"] for r in reqs} >= {"invoice", "lr_copy", "credit_note", "sales_return"}
    st = client.get("/evidence/status", headers=AUD).json()
    assert st["pending"] == len(reqs) and st["samples"][0]["documents"]

    status = client.get("/engagements/status", headers=AUD).json()
    assert status["counts"]["samples_by_sheet"]["sales_tod"] == 28
    assert {x["step"]: x["status"] for x in status["steps"]}["detect"] == "done"

    rows = client.get("/register/rows", params={"limit": 5}, headers=AUD).json()
    assert len(rows["rows"]) == 5 and rows["next_cursor"] and "Bill no." in rows["rows"][0]["raw"]
    assert rows["rows"][0]["rp_tag"] in ("Related Party", "Non Related Party")
    bad = client.get("/register/rows", params={"recon_status": "NOT_IN_SYSTEM"}, headers=AUD).json()["rows"]
    assert bad and all("Not in system" in r["recon_status"] for r in bad)

    f = client.get("/findings", params={"severity": "High", "limit": 5}, headers=AUD).json()
    assert f["findings"] and f["next_cursor"] and f["totals"]["count"] > 5
    fid = f["findings"][0]["finding_id"]
    assert fid.startswith("fnd_") and "lineage" not in f["findings"][0]
    ex = client.get(f"/findings/{fid}/explain", headers=AUD).json()
    assert ex["explanation"] and ex["lineage"]["rule_id"] and ex["documents"]
    r = client.post(f"/findings/{fid}/decisions", json={"decision": "confirmed"}, headers=AUD)
    assert r.status_code == 403
    d = client.post(f"/findings/{fid}/decisions", json={"decision": "confirmed", "note": "ok"}, headers=MGR).json()
    assert d["status"] == "confirmed" and d["decided_by"] == "partner"
    r = client.post("/engagements/sign-off", json={}, headers=MGR)
    assert r.status_code == 400 and r.json()["error"]["code"] == "VALIDATION_FAILED"

    g = client.get("/graph", headers=AUD).json()
    assert g["cycles"] and all(c["finding_id"] for c in g["cycles"])
    assert {n["kind"] for n in g["nodes"]} >= {"company", "customer", "vendor"}

    ch = client.post("/changes/check", json={}, headers=AUD).json()
    assert ch["changes"] == [] and ch["head_seq"] >= eng["snapshot_seq"]
    integ = client.post("/integrity/report", json={"business_chain": {"ok": True}, "trail_chain": {"ok": True},
                                                   "snapshot_match": True}, headers=AUD).json()
    assert integ["findings_created"] == 0

    wp = client.post("/workpaper", json={}, headers=AUD).json()
    assert wp["file"]["file_name"].endswith(".xlsx") and len(wp["sheets"]) == 6
    memo = client.post("/memo", json={}, headers=AUD).json()
    assert {f["file_name"].rsplit(".", 1)[1] for f in memo["files"]} == {"md", "docx"}
    assert memo["findings"] > 0 and isinstance(memo["total_adjustment"], int)
