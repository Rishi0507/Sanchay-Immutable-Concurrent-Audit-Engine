"""Finding records (PRD section 15): stable IDs, severity, lineage and template reasons."""

from __future__ import annotations

import datetime as dt
import hashlib
from typing import Any

from .money import rupees

DETECTOR_OF = {
    "REGISTER_MISMATCH": "D-01", "RP_UNDISCLOSED": "D-02", "RP_MID_PERIOD": "D-03", "CIRCULAR_TRADING": "D-04",
    "NO_MOVEMENT": "D-05", "CUTOFF": "D-06", "PERIOD_END_CONCENTRATION": "D-07", "DOC_TAX_MISMATCH": "D-08",
    "NON_SALE_REVENUE": "D-09", "EVIDENCE_SUSPECT": "D-10", "CREDIT_NOTE": "D-11", "PROMOTION_DISCOUNT": "D-12",
    "SETTLEMENT": "D-13", "DOCUMENT_INTEGRITY": "D-14", "POST_TESTING_CHANGE": "D-15", "LEDGER_INTEGRITY": "D-16",
}
CATEGORY_OF = {v: k for k, v in DETECTOR_OF.items()}

ALWAYS_HIGH = {"CIRCULAR_TRADING", "NON_SALE_REVENUE", "EVIDENCE_SUSPECT", "POST_TESTING_CHANGE", "LEDGER_INTEGRITY"}

STANDARD_REFS = {
    "REGISTER_MISMATCH": ["SA 230", "SA 500", "SA 330"],
    "RP_UNDISCLOSED": ["SA 550", "Ind AS 24", "AS 18", "Companies Act 2013 s.2(76)", "Companies Act 2013 s.188"],
    "RP_MID_PERIOD": ["SA 550", "Ind AS 24", "AS 18", "Companies Act 2013 s.2(76)"],
    "CIRCULAR_TRADING": ["SA 240", "SA 550", "SA 330"],
    "NO_MOVEMENT": ["SA 240", "SA 500", "CGST Rules r.138", "Ind AS 115"],
    "CUTOFF": ["Ind AS 115", "AS 9", "SA 330"],
    "PERIOD_END_CONCENTRATION": ["SA 520", "SA 240", "SA 560"],
    "DOC_TAX_MISMATCH": ["CGST Act s.31", "CGST Act s.37", "CGST Rules r.48", "CGST Rules r.138", "IGST Act s.10"],
    "NON_SALE_REVENUE": ["SA 240", "Ind AS 115", "SA 330"],
    "EVIDENCE_SUSPECT": ["SA 500", "SA 240"],
    "CREDIT_NOTE": ["SA 560", "CGST Act s.34", "Ind AS 115"],
    "PROMOTION_DISCOUNT": ["Ind AS 115", "SA 330"],
    "SETTLEMENT": ["SA 500", "SA 240", "SA 550"],
    "DOCUMENT_INTEGRITY": ["SA 240", "SA 500", "CGST Act s.31", "CGST Rules r.138"],
    "POST_TESTING_CHANGE": ["SA 230", "SA 560", "SA 330"],
    "LEDGER_INTEGRITY": ["SA 230", "SA 240"],
}

# One line per subtype. Fields come from the finding's facts. Missing fields render as "?".
REASONS = {
    "MISSING_IN_REGISTER": "Invoice {invoice_no} dated {invoice_date} for Rs {taxable} is in the system of record but not in the client's sales register.",
    "NOT_IN_SYSTEM": "Register row {row_no} lists bill {bill_no} for Rs {taxable}, but no invoice with that number exists in the system of record.",
    "FIELD_DIFFERENCE": "Register row {row_no} for invoice {invoice_no} differs from the system of record in: {fields_text}.",
    "DUPLICATE_ROW": "Bill {bill_no} appears {count} times in the register (rows {rows}) but {system_count} time(s) in the system of record.",
    "ROW_ARITHMETIC": "Register row {row_no} (bill {bill_no}) does not foot: components sum to Rs {computed} but Gross Amt. is Rs {gross}.",
    "TOTAL_NOT_AGREED_TO_LEDGER": "Register Total Cost of Rs {register_total} differs from net credits to Sales (4000) for the period of Rs {ledger_total} by Rs {difference}.",
    "REVERSED_IN_SYSTEM": "Invoice {invoice_no} was reversed on {reversed_on} (event {reversal_seq}) but is still listed in the register.",
    "MISSING_COLUMN": "The register has no column for {missing}. Values from that column cannot be compared.",
    "TOTAL_ROW_MISMATCH": "The register's total row {row_no} shows Rs {stated} for {column}, but the rows above sum to Rs {computed}.",
}


def finding_id(engagement_id: str, category: str, subtype: str, subject_type: str, subject_id: str) -> str:
    raw = f"{engagement_id}|{category}|{subtype}|{subject_type}|{subject_id}"
    return "F-" + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def severity(category: str, amount_impact: int, revenue: int, related_party: bool, cfg: dict) -> str:
    if category in ALWAYS_HIGH or related_party:
        return "High"
    revenue = max(revenue, 1)
    if abs(amount_impact) * 10000 >= revenue * cfg.get("high_bp", 100):
        return "High"
    if abs(amount_impact) * 10000 >= revenue * cfg.get("medium_bp", 10):
        return "Medium"
    return "Low"


class _Facts(dict):
    def __missing__(self, key):
        return "?"


def render_reason(subtype: str, facts: dict, fallback: str) -> str:
    tmpl = REASONS.get(subtype)
    if not tmpl:
        return fallback
    shown = _Facts()
    for k, v in facts.items():
        shown[k] = rupees(v) if isinstance(v, int) and not isinstance(v, bool) and k in _MONEY_KEYS else v
    try:
        return tmpl.format_map(shown)
    except (ValueError, KeyError):
        return fallback


_MONEY_KEYS = {"taxable", "computed", "gross", "register_total", "ledger_total", "difference", "stated", "amount",
               "value", "receipt_amount", "payment_amount", "sales_before", "sales_after", "credit", "invoice_value",
               "ewb_value", "gstr1_value", "ledger_value"}


def make_finding(*, engagement_id: str, category: str, subtype: str, subject_type: str, subject_id: str,
                 title: str, amount_impact: int = 0, period_effect: str = "None", revenue: int = 1,
                 severity_cfg: dict | None = None, related_party: bool = False,
                 event_seqs: list[int] | None = None, document_ids: list[str] | None = None,
                 evidence_hashes: list[str] | None = None, rule_id: str | None = None,
                 thresholds: dict | None = None, facts: dict | None = None, reason: str | None = None,
                 sample_ids: list[str] | None = None, proposed_adjustment: list[dict] | None = None,
                 subject_label: str | None = None, severity_floor: str | None = None) -> dict[str, Any]:
    facts = facts or {}
    sev = severity(category, amount_impact, revenue, related_party, severity_cfg or {})
    if severity_floor and _RANK[severity_floor] > _RANK[sev]:
        sev = severity_floor
    fid = finding_id(engagement_id, category, subtype, subject_type, subject_id)
    return {
        "finding_id": fid,
        "engagement_id": engagement_id,
        "detector_id": DETECTOR_OF[category],
        "category": category,
        "subtype": subtype,
        "severity": sev,
        "title": title,
        "subject": {"type": subject_type, "id": subject_id, "label": subject_label},
        "amount_impact": int(amount_impact),
        "period_effect": period_effect,
        "proposed_adjustment": proposed_adjustment or [],
        "standard_refs": STANDARD_REFS.get(category, []),
        "lineage": {
            "event_seqs": sorted(set(int(s) for s in (event_seqs or []) if s is not None)),
            "document_ids": sorted(set(str(d) for d in (document_ids or []) if d)),
            "evidence_hashes": sorted(set(evidence_hashes or [])),
            "rule_id": rule_id or f"{DETECTOR_OF[category]}/{subtype}",
            "thresholds": thresholds or {},
            "facts": _jsonable(facts),
        },
        "reason": reason or render_reason(subtype, facts, title),
        "sample_ids": sorted(set(sample_ids or [])),
        "status": "proposed",
        "decided_by": None,
        "created_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


_RANK = {"Low": 0, "Medium": 1, "High": 2}


def _jsonable(v):
    if isinstance(v, dict):
        return {str(k): _jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple, set)):
        return [_jsonable(x) for x in v]
    if isinstance(v, (dt.date, dt.datetime)):
        return v.isoformat()
    return v


def adjustment(lines: list[tuple[str, int, int]], narration: str) -> list[dict]:
    return [{"account": a, "debit": int(d), "credit": int(c), "narration": narration} for a, d, c in lines if d or c]
