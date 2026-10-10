"""Indicators (PRD 13.3): weak signals for the risk score, never findings on their own."""

from __future__ import annotations

import math
from collections import Counter, defaultdict

from ..repo import indicators as indicators_table
from .common import period_invoices

BENFORD = {k: math.log10(1 + 1 / k) for k in range(1, 10)}


def first_digit(paise: int) -> int | None:
    s = str(abs(int(paise)) // 100).lstrip("0")
    return int(s[0]) if s else None


def compute_indicators(ctx) -> dict:
    th = ctx.th["indicators"]
    invs = period_invoices(ctx)
    flags: dict[str, list[str]] = defaultdict(list)
    by_cust = defaultdict(list)
    for inv in invs:
        no = inv["invoice_no"]
        tv = inv.get("taxable_value") or 0
        if tv and tv % th["round_multiple"] == 0:
            flags[no].append("ROUND_AMOUNT")
        if th["just_below_low"] <= (inv.get("gross") or 0) < th["just_below_high"]:
            flags[no].append("JUST_BELOW_EWAY_THRESHOLD")
        by_cust[inv.get("customer_id")].append(inv)
    benford = {}
    for cust, items in sorted(by_cust.items(), key=lambda kv: kv[0] or ""):
        if len(items) < th["benford_min_invoices"]:
            continue
        digits = Counter(first_digit(i.get("taxable_value") or 0) for i in items)
        n = sum(v for k, v in digits.items() if k)
        mad = sum(abs(digits.get(k, 0) / n - p) for k, p in BENFORD.items()) / 9
        benford[cust] = round(mad, 4)
        if mad > th["benford_mad"]:
            for i in items:
                flags[i["invoice_no"]].append("BENFORD_DEVIATION")
    rows = [{"engagement_id": ctx.eid, "subject_id": k, "detail": {"indicators": v}} for k, v in sorted(flags.items())]
    ctx.engine.repo.insert(indicators_table, rows)
    counts = Counter(x for v in flags.values() for x in v)
    return {"invoices_flagged": len(flags), "by_indicator": dict(counts), "benford_mad": benford,
            "thresholds": th}
