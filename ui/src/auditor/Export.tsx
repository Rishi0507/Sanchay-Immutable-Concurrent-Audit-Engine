import { useState } from "react";
import { callTool, fileUrl, money, shortHash } from "../api";
import type { ViewProps } from "../App";
import { Button, Mark, Status, toast, useAction, useTool } from "../ui";
import { FindingLite, Kpi, PageBrief, Panel, ReviewProgress, spotlight, Term, ViewHead, day, dedupe, inr, plural, sum } from "./kit";

interface FileRef {
  file_hash: string;
  file_name: string;
  content_type?: string;
}

function Download({ file }: { file: FileRef }) {
  return (
    <a
      href={fileUrl(file.file_hash, file.file_name)}
      className="flex items-center justify-between gap-4 rounded-md border border-line px-3.5 py-2.5 text-sm transition-colors hover:border-brand/50 hover:bg-brand-wash focus-visible:border-brand focus-visible:outline-none"
    >
      <span className="flex min-w-0 items-center gap-2 font-medium text-brand">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M8 2.5v8M4.5 7.5L8 11l3.5-3.5M3 13.5h10" />
        </svg>
        <span className="truncate">{file.file_name}</span>
      </span>
      <span className="font-mono text-xs text-ink-3" title="SHA-256 of the file">
        {shortHash(file.file_hash, 10)}
      </span>
    </a>
  );
}

function Contents({ items }: { items: string[] }) {
  return (
    <ul className="mb-5 space-y-1.5">
      {items.map((i) => (
        <li key={i} className="flex items-start gap-2 text-[13px] text-ink-2">
          <span className="mt-0.5 text-ink-3">
            <Mark tone="neutral" size={12} />
          </span>
          {i}
        </li>
      ))}
    </ul>
  );
}

export default function Export({ pulse, engagementId }: ViewProps) {
  const [workpaper, setWorkpaper] = useState<any>(null);
  const [memo, setMemo] = useState<any>(null);
  const [report, setReport] = useState<any>(null);
  const { busy, run } = useAction();
  const status = useTool<any>(engagementId ? "get_engagement_status" : null, {}, [pulse]);
  const found = useTool<{ findings: FindingLite[] }>(engagementId ? "get_findings" : null, { limit: 500 }, [pulse]);

  const s = status.data ?? {};
  const findings = found.data?.findings ?? [];
  const confirmed = findings.filter((f) => f.status === "confirmed");
  const awaiting = findings.filter((f) => f.status === "proposed" || f.status === "needs_info");

  // Totals count each subject once, as on the Overview.
  const once = (list: FindingLite[]) => sum(dedupe(list).kept);

  // With nothing confirmed, an export first asks once, inline.
  const [pending, setPending] = useState<"workpaper" | "summary" | "memo" | null>(null);
  const exportName = { workpaper: "workpaper", summary: "summary report", memo: "findings memo" } as const;
  const guard = (key: "workpaper" | "summary" | "memo", fn: () => void) => () => {
    if (findings.length > 0 && confirmed.length === 0) setPending(key);
    else fn();
  };
  const proceed = () => {
    const key = pending;
    setPending(null);
    if (key === "workpaper") makeWorkpaper();
    if (key === "summary") makeReport();
    if (key === "memo") makeMemo();
  };

  const copyHash = async () => {
    try {
      await navigator.clipboard.writeText(String(s.snapshot_hash));
      toast("Snapshot hash copied.");
    } catch {
      toast("Could not copy. Select the hash and copy it by hand.", "bad");
    }
  };

  const makeWorkpaper = () =>
    run("workpaper", async () => {
      setWorkpaper(await callTool("export_workpaper", {}));
      toast("Workpaper exported.");
    });

  const makeReport = () =>
    run("summary", async () => {
      setReport(await callTool("export_summary_report", {}));
      toast("Summary report created.");
    });

  const makeMemo = () =>
    run("memo", async () => {
      setMemo(await callTool("draft_findings_memo", {}));
      toast("Findings memo drafted.");
    });

  return (
    <>
      <ViewHead title="Export" action={s.signed_off ? <Status tone="good">Engagement signed off</Status> : null} />

      <PageBrief
        lead={
          findings.length
            ? `${findings.filter((f) => f.status === "confirmed" || f.status === "rejected").length} of ${findings.length} findings reviewed; ${confirmed.length ? `${inr(once(confirmed))} confirmed.` : "nothing confirmed yet."}`
            : "No findings to report yet."
        }
        detail="Every file is produced from the frozen snapshot and states the ledger hash it rests on, so anyone can check that the files describe the same records."
        stats={[
          { label: "Confirmed misstatement", value: inr(once(confirmed)), tone: confirmed.length ? "good" : undefined, onClick: () => spotlight("ex-review"), hint: "Go to the review progress" },
          { label: "Still under review", value: inr(once(awaiting)), tone: awaiting.length ? "warn" : undefined, onClick: () => spotlight("ex-review"), hint: "Go to the review progress" },
          { label: "Files you can produce", value: 3, onClick: () => spotlight("ex-files"), hint: "Go to the files" },
          { label: "Snapshot event, select to copy its hash", value: s.snapshot_seq ?? "—", onClick: s.snapshot_hash ? copyHash : undefined, hint: "Copy the snapshot hash" },
        ]}
        guide={[
          { label: "Review progress", target: "ex-review" },
          { label: "The files", target: "ex-files" },
          { label: "What they rest on", target: "ex-rests" },
        ]}
      />

      {findings.length > 0 && (
        <div id="ex-review" className="mb-6 grid gap-5 lg:grid-cols-[1.2fr_1fr]">
          <Panel
            title="How much of the pack has the manager reviewed?"
            takeaway={
              confirmed.length
                ? `${inr(once(confirmed))} of misstatement is confirmed so far.`
                : "Nothing is confirmed yet, so every amount in the files is still potential."
            }
          >
            <ReviewProgress findings={findings} />
          </Panel>
          <div className="grid gap-4 sm:grid-cols-2">
            <Kpi label="Confirmed misstatement" value={inr(once(confirmed))} tone={confirmed.length ? "good" : undefined} note={plural(confirmed.length, "confirmed finding")} />
            <Kpi label="Potential, still under review" value={inr(once(awaiting))} tone={awaiting.length ? "warn" : undefined} note={awaiting.length ? `${plural(awaiting.length, "finding")} not yet decided.` : "Every finding has a decision."} />
          </div>
        </div>
      )}

      {/* A gentle check before exporting while nothing is confirmed. */}
      {pending && (
        <div className="view mb-5 flex flex-wrap items-center gap-x-5 gap-y-3 rounded-lg border border-wait/40 bg-wait-wash px-5 py-4" role="alert">
          <span className="text-wait">
            <Mark tone="warn" size={18} />
          </span>
          <span className="min-w-0 flex-1 text-[13px] text-ink">
            <span className="block font-semibold">No finding is confirmed yet.</span>
            The {exportName[pending]} will list every finding as potential, and its totals will not be final until the manager reviews them.
          </span>
          <span className="flex gap-2">
            <Button small onClick={proceed}>
              Export anyway
            </Button>
            <Button small kind="ghost" onClick={() => setPending(null)}>
              Cancel
            </Button>
          </span>
        </div>
      )}

      <div id="ex-files" className="grid gap-5 lg:grid-cols-2 2xl:grid-cols-[1fr_1fr_1fr_300px]">
        <Panel title="Summary report" meta="One page">
          {report ? (
            <p className="mb-5 text-[13px] text-ink-2">
              {plural(Number(report.summary?.findings?.count ?? 0), "finding")}, with{" "}
              <span className="num font-medium text-ink">{(Number(report.summary?.revenue?.fully_evidenced_share ?? 0) * 100).toFixed(1)}%</span> of revenue backed by a full chain of records.
            </p>
          ) : (
            <Contents items={["Findings and samples at a glance", "Evidence received and tested", "How much revenue can be proved", "Written for the engagement partner"]} />
          )}
          {report?.file && (
            <div className="mb-4">
              <Download file={report.file} />
            </div>
          )}
          <Button busy={busy === "summary"} kind={report ? "ghost" : "primary"} onClick={guard("summary", makeReport)}>
            {report ? "Create again" : "Create the summary"}
          </Button>
        </Panel>

        <Panel title="Workpaper" meta="Excel">
          <Contents items={(workpaper?.sheets ?? ["Sales Register", "Sales TOD", "Sales Cut-off TOD", "Credit Note TOD"]).map((x: string) => `${x} sheet`)} />
          {workpaper?.file && (
            <div className="mb-4">
              <Download file={workpaper.file} />
            </div>
          )}
          <Button busy={busy === "workpaper"} kind="ghost" onClick={guard("workpaper", makeWorkpaper)}>
            {workpaper ? "Export again" : "Export the workpaper"}
          </Button>
        </Panel>

        <Panel title="Findings memo" meta="Document">
          {memo ? (
            <p className="mb-5 text-[13px] text-ink-2">
              {plural(Number(memo.findings ?? 0), "finding")}, with proposed adjustments of <span className="num font-medium text-ink">₹ {money(memo.total_adjustment)}</span> in total.
            </p>
          ) : (
            <Contents items={["Each finding with its impact", "The proposed adjusting entry", "The evidence behind it", "A statement of ledger integrity"]} />
          )}
          {memo?.files?.length > 0 && (
            <div className="mb-4 space-y-2">
              {memo.files.map((f: FileRef) => (
                <Download key={f.file_hash} file={f} />
              ))}
            </div>
          )}
          <Button busy={busy === "memo"} kind="ghost" onClick={guard("memo", makeMemo)}>
            {memo ? "Draft again" : "Draft the memo"}
          </Button>
        </Panel>

        <Panel id="ex-rests" title="Rests on">
          <dl className="space-y-3 text-[13px]">
            <div>
              <dt className="text-ink-2">Period</dt>
              <dd className="text-ink">{s.period_start ? `${day(s.period_start)} to ${day(s.period_end)}` : "—"}</dd>
            </div>
            <div>
              <dt className="text-ink-2">Snapshot</dt>
              <dd className="text-ink">{s.snapshot_seq !== undefined ? `Event ${s.snapshot_seq}` : "—"}</dd>
            </div>
            <div>
              <dt className="text-ink-2">
                <Term word="snapshot">Snapshot hash</Term>
              </dt>
              <dd className="mt-1 flex items-start gap-2">
                <span className="min-w-0 font-mono text-xs break-all text-ink" title={s.snapshot_hash}>
                  {s.snapshot_hash ? shortHash(s.snapshot_hash, 24) : "—"}
                </span>
                {s.snapshot_hash && (
                  <button onClick={copyHash} className="inline-flex shrink-0 items-center gap-1 rounded-md border border-line px-2 py-0.5 text-xs font-medium text-ink-2 transition-colors hover:bg-wash hover:text-ink" aria-label="Copy the full snapshot hash">
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden>
                      <rect x="5" y="5" width="8.5" height="8.5" rx="1.5" />
                      <path d="M3 10.5V3.5A1 1 0 014 2.5h6.5" strokeLinecap="round" />
                    </svg>
                    Copy
                  </button>
                )}
              </dd>
            </div>
          </dl>
        </Panel>
      </div>
    </>
  );
}
