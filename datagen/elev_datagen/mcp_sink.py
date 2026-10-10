"""Load the generated business through the client tools of the running system (SD-2).

Each event becomes one call of the tool named in contracts/events.json, made over
the MCP server's HTTP gateway (/api/tools/<tool>, the same handlers as /mcp). The
arguments use the catalogue's field names, amounts in rupees (the server stores
paise), and references by the identifiers the server returned for earlier
records. The historical record time is sent in X-Sim-Recorded-At, which the
server honours only when started with SIM_CLOCK=1 and the ledger with
LEDGER_SIM_CLOCK=1.
"""

from __future__ import annotations

import base64
import datetime as dt
import json
import time
from pathlib import Path

import httpx

from .world import utc

TOOL_FOR_EVENT = {
    "CustomerCreated": "create_customer", "CustomerUpdated": "update_customer", "VendorCreated": "create_vendor",
    "VendorUpdated": "update_vendor", "CompanyOfficerRecorded": "record_company_officer", "PriceSet": "set_price",
    "PromotionCreated": "create_promotion", "EnquiryRecorded": "record_enquiry",
    "SalesOrderCreated": "create_sales_order", "DispatchRecorded": "record_dispatch",
    "EWayBillGenerated": "generate_eway_bill", "LorryReceiptRecorded": "record_lr",
    "DeliveryRecorded": "record_delivery", "InvoiceIssued": "issue_invoice", "Gstr1Filed": "file_gstr1",
    "ReceiptRecorded": "record_receipt", "BankStatementImported": "import_bank_statement",
    "CreditNoteIssued": "issue_credit_note", "SalesReturnRecorded": "record_sales_return",
    "PurchaseInvoiceRecorded": "record_purchase_invoice", "GoodsReceiptRecorded": "record_goods_receipt",
    "PaymentMade": "record_payment", "JournalPosted": "post_journal", "DocumentReversed": "reverse_document",
    "SalesRegisterUploaded": "upload_sales_register", "RelatedPartyListUploaded": "upload_related_parties",
    "EvidenceUploaded": "upload_evidence",
}
# The identifier field each create tool returns.
ID_FIELD = {"create_customer": "customer_id", "create_vendor": "vendor_id", "record_enquiry": "enquiry_id",
            "create_sales_order": "order_id", "record_dispatch": "dispatch_id", "issue_invoice": "invoice_id",
            "issue_credit_note": "credit_note_id", "record_purchase_invoice": "purchase_invoice_id"}
IST = dt.timedelta(hours=5, minutes=30)


class ToolError(Exception):
    def __init__(self, tool: str, body: dict):
        err = body.get("error") or body
        super().__init__(f"{tool}: {err.get('code')}: {err.get('message')}")
        self.code = err.get("code")


class GatewayClient:
    """Calls tools over the MCP server's HTTP gateway."""

    def __init__(self, base: str, token: str, timeout: float = 120.0):
        self.base = base.rstrip("/")
        if self.base.endswith("/mcp"):
            self.base = self.base[:-4]
        self.http = httpx.Client(timeout=timeout, headers={"Authorization": f"Bearer {token}"})

    def call(self, tool: str, args: dict, sim_time: str | None = None, retries: int = 3) -> dict:
        headers = {"X-Sim-Recorded-At": sim_time} if sim_time else {}
        for attempt in range(retries):
            try:
                r = self.http.post(f"{self.base}/api/tools/{tool}", json=args, headers=headers)
            except httpx.TransportError:
                if attempt == retries - 1:
                    raise
                time.sleep(1 + attempt)
                continue
            body = r.json() if r.content else {}
            if r.status_code >= 400 or body.get("ok") is False:
                raise ToolError(tool, body)
            return body.get("result", body)
        raise RuntimeError("unreachable")


def rupees(paise) -> float | None:
    return None if paise is None else round(int(paise) / 100, 2)


def utc_of_ist(value: str | None) -> str | None:
    if not value:
        return None
    t = dt.datetime.fromisoformat(str(value)[:19])
    return (t - IST).strftime("%Y-%m-%dT%H:%M:%SZ")


def clean(d):
    if isinstance(d, dict):
        return {k: clean(v) for k, v in d.items() if v is not None and v != [] and v != ""}
    if isinstance(d, list):
        return [clean(x) for x in d]
    return d


class McpSink:
    """Sink for generate(): appends each event through the client tools."""

    def __init__(self, url: str, token: str, out_dir: str | Path, tee=None):
        self.client = GatewayClient(url, token)
        self.files: dict[str, tuple[bytes, str]] = {}
        self.out = Path(out_dir)
        self.tee = tee  # a FixtureSink kept in step, for the client's own view of its records
        self.ids: dict[str, str] = {}  # engine-side identifiers to server identifiers
        self.invoice_by_no: dict[str, str] = {}
        self.cn_by_no: dict[str, str] = {}
        self.count = 0
        self.started = time.time()

    def put_file(self, data: bytes, name: str) -> str:
        import hashlib

        h = hashlib.sha256(data).hexdigest()
        self.files[h] = (data, name)
        if self.tee:
            self.tee.put_file(data, name)
        return h

    def _id(self, key: str | None) -> str | None:
        return self.ids.get(key) if key else None

    def _items(self, items, with_rate=True) -> list[dict]:
        out = []
        for it in items or []:
            row = {"item_code": it.get("item"), "qty": it.get("qty")}
            if with_rate and it.get("rate") is not None:
                row["rate"] = rupees(it["rate"])
            if it.get("discount_bp"):
                row["discount_percent"] = it["discount_bp"] / 100
            out.append(row)
        return out

    def _party(self, p: dict) -> dict:
        addr = (p.get("addresses") or [{}])[0] if p.get("addresses") else {}
        return {"name": p.get("name"), "gstin": p.get("gstin"), "pan": p.get("pan"),
                "state_code": addr.get("state_code"),
                "addresses": [{"line": a.get("line1"), "city": a.get("city"), "state": a.get("state_code"),
                               "pincode": a.get("pincode")} for a in p.get("addresses") or []],
                "phone": p.get("phone"), "email": p.get("email"),
                "bank_accounts": [{"account_no": b.get("account_no"), "ifsc": b.get("ifsc")} for b in p.get("bank_accounts") or []],
                "directors": [{"name": d.get("name"), "pan": d.get("pan"), "din": d.get("din")} for d in p.get("directors") or []]}

    def args_for(self, intent: dict) -> tuple[str, dict, str | None]:
        """Tool name, arguments and the engine-side key whose server id the response carries."""
        t, p, agg = intent["event_type"], intent["payload"], intent["aggregate_id"]
        tool = TOOL_FOR_EVENT[t]
        key = None
        if t in ("CustomerCreated", "VendorCreated"):
            a = dict(self._party(p), effective_from=p.get("effective_from"))
            key = agg
        elif t in ("CustomerUpdated", "VendorUpdated"):
            kind = "customer" if t == "CustomerUpdated" else "vendor"
            ch = p.get("changes") or {}
            a = {f"{kind}_id": self._id(p.get(f"{kind}_id")), "effective_from": p.get("effective_from")}
            party = self._party({k: v for k, v in ch.items()})
            a.update({k: v for k, v in party.items() if k in ch or (k == "state_code" and "addresses" in ch)})
        elif t == "CompanyOfficerRecorded":
            ad = p.get("address") or {}
            a = {"name": p.get("name"), "pan": p.get("pan"), "din": p.get("din"), "role": p.get("role"),
                 "phone": p.get("phone"), "email": p.get("email"),
                 "address": ", ".join(x for x in (ad.get("line1"), ad.get("city"), ad.get("pincode")) if x) or None,
                 "bank_accounts": [{"account_no": b.get("account_no"), "ifsc": b.get("ifsc")} for b in p.get("bank_accounts") or []],
                 "effective_from": p.get("effective_from"), "effective_to": p.get("effective_to")}
        elif t == "PriceSet":
            a = {"item_code": p.get("item"), "rate": rupees(p.get("rate")), "effective_from": p.get("effective_from")}
        elif t == "PromotionCreated":
            a = {"scheme_id": p.get("scheme_id"), "discount_percent": (p.get("discount_bp") or 0) / 100,
                 "valid_from": p.get("valid_from"), "valid_to": p.get("valid_to"),
                 "eligible_customer_ids": [self._id(c) for c in p.get("eligible_customers") or []] or None,
                 "approver": p.get("approver")}
        elif t == "EnquiryRecorded":
            a = {"customer_id": self._id(p.get("customer_id")), "date": p.get("date"), "channel": p.get("channel"),
                 "items": self._items(p.get("items"), with_rate=False)}
            key = agg
        elif t == "SalesOrderCreated":
            a = {"customer_id": self._id(p.get("customer_id")), "enquiry_id": self._id(p.get("enquiry_id")),
                 "order_no": p.get("order_id"), "date": p.get("order_date"), "items": self._items(p.get("items")),
                 "scheme_id": p.get("scheme_id"), "delivery_terms": str(p.get("delivery_terms") or "").lower(),
                 "approver": p.get("approver")}
            key = agg
        elif t == "DispatchRecorded":
            a = {"order_id": self._id(p.get("order_id")), "dispatched_at": utc_of_ist(p.get("dispatched_at")),
                 "items": self._items(p.get("items"), with_rate=False), "vehicle_no": p.get("vehicle_no"),
                 "from_address": p.get("from_address"), "to_address": p.get("to_address"),
                 "distance_km": p.get("distance_km")}
            key = agg
        elif t == "EWayBillGenerated":
            a = {"dispatch_id": self._id(p.get("dispatch_id")), "invoice_id": self.invoice_by_no.get(str(p.get("invoice_no"))),
                 "ewb_no": p.get("ewb_no"), "date": (p.get("generated_at") or "")[:10], "invoice_no": p.get("invoice_no"),
                 "value": rupees(p.get("value")), "supplier_gstin": p.get("supplier_gstin"),
                 "recipient_gstin": p.get("recipient_gstin"), "vehicle_no": p.get("vehicle_no"),
                 "distance_km": p.get("distance_km"), "valid_until": utc_of_ist(p.get("valid_until"))}
        elif t == "LorryReceiptRecorded":
            a = {"dispatch_id": self._id(p.get("dispatch_id")), "lr_no": p.get("lr_no"), "transporter": p.get("transporter"),
                 "date": p.get("date"), "vehicle_no": p.get("vehicle_no"), "consignee": p.get("consignee")}
        elif t == "DeliveryRecorded":
            a = {"dispatch_id": self._id(p.get("dispatch_id")), "delivered_at": utc_of_ist(p.get("delivered_at")),
                 "receiver_name": p.get("receiver"), "pod_reference": p.get("pod_ref")}
        elif t == "InvoiceIssued":
            a = {"invoice_no": p.get("invoice_no"), "date": p.get("invoice_date"),
                 "customer_id": self._id(p.get("customer_id")), "order_id": self._id(p.get("order_id")),
                 "job_no": p.get("order_id"), "items": self._items(p.get("items")),
                 "scheme_id": None, "taxable_value": rupees(p.get("taxable_value")), "discount": rupees(p.get("discount")),
                 "packing": rupees(p.get("packing")), "freight": rupees(p.get("freight")),
                 "insurance": rupees(p.get("insurance")), "cgst": rupees(p.get("cgst")), "sgst": rupees(p.get("sgst")),
                 "igst": rupees(p.get("igst")), "tcs": rupees(p.get("tcs")), "round_off": rupees(p.get("round_off")),
                 "gross": rupees(p.get("gross")), "tax_rate": (p.get("tax_rate_bp") or 0) / 100,
                 "place_of_supply": p.get("place_of_supply"), "customer_gstin": p.get("customer_gstin"),
                 "business_unit": p.get("bu"), "ledger_account": p.get("ledger_account"), "irn": p.get("irn"),
                 "einvoice_status": "Generated" if p.get("irn") else None}
            key = agg
        elif t == "Gstr1Filed":
            a = {"return_period": p.get("return_period"), "filed_on": intent["business_date"],
                 "lines": [{"invoice_no": ln.get("invoice_no"), "doc_type": "invoice", "date": ln.get("invoice_date"),
                            "gstin": ln.get("gstin"), "place_of_supply": ln.get("place_of_supply"),
                            "taxable_value": rupees(ln.get("taxable_value")), "cgst": rupees(ln.get("cgst")),
                            "sgst": rupees(ln.get("sgst")), "igst": rupees(ln.get("igst"))} for ln in p.get("lines") or []]}
        elif t == "ReceiptRecorded":
            a = {"customer_id": self._id(p.get("customer_id")),
                 "invoice_ids": [self.invoice_by_no[x] for x in p.get("invoice_refs") or [] if x in self.invoice_by_no],
                 "amount": rupees(p.get("amount")), "date": p.get("date"), "payer_name": p.get("payer_name"),
                 "payer_account": p.get("payer_account"), "utr": p.get("utr"), "mode": "NEFT"}
        elif t == "BankStatementImported":
            a = {"account_no": p.get("account_no"), "statement_date": intent["business_date"],
                 "lines": [{"date": ln.get("date"), "amount": rupees(ln.get("amount")),
                            "direction": "credit" if ln.get("direction") == "CR" else "debit",
                            "counterparty_name": ln.get("counterparty_name"),
                            "counterparty_account": ln.get("counterparty_account"), "utr": ln.get("utr")}
                           for ln in p.get("lines") or []]}
        elif t == "CreditNoteIssued":
            a = {"credit_note_no": p.get("credit_note_no"), "date": p.get("date"),
                 "invoice_id": self.invoice_by_no.get(str(p.get("original_invoice_no"))), "reason": p.get("reason"),
                 "taxable_value": rupees(p.get("taxable_value")), "cgst": rupees(p.get("cgst")),
                 "sgst": rupees(p.get("sgst")), "igst": rupees(p.get("igst")), "gross": rupees(p.get("gross")),
                 "approver": p.get("approver")}
            key = agg
        elif t == "SalesReturnRecorded":
            a = {"credit_note_id": self.cn_by_no.get(str(p.get("credit_note_no"))), "inward_date": p.get("inward_date"),
                 "items": self._items(p.get("items"), with_rate=False), "vehicle_no": p.get("vehicle_no")}
        elif t == "PurchaseInvoiceRecorded":
            a = {"vendor_id": self._id(p.get("vendor_id")), "invoice_no": p.get("invoice_no"), "date": p.get("date"),
                 "items": [{"item_code": it.get("item"), "qty": it.get("qty"), "rate": rupees(it.get("rate"))}
                           for it in p.get("items") or []],
                 "taxable_value": rupees(p.get("taxable_value")),
                 "tax": rupees((p.get("cgst") or 0) + (p.get("sgst") or 0) + (p.get("igst") or 0)),
                 "gross": rupees(p.get("gross"))}
            key = agg
        elif t == "GoodsReceiptRecorded":
            a = {"purchase_invoice_id": self._id(p.get("purchase_id")), "date": p.get("date"),
                 "items": self._items(p.get("items"), with_rate=False), "vehicle_no": p.get("vehicle_no")}
        elif t == "PaymentMade":
            a = {"vendor_id": self._id(p.get("vendor_id")),
                 "purchase_invoice_ids": [self._id(x) for x in p.get("purchase_refs") or [] if self._id(x)],
                 "amount": rupees(p.get("amount")), "date": p.get("date"), "payee_account": p.get("payee_account"),
                 "utr": p.get("utr")}
        elif t == "JournalPosted":
            lines = []
            for ln in p.get("lines") or []:
                row = {"account": ln.get("account")}
                if ln.get("debit"):
                    row["debit"] = rupees(ln["debit"])
                if ln.get("credit"):
                    row["credit"] = rupees(ln["credit"])
                lines.append(row)
            ref = next((ln.get("ref") for ln in p.get("lines") or [] if ln.get("ref")), None)
            a = {"date": p.get("date"), "narration": p.get("narration"), "reference": ref,
                 "approver": p.get("approver"), "lines": lines}
        elif t == "DocumentReversed":
            a = {"document_id": self._id(p.get("target_aggregate_id")), "reason": p.get("reason"),
                 "date": intent["business_date"]}
        elif t == "SalesRegisterUploaded":
            data, name = self.files[p["file_hash"]]
            a = {"content_base64": base64.b64encode(data).decode(), "file_name": name, "row_count": p.get("row_count"),
                 "period_start": p.get("period_start"), "period_end": p.get("period_end")}
        elif t == "RelatedPartyListUploaded":
            data, name = self.files[p["file_hash"]]
            a = {"as_of": intent["business_date"], "content_base64": base64.b64encode(data).decode(), "file_name": name,
                 "parties": [{k: v for k, v in x.items()} for x in p.get("parties") or []]}
        elif t == "EvidenceUploaded":
            data, name = self.files[p["file_hash"]]
            a = {"sample_id": p.get("sample_id"), "document_type": p.get("document_type"),
                 "content_base64": base64.b64encode(data).decode(), "file_name": name}
        else:
            raise ValueError(f"no tool mapping for {t}")
        if tool.startswith(("create_", "record_", "issue_", "set_", "generate_", "file_", "import_", "post_", "upload_")) \
                and tool not in ("upload_evidence",):
            a["entity_id"] = intent.get("entity_id") or "E1"
        return tool, clean(a), key

    def append(self, intent: dict, idem: str) -> dict:
        tool, args, key = self.args_for(intent)
        args["idempotency_key"] = idem
        try:
            res = self.client.call(tool, args, utc(intent["t"]))
        except ToolError as e:
            raise RuntimeError(f"{e} (event {intent['event_type']} {intent['aggregate_id']})") from e
        if key and ID_FIELD.get(tool) in res:
            self.ids[key] = res[ID_FIELD[tool]]
        if tool == "issue_invoice" and res.get("invoice_id"):
            self.invoice_by_no[str(intent["payload"].get("invoice_no"))] = res["invoice_id"]
        if tool == "issue_credit_note" and res.get("credit_note_id"):
            self.cn_by_no[str(intent["payload"].get("credit_note_no"))] = res["credit_note_id"]
        self.count += 1
        if self.tee:
            self.tee.append(intent, idem)
        if self.count % 500 == 0:
            rate = self.count / max(1e-6, time.time() - self.started)
            print(f"  loaded {self.count} events ({rate:.0f} per second)", flush=True)
        return res

    def close(self) -> None:
        if self.tee:
            self.tee.close()
        (self.out / "mcp_load.json").write_text(json.dumps({"calls": self.count, "ids": len(self.ids)}), encoding="utf-8")
        (self.out / "server_ids.json").write_text(json.dumps(self.ids, indent=0), encoding="utf-8")


def upload_file(base: str, token: str, data: bytes, name: str) -> dict:
    """Store a file through POST /api/files (used for the company profile the engine reads)."""
    base = base.rstrip("/")
    if base.endswith("/mcp"):
        base = base[:-4]
    r = httpx.post(f"{base}/api/files", content=data, timeout=60,
                   headers={"Authorization": f"Bearer {token}", "X-File-Name": name, "Content-Type": "application/toml"})
    r.raise_for_status()
    return r.json()


PREFIX = {"create_customer": "cus", "create_vendor": "ven", "record_enquiry": "enq", "create_sales_order": "ord",
          "record_dispatch": "dsp", "issue_invoice": "inv", "issue_credit_note": "crn",
          "record_purchase_invoice": "pin", "post_journal": "jrn", "record_receipt": "rcp"}


def server_id(tool: str, idempotency_key: str) -> str:
    """The identifier the MCP server assigns to a created record (prefix and SHA-256 of tool and key)."""
    import hashlib

    return PREFIX[tool] + "_" + hashlib.sha256(f"{tool}|{idempotency_key}".encode()).hexdigest()[:16]
