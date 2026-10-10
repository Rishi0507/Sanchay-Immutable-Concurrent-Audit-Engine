import { useState } from "react";
import { callTool, shortHash, when } from "../api";
import type { ViewProps } from "../App";
import { Button, Card, Chip, Empty, ErrorNote, Field, Header, KeyValues, Loading, Stat, cx, inputClass, toast, toneFor, useAction, useTool } from "../ui";

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

function label(tool: string) {
  const text = tool.replace(/_/g, " ").replace(/\btod\b/, "TOD");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function OpenEngagement({ onOpened, pulse }: { onOpened: () => void; pulse: number }) {
  const now = new Date();
  const startYear = now.getMonth() >= 3 ? now.getFullYear() - 1 : now.getFullYear() - 2;
  const [periodStart, setPeriodStart] = useState(`${startYear}-04-01`);
  const [periodEnd, setPeriodEnd] = useState(`${startYear + 1}-03-31`);
  const [seed, setSeed] = useState("");
  const notes = useTool<any>("get_notifications", {}, [pulse]);
  const { busy, run } = useAction();
  const ready = notes.data?.sales_register_uploaded && notes.data?.related_parties_uploaded;

  return (
    <Card className="mx-auto max-w-xl p-6">
      <div className="mb-4 text-base font-semibold">Open an engagement</div>
      <div className="mb-5 flex gap-2">
        <Chip tone={notes.data?.sales_register_uploaded ? "good" : "warn"}>Sales register {notes.data?.sales_register_uploaded ? "received" : "awaited"}</Chip>
        <Chip tone={notes.data?.related_parties_uploaded ? "good" : "warn"}>Related parties {notes.data?.related_parties_uploaded ? "received" : "awaited"}</Chip>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Period start">
          <input type="date" className={inputClass} value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
        </Field>
        <Field label="Period end">
          <input type="date" className={inputClass} value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
        </Field>
        <div className="col-span-2">
          <Field label="Sampling seed (optional)">
            <input className={inputClass} placeholder="Generated when empty" value={seed} onChange={(e) => setSeed(e.target.value)} />
          </Field>
        </div>
      </div>
      <div className="mt-5 flex justify-end">
        <Button
          busy={busy === "open"}
          disabled={!ready}
          onClick={() =>
            run("open", async () => {
              await callTool("open_engagement", { period_start: periodStart, period_end: periodEnd, seed });
              toast("Engagement opened. The snapshot is frozen.");
              onOpened();
            })
          }
        >
          Open engagement
        </Button>
      </div>
    </Card>
  );
}

export default function Overview({ pulse, goTo }: ViewProps) {
  const status = useTool<any>("get_engagement_status", {}, [pulse]);
  const noEngagement = (status.error as any)?.code === "NO_ENGAGEMENT";
  const engagementId = status.data?.engagement_id;
  const plan = useTool<{ steps: Step[]; next_tool?: string }>(engagementId ? "get_audit_plan" : null, { engagement_id: engagementId }, [pulse, engagementId]);
  const [integrity, setIntegrity] = useState<any>(null);
  const { busy, run } = useAction();

  const reload = () => {
    status.reload();
    plan.reload();
  };

  const runTool = (tool: string) =>
    run(tool, async () => {
      const result = await callTool(tool, { engagement_id: engagementId });
      if (tool === "verify_ledger_integrity") setIntegrity(result);
      const made = result.findings_created;
      toast(`${label(tool)} finished${typeof made === "number" && made > 0 ? `, ${made} finding${made === 1 ? "" : "s"}` : ""}.`);
      reload();
    });

  if (status.loading && !status.data && !status.error) return <Loading />;
  if (noEngagement) {
    return (
      <>
        <Header title="Overview" />
        <OpenEngagement onOpened={status.reload} pulse={pulse} />
      </>
    );
  }
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
  const steps = plan.data?.steps ?? s.steps ?? [];
  const next = plan.data?.next_tool ?? s.next_tool;
  const samples = Object.values(s.counts?.samples_by_sheet ?? {}).reduce((a: number, b: any) => a + Number(b), 0);

  return (
    <>
      <Header
        title="Overview"
        hint={`${s.period_start} to ${s.period_end}`}
        action={
          next && runnable.has(next) ? (
            <Button busy={busy === next} onClick={() => runTool(next)}>
              {label(next)}
            </Button>
          ) : s.signed_off ? (
            <Chip tone="good">Signed off</Chip>
          ) : null
        }
      />
      <div className="mb-5 grid grid-cols-2 gap-4 md:grid-cols-5">
        <Stat label="High" value={bySeverity.High ?? 0} tone={bySeverity.High ? "bad" : undefined} />
        <Stat label="Medium" value={bySeverity.Medium ?? 0} tone={bySeverity.Medium ? "warn" : undefined} />
        <Stat label="Low" value={bySeverity.Low ?? 0} />
        <Stat label="Samples" value={samples} />
        <Stat label="Evidence pending" value={s.counts?.evidence_pending ?? 0} tone={s.counts?.evidence_pending ? "warn" : undefined} />
      </div>
      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="border-b border-slate-200 px-5 py-3 text-sm font-semibold">Audit steps</div>
          {steps.length === 0 ? (
            <Empty title="No plan yet" />
          ) : (
            <ol>
              {steps.map((st: Step, i: number) => (
                <li key={st.step} className="flex items-center gap-4 border-b border-slate-100 px-5 py-3 last:border-0">
                  <span
                    className={cx(
                      "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                      st.status === "done" ? "bg-emerald-100 text-emerald-700" : st.tool === next ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-500",
                    )}
                  >
                    {st.status === "done" ? "✓" : i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{label(st.tool)}</div>
                  </div>
                  <Chip tone={toneFor(st.status)}>{st.status}</Chip>
                  {runnable.has(st.tool) && st.status !== "blocked" && st.tool !== next && (
                    <Button kind="ghost" small busy={busy === st.tool} onClick={() => runTool(st.tool)}>
                      {st.status === "done" ? "Run again" : "Run"}
                    </Button>
                  )}
                </li>
              ))}
            </ol>
          )}
        </Card>
        <div className="space-y-5">
          <Card className="p-5">
            <div className="mb-3 text-sm font-semibold">Engagement</div>
            <KeyValues
              items={[
                ["ID", <span className="font-mono text-xs">{s.engagement_id}</span>],
                ["Seed", <span className="font-mono text-xs">{s.seed}</span>],
                ["Snapshot", `Event ${s.snapshot_seq}`],
                ["Hash", <span className="font-mono text-xs" title={s.snapshot_hash}>{shortHash(s.snapshot_hash, 16)}</span>],
                ["Opened", s.opened_at ? when(s.opened_at) : undefined],
              ]}
            />
          </Card>
          <Card className="p-5">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-sm font-semibold">Integrity</div>
              {integrity && <Chip tone={integrity.ok ? "good" : "bad"}>{integrity.ok ? "Verified" : "Failed"}</Chip>}
            </div>
            {integrity ? (
              <KeyValues
                items={[
                  ["Ledger", `${integrity.business_chain?.checked ?? 0} events checked`],
                  ["Trail", `${integrity.trail_chain?.checked ?? 0} entries checked`],
                  ["Snapshot", integrity.snapshot ? (integrity.snapshot.match ? "Unchanged" : "Altered") : undefined],
                  ["First bad", integrity.business_chain?.first_bad_seq ?? integrity.trail_chain?.first_bad_seq],
                ]}
              />
            ) : (
              <div className="text-sm text-slate-500">Recompute both hash chains.</div>
            )}
            <div className="mt-4 flex gap-2">
              <Button kind="ghost" small busy={busy === "verify_ledger_integrity"} onClick={() => runTool("verify_ledger_integrity")}>
                Verify
              </Button>
              <Button kind="ghost" small onClick={() => goTo("trail")}>
                Open trail
              </Button>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
