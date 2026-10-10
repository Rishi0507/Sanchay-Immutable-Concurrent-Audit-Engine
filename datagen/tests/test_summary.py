"""The one-page summary report (PRD 19.4)."""

import pymupdf

from audit_engine.detectors.common import period_invoices
from audit_engine.findings_service import all_findings
from audit_engine.outputs import export_summary, summary


def test_summary_agrees_with_the_engagement(planted_engine):
    for step in ("run_detectors", "select_sales_tod"):
        planted_engine.step(step)
    ctx = planted_engine.ctx()
    s = summary.collect(ctx)
    f = s["findings"]
    assert f["count"] == len(all_findings(ctx)) == sum(f["by_severity"].values()) == sum(a["findings"] for a in f["by_area"])
    assert f["count"] == f["awaiting_confirmation"] + f["confirmed"] + f["rejected"]
    amounts = [abs(x["amount_impact"]) for x in f["largest"]]
    assert len(amounts) == 5 and amounts == sorted(amounts, reverse=True)

    rev = s["revenue"]
    assert sum(level["invoices"] for level in rev["proof"]) == rev["invoices"] == len(period_invoices(ctx))
    assert sum(level["taxable_value"] for level in rev["proof"]) == rev["taxable_value"]
    # The planted set holds invoices with nothing behind them, so some revenue has no full chain.
    assert 0.9 < rev["fully_evidenced_share"] < 1
    assert rev["proof"][-1]["invoices"] >= 1

    assert s["samples"]["selected"] == sum(s["samples"]["by_sheet"].values()) >= 25
    assert s["evidence"]["requested"] == s["evidence"]["received"] + s["evidence"]["not_available"] + s["evidence"]["awaited"]
    # This engagement was opened with a seed given by hand, and the page must say so.
    assert s["safeguards"]["seed"] == "chosen"


def test_summary_is_one_page_and_reproducible(planted_engine):
    out = export_summary(planted_engine.ctx())
    data = planted_engine.files.get(out["file"]["file_hash"])
    assert data[:4] == b"%PDF" and out["file"]["content_type"] == "application/pdf"
    doc = pymupdf.open(stream=data, filetype="pdf")
    assert doc.page_count == 1
    text = doc[0].get_text()
    assert "Audit summary" in text and "chosen by the auditor" in text
    assert str(out["summary"]["findings"]["count"]) in text
    # No clock and no random identifier: the same state gives the same file.
    assert export_summary(planted_engine.ctx())["file"]["file_hash"] == out["file"]["file_hash"]
