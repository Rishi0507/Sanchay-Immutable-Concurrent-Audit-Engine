"""D-04 Circular trading: cycles in the counterparty graph (PRD 13.4)."""

from __future__ import annotations

from ..money import rupees
from ..graph import build_graph


def detect(ctx) -> list[dict]:
    g = build_graph(ctx)
    th = ctx.th["d04"]
    out = []
    for c in g["cycles"]:
        path = " -> ".join(c["labels"] + [c["labels"][0]])
        steps = "; ".join(f"{t['doc']} {t['date']} Rs {rupees(t['value'])}" for t in c["edges"])
        sales = [t for t in c["edges"] if t["type"] == "goods" and t["from"] == c["nodes"][0]]
        impact = sales[0]["value"] if sales else c["min_value"]
        out.append(ctx.finding(
            category="CIRCULAR_TRADING", subtype=f"{c['type'].upper()}_CYCLE", subject_type="cycle",
            subject_id=f"{c['type']}:" + ">".join(c["nodes"]), subject_label=path,
            amount_impact=impact, period_effect="Overstated" if sales else "None",
            title=f"{c['type'].capitalize()} return to the company within "
                  f"{(_days(c['first_date'], c['last_date']))} days: {path}",
            event_seqs=[t["seq"] for t in c["edges"]], document_ids=[t["doc"] for t in c["edges"]],
            thresholds={"window_days": th["window_days"], "min_edge_ratio_bp": th["min_edge_ratio_bp"],
                        "max_cycle_length": th["max_cycle_length"]},
            facts={"path": c["labels"], "nodes": c["nodes"], "edges": c["edges"]},
            reason=(f"{c['type'].capitalize()} flows {path} between {c['first_date']} and {c['last_date']}: "
                    f"{steps}. The smallest leg is {c['min_value'] * 100 // max(c['max_value'], 1)} percent of the "
                    f"largest, so the value returns to where it started (SA 240, SA 550).")))
    return out


def _days(a: str, b: str) -> int:
    import datetime as dt

    return (dt.date.fromisoformat(b) - dt.date.fromisoformat(a)).days
