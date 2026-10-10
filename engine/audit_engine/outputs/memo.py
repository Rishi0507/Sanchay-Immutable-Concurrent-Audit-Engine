"""Findings memo in Markdown and Word (PRD 19.2).

Every number comes from the findings table. The local model may rephrase a
description only; a rephrasing that changes any number is discarded and the
template text is used (PRD 21, AI-3).
"""

from __future__ import annotations

import io
import re
from collections import Counter, defaultdict

from ..findings_service import all_findings
from ..repo import finding_decisions
from ..money import rupees

ORDER = {"High": 0, "Medium": 1, "Low": 2}
NAMES = {"D-01": "Register differences", "D-02": "Undisclosed related parties", "D-03": "Related parties from mid-period",
         "D-04": "Circular trading", "D-05": "No physical movement", "D-06": "Cut-off", "D-07": "Period-end concentration",
         "D-08": "Statutory documents and tax filings", "D-09": "Revenue not from a sale", "D-10": "Suspect evidence",
         "D-11": "Credit notes", "D-12": "Promotions and discounts", "D-13": "Settlement", "D-14": "Document integrity",
         "D-15": "Changes after testing began", "D-16": "Ledger integrity"}


def _numbers(s: str) -> list[str]:
    return sorted(re.findall(r"\d[\d,]*(?:\.\d+)?", s))


def rephrase(ctx, text: str) -> str:
    url = ctx.engine.settings.ollama_url
    if not url:
        return text
    try:
        import httpx

        r = httpx.post(f"{url.rstrip('/')}/api/generate", timeout=30, json={
            "model": ctx.engine.settings.ollama_model, "stream": False, "options": {"temperature": 0},
            "prompt": "Rewrite this audit finding in formal, concise English for a findings memo. Keep every "
                      "number, date, name and document reference exactly as written. Return only the text.\n\n" + text})
        out = (r.json().get("response") or "").strip()
    except Exception:
        return text
    return out if out and _numbers(out) == _numbers(text) else text


def revenue_adjustment(findings: list[dict]) -> int:
    """Net change to revenue (accounts 4000 and 4100) proposed by the findings. Negative reduces revenue."""
    total = 0
    for f in findings:
        if f["status"] == "rejected":
            continue
        for line in f.get("proposed_adjustment") or []:
            if line["account"] in ("4000", "4100", "4200"):
                total += line["credit"] - line["debit"]
    return total


def build(ctx, changes: dict, integrity: dict) -> tuple[str, bytes]:
    findings = sorted(all_findings(ctx), key=lambda f: (ORDER[f["severity"]], f["detector_id"], f["finding_id"]))
    eng = ctx.eng
    head_seq, head_hash = ctx.engine.business.head()
    by_cat = Counter((f["detector_id"], f["severity"]) for f in findings)
    adj = revenue_adjustment(findings)
    decisions = defaultdict(list)
    for r in ctx.engine.repo.select(finding_decisions, order_by=finding_decisions.c.id, engagement_id=ctx.eid):
        decisions[r["finding_id"]].append(r)
    md: list[str] = []
    md.append(f"# Findings memo: {eng['client_name']}")
    md.append("")
    md.append("## 1. Engagement details")
    md.append("")
    md.append("| Item | Value |")
    md.append("|---|---|")
    for k, v in (("Client", eng["client_name"]), ("Period", f"{ctx.start} to {ctx.end}"),
                 ("Snapshot sequence", eng["snapshot_seq"]), ("Snapshot hash", f"`{eng['snapshot_hash']}`"),
                 ("Merkle root at snapshot", f"`{eng.get('merkle_root')}`"), ("Seed", f"`{eng['seed']}`"),
                 ("Engagement", eng["engagement_id"])):
        md.append(f"| {k} | {v} |")
    md.append("")
    md.append("## 2. Summary")
    md.append("")
    md.append(f"{len(findings)} findings. Proposed net adjustment to revenue: Rs {rupees(adj)}. Findings without a "
              f"decision are marked Pending auditor confirmation.")
    md.append("")
    md.append("| Detector | Area | High | Medium | Low | Total |")
    md.append("|---|---|---|---|---|---|")
    for det in sorted({f["detector_id"] for f in findings}):
        h, m, l = by_cat[(det, "High")], by_cat[(det, "Medium")], by_cat[(det, "Low")]
        md.append(f"| {det} | {NAMES.get(det, det)} | {h} | {m} | {l} | {h + m + l} |")
    sev = Counter(f["severity"] for f in findings)
    md.append(f"| All | | {sev['High']} | {sev['Medium']} | {sev['Low']} | {len(findings)} |")
    md.append("")
    md.append("## 3. Findings")
    md.append("")
    for n, f in enumerate(findings, 1):
        status = "Pending auditor confirmation" if f["status"] == "proposed" else f["status"].replace("_", " ")
        md.append(f"### 3.{n} {f['title']}")
        md.append("")
        md.append(f"`{f['finding_id']}` | {f['detector_id']} {f['category']} / {f['subtype']} | Severity "
                  f"{f['severity']} | Status: {status}" + (f" by {f['decided_by']}" if f.get("decided_by") else ""))
        md.append("")
        md.append(f"**Description.** {rephrase(ctx, f['reason'])}")
        md.append("")
        md.append(f"**Basis.** {', '.join(f['standard_refs'])}.")
        md.append("")
        md.append(f"**Amount impact.** Rs {rupees(f['amount_impact'])}. Period effect: {f['period_effect']}.")
        md.append("")
        if f.get("proposed_adjustment"):
            md.append("**Proposed adjusting entry.**")
            md.append("")
            md.append("| Account | Debit (Rs) | Credit (Rs) | Narration |")
            md.append("|---|---|---|---|")
            for line in f["proposed_adjustment"]:
                md.append(f"| {line['account']} | {rupees(line['debit'])} | {rupees(line['credit'])} | {line['narration']} |")
            md.append("")
        lin = f["lineage"]
        refs = []
        if lin["document_ids"]:
            refs.append("documents " + ", ".join(lin["document_ids"][:12]) + (" ..." if len(lin["document_ids"]) > 12 else ""))
        if lin["event_seqs"]:
            refs.append("events " + ", ".join(map(str, lin["event_seqs"][:12])) + (" ..." if len(lin["event_seqs"]) > 12 else ""))
        if lin["evidence_hashes"]:
            refs.append("evidence " + ", ".join(h[:16] for h in lin["evidence_hashes"]))
        if f.get("sample_ids"):
            refs.append("samples " + ", ".join(f["sample_ids"]))
        md.append(f"**Evidence and lineage.** Rule {lin['rule_id']}; " + "; ".join(refs) + ".")
        if decisions.get(f["finding_id"]):
            md.append("")
            md.append("**Decisions.** " + "; ".join(f"{d['decision']} by {d['identity']} ({d['note'] or 'no note'})"
                                                   for d in decisions[f["finding_id"]]) + ".")
        md.append("")
    md.append("## 4. Samples affected by changes after testing began")
    md.append("")
    from ..changes import changed_samples

    ch = changed_samples(ctx)
    if ch:
        md.append("| Sample | Change |")
        md.append("|---|---|")
        for sid, notes in sorted(ch.items()):
            md.append(f"| {sid} | {'; '.join(notes)} |")
    else:
        md.append("No sample was affected by a change after the snapshot.")
    md.append("")
    md.append("## 5. Integrity statement")
    md.append("")
    trail = integrity.get("trail") or {}
    md.append(f"This memo was produced from the business chain with head sequence {head_seq} and head hash "
              f"`{head_hash}`. The Merkle root over events up to the snapshot is `{integrity.get('merkle_root')}`. "
              f"Recomputation of the business chain: {'passed' if integrity['business']['ok'] else 'FAILED at ' + str(integrity['business']['first_bad_seq'])}. "
              f"Snapshot hash and Merkle root: {'unchanged' if integrity.get('snapshot_hash_ok') and integrity.get('merkle_ok') is not False else 'CHANGED'}. "
              f"Audit trail verification: {'passed' if trail.get('ok') else ('failed at ' + str(trail.get('first_bad_seq'))) if trail.get('ok') is False else 'performed by the ledger core'}.")
    md.append("")
    text = "\n".join(md)
    return text, _docx(text)


def _docx(markdown: str) -> bytes:
    from docx import Document
    from docx.shared import Pt

    doc = Document()
    style = doc.styles["Normal"]
    style.font.name = "Calibri"
    style.font.size = Pt(10)
    core = doc.core_properties
    import datetime as dt

    core.created = core.modified = dt.datetime(2000, 1, 1)
    table = None
    for line in markdown.splitlines():
        if line.startswith("|"):
            cells = [c.strip() for c in line.strip("|").split("|")]
            if all(set(c) <= set("-") for c in cells):
                continue
            if table is None:
                table = doc.add_table(rows=0, cols=len(cells))
                table.style = "Light Grid Accent 1"
            row = table.add_row().cells
            for i, c in enumerate(cells[:len(row)]):
                row[i].text = c.replace("`", "").replace("**", "")
            continue
        table = None
        if line.startswith("# "):
            doc.add_heading(line[2:], level=0)
        elif line.startswith("## "):
            doc.add_heading(line[3:], level=1)
        elif line.startswith("### "):
            doc.add_heading(line[4:], level=2)
        elif line.strip():
            p = doc.add_paragraph()
            for part in re.split(r"(\*\*[^*]+\*\*)", line):
                if part.startswith("**") and part.endswith("**"):
                    p.add_run(part[2:-2]).bold = True
                elif part:
                    p.add_run(part.replace("`", ""))
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()
