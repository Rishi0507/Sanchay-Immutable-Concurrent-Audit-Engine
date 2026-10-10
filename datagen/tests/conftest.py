import json

import pytest

from elev_datagen.generate import generate
from elev_datagen.harness import engine_for

SCALE = 0.15


@pytest.fixture(scope="session")
def datasets(tmp_path_factory):
    root = tmp_path_factory.mktemp("ds")
    generate(root / "clean", "clean", seed=21, scale=SCALE)
    generate(root / "planted", "planted", seed=21, scale=SCALE)
    return root


@pytest.fixture(scope="session")
def clean_engine(datasets):
    e = engine_for(datasets / "clean", datasets / "clean_audit.db")
    e.open_engagement("2025-04-01", "2026-03-31", seed="42")
    return e


@pytest.fixture(scope="session")
def planted_engine(datasets):
    e = engine_for(datasets / "planted", datasets / "planted_audit.db")
    e.open_engagement("2025-04-01", "2026-03-31", seed="42")
    return e


@pytest.fixture(scope="session")
def answer_key(datasets):
    return json.loads((datasets / "planted" / "answer_key.json").read_text())["items"]


def matches(finding: dict, item: dict) -> bool:
    if finding["category"] != item["category"]:
        return False
    if item["subject_type"] == "period":
        return finding["subject"]["type"] == "period"
    sid = item["subject_id"]
    return (finding["subject"]["id"].split("#")[0] == sid or sid in finding["lineage"]["document_ids"]
            or sid in json.dumps(finding["lineage"].get("facts", {})))


def recall(findings: list[dict], items: list[dict]) -> list[dict]:
    """Return the answer-key items no finding matches."""
    return [i for i in items if not any(matches(f, i) for f in findings)]
