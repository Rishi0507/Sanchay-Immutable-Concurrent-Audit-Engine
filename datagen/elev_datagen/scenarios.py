"""Client changes after the snapshot (SD-9) and a storage-level tamper (D-16).

Each function returns answer-key items for what it planted.
"""

from __future__ import annotations

import json
from pathlib import Path

from audit_engine.snapshot import Snapshot

from .evidence import EvidenceFactory


def post_testing_changes(client, samples: dict[str, dict], snap: Snapshot, company: dict,
                         verified_requests: list[dict]) -> list[dict]:
    key = []
    sales = sorted([s for s in samples.values() if s["sheet"] == "sales" and s["subject_type"] == "invoice"],
                   key=lambda s: s["sample_id"])
    if len(sales) < 6:
        return key

    def note(subject, sub, text):
        key.append({"detector": "D-15", "category": "POST_TESTING_CHANGE", "subtype": sub, "subject_type": "invoice",
                    "subject_id": subject, "note": text})

    s0, s1, s2, s3 = sales[-1], sales[-2], sales[-3], sales[-4]
    inv0 = snap.by_aggregate[s0["data"]["aggregate_id"]]
    client.append("DocumentReversed", inv0["_aggregate_id"],
                  {"target_aggregate_id": inv0["_aggregate_id"], "reason": "Cancelled at customer request"},
                  sale_id=inv0["_sale_id"])
    note(s0["subject_id"], "DOCUMENTREVERSED", "Sampled invoice reversed after the snapshot.")
    cust = snap.customer(s1["data"]["customer_id"])
    client.append("CustomerUpdated", cust.party_id,
                  {"customer_id": cust.party_id, "changes": {"bank_accounts": [{"account_no": "918273645501",
                                                                                "ifsc": "UTIB0000999"}]},
                   "effective_from": "2026-07-21"})
    note(s1["subject_id"], "CUSTOMERUPDATED", "Customer of a sampled invoice changed its bank account.")
    client.append("JournalPosted", "JV-LATE-1",
                  {"journal_id": "JV-LATE-1", "date": "2026-03-31",
                   "narration": f"Rate revision on {s2['subject_id']}",
                   "lines": [{"account": "1100", "debit": 25_000_00, "credit": 0, "ref": s2["subject_id"]},
                             {"account": "4000", "debit": 0, "credit": 25_000_00, "ref": s2["subject_id"]}],
                   "approver": None}, business_date="2026-03-31")
    note(s2["subject_id"], "JOURNALPOSTED", "Journal to Sales dated in the period, referring to a sampled invoice.")
    inv3 = snap.by_aggregate[s3["data"]["aggregate_id"]]
    client.append("CreditNoteIssued", "cn:LATE-1",
                  {"credit_note_no": "CN/26-27/9001", "date": "2026-07-21", "original_invoice_no": inv3["invoice_no"],
                   "customer_id": inv3["customer_id"], "reason": "Quality claim", "taxable_value": 10_000_00,
                   "cgst": 90_000 if not inv3.get("igst") else 0, "sgst": 90_000 if not inv3.get("igst") else 0,
                   "igst": 1_80_000 if inv3.get("igst") else 0, "gross": 11_800_00, "approver": "R. Iyer (Sales Head)"},
                  sale_id=inv3["_sale_id"])
    note(s3["subject_id"], "CREDITNOTEISSUED", "Credit note against a sampled invoice after testing began.")
    # Replace evidence that was already verified (E-8).
    if verified_requests:
        r = sorted(verified_requests, key=lambda r: r["request_id"])[0]
        s = samples[r["sample_id"]]
        made = EvidenceFactory(snap, company).make(s, r["document_type"], {"amount_delta": 1_00_00})
        if made:
            client.upload_evidence(r["sample_id"], r["request_id"], r["document_type"], *made)
            note(s["subject_id"], "EVIDENCEUPLOADED", "Verified evidence replaced.")
            key.append({"detector": "D-10", "category": "EVIDENCE_SUSPECT", "subtype": "E-8", "subject_type": "invoice",
                        "subject_id": s["subject_id"], "note": "Verified evidence replaced."})
    return key


def tamper_event(fixture_dir: str | Path, seq: int) -> dict:
    """Edit one stored event in place, as an attacker with database access would (bypassing triggers)."""
    path = Path(fixture_dir) / "events.jsonl"
    lines = path.read_text(encoding="utf-8").splitlines()
    ev = json.loads(lines[seq - 1])
    assert ev["seq"] == seq
    payload = ev["payload"]
    for k in ("taxable_value", "amount", "gross", "rate"):
        if isinstance(payload.get(k), int):
            payload[k] = payload[k] + 1_00_000_00
            break
    else:
        payload["tampered"] = True
    lines[seq - 1] = json.dumps(ev, ensure_ascii=False, separators=(",", ":"))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return {"detector": "D-16", "category": "LEDGER_INTEGRITY", "subtype": "BUSINESS_CHAIN_BROKEN",
            "subject_type": "chain", "subject_id": f"business:{seq}", "note": f"Event {seq} edited in storage."}
