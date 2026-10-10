"""Audit workpaper (.xlsx) in the layout of Fig. 1 to Fig. 3 (PRD 19.1).

Cell values depend only on the snapshot, the seed and recorded decisions, so
two exports of the same engagement have identical cells (22.1).
"""

from __future__ import annotations

import io
from collections import Counter, defaultdict

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

from .. import __version__
from ..findings_service import all_findings
from ..money import rupees
from ..register_recon import CANON_OF_EXPECTED, dec, norm_no
from ..repo import register_imports, register_recon, register_rows, sample_meta, samples
from ..sampling import TESTS, overall

ACCENT = "1F4E79"
HEAD_FILL = PatternFill("solid", fgColor="D9E1F2")
ADDED_FILL = PatternFill("solid", fgColor="FFF2CC")
EXC_FILL = PatternFill("solid", fgColor="F8CBAD")
REVIEW_FILL = PatternFill("solid", fgColor="FFE699")
BOLD = Font(bold=True)
TITLE = Font(bold=True, size=13, color=ACCENT)
THICK = Side(style="thick", color=ACCENT)
THIN = Side(style="thin", color="BFBFBF")

PENDING = "Pending auditor confirmation"


def _rs(paise) -> float | None:
    return None if paise is None else round(paise / 100, 2)


def _header_block(ws, ctx, area: str, objective: str, work: list[str]) -> int:
    ws["A1"] = ctx.eng["client_name"]
    ws["A1"].font = TITLE
    rows = [("Client", ctx.eng["client_name"]), ("Period", f"{ctx.start:%d-%m-%Y} to {ctx.end:%d-%m-%Y}"),
            ("Area", area), ("Objective", objective)]
    r = 2
    for k, v in rows:
        ws.cell(r, 1, k).font = BOLD
        ws.cell(r, 2, v)
        r += 1
    ws.cell(r, 1, "Work done").font = BOLD
    r += 1
    for i, w in enumerate(work, 1):
        ws.cell(r, 1, i)
        ws.cell(r, 2, w)
        r += 1
    return r + 1


def _table(ws, start_row: int, headers: list[str], rows: list[list], status_col: int | None = None,
           widths: dict[int, int] | None = None) -> None:
    for c, h in enumerate(headers, 1):
        cell = ws.cell(start_row, c, h)
        cell.font = BOLD
        cell.fill = HEAD_FILL
        cell.alignment = Alignment(wrap_text=True, vertical="top")
        cell.border = Border(bottom=THIN)
    for i, row in enumerate(rows, 1):
        for c, v in enumerate(row, 1):
            cell = ws.cell(start_row + i, c, v)
            cell.alignment = Alignment(vertical="top", wrap_text=isinstance(v, str) and len(v) > 40)
        if status_col is not None:
            st = str(row[status_col - 1] or "")
            fill = EXC_FILL if st.startswith("Exception") else REVIEW_FILL if st in ("Needs human review",
                                                                                   "Changed after testing") else None
            if fill:
                for c in range(1, len(headers) + 1):
                    ws.cell(start_row + i, c).fill = fill
    ws.freeze_panes = ws.cell(start_row + 1, 1)
    for c in range(1, len(headers) + 1):
        ws.column_dimensions[get_column_letter(c)].width = (widths or {}).get(c, 14)


def build(ctx) -> bytes:
    repo = ctx.engine.repo
    findings = all_findings(ctx)
    fstatus = {f["finding_id"]: f for f in findings}
    tests_latest = repo.latest_tests(ctx.eid)
    from ..changes import changed_samples

    changed = changed_samples(ctx)
    wb = Workbook()
    wb.properties.creator = "ELEV05 audit engine"
    _register_sheet(wb.active, ctx)
    _sales_sheet(wb.create_sheet("Sales TOD"), ctx, tests_latest, changed)
    _cutoff_sheet(wb.create_sheet("Sales Cut-off TOD"), ctx, changed)
    _cn_sheet(wb.create_sheet("Credit Note TOD"), ctx, tests_latest, changed)
    _findings_sheet(wb.create_sheet("Findings"), findings)
    _params_sheet(wb.create_sheet("Parameters"), ctx)
    buf = io.BytesIO()
    wb.save(buf)
    return _fix_zip(buf.getvalue())


def _fix_zip(data: bytes) -> bytes:
    import re
    import zipfile

    src = zipfile.ZipFile(io.BytesIO(data))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as dst:
        for info in src.infolist():
            content = src.read(info.filename)
            if info.filename == "docProps/core.xml":
                content = re.sub(rb"<dcterms:(created|modified)([^>]*)>[^<]*<", rb"<dcterms:\1\2>2000-01-01T00:00:00Z<",
                                 content)
            zi = zipfile.ZipInfo(info.filename, date_time=(2000, 1, 1, 0, 0, 0))
            zi.compress_type = zipfile.ZIP_DEFLATED
            dst.writestr(zi, content)
    return out.getvalue()


def _register_sheet(ws, ctx) -> None:
    ws.title = "Sales Register"
    repo = ctx.engine.repo
    imp = repo.first(register_imports, engagement_id=ctx.eid)
    rows = repo.select(register_rows, order_by=register_rows.c.row_no, engagement_id=ctx.eid)
    recon = {r["row_no"]: r for r in repo.select(register_recon, engagement_id=ctx.eid)}
    tags = ctx.rp_tags()
    by_gstin, by_name = {}, {}
    for cid, party in ctx.snap.customers.items():
        for v in party.versions:
            if v["state"].get("gstin"):
                by_gstin.setdefault(str(v["state"]["gstin"]).upper(), cid)
            by_name.setdefault(str(v["state"].get("name") or "").strip().lower(), cid)
    colmap = {int(k): v for k, v in (imp["column_map"] or {}).items()} if imp else {}
    inv_col = next((k for k, v in colmap.items() if v == "bill_no"), None)
    g_col = next((k for k, v in colmap.items() if v == "gstin"), None)
    c_col = next((k for k, v in colmap.items() if v == "customer"), None)
    width = max((len(r["raw"]) for r in rows), default=0)
    header_row = (imp["headers"] or {}).get("header_row", 1) if imp else 1
    added = ["Related / Non Related", "Suggested RP", "Recon Status", "Finding Refs"]
    for r in rows:
        rn = r["row_no"]
        for c, v in enumerate(r["raw"], 1):
            ws.cell(rn, c, dec(v))
        kind = r["parsed"]["_kind"]
        if rn == header_row:
            for i, h in enumerate(added):
                cell = ws.cell(rn, width + 2 + i, h)
                cell.font = BOLD
                cell.fill = ADDED_FILL
            for c in range(1, width + 1):
                ws.cell(rn, c).font = BOLD
            continue
        if kind != "data":
            if rn in recon:
                ws.cell(rn, width + 4, recon[rn]["status"]).fill = ADDED_FILL
            continue
        raw = r["raw"]
        cid = None
        inv_no = norm_no(dec(raw[inv_col])) if inv_col is not None and inv_col < len(raw) else ""
        invs = ctx.snap.invoices_by_no.get(inv_no) or []
        if invs:
            cid = invs[0].get("customer_id")
        if not cid and g_col is not None and g_col < len(raw) and raw[g_col]:
            cid = by_gstin.get(str(raw[g_col]).strip().upper())
        if not cid and c_col is not None and c_col < len(raw):
            cid = by_name.get(str(raw[c_col] or "").strip().lower())
        tag = (tags.get(cid) or {}) if cid else {}
        det = tag.get("detail") or {}
        related = "Related Party" if det.get("disclosed_from") else "Non Related Party"
        suggested = det.get("explanation") if tag.get("tag") == "suggested" else ""
        rec = recon.get(rn) or {}
        vals = [related, suggested or None, rec.get("status"), ", ".join(rec.get("finding_refs") or []) or None]
        for i, v in enumerate(vals):
            cell = ws.cell(rn, width + 2 + i, v)
            cell.fill = ADDED_FILL
        if rec.get("status") and rec["status"] != "Matched":
            ws.cell(rn, width + 4).fill = EXC_FILL
    for rn in range(1, ws.max_row + 1):
        ws.cell(rn, width + 2).border = Border(left=THICK)
    ws.column_dimensions[get_column_letter(width + 1)].width = 3
    for i, w in enumerate((20, 50, 22, 40)):
        ws.column_dimensions[get_column_letter(width + 2 + i)].width = w
    ws.freeze_panes = ws.cell(header_row + 1, 1)


def _sample_rows(ctx, sheet: str) -> list[dict]:
    return ctx.engine.repo.select(samples, order_by=samples.c.position, engagement_id=ctx.eid, sheet=sheet)


def _sales_sheet(ws, ctx, tests_latest, changed) -> None:
    meta = ctx.engine.repo.first(sample_meta, engagement_id=ctx.eid, sheet="sales")
    pop = (meta or {}).get("detail", {}).get("population", 0)
    r0 = _header_block(ws, ctx, "Revenue: Sales (test of details)",
                       "To verify occurrence, accuracy, cut-off and classification of sales invoices recorded in the period.",
                       [f"Selected {len(_sample_rows(ctx, 'sales'))} invoices from a population of {pop} using the "
                        f"risk-weighted method in the Parameters sheet (seed {ctx.eng['seed']}).",
                        "Agreed each invoice to the sales order, dispatch, e-way bill, LR and proof of delivery.",
                        "Agreed invoice value to the ledger posting (Trade Receivables 1100, Sales 4000) and to the "
                        "client's invoice copy.",
                        "Agreed the customer on the invoice, the evidence and the receipt payer.",
                        "Checked the period of recognition against transfer of control.",
                        "Checked tax type and amount against place of supply and GSTR-1.",
                        "Tested evidence uploaded by the client for alteration, reuse and consistency."])
    headers = ["Sr No.", "Unit", "Quarter", "Month", "Bill no.", "Date", "Job No.", "Customer", "BU",
               "Related / Non Related", "Total Taxable Value", "Selection Reason"] + TESTS + ["Result", "Finding Refs"]
    rows = []
    for i, s in enumerate(_sample_rows(ctx, "sales"), 1):
        data = s["data"]
        t = (tests_latest.get(s["sample_id"]) or {}).get("tests") or {}
        result = "Changed after testing" if s["sample_id"] in changed else overall(t)
        refs = sorted(set(data.get("finding_refs") or []) | {
            f["finding_id"] for f in _evidence_refs(ctx, s["sample_id"])})
        rows.append([i, data.get("unit"), data.get("quarter"), data.get("month"), data.get("bill_no"), data.get("date"),
                     data.get("job_no"), data.get("customer"), data.get("bu"), data.get("related"),
                     _rs(data.get("taxable")), s["reason"]] + [t.get(k, "") for k in TESTS] +
                    [result, ", ".join(refs)])
    _table(ws, r0, headers, rows, status_col=len(headers) - 1,
           widths={5: 18, 8: 30, 10: 18, 11: 16, 12: 60, len(headers): 40})


def _evidence_refs(ctx, sample_id: str) -> list[dict]:
    if "ev_refs" not in ctx.cache:
        idx = defaultdict(list)
        for f in ctx.engine.repo.findings(ctx.eid):
            for sid in f.get("sample_ids") or []:
                idx[sid].append(f)
        ctx.cache["ev_refs"] = idx
    return ctx.cache["ev_refs"].get(sample_id, [])


def _cutoff_sheet(ws, ctx, changed) -> None:
    rows_db = _sample_rows(ctx, "cutoff")
    r0 = _header_block(ws, ctx, "Revenue: Sales cut-off",
                       "To verify that sales around the period end are recorded in the period in which control passed.",
                       [f"Selected the last {sum(1 for s in rows_db if s['data']['side'] == 'before')} invoices dated on "
                        f"or before {ctx.end:%d-%m-%Y} and the first {sum(1 for s in rows_db if s['data']['side'] == 'after')} "
                        f"after it.",
                        "Obtained dispatch and delivery dates and the delivery terms of each order.",
                        "Determined the control date: dispatch for ex-works terms, delivery for delivered terms.",
                        "Compared the period of recognition (ledger posting date) with the period of control."])
    headers = ["Sr No.", "Unit", "Quarter", "Month", "Bill no.", "Date", "Job No.", "Customer", "Ledger Account",
               "State Code", "GST No.", "Total Cost", "Dispatch Date", "Delivery Date", "Delivery Terms", "Control Date",
               "Ledger Posting Date", "Period Recognised", "Correct Period", "Conclusion", "Finding Refs"]
    rows = []
    for i, s in enumerate(rows_db, 1):
        d_ = s["data"]
        concl = "Changed after testing" if s["sample_id"] in changed else d_.get("conclusion")
        rows.append([i, d_.get("unit"), d_.get("quarter"), d_.get("month"), d_.get("bill_no"), d_.get("date"),
                     d_.get("job_no"), d_.get("customer"), d_.get("ledger_account"), d_.get("state_code"), d_.get("gstin"),
                     _rs(d_.get("taxable")), d_.get("dispatch_date"), d_.get("delivery_date"), d_.get("terms"),
                     d_.get("control_date"), d_.get("posting_date"), d_.get("period_recognised"),
                     d_.get("correct_period"), concl, ", ".join(d_.get("finding_refs") or [])])
    _table(ws, r0, headers, rows, status_col=20, widths={5: 18, 8: 30, 11: 18, 20: 45, 21: 24})


def _cn_sheet(ws, ctx, tests_latest, changed) -> None:
    rows_db = _sample_rows(ctx, "credit_notes")
    r0 = _header_block(ws, ctx, "Revenue: Credit notes",
                       "To verify that credit notes, in particular those issued after the period end, are genuine, "
                       "approved and recorded in the correct period.",
                       ["Selected every credit note dated after the period end against an invoice of the period (up to "
                        "15), and filled to 20 with in-period credit notes weighted to related parties and the last month.",
                        "Agreed each credit note to the original invoice, the reason, the approver and the sales return "
                        "inward record.",
                        "Considered whether post-period credit notes are adjusting events (SA 560)."])
    headers = ["Sr No.", "Credit Note No.", "Date", "Customer", "Related / Non Related", "Original Bill no.",
               "Original Date", "Reason", "Approver", "Return Inward Date", "Taxable Value", "Days from Invoice",
               "Selection Reason", "Evidence", "Conclusion", "Finding Refs"]
    rows = []
    for i, s in enumerate(rows_db, 1):
        d_ = s["data"]
        t = (tests_latest.get(s["sample_id"]) or {}).get("tests") or {}
        concl = "Changed after testing" if s["sample_id"] in changed else d_.get("conclusion")
        if t.get("Evidence") == "Exception" and not str(concl).startswith("Exception"):
            concl = "Exception: evidence"
        rows.append([i, d_.get("credit_note_no"), d_.get("date"), d_.get("customer"), d_.get("related"),
                     d_.get("original_bill_no"), d_.get("original_date"), d_.get("reason_given"), d_.get("approver"),
                     d_.get("return_inward_date"), _rs(d_.get("taxable")), d_.get("days_from_invoice"), s["reason"],
                     t.get("Evidence"), concl, ", ".join(d_.get("finding_refs") or [])])
    _table(ws, r0, headers, rows, status_col=15, widths={2: 16, 4: 30, 8: 28, 13: 50, 15: 45, 16: 30})


def _findings_sheet(ws, findings: list[dict]) -> None:
    headers = ["ID", "Detector", "Category", "Subtype", "Severity", "Subject", "Amount Impact (Rs)", "Period Effect",
               "Status", "Decided By", "Title", "Reason", "Standards", "Samples"]
    rows = []
    for f in findings:
        subj = f"{f['subject']['type']}: {f['subject']['id']}" + (f" ({f['subject']['label']})" if f['subject'].get('label') else "")
        rows.append([f["finding_id"], f["detector_id"], f["category"], f["subtype"], f["severity"], subj,
                     _rs(f["amount_impact"]), f["period_effect"],
                     PENDING if f["status"] == "proposed" else f["status"], f.get("decided_by"), f["title"], f["reason"],
                     ", ".join(f["standard_refs"]), ", ".join(f.get("sample_ids") or [])])
    _table(ws, 1, headers, rows, widths={1: 20, 3: 24, 4: 26, 6: 40, 7: 16, 9: 26, 11: 60, 12: 90, 13: 30, 14: 30})
    for i, f in enumerate(findings, 2):
        if f["severity"] == "High":
            ws.cell(i, 5).fill = EXC_FILL


def _params_sheet(ws, ctx) -> None:
    ws["A1"] = "Parameters"
    ws["A1"].font = TITLE
    head_seq, head_hash = ctx.engine.business.head()
    rows = [("Client", ctx.eng["client_name"]), ("Period start", str(ctx.start)), ("Period end", str(ctx.end)),
            ("Entities", ", ".join(ctx.eng.get("entity_ids") or [])), ("Seed", ctx.eng["seed"]),
            ("Snapshot sequence", ctx.eng["snapshot_seq"]), ("Snapshot hash", ctx.eng["snapshot_hash"]),
            ("Merkle root at snapshot", ctx.eng.get("merkle_root")), ("Chain head at export (sequence)", head_seq),
            ("Chain head at export (hash)", head_hash), ("Engine version", __version__),
            ("Period revenue (Rs)", _rs(ctx.revenue))]
    r = 3
    for k, v in rows:
        ws.cell(r, 1, k).font = BOLD
        ws.cell(r, 2, v)
        r += 1
    r += 1
    ws.cell(r, 1, "Sampling").font = TITLE
    r += 1
    for m in ctx.engine.repo.select(sample_meta, engagement_id=ctx.eid):
        det = m["detail"]
        ws.cell(r, 1, det.get("sheet")).font = BOLD
        r += 1
        for k in ("rng_material", "population", "population_value"):
            if k in det:
                ws.cell(r, 1, k)
                ws.cell(r, 2, str(det[k]))
                r += 1
        for k, v in sorted((det.get("strata") or {}).items()):
            ws.cell(r, 1, f"stratum: {k}")
            ws.cell(r, 2, str(v))
            r += 1
        if det.get("note"):
            ws.cell(r, 1, "note")
            ws.cell(r, 2, det["note"])
            r += 1
    r += 1
    ws.cell(r, 1, "Thresholds (DT-6)").font = TITLE
    r += 1
    for section, values in sorted(ctx.th.items()):
        for k, v in sorted(values.items()):
            ws.cell(r, 1, f"{section}.{k}")
            ws.cell(r, 2, ", ".join(map(str, v)) if isinstance(v, list) else v)
            r += 1
    r += 1
    ws.cell(r, 1, "Indicators (13.3)").font = TITLE
    r += 1
    from ..repo import indicators

    counts = Counter(x for row in ctx.engine.repo.select(indicators, engagement_id=ctx.eid)
                     for x in row["detail"]["indicators"])
    for k, v in sorted(counts.items()):
        ws.cell(r, 1, k)
        ws.cell(r, 2, v)
        r += 1
    ws.column_dimensions["A"].width = 40
    ws.column_dimensions["B"].width = 90
