"""The client answers the auditor's evidence requests through the client tools.

It lists pending requests (list_evidence_requests), renders each requested
document from its own records (the local copy written while seeding), and
uploads it (upload_evidence). A request for a document the client does not
hold is answered as not available. With plant=True some uploads are forged or
reused, one document that does not exist is supplied all the same, and the
answer-key items are written beside the dataset. With regional=True every
fourth sample sends its own documents in Hindi or Marathi.
"""

from __future__ import annotations

import json
from pathlib import Path

from audit_engine.snapshot import Snapshot
from audit_engine.store.business import FixtureBusinessStore

from .mcp_sink import GatewayClient
from .plant_evidence import company_of, upload_all


class _Uploader:
    def __init__(self, client: GatewayClient):
        self.client = client
        self.count = 0
        self.declined = 0

    def upload_evidence(self, sample_id: str, request_id: str, document_type: str, data: bytes, file_name: str):
        import base64

        self.count += 1
        return self.client.call("upload_evidence", {
            "sample_id": sample_id, "document_type": document_type, "file_name": file_name,
            "content_base64": base64.b64encode(data).decode(),
            "idempotency_key": f"evidence-{request_id}-{self.count}"})


    def decline_evidence(self, sample_id: str, request_id: str, document_type: str, note: str):
        self.declined += 1
        return self.client.call("upload_evidence", {
            "sample_id": sample_id, "document_type": document_type, "not_available": True, "note": note,
            "idempotency_key": f"evidence-{request_id}-none"})


def pending_requests(client: GatewayClient) -> list[dict]:
    out, cursor = [], None
    while True:
        args = {"status": "pending", "limit": 500}
        if cursor:
            args["cursor"] = cursor
        page = client.call("list_evidence_requests", args)
        out += page.get("requests") or []
        cursor = page.get("next_cursor")
        if not cursor:
            return out


def respond(base: str, token: str, dataset_dir: str | Path, plant: bool = False, regional: bool = False) -> dict:
    ds = Path(dataset_dir)
    client = GatewayClient(base, token)
    reqs = pending_requests(client)
    store = FixtureBusinessStore(ds / "fixture")
    head = store.head()[0]
    snap = Snapshot(store.events(), store.postings(), head)
    cn_agg = {str(c.get("credit_note_no")): c["_aggregate_id"] for c in snap.credit_notes}
    samples: dict[str, dict] = {}
    for r in reqs:
        if r["sample_id"] in samples:
            continue
        number = str((r.get("subject") or {}).get("invoice_no") or "")
        if r.get("sheet") == "credit_note_tod":
            agg, kind = cn_agg.get(number), "credit_note"
        else:
            invs = [i for i in snap.invoices_by_no.get(number, []) if not i["_reversed"]] or snap.invoices_by_no.get(number, [])
            agg, kind = (invs[0]["_aggregate_id"] if invs else None), "invoice"
        samples[r["sample_id"]] = {"sample_id": r["sample_id"], "sheet": r.get("sheet"), "subject_type": kind if agg else "register_row",
                                   "subject_id": number, "data": {"aggregate_id": agg}}
    uploader = _Uploader(client)
    key = upload_all(uploader, [{"request_id": r["request_id"], "sample_id": r["sample_id"],
                                 "document_type": r["document_type"]} for r in reqs],
                     samples, snap, company_of(ds), plant=plant, regional=regional)
    (ds / "evidence_answer_key.json").write_text(json.dumps(key, indent=2), encoding="utf-8")
    return {"pending_requests": len(reqs), "uploaded": uploader.count, "not_available": uploader.declined,
            "planted": len(key), "regional": regional}
