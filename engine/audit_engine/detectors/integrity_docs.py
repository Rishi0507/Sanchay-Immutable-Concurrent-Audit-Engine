"""D-14 Paperwork that looks complete but is not."""

from __future__ import annotations

import re
from collections import defaultdict

from ..snapshot import d, ts
from .common import inv_date, related

_SERIES = re.compile(r"^(.*?)(\d+)$")


def detect(ctx) -> list[dict]:
    snap, th = ctx.snap, ctx.th["d14"]
    out = []
    invoices = [i for i in snap.invoices if ctx.in_scope(i)]
    series = defaultdict(list)
    for inv in invoices:
        m = _SERIES.match(str(inv.get("invoice_no") or ""))
        if m:
            series[m.group(1)].append((int(m.group(2)), inv, len(m.group(2))))
    for prefix, items in sorted(series.items()):
        if not any(ctx.in_period(i[1].get("invoice_date")) for i in items):
            continue
        items.sort(key=lambda x: (x[0], x[1]["_seq"]))
        width = items[0][2]
        nums = [n for n, _, _ in items]
        present = set(nums)
        by_num = defaultdict(list)
        for n, inv, _ in items:
            by_num[n].append(inv)
        for n in range(min(nums), max(nums) + 1):
            if n not in present:
                before = by_num.get(max((x for x in present if x < n), default=n), [{}])[0]
                after = by_num.get(min((x for x in present if x > n), default=n), [{}])[0]
                missing = f"{prefix}{n:0{width}d}"
                out.append(ctx.finding(
                    category="DOCUMENT_INTEGRITY", subtype="NUMBER_GAP", subject_type="invoice", subject_id=missing,
                    title=f"Invoice number {missing} is missing from the series", event_seqs=[x["_seq"] for x in (before, after) if x],
                    document_ids=[missing] + [x.get("invoice_no") for x in (before, after) if x],
                    facts={"missing": missing, "previous": before.get("invoice_no"), "next": after.get("invoice_no")},
                    reason=(f"Series {prefix} jumps from {before.get('invoice_no')} ({before.get('invoice_date')}) to "
                            f"{after.get('invoice_no')} ({after.get('invoice_date')}). Number {missing} was never "
                            f"issued, or was issued and is not in the records.")))
        for n, invs in sorted(by_num.items()):
            if len(invs) > 1:
                no = invs[0]["invoice_no"]
                out.append(ctx.finding(
                    category="DOCUMENT_INTEGRITY", subtype="DUPLICATE_NUMBER", subject_type="invoice", subject_id=no,
                    subject_label=", ".join(sorted({i.get("customer_name") or "" for i in invs})),
                    related_party=any(related(ctx, i) for i in invs),
                    amount_impact=sum(i.get("taxable_value") or 0 for i in invs[1:]),
                    title=f"Invoice number {no} is used {len(invs)} times", event_seqs=[i["_seq"] for i in invs],
                    document_ids=[no], facts={"uses": [{"date": i.get("invoice_date"), "customer": i.get("customer_name"),
                                                        "seq": i["_seq"]} for i in invs]},
                    reason=f"Invoice number {no} appears on {len(invs)} invoices: " + "; ".join(
                        f"{i.get('invoice_date')} to {i.get('customer_name')} (event {i['_seq']})" for i in invs) + "."))
        running = None
        for n, inv, _ in items:
            idate = inv_date(inv)
            if running and idate and idate < running[0] and ctx.in_period(idate):
                out.append(ctx.finding(
                    category="DOCUMENT_INTEGRITY", subtype="OUT_OF_DATE_ORDER", subject_type="invoice",
                    subject_id=inv["invoice_no"], subject_label=inv.get("customer_name"), related_party=related(ctx, inv),
                    amount_impact=inv.get("taxable_value") or 0,
                    title=f"Invoice {inv['invoice_no']} is dated before an earlier-numbered invoice",
                    event_seqs=[inv["_seq"], running[1]["_seq"]], document_ids=[inv["invoice_no"], running[1]["invoice_no"]],
                    facts={"date": str(idate), "earlier_number": running[1]["invoice_no"], "earlier_date": str(running[0])},
                    reason=(f"Invoice {inv['invoice_no']} is dated {idate}, but the lower number "
                            f"{running[1]['invoice_no']} is dated {running[0]}. Numbers are issued in order, so one "
                            f"of the dates is not genuine.")))
            if idate and (running is None or idate > running[0]):
                running = (idate, inv)
    for inv in invoices:
        idate, rec = inv_date(inv), d(inv.get("_recorded_at"))
        if idate and rec and ctx.in_period(idate) and (rec - idate).days > th["backdate_days"]:
            out.append(ctx.finding(
                category="DOCUMENT_INTEGRITY", subtype="BACKDATED", subject_type="invoice", subject_id=inv["invoice_no"],
                subject_label=inv.get("customer_name"), related_party=related(ctx, inv),
                amount_impact=inv.get("taxable_value") or 0,
                title=f"Invoice {inv['invoice_no']} dated {idate} was recorded {(rec - idate).days} days later",
                event_seqs=[inv["_seq"]], document_ids=[inv["invoice_no"]],
                thresholds={"backdate_days": th["backdate_days"]},
                facts={"business_date": str(idate), "recorded_at": inv.get("_recorded_at")},
                reason=(f"Invoice {inv['invoice_no']} states {idate} but was appended to the ledger at "
                        f"{inv.get('_recorded_at')}, {(rec - idate).days} days later (limit {th['backdate_days']}).")))
    # One e-way bill or LR number on more than one invoice or dispatch.
    for kind, docs, key, link in (("EWAY_BILL_REUSED", snap.ewbs, "ewb_no", "invoice_no"),
                                  ("LR_REUSED", snap.lrs, "lr_no", "dispatch_id")):
        groups = defaultdict(list)
        for doc in docs:
            if ctx.in_scope(doc) and doc.get(key):
                groups[str(doc[key])].append(doc)
        for no, ds in sorted(groups.items()):
            targets = sorted({str(x.get(link)) for x in ds})
            if len(targets) < 2:
                continue
            invs = []
            for x in ds:
                if link == "invoice_no":
                    invs += snap.invoices_by_no.get(str(x.get("invoice_no")), [])
                else:
                    invs += [i for i in snap.invoices if i.get("dispatch_id") == x.get("dispatch_id")]
            if not any(ctx.in_period(i.get("invoice_date")) for i in invs):
                continue
            later = max(invs, key=lambda i: i["_seq"]) if invs else {}
            label = "e-way bill" if kind == "EWAY_BILL_REUSED" else "LR"
            out.append(ctx.finding(
                category="DOCUMENT_INTEGRITY", subtype=kind, subject_type="invoice",
                subject_id=later.get("invoice_no") or no, subject_label=f"{label} {no}",
                amount_impact=later.get("taxable_value") or 0,
                title=f"{label} {no} is used for {len(targets)} different documents",
                event_seqs=[x["_seq"] for x in ds], document_ids=[no] + [i["invoice_no"] for i in invs] + targets,
                facts={key: no, "used_for": targets},
                reason=f"{label.capitalize()} {no} appears on {', '.join(targets)}. One movement document cannot "
                       f"cover two consignments."))
    # Vehicles on overlapping trips, and deliveries faster than the distance allows.
    trips = defaultdict(list)
    for ds in snap.dispatches.values():
        if not ctx.in_scope(ds):
            continue
        dl = snap.delivery_for_dispatch(ds.get("dispatch_id"))
        start, end = ts(ds.get("dispatched_at")), ts((dl or {}).get("delivered_at"))
        if not start:
            continue
        inv = next(iter(snap.invoices_by_sale.get(ds["_sale_id"], [])), None)
        if end and ds.get("distance_km"):
            hours = (end - start).total_seconds() / 3600
            if hours <= 0 or ds["distance_km"] / max(hours, 1e-6) > th["max_speed_kmph"]:
                if inv and ctx.in_period(inv.get("invoice_date")):
                    speed = ds["distance_km"] / hours if hours > 0 else float("inf")
                    out.append(ctx.finding(
                        category="DOCUMENT_INTEGRITY", subtype="IMPOSSIBLE_DELIVERY", subject_type="invoice",
                        subject_id=inv["invoice_no"], subject_label=inv.get("customer_name"),
                        related_party=related(ctx, inv), amount_impact=inv.get("taxable_value") or 0,
                        title=f"Delivery for {inv['invoice_no']} implies {speed:.0f} km per hour",
                        event_seqs=[ds["_seq"], dl["_seq"], inv["_seq"]],
                        document_ids=[inv["invoice_no"], ds.get("dispatch_id"), dl.get("pod_ref")],
                        thresholds={"max_speed_kmph": th["max_speed_kmph"]},
                        facts={"distance_km": ds["distance_km"], "hours": round(hours, 2),
                               "dispatched_at": ds.get("dispatched_at"), "delivered_at": dl.get("delivered_at")},
                        reason=(f"Dispatch {ds.get('dispatch_id')} left at {ds.get('dispatched_at')} and was delivered "
                                f"{ds['distance_km']} km away at {dl.get('delivered_at')}, {hours:.1f} hours later. "
                                f"That needs an average of {speed:.0f} km per hour (limit {th['max_speed_kmph']}).")))
        vehicle = (ds.get("vehicle_no") or "").replace(" ", "").upper()
        if vehicle and end:
            trips[vehicle].append((start, end, ds, inv))
    for vehicle, ts_ in sorted(trips.items()):
        ts_.sort(key=lambda x: (x[0], x[2]["_seq"]))
        for i in range(1, len(ts_)):
            prev_end = max(t[1] for t in ts_[:i])
            prev = max(ts_[:i], key=lambda t: t[1])
            s, e, ds, inv = ts_[i]
            if s < prev_end and inv and ctx.in_period(inv.get("invoice_date")):
                out.append(ctx.finding(
                    category="DOCUMENT_INTEGRITY", subtype="VEHICLE_OVERLAP", subject_type="invoice",
                    subject_id=inv["invoice_no"], subject_label=f"vehicle {vehicle}",
                    related_party=related(ctx, inv), amount_impact=inv.get("taxable_value") or 0,
                    title=f"Vehicle {vehicle} is on two trips at once",
                    event_seqs=[ds["_seq"], prev[2]["_seq"]],
                    document_ids=[inv["invoice_no"], ds.get("dispatch_id"), prev[2].get("dispatch_id")]
                    + ([prev[3]["invoice_no"]] if prev[3] else []),
                    facts={"vehicle": vehicle, "trip": [str(s), str(e)], "overlaps": [str(prev[0]), str(prev[1])]},
                    reason=(f"Vehicle {vehicle} left with {ds.get('dispatch_id')} at {s} while still on "
                            f"{prev[2].get('dispatch_id')} ({prev[0]} to {prev[1]}).")))
    return out
