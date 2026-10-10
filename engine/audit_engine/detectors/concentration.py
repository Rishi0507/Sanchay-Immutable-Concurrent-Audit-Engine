"""D-07 Period-end concentration of sales and discounts (SA 520)."""

from __future__ import annotations

import datetime as dt
import math
from collections import defaultdict

from ..money import rupees
from .common import inv_date, period_invoices


def _blocks(ctx, last_days: int) -> tuple[dt.date, list[tuple[dt.date, dt.date]]]:
    """Last window and the non-overlapping baseline blocks of equal length before it."""
    win_start = ctx.end - dt.timedelta(days=last_days - 1)
    blocks = []
    b_end = win_start - dt.timedelta(days=1)
    while b_end - dt.timedelta(days=last_days - 1) >= ctx.start:
        blocks.append((b_end - dt.timedelta(days=last_days - 1), b_end))
        b_end -= dt.timedelta(days=last_days)
    return win_start, blocks


def _stats(values: list[float]) -> tuple[float, float]:
    n = len(values)
    mean = sum(values) / n
    var = sum((v - mean) ** 2 for v in values) / max(n - 1, 1)
    return mean, math.sqrt(var)


def _list_value(inv: dict) -> int:
    return sum((it.get("qty") or 0) * (it.get("rate") or 0) for it in inv.get("items") or []) or \
        (inv.get("taxable_value") or 0) + (inv.get("discount") or 0)


def detect(ctx) -> list[dict]:
    th = ctx.th["d07"]
    last = th["last_days"]
    win_start, blocks = _blocks(ctx, last)
    if len(blocks) < th["min_baseline_windows"]:
        return []
    invoices = period_invoices(ctx)
    post_cn = defaultdict(list)
    for cn in ctx.snap.credit_notes:
        cd = cn.get("date") or ""
        if cd > ctx.end.isoformat() and not cn["_reversed"]:
            invs = ctx.snap.invoices_by_no.get(str(cn.get("original_invoice_no")), [])
            if invs and ctx.in_period(invs[0].get("invoice_date")):
                post_cn[cn.get("customer_id")].append(cn)
    groups: dict[str | None, list[dict]] = defaultdict(list)
    for inv in invoices:
        groups[None].append(inv)
        groups[inv.get("customer_id")].append(inv)
    out = []
    for cust, invs in sorted(groups.items(), key=lambda kv: (kv[0] is not None, kv[0] or "")):
        if cust is not None and len(invs) < th["min_customer_invoices"]:
            continue
        win = [i for i in invs if inv_date(i) >= win_start]
        if cust is not None and len(win) < 2:
            continue
        # Sales value.
        sums = []
        for a, b in blocks:
            sums.append(sum(i.get("taxable_value") or 0 for i in invs if a <= inv_date(i) <= b))
        x = sum(i.get("taxable_value") or 0 for i in win)
        mean, std = _stats(sums)
        std = max(std, mean * 0.25, 100.0)
        z = (x - mean) / std
        label = "Overall" if cust is None else (ctx.snap.customer(cust).name if ctx.snap.customer(cust) else cust)
        rel = cust is not None and ctx.is_related(cust, ctx.end) is not None
        floor = "High" if cust is not None and post_cn.get(cust) else None
        cn_note = (f" {len(post_cn[cust])} credit note(s) dated after the period end reduce this customer's "
                   f"period sales by Rs {rupees(sum(c.get('taxable_value') or 0 for c in post_cn[cust]))}."
                   if cust is not None and post_cn.get(cust) else "")
        min_value = th["min_window_value"] if cust is not None else 0
        if z >= th["z_min"] and x >= 2 * mean and x >= min_value:
            out.append(ctx.finding(
                category="PERIOD_END_CONCENTRATION", subtype=("CUSTOMER" if cust else "OVERALL") + "_SALES_SPIKE",
                subject_type="customer" if cust else "period", subject_id=cust or f"last-{last}-days",
                subject_label=label, related_party=rel, amount_impact=int(x - mean), severity_floor=floor,
                title=f"{label}: sales in the last {last} days are {z:.1f} standard deviations above the baseline",
                event_seqs=[i["_seq"] for i in win], document_ids=[i["invoice_no"] for i in win] + ([cust] if cust else []),
                thresholds={"last_days": last, "z_min": th["z_min"], "min_window_value": min_value},
                facts={"window": f"{win_start}..{ctx.end}", "window_value": x, "baseline_mean": int(mean),
                       "baseline_std": int(std), "z": round(z, 2), "baseline_blocks": len(blocks),
                       "invoices_in_window": len(win)},
                reason=(f"{label} invoiced Rs {rupees(x)} in the last {last} days of the period ({win_start} to "
                        f"{ctx.end}, {len(win)} invoices) against an average of Rs {rupees(int(mean))} per "
                        f"{last}-day block over {len(blocks)} earlier blocks (z = {z:.1f}).{cn_note}")))
        # Discount rate, weighted by list value.
        def disc_rate(items):
            lv = sum(_list_value(i) for i in items)
            return (sum(i.get("discount") or 0 for i in items) * 10000 / lv) if lv else None

        rates = [r for r in (disc_rate([i for i in invs if a <= inv_date(i) <= b]) for a, b in blocks) if r is not None]
        xr = disc_rate(win)
        if xr is None or len(rates) < 3:
            continue
        mr, sr = _stats(rates)
        sr = max(sr, 50.0)
        zr = (xr - mr) / sr
        if zr >= th["z_min"] and xr - mr >= th["discount_min_uplift_bp"]:
            out.append(ctx.finding(
                category="PERIOD_END_CONCENTRATION", subtype=("CUSTOMER" if cust else "OVERALL") + "_DISCOUNT_SPIKE",
                subject_type="customer" if cust else "period", subject_id=cust or f"last-{last}-days-discount",
                subject_label=label, related_party=rel,
                amount_impact=int(sum(_list_value(i) for i in win) * (xr - mr) / 10000), severity_floor=floor,
                title=f"{label}: average discount in the last {last} days is {xr / 100:.1f} percent against "
                      f"{mr / 100:.1f} percent",
                event_seqs=[i["_seq"] for i in win], document_ids=[i["invoice_no"] for i in win] + ([cust] if cust else []),
                thresholds={"last_days": last, "z_min": th["z_min"], "discount_min_uplift_bp": th["discount_min_uplift_bp"]},
                facts={"window_discount_bp": round(xr), "baseline_discount_bp": round(mr), "z": round(zr, 2)},
                reason=(f"{label} received an average discount of {xr / 100:.1f} percent in the last {last} days "
                        f"against {mr / 100:.1f} percent in earlier blocks (z = {zr:.1f}).{cn_note}")))
    return out
