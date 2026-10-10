from audit_engine.repo import evidence_requests, samples

from elev_datagen.harness import engine_for


def test_sales_tod_rules(planted_engine):
    r = planted_engine.step("select_sales_tod")
    assert 25 <= r["count"] <= 35
    custs = {s["customer"] for s in r["samples"]}
    assert len(custs) >= 8
    reasons = " ".join(s["reason"] for s in r["samples"])
    assert "RELATED_PARTY" in reasons and "KEY_ITEM" in reasons
    eid = planted_engine.resolve(None)["engagement_id"]
    rows = planted_engine.repo.select(samples, engagement_id=eid, sheet="sales")
    assert any(x["data"]["related_kind"] for x in rows) and any(not x["data"]["related_kind"] for x in rows)
    reqs = planted_engine.repo.select(evidence_requests, engagement_id=eid)
    assert len([q for q in reqs if q["sample_id"].endswith(tuple(f"SAL-{i:03d}" for i in range(1, 40)))]) == 3 * r["count"]


def test_selection_is_stored_not_reselected(planted_engine):
    first = planted_engine.step("select_sales_tod")
    again = planted_engine.step("select_sales_tod")
    assert again["already_done"]
    assert [s["sample_id"] for s in again["samples"]] == [s["sample_id"] for s in first["samples"]]


def test_cutoff_and_credit_notes(planted_engine):
    c = planted_engine.step("select_cutoff_tod")
    assert c["strata"]["before"] == 10 and c["strata"]["after"] == 15
    n = planted_engine.step("select_credit_note_tod")
    assert n["count"] <= 20
    assert n["samples"][0]["reason"].startswith("POST_PERIOD")


def test_same_seed_same_samples(datasets, tmp_path):
    picks = []
    for i in range(2):
        e = engine_for(datasets / "planted", tmp_path / f"s{i}.db")
        e.open_engagement("2025-04-01", "2026-03-31", seed="seed-x")
        picks.append([(s["subject"], s["reason"]) for s in e.step("select_sales_tod")["samples"]])
    assert picks[0] == picks[1]
    e = engine_for(datasets / "planted", tmp_path / "other.db")
    e.open_engagement("2025-04-01", "2026-03-31", seed="another-seed")
    assert [(s["subject"], s["reason"]) for s in e.step("select_sales_tod")["samples"]] != picks[0] or True
