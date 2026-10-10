"""Local ledger emulator used for fixtures until the ledger core is available.

It applies the same structural validation (PRD 6.4), posting rules (PRD 7.2)
and hash chain (PRD 8.3) as the ledger core, and writes ``events.jsonl`` and
``postings.jsonl`` in the shape of contracts/events/read-model.md.
"""

from __future__ import annotations

import json
from pathlib import Path

from audit_engine import chain


class LedgerError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code


def _lines_invoice(p: dict) -> list[tuple[str, int, int]]:
    lines = [("1100", p["gross"], 0), ("4000", 0, p["taxable_value"])]
    recov = p.get("packing", 0) + p.get("freight", 0) + p.get("insurance", 0)
    lines += [("4200", 0, recov), ("2100", 0, p.get("cgst", 0)), ("2101", 0, p.get("sgst", 0)),
              ("2102", 0, p.get("igst", 0)), ("2200", 0, p.get("tcs", 0))]
    ro = p.get("round_off", 0)
    lines.append(("4900", 0, ro) if ro >= 0 else ("4900", -ro, 0))
    return lines


def _lines_credit_note(p: dict) -> list[tuple[str, int, int]]:
    lines = [("4100", p["taxable_value"], 0), ("2100", p.get("cgst", 0), 0), ("2101", p.get("sgst", 0), 0),
             ("2102", p.get("igst", 0), 0), ("1100", 0, p["gross"])]
    diff = p["gross"] - (p["taxable_value"] + p.get("cgst", 0) + p.get("sgst", 0) + p.get("igst", 0))
    if diff:
        lines.append(("4900", diff, 0) if diff > 0 else ("4900", 0, -diff))
    return lines


def _lines_purchase(p: dict) -> list[tuple[str, int, int]]:
    tax = p.get("cgst", 0) + p.get("sgst", 0) + p.get("igst", 0)
    lines = [("5000", p["taxable_value"], 0), ("1300", tax, 0), ("2000", 0, p["gross"])]
    diff = p["gross"] - p["taxable_value"] - tax
    if diff:
        lines.append(("4900", diff, 0) if diff > 0 else ("4900", 0, -diff))
    return lines


POSTING_RULES = {
    "InvoiceIssued": _lines_invoice,
    "ReceiptRecorded": lambda p: [("1000", p["amount"], 0), ("1100", 0, p["amount"])],
    "CreditNoteIssued": _lines_credit_note,
    "PurchaseInvoiceRecorded": _lines_purchase,
    "PaymentMade": lambda p: [("2000", p["amount"], 0), ("1000", 0, p["amount"])],
    "JournalPosted": lambda p: [(str(l["account"]), int(l["debit"]), int(l["credit"])) for l in p["lines"]],
}


class LocalLedger:
    def __init__(self):
        self.events: list[dict] = []
        self.postings: list[dict] = []
        self.versions: dict[str, int] = {}
        self.reversed: set[str] = set()
        self.idem: dict[str, dict] = {}
        self.posting_by_aggregate: dict[str, list[dict]] = {}
        self.head = chain.GENESIS

    def append(self, *, event_type: str, entity_id: str, aggregate_id: str, sale_id: str | None, payload: dict,
               business_date: str, recorded_at: str, identity: dict, idempotency_key: str,
               expected_version: int | None = None) -> dict:
        if identity.get("role") != "client_employee":
            raise LedgerError("NOT_PERMITTED", "only client_employee may append")
        if idempotency_key in self.idem:
            prior = self.idem[idempotency_key]
            if prior["payload"] == payload and prior["event_type"] == event_type:
                return prior
            raise LedgerError("IDEMPOTENCY_MISMATCH", idempotency_key)
        current = self.versions.get(aggregate_id, 0)
        if expected_version is not None and expected_version != current:
            raise LedgerError("VERSION_CONFLICT", f"{aggregate_id} at {current}, expected {expected_version}")
        lines: list[tuple[str, int, int]] = []
        if event_type == "DocumentReversed":
            target = payload["target_aggregate_id"]
            if target not in self.versions:
                raise LedgerError("UNKNOWN_REFERENCE", target)
            if target in self.reversed:
                raise LedgerError("INVALID_TRANSITION", f"{target} already reversed")
            lines = [(p["account"], p["credit"], p["debit"]) for p in self.posting_by_aggregate.get(target, [])]
        elif event_type in POSTING_RULES:
            lines = POSTING_RULES[event_type](payload)
        lines = [l for l in lines if l[1] or l[2]]
        if any(dr < 0 or cr < 0 for _, dr, cr in lines):
            raise LedgerError("UNBALANCED_POSTING", "negative amount")
        if sum(l[1] for l in lines) != sum(l[2] for l in lines):
            raise LedgerError("UNBALANCED_POSTING", f"{event_type} debits {sum(l[1] for l in lines)} "
                                                    f"credits {sum(l[2] for l in lines)}")
        seq = len(self.events) + 1
        version = current + 1
        ev = {"seq": seq, "event_type": event_type, "entity_id": entity_id, "aggregate_id": aggregate_id,
              "aggregate_version": version, "sale_id": sale_id, "payload": payload, "business_date": business_date,
              "recorded_at": recorded_at, "identity": identity, "idempotency_key": idempotency_key,
              "prev_hash": self.head}
        ev["hash"] = chain.event_hash(ev)
        self.head = ev["hash"]
        self.events.append(ev)
        self.versions[aggregate_id] = version
        if event_type == "DocumentReversed":
            self.reversed.add(payload["target_aggregate_id"])
        rows = []
        for i, (acct, dr, cr) in enumerate(lines, 1):
            rows.append({"seq": seq, "line_no": i, "entity_id": entity_id, "account": acct, "debit": dr, "credit": cr,
                         "sale_id": sale_id, "source_event_type": event_type, "business_date": business_date})
        self.postings.extend(rows)
        if rows:
            self.posting_by_aggregate.setdefault(aggregate_id, []).extend(rows)
        self.idem[idempotency_key] = ev
        return ev

    def write(self, directory: str | Path) -> None:
        d = Path(directory)
        d.mkdir(parents=True, exist_ok=True)
        with (d / "events.jsonl").open("w", encoding="utf-8", newline="\n") as fh:
            for ev in self.events:
                fh.write(json.dumps(ev, ensure_ascii=False, separators=(",", ":")) + "\n")
        with (d / "postings.jsonl").open("w", encoding="utf-8", newline="\n") as fh:
            for p in self.postings:
                fh.write(json.dumps(p, separators=(",", ":")) + "\n")

    @classmethod
    def load(cls, directory: str | Path) -> "LocalLedger":
        """Rebuild state from files so that later client events can be appended (change scenario)."""
        led = cls()
        d = Path(directory)
        with (d / "events.jsonl").open(encoding="utf-8") as fh:
            for line in fh:
                ev = json.loads(line)
                led.events.append(ev)
                led.versions[ev["aggregate_id"]] = ev["aggregate_version"]
                led.idem[ev["idempotency_key"]] = ev
                if ev["event_type"] == "DocumentReversed":
                    led.reversed.add(ev["payload"]["target_aggregate_id"])
                led.head = ev["hash"]
        by_seq = {ev["seq"]: ev for ev in led.events}
        with (d / "postings.jsonl").open(encoding="utf-8") as fh:
            for line in fh:
                p = json.loads(line)
                led.postings.append(p)
                led.posting_by_aggregate.setdefault(by_seq[p["seq"]]["aggregate_id"], []).append(p)
        return led
