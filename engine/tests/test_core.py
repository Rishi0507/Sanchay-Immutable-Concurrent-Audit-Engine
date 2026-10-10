import json
from pathlib import Path

import pytest
from sqlalchemy.exc import DBAPIError

from audit_engine import chain, gstin, money
from audit_engine.repo import AuditRepo, findings

VECTORS = Path(__file__).resolve().parents[2] / "contracts" / "events" / "chain-vectors.json"


def test_gstin_checksum_roundtrip():
    g = gstin.make_gstin("27", "AABCS1234K")
    assert gstin.is_valid(g)
    assert gstin.pan_of(g) == "AABCS1234K"
    assert gstin.state_of(g) == "27"
    bad = g[:-1] + ("0" if g[-1] != "0" else "1")
    assert not gstin.is_valid(bad)
    assert any("checksum" in e for e in gstin.structure_errors(bad))


def test_known_gstin_checksum():
    # Published sample GSTIN with a valid checksum.
    assert gstin.is_valid("27AAPFU0939F1ZV")


def test_money():
    assert money.div_round(5, 2) == 3
    assert money.div_round(-5, 2) == -3
    assert money.apply_bp(10000, 1800) == 1800
    assert money.rupees(1234567890) == "1,23,45,678.90"
    assert money.to_paise("1,234.50") == 123450
    assert money.to_paise("(10)") == -1000
    assert money.to_paise("abc") is None
    assert money.to_paise(12.345) == 1235 or money.to_paise(12.345) == 1234


def _event(seq, prev, **kw):
    ev = {"seq": seq, "event_type": "PriceSet", "entity_id": "E1", "aggregate_id": "price:X", "aggregate_version": seq,
          "sale_id": None, "payload": {"item": "X", "rate": 100 * seq, "effective_from": "2025-04-01"},
          "business_date": "2025-04-01", "recorded_at": "2025-04-01T04:30:00Z",
          "identity": {"user": "seed", "role": "client_employee"}, "idempotency_key": f"k{seq}", "prev_hash": prev}
    ev.update(kw)
    ev["hash"] = chain.event_hash(ev)
    return ev


def test_chain_verify_and_tamper():
    evs, prev = [], chain.GENESIS
    for s in range(1, 6):
        e = _event(s, prev)
        evs.append(e)
        prev = e["hash"]
    assert chain.verify_chain(evs)["ok"]
    evs[2]["payload"]["rate"] = 1
    res = chain.verify_chain(evs)
    assert not res["ok"] and res["first_bad_seq"] == 3


def test_chain_vectors_match():
    data = json.loads(VECTORS.read_text(encoding="utf-8"))
    for v in data["vectors"]:
        assert chain.canonical_json(chain.hashed_content(v["event"])) == v["canonical_json"]
        assert chain.event_hash(v["event"]) == v["hash"]
    assert chain.merkle_root([v["hash"] for v in data["vectors"]]) == data["merkle_root"]


def test_repo_append_only(tmp_path):
    repo = AuditRepo(f"sqlite:///{tmp_path / 'a.db'}")
    repo.create_all()
    rec = {"finding_id": "F-0000000000000001", "engagement_id": "E", "detector_id": "D-01",
           "category": "REGISTER_MISMATCH", "severity": "Low", "created_at": "x"}
    assert repo.add_findings([rec]) == 1
    assert repo.add_findings([rec]) == 0  # DT-4: no duplicate
    from sqlalchemy import text
    with pytest.raises(DBAPIError):
        with repo.engine.begin() as c:
            c.execute(text("UPDATE findings SET severity='High'"))
    assert repo.select(findings)[0]["severity"] == "Low"
