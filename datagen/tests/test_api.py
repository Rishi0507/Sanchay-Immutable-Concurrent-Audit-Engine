import pytest
from fastapi.testclient import TestClient

from audit_engine import api
from elev_datagen.harness import engine_for

AUD = {"X-Identity-User": "agent-1", "X-Identity-Role": "auditor"}
MGR = {"X-Identity-User": "partner", "X-Identity-Role": "audit_manager"}
CLI = {"X-Identity-User": "client.ops", "X-Identity-Role": "client_employee"}


@pytest.fixture(scope="module")
def client(datasets, tmp_path_factory, monkeypatch_module):
    e = engine_for(datasets / "planted", tmp_path_factory.mktemp("api") / "a.db")
    monkeypatch_module.setattr(api, "engine", lambda: e)
    return TestClient(api.app)


@pytest.fixture(scope="module")
def monkeypatch_module():
    mp = pytest.MonkeyPatch()
    yield mp
    mp.undo()


def test_identity_required(client):
    r = client.get("/plan")
    assert r.status_code == 403 and r.json()["code"] == "PERMISSION_DENIED"
    r = client.post("/engagements", json={"period_start": "2025-04-01", "period_end": "2026-03-31"}, headers=CLI)
    assert r.status_code == 403


def test_no_engagement_error_has_next_step(client):
    r = client.post("/detectors/run", json={}, headers=AUD)
    assert r.status_code == 409
    assert r.json()["code"] == "NO_ENGAGEMENT" and "open_engagement" in r.json()["next_step"]


def test_full_flow(client):
    r = client.post("/engagements", json={"period_start": "2025-04-01", "period_end": "2026-03-31", "seed": "s1"},
                    headers=AUD)
    assert r.status_code == 200, r.text
    assert r.json()["snapshot_seq"] > 0
    plan = client.get("/plan", headers=AUD).json()
    assert plan["next_tool"] == "import_register"
    r = client.post("/samples/sales", json={}, headers=AUD).json()
    assert set(r["auto_ran"]) >= {"import_register", "reconcile_register", "tag_related_parties", "run_detectors"}
    assert 25 <= r["count"] <= 35 and r["evidence_requests"]
    r = client.post("/samples/cutoff", json={"after_count": 12}, headers=AUD).json()
    assert r["strata"]["after"] == 12
    reqs = client.get("/evidence/requests", headers=CLI).json()["requests"]
    assert reqs and reqs[0]["status"] == "requested"
    f = client.get("/findings", params={"severity": "High", "limit": 5}, headers=AUD).json()
    assert f["items"] and f["next_cursor"]
    fid = f["items"][0]["finding_id"]
    ex = client.get(f"/findings/{fid}/explain", headers=AUD).json()
    assert ex["reason"] and ex["lineage"]["rule_id"]
    assert client.post(f"/findings/{fid}/decisions", json={"decision": "confirmed"}, headers=AUD).status_code == 403
    assert client.post(f"/findings/{fid}/decisions", json={"decision": "confirmed", "note": "ok"},
                       headers=MGR).json()["status"] == "confirmed"
    q = client.post("/records/query", json={"record_type": "invoice", "filters": {"date_from": "2026-03-25"},
                                            "limit": 5}, headers=AUD).json()
    assert q["total"] > 5 and len(q["items"]) == 5
    sale = q["items"][0]["meta"]["sale_id"]
    assert client.get(f"/sales/{sale}/chain", headers=AUD).json()["events"]
    le = client.get("/ledger/entries", params={"account": "4000", "limit": 3}, headers=AUD).json()
    assert le["credit"] > 0
    g = client.get("/graph", headers=AUD).json()
    assert g["cycles"] and g["nodes"]
    wp = client.post("/workpaper", json={}, headers=AUD).json()
    dl = client.get(f"/files/{wp['file_hash']}", headers=AUD)
    assert dl.status_code == 200 and dl.content[:2] == b"PK"
    memo = client.post("/memo", json={"format": "md"}, headers=AUD).json()
    assert memo["files"][0]["format"] == "md"
    st = client.get("/engagements/status", headers=AUD).json()
    assert "export_workpaper" in st["steps_completed"]
