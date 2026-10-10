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
    rec = {"finding_id": "fnd_0000000000000001", "engagement_id": "E", "detector_id": "D-01",
           "category": "REGISTER_MISMATCH", "severity": "Low", "created_at": "x"}
    assert repo.add_findings([rec]) == 1
    assert repo.add_findings([rec]) == 0  # DT-4: no duplicate
    from sqlalchemy import text
    with pytest.raises(DBAPIError):
        with repo.engine.begin() as c:
            c.execute(text("UPDATE findings SET severity='High'"))
    assert repo.select(findings)[0]["severity"] == "Low"


def test_model_output_is_parsed_leniently():
    from audit_engine.model import parse_object

    assert parse_object('```json\n{"invoice_no": "A/1"}\n```') == {"invoice_no": "A/1"}
    assert parse_object('Here it is: {"gross": 118} as asked.') == {"gross": 118}
    assert parse_object("no fields found") is None
    assert parse_object(None) is None


def test_model_fields_confirm_or_question_pattern_fields():
    from audit_engine.evidence.extract import extract
    from audit_engine.model import Model

    class Stub(Model):
        answer: dict = {}

        def complete_json(self, prompt, schema=None):
            return type(self).answer

    text = b"TAX INVOICE\nInvoice No: SPC/25-26/00042\nInvoice Date: 2026-03-30\nTaxable Value: 100000.00\n"
    plain = extract(text, "invoice")
    assert not plain["model_used"]
    number = plain["fields"]["invoice_no"]["value"]

    Stub.answer = {"invoice_no": number}
    agreed = extract(text, "invoice", Stub("http://model", "stub"))
    assert agreed["model_used"]
    assert agreed["fields"]["invoice_no"]["confidence"] >= plain["fields"]["invoice_no"]["confidence"]

    Stub.answer = {"invoice_no": "SPC/25-26/99999"}
    disputed = extract(text, "invoice", Stub("http://model", "stub"))
    assert disputed["fields"]["invoice_no"]["value"] == number  # the pattern value stands (AI-3)
    assert disputed["fields"]["invoice_no"]["alternative"] == "SPC/25-26/99999"
    assert disputed["fields"]["invoice_no"]["confidence"] <= 0.6

    Stub.answer = None  # the model failed: pattern rules alone (AI-1)
    assert extract(text, "invoice", Stub("http://model", "stub")) == plain


def test_other_wordings_of_a_number_and_a_date_are_read():
    from audit_engine.evidence.extract import extract

    # Many invoices say "Bill No" and many lorry receipts say only "Date".
    bill = extract(b"TAX INVOICE\nBill No: SPC/25-26/00042\nInvoice Date: 30-03-2026\nGrand Total: Rs 1,18,000.00\n", "invoice")
    assert bill["fields"]["invoice_no"]["value"] == "SPC/25-26/00042"
    receipt = extract(b"LORRY RECEIPT\nLR No: LR0000042\nDate: 30-03-2026\nVehicle No: MH12AB1234\n", "lr_copy")
    assert receipt["fields"]["date"]["value"] == "2026-03-30"
    assert not receipt["low_confidence"]
    # The number of an e-way bill is not the number of the invoice.
    ewb = extract(b"E-WAY BILL\nE-Way Bill No: 3912 3456 7890\nValid Upto: 31-03-2026 23:59:59\n", "eway_bill")
    assert "invoice_no" not in ewb["fields"] and ewb["fields"]["ewb_no"]["value"] == "391234567890"
