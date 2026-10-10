"""Upload evidence for every open request, planting forgeries for chosen samples (SD-7).

Returns answer-key items for the planted evidence (category EVIDENCE_SUSPECT).
"""

from __future__ import annotations

import tomllib
from pathlib import Path

from .evidence import EvidenceFactory


def upload_all(client, requests: list[dict], samples: dict[str, dict], snap, company: dict,
               plant: bool = True) -> list[dict]:
    fac = EvidenceFactory(snap, company)
    sales = sorted([s for s in samples.values() if s["sheet"] == "sales_tod" and s["subject_type"] == "invoice"],
                   key=lambda s: s["sample_id"])
    key: list[dict] = []
    tamper: dict[tuple[str, str], dict] = {}
    reuse = None
    if plant and len(sales) >= 8:
        # Each forgery needs the document it forges to have been requested.
        wanted = {}
        for r in requests:
            wanted.setdefault(r["sample_id"], set()).add(r["document_type"])
        full = [x for x in sales if {"invoice", "eway_bill", "lr_copy"} <= wanted.get(x["sample_id"], set())]
        rest = [x for x in sales if x not in full]
        pool = full + rest
        picks = [pool[1], full[0] if full else pool[0]] + [x for x in pool[2:] if x is not (full[0] if full else None)][:4]

        def note(s, check, text):
            key.append({"detector": "D-10", "category": "EVIDENCE_SUSPECT", "subtype": check, "subject_type": "invoice",
                        "subject_id": s["subject_id"], "note": text})

        tamper[(picks[0]["sample_id"], "invoice")] = {"amount_delta": 50_000_00}
        note(picks[0], "E-1", "Invoice copy amount raised by Rs 50,000.")
        tamper[(picks[1]["sample_id"], "eway_bill")] = {"short_validity": True}
        note(picks[1], "E-5", "E-way bill validity shortened to six hours.")
        tamper[(picks[2]["sample_id"], "invoice")] = {"producer": "Adobe Photoshop 25.1 (Windows)"}
        note(picks[2], "E-7", "Invoice copy produced by an image editor.")
        tamper[(picks[3]["sample_id"], "lr_copy")] = {"vehicle": "MH14ZZ0001"}
        note(picks[3], "E-2", "LR copy shows a different vehicle.")
        reuse = (picks[4]["sample_id"], picks[5]["sample_id"])
        note(picks[5], "E-3", "Invoice copy of another sample uploaded again.")
        # E-way bill of an invoice that is not sampled.
        sampled = {s["subject_id"] for s in sales}
        other = next((i for i in snap.invoices if str(i["invoice_no"]) not in sampled
                      and snap.ewbs_by_invoice.get(str(i["invoice_no"]))), None)
        target = next((s for s in sales[2::3] if s["sample_id"] not in {p["sample_id"] for p in picks}), None)
        if other and target:
            tamper[(target["sample_id"], "eway_bill")] = {"ewb_from": other}
            note(target, "E-4", f"E-way bill of {other['invoice_no']} uploaded.")
        scan = next((s for s in sales if s["sample_id"] not in {p["sample_id"] for p in picks}), None)
        if scan:
            tamper[(scan["sample_id"], "invoice")] = {"scan": True}
        # Documents the records do not hold, supplied all the same. The client cannot tell which requests
        # the auditor made as controls: it only knows that a document was asked for and none exists.
        for r in sorted(requests, key=lambda r: r["request_id"]):
            s, doc = samples[r["sample_id"]], r["document_type"]
            if (doc in ("eway_bill", "credit_note") and (r["sample_id"], doc) not in tamper
                    and s["subject_type"] == "invoice" and fac.make(s, doc) is None
                    and fac.make(s, "invoice") is not None):
                tamper[(r["sample_id"], doc)] = {"fabricate": True}
                note(s, "E-9", f"{doc.replace('_', ' ').capitalize()} supplied for an invoice that has none.")
    made_files = {}
    uploaded = 0
    def order(r):
        last = bool(reuse and r["sample_id"] == reuse[1] and r["document_type"] == "invoice")
        return (last, r["request_id"])

    for r in sorted(requests, key=order):
        s = samples[r["sample_id"]]
        made = fac.make(s, r["document_type"], tamper.get((r["sample_id"], r["document_type"])))
        if not made:
            # The honest answer to a request for a document that does not exist.
            client.decline_evidence(r["sample_id"], r["request_id"], r["document_type"],
                                    "No such document exists for this transaction.")
            continue
        data, name = made
        if reuse and r["sample_id"] == reuse[1] and r["document_type"] == "invoice" and (reuse[0], "invoice") in made_files:
            data, name = made_files[(reuse[0], "invoice")]
        made_files[(r["sample_id"], r["document_type"])] = (data, name)
        client.upload_evidence(r["sample_id"], r["request_id"], r["document_type"], data, name)
        uploaded += 1
    return key


def company_of(dataset_dir: str | Path) -> dict:
    return tomllib.loads((Path(dataset_dir) / "company.toml").read_text(encoding="utf-8"))
