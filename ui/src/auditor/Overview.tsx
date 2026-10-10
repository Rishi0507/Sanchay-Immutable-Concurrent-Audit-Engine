import { useMemo, useState } from "react";
import { callTool, shortHash, when } from "../api";
import type { ViewProps } from "../App";
import { Button, Card, ErrorNote, Field, KeyValues, Mark, Pills, Status, cx, inputClass, toast, useAction, useTool } from "../ui";
import { Bridge, BridgeStep, ColumnDatum, Columns, Swatch, ink } from "./charts";
import { ChartSkeleton, FindingLite, MoreBar, dedupe, ListSkeleton, Panel, ReviewProgress, Ring, SeverityBadge, Skeleton, Term, ViewHead, byPriority, catColor, category, family, day, inr, monthKey, monthLabel, monthRange, num, plural, registerFields, scaleFor, sum, useRegisterAll } from "./kit";
import { Figure } from "../Figure";

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
                <span className="block text-[14px] text-ink-2">
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
          <p className="text-[14px] text-ink-2">{ready ? "Opening freezes a snapshot of the client's records." : "Both files are needed before the engagement can open."}</p>
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


// Small line icons for the figures of what the audit covered.
function CoverIcon({ id }: { id: string }) {
  const p = { width: 22, height: 22, viewBox: "0 0 20 20", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (id === "register")
    return (
      <svg {...p}>
        <rect x="3.5" y="3" width="13" height="14" rx="1.5" />
        <path d="M3.5 7.5h13M3.5 12h13M8 7.5V17" />
      </svg>
    );
  if (id === "samples")
    return (
      <svg {...p}>
        <circle cx="9" cy="9" r="5" />
        <path d="M13 13l4 4M6.8 9.2l1.5 1.5 3-3.2" />
      </svg>
    );
  if (id === "findings")
    return (
      <svg {...p}>
        <path d="M10 3l7.5 13h-15z" />
        <path d="M10 8.5v3.5M10 14.2v.1" />
      </svg>
    );
  return (
    <svg {...p}>
      <path d="M4 9a6 6 0 0112 0v2l1.5 3h-15L4 11z" />
      <path d="M8 16.5a2 2 0 004 0" />
    </svg>
  );
}

// What each step does, in a sentence a newcomer can follow. Shown on the
// next-step card, so the button is never a mystery.
const stepWhy: Record<string, string> = {
  import_register: "Brings the client's sales register into the workpaper exactly as they sent it.",
  reconcile_register: "Compares every register row with the books. Every difference becomes a finding.",
  tag_related_parties: "Marks customers linked to the company's owners or officers, including ones the client did not declare.",
  run_detectors: "Runs sixteen checks over every sale, looking for revenue that is fake, misbooked or in the wrong year.",
  select_sales_tod: "Picks 25 to 35 risky invoices to test against their documents, and asks the client for those documents.",
  select_cutoff_tod: "Picks invoices either side of the year end, to test each is booked in the right year.",
  select_credit_note_tod: "Picks credit notes to test, those issued after the year end first.",
  verify_evidence: "Tests the documents the client sent against the books and against each other.",
  check_post_testing_changes: "Looks for anything the client changed in the books after testing began.",
  verify_ledger_integrity: "Recomputes every hash in the ledger, to prove no stored record was altered.",
  draft_findings_memo: "Writes the findings memo for the client's management.",
  export_workpaper: "Produces the Excel workpaper with every sheet of the audit.",
};

// The audit as eight stages, in the order the work runs. Each stage is done
// when every plan step behind it is done, and opens the page where its work is.
const stages: { key: string; label: string; tools: string[]; page: string }[] = [
  { key: "upload", label: "Client uploads", tools: [], page: "overview" },
  { key: "snapshot", label: "Books frozen", tools: ["open_engagement"], page: "trail" },
  { key: "reconcile", label: "Register checked", tools: ["import_register", "reconcile_register", "tag_related_parties"], page: "register" },
  { key: "detect", label: "Patterns searched", tools: ["run_detectors"], page: "findings" },
  { key: "sample", label: "Samples picked", tools: ["select_sales_tod", "select_cutoff_tod", "select_credit_note_tod"], page: "samples" },
  { key: "evidence", label: "Papers tested", tools: ["verify_evidence", "check_post_testing_changes"], page: "samples" },
  { key: "review", label: "Manager review", tools: [], page: "findings" },
  { key: "export", label: "Reports out", tools: ["verify_ledger_integrity", "draft_findings_memo", "export_workpaper"], page: "export" },
];

type StageState = "done" | "current" | "todo";

// The stages as one ruled line across the page. Ticks are drawn in the
// auditor's green ink, one after another, when the page opens.
function Journey({ items, onOpen }: { items: { key: string; label: string; state: StageState; detail: string; page: string }[]; onOpen: (page: string) => void }) {
  return (
    <ol className="grid grid-cols-2 gap-x-2 gap-y-5 sm:grid-cols-4 xl:grid-cols-8" aria-label="Audit stages">
      {items.map((it, i) => (
        <li key={it.key} className="relative min-w-0" aria-current={it.state === "current" ? "step" : undefined}>
          {i < items.length - 1 && (
            <span className="absolute top-[21px] right-[-8px] left-[50px] hidden h-[3px] overflow-hidden rounded-full bg-line-soft xl:block" aria-hidden>
              {it.state === "done" && <span className="rail-fill absolute inset-0 bg-brand" style={{ animationDelay: `${i * 110}ms` }} />}
            </span>
          )}
          <button onClick={() => onOpen(it.page)} className="group relative flex w-full flex-col items-start rounded-xl p-1 text-left focus-visible:outline-none">
            <span
              className={cx(
                "flex h-11 w-11 items-center justify-center rounded-full border-[2.5px] text-[16px] font-bold transition-transform duration-150 group-hover:scale-105",
                it.state === "done" ? "border-brand bg-brand-wash text-brand" : it.state === "current" ? "border-highlight bg-highlight/30 text-ink shadow-[0_0_0_5px_color-mix(in_oklab,var(--color-highlight)_25%,transparent)]" : "border-line bg-paper text-ink-3",
              )}
            >
              {it.state === "done" ? (
                <span style={{ animationDelay: `${i * 110}ms` }} className="contents">
                  <Mark tone="good" size={22} draw />
                </span>
              ) : (
                i + 1
              )}
            </span>
            <span className={cx("mt-2.5 text-[15px] leading-tight font-bold group-hover:text-brand", it.state === "todo" ? "text-ink-3" : "text-ink")}>{it.label}</span>
            <span className={cx("mt-0.5 text-[13.5px]", it.state === "current" ? "font-semibold text-wait" : "text-ink-2")}>{it.detail}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

// A circle drawn round a figure in red pen, the way an auditor marks the
// number that matters. It is drawn once, when the page opens.
function PenCircle() {
  return (
    <svg className="pointer-events-none absolute -inset-x-5 -inset-y-3 h-[calc(100%+1.5rem)] w-[calc(100%+2.5rem)] text-fail" viewBox="0 0 300 100" preserveAspectRatio="none" fill="none" aria-hidden>
      <path d="M48 14C120 2 262 4 290 38c22 28-60 58-170 56C40 92 4 74 10 46 15 24 60 12 120 9" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" pathLength={1} className="ink-draw" style={{ animationDelay: "0.35s", animationDuration: "0.8s" }} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export default function Overview({ pulse, goTo, engagementId, onEngagement, identity }: ViewProps) {
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
  const manager = identity.role === "audit_manager";

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
              { key: "clean", label: "Agrees with the books", value: b.clean, color: "var(--color-agree)" },
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
        <Skeleton className="h-10 w-1/3" />
        <Skeleton className="h-64 rounded-2xl" />
        <div className="grid gap-4 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
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
      detail = findings.length ? `${reviewed} of ${findings.length} decided` : "Nothing yet";
    } else {
      const n = st.tools.filter(stepDone).length;
      isDone = st.tools.length > 0 && n === st.tools.length;
      detail = st.key === "evidence" && pending ? `${pending} papers awaited` : st.tools.length > 1 && !isDone ? `${n} of ${st.tools.length} steps` : isDone ? "Done" : "To do";
    }
    let state: StageState = isDone ? "done" : "todo";
    if (!isDone && !currentSet) {
      state = "current";
      currentSet = true;
    }
    return { key: st.key, label: st.label, state, detail, page: st.page };
  });

  // What the audit covered, as four figures that each open their page.
  const bySheet = (s.counts?.samples_by_sheet ?? {}) as Record<string, number>;
  const sampled = Object.values(bySheet).reduce((a, b) => a + Number(b || 0), 0);
  const medium = findings.filter((f) => f.severity === "Medium").length;
  const low = findings.filter((f) => f.severity === "Low").length;
  const covered: { label: string; value: string | number; note: string; bad?: boolean; icon: string; onClick: () => void }[] = [
    { label: "Register rows checked", icon: "register", value: register.loading && !register.rows.length ? "…" : register.rows.length.toLocaleString("en-IN"), note: "Each one compared with the books", onClick: () => goTo("register") },
    { label: "Invoices tested", icon: "samples", value: sampled, note: `${bySheet.sales_tod ?? 0} sales, ${bySheet.cutoff_tod ?? 0} year-end, ${bySheet.credit_note_tod ?? 0} credit notes`, onClick: () => goTo("samples") },
    { label: "Problems found", icon: "findings", value: findings.length, note: `${view.high.length} high, ${medium} medium, ${low} low severity`, bad: view.high.length > 0, onClick: () => goTo("findings") },
    {
      label: "Trap requests",
      icon: "trap",
      value: controls?.sent ?? 0,
      note: !controls?.sent ? "Requests for papers that should not exist. None sent yet." : controls.supplied > 0 ? `${controls.supplied} answered with a made-up document` : "Every one answered honestly",
      bad: !!controls && controls.supplied > 0,
      onClick: () => goTo("samples"),
    },
  ];

  const total = timeline.total;
  const exposure = view.exposure;
  const confirmedValue = Math.min(view.confirmedValue, exposure);
  const notInQuestion = Math.max(0, total - exposure);
  const share = total ? (exposure / total) * 100 : 0;
  const bridgeScale = scaleFor(timeline.total);
  const monthScale = scaleFor(timeline.max);
  const topCats = view.byCategory.slice(0, 6);
  const maxCat = Math.max(1, ...topCats.map((c) => c.value));

  // The verdict in words, under the figure.
  const verdict = s.signed_off
    ? `Signed off. ${plural(view.confirmed.length, "finding")} confirmed by the manager.`
    : findings.length === 0
      ? "No problems found yet. Findings appear here as the checks run."
      : `${plural(view.open.length, "finding")} point at it, ${view.high.length} of them high severity. ${view.confirmed.length ? `The manager has confirmed ${inr(view.confirmedValue)} so far.` : "The audit manager has not confirmed any yet."}`;

  // The one thing to do next, for this person.
  const awaiting = view.awaiting.length;
  const nextCard = s.signed_off
    ? { title: "The audit is signed off", body: "Every finding has a decision. The reports are ready on the Export page.", action: { label: "Open the reports", run: () => goTo("export") } }
    : next && runnable.has(next)
      ? { title: label(next), body: stepWhy[next] ?? "", action: { label: "Run this step", run: () => runTool(next), busy: busy === next } }
      : awaiting > 0
        ? manager
          ? { title: `Review ${plural(awaiting, "finding")}`, body: "Every step of the audit has run. Each finding now needs your decision: confirm it, reject it or ask for more.", action: { label: "Start reviewing", run: () => goTo("findings", "f:status=proposed") } }
          : { title: "Hand over to the manager", body: `Every step has run. ${plural(awaiting, "finding")} now wait for the audit manager's decision.`, action: { label: "See the findings", run: () => goTo("findings") } }
        : { title: "Export the reports", body: "Every finding has a decision. Produce the memo, the workpaper and the summary.", action: { label: "Open the reports", run: () => goTo("export") } };

  return (
    <>
      <ViewHead eyebrow={`Revenue audit, ${day(s.period_start)} to ${day(s.period_end)}`} title="Overview" />

      {/* The verdict, on a page of ledger paper. */}
      <section className="attach mb-6 grid overflow-hidden rounded-2xl border border-line shadow-[0_1px_0_var(--color-line-soft),0_18px_40px_-28px_rgba(12,58,43,0.35)] xl:grid-cols-[minmax(0,1fr)_380px]" aria-label="The answer">
        <div className="ledger-paper py-7 pr-6 pl-[72px] sm:pr-10">
          <p className="text-[15px] font-semibold text-ink-2">{s.signed_off ? "Misstatement confirmed" : "Revenue in question"}</p>
          <div className="mt-2 flex flex-wrap items-end gap-x-5 gap-y-2">
            <span className="relative inline-block">
              {exposure > 0 && <PenCircle />}
              <span className={cx("display relative block text-[64px] leading-[0.95] sm:text-[88px]", exposure > 0 ? "text-fail" : "text-ink")} style={{ fontVariationSettings: '"wdth" 76', fontWeight: 720 }}>
                <Figure value={inr(s.signed_off ? view.confirmedValue : exposure)} />
              </span>
            </span>
            <span className="mb-2 text-[20px] leading-snug font-semibold text-ink">
              {total ? (
                <>
                  of <span className="highlight">{inr(total)}</span> in the client's register
                </>
              ) : (
                "of the client's register"
              )}
            </span>
          </div>
          <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-ink-2">{verdict}</p>

          {/* The register as one strip: what is in question, and what is not. */}
          <div className="mt-6">
            {total ? (
              <>
                <div className="flex h-5 gap-[3px] overflow-hidden rounded-full" role="img" aria-label={`${inr(exposure)} of ${inr(total)} is in question, ${share.toFixed(1)} percent`}>
                  <div className="grow-x h-full rounded-l-full bg-[color-mix(in_oklab,var(--color-brand)_32%,var(--color-paper))]" style={{ width: `${100 - share}%` }} title={`${inr(notInQuestion)} not in question`} />
                  {exposure - confirmedValue > 0 && <div className="grow-x h-full bg-fail" style={{ width: `${Math.max(0.8, ((exposure - confirmedValue) / total) * 100)}%`, animationDelay: "0.2s" }} title={`${inr(exposure - confirmedValue)} awaiting the manager`} />}
                  {confirmedValue > 0 && <div className="grow-x h-full rounded-r-full bg-ink" style={{ width: `${Math.max(0.8, (confirmedValue / total) * 100)}%`, animationDelay: "0.3s" }} title={`${inr(confirmedValue)} confirmed`} />}
                </div>
                <div className="mt-2.5 flex flex-wrap justify-between gap-x-6 gap-y-1 text-[14px]">
                  <span className="inline-flex items-center gap-2 text-ink-2">
                    <span className="h-3 w-3 rounded-full bg-[color-mix(in_oklab,var(--color-brand)_32%,var(--color-paper))]" />
                    <span>
                      <span className="font-bold text-ink">{inr(notInQuestion)}</span> not in question
                    </span>
                  </span>
                  <span className="inline-flex items-center gap-2 text-ink-2">
                    <span className="h-3 w-3 rounded-full bg-fail" />
                    <span>
                      <span className="font-bold text-fail">{share.toFixed(1)}%</span> in question
                      {confirmedValue > 0 && <>, {inr(confirmedValue)} confirmed</>}
                    </span>
                  </span>
                </div>
              </>
            ) : register.loading ? (
              <Skeleton className="h-5 rounded-full" />
            ) : null}
          </div>
        </div>

        {/* What to do next: one card, one button. */}
        <div className="flex flex-col justify-between gap-6 bg-spine p-7 text-spine-ink">
          <div>
            <div className="flex items-center justify-between gap-3 text-[14px] font-semibold text-spine-ink-2">
              <span>What to do next</span>
              <span className="num">
                {done} of {steps.length} steps done
              </span>
            </div>
            <div className="mt-2 flex h-1.5 gap-0.5" aria-hidden>
              {steps.map((st, i) => (
                <span key={st.step ?? i} className={cx("flex-1 rounded-full", st.status === "done" ? "bg-highlight" : st.tool === next ? "bg-white/45" : "bg-white/15")} />
              ))}
            </div>
            <h2 className="display mt-6 text-[30px] leading-[1.05]">{nextCard.title}</h2>
            <p className="mt-2.5 text-[15.5px] leading-relaxed text-spine-ink-2">{nextCard.body}</p>
          </div>
          <button
            onClick={nextCard.action.run}
            disabled={"busy" in nextCard.action && !!nextCard.action.busy}
            className="group inline-flex h-13 items-center justify-between gap-3 rounded-xl bg-highlight px-5 text-[16px] font-bold text-spine shadow-[inset_0_-3px_0_rgba(0,0,0,0.15)] transition-transform duration-150 hover:-translate-y-0.5 active:translate-y-0 disabled:opacity-70"
          >
            {"busy" in nextCard.action && nextCard.action.busy ? (
              <span className="inline-flex items-center gap-2.5">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-spine/30 border-t-spine" />
                Running
              </span>
            ) : (
              nextCard.action.label
            )}
            <svg className="transition-transform duration-150 group-hover:translate-x-1" width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 8h9.5M8.5 3.5L13 8l-4.5 4.5" />
            </svg>
          </button>
        </div>
      </section>

      {/* The audit's journey, stage by stage. */}
      <section id="ov-progress" className="mb-6 rounded-2xl border border-line bg-paper px-6 pt-5 pb-6" aria-label="Audit progress">
        <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[18px] font-bold text-ink">Where the audit has got to</h2>
          <span className="text-[14px] text-ink-2">Select a stage to open its page</span>
        </div>
        <Journey items={rail} onOpen={goTo} />
        {findings.length > 0 && (
          <div className="mt-6 border-t border-line-soft pt-5">
            <ReviewProgress findings={findings} />
          </div>
        )}
      </section>

      {/* What the audit covered. */}
      <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {covered.map((c) => (
          <button
            key={c.label}
            onClick={c.onClick}
            className="group flex items-start gap-4 rounded-2xl border border-line bg-paper p-5 text-left transition-[border-color,box-shadow,transform] duration-150 hover:-translate-y-0.5 hover:border-brand/50 hover:shadow-[0_12px_28px_rgba(12,58,43,0.12)] focus-visible:border-brand focus-visible:outline-none"
          >
            <span className={cx("flex h-11 w-11 shrink-0 items-center justify-center rounded-xl", c.bad ? "bg-fail-wash text-fail" : "bg-brand-wash text-brand")}>
              <CoverIcon id={c.icon} />
            </span>
            <span className="min-w-0">
              <span className="block text-[14px] font-semibold text-ink-2">{c.label}</span>
              <span className={cx("amount mt-0.5 block text-[38px] leading-[1.05]", c.bad ? "text-fail" : "text-ink")}>
                <Figure value={c.value} />
              </span>
              <span className={cx("mt-1 block text-[13.5px] leading-snug", c.bad ? "font-semibold text-fail" : "text-ink-2")}>{c.note}</span>
            </span>
          </button>
        ))}
      </div>

      <div className="mb-6 grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div id="ov-top">
          <Panel title="Look at these first" takeaway="Highest severity first, then the largest amount." action={<button onClick={() => goTo("findings")} className="font-semibold text-brand hover:underline">All findings</button>} flush>
            {found.loading && !found.data ? (
              <ListSkeleton rows={5} />
            ) : view.top.length === 0 ? (
              <p className="px-5 py-8 text-[15px] text-ink-2">Nothing to look at yet. Findings appear here once the checks have run.</p>
            ) : (
              <ol className="divide-y divide-line-soft">
                {view.top.map((f, i) => (
                  <li key={f.finding_id}>
                    <button onClick={() => goTo("findings", f.finding_id)} className="group flex w-full items-start gap-4 px-5 py-3.5 text-left transition-colors hover:bg-wash focus-visible:bg-wash focus-visible:outline-none">
                      <span className="amount mt-0.5 w-5 shrink-0 text-[20px] leading-none text-ink-3">{i + 1}</span>
                      <span className="min-w-0 flex-1">
                        <span className="line-clamp-2 text-[15px] leading-snug font-semibold text-ink group-hover:text-brand" title={f.title}>{f.title}</span>
                        <span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[14px] text-ink-2">
                          <SeverityBadge severity={f.severity} compact />
                          <span className="inline-flex items-center gap-1.5">
                            <Swatch color={catColor(f.category)} shape="dot" />
                            {category(f.category)}
                          </span>
                        </span>
                      </span>
                      <span className="amount shrink-0 text-[19px] text-ink">{f.amount_impact ? inr(f.amount_impact) : "nil"}</span>
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </Panel>
        </div>

        <div id="ov-bridge">
          <Panel title="Where the money is in question" takeaway={topCats[0] ? `${category(topCats[0].cat)} carries the most, at ${inr(topCats[0].value)}.` : "Each kind of problem, by the amount it puts in question."} flush>
            {found.loading && !found.data ? (
              <ListSkeleton rows={6} />
            ) : topCats.length === 0 ? (
              <p className="px-5 py-8 text-[15px] text-ink-2">No amounts in question yet.</p>
            ) : (
              <ul className="space-y-1 px-3 py-3">
                {topCats.map((c, i) => {
                  const fam = family(c.cat);
                  return (
                    <li key={c.cat}>
                      <button onClick={() => goTo("findings", `f:category=${c.cat}`)} className="group w-full rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-wash focus-visible:bg-wash focus-visible:outline-none" title={`${fam.label}. Open these findings.`}>
                        <span className="flex items-baseline justify-between gap-3">
                          <span className="min-w-0 truncate text-[15px] font-semibold text-ink group-hover:text-brand">{category(c.cat)}</span>
                          <span className="amount shrink-0 text-[18px] text-ink">{inr(c.value)}</span>
                        </span>
                        <span className="mt-1.5 flex items-center gap-3">
                          <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-wash">
                            <span className="grow-x block h-full rounded-full" style={{ width: `${(c.value / maxCat) * 100}%`, background: fam.color, animationDelay: `${i * 60}ms` }} />
                          </span>
                          <span className="w-24 shrink-0 text-right text-[14px] text-ink-2">{plural(c.list.length, "finding")}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
                {view.byCategory.length > topCats.length && <li className="px-3 pt-1 text-[14px] text-ink-2">and {plural(view.byCategory.length - topCats.length, "smaller area")}</li>}
              </ul>
            )}
          </Panel>
        </div>
      </div>

      <MoreBar group="ov" title="Behind the scenes" items="The register as a chart, the audit plan step by step, recent activity, and the frozen books." />
      <div data-more="ov" className="mb-6">
        <Panel
          title={heroView === "bridge" ? "From the register's value to what is not in question" : "When revenue was booked, and where it does not agree"}
          takeaway={
            heroView === "bridge"
              ? `At least ${inr(notInQuestion)} of ${inr(total)} is not in question.`
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
            <p className="py-16 text-center text-[15px] text-ink-2">Import the register to draw this chart.</p>
          ) : heroView === "bridge" ? (
            <>
              <Bridge steps={bridge} height={340} format={bridgeScale.label} axisFormat={bridgeScale.axis} onSelect={(cat) => cat !== "other" && goTo("findings", `f:category=${cat}`)} />
              <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-[14px] text-ink-2">
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
      <div id="ov-plan" data-more="ov" className="grid gap-5 lg:grid-cols-2 xl:grid-cols-[1.2fr_1fr_1fr]">

        <Panel title="Audit plan" meta={`${done} of ${steps.length} done`}>
          <div className="mb-3 flex items-center gap-4">
            <Ring done={done} total={steps.length} size={56} />
            <p className="text-[14px] leading-relaxed text-ink-2">
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
                  <span className={cx("min-w-0 flex-1 text-[14px]", isDone ? "text-ink" : isNext ? "font-medium text-ink" : "text-ink-2")}>{label(st.tool)}</span>
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
            <p className="px-5 py-6 text-[14px] text-ink-2">No actions among the latest 300 trail entries; recent entries are reads. The full record is in the trail.</p>
          ) : (
            <ul className="divide-y divide-line-soft">
              {activity.map((e) => (
                <li key={e.trail_seq} className="px-5 py-2.5">
                  <div className="text-[14px] font-medium text-ink">{actionName[e.tool] ?? e.tool.replace(/_/g, " ")}</div>
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
            <p className="mt-3 text-[14px] text-ink-2">
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
