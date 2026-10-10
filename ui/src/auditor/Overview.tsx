import { useMemo, useState } from "react";
import { callTool, shortHash, when } from "../api";
import type { ViewProps } from "../App";
import { Button, Card, ErrorNote, Field, KeyValues, Mark, Pills, Status, cx, inputClass, toast, useAction, useTool } from "../ui";
import { Bridge, BridgeStep, ColumnDatum, Columns, Swatch, ink } from "./charts";
import { ChartSkeleton, FindingLite, PageBrief, dedupe, ListSkeleton, Panel, ReviewProgress, Ring, SeverityBadge, Skeleton, Term, ViewHead, byPriority, catColor, category, day, inr, monthKey, monthLabel, monthRange, num, plural, registerFields, scaleFor, sum, useRegisterAll } from "./kit";

interface Step {
  step: string;
  tool: string;
  purpose?: string;
  status: "done" | "ready" | "blocked";
}

interface TrailEntry {
  trail_seq: number;
  ts: string;
  user: string;
  role: string;
  tool: string;
  status: string;
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

// Actions worth showing as activity: reads are left out, they are in the trail.
const quietTool = /^(get_|list_|explain_|whoami|query_)/;
const actionName: Record<string, string> = {
  ...stepName,
  confirm_finding: "Decided on a finding",
  upload_register: "Uploaded the sales register",
  upload_related_parties: "Uploaded the related-party list",
  upload_evidence: "Uploaded evidence",
  request_evidence: "Requested evidence",
  sign_off_engagement: "Signed off the engagement",
  record_sale: "Recorded a sale",
};
const roleLabel: Record<string, string> = { client_employee: "Client", auditor: "Auditor", audit_manager: "Manager" };

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
  const ready = register && parties;

  return (
    <div className="grid max-w-4xl gap-5 md:grid-cols-[1fr_1.3fr]">
      <Panel title="What the client has sent">
        <ul className="space-y-3">
          {[
            [register, "Sales register", "The register the client prepared for the period."],
            [parties, "Related-party list", "Parties the client declares as related."],
          ].map(([got, name, hint]) => (
            <li key={String(name)} className="flex gap-3">
              <span className={cx("mt-0.5", got ? "text-pass" : "text-wait")}>
                <Mark tone={got ? "good" : "warn"} size={16} />
              </span>
              <span>
                <span className="block text-sm font-medium text-ink">{name as string}</span>
                <span className="block text-[13px] text-ink-2">
                  {got ? "Received." : "Waiting for the client."} {hint as string}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </Panel>
      <Panel title="Audit period">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Period start">
            <input type="date" className={inputClass} value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
          </Field>
          <Field label="Period end">
            <input type="date" className={inputClass} value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
          </Field>
          <div className="col-span-2">
            <Field label="Sampling seed (leave empty to use the sealed seed, which nobody chooses)">
              <input className={inputClass} value={seed} onChange={(e) => setSeed(e.target.value)} />
            </Field>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-4">
          <p className="text-[13px] text-ink-2">{ready ? "Opening freezes a snapshot of the client's records." : "Both files are needed before the engagement can open."}</p>
          <Button
            busy={busy === "open"}
            disabled={!ready}
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
      </Panel>
    </div>
  );
}


// The audit as eight stages, in the order the pipeline runs them. Each stage
// is done when every plan step behind it is done.
const stages: { key: string; label: string; tools: string[]; note?: string }[] = [
  { key: "upload", label: "Upload", tools: [] },
  { key: "snapshot", label: "Snapshot", tools: ["open_engagement"] },
  { key: "reconcile", label: "Reconcile", tools: ["import_register", "reconcile_register", "tag_related_parties"] },
  { key: "detect", label: "Detect", tools: ["run_detectors"] },
  { key: "sample", label: "Sample", tools: ["select_sales_tod", "select_cutoff_tod", "select_credit_note_tod"], note: "Uses detector hits to pick risky invoices." },
  { key: "evidence", label: "Evidence", tools: ["verify_evidence", "check_post_testing_changes"] },
  { key: "review", label: "Review", tools: [] },
  { key: "export", label: "Export", tools: ["verify_ledger_integrity", "draft_findings_memo", "export_workpaper"] },
];

type StageState = "done" | "current" | "todo";

function StepsRail({ items }: { items: { key: string; label: string; state: StageState; detail: string; note?: string }[] }) {
  return (
    <ol className="grid grid-cols-4 gap-y-4 sm:grid-cols-8" aria-label="Audit stages">
      {items.map((it, i) => (
        <li key={it.key} className="group/stage relative min-w-0 pr-2" aria-current={it.state === "current" ? "step" : undefined}>
          <div className="flex items-center">
            <span
              className={cx(
                "relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 text-[11px] font-semibold",
                it.state === "done" ? "border-pass bg-pass text-paper" : it.state === "current" ? "border-brand bg-paper text-brand" : "border-line bg-paper text-ink-3",
              )}
            >
              {it.state === "done" ? <Mark tone="good" size={12} /> : i + 1}
            </span>
            {i < items.length - 1 && (
              <span className="relative mx-1.5 h-0.5 flex-1 overflow-hidden rounded-full bg-line">
                {it.state === "done" && <span className="rail-fill absolute inset-0 bg-pass" style={{ animationDelay: `${i * 90}ms` }} />}
              </span>
            )}
          </div>
          <div className={cx("mt-2 text-[13px] font-medium", it.state === "todo" ? "text-ink-3" : "text-ink")}>
            {it.note ? (
              <span className="inline-flex items-center gap-1">
                {it.label}
                <span tabIndex={0} className="cursor-help text-ink-3 outline-none focus-visible:text-ink" aria-label={it.note}>
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
                    <circle cx="8" cy="8" r="6.3" />
                    <path d="M8 7.2v4M8 4.9v.2" strokeLinecap="round" strokeWidth="1.8" />
                  </svg>
                </span>
                <span role="tooltip" className="pointer-events-none absolute top-full left-0 z-30 mt-1 hidden w-52 rounded-md border border-line bg-paper px-3 py-2 text-xs font-normal text-ink shadow-[0_10px_30px_rgba(0,0,0,0.28)] group-focus-within/stage:block group-hover/stage:block">
                  {it.note}
                </span>
              </span>
            ) : (
              it.label
            )}
          </div>
          <div className="text-xs text-ink-2">{it.detail}</div>
        </li>
      ))}
    </ol>
  );
}

export default function Overview({ pulse, goTo, engagementId, onEngagement }: ViewProps) {
  const status = useTool<any>(engagementId ? "get_engagement_status" : null, {}, [pulse]);
  const noEngagement = !engagementId || (status.error as any)?.code === "NO_ENGAGEMENT";
  const plan = useTool<{ steps: Step[]; next_tool?: string }>(engagementId ? "get_audit_plan" : null, {}, [pulse]);
  const found = useTool<{ findings: FindingLite[]; totals?: { count: number } }>(engagementId ? "get_findings" : null, { limit: 500 }, [pulse]);
  const trail = useTool<{ entries: TrailEntry[] }>(engagementId ? "get_audit_trail" : null, { limit: 300 }, [pulse]);
  const register = useRegisterAll(!!engagementId && !noEngagement, pulse);
  const [integrity, setIntegrity] = useState<any>(null);
  const [onlyBad, setOnlyBad] = useState(false);
  const [heroView, setHeroView] = useState<"bridge" | "months">("bridge");
  const { busy, run } = useAction();

  const findings = found.data?.findings ?? [];

  // Everything below is arithmetic on the findings the engine returned.
  const view = useMemo(() => {
    const open = findings.filter((f) => f.status !== "rejected");
    const confirmed = findings.filter((f) => f.status === "confirmed");
    const awaiting = findings.filter((f) => f.status === "proposed" || f.status === "needs_info");
    const once = dedupe(open);
    const cats = new Map<string, FindingLite[]>();
    for (const f of once.kept) cats.set(f.category, [...(cats.get(f.category) ?? []), f]);
    const byCategory = [...cats.entries()].map(([cat, list]) => ({ cat, list, value: sum(list) })).sort((a, b) => b.value - a.value || b.list.length - a.list.length);
    const high = open.filter((f) => f.severity === "High");
    return {
      open,
      confirmed,
      awaiting,
      high,
      once,
      byCategory,
      exposure: sum(once.kept),
      confirmedValue: sum(dedupe(confirmed).kept),
      highValue: sum(dedupe(high).kept),
      top: [...open].sort(byPriority).slice(0, 5),
    };
  }, [findings]);

  // The register by month: clean revenue, related-party revenue, and rows the
  // reconciliation could not agree.
  const timeline = useMemo(() => {
    const f = registerFields(register.columns);
    if (!f.date || !f.value) return { data: [] as ColumnDatum[], attention: 0, total: 0, max: 0 };
    const buckets = new Map<string, { clean: number; rp: number; bad: number; badRows: number; rows: number }>();
    let attention = 0;
    let total = 0;
    for (const r of register.rows) {
      const m = monthKey(r.raw[f.date]);
      if (!m) continue;
      const v = num(r.raw[f.value]);
      const b = buckets.get(m) ?? { clean: 0, rp: 0, bad: 0, badRows: 0, rows: 0 };
      b.rows++;
      total += v;
      if (r.recon_status && r.recon_status !== "MATCHED") {
        b.bad += v;
        b.badRows++;
        attention += v;
      } else if (r.rp_tag === "Related Party") b.rp += v;
      else b.clean += v;
      buckets.set(m, b);
    }
    let max = 0;
    const data = monthRange([...buckets.keys()]).map((m) => {
      const b = buckets.get(m) ?? { clean: 0, rp: 0, bad: 0, badRows: 0, rows: 0 };
      max = Math.max(max, onlyBad ? b.bad : b.clean + b.rp + b.bad);
      return {
        key: m,
        label: monthLabel(m),
        parts: (onlyBad
          ? []
          : [
              { key: "clean", label: "Agrees with the books", value: b.clean, color: "color-mix(in oklab, var(--color-brand) 42%, transparent)" },
              { key: "rp", label: "Related party", value: b.rp, color: ink.rp },
            ]
        ).concat([{ key: "bad", label: "Not agreeing", value: b.bad, color: ink.high }]),
        note: `${plural(b.rows, "row")}${b.badRows ? `, ${b.badRows} not agreeing` : ""}`,
      };
    });
    return { data, attention, total, max };
  }, [register.columns, register.rows, onlyBad]);

  // The bridge: register value, less each area's potential misstatement, each
  // subject counted once.
  const bridge = useMemo<BridgeStep[]>(() => {
    if (!timeline.total) return [];
    const top = view.byCategory.slice(0, 6);
    const rest = view.byCategory.slice(6);
    const confirmedIn = (list: FindingLite[]) => sum(list.filter((f) => f.status === "confirmed"));
    const steps: BridgeStep[] = [{ key: "start", label: "Register value", kind: "total", value: timeline.total, note: "Gross value of every row in the client's register" }];
    for (const c of top) steps.push({ key: c.cat, label: category(c.cat), kind: "step", value: c.value, confirmed: confirmedIn(c.list), note: plural(c.list.length, "finding") });
    if (rest.length) {
      const list = rest.flatMap((c) => c.list);
      steps.push({ key: "other", label: `${rest.length} other areas`, kind: "step", value: sum(list), confirmed: confirmedIn(list), note: plural(list.length, "finding") });
    }
    steps.push({ key: "end", label: "Not in question", kind: "total", prefix: "At least", value: Math.max(0, timeline.total - view.exposure), note: "Register value less every open finding. Findings on different subjects can still overlap, so the true figure can only be higher." });
    return steps;
  }, [timeline.total, view]);

  const reload = () => {
    status.reload();
    plan.reload();
    found.reload();
    trail.reload();
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
        <ViewHead title="Open an engagement" summary="Choose the period to audit. Opening freezes the client's records so every test runs on the same data." />
        <OpenEngagement onOpened={onEngagement} pulse={pulse} />
      </>
    );
  }
  if (status.loading && !status.data && !status.error) {
    return (
      <div className="space-y-5" role="status" aria-label="Loading the overview">
        <Skeleton className="h-9 w-2/3" />
        <Skeleton className="h-5 w-1/2" />
        <div className="grid gap-4 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <Skeleton className="h-80" />
      </div>
    );
  }
  if (status.error) {
    return (
      <>
        <ViewHead title="Overview" />
        <Card>
          <ErrorNote error={status.error} onRetry={status.reload} />
        </Card>
      </>
    );
  }

  const s = status.data ?? {};
  const steps: Step[] = plan.data?.steps ?? s.steps ?? [];
  const next = plan.data?.next_tool ?? s.next_tool;
  const pending = Number(s.counts?.evidence_pending ?? 0);
  // Requests for documents that should not exist, and how the client answered
  // them. Shown only when the engine reports counts.control_requests.
  const controls = s.counts?.control_requests as { sent: number; declined: number; supplied: number } | undefined;
  const done = steps.filter((st) => st.status === "done").length;
  const activity = (trail.data?.entries ?? []).filter((e) => !quietTool.test(e.tool) && e.status === "ok").slice(0, 6);
  const periodEndMonth = monthKey(s.period_end);
  const reviewed = findings.filter((f) => f.status === "confirmed" || f.status === "rejected").length;

  // Stage states from the plan and the review.
  const stepDone = (tool: string) => steps.find((x) => x.tool === tool)?.status === "done" || (tool === "open_engagement" && !!s.engagement_id);
  let currentSet = false;
  const rail = stages.map((st) => {
    let isDone: boolean;
    let detail: string;
    if (st.key === "upload") {
      isDone = !!s.engagement_id;
      detail = isDone ? "Register received" : "Waiting";
    } else if (st.key === "review") {
      isDone = findings.length > 0 && reviewed === findings.length;
      detail = findings.length ? `${reviewed} of ${findings.length}` : "Nothing yet";
    } else {
      const n = st.tools.filter(stepDone).length;
      isDone = st.tools.length > 0 && n === st.tools.length;
      detail = st.key === "evidence" && pending ? `${pending} awaited` : st.tools.length > 1 ? `${n} of ${st.tools.length}` : isDone ? "Done" : "To do";
      if (st.key === "evidence" && controls && controls.sent > 0) detail += `, ${controls.supplied} fabricated`;
    }
    let state: StageState = isDone ? "done" : "todo";
    if (!isDone && !currentSet) {
      state = "current";
      currentSet = true;
    }
    return { key: st.key, label: st.label, state, detail, note: st.note };
  });

  const topArea = view.byCategory[0];
  const notInQuestion = Math.max(0, timeline.total - view.exposure);
  const bridgeScale = scaleFor(timeline.total);
  const monthScale = scaleFor(timeline.max);

  const headline = s.signed_off
    ? `Signed off, with ${inr(view.confirmedValue)} of misstatement confirmed.`
    : findings.length === 0
      ? "No findings raised yet."
      : `${inr(view.exposure)} of revenue is in question.`;
  const summary = s.signed_off
    ? `${plural(view.confirmed.length, "finding")} confirmed by the manager.`
    : `${plural(view.open.length, "open finding")} flag it, ${view.high.length} of them high severity. ${view.confirmed.length ? `${inr(view.confirmedValue)} is confirmed so far.` : "None is confirmed yet."}`;

  return (
    <>
      <ViewHead
        eyebrow={`Revenue audit, ${day(s.period_start)} to ${day(s.period_end)}${s.signed_off ? ", signed off" : ""}`}
        title="Overview"
        action={
          next && runnable.has(next) ? (
            <Button busy={busy === next} onClick={() => runTool(next)}>
              Next: {label(next)}
            </Button>
          ) : s.signed_off ? (
            <Status tone="good">Signed off</Status>
          ) : null
        }
      />

      <PageBrief
        lead={headline}
        detail={summary}
        stats={[
          { label: "Potential misstatement, each subject counted once", value: inr(view.exposure), tone: view.exposure ? "bad" : undefined, onClick: () => goTo("findings"), hint: "Open the findings" },
          { label: "Confirmed by the manager", value: inr(view.confirmedValue), tone: view.confirmedValue ? "good" : undefined, onClick: () => goTo("findings", "f:status=proposed"), hint: "Open the findings awaiting review" },
          { label: "High-severity findings", value: view.high.length, tone: view.high.length ? "bad" : undefined, onClick: () => goTo("findings", "f:severity=High"), hint: "Open the high-severity findings" },
          {
            label: timeline.total ? `Register rows not agreeing, ${((timeline.attention / timeline.total) * 100).toFixed(1)}% of the register` : "Register rows not agreeing",
            value: register.loading && !register.rows.length ? "…" : inr(timeline.attention),
            onClick: () => goTo("register", "status:attention"),
            hint: "Open those rows in the register",
          },
        ]}
        guide={[
          { label: "How far the audit has got", target: "ov-progress" },
          { label: "What to look at first", target: "ov-top" },
          { label: "Where the money is in question", target: "ov-bridge" },
          { label: "The plan and the ledger", target: "ov-plan" },
        ]}
      />

      <div className="mb-6 grid gap-6 xl:grid-cols-[1fr_400px]">
        {/* Where the audit stands. */}
        <section id="ov-progress" className="rounded-lg border border-line bg-paper px-5 py-5" aria-label="Audit progress">
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold text-ink">How far has the audit got?</h2>
            <span className="text-[13px] text-ink-2">
              {done} of {steps.length} plan steps done{next ? `. Next: ${label(next).toLowerCase()}` : ""}
            </span>
          </div>
          <StepsRail items={rail} />
          {findings.length > 0 && (
            <div className="mt-5 border-t border-line-soft pt-4">
              <ReviewProgress findings={findings} />
            </div>
          )}
        </section>

        <div id="ov-top">
        <Panel title="Investigate first" takeaway="Highest severity first, then the largest amount." action={<button onClick={() => goTo("findings")} className="font-medium text-brand hover:underline">All findings</button>} flush>
          {found.loading && !found.data ? (
            <ListSkeleton rows={5} />
          ) : view.top.length === 0 ? (
            <p className="px-5 py-8 text-sm text-ink-2">Nothing to investigate yet. Findings appear here once the detectors have run.</p>
          ) : (
            <ol className="divide-y divide-line-soft">
              {view.top.map((f, i) => (
                <li key={f.finding_id}>
                  <button onClick={() => goTo("findings", f.finding_id)} className="group flex w-full items-start gap-3.5 px-5 py-3 text-left transition-colors hover:bg-wash focus-visible:bg-wash focus-visible:outline-none">
                    <span className="num mt-0.5 w-3 shrink-0 text-[13px] text-ink-3">{i + 1}</span>
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-2 text-[13px] leading-snug font-medium text-ink group-hover:text-brand" title={f.title}>{f.title}</span>
                      <span className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-ink-2">
                        <SeverityBadge severity={f.severity} compact />
                        <span className="inline-flex items-center gap-1.5">
                          <Swatch color={catColor(f.category)} shape="dot" />
                          {category(f.category)}
                        </span>
                      </span>
                    </span>
                    <span className="num shrink-0 text-[13px] font-medium text-ink">{f.amount_impact ? inr(f.amount_impact) : "nil"}</span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </Panel>
        </div>
      </div>

      {/* The bridge: from the register's value to what is not in question. */}
      <div id="ov-bridge" className="mb-6">
      <Panel
        title={heroView === "bridge" ? "How much of the register's revenue is in question?" : "When was revenue booked, and where does it not agree?"}
        takeaway={
          heroView === "bridge"
            ? topArea
              ? `${category(topArea.cat)} is the largest area at ${inr(topArea.value)}. At least ${inr(notInQuestion)} of ${inr(timeline.total)} is not in question.`
              : undefined
            : timeline.attention
              ? `${inr(timeline.attention)} of register rows do not agree with the books.`
              : "Every register row agrees with the books."
        }
        meta={
          <span className="flex flex-wrap items-center gap-3">
            {heroView === "months" && <Pills value={onlyBad ? "bad" : "all"} onChange={(v) => setOnlyBad(v === "bad")} options={[{ value: "all", label: "All" }, { value: "bad", label: "Not agreeing" }]} />}
            <Pills value={heroView} onChange={setHeroView} options={[{ value: "bridge", label: "Bridge" }, { value: "months", label: "By month" }]} />
          </span>
        }
      >
        {register.loading && !register.rows.length ? (
          <ChartSkeleton height={330} />
        ) : register.error ? (
          <ErrorNote error={register.error} />
        ) : timeline.data.length === 0 ? (
          <p className="py-16 text-center text-sm text-ink-2">Import the register on the plan below to draw this chart.</p>
        ) : heroView === "bridge" ? (
          <>
            <Bridge steps={bridge} height={340} format={bridgeScale.label} axisFormat={bridgeScale.axis} onSelect={(cat) => cat !== "other" && goTo("findings", `f:category=${cat}`)} />
            <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-ink-2">
              <span className="flex items-center gap-1.5">
                <Swatch color={ink.high} />
                <Term word="misstatement">Potential misstatement</Term>
              </span>
              <span className="flex items-center gap-1.5">
                <Swatch color={ink.good} />
                Confirmed
              </span>
              <span>
                Some findings can overlap, so the last bar is a floor.
                {view.once.merged > 0 && ` ${plural(view.once.merged, "finding")} on an already counted subject were left out, removing ${inr(view.once.removed)} of overlap.`}
              </span>
            </div>
          </>
        ) : (
          <Columns brush data={timeline.data} height={340} format={monthScale.label} axisFormat={monthScale.axis} onSelect={(m) => goTo("register", `month:${m}`)} marker={periodEndMonth ? { after: periodEndMonth, label: "Period end" } : undefined} />
        )}
      </Panel>

      </div>

      <div id="ov-plan" className="grid gap-5 lg:grid-cols-2 xl:grid-cols-[1.2fr_1fr_1fr]">
        <Panel title="Audit plan" meta={`${done} of ${steps.length} done`}>
          <div className="mb-3 flex items-center gap-4">
            <Ring done={done} total={steps.length} size={56} />
            <p className="text-[13px] leading-relaxed text-ink-2">
              {next ? (
                <>
                  Next: <span className="font-medium text-ink">{label(next)}</span>.
                </>
              ) : (
                "Every step has run."
              )}
            </p>
          </div>
          <ol className="thin-scroll max-h-[260px] overflow-y-auto border-t border-line-soft">
            {steps.map((st, i) => {
              const isNext = st.tool === next;
              const isDone = st.status === "done";
              return (
                <li key={st.step} className={cx("group flex min-h-9 items-center gap-3 border-b border-line-soft py-1 pr-1 last:border-0", isNext && "bg-brand-wash/60")}>
                  <span className={cx("ml-1 flex h-6 w-6 shrink-0 items-center justify-center text-xs tabular-nums", isDone ? "text-pass" : isNext ? "font-semibold text-brand" : "text-ink-3")}>{isDone ? <Mark tone="good" size={15} /> : i + 1}</span>
                  <span className={cx("min-w-0 flex-1 text-[13px]", isDone ? "text-ink" : isNext ? "font-medium text-ink" : "text-ink-2")}>{label(st.tool)}</span>
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
        </Panel>

        <Panel title="Recent activity" action={<button onClick={() => goTo("trail")} className="font-medium text-brand hover:underline">Open the trail</button>} flush>
          {trail.loading && !trail.data ? (
            <ListSkeleton rows={4} />
          ) : activity.length === 0 ? (
            <p className="px-5 py-6 text-[13px] text-ink-2">No actions among the latest 300 trail entries; recent entries are reads. The full record is in the trail.</p>
          ) : (
            <ul className="divide-y divide-line-soft">
              {activity.map((e) => (
                <li key={e.trail_seq} className="px-5 py-2.5">
                  <div className="text-[13px] font-medium text-ink">{actionName[e.tool] ?? e.tool.replace(/_/g, " ")}</div>
                  <div className="text-xs text-ink-2">
                    {roleLabel[e.role] ?? e.role}, {when(e.ts)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title={<Term word="snapshot">Snapshot and ledger</Term>} action={integrity && <Status tone={integrity.ok ? "good" : "bad"}>{integrity.ok ? "Verified" : "Failed"}</Status>}>
          <KeyValues
            items={[
              ["Frozen at", `Event ${s.snapshot_seq}`],
              ["Hash", <span className="font-mono text-xs" title={s.snapshot_hash}>{shortHash(s.snapshot_hash, 14)}</span>],
              ["Seed", <span className="font-mono text-xs">{s.seed}</span>],
              // Shown only when the engine reports seed_source.
              ["Sampling", s.seed_source ? s.seed_source === "sealed" ? <Status tone="good">Sealed, chosen by nobody</Status> : <Status tone="warn">Seed chosen by the auditor</Status> : undefined],
              ["Opened", s.opened_at ? when(s.opened_at) : undefined],
              ...(integrity
                ? ([
                    ["Ledger", `${integrity.business_chain?.checked ?? 0} events checked`],
                    ["Trail", `${integrity.trail_chain?.checked ?? 0} entries checked`],
                    ["Snapshot", integrity.snapshot ? (integrity.snapshot.match ? "Unchanged since opening" : "Altered since opening") : undefined],
                    ["First altered", integrity.business_chain?.first_bad_seq ?? integrity.trail_chain?.first_bad_seq],
                  ] as [string, any][])
                : []),
            ]}
          />
          {controls && controls.sent > 0 && (
            <p className="mt-3 text-[13px] text-ink-2">
              {plural(controls.sent, "control request")} for documents that should not exist: {controls.declined} answered correctly
              {controls.supplied > 0 && <span className="font-medium text-fail">, {controls.supplied} fabricated</span>}.
            </p>
          )}
          <div className="mt-4">
            <Button kind="ghost" small busy={busy === "verify_ledger_integrity"} onClick={() => runTool("verify_ledger_integrity")}>
              Verify the ledger
            </Button>
          </div>
        </Panel>
      </div>
      {found.data && Number(found.data.totals?.count ?? 0) > findings.length && <p className="mt-4 text-xs text-ink-2">Figures cover the first {findings.length} of {found.data.totals?.count} findings.</p>}
    </>
  );
}
