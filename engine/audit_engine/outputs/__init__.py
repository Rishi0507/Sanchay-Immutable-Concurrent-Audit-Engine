"""Workpaper, memo and export orchestration (PRD section 19)."""

from __future__ import annotations

import datetime as dt
from pathlib import Path

from ..changes import check_post_testing_changes
from ..integrity import verify_ledger_integrity
from ..repo import outputs


CONTENT_TYPES = {"xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                 "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                 "md": "text/markdown", "pdf": "application/pdf"}


def _store(ctx, kind: str, data: bytes, name: str) -> dict:
    h = ctx.engine.files.put(data, name, CONTENT_TYPES[kind])
    out_dir = Path(ctx.engine.settings.output_dir) / ctx.eid
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / name
    path.write_bytes(data)
    head = ctx.engine.business.head()[1]
    ctx.engine.repo.insert(outputs, {"engagement_id": ctx.eid, "kind": kind, "file_hash": h, "path": str(path),
                                     "head_hash": head,
                                     "at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")})
    return {"format": kind, "file_hash": h, "path": str(path), "file_name": name, "content_type": CONTENT_TYPES[kind],
            "size": len(data), "head_hash": head}


def export_workpaper(ctx) -> dict:
    from . import workpaper

    changes = check_post_testing_changes(ctx)  # CH-3
    ctx.cache.clear()
    data = workpaper.build(ctx)
    f = _store(ctx, "xlsx", data, f"workpaper_{ctx.eid}.xlsx")
    return dict(f, sheets=["Sales Register", "Sales TOD", "Sales Cut-off TOD", "Credit Note TOD", "Findings",
                           "Parameters"], changes_checked=changes["events_examined"],
                new_change_findings=changes["findings_raised"])


def export_summary(ctx) -> dict:
    """The one-page summary: the figures, and the same figures as a PDF."""
    from . import summary

    ctx.cache.clear()
    data = summary.collect(ctx)
    f = _store(ctx, "pdf", summary.render(data, ctx.engine.business.head()[1]), f"audit_summary_{ctx.eid}.pdf")
    return {"summary": data, "file": f}


def draft_findings_memo(ctx, fmt: str = "both", ledger_result: dict | None = None) -> dict:
    from . import memo

    changes = check_post_testing_changes(ctx)  # CH-3
    integ = verify_ledger_integrity(ctx, ledger_result)
    ctx.cache.clear()
    text, docx = memo.build(ctx, changes, integ)
    files = []
    if fmt in ("md", "both"):
        files.append(_store(ctx, "md", text.encode("utf-8"), f"findings_memo_{ctx.eid}.md"))
    if fmt in ("docx", "both"):
        files.append(_store(ctx, "docx", docx, f"findings_memo_{ctx.eid}.docx"))
    return {"files": files, "changes_checked": changes["events_examined"], "integrity_ok": integ["business"]["ok"]}
