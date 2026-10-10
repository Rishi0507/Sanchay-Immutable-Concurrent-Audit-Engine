"""Control requests (PRD 14.4) and the sealed sampling seed (PRD 12.5)."""

import hashlib
import shutil

import pytest

from audit_engine.evidence.service import control_summary, request_status, verify_evidence
from audit_engine.repo import control_requests, evidence_requests, samples

from elev_datagen.client import FixtureClient
from elev_datagen.harness import engine_for
from elev_datagen.plant_evidence import company_of, upload_all

PERIOD = ("2025-04-01", "2026-03-31")


def audited(datasets, root, plant: bool):
    """An engagement whose evidence requests the client has answered, honestly or with planted forgeries."""
    ds = root / ("planted" if plant else "honest")
    shutil.copytree(datasets / "planted", ds)
    e = engine_for(ds, root / f"{ds.name}.db")
    e.open_engagement(*PERIOD, seed="42")
    for step in ("select_sales_tod", "select_cutoff_tod", "select_credit_note_tod"):
        e.step(step)
    ctx = e.ctx()
    reqs = e.repo.select(evidence_requests, engagement_id=ctx.eid)
    ss = {s["sample_id"]: s for s in e.repo.select(samples, engagement_id=ctx.eid)}
    client = FixtureClient(ds)
    upload_all(client, reqs, ss, ctx.snap, company_of(ds), plant=plant)
    client.flush()
    return e, verify_evidence(e.ctx())


@pytest.fixture(scope="module")
def honest(datasets, tmp_path_factory):
    return audited(datasets, tmp_path_factory.mktemp("honest"), plant=False)


@pytest.fixture(scope="module")
def dishonest(datasets, tmp_path_factory):
    return audited(datasets, tmp_path_factory.mktemp("dishonest"), plant=True)


def test_control_requests_ask_for_documents_that_do_not_exist(honest):
    e, _ = honest
    ctx = e.ctx()
    controls = e.repo.select(control_requests, engagement_id=ctx.eid)
    # Every engagement carries the full number: an invoice with no credit note against it can always be found.
    assert len(controls) == ctx.th["sampling"]["control_requests_max"]
    by_sample = {s["sample_id"]: s for s in e.repo.select(samples, engagement_id=ctx.eid)}
    requests = {r["request_id"]: r for r in e.repo.select(evidence_requests, engagement_id=ctx.eid)}
    for c in controls:
        inv = ctx.snap.by_aggregate[by_sample[c["sample_id"]]["data"]["aggregate_id"]]
        if c["document_type"] == "eway_bill":
            assert not ctx.snap.ewbs_by_invoice.get(str(inv["invoice_no"]))
            assert (inv.get("gross") or 0) <= ctx.th["d05"]["eway_bill_threshold"]
        else:
            assert c["document_type"] == "credit_note"
            assert not ctx.snap.credit_notes_by_invoice.get(str(inv["invoice_no"]))
        # The request the client sees is worded like every other request.
        assert requests[c["request_id"]]["note"] == f"{c['document_type'].replace('_', ' ')} copy for {inv['invoice_no']}"
    # Nothing in the client's view of a request says that it is a control.
    assert all("control" not in k and "basis" not in k for r in request_status(ctx) for k in r)


def test_an_honest_client_passes_every_control(honest):
    e, result = honest
    ctx = e.ctx()
    summary = control_summary(ctx)
    assert summary["sent"] >= 1 and summary["declined"] == summary["sent"] and summary["supplied"] == 0
    assert result["control_requests"] == summary
    assert not [f for f in e.repo.findings(ctx.eid) if (f["lineage"].get("facts") or {}).get("check") == "E-9"]
    control_samples = {c["sample_id"] for c in e.repo.select(control_requests, engagement_id=ctx.eid)}
    for r in result["results"]:
        if r["sample_id"] in control_samples:
            passed = [c for c in r["checks"] if c["check"] == "E-9"]
            assert passed and all(c["result"] == "pass" for c in passed)
            assert r["tests"]["Evidence"] == "Pass", r


def test_a_document_made_for_the_request_is_caught(dishonest):
    e, result = dishonest
    ctx = e.ctx()
    summary = control_summary(ctx)
    assert summary["sent"] >= 1 and summary["supplied"] == summary["sent"] and summary["declined"] == 0
    caught = [f for f in e.repo.findings(ctx.eid) if (f["lineage"].get("facts") or {}).get("check") == "E-9"]
    assert all(f["detector_id"] == "D-10" for f in caught)
    # One finding per control, and it says why the document cannot be genuine.
    trapped = [f for f in caught if "made for the request" in f["reason"]]
    assert len(trapped) == summary["sent"]
    sample = trapped[0]["sample_ids"][0]
    assert next(r for r in result["results"] if r["sample_id"] == sample)["tests"]["Evidence"] == "Exception"


def test_the_seed_follows_from_a_secret_sealed_before_opening(datasets, tmp_path):
    e = engine_for(datasets / "planted", tmp_path / "audit.db")
    seal = e.seal_sampling()  # as the register arrives
    before = e.sampling_seal()
    assert before["status"] == "sealed" and before["commitment"] == seal["commitment"]
    assert "secret" not in before and "seed" not in before

    eng = e.open_engagement(*PERIOD)
    proof = e.sampling_seal(eng["engagement_id"])
    assert proof["status"] == "verified" and all(proof["checks"].values())
    # What the client can check with the commitment it was handed on upload.
    assert hashlib.sha256(proof["secret"].encode()).hexdigest() == seal["commitment"]
    assert hashlib.sha256(f"{proof['secret']}|{proof['snapshot_hash']}".encode()).hexdigest()[:16] == proof["seed"] == eng["seed"]


def test_the_seed_cannot_be_drawn_again(datasets, tmp_path):
    e = engine_for(datasets / "planted", tmp_path / "audit.db")
    first = e.open_engagement(*PERIOD)
    again = e.open_engagement(*PERIOD)
    assert again["engagement_id"] == first["engagement_id"] and again["seed"] == first["seed"]
    assert len(e.repo.open_engagements()) == 1
    # Sealing again does not replace the secret.
    assert e.seal_sampling()["commitment"] == e.sampling_seal(first["engagement_id"])["commitment"]


def test_a_seal_made_only_at_opening_and_a_chosen_seed_are_reported_as_such(datasets, tmp_path):
    e = engine_for(datasets / "planted", tmp_path / "audit.db")
    late = e.open_engagement(*PERIOD)
    assert e.sampling_seal(late["engagement_id"])["status"] == "sealed at opening"
    chosen = e.open_engagement(*PERIOD, seed="42")
    assert chosen["engagement_id"] != late["engagement_id"]
    proof = e.sampling_seal(chosen["engagement_id"])
    assert proof["status"] == "chosen" and "secret" not in proof
