"""The audit assistant on a whole engagement: its answers agree with the records they come from."""

from audit_engine.assistant.passages import number_of
from audit_engine.assistant.service import ask, index_for
from audit_engine.findings_service import all_findings
from audit_engine.repo import samples


def test_answers_agree_with_the_engagement(planted_engine):
    for step in ("run_detectors", "select_sales_tod"):
        planted_engine.step(step)
    ctx = planted_engine.ctx()
    findings = all_findings(ctx)
    high = sum(1 for f in findings if f["severity"] == "High")

    out = ask(ctx, "How many findings are there and how many are High?")
    assert out["mode"] == "records" and out["tokens"] == 0  # no model is configured, and none is needed
    assert f"{len(findings)} findings in total: {high} High" in out["answer"]
    assert out["sources"][0]["tab"] == "overview" and out["checks"]["withheld"] == 0

    # The same question in Hindi reads the same record.
    assert ask(ctx, "कुल कितने निष्कर्ष हैं?")["sources"][0]["title"] == out["sources"][0]["title"]


def test_a_document_number_leads_to_its_sample_and_findings(planted_engine):
    ctx = planted_engine.ctx()
    sample = planted_engine.repo.select(samples, order_by=samples.c.position, engagement_id=ctx.eid, sheet="sales_tod")[0]
    number = number_of(sample)
    out = ask(ctx, f"What do the records say about {number}?")
    assert number in out["answer"]
    opened = {(s["tab"], s["focus"]) for s in out["sources"]}
    assert ("samples", f"sales_tod:{sample['sample_id']}") in opened
    # The last digits are enough, as a person would type them.
    assert number in ask(ctx, f"why was {number.rsplit('/', 1)[-1]} sampled")["answer"]


def test_every_finding_and_sample_can_be_asked_about(planted_engine):
    ctx = planted_engine.ctx()
    index, stamp = index_for(ctx)
    keys = {p.key for p in index.passages}
    assert {f"finding:{f['finding_id']}" for f in all_findings(ctx)} <= keys
    assert {f"sample:{s['sample_id']}" for s in planted_engine.repo.select(samples, engagement_id=ctx.eid)} <= keys
    # The passages are built once and kept until the engagement changes.
    assert index_for(ctx) == (index, stamp)
    assert ask(ctx, "Who won the cricket world cup?")["mode"] == "none"
