"""Load generated events through the MCP client tools (SD-2).

Each event becomes one ``tools/call`` of the tool named in PRD section 6.3. The
arguments are the payload fields plus the envelope fields the caller owns:
``entity_id``, ``aggregate_id``, ``sale_id``, ``business_date`` and
``idempotency_key``. Upload tools receive the file as ``content_base64``.
The simulated clock is sent in ``X-Sim-Recorded-At`` (contracts/events, section 3).
"""

from __future__ import annotations

import base64
import itertools
import json
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


class McpError(Exception):
    pass


class McpClient:
    """Minimal MCP client over Streamable HTTP (JSON or SSE responses)."""

    def __init__(self, url: str, token: str | None, timeout: float = 60.0):
        self.url = url.rstrip("/")
        self.http = httpx.Client(timeout=timeout)
        self.headers = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
        if token:
            self.headers["Authorization"] = f"Bearer {token}"
        self.ids = itertools.count(1)
        self.session: str | None = None
        self._initialise()

    def _post(self, body: dict, extra: dict | None = None) -> dict | None:
        headers = dict(self.headers)
        if self.session:
            headers["Mcp-Session-Id"] = self.session
        if extra:
            headers.update(extra)
        r = self.http.post(self.url, json=body, headers=headers)
        if "mcp-session-id" in r.headers:
            self.session = r.headers["mcp-session-id"]
        if r.status_code == 202 or not r.content:
            return None
        r.raise_for_status()
        if r.headers.get("content-type", "").startswith("text/event-stream"):
            for line in r.text.splitlines():
                if line.startswith("data:"):
                    msg = json.loads(line[5:].strip())
                    if msg.get("id") == body.get("id"):
                        return msg
            return None
        return r.json()

    def _initialise(self) -> None:
        self._post({"jsonrpc": "2.0", "id": next(self.ids), "method": "initialize",
                    "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                               "clientInfo": {"name": "elev-datagen", "version": "0.1.0"}}})
        self._post({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def call(self, tool: str, arguments: dict, headers: dict | None = None) -> dict:
        msg = self._post({"jsonrpc": "2.0", "id": next(self.ids), "method": "tools/call",
                          "params": {"name": tool, "arguments": arguments}}, headers)
        if msg is None:
            raise McpError(f"{tool}: no response")
        if "error" in msg:
            raise McpError(f"{tool}: {msg['error']}")
        result = msg.get("result") or {}
        content = result.get("structuredContent")
        if content is None:
            texts = [c.get("text", "") for c in result.get("content", []) if c.get("type") == "text"]
            try:
                content = json.loads(texts[0]) if texts else {}
            except json.JSONDecodeError:
                content = {"text": texts[0]}
        if result.get("isError"):
            raise McpError(f"{tool}: {content}")
        return content

    def list_tools(self) -> list[str]:
        msg = self._post({"jsonrpc": "2.0", "id": next(self.ids), "method": "tools/list", "params": {}})
        return [t["name"] for t in (msg or {}).get("result", {}).get("tools", [])]


class McpSink:
    def __init__(self, url: str, token: str | None, out_dir: str | Path):
        self.client = McpClient(url, token)
        self.files: dict[str, tuple[bytes, str]] = {}
        self.out = Path(out_dir)
        self.count = 0

    def put_file(self, data: bytes, name: str) -> str:
        import hashlib

        h = hashlib.sha256(data).hexdigest()
        self.files[h] = (data, name)
        return h

    def append(self, intent: dict, idem: str) -> dict:
        etype = intent["event_type"]
        tool = TOOL_FOR_EVENT[etype]
        args = dict(intent["payload"])
        args.update({"entity_id": intent["entity_id"], "aggregate_id": intent["aggregate_id"],
                     "sale_id": intent["sale_id"], "business_date": intent["business_date"],
                     "idempotency_key": idem})
        if etype in ("SalesRegisterUploaded", "RelatedPartyListUploaded", "EvidenceUploaded"):
            data, name = self.files[args["file_hash"]]
            args["content_base64"] = base64.b64encode(data).decode("ascii")
            args["file_name"] = name
        self.count += 1
        return self.client.call(tool, args, {"X-Sim-Recorded-At": utc(intent["t"])})

    def close(self) -> None:
        (self.out / "mcp_load.json").write_text(json.dumps({"calls": self.count}), encoding="utf-8")
