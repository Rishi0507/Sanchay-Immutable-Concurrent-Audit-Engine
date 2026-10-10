import { useState } from "react";
import { callTool, shortHash, when } from "../api";
import type { ViewProps } from "../App";
import { Button, Card, ErrorNote, Field, Header, KeyValues, Loading, Mark, Status, cx, inputClass, toast, useAction, useTool } from "../ui";

interface Step {
  step: string;
  tool: string;
  purpose?: string;
  status: "done" | "ready" | "blocked";
}

// Tools that the plan can run directly, with no further input.
const runnable = new Set([
  "import_register",
  "reconcile_register",
  "tag_related_parties",
  "run_detectors",
  "select_sales_tod",
  "select_cutoff_tod",
  "select_credit_note_tod",
  "verify_evidence",
  "check_post_testing_changes",
  "verify_ledger_integrity",
  "draft_findings_memo",
  "export_workpaper",
]);

// Plain names for the steps. The button that starts a step carries the same
// words as the step itself.
const stepName: Record<string, string> = {
  open_engagement: "Open the engagement",
  import_register: "Import the register",
  reconcile_register: "Reconcile the register",
  tag_related_parties: "Tag related parties",
  run_detectors: "Run the detectors",
  select_sales_tod: "Select Sales TOD samples",
  select_cutoff_tod: "Select cut-off samples",
  select_credit_note_tod: "Select credit note samples",
  verify_evidence: "Test the evidence",
  check_post_testing_changes: "Check for client changes",
  verify_ledger_integrity: "Verify the ledger",
  draft_findings_memo: "Draft the findings memo",
  export_workpaper: "Export the workpaper",
};

function label(tool: string) {
  return stepName[tool] ?? tool.replace(/_/g, " ");
}

function OpenEngagement({ onOpened, pulse }: { onOpened: (id: string) => void; pulse: number }) {
  const now = new Date();
  const startYear = now.getMonth() >= 3 ? now.getFullYear() - 1 : now.getFullYear() - 2;
  const [periodStart, setPeriodStart] = useState(`${startYear}-04-01`);
  const [periodEnd, setPeriodEnd] = useState(`${startYear + 1}-03-31`);
  const [seed, setSeed] = useState("");
  const notes = useTool<any>("get_notifications", {}, [pulse]);
  const { busy, run } = useAction();
  const register = !!notes.data?.sales_register_uploaded;
  const parties = !!notes.data?.related_parties_uploaded;

  return (
    <div className="max-w-xl">
      <div className="mb-6 space-y-2">
        <Status tone={register ? "good" : "warn"}>{register ? "Sales register received" : "Waiting for the client's sales register"}</Status>
        <br />
        <Status tone={parties ? "good" : "warn"}>{parties ? "Related-party list received" : "Waiting for the client's related-party list"}</Status>
      </div>
      <Card className="p-5">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Period start">
            <input type="date" className={inputClass} value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
          </Field>
          <Field label="Period end">
            <input type="date" className={inputClass} value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
          </Field>
          <div className="col-span-2">
            <Field label="Sampling seed (generated if left empty)">
              <input className={inputClass} value={seed} onChange={(e) => setSeed(e.target.value)} />
            </Field>
          </div>
        </div>
        <div className="mt-5 flex items-center justify-between gap-4">
          <p className="text-[13px] text-ink-2">Opening freezes a snapshot of the client's records.</p>
          <Button
            busy={busy === "open"}
            disabled={!register || !parties}
            onClick={() =>
              run("open", async () => {
                const opened = await callTool("open_engagement", { period_start: periodStart, period_end: periodEnd, seed });
                toast("Engagement opened. The snapshot is frozen.");
                onOpened(opened.engagement_id);
              })
            }
          >
            Open the engagement
          </Button>
        </div>
      </Card>
    </div>
  );
}

// One line that shows how the findings split by severity. The widths are the
// counts, so the bar is the data.
function SeverityBar({ high, medium, low }: { high: number; medium: number; low: number }) {
  const total = high + medium + low;
  if (total === 0) return <div className="h-2 rounded-full bg-wash" />;
  const part = (n: number) => `${(n / total) * 100}%`;
  return (
    <div className="flex h-2 gap-px overflow-hidden rounded-full" role="img" aria-label={`${high} high, ${medium} medium, ${low} low`}>
      {high > 0 && <div className="bg-fail" style={{ width: part(high) }} />}
      {medium > 0 && <div className="bg-warm" style={{ width: part(medium) }} />}
      {low > 0 && <div className="bg-ink-3" style={{ width: part(low) }} />}
    </div>
  );
}

function Count({ n, label, tone }: { n: number; label: string; tone?: string }) {
  return (
    <span className="whitespace-nowrap">
      <span className={cx("figure text-xl font-medium", n > 0 && tone)}>{n}</span>
      <span className="ml-1.5 text-[13px] text-ink-2">{label}</span>
    </span>
  );
}

export default function Overview({ pulse, goTo, engagementId, onEngagement }: ViewProps) {
  const status = useTool<any>(engagementId ? "get_engagement_status" : null, {}, [pulse]);
  const noEngagement = !engagementId || (status.error as any)?.code === "NO_ENGAGEMENT";
  const plan = useTool<{ steps: Step[]; next_tool?: string }>(engagementId ? "get_audit_plan" : null, {}, [pulse]);
  const [integrity, setIntegrity] = useState<any>(null);
  const { busy, run } = useAction();

  const reload = () => {
    status.reload();
    plan.reload();
  };

  const runTool = (tool: string) =>
    run(tool, async () => {
      const result = await callTool(tool, {});
      if (tool === "verify_ledger_integrity") setIntegrity(result);
      const made = result.findings_created;
      toast(`${label(tool)}: done${typeof made === "number" && made > 0 ? `, ${made} new finding${made === 1 ? "" : "s"}` : ""}.`);
      reload();
    });

  if (noEngagement) {
    return (
      <>
        <Header title="Open an engagement" hint="Choose the period to audit." />
        <OpenEngagement onOpened={onEngagement} pulse={pulse} />
      </>
    );
  }
  if (status.loading && !status.data && !status.error) return <Loading />;
  if (status.error) {
    return (
      <>
        <Header title="Overview" />
        <Card>
          <ErrorNote error={status.error} onRetry={status.reload} />
        </Card>
      </>
    );
  }

  const s = status.data ?? {};
  const bySeverity = s.counts?.findings_by_severity ?? {};
  const high = Number(bySeverity.High ?? 0);
  const medium = Number(bySeverity.Medium ?? 0);
  const low = Number(bySeverity.Low ?? 0);
  const steps: Step[] = plan.data?.steps ?? s.steps ?? [];
  const next = plan.data?.next_tool ?? s.next_tool;
  const samples = Object.values(s.counts?.samples_by_sheet ?? {}).reduce((a: number, b: any) => a + Number(b), 0);
  const pending = Number(s.counts?.evidence_pending ?? 0);
  const done = steps.filter((st) => st.status === "done").length;

  return (
    <>
      <Header
        title="Overview"
        hint={`Period ${s.period_start} to ${s.period_end}`}
        action={
          next && runnable.has(next) ? (
            <Button busy={busy === next} onClick={() => runTool(next)}>
              {label(next)}
            </Button>
          ) : s.signed_off ? (
            <Status tone="good">Signed off</Status>
          ) : null
        }
      />

      <div className="mb-8 grid gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-[1.6fr_1fr_1fr]">
        <button onClick={() => goTo("findings")} className="flex flex-col bg-paper px-5 py-4 text-left transition-colors hover:bg-wash">
          <div className="mb-3 flex w-full items-baseline justify-between">
            <span className="text-[13px] font-medium text-ink-2">Findings</span>
            <span className="text-[13px] text-ink-3 tabular-nums">{high + medium + low} in total</span>
          </div>
          <div className="w-full">
            <SeverityBar high={high} medium={medium} low={low} />
          </div>
          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1">
            <Count n={high} label="high" tone="text-fail" />
            <Count n={medium} label="medium" tone="text-warm" />
            <Count n={low} label="low" />
          </div>
        </button>
        <button onClick={() => goTo("samples")} className="flex flex-col bg-paper px-5 py-4 text-left transition-colors hover:bg-wash">
          <div className="mb-3 text-[13px] font-medium text-ink-2">Samples selected</div>
          <div className="figure text-xl font-medium">{samples}</div>
        </button>
        <div className="bg-paper px-5 py-4">
          <div className="mb-3 text-[13px] font-medium text-ink-2">Documents awaited from the client</div>
          <div className={cx("figure text-xl font-medium", pending > 0 && "text-wait")}>{pending}</div>
        </div>
      </div>

      <div className="grid gap-x-12 gap-y-8 lg:grid-cols-[1fr_340px]">
        <section>
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold">Audit steps</h2>
            <span className="text-[13px] text-ink-2 tabular-nums">
              {done} of {steps.length} done
            </span>
          </div>
          <ol className="border-t border-line">
            {steps.map((st, i) => {
              const isNext = st.tool === next;
              const isDone = st.status === "done";
              return (
                <li key={st.step} className={cx("group flex min-h-11 items-center gap-3.5 border-b border-line-soft py-1.5 pr-1", isNext && "bg-brand-wash/60")}>
                  <span
                    className={cx(
                      "ml-1 flex h-6 w-6 shrink-0 items-center justify-center text-xs tabular-nums",
                      isDone ? "text-pass" : isNext ? "font-semibold text-brand" : "text-ink-3",
                    )}
                  >
                    {isDone ? <Mark tone="good" size={16} /> : i + 1}
                  </span>
                  <span className={cx("min-w-0 flex-1 text-sm", isDone ? "text-ink" : isNext ? "font-medium text-ink" : "text-ink-2")}>{label(st.tool)}</span>
                  {isNext && <span className="text-xs font-medium text-brand">Next</span>}
                  {runnable.has(st.tool) && st.status !== "blocked" && !isNext && (
                    // Shown on hover or keyboard focus, so a finished list stays quiet.
                    <span className={cx("transition-opacity duration-150", busy === st.tool ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100")}>
                      <Button kind="ghost" small busy={busy === st.tool} onClick={() => runTool(st.tool)}>
                        {isDone ? "Run again" : "Run"}
                      </Button>
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </section>

        <aside className="space-y-8">
          <section>
            <h2 className="mb-3 text-sm font-semibold">Snapshot</h2>
            <KeyValues
              items={[
                ["Frozen at", `Event ${s.snapshot_seq}`],
                ["Hash", <span className="font-mono text-xs" title={s.snapshot_hash}>{shortHash(s.snapshot_hash, 16)}</span>],
                ["Seed", <span className="font-mono text-xs">{s.seed}</span>],
                ["Opened", s.opened_at ? when(s.opened_at) : undefined],
                ["Engagement", <span className="font-mono text-xs">{s.engagement_id}</span>],
              ]}
            />
          </section>
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Ledger integrity</h2>
              {integrity && <Status tone={integrity.ok ? "good" : "bad"}>{integrity.ok ? "Verified" : "Failed"}</Status>}
            </div>
            {integrity ? (
              <KeyValues
                items={[
                  ["Ledger", `${integrity.business_chain?.checked ?? 0} events checked`],
                  ["Trail", `${integrity.trail_chain?.checked ?? 0} entries checked`],
                  ["Snapshot", integrity.snapshot ? (integrity.snapshot.match ? "Unchanged since opening" : "Altered since opening") : undefined],
                  ["First altered", integrity.business_chain?.first_bad_seq ?? integrity.trail_chain?.first_bad_seq],
                ]}
              />
            ) : (
              <p className="text-[13px] text-ink-2">Recomputes every hash in the ledger and the trail, and compares the snapshot with the one stored at opening.</p>
            )}
            <div className="mt-4 flex gap-2">
              <Button kind="ghost" small busy={busy === "verify_ledger_integrity"} onClick={() => runTool("verify_ledger_integrity")}>
                Verify the ledger
              </Button>
              <Button kind="ghost" small onClick={() => goTo("trail")}>
                Open the trail
              </Button>
            </div>
          </section>
        </aside>
      </div>
    </>
  );
}
