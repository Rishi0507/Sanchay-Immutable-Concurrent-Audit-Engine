"""Translation from the shared event catalogue (contracts/events.json) to the engine's internal records.

The ledger stores events in the catalogue's shape: system-assigned identifiers
(``cus_...``, ``inv_...``), references by identifier, UTC date-times and the
catalogue's field names. The detectors were written against a flatter shape
that carries business numbers (invoice numbers, credit note numbers) and
Indian Standard Time. This module converts one event at a time, in sequence
order, remembering only what later events refer to. Nothing in the business
schema is changed; the translation exists only inside the engine.
"""

from __future__ import annotations

import datetime as dt
from typing import Iterable, Iterator

IST = dt.timedelta(hours=5, minutes=30)

DOC_TYPE_IN = {"lr_copy": "lr_copy", "lr": "lr_copy", "sales_return": "sales_return", "return_document": "sales_return"}


def is_catalogue_event(ev: dict) -> bool:
    return "aggregate_type" in ev


def ist(value: str | None) -> str | None:
    """RFC 3339 UTC to an IST wall-clock string. Dates and values without a zone are returned unchanged."""
    if not value or len(value) <= 10:
        return value
    s = str(value)
    if not (s.endswith("Z") or "+" in s[10:]):
        return s[:19]
    try:
        t = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return s[:19]
    return (t.astimezone(dt.timezone.utc).replace(tzinfo=None) + IST).strftime("%Y-%m-%dT%H:%M:%S")


def _bp(percent) -> int:
    try:
        return int(round(float(percent or 0) * 100))
    except (TypeError, ValueError):
        return 0


def _items(items) -> list[dict]:
    out = []
    for it in items or []:
        qty = it.get("qty") or 0
        rate = it.get("rate") or 0
        bp = _bp(it.get("discount_percent"))
        q = int(qty) if float(qty).is_integer() else qty
        line = {"item": it.get("item_code") or it.get("item"), "qty": q, "rate": int(rate), "discount_bp": bp}
        line["amount"] = int(round(qty * rate * (10000 - bp) / 10000))
        out.append(line)
    return out


def _address(a) -> dict:
    if isinstance(a, str):
        return {"line1": a, "city": "", "state_code": "", "pincode": ""}
    a = a or {}
    return {"line1": a.get("line") or a.get("line1") or "", "city": a.get("city") or "",
            "state_code": a.get("state_code") or a.get("state") or "", "pincode": a.get("pincode") or "",
            "kind": a.get("kind") or "billing"}


PARTY_KEYS = ("name", "gstin", "pan", "addresses", "phone", "email", "bank_accounts", "directors")


class Translator:
    def __init__(self) -> None:
        self.invoice_no: dict[str, str] = {}
        self.invoice_customer: dict[str, str] = {}
        self.cn_no: dict[str, str] = {}
        self.party_name: dict[str, str] = {}
        self.party_gstin: dict[str, str] = {}
        self.dispatch_of_order: dict[str, str] = {}
        self.dispatch_of_invoice: dict[str, str] = {}
        self.order_of_invoice: dict[str, str] = {}
        self.purchase_no: dict[str, str] = {}

    def _dispatch_for(self, p: dict) -> str | None:
        if p.get("dispatch_id"):
            return p["dispatch_id"]
        if p.get("invoice_id") and p["invoice_id"] in self.dispatch_of_invoice:
            return self.dispatch_of_invoice[p["invoice_id"]]
        order = p.get("order_id") or self.order_of_invoice.get(p.get("invoice_id") or "")
        return self.dispatch_of_order.get(order or "")

    def translate(self, ev: dict) -> dict:
        t, p, agg = ev["event_type"], dict(ev.get("payload") or {}), ev.get("aggregate_id")
        out = dict(ev)
        q: dict = {}
        if t in ("CustomerCreated", "VendorCreated"):
            kind = "customer" if t == "CustomerCreated" else "vendor"
            q = {f"{kind}_id": agg, "name": p.get("name"), "gstin": p.get("gstin"), "pan": p.get("pan"),
                 "addresses": [_address(a) for a in p.get("addresses") or []], "phone": p.get("phone"),
                 "email": p.get("email"), "bank_accounts": [{"account_no": b.get("account_no"), "ifsc": b.get("ifsc")}
                                                            for b in p.get("bank_accounts") or []],
                 "directors": [{"name": d.get("name"), "pan": d.get("pan"), "din": d.get("din")}
                               for d in p.get("directors") or []],
                 "effective_from": p.get("effective_from"), "state_code": p.get("state_code")}
            self.party_name[agg] = p.get("name") or agg
            if p.get("gstin"):
                self.party_gstin[agg] = p["gstin"]
        elif t in ("CustomerUpdated", "VendorUpdated"):
            kind = "customer" if t == "CustomerUpdated" else "vendor"
            changes = {}
            for k in PARTY_KEYS:
                if p.get(k) is None:
                    continue
                if k == "addresses":
                    changes[k] = [_address(a) for a in p[k]]
                elif k == "bank_accounts":
                    changes[k] = [{"account_no": b.get("account_no"), "ifsc": b.get("ifsc")} for b in p[k]]
                elif k == "directors":
                    changes[k] = [{"name": d.get("name"), "pan": d.get("pan"), "din": d.get("din")} for d in p[k]]
                else:
                    changes[k] = p[k]
            if p.get("name"):
                self.party_name[agg] = p["name"]
            if p.get("gstin"):
                self.party_gstin[agg] = p["gstin"]
            q = {f"{kind}_id": agg, "changes": changes, "effective_from": p.get("effective_from")}
        elif t == "CompanyOfficerRecorded":
            q = {"officer_id": agg, "name": p.get("name"), "pan": p.get("pan"), "din": p.get("din"),
                 "role": p.get("role"), "phone": p.get("phone"), "email": p.get("email"),
                 "address": _address(p.get("address")) if p.get("address") else None,
                 "bank_accounts": [{"account_no": b.get("account_no"), "ifsc": b.get("ifsc")} for b in p.get("bank_accounts") or []],
                 "effective_from": p.get("effective_from"), "effective_to": p.get("effective_to")}
        elif t == "PriceSet":
            q = {"item": p.get("item_code"), "rate": p.get("rate"), "effective_from": p.get("effective_from")}
        elif t == "PromotionCreated":
            q = {"scheme_id": p.get("scheme_id"), "discount_bp": _bp(p.get("discount_percent")),
                 "valid_from": p.get("valid_from"), "valid_to": p.get("valid_to"),
                 "eligible_customers": p.get("eligible_customer_ids") or None, "approver": p.get("approver")}
        elif t == "EnquiryRecorded":
            q = {"enquiry_id": agg, "customer_id": p.get("customer_id"), "date": p.get("date"),
                 "channel": p.get("channel"), "items": [{"item": i["item"], "qty": i["qty"]} for i in _items(p.get("items"))]}
        elif t == "SalesOrderCreated":
            q = {"order_id": agg, "order_no": p.get("order_no"), "enquiry_id": p.get("enquiry_id"),
                 "customer_id": p.get("customer_id"), "order_date": p.get("date"),
                 "items": [{k: v for k, v in i.items() if k != "amount"} for i in _items(p.get("items"))],
                 "scheme_id": p.get("scheme_id"), "delivery_terms": str(p.get("delivery_terms") or "").upper() or None,
                 "approver": p.get("approver"), "bu": None, "unit": None}
        elif t == "DispatchRecorded":
            if p.get("order_id"):
                self.dispatch_of_order.setdefault(p["order_id"], agg)
            if p.get("invoice_id"):
                self.dispatch_of_invoice.setdefault(p["invoice_id"], agg)
            q = {"dispatch_id": agg, "order_id": p.get("order_id") or self.order_of_invoice.get(p.get("invoice_id") or ""),
                 "invoice_id": p.get("invoice_id"), "dispatched_at": ist(p.get("dispatched_at")),
                 "items": [{"item": i["item"], "qty": i["qty"]} for i in _items(p.get("items"))],
                 "vehicle_no": p.get("vehicle_no"), "from_address": p.get("from_address"),
                 "to_address": p.get("to_address"), "distance_km": int(p.get("distance_km") or 0)}
        elif t == "EWayBillGenerated":
            inv_no = p.get("invoice_no") or self.invoice_no.get(p.get("invoice_id") or "")
            date = p.get("date")
            q = {"ewb_no": str(p.get("ewb_no")), "invoice_no": inv_no, "dispatch_id": self._dispatch_for(p),
                 "value": p.get("value"), "supplier_gstin": p.get("supplier_gstin"),
                 "recipient_gstin": p.get("recipient_gstin"), "vehicle_no": p.get("vehicle_no"),
                 "distance_km": int(p.get("distance_km") or 0),
                 "generated_at": (date + "T00:00:00") if date else None, "valid_until": ist(p.get("valid_until"))}
        elif t == "LorryReceiptRecorded":
            q = {"lr_no": p.get("lr_no"), "dispatch_id": self._dispatch_for(p), "transporter": p.get("transporter"),
                 "vehicle_no": p.get("vehicle_no"), "date": p.get("date"), "consignee": p.get("consignee")}
        elif t == "DeliveryRecorded":
            q = {"dispatch_id": self._dispatch_for(p), "delivered_at": ist(p.get("delivered_at")),
                 "receiver": p.get("receiver_name"), "pod_ref": p.get("pod_reference")}
        elif t == "InvoiceIssued":
            self.invoice_no[agg] = p.get("invoice_no")
            self.invoice_customer[agg] = p.get("customer_id")
            if p.get("order_id"):
                self.order_of_invoice[agg] = p["order_id"]
            q = {"invoice_no": p.get("invoice_no"), "invoice_date": p.get("date"), "customer_id": p.get("customer_id"),
                 "customer_name": self.party_name.get(p.get("customer_id") or "", p.get("customer_id")),
                 "customer_gstin": p.get("customer_gstin") or self.party_gstin.get(p.get("customer_id") or ""),
                 "order_id": p.get("order_id"), "dispatch_id": self.dispatch_of_order.get(p.get("order_id") or ""),
                 "job_no": p.get("job_no"), "items": _items(p.get("items")), "scheme_id": p.get("scheme_id"),
                 "taxable_value": p.get("taxable_value") or 0, "discount": p.get("discount") or 0,
                 "packing": p.get("packing") or 0, "freight": p.get("freight") or 0,
                 "insurance": p.get("insurance") or 0, "cgst": p.get("cgst") or 0, "sgst": p.get("sgst") or 0,
                 "igst": p.get("igst") or 0, "tcs": p.get("tcs") or 0, "round_off": p.get("round_off") or 0,
                 "gross": p.get("gross") or 0, "place_of_supply": p.get("place_of_supply"),
                 "tax_rate_bp": _bp(p.get("tax_rate")), "irn": p.get("irn"),
                 "ledger_account": p.get("ledger_account"), "bu": p.get("business_unit"), "unit": None,
                 "invoice_id": agg}
        elif t == "Gstr1Filed":
            lines = []
            for ln in p.get("lines") or []:
                if (ln.get("doc_type") or "invoice") != "invoice":
                    continue
                lines.append({"invoice_no": ln.get("invoice_no"), "invoice_date": ln.get("date"), "gstin": ln.get("gstin"),
                              "taxable_value": ln.get("taxable_value") or 0, "cgst": ln.get("cgst") or 0,
                              "sgst": ln.get("sgst") or 0, "igst": ln.get("igst") or 0,
                              "place_of_supply": ln.get("place_of_supply")})
            q = {"return_period": p.get("return_period"), "supplier_gstin": None, "lines": lines}
        elif t == "ReceiptRecorded":
            ids = p.get("invoice_ids") or []
            q = {"receipt_id": agg, "customer_id": p.get("customer_id"),
                 "invoice_refs": [self.invoice_no.get(i, i) for i in ids], "amount": p.get("amount") or 0,
                 "date": p.get("date"), "payer_name": p.get("payer_name"), "payer_account": p.get("payer_account"),
                 "utr": p.get("utr")}
        elif t == "BankStatementImported":
            q = {"statement_id": agg, "account_no": p.get("account_no"),
                 "lines": [{"date": ln.get("date"), "amount": ln.get("amount") or 0,
                            "direction": "CR" if str(ln.get("direction")).lower() in ("credit", "cr") else "DR",
                            "counterparty_name": ln.get("counterparty_name"),
                            "counterparty_account": ln.get("counterparty_account"), "utr": ln.get("utr")}
                           for ln in p.get("lines") or []]}
        elif t == "CreditNoteIssued":
            self.cn_no[agg] = p.get("credit_note_no")
            q = {"credit_note_no": p.get("credit_note_no"), "date": p.get("date"),
                 "original_invoice_no": self.invoice_no.get(p.get("invoice_id") or "", p.get("invoice_id")),
                 "customer_id": self.invoice_customer.get(p.get("invoice_id") or ""), "reason": p.get("reason"),
                 "taxable_value": p.get("taxable_value") or 0, "cgst": p.get("cgst") or 0, "sgst": p.get("sgst") or 0,
                 "igst": p.get("igst") or 0, "gross": p.get("gross") or 0, "approver": p.get("approver"),
                 "invoice_id": p.get("invoice_id")}
        elif t == "SalesReturnRecorded":
            q = {"credit_note_no": self.cn_no.get(p.get("credit_note_id") or ""), "invoice_id": p.get("invoice_id"),
                 "inward_date": p.get("inward_date"),
                 "items": [{"item": i["item"], "qty": i["qty"]} for i in _items(p.get("items"))],
                 "vehicle_no": p.get("vehicle_no")}
        elif t == "PurchaseInvoiceRecorded":
            self.purchase_no[agg] = p.get("invoice_no")
            tax = p.get("tax") or 0
            q = {"purchase_id": agg, "vendor_id": p.get("vendor_id"), "invoice_no": p.get("invoice_no"),
                 "date": p.get("date"), "items": _items(p.get("items")), "taxable_value": p.get("taxable_value") or 0,
                 "cgst": 0, "sgst": 0, "igst": tax, "gross": p.get("gross") or 0}
        elif t == "GoodsReceiptRecorded":
            q = {"purchase_id": p.get("purchase_invoice_id"), "date": p.get("date"),
                 "items": [{"item": i["item"], "qty": i["qty"]} for i in _items(p.get("items"))],
                 "vehicle_no": p.get("vehicle_no")}
        elif t == "PaymentMade":
            q = {"payment_id": agg, "vendor_id": p.get("vendor_id"), "amount": p.get("amount") or 0, "date": p.get("date"),
                 "payee_account": p.get("payee_account"), "payee_name": p.get("payee_name"), "utr": p.get("utr"),
                 "purchase_refs": p.get("purchase_invoice_ids") or []}
        elif t == "JournalPosted":
            q = {"journal_id": agg, "date": p.get("date"), "narration": p.get("narration"),
                 "lines": [{"account": str(ln.get("account")), "debit": ln.get("debit") or 0, "credit": ln.get("credit") or 0,
                            "ref": p.get("reference")} for ln in p.get("lines") or []],
                 "approver": p.get("approver"), "reference": p.get("reference")}
        elif t == "DocumentReversed":
            q = {"target_aggregate_id": p.get("target_id") or agg, "reason": p.get("reason"), "date": p.get("date")}
        elif t == "SalesRegisterUploaded":
            q = {"file_hash": p.get("file_hash"), "file_name": p.get("file_name"), "row_count": p.get("row_count"),
                 "period_start": p.get("period_start"), "period_end": p.get("period_end")}
        elif t == "RelatedPartyListUploaded":
            q = {"file_hash": p.get("file_hash"), "file_name": p.get("file_name"), "as_of": p.get("as_of"),
                 "parties": [{"name": x.get("name"), "pan": x.get("pan"), "gstin": x.get("gstin"),
                              "relationship": x.get("relationship"), "effective_from": x.get("effective_from")}
                             for x in p.get("parties") or []]}
        elif t == "EvidenceUploaded":
            doc = DOC_TYPE_IN.get(p.get("document_type"), p.get("document_type"))
            q = {"sample_id": p.get("sample_id"), "document_type": doc, "file_hash": p.get("file_hash"),
                 "file_name": p.get("file_name"), "request_id": p.get("request_id")}
        else:
            q = p
        out["payload"] = q
        out.setdefault("identity", {"user": ev.get("identity_user"), "role": ev.get("identity_role")})
        return out


def translate_events(events: Iterable[dict]) -> Iterator[dict]:
    """Translate catalogue events lazily, passing engine-format events through unchanged."""
    tr = Translator()
    for ev in events:
        yield tr.translate(ev) if is_catalogue_event(ev) else ev
