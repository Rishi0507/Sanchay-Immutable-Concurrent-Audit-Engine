"""Self-test (SD-8, SD-9): a scripted auditor runs the full audit and the report measures it.

Measures:
* recall per detector category on the planted dataset (target 100 percent),
* findings on the clean baseline (target 0),
* determinism: same seed and snapshot give identical samples, findings and workpaper cells (22.1),
* tamper detection (D-16) and change detection after testing begins (D-15).

The auditor here calls the engine in-process, through the same functions the
engine API serves to the MCP server. Once the MCP server is running, the same
flow can be pointed at it with --mcp-url (tool names of PRD 9.4).
"""

from __future__ import annotations

import argparse
import json
import shutil
import time
from collections import defaultdict
from pathlib import Path

from audit_engine.changes import check_post_testing_changes
from audit_engine.evidence.service import verify_evidence
from audit_engine.findings_service import all_findings
from audit_engine.integrity import verify_ledger_integrity
from audit_engine.outputs import draft_findings_memo, export_workpaper
from audit_engine.repo import evidence_requests, evidence_results, samples

from .client import FixtureClient
from .generate import generate
from .harness import engine_for
from .plant_evidence import company_of, upload_all
from .scenarios import post_testing_changes, tamper_event

CATEGORIES = ["D-01", "D-02", "D-03", "D-04", "D-05", "D-06", "D-07", "D-08", "D-09", "D-10", "D-11", "D-12",
              "D-13", "D-14", "D-15", "D-16"]


def matches(finding: dict, item: dict) -> bool:
    if finding["category"] != item["category"]:
        return False
    if item["subject_type"] == "period":
        return finding["subject"]["type"] == "period"
    sid = item["subject_id"]
    return (finding["subject"]["id"].split("#")[0] == sid or sid in finding["lineage"]["document_ids"]
            or sid in json.dumps(finding["lineage"].get("facts", {})))


def run_audit(dataset: Path, work: Path, seed: str, plant: bool, scenario: bool, period=("2025-04-01", "2026-03-31")) -> dict:
    """Copy the dataset, run every audit step, and return findings, timings and dynamic answer-key items."""
    if work.exists():
        shutil.rmtree(work)
    shutil.copytree(dataset, work / "data")
    e = engine_for(work / "data", work / "audit.db", work / "outputs")
    timings = {}

    def timed(name, fn, *a, **kw):
        t = time.perf_counter()
        out = fn(*a, **kw)
        timings[name] = round(time.perf_counter() - t, 2)
        return out

    eng = timed("open_engagement", e.open_engagement, *period, seed=seed)
    for step in ("import_register", "reconcile_register", "tag_related_parties", "run_detectors", "select_sales_tod",
                 "select_cutoff_tod", "select_credit_note_tod"):
        timed(step, e.step, step)
    ctx = e.ctx()
    reqs = e.repo.select(evidence_requests, engagement_id=ctx.eid)
    ss = {s["sample_id"]: s for s in e.repo.select(samples, engagement_id=ctx.eid)}
    client = FixtureClient(work / "data")
    dynamic = upload_all(client, reqs, ss, ctx.snap, company_of(work / "data"), plant=plant)
    client.flush()
    timed("verify_evidence", verify_evidence, e.ctx())
    if scenario:
        verified = [{"request_id": r["request_id"], "sample_id": r["sample_id"],
                     "document_type": r["request_id"].rsplit("-", 1)[-1]}
                    for r in e.repo.select(evidence_results, engagement_id=ctx.eid) if r["request_id"].endswith("-invoice")]
        client = FixtureClient(work / "data")
        dynamic += post_testing_changes(client, ss, ctx.snap, company_of(work / "data"), verified)
        client.flush()
        timed("check_post_testing_changes", check_post_testing_changes, e.ctx())
        verify_evidence(e.ctx())
    integ = timed("verify_ledger_integrity", verify_ledger_integrity, e.ctx())
    wp = timed("export_workpaper", export_workpaper, e.ctx())
    memo = timed("draft_findings_memo", draft_findings_memo, e.ctx())
    findings = all_findings(e.ctx())
    sample_list = [(s["sheet"], s["position"], s["subject_id"], s["reason"])
                   for s in sorted(ss.values(), key=lambda s: s["sample_id"])]
    return {"engagement": eng, "findings": findings, "timings": timings, "dynamic_key": dynamic,
            "workpaper": wp, "memo": memo, "integrity": integ, "samples": sample_list}


def workpaper_cells(path: str) -> dict:
    from openpyxl import load_workbook

    wb = load_workbook(path, read_only=True)
    return {ws.title: [list(r) for r in ws.iter_rows(values_only=True)] for ws in wb.worksheets}


def recall_report(findings: list[dict], key: list[dict]) -> dict:
    per = defaultdict(lambda: {"planted": 0, "found": 0, "missed": []})
    for item in key:
        row = per[item["detector"]]
        row["planted"] += 1
        if any(matches(f, item) for f in findings):
            row["found"] += 1
        else:
            row["missed"].append({"subtype": item["subtype"], "subject": item["subject_id"], "note": item["note"]})
    return {d: dict(per[d], recall=(per[d]["found"] / per[d]["planted"]) if per[d]["planted"] else None)
            for d in CATEGORIES}


def selftest(out: Path, seed: int = 7, scale: float = 1.0, audit_seed: str = "elev05", regenerate: bool = True) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    clean, planted = out / "dataset_clean", out / "dataset_planted"
    if regenerate or not (clean / "fixture").exists():
        generate(clean, "clean", seed=seed, scale=scale)
    if regenerate or not (planted / "fixture").exists():
        generate(planted, "planted", seed=seed, scale=scale)
    report: dict = {"seed": seed, "scale": scale, "audit_seed": audit_seed}

    clean_run = run_audit(clean, out / "run_clean", audit_seed, plant=False, scenario=False)
    fp = defaultdict(list)
    for f in clean_run["findings"]:
        fp[f["detector_id"]].append({"id": f["finding_id"], "subtype": f["subtype"], "title": f["title"]})
    report["false_positives"] = {"total": len(clean_run["findings"]), "by_detector": dict(fp)}
    report["timings_clean"] = clean_run["timings"]

    run_a = run_audit(planted, out / "run_planted_a", audit_seed, plant=True, scenario=True)
    static_key = json.loads((planted / "answer_key.json").read_text(encoding="utf-8"))["items"]
    tamper_dir = out / "run_tamper"
    if tamper_dir.exists():
        shutil.rmtree(tamper_dir)
    shutil.copytree(clean, tamper_dir / "data")
    te = engine_for(tamper_dir / "data", tamper_dir / "audit.db", tamper_dir / "outputs")
    te.open_engagement("2025-04-01", "2026-03-31", seed=audit_seed)
    tamper_key = [tamper_event(tamper_dir / "data" / "fixture", 1234)]
    verify_ledger_integrity(te.ctx())
    tamper_findings = all_findings(te.ctx())
    key = static_key + run_a["dynamic_key"]
    rec = recall_report(run_a["findings"] + tamper_findings, key + tamper_key)
    report["recall"] = rec
    report["timings_planted"] = run_a["timings"]
    report["planted_findings_total"] = len(run_a["findings"])

    run_b = run_audit(planted, out / "run_planted_b", audit_seed, plant=True, scenario=True)
    same_samples = run_a["samples"] == run_b["samples"]
    ids_a = sorted(f["finding_id"] for f in run_a["findings"])
    ids_b = sorted(f["finding_id"] for f in run_b["findings"])
    cells_a, cells_b = workpaper_cells(run_a["workpaper"]["path"]), workpaper_cells(run_b["workpaper"]["path"])
    diff_sheets = [s for s in cells_a if cells_a[s] != cells_b.get(s)]
    report["determinism"] = {"samples_identical": same_samples, "findings_identical": ids_a == ids_b,
                             "workpaper_cells_identical": not diff_sheets, "differing_sheets": diff_sheets,
                             "workpaper_hash_a": run_a["workpaper"]["file_hash"],
                             "workpaper_hash_b": run_b["workpaper"]["file_hash"]}
    planted_total = sum(r["planted"] for r in rec.values())
    found_total = sum(r["found"] for r in rec.values())
    report["summary"] = {
        "recall_overall": round(found_total / planted_total, 4) if planted_total else None,
        "categories_at_100": sum(1 for r in rec.values() if r["recall"] == 1.0),
        "categories_tested": sum(1 for r in rec.values() if r["planted"]),
        "false_positives_on_clean": len(clean_run["findings"]),
        "deterministic": same_samples and ids_a == ids_b and not diff_sheets,
        "pass": (found_total == planted_total and not clean_run["findings"] and same_samples and ids_a == ids_b
                 and not diff_sheets),
    }
    report["outputs"] = {"workpaper": run_a["workpaper"]["path"], "memo": [f["path"] for f in run_a["memo"]["files"]]}
    (out / "selftest_report.json").write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
    (out / "selftest_report.md").write_text(markdown(report), encoding="utf-8")
    return report


def markdown(r: dict) -> str:
    s = r["summary"]
    lines = ["# Self-test report", "",
             f"Generator seed {r['seed']}, scale {r['scale']}, audit seed `{r['audit_seed']}`.", "",
             "| Measure | Result | Target |", "|---|---|---|",
             f"| Overall recall | {s['recall_overall']:.0%} | 100% |",
             f"| Categories at 100% recall | {s['categories_at_100']} of {s['categories_tested']} | all |",
             f"| Findings on the clean baseline | {s['false_positives_on_clean']} | 0 |",
             f"| Same seed and snapshot give identical samples, findings and workpaper cells | "
             f"{'Yes' if s['deterministic'] else 'No'} | Yes |",
             f"| Overall | {'PASS' if s['pass'] else 'FAIL'} | PASS |", "",
             "## Recall per detector", "", "| Detector | Planted | Found | Recall | Missed |", "|---|---|---|---|---|"]
    for d, row in r["recall"].items():
        if not row["planted"]:
            continue
        missed = "; ".join(f"{m['subtype']} {m['subject']}" for m in row["missed"]) or ""
        lines.append(f"| {d} | {row['planted']} | {row['found']} | {row['recall']:.0%} | {missed} |")
    lines += ["", "## False positives on the clean baseline", ""]
    if r["false_positives"]["total"]:
        for d, items in r["false_positives"]["by_detector"].items():
            for it in items[:20]:
                lines.append(f"- {d} {it['subtype']}: {it['title']}")
    else:
        lines.append("None.")
    lines += ["", "## Timings (seconds)", "", "| Step | Clean | Planted |", "|---|---|---|"]
    for k in r["timings_planted"]:
        lines.append(f"| {k} | {r['timings_clean'].get(k, '')} | {r['timings_planted'][k]} |")
    lines += ["", "## Determinism", "", "```", json.dumps(r["determinism"], indent=2), "```", ""]
    return "\n".join(lines)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m elev_datagen.selftest")
    ap.add_argument("--out", default="var/selftest")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--scale", type=float, default=1.0)
    ap.add_argument("--audit-seed", default="elev05")
    ap.add_argument("--reuse", action="store_true", help="Reuse datasets already generated in --out")
    a = ap.parse_args(argv)
    rep = selftest(Path(a.out), a.seed, a.scale, a.audit_seed, regenerate=not a.reuse)
    print(markdown(rep))
    return 0 if rep["summary"]["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
