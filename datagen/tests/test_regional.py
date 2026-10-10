"""Evidence written in Hindi or Marathi (PRD 14.2, EV-6)."""

import shutil

import pymupdf
import pytest

from audit_engine.evidence import regional
from audit_engine.evidence.extract import extract
from audit_engine.evidence.service import regional_documents, verify_evidence
from audit_engine.outputs import export_summary
from audit_engine.repo import evidence_requests, evidence_results, samples

from conftest import recall
from elev_datagen.client import FixtureClient
from elev_datagen.evidence import EvidenceFactory
from elev_datagen.harness import engine_for
from elev_datagen.plant_evidence import REGIONAL_DOCS, company_of, regional_samples, upload_all

PERIOD = ("2025-04-01", "2026-03-31")

HINDI_INVOICE = """कर बीजक
आपूर्तिकर्ता जीएसटीआईएन: 27AAACS1234A1Z5
बीजक संख्या: SPC/25-26/00042
बीजक दिनांक: ०८-०४-२०२५
खरीदार का नाम: Nexa Engineering Solutions
खरीदार जीएसटीआईएन: 27AABCN5678B1Z3
आदेश संदर्भ: -
कर योग्य मूल्य: Rs ५,९२,९२०.००
सीजीएसटी: Rs 53,362.80
एसजीएसटी: Rs 53,362.80
कुल योग: Rs 6,99,645.60
वाहन संख्या: MH12AB1234
"""


def test_a_hindi_invoice_reads_like_an_english_one():
    got = extract(HINDI_INVOICE.encode("utf-8"), "invoice")
    values = {k: v["value"] for k, v in got["fields"].items()}
    assert values["invoice_no"] == "SPC/25-26/00042"
    # The date and the taxable value are written in Devanagari digits.
    assert values["invoice_date"] == "2025-04-08"
    assert values["taxable_value"] == 592_920_00
    assert values["gross"] == 699_645_60
    assert values["cgst"] == values["sgst"] == 53_362_80
    assert values["customer_gstin"] == "27AABCN5678B1Z3" and values["supplier_gstin"] == "27AAACS1234A1Z5"
    assert values["vehicle_no"] == "MH12AB1234"
    assert got["language"] == "hi" and got["labels_translated"] >= 9 and got["labels_unplaced"] == 0
    assert not got["low_confidence"]


def test_a_label_that_cannot_be_placed_sends_the_document_to_a_person():
    # "Final amount payable" is not a wording the dictionary knows, so the total is not guessed.
    text = HINDI_INVOICE.replace("कुल योग", "अंतिम देय धनराशि")
    got = extract(text.encode("utf-8"), "invoice")
    assert "gross" not in got["fields"]
    assert got["low_confidence"] == ["gross"] and got["labels_unplaced"] == 1


def test_an_english_document_is_left_as_it_is():
    text = "Invoice No: SPC/25-26/00042\nInvoice Date: 08-04-2025\nGrand Total: Rs 6,99,645.60\n"
    assert regional.normalise(text) == (text, {"language": "en", "labels_translated": 0, "labels_unplaced": 0,
                                               "weakest_match": None})


def audited(datasets, root, plant: bool, regional_docs: bool):
    ds = root / "data"
    shutil.copytree(datasets / "planted", ds)
    e = engine_for(ds, root / "audit.db")
    e.open_engagement(*PERIOD, seed="42")
    for step in ("select_sales_tod", "select_cutoff_tod", "select_credit_note_tod"):
        e.step(step)
    ctx = e.ctx()
    reqs = e.repo.select(evidence_requests, engagement_id=ctx.eid)
    ss = {s["sample_id"]: s for s in e.repo.select(samples, engagement_id=ctx.eid)}
    client = FixtureClient(ds)
    key = upload_all(client, reqs, ss, ctx.snap, company_of(ds), plant=plant, regional=regional_docs)
    client.flush()
    return e, key, verify_evidence(e.ctx()), ss, ds


@pytest.fixture(scope="module")
def english(datasets, tmp_path_factory):
    return audited(datasets, tmp_path_factory.mktemp("english"), plant=False, regional_docs=False)


@pytest.fixture(scope="module")
def mixed(datasets, tmp_path_factory):
    return audited(datasets, tmp_path_factory.mktemp("mixed"), plant=False, regional_docs=True)


@pytest.fixture(scope="module")
def forged(datasets, tmp_path_factory):
    return audited(datasets, tmp_path_factory.mktemp("forged"), plant=True, regional_docs=True)


def test_every_kind_of_document_reads_the_same_in_each_language(english):
    e, _, _, ss, ds = english
    ctx = e.ctx()
    fac = EvidenceFactory(ctx.snap, company_of(ds))
    seen = set()
    for s in sorted(ss.values(), key=lambda s: s["sample_id"]):
        for doc in REGIONAL_DOCS:
            made = fac.make(s, doc)
            if not made or doc in seen:
                continue
            seen.add(doc)
            base = extract(made[0], doc)
            for language in ("hi", "mr"):
                data, name = fac.make(s, doc, {"language": language})
                got = extract(data, doc)
                assert name == made[1]
                assert got["language"] == language, (doc, language, got["language"])
                assert not got["low_confidence"] and got["labels_unplaced"] == 0, (doc, language)
                assert ({k: v["value"] for k, v in got["fields"].items()} ==
                        {k: v["value"] for k, v in base["fields"].items()}), (doc, language)
                # The file still says who made it and when, which the made-to-order check reads.
                assert got["metadata"]["producer"] == base["metadata"]["producer"]
                assert got["metadata"]["creation_date"] == base["metadata"]["creation_date"]
    assert seen == set(REGIONAL_DOCS)


def test_genuine_regional_documents_pass_like_english_ones(english, mixed):
    _, _, plain, ss, _ = english
    e, _, result, _, _ = mixed
    ctx = e.ctx()
    in_regional = regional_samples(ss)
    assert len(in_regional) >= 10 and set(in_regional.values()) == {"hi", "mr"}
    # Nothing changes for any sample: the same tests give the same results.
    assert ({r["sample_id"]: r.get("tests") for r in result["results"]} ==
            {r["sample_id"]: r.get("tests") for r in plain["results"]})
    assert result["findings_raised"] == plain["findings_raised"]
    read = regional_documents(ctx)
    assert set(read) <= set(in_regional) and len(read) >= 10
    for sid, languages in read.items():
        assert set(languages) == {regional.LANGUAGE_NAMES[in_regional[sid]]}
    # An e-way bill comes from the government portal and stays in English.
    for r in e.repo.select(evidence_results, engagement_id=ctx.eid):
        if (r["extracted"] or {}).get("doc_type") == "eway_bill":
            assert r["extracted"]["language"] == "en"


def test_a_forged_amount_on_a_hindi_invoice_is_caught(forged):
    e, key, result, _, _ = forged
    ctx = e.ctx()
    findings = [f for f in e.repo.findings(ctx.eid) if f["detector_id"] == "D-10"]
    assert not recall(findings, key)
    planted = next(k for k in key if k["subtype"] == "E-1")
    hit = next(f for f in findings if (f["lineage"].get("facts") or {}).get("check") == "E-1"
               and planted["subject_id"] in f["lineage"]["document_ids"])
    sample = hit["sample_ids"][0]
    assert regional_documents(ctx)[sample] and set(regional_documents(ctx)[sample]) == {"Hindi"}
    assert next(r for r in result["results"] if r["sample_id"] == sample)["tests"]["Amount"] == "Exception"


def test_the_summary_counts_documents_read_in_a_regional_language(mixed):
    e, _, _, _, _ = mixed
    out = export_summary(e.ctx())
    count = out["summary"]["evidence"]["regional_language"]
    assert count == sum(len(v) for v in regional_documents(e.ctx()).values()) >= 10
    doc = pymupdf.open(stream=e.files.get(out["file"]["file_hash"]), filetype="pdf")
    assert doc.page_count == 1 and "Read in Hindi or Marathi" in doc[0].get_text()
