"""Documents as of a snapshot sequence number (PRD sections 6 and 16.1).

Every document is a dict holding its payload fields plus metadata keys that
start with an underscore: ``_seq``, ``_event_type``, ``_aggregate_id``,
``_sale_id``, ``_entity_id``, ``_business_date``, ``_recorded_at``,
``_identity``. Nothing here filters by period; detectors decide that.
"""

from __future__ import annotations

import copy
import datetime as dt
from collections import defaultdict
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Iterable

from . import gstin as gst

PARTY_FIELDS = ("name", "gstin", "pan", "addresses", "phone", "email", "bank_accounts", "directors")


@lru_cache(maxsize=65536)
def d(value: str | None) -> dt.date | None:
    """Parse a date or the date part of a date-time string."""
    if not value:
        return None
    try:
        return dt.date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


@lru_cache(maxsize=65536)
def ts(value: str | None) -> dt.datetime | None:
    """Parse a date-time. A bare date is taken as midnight. A trailing Z is dropped (UTC)."""
    if not value:
        return None
    s = str(value).rstrip("Z")
    try:
        if len(s) == 10:
            return dt.datetime.fromisoformat(s + "T00:00:00")
        return dt.datetime.fromisoformat(s).replace(tzinfo=None)
    except ValueError:
        return None


def _doc(ev: dict) -> dict:
    out = dict(ev.get("payload") or {})
    out.update({
        "_seq": ev["seq"], "_event_type": ev["event_type"], "_aggregate_id": ev.get("aggregate_id"),
        "_sale_id": ev.get("sale_id"), "_entity_id": ev.get("entity_id"),
        "_business_date": ev.get("business_date"), "_recorded_at": ev.get("recorded_at"),
        "_identity": ev.get("identity") or {},
    })
    return out


@dataclass
class Party:
    party_id: str
    kind: str  # customer or vendor
    entity_id: str | None
    versions: list[dict] = field(default_factory=list)  # {effective_from, seq, state}

    @property
    def state(self) -> dict:
        return self.versions[-1]["state"] if self.versions else {}

    def state_at(self, on: dt.date) -> dict:
        """Master data in force on a date. Falls back to the first version."""
        chosen = self.versions[0]["state"] if self.versions else {}
        for v in self.versions:
            ef = d(v["effective_from"])
            if ef is None or ef <= on:
                chosen = v["state"]
        return chosen

    @property
    def name(self) -> str:
        return self.state.get("name") or self.party_id

    @property
    def created_seq(self) -> int:
        return self.versions[0]["seq"] if self.versions else 0


class Snapshot:
    """In-memory view of the business chain up to ``snapshot_seq``."""

    def __init__(self, events: Iterable[dict], postings: Iterable[dict], snapshot_seq: int,
                 company: dict | None = None):
        self.snapshot_seq = snapshot_seq
        self.company_profile = company or {}
        self.events: list[dict] = []
        self.postings: list[dict] = list(postings)
        self.customers: dict[str, Party] = {}
        self.vendors: dict[str, Party] = {}
        self.officers: dict[str, dict] = {}
        self.prices: dict[str, list[dict]] = defaultdict(list)
        self.promotions: dict[str, dict] = {}
        self.enquiries: dict[str, dict] = {}
        self.orders: dict[str, dict] = {}
        self.dispatches: dict[str, dict] = {}
        self.deliveries: dict[str, list[dict]] = defaultdict(list)
        self.ewbs: list[dict] = []
        self.lrs: list[dict] = []
        self.invoices: list[dict] = []
        self.gstr1_filings: list[dict] = []
        self.gstr1_lines: list[dict] = []
        self.receipts: list[dict] = []
        self.bank_lines: list[dict] = []
        self.credit_notes: list[dict] = []
        self.sales_returns: list[dict] = []
        self.purchases: list[dict] = []
        self.goods_receipts: list[dict] = []
        self.payments: list[dict] = []
        self.journals: list[dict] = []
        self.reversals: dict[str, dict] = {}
        self.register_uploads: list[dict] = []
        self.rp_uploads: list[dict] = []
        self.evidence_uploads: list[dict] = []
        self.by_aggregate: dict[str, dict] = {}
        self.events_by_sale: dict[str, list[dict]] = defaultdict(list)
        self.events_by_seq: dict[int, dict] = {}
        self.company_bank_accounts: dict[str, set[str]] = defaultdict(set)
        self.company_gstins: dict[str, set[str]] = defaultdict(set)
        for ev in events:
            if ev["seq"] > snapshot_seq:
                break
            self._apply(ev)
        self._index()

    # Building

    def _apply(self, ev: dict) -> None:
        self.events.append(ev)
        self.events_by_seq[ev["seq"]] = ev
        if ev.get("sale_id"):
            self.events_by_sale[ev["sale_id"]].append(ev)
        t, p, doc = ev["event_type"], ev.get("payload") or {}, _doc(ev)
        agg = ev.get("aggregate_id")
        if agg and agg not in self.by_aggregate:
            self.by_aggregate[agg] = doc

        if t in ("CustomerCreated", "VendorCreated"):
            kind = "customer" if t == "CustomerCreated" else "vendor"
            pid = p.get(f"{kind}_id") or agg
            book = self.customers if kind == "customer" else self.vendors
            party = book.get(pid) or Party(pid, kind, ev.get("entity_id"))
            state = {k: copy.deepcopy(p.get(k)) for k in PARTY_FIELDS}
            party.versions.append({"effective_from": p.get("effective_from") or ev.get("business_date"),
                                   "seq": ev["seq"], "state": state, "changes": None})
            book[pid] = party
        elif t in ("CustomerUpdated", "VendorUpdated"):
            kind = "customer" if t == "CustomerUpdated" else "vendor"
            pid = p.get(f"{kind}_id") or agg
            book = self.customers if kind == "customer" else self.vendors
            party = book.get(pid)
            if party is None:
                party = Party(pid, kind, ev.get("entity_id"))
                book[pid] = party
            state = copy.deepcopy(party.state)
            for k, v in (p.get("changes") or {}).items():
                state[k] = copy.deepcopy(v)
            party.versions.append({"effective_from": p.get("effective_from") or ev.get("business_date"),
                                   "seq": ev["seq"], "state": state, "changes": p.get("changes") or {}})
        elif t == "CompanyOfficerRecorded":
            self.officers[p.get("officer_id") or agg] = doc
        elif t == "PriceSet":
            self.prices[p.get("item")].append(doc)
        elif t == "PromotionCreated":
            self.promotions[p.get("scheme_id")] = doc
        elif t == "EnquiryRecorded":
            self.enquiries[p.get("enquiry_id") or agg] = doc
        elif t == "SalesOrderCreated":
            self.orders[p.get("order_id") or agg] = doc
        elif t == "DispatchRecorded":
            self.dispatches[p.get("dispatch_id") or agg] = doc
        elif t == "DeliveryRecorded":
            self.deliveries[p.get("dispatch_id") or agg].append(doc)
        elif t == "EWayBillGenerated":
            self.ewbs.append(doc)
        elif t == "LorryReceiptRecorded":
            self.lrs.append(doc)
        elif t == "InvoiceIssued":
            self.invoices.append(doc)
        elif t == "Gstr1Filed":
            self.gstr1_filings.append(doc)
            if p.get("supplier_gstin"):
                self.company_gstins[ev.get("entity_id")].add(gst.normalise(p["supplier_gstin"]))
            for i, line in enumerate(p.get("lines") or []):
                ln = dict(line)
                ln.update({"_seq": ev["seq"], "_line": i, "return_period": p.get("return_period"),
                           "_entity_id": ev.get("entity_id"), "_aggregate_id": agg})
                self.gstr1_lines.append(ln)
        elif t == "ReceiptRecorded":
            self.receipts.append(doc)
        elif t == "BankStatementImported":
            if p.get("account_no"):
                self.company_bank_accounts[ev.get("entity_id")].add(_acct(p["account_no"]))
            for i, line in enumerate(p.get("lines") or []):
                ln = dict(line)
                ln.update({"_seq": ev["seq"], "_line": i, "statement_id": p.get("statement_id"),
                           "_entity_id": ev.get("entity_id"), "_aggregate_id": agg})
                self.bank_lines.append(ln)
        elif t == "CreditNoteIssued":
            self.credit_notes.append(doc)
        elif t == "SalesReturnRecorded":
            self.sales_returns.append(doc)
        elif t == "PurchaseInvoiceRecorded":
            self.purchases.append(doc)
        elif t == "GoodsReceiptRecorded":
            self.goods_receipts.append(doc)
        elif t == "PaymentMade":
            self.payments.append(doc)
        elif t == "JournalPosted":
            self.journals.append(doc)
        elif t == "DocumentReversed":
            target = p.get("target_aggregate_id")
            if target and target not in self.reversals:
                self.reversals[target] = doc
        elif t == "SalesRegisterUploaded":
            self.register_uploads.append(doc)
        elif t == "RelatedPartyListUploaded":
            self.rp_uploads.append(doc)
        elif t == "EvidenceUploaded":
            self.evidence_uploads.append(doc)
        if t == "EWayBillGenerated" and p.get("supplier_gstin"):
            self.company_gstins[ev.get("entity_id")].add(gst.normalise(p["supplier_gstin"]))

    def _index(self) -> None:
        self.invoices_by_no: dict[str, list[dict]] = defaultdict(list)
        self.invoices_by_sale: dict[str, list[dict]] = defaultdict(list)
        for inv in self.invoices:
            inv["_reversed"] = self.reversals.get(inv["_aggregate_id"])
            self.invoices_by_no[str(inv.get("invoice_no"))].append(inv)
            if inv["_sale_id"]:
                self.invoices_by_sale[inv["_sale_id"]].append(inv)
        for cn in self.credit_notes:
            cn["_reversed"] = self.reversals.get(cn["_aggregate_id"])
        for j in self.journals:
            j["_reversed"] = self.reversals.get(j["_aggregate_id"])
        self.ewbs_by_invoice: dict[str, list[dict]] = defaultdict(list)
        self.ewbs_by_dispatch: dict[str, list[dict]] = defaultdict(list)
        for e in self.ewbs:
            self.ewbs_by_invoice[str(e.get("invoice_no"))].append(e)
            if e.get("dispatch_id"):
                self.ewbs_by_dispatch[e["dispatch_id"]].append(e)
        self.lrs_by_dispatch: dict[str, list[dict]] = defaultdict(list)
        for lr in self.lrs:
            if lr.get("dispatch_id"):
                self.lrs_by_dispatch[lr["dispatch_id"]].append(lr)
        self.dispatches_by_order: dict[str, list[dict]] = defaultdict(list)
        for ds in self.dispatches.values():
            self.dispatches_by_order[ds.get("order_id")].append(ds)
        self.gstr1_by_invoice: dict[str, list[dict]] = defaultdict(list)
        for ln in self.gstr1_lines:
            self.gstr1_by_invoice[str(ln.get("invoice_no"))].append(ln)
        self.receipts_by_invoice: dict[str, list[dict]] = defaultdict(list)
        for r in self.receipts:
            for ref in r.get("invoice_refs") or []:
                self.receipts_by_invoice[str(ref)].append(r)
        self.credit_notes_by_invoice: dict[str, list[dict]] = defaultdict(list)
        for cn in self.credit_notes:
            self.credit_notes_by_invoice[str(cn.get("original_invoice_no"))].append(cn)
        self.returns_by_cn: dict[str, list[dict]] = defaultdict(list)
        for sr in self.sales_returns:
            self.returns_by_cn[str(sr.get("credit_note_no"))].append(sr)
        self.postings_by_seq: dict[int, list[dict]] = defaultdict(list)
        for po in self.postings:
            self.postings_by_seq[po["seq"]].append(po)

    # Queries

    def customer(self, customer_id: str | None) -> Party | None:
        return self.customers.get(customer_id) if customer_id else None

    def active_invoices(self, entity_ids: set[str] | None = None) -> list[dict]:
        """Invoices not reversed, in seq order."""
        return [i for i in self.invoices if not i["_reversed"] and _in(i, entity_ids)]

    def invoices_in_period(self, start: dt.date, end: dt.date, entity_ids=None,
                           include_reversed: bool = False) -> list[dict]:
        out = []
        for inv in self.invoices:
            if not _in(inv, entity_ids):
                continue
            if inv["_reversed"] and not include_reversed:
                continue
            idate = d(inv.get("invoice_date")) or d(inv["_business_date"])
            if idate and start <= idate <= end:
                out.append(inv)
        return out

    def dispatch_for_invoice(self, inv: dict) -> dict | None:
        if inv.get("dispatch_id") and inv["dispatch_id"] in self.dispatches:
            return self.dispatches[inv["dispatch_id"]]
        if inv.get("order_id"):
            ds = self.dispatches_by_order.get(inv["order_id"]) or []
            if ds:
                return ds[0]
        return None

    def delivery_for_dispatch(self, dispatch_id: str | None) -> dict | None:
        if not dispatch_id:
            return None
        ds = self.deliveries.get(dispatch_id) or []
        return ds[-1] if ds else None

    def price_on(self, item: str, on: dt.date) -> int | None:
        rate = None
        for p in sorted(self.prices.get(item) or [], key=lambda x: (x.get("effective_from") or "", x["_seq"])):
            ef = d(p.get("effective_from"))
            if ef is None or ef <= on:
                rate = p.get("rate")
        return rate

    def postings_for(self, seq: int) -> list[dict]:
        return self.postings_by_seq.get(seq, [])

    def company_gstin(self, entity_id: str | None) -> str | None:
        prof = (self.company_profile.get("entities") or {}).get(entity_id or "", {})
        if prof.get("gstin"):
            return gst.normalise(prof["gstin"])
        found = sorted(self.company_gstins.get(entity_id) or [])
        return found[0] if found else None

    def company_state(self, entity_id: str | None) -> str | None:
        return gst.state_of(self.company_gstin(entity_id))

    def latest_upload(self, kind: str) -> dict | None:
        items = self.register_uploads if kind == "register" else self.rp_uploads
        return items[-1] if items else None


def _in(doc: dict, entity_ids: set[str] | None) -> bool:
    return not entity_ids or doc.get("_entity_id") in entity_ids


def _acct(no: str | None) -> str:
    return "".join(ch for ch in str(no or "") if ch.isalnum()).upper()


normalise_account = _acct
