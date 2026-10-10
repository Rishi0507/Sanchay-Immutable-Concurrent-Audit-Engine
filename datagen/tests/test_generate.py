import json
from collections import Counter

import pytest

from audit_engine import chain
from audit_engine.store import open_business_store
from elev_datagen.generate import generate


@pytest.fixture(scope="module")
def planted(tmp_path_factory):
    out = tmp_path_factory.mktemp("planted")
    meta = generate(out, "planted", seed=11, scale=0.15)
    return out, meta


def _check_chain(out):
    st = open_business_store(f"fixture:{out / 'fixture'}")
    events = list(st.events())
    assert chain.verify_chain(events)["ok"]
    postings = list(st.postings())
    assert sum(p["debit"] for p in postings) == sum(p["credit"] for p in postings)
    seqs = [e["seq"] for e in events]
    assert seqs == list(range(1, len(seqs) + 1))
    return events


def test_planted_chain_and_answer_key(planted):
    out, meta = planted
    events = _check_chain(out)
    assert events[-1]["event_type"] == "RelatedPartyListUploaded"
    key = json.loads((out / "answer_key.json").read_text())
    by_detector = Counter(i["detector"] for i in key["items"])
    for d in [f"D-{n:02d}" for n in range(1, 15) if n != 10]:
        assert by_detector[d] >= 2, d  # SD-4; D-10 is planted at evidence time
    assert all(i["subject_id"] for i in key["items"])


def test_answer_key_not_in_fixture(planted):
    out, _ = planted
    assert not (out / "fixture" / "answer_key.json").exists()
    assert not any("answer" in p.name for p in (out / "files").rglob("*"))


def test_deterministic(tmp_path):
    a = generate(tmp_path / "a", "clean", seed=3, scale=0.1)
    b = generate(tmp_path / "b", "clean", seed=3, scale=0.1)
    ha = open_business_store(f"fixture:{tmp_path / 'a' / 'fixture'}").head()
    hb = open_business_store(f"fixture:{tmp_path / 'b' / 'fixture'}").head()
    assert ha == hb
    assert a["register_hash"] == b["register_hash"]


def test_clean_has_no_answer_items(tmp_path):
    generate(tmp_path, "clean", seed=5, scale=0.1)
    key = json.loads((tmp_path / "answer_key.json").read_text())
    assert key["items"] == []
    _check_chain(tmp_path)
