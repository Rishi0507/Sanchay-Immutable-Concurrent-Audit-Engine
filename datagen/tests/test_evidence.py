import shutil

import pytest

from audit_engine.evidence.service import evidence_status, verify_evidence
from audit_engine.engine import EngineError
from audit_engine.repo import evidence_requests, samples

from conftest import recall
from elev_datagen.client import FixtureClient
from elev_datagen.harness import engine_for
from elev_datagen.plant_evidence import company_of, upload_all


@pytest.fixture(scope="module")
def evidence_run(datasets, tmp_path_factory):
    root = tmp_path_factory.mktemp("ev")
    ds = root / "planted"
    shutil.copytree(datasets / "planted", ds)
    e = engine_for(ds, root / "audit.db")
    e.open_engagement("2025-04-01", "2026-03-31", seed="42")
    for step in ("select_sales_tod", "select_cutoff_tod", "select_credit_note_tod"):
        e.step(step)
    ctx = e.ctx()
    with pytest.raises(EngineError) as err:
        verify_evidence(ctx, ctx.engine.repo.select(samples, engagement_id=ctx.eid)[0]["sample_id"])
    assert err.value.code == "EVIDENCE_PENDING"
    reqs = e.repo.select(evidence_requests, engagement_id=ctx.eid)
    ss = {s["sample_id"]: s for s in e.repo.select(samples, engagement_id=ctx.eid)}
    client = FixtureClient(ds)
    key = upload_all(client, reqs, ss, ctx.snap, company_of(ds))
    client.flush()
    result = verify_evidence(e.ctx())
    return e, key, result


def test_evidence_recall(evidence_run):
    e, key, result = evidence_run
    assert len(key) >= 6
    findings = [f for f in e.repo.findings(e.resolve(None)["engagement_id"]) if f["detector_id"] == "D-10"]
    missed = recall(findings, key)
    assert not missed, missed


def test_genuine_evidence_passes(evidence_run):
    e, key, result = evidence_run
    planted = {k["subject_id"] for k in key}
    ok = [r for r in result["results"] if r.get("subject") and r["subject"] not in planted
          and r["status"] == "Pass"]
    assert len(ok) >= 20
    status = evidence_status(e.ctx())
    assert status["by_status"].get("verified", 0) > 50


def test_verify_twice_is_stable(evidence_run):
    e, key, result = evidence_run
    eid = e.resolve(None)["engagement_id"]
    before = len(e.repo.findings(eid))
    again = verify_evidence(e.ctx())
    assert len(e.repo.findings(eid)) == before
    assert all(r.get("already_verified") or r["status"] == "Pending evidence" for r in again["results"])


@pytest.fixture(scope="module")
def changed_run(evidence_run):
    from audit_engine.repo import evidence_results

    from elev_datagen.scenarios import post_testing_changes

    e, _, _ = evidence_run
    ctx = e.ctx()
    ds = e.settings.business_source.split("fixture:", 1)[1].rsplit("/fixture", 1)[0]
    ss = {s["sample_id"]: s for s in e.repo.select(samples, engagement_id=ctx.eid)}
    verified = [{"request_id": r["request_id"], "sample_id": r["sample_id"],
                 "document_type": r["request_id"].rsplit("-", 1)[-1]}
                for r in e.repo.select(evidence_results, engagement_id=ctx.eid) if r["request_id"].endswith("-invoice")]
    client = FixtureClient(ds)
    key = post_testing_changes(client, ss, ctx.snap, company_of(ds), verified)
    client.flush()
    from audit_engine.changes import check_post_testing_changes

    result = check_post_testing_changes(e.ctx())
    verify_evidence(e.ctx())
    return e, key, result


def test_post_testing_changes_detected(changed_run):
    e, key, result = changed_run
    eid = e.resolve(None)["engagement_id"]
    findings = [f for f in e.repo.findings(eid) if f["detector_id"] in ("D-15", "D-10")]
    missed = recall(findings, key)
    assert not missed, missed
    assert result["samples_changed_after_testing"]
    tests = e.repo.latest_tests(eid)
    sid = result["samples_changed_after_testing"][0]
    assert any(f.get("check") == "CH-2" for f in tests[sid]["flags"])


def test_change_check_is_idempotent(changed_run):
    from audit_engine.changes import check_post_testing_changes

    e, key, result = changed_run
    again = check_post_testing_changes(e.ctx())
    assert again["findings_raised"] == 0


def test_tamper_detected(datasets, tmp_path):
    from audit_engine.integrity import verify_ledger_integrity

    from elev_datagen.scenarios import tamper_event

    ds = tmp_path / "t"
    shutil.copytree(datasets / "clean", ds)
    e = engine_for(ds, tmp_path / "a.db")
    e.open_engagement("2025-04-01", "2026-03-31", seed="1")
    ok = verify_ledger_integrity(e.ctx())
    assert ok["business"]["ok"] and ok["snapshot_hash_ok"] and ok["findings_raised"] == 0
    item = tamper_event(ds / "fixture", 500)
    res = verify_ledger_integrity(e.ctx())
    assert not res["business"]["ok"] and res["business"]["first_bad_seq"] == 500
    findings = [f for f in e.repo.findings(e.resolve(None)["engagement_id"]) if f["detector_id"] == "D-16"]
    assert any(f["subject"]["id"] == item["subject_id"] for f in findings)
    assert any(f["subtype"] == "SNAPSHOT_ALTERED" for f in findings)
