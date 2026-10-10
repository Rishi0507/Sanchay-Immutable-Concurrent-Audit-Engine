"""The records of one engagement as short passages the assistant can search and quote.

Every figure a passage states is computed here, by the same code that fills
the screens and the summary report. The model is never asked to count, add or
rank, which is where a language model is least reliable.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass

from ..evidence.service import regional_documents
from ..findings_service import all_findings
from ..money import rupees
from ..outputs.memo import NAMES
from ..outputs.summary import collect
from ..repo import evidence_results, register_recon, rp_tags, samples
from ..sampling import SHEETS, overall
from .guide import AREA_TERMS, GUIDE

STATUS = {"proposed": "awaiting the audit manager's decision", "confirmed": "confirmed by the audit manager",
          "rejected": "rejected by the audit manager", "needs_info": "sent back for more information"}
STEP_NAMES = {"open_engagement": "open the engagement", "import_register": "import the register",
              "reconcile_register": "reconcile the register", "tag_related_parties": "tag related parties",
              "run_detectors": "run the detectors", "select_sales_tod": "select sales samples",
              "select_cutoff_tod": "select cut-off samples", "select_credit_note_tod": "select credit note samples",
              "verify_evidence": "test the evidence", "check_post_testing_changes": "check changes after testing",
              "verify_ledger_integrity": "verify the ledger", "draft_findings_memo": "draft the findings memo",
              "export_workpaper": "export the workpaper"}


@dataclass(frozen=True)
class Passage:
    key: str
    kind: str  # figures, area, finding, sample, party or guide
    title: str
    text: str
    tab: str = ""  # the screen that shows the record
    focus: str | None = None  # what that screen should open
    terms: str = ""  # other words a person may ask with; searched, never shown


def rs(paise) -> str:
    return "Rs " + rupees(int(paise or 0))


def clip(text: str, limit: int) -> str:
    text = " ".join(str(text or "").split())
    return text if len(text) <= limit else text[:limit].rsplit(" ", 1)[0] + " ..."


def number_of(s: dict) -> str:
    """The number a person knows a sample by: the credit note or the invoice."""
    d = s.get("data") or {}
    return str(d.get("credit_note_no") or d.get("bill_no") or s["subject_id"])


def failed_checks(ctx) -> dict[str, list[str]]:
    """Sample to the evidence checks its latest documents failed, in words."""
    latest: dict[str, dict] = {}
    for r in ctx.engine.repo.select(evidence_results, order_by=evidence_results.c.id, engagement_id=ctx.eid):
        latest[r["request_id"]] = r
    out: dict[str, list[str]] = defaultdict(list)
    for r in latest.values():
        for c in r["checks"] or []:
            if c.get("result") == "fail":
                out[r["sample_id"]].append(f"{c.get('check')} on the {str(c.get('document') or 'document').replace('_', ' ')}: "
                                           f"{clip(c.get('detail'), 220)}")
    return out


def finding_passages(findings: list[dict], numbers: dict[str, str]) -> list[Passage]:
    out = []
    for f in findings:
        parts = [f"{f['title']}.", f"Severity {f['severity']}.",
                 f"Area: {NAMES.get(f['detector_id'], f['detector_id'])} ({f['detector_id']})."]
        label = (f.get("subject") or {}).get("label")
        if label:
            parts.append(f"About {label}.")
        if f.get("amount_impact"):
            parts.append(f"Amount {rs(f['amount_impact'])}.")
        if f.get("period_effect") and f["period_effect"] != "None":
            parts.append(f"Effect on the period: {f['period_effect']}.")
        parts.append(f"Status: {STATUS.get(f['status'], f['status'])}.")
        parts.append(f"Why: {clip(f.get('reason'), 600)}")
        if f.get("standard_refs"):
            parts.append("Standards: " + ", ".join(f["standard_refs"]) + ".")
        tested = [numbers[s] for s in f.get("sample_ids") or [] if s in numbers]
        if tested:
            parts.append("Sampled as " + ", ".join(tested[:6]) + ".")
        out.append(Passage(f"finding:{f['finding_id']}", "finding", f["title"], " ".join(parts), "findings", f["finding_id"]))
    return out


def sample_passages(ctx, rows: list[dict], tests: dict, findings: list[dict]) -> list[Passage]:
    languages = regional_documents(ctx)
    failed = failed_checks(ctx)
    linked: dict[str, list[str]] = defaultdict(list)
    for f in findings:
        for sid in f.get("sample_ids") or []:
            linked[sid].append(f["title"])
    out = []
    for s in rows:
        d, sid = s["data"] or {}, s["sample_id"]
        parts = [f"Sample {number_of(s)} on the {SHEETS.get(s['sheet'], s['sheet'])} sheet."]
        who = [f"Customer {d['customer']}" if d.get("customer") else "", f"dated {d['date']}" if d.get("date") else "",
               f"taxable value {rs(d['taxable'])}" if d.get("taxable") else "", str(d.get("related") or "")]
        parts.append(", ".join(w for w in who if w) + ".")
        if s.get("reason"):
            parts.append(f"Chosen because: {clip(s['reason'], 260)}")
        t = (tests.get(sid) or {}).get("tests") or {}
        if t:
            other = [f"{name} {value}" for name, value in t.items() if value != "Pass"]
            parts.append(f"Result: {overall(t)}." + (" Tests not passed: " + ", ".join(other) + "." if other else ""))
        if languages.get(sid):
            parts.append("Documents read in " + ", ".join(sorted(set(languages[sid]))) + ".")
        if failed.get(sid):
            parts.append("Failed checks: " + "; ".join(failed[sid][:4]) + ".")
        if linked.get(sid):
            parts.append("Findings on this sample: " + "; ".join(clip(x, 140) for x in linked[sid][:4]) + ".")
        out.append(Passage(f"sample:{sid}", "sample", f"Sample {number_of(s)}", " ".join(parts), "samples", f"{s['sheet']}:{sid}"))
    return out


def figure_passages(ctx, findings: list[dict], rows: list[dict], tests: dict) -> list[Passage]:
    s = collect(ctx)
    f, sm, ev, rev, safe = s["findings"], s["samples"], s["evidence"], s["revenue"], s["safeguards"]
    sev = f["by_severity"]
    out = [Passage("figures:overview", "figures", "The audit at a glance", (
        f"Audit of {s['client']} for the period {s['period_start']} to {s['period_end']}. "
        f"{f['count']} findings in total: {sev['High']} High, {sev['Medium']} Medium and {sev['Low']} Low. "
        f"{f['awaiting_confirmation']} await the audit manager's decision, {f['confirmed']} are confirmed and "
        f"{f['rejected']} are rejected. Proposed adjustment to revenue: {rs(f['total_adjustment'])}. "
        f"{sm['selected']} samples were selected. The engagement is {'signed off' if s['signed_off'] else 'not yet signed off'}."),
        "overview", terms="how many findings total count number high medium low severity summary overall")]

    by_area: dict[str, list[dict]] = defaultdict(list)
    for x in findings:
        by_area[x["detector_id"]].append(x)
    lines = []
    for det, items in sorted(by_area.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        name = NAMES.get(det, det)
        high = sum(1 for x in items if x["severity"] == "High")
        total = sum(x["amount_impact"] or 0 for x in items)
        lines.append(f"{name}: {len(items)} findings, {high} High, amount {rs(total)}.")
        top = sorted(items, key=lambda x: (-abs(x["amount_impact"] or 0), x["finding_id"]))[:5]
        refs = sorted({r for x in items for r in x.get("standard_refs") or []})
        out.append(Passage(f"area:{det}", "area", f"{name}: the findings", (
            f"{name} ({det}): {len(items)} findings, of which {high} are High. Total amount {rs(total)}. "
            + ("Standards: " + ", ".join(refs) + ". " if refs else "")
            + "The largest: " + "; ".join(f"{clip(x['title'], 150)} ({rs(x['amount_impact'])})" for x in top) + "."),
            "findings", f"f:category={items[0]['category']}", terms=AREA_TERMS.get(det, "")))
    out.append(Passage("figures:areas", "figures", "Findings by area",
                       "Findings by area of the audit, most findings first. " + " ".join(lines), "findings",
                       terms="breakdown category which area most"))
    if f["largest"]:
        out.append(Passage("figures:largest", "figures", "The largest findings", (
            "The largest findings by amount: " + "; ".join(
                f"{clip(x['title'], 150)} ({x['severity']}, {x['area']}, {rs(x['amount_impact'])})" for x in f["largest"]) + "."),
            "findings", terms="biggest top largest highest amount"))

    result = {r["sample_id"]: overall((tests.get(r["sample_id"]) or {}).get("tests") or {}) for r in rows if r["sample_id"] in tests}
    not_passed = [f"{number_of(r)} ({result[r['sample_id']]})" for r in rows if result.get(r["sample_id"], "Pass") != "Pass"]
    out.append(Passage("figures:samples", "figures", "Samples and their results", (
        f"{sm['selected']} samples selected: " + ", ".join(f"{n} on {sheet}" for sheet, n in sm["by_sheet"].items()) + ". "
        + ("Results: " + ", ".join(f"{n} {label}" for label, n in sorted(sm["by_result"].items())) + ". " if sm["by_result"] else
           "No sample has been tested yet. ")
        + ("Samples that did not pass: " + ", ".join(not_passed[:30]) + "." if not_passed else "")), "samples",
        terms="how many samples tested checked results exception pass"))

    cr = ev["control_requests"]
    out.append(Passage("figures:evidence", "figures", "Documents requested from the client", (
        f"{ev['requested']} documents were requested from the client. {ev['received']} were received, "
        f"{ev['awaited']} are still awaited and {ev['not_available']} were answered as not available. "
        f"{ev['regional_language']} documents were read in Hindi or Marathi. "
        f"Control requests, which ask for a document that should not exist: {cr['sent']} sent, {cr['declined']} declined "
        f"by the client, {cr['supplied']} answered with a file and {cr['pending']} not yet answered."), "samples",
        terms="evidence documents pending awaited received status control trap requests"))
    languages = regional_documents(ctx)
    if languages:
        named = [f"{number_of(r)} ({', '.join(sorted(set(languages[r['sample_id']])))})" for r in rows if r["sample_id"] in languages]
        out.append(Passage("figures:languages", "figures", "Samples with Hindi or Marathi documents", (
            f"{ev['regional_language']} documents across {len(named)} samples were read in Hindi or Marathi. "
            "The samples: " + ", ".join(named[:40]) + "."), "samples", terms="regional language which samples documents"))

    if rev["invoices"]:
        share = rev["fully_evidenced_share"]
        out.append(Passage("figures:revenue", "figures", "Revenue of the period and the record behind it", (
            f"Revenue of the period: {rev['invoices']} invoices with a taxable value of {rs(rev['taxable_value'])}. "
            "By the record behind each invoice: " + "; ".join(
                f"{p['proof']}: {p['invoices']} invoices, {rs(p['taxable_value'])}" for p in rev["proof"]) + ". "
            + (f"Share of revenue with the whole life of the sale on record: {share * 100:.1f} percent." if share is not None else "")),
            "overview", terms="revenue how much total fully evidenced proof backed invoices"))

    out.append(Passage("figures:safeguards", "figures", "State of the safeguards", (
        f"Sampling seed: {safe['seed']}. "
        + ("The ledger was verified and no record has been altered. " if safe["ledger_verified"] else
           "The ledger check found a problem. " if safe["ledger_checked"] else "The ledger has not been verified yet. ")
        + f"Client changes after testing began: {safe['changes_after_testing']}."), "overview",
        terms="safeguards seed sealed ledger verified tamper integrity changes"))

    done = ctx.engine.repo.steps_done(ctx.eid)
    left = [name for step, name in STEP_NAMES.items() if step not in done]
    out.append(Passage("figures:progress", "figures", "Progress of the audit", (
        f"{len(STEP_NAMES) - len(left)} of {len(STEP_NAMES)} steps of the audit plan are complete. "
        + ("Still to do: " + ", ".join(left) + "." if left else "Every step is complete.")), "overview",
        terms="progress steps left remaining still next done complete plan status"))

    compared = ctx.engine.repo.select(register_recon, engagement_id=ctx.eid)
    recon = Counter(part.strip() for r in compared for part in str(r["status"]).split(";"))
    if recon:
        out.append(Passage("figures:register", "figures", "The client's register against the system", (
            f"{len(compared)} rows of the client's sales register were compared with the system of record. "
            + ", ".join(f"{label}: {n}" for label, n in recon.most_common()) + "."), "register", "status:attention",
            terms="register reconciliation matched differences rows how many"))
    return out


def party_passages(ctx, findings: list[dict]) -> list[Passage]:
    about: dict[str, list[str]] = defaultdict(list)
    for f in findings:
        about[(f.get("subject") or {}).get("id", "")].append(f["title"])
    disclosed, suggested, out = [], [], []
    for t in ctx.engine.repo.select(rp_tags, engagement_id=ctx.eid):
        det = t["detail"] or {}
        name = det.get("name") or t["customer_id"]
        if t["tag"] == "disclosed":
            disclosed.append(name)
            text = (f"{name} is a related party disclosed by the client"
                    + (f" from {det['disclosed_from']}" if det.get("disclosed_from") else "")
                    + (f": {det['relationship']}." if det.get("relationship") else "."))
        elif t["tag"] == "suggested":
            suggested.append(name)
            text = (f"{name} is not in the client's related-party list, but the system suggests it is related"
                    + (f" from {det['suggested_from']}" if det.get("suggested_from") else "")
                    + f". {clip(det.get('explanation'), 400)}")
        else:
            continue
        if about.get(t["customer_id"]):
            text += " Findings about it: " + "; ".join(clip(x, 140) for x in about[t["customer_id"]][:4]) + "."
        out.append(Passage(f"party:{t['customer_id']}", "party", name, text, "graph"))
    if disclosed or suggested:
        out.append(Passage("figures:related", "figures", "Related parties", (
            f"{len(disclosed)} related parties were disclosed by the client"
            + (": " + ", ".join(sorted(disclosed)) if disclosed else "") + ". "
            + f"{len(suggested)} more are suggested by the system and are not in the client's list"
            + (": " + ", ".join(sorted(suggested)) if suggested else "") + "."), "graph",
            terms="related parties how many list disclosed undisclosed suggested"))
    return out


def build(ctx) -> list[Passage]:
    """Every passage of the engagement, followed by the guide."""
    repo = ctx.engine.repo
    findings = all_findings(ctx)
    rows = repo.select(samples, order_by=[samples.c.sheet, samples.c.position], engagement_id=ctx.eid)
    tests = repo.latest_tests(ctx.eid)
    numbers = {s["sample_id"]: number_of(s) for s in rows}
    out = figure_passages(ctx, findings, rows, tests) + party_passages(ctx, findings)
    out += finding_passages(findings, numbers) + sample_passages(ctx, rows, tests, findings)
    return out + [Passage(f"guide:{key}", "guide", title, text, tab, terms=AREA_TERMS.get(key, ""))
                  for key, title, text, tab in GUIDE]
