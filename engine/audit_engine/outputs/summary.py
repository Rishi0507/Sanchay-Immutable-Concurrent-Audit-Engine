"""One-page summary of an engagement for the engagement partner (PRD 19.4).

The figures come from the findings table, the samples and the frozen
snapshot. Nothing here is computed by a model, and the page states the hashes
it rests on, like the workpaper and the memo.
"""

from __future__ import annotations

from collections import Counter
from pathlib import Path

from ..detectors.common import period_invoices
from ..evidence.service import control_summary, regional_documents, request_status
from ..findings_service import all_findings
from ..money import rupees
from ..repo import samples
from ..sampling import SHEETS, overall
from .memo import NAMES, revenue_adjustment

# How much of the life of a sale is on record behind an invoice, strongest first.
PROOF = ["Ordered, shipped, delivered, paid", "Delivered, not yet paid",
         "Some movement on record", "Order only, no movement", "Invoice with nothing behind it"]
# The Sanchay emblem, printed beside the title.
LOGO = Path(__file__).with_name("logo-mark.png")


def proof_level(snap, inv: dict) -> int:
    """Index into PROOF for one invoice."""
    ordered = bool(inv.get("order_id") and snap.orders.get(inv["order_id"]))
    dispatch = snap.dispatch_for_invoice(inv)
    delivered = bool(dispatch and snap.delivery_for_dispatch(dispatch.get("dispatch_id")))
    paid = bool(snap.receipts_by_invoice.get(str(inv.get("invoice_no"))) or
                snap.receipts_by_invoice.get(str(inv.get("_aggregate_id"))))
    if ordered and dispatch and delivered:
        return 0 if paid else 1
    if dispatch or delivered:
        return 2
    return 3 if ordered else 4


def collect(ctx) -> dict:
    """The figures of the summary. Money is in paise, as everywhere inside the engine."""
    repo, eng = ctx.engine.repo, ctx.eng
    findings = all_findings(ctx)
    severity = Counter(f["severity"] for f in findings)
    status = Counter(f["status"] for f in findings)
    areas = Counter(f["detector_id"] for f in findings)
    high = Counter(f["detector_id"] for f in findings if f["severity"] == "High")
    by_area = [{"detector_id": det, "area": NAMES.get(det, det), "findings": n, "high": high[det]}
               for det, n in sorted(areas.items(), key=lambda kv: (-kv[1], kv[0]))]
    largest = sorted((f for f in findings if f["amount_impact"]), key=lambda f: (-abs(f["amount_impact"]), f["finding_id"]))[:5]

    rows = repo.select(samples, engagement_id=ctx.eid)
    tests = repo.latest_tests(ctx.eid)
    results = Counter(overall(tests[s["sample_id"]]["tests"]) for s in rows if s["sample_id"] in tests)
    requests = Counter(r["status"] for r in request_status(ctx))

    invoices = period_invoices(ctx)
    levels = [{"proof": label, "invoices": 0, "taxable_value": 0} for label in PROOF]
    for inv in invoices:
        level = levels[proof_level(ctx.snap, inv)]
        level["invoices"] += 1
        level["taxable_value"] += inv.get("taxable_value") or 0
    booked = sum(level["taxable_value"] for level in levels)

    done = repo.steps_done(ctx.eid)
    seal = ctx.engine.sampling_seal(ctx.eid)
    return {
        "client": eng["client_name"], "period_start": str(ctx.start), "period_end": str(ctx.end),
        "engagement_id": ctx.eid, "snapshot_seq": eng["snapshot_seq"], "snapshot_hash": eng["snapshot_hash"],
        "signed_off": repo.is_closed(ctx.eid),
        "findings": {
            "count": len(findings), "by_severity": {k: severity.get(k, 0) for k in ("High", "Medium", "Low")},
            "by_area": by_area, "awaiting_confirmation": status.get("proposed", 0),
            "confirmed": status.get("confirmed", 0), "rejected": status.get("rejected", 0),
            "total_adjustment": revenue_adjustment(findings),
            "largest": [{"finding_id": f["finding_id"], "title": f["title"], "severity": f["severity"],
                         "area": NAMES.get(f["detector_id"], f["detector_id"]), "amount_impact": f["amount_impact"]}
                        for f in largest],
        },
        "samples": {"by_sheet": {SHEETS[k]: sum(1 for s in rows if s["sheet"] == k) for k in SHEETS},
                    "selected": len(rows), "by_result": dict(results)},
        "evidence": {"requested": sum(requests.values()),
                     "received": requests.get("uploaded", 0) + requests.get("verified", 0) + requests.get("replaced after verification", 0),
                     "not_available": requests.get("declined", 0), "awaited": requests.get("requested", 0),
                     "regional_language": sum(len(v) for v in regional_documents(ctx).values()),
                     "control_requests": control_summary(ctx)},
        "revenue": {"invoices": len(invoices), "taxable_value": booked, "proof": levels,
                    "fully_evidenced_share": round(levels[0]["taxable_value"] / booked, 4) if booked else None},
        "safeguards": {
            "seed": seal.get("status"),
            "ledger_verified": "verify_ledger_integrity" in done and not areas.get("D-16"),
            "ledger_checked": "verify_ledger_integrity" in done,
            "changes_after_testing": areas.get("D-15", 0),
        },
    }


# Rendering

INK, INK2, INK3, LINE = (0.106, 0.114, 0.133), (0.353, 0.361, 0.388), (0.549, 0.553, 0.573), (0.863, 0.851, 0.816)
BRAND, FAIL, WARM, PASS, WASH = (0.541, 0.392, 0.063), (0.761, 0.224, 0.114), (0.71, 0.4, 0.106), (0.059, 0.478, 0.373), (0.949, 0.941, 0.918)
LEFT, RIGHT = 48, 547
TONE = {"High": FAIL, "Medium": WARM, "Low": INK3}


def short_money(paise: int) -> str:
    """An amount as a partner says it: in crore or lakh where it is large."""
    r = abs(paise) / 100
    sign = "-" if paise < 0 else ""
    if r >= 1e7:
        return f"{sign}Rs {r / 1e7:.2f} crore"
    if r >= 1e5:
        return f"{sign}Rs {r / 1e5:.2f} lakh"
    return f"{sign}Rs {rupees(abs(paise))}"


def render(s: dict, head_hash: str) -> bytes:
    """The summary as a one-page A4 PDF. The same figures always give the same bytes."""
    import pymupdf

    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)

    def text(x, y, value, size=9, color=INK, bold=False, right=False):
        value = str(value)
        if not value:
            return
        font = "hebo" if bold else "helv"
        if right:
            x -= pymupdf.get_text_length(value, fontname=font, fontsize=size)
        page.insert_text((x, y), value, fontsize=size, fontname=font, color=color)

    def fit(value: str, width: float, size=9, bold=False) -> str:
        font = "hebo" if bold else "helv"
        if pymupdf.get_text_length(value, fontname=font, fontsize=size) <= width:
            return value
        while value and pymupdf.get_text_length(value + "...", fontname=font, fontsize=size) > width:
            value = value[:-1]
        return value.rstrip() + "..."

    def rule(y, color=LINE):
        page.draw_line((LEFT, y), (RIGHT, y), color=color, width=0.6)

    def heading(y, value):
        text(LEFT, y, value, 10.5, INK, bold=True)
        rule(y + 6)
        return y + 22

    def mark(x, y, ok: bool):
        if ok:
            page.draw_polyline([(x, y - 3), (x + 2.6, y), (x + 7.5, y - 6.5)], color=PASS, width=1.4)
        else:
            page.draw_circle((x + 3.5, y - 3), 2.2, color=WARM, width=1.2)

    f, sm, ev, rev, safe = s["findings"], s["samples"], s["evidence"], s["revenue"], s["safeguards"]

    # Title
    text(LEFT, 62, "Audit summary", 20, INK, bold=True)
    label_right = RIGHT
    if LOGO.exists():
        page.insert_image(pymupdf.Rect(RIGHT - 32, 34, RIGHT, 66), stream=LOGO.read_bytes())
        label_right = RIGHT - 40
    text(label_right, 62, "Statutory revenue audit", 9, INK2, right=True)
    text(LEFT, 80, fit(f"{s['client']}   |   {s['period_start']} to {s['period_end']}", RIGHT - LEFT, 10), 10, INK2)
    rule(92)

    # Headline figures
    exceptions = sm["by_result"].get("Exception", 0)
    share = rev["fully_evidenced_share"]
    tiles = [
        ("Findings", str(f["count"]), f"{f['by_severity']['High']} high, {f['by_severity']['Medium']} medium, {f['by_severity']['Low']} low"),
        ("Proposed adjustment", short_money(abs(f["total_adjustment"])),
         "reduces revenue" if f["total_adjustment"] < 0 else "increases revenue"),
        ("Samples tested", str(sm["selected"]), f"{exceptions} with an exception"),
        ("Revenue with a full chain", f"{share * 100:.1f}%" if share is not None else "n/a",
         f"of {short_money(rev['taxable_value'])} booked"),
    ]
    width = (RIGHT - LEFT - 30) / 4
    for i, (label, figure, sub) in enumerate(tiles):
        x = LEFT + i * (width + 10)
        page.draw_rect((x, 104, x + width, 166), color=LINE, fill=WASH, width=0.6)
        text(x + 9, 119, fit(label, width - 16, 7.5), 7.5, INK2)
        text(x + 9, 142, fit(figure, width - 16, 15, bold=True), 15, INK, bold=True)
        text(x + 9, 157, fit(sub, width - 16, 7), 7, INK2)

    # Findings by area, with one bar for the split by severity
    y = heading(192, "Findings by area")
    total = max(f["count"], 1)
    x = LEFT
    for sev in ("High", "Medium", "Low"):
        w = (RIGHT - LEFT) * f["by_severity"][sev] / total
        if w > 0:
            page.draw_rect((x, y - 12, x + w, y - 7), color=TONE[sev], fill=TONE[sev], width=0)
        x += w
    y += 6
    text(RIGHT - 60, y, "High", 8, INK2, right=True)
    text(RIGHT, y, "Findings", 8, INK2, right=True)
    y += 13
    shown = f["by_area"][:8]
    for a in shown:
        text(LEFT, y, fit(a["area"], 330), 9)
        text(LEFT + 340, y, a["detector_id"], 8, INK3)
        text(RIGHT - 60, y, a["high"] or "", 9, FAIL, right=True)
        text(RIGHT, y, a["findings"], 9, INK, bold=True, right=True)
        y += 14
    rest = f["by_area"][8:]
    if rest:
        text(LEFT, y, f"{len(rest)} other areas", 9, INK2)
        text(RIGHT - 60, y, sum(a["high"] for a in rest) or "", 9, FAIL, right=True)
        text(RIGHT, y, sum(a["findings"] for a in rest), 9, INK, bold=True, right=True)
        y += 14

    # Largest findings
    y = heading(y + 14, "Largest findings by amount")
    if not f["largest"]:
        text(LEFT, y, "No finding carries an amount.", 9, INK2)
        y += 14
    for item in f["largest"]:
        text(LEFT, y, item["severity"], 8, TONE[item["severity"]], bold=True)
        text(LEFT + 44, y, fit(item["title"], 345), 9)
        text(RIGHT, y, short_money(item["amount_impact"]), 9, INK, right=True)
        y += 14

    # Two columns: samples and evidence, revenue and its proof
    top = heading(y + 14, "Samples and evidence")
    mid = LEFT + 232
    text(mid + 16, top - 22, "Revenue and the record behind it", 10.5, INK, bold=True)
    page.draw_rect((mid, top - 16.4, mid + 16, top - 15.6), color=(1, 1, 1), fill=(1, 1, 1), width=0)
    y = top
    lines = [(name, n) for name, n in sm["by_sheet"].items()]
    lines += [("", None)] + [(k, sm["by_result"][k]) for k in ("Pass", "Exception", "Needs human review", "Pending evidence", "Changed after testing") if sm["by_result"].get(k)]
    lines += [("", None), ("Documents requested", ev["requested"]), ("Received", ev["received"]),
              ("Answered as not available", ev["not_available"]), ("Still awaited", ev["awaited"])]
    if ev.get("regional_language"):
        lines.append(("Read in Hindi or Marathi", ev["regional_language"]))
    for name, n in lines:
        if n is None:
            y += 5
            continue
        text(LEFT, y, name, 9, FAIL if name == "Exception" and n else INK)
        text(mid - 6, y, n, 9, INK, bold=True, right=True)
        y += 13.5
    left_end = y
    y = top
    for level in rev["proof"]:
        if not level["invoices"] and level is not rev["proof"][0]:
            continue
        text(mid + 16, y, fit(level["proof"], 150, 9), 9, INK if level is rev["proof"][0] else FAIL)
        text(RIGHT - 84, y, f"{level['invoices']:,}", 9, INK, right=True)
        text(RIGHT, y, short_money(level["taxable_value"]), 9, INK, bold=True, right=True)
        y += 13.5
    text(mid + 16, y + 4, f"{rev['invoices']:,} invoices in the period. A full chain does not make a sale", 7.5, INK3)
    text(mid + 16, y + 14, "genuine: the findings above say where it does not.", 7.5, INK3)
    y = max(left_end, y + 22)

    # Safeguards
    y = heading(y + 10, "Safeguards")
    ctl = ev["control_requests"]
    seed_ok = safe["seed"] in ("verified", "sealed at opening")
    rows = [
        (seed_ok, "The sampling seed was sealed and chosen by nobody." if safe["seed"] == "verified" else
         "The sampling seed was sealed when the engagement opened." if seed_ok else "The sampling seed was chosen by the auditor."),
        (ctl["sent"] > 0 and ctl["supplied"] == 0,
         f"Control requests for documents that should not exist: {ctl['sent']} sent, {ctl['declined']} answered correctly, "
         f"{ctl['supplied']} supplied by the client." if ctl["sent"] else "No control requests were sent."),
        (safe["ledger_verified"], "Both hash chains of the ledger verify. No record was altered." if safe["ledger_verified"] else
         "The ledger failed verification." if safe["ledger_checked"] else "The ledger has not been verified in this engagement yet."),
        (safe["changes_after_testing"] == 0, "The client changed nothing that touches a sample after testing began." if not safe["changes_after_testing"]
         else f"{safe['changes_after_testing']} client changes after testing began touch a sample."),
    ]
    for ok, line in rows:
        mark(LEFT, y, ok)
        text(LEFT + 16, y, fit(line, RIGHT - LEFT - 16), 9)
        y += 14

    # What remains for a person
    y += 8
    page.draw_rect((LEFT, y - 11, RIGHT, y + 9), color=LINE, fill=WASH, width=0.6)
    waiting = ("Signed off by the audit manager." if s["signed_off"] else
               f"{f['awaiting_confirmation']} of {f['count']} findings await the audit manager's decision. "
               f"{f['confirmed']} confirmed, {f['rejected']} rejected.")
    text(LEFT + 9, y + 2, fit(waiting, RIGHT - LEFT - 18, 9, bold=True), 9, BRAND, bold=True)

    # Footer: what the page rests on
    rule(790)
    text(LEFT, 803, f"Engagement {s['engagement_id']}   |   snapshot at event {s['snapshot_seq']}   |   snapshot hash {s['snapshot_hash'][:24]}", 7, INK3)
    text(LEFT, 813, f"Ledger head hash {head_hash}", 7, INK3)
    text(RIGHT, 813, "Figures come from the findings and the frozen snapshot.", 7, INK3, right=True)

    doc.set_metadata({"title": "Audit summary", "producer": "audit-engine", "creator": "audit-engine",
                      "creationDate": "D:20000101000000Z", "modDate": "D:20000101000000Z"})
    return doc.tobytes(deflate=True, garbage=3, no_new_id=True)
