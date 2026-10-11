import { useEffect, useMemo, useState } from "react";
import { callTool, money, when } from "../api";
import type { ViewProps } from "../App";
import { Button, Card, Chip, Column, Drawer, Empty, ErrorNote, KeyValues, Mark, Pills, Section, Status, Table, cx, inputClass, toast, toneFor, useAction, useTool } from "../ui";
import { Stamp } from "../Stamp";
import { Ranked, RiskMap, Swatch, ink } from "./charts";
import { EmailAction, day, FindingLite, ListSkeleton, MoreBar, PageBrief, dedupe, Panel, SearchBox, Severity, SeverityBadge, SeverityIcon, Tally, Term, ViewHead, byPriority, catColor, category, findingStatus, inr, plural, sevFill, severities, sum } from "./kit";

interface Finding extends FindingLite {
  explanation?: string;
  proposed_adjustment?: { account: string; debit: number; credit: number; narration?: string }[];
  standard_refs?: string[];
  lineage?: Record<string, any>;
  decision_note?: string;
  // The ledger events the finding rests on, as explain_finding returns them.
  documents?: { seq: number; event_type: string; reference?: string; business_date?: string; recorded_by?: string; hash?: string }[];
}

// "InvoiceIssued" reads "Invoice issued".
const eventName = (t: string) => t.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase()).replace(/ (\w)/g, (m) => m.toLowerCase());

const statusTone = (s: string) => toneFor(s);

interface EvidenceSample {
  sample_id: string;
  sheet: string;
  documents: { document_type: string; status: string }[];
}

interface LinkedSample {
  sample_id: string;
  sheet: string;
  invoice_no?: string;
  credit_note_no?: string;
  subject_id: string;
  taxable_value?: number;
  tests?: Record<string, string>;
}

// Documents in the order a sale produces them.
const docOrder = ["invoice", "eway_bill", "lr_copy", "credit_note", "sales_return"];
const docName: Record<string, string> = { invoice: "Invoice", eway_bill: "E-way bill", lr_copy: "LR copy", credit_note: "Credit note", sales_return: "Sales return" };
const sheetName: Record<string, string> = { sales_tod: "Sales", cutoff_tod: "Cut-off", credit_note_tod: "Credit notes" };

// The first sentence, for the one-line reason.
const firstSentence = (t?: string) => {
  if (!t) return "";
  const m = t.match(/^(.+?[.!?])(\s|$)/);
  return m ? m[1] : t;
};

// Each linked sample's documents as a chain: received and verified, received,
// or still awaited; then the sample's own evidence test.
function EvidenceChain({ docs, test }: { docs: { document_type: string; status: string }[]; test?: string }) {
  const sorted = [...docs].sort((a, b) => docOrder.indexOf(a.document_type) - docOrder.indexOf(b.document_type));
  const mark = (st: string) =>
    st === "verified" ? { sym: "✓", cls: "text-pass", word: "verified" } : st === "received" ? { sym: "✓", cls: "text-ink-2", word: "received, not yet tested" } : { sym: "✗", cls: "text-fail", word: "not received" };
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[14px]">
      {sorted.map((d, i) => {
        const m = mark(d.status);
        return (
          <span key={d.document_type + i} className="inline-flex items-center gap-1.5">
            {i > 0 && (
              <span className="text-ink-3" aria-hidden>
                →
              </span>
            )}
            <span className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-0.5" title={`${docName[d.document_type] ?? d.document_type}: ${m.word}`}>
              <span className="text-ink">{docName[d.document_type] ?? d.document_type.replace(/_/g, " ")}</span>
              <span className={cx("font-semibold", m.cls)} aria-label={m.word}>
                {m.sym}
              </span>
            </span>
          </span>
        );
      })}
      {test && (
        <span className="ml-1 inline-flex items-center gap-1.5">
          <span className="text-ink-3" aria-hidden>
            =
          </span>
          <Status tone={toneFor(test)}>{test === "Pass" ? "Evidence passes" : `Evidence: ${test.toLowerCase()}`}</Status>
        </span>
      )}
    </div>
  );
}

function Detail({ id, manager, onDecided, onNext, goTo }: { id: string; manager: boolean; onDecided: () => void; onNext?: () => void; goTo: ViewProps["goTo"] }) {
  const { data, error, loading, reload } = useTool<Finding>("explain_finding", { finding_id: id }, [id]);
  const [note, setNote] = useState("");
  const [more, setMore] = useState(false);
  // The stamp the manager's decision leaves on the finding, shown for a moment.
  const [stamp, setStamp] = useState<string | null>(null);
  useEffect(() => setStamp(null), [id]);
  const [linked, setLinked] = useState<{ evidence: Map<string, EvidenceSample>; samples: Map<string, LinkedSample> } | null>(null);
  const { busy, run } = useAction();
  const sampleIds = data?.sample_ids ?? [];
  const sampleKey = sampleIds.join(",");

  // Evidence and sample details only for the samples this finding touches.
  useEffect(() => {
    if (!sampleKey) {
      setLinked(null);
      return;
    }
    let live = true;
    (async () => {
      try {
        const ev = await callTool<{ samples: EvidenceSample[] }>("get_evidence_status", {});
        const evidence = new Map<string, EvidenceSample>();
        for (const s of ev.samples ?? []) if (sampleKey.split(",").includes(s.sample_id)) evidence.set(s.sample_id, s);
        const sheets = [...new Set([...evidence.values()].map((s) => s.sheet))];
        const samples = new Map<string, LinkedSample>();
        for (const sheet of sheets) {
          const r = await callTool<{ samples: LinkedSample[] }>("get_samples", { sheet });
          for (const s of r.samples ?? []) if (evidence.has(s.sample_id)) samples.set(s.sample_id, { ...s, sheet });
        }
        if (live) setLinked({ evidence, samples });
      } catch {
        if (live) setLinked({ evidence: new Map(), samples: new Map() });
      }
    })();
    return () => {
      live = false;
    };
  }, [sampleKey]);

  const decide = (decision: string) =>
    run(decision, async () => {
      await callTool("confirm_finding", { finding_id: id, decision, note });
      toast(`Finding ${(findingStatus[decision] ?? decision).toLowerCase()}.`);
      setNote("");
      setStamp(decision);
      reload();
      onDecided();
      // Move on to the next finding, once the stamp has been seen.
      if (onNext) window.setTimeout(onNext, 1100);
    });

  // The manager decides from the keyboard: C confirms, R rejects, I asks for more.
  useEffect(() => {
    if (!manager || !data) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, select") || e.ctrlKey || e.metaKey || e.altKey || busy) return;
      const decision = { c: "confirmed", r: "rejected", i: "needs_info" }[e.key.toLowerCase()];
      if (decision) {
        e.preventDefault();
        decide(decision);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manager, data, busy, note, id]);

  if (loading && !data) return <ListSkeleton rows={7} />;
  if (error) return <ErrorNote error={error} onRetry={reload} />;
  if (!data) return null;
  const f = data;
  const lineage = f.lineage ?? {};
  const confirmed = f.status === "confirmed";

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <SeverityBadge severity={f.severity} />
        <span className="inline-flex items-center gap-1.5 text-[14px] text-ink-2">
          <Swatch color={catColor(f.category)} shape="dot" />
          {category(f.category)}
        </span>
        <span className="ml-auto">
          <Status tone={statusTone(f.status)}>{findingStatus[f.status] ?? f.status}</Status>
        </span>
      </div>

      {/* One line: why it was raised. */}
      <p className="mb-5 text-[15px] leading-relaxed text-ink">{firstSentence(f.reason ?? f.explanation)}</p>

      {/* The money, and whether it is confirmed or only flagged. */}
      <div className="mb-6 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line">
        <div className="bg-paper px-4 py-3.5">
          <div className="text-xs font-semibold text-ink-2">
            <Term word="misstatement">{confirmed ? "Confirmed misstatement" : "Potential misstatement"}</Term>
          </div>
          <div className={cx("amount mt-1 text-[32px] leading-9", confirmed ? "text-pass" : f.amount_impact ? "text-fail" : "text-ink")}>{f.amount_impact ? `₹ ${money(f.amount_impact)}` : "No direct amount"}</div>
          <div className="mt-0.5 text-xs text-ink-3">{confirmed ? "Confirmed by the manager." : "Flagged by the detector, not yet confirmed."}</div>
        </div>
        <div className="bg-paper px-4 py-3">
          <div className="text-xs font-medium text-ink-2">Effect on period revenue</div>
          <div className="mt-1 text-sm font-medium text-ink">{f.period_effect && f.period_effect !== "None" ? f.period_effect : "None stated"}</div>
          <div className="mt-0.5 text-xs text-ink-3">{f.subject?.label ?? f.subject?.id}</div>
        </div>
      </div>

      {/* Evidence chain and linked samples. */}
      <Section title={sampleIds.length ? `Evidence for ${plural(sampleIds.length, "linked sample")}` : "Evidence"}>
        {!sampleIds.length ? (
          <p className="text-[14px] text-ink-2">This finding comes from the records themselves, not from a sample, so no documents were requested. The records it rests on are below.</p>
        ) : !linked ? (
          <ListSkeleton rows={Math.min(3, sampleIds.length)} />
        ) : (
          <ul className="space-y-3">
            {sampleIds.map((sid) => {
              const ev = linked.evidence.get(sid);
              const smp = linked.samples.get(sid);
              const sheet = ev?.sheet ?? smp?.sheet;
              return (
                <li key={sid} className="rounded-md border border-line-soft px-3 py-2.5">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <button
                      onClick={() => sheet && goTo("samples", `${sheet}:${sid}`)}
                      disabled={!sheet}
                      className="text-[14px] font-medium text-brand hover:underline disabled:text-ink-2 disabled:no-underline"
                      title="Open this sample"
                    >
                      {smp?.credit_note_no ?? smp?.invoice_no ?? smp?.subject_id ?? sid}
                    </button>
                    <span className="text-xs text-ink-2">
                      {sheet ? `${sheetName[sheet] ?? sheet} sheet` : ""}
                      {smp?.taxable_value !== undefined ? `, ₹ ${money(smp.taxable_value)}` : ""}
                    </span>
                  </div>
                  {ev?.documents?.length ? <EvidenceChain docs={ev.documents} test={smp?.tests?.Evidence} /> : <p className="text-xs text-ink-2">No documents requested for this sample.</p>}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      {/* The ledger records the finding rests on, oldest first, each with its seal. */}
      {(f.documents?.length ?? 0) > 0 && (
        <Section title={`The records behind it (${f.documents!.length})`}>
          <ol className="relative ml-1.5 space-y-3 border-l-2 border-line pl-5">
            {f.documents!.slice(0, 12).map((d) => (
              <li key={d.seq} className="relative">
                <span className="absolute top-1.5 -left-[27px] h-3 w-3 rounded-full border-2 border-brand bg-paper" aria-hidden />
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[14.5px] font-semibold text-ink">{eventName(d.event_type)}</span>
                  <span className="num shrink-0 text-[12.5px] text-ink-3">Event {d.seq.toLocaleString("en-IN")}</span>
                </div>
                <div className="text-[13.5px] text-ink-2">{[d.reference, d.business_date ? day(d.business_date) : "", d.recorded_by ? `recorded by ${d.recorded_by}` : ""].filter(Boolean).join(", ")}</div>
                {d.hash && (
                  <div className="font-mono text-[11.5px] text-ink-3" title={d.hash}>
                    sealed {d.hash.slice(0, 16)}…
                  </div>
                )}
              </li>
            ))}
          </ol>
          {f.documents!.length > 12 && <p className="mt-2 text-[13px] text-ink-2">The first 12 of {f.documents!.length} are shown. Every one is under More detail.</p>}
        </Section>
      )}

      {/* The decision. */}
      <div className="relative">
      {stamp && (
        <Stamp
          word={stamp === "confirmed" ? "CONFIRMED" : stamp === "rejected" ? "REJECTED" : "MORE INFO"}
          tone={stamp === "confirmed" ? "fail" : stamp === "rejected" ? "pass" : "wait"}
          small
          className="stamp -top-2 right-2 z-10"
        />
      )}
      <Section title="Decision">
        {f.decided_by && (
          <div className="mb-3">
            <KeyValues items={[["By", f.decided_by], ["At", when(f.decided_at)], ["Note", f.decision_note]]} />
          </div>
        )}
        {manager ? (
          <>
            <textarea className={inputClass + " mb-3 h-auto min-h-20 py-2"} placeholder="Reason for the decision (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
            <div className="grid gap-2 sm:grid-cols-3">
              {(
                [
                  { decision: "confirmed", key: "C", label: "Confirm", hint: "It is a misstatement", tone: "good", cls: "border-brand bg-brand text-on-brand hover:bg-brand-deep" },
                  { decision: "rejected", key: "R", label: "Reject", hint: "Not a problem", tone: "bad", cls: "border-fail/50 bg-paper text-fail hover:bg-fail-wash" },
                  { decision: "needs_info", key: "I", label: "Ask for more", hint: "Need more information", tone: "warn", cls: "border-line bg-paper text-ink hover:border-highlight hover:bg-wait-wash" },
                ] as const
              ).map((d) => (
                <button
                  key={d.decision}
                  onClick={() => decide(d.decision)}
                  disabled={!!busy}
                  className={cx("group flex flex-col items-start rounded-xl border-2 px-3.5 py-3 text-left transition-[background-color,border-color,transform] duration-150 hover:-translate-y-0.5 disabled:opacity-60", d.cls, f.status === d.decision && "ring-[3px] ring-highlight/60")}
                >
                  <span className="flex w-full items-center justify-between">
                    <span className="inline-flex items-center gap-2 text-[16px] font-bold">
                      {busy === d.decision ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" /> : <Mark tone={d.tone} size={18} />}
                      {d.label}
                    </span>
                    <kbd className="!bg-transparent !text-current opacity-70">{d.key}</kbd>
                  </span>
                  <span className="mt-0.5 text-[13px] opacity-80">{d.hint}</span>
                </button>
              ))}
            </div>
            {onNext && <p className="mt-2 text-[13px] text-ink-2">After a decision, the next finding opens by itself.</p>}
          </>
        ) : (
          <div className="flex items-start gap-3 rounded-xl border border-line bg-wash px-4 py-3">
            <span className="mt-0.5 text-wait">
              <Mark tone={f.status === "confirmed" ? "good" : f.status === "rejected" ? "bad" : "warn"} size={18} />
            </span>
            <span className="text-[14px] text-ink-2">
              <span className="block font-semibold text-ink">{f.status === "proposed" ? "Waiting for the audit manager" : findingStatus[f.status] ?? f.status}</span>
              Only the audit manager can confirm or reject a finding, so the agent never decides on its own conclusions.
            </span>
          </div>
        )}
      </Section>
      </div>

      <button onClick={() => setMore((m) => !m)} aria-expanded={more} className="mb-4 text-[14px] font-medium text-brand hover:underline">
        {more ? "Hide detail" : "More detail: full reasoning, adjusting entry and lineage"}
      </button>
      {more && (
        <div className="view">
          {f.explanation && f.explanation !== f.reason && (
            <Section title="Full reasoning">
              <p className="text-sm leading-relaxed text-ink">{f.explanation}</p>
            </Section>
          )}
          <Section title="What it concerns">
            <KeyValues
              items={[
                ["Subject", f.subject?.label ?? f.subject?.id],
                ["Detector", `${f.detector_id}${f.subtype ? ", " + f.subtype.replace(/_/g, " ").toLowerCase() : ""}`],
                ["Raised", f.created_at ? when(f.created_at) : undefined],
                ["Reference", <span className="font-mono text-xs">{f.finding_id}</span>],
              ]}
            />
          </Section>
          {(f.proposed_adjustment?.length ?? 0) > 0 && (
            <Section title="Proposed adjusting entry">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-ink-2">
                    <th className="pb-1 font-medium">Account</th>
                    <th className="pb-1 text-right font-medium">Debit</th>
                    <th className="pb-1 text-right font-medium">Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {f.proposed_adjustment!.map((l, i) => (
                    <tr key={i} className="border-t border-line-soft">
                      <td className="py-1.5 text-ink">{l.account}</td>
                      <td className="num py-1.5 text-right">{l.debit ? money(l.debit) : ""}</td>
                      <td className="num py-1.5 text-right">{l.credit ? money(l.credit) : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          )}
          <Section title="Lineage">
            <KeyValues
              items={[
                ["Rule", lineage.rule_id],
                ["Events", lineage.event_seqs?.length ? lineage.event_seqs.join(", ") : undefined],
                ["Documents", lineage.document_ids?.length ? <span className="font-mono text-xs">{lineage.document_ids.join(", ")}</span> : undefined],
                ["Register rows", lineage.register_rows?.length ? lineage.register_rows.join(", ") : undefined],
                ["Evidence", lineage.evidence_hashes?.length ? `${lineage.evidence_hashes.length} file${lineage.evidence_hashes.length === 1 ? "" : "s"}` : undefined],
                ...Object.entries(lineage.values ?? {}).map(([k, v]) => [k.replace(/_/g, " "), String(v)] as [string, string]),
                ...Object.entries(lineage.thresholds ?? {}).map(([k, v]) => [`${k.replace(/_/g, " ")} (threshold)`, String(v)] as [string, string]),
              ]}
            />
          </Section>
          {(f.standard_refs?.length ?? 0) > 0 && (
            <Section title="Basis">
              <div className="flex flex-wrap gap-1.5">
                {f.standard_refs!.map((r) => (
                  <Chip key={r}>{r}</Chip>
                ))}
              </div>
            </Section>
          )}
        </div>
      )}
    </>
  );
}

const sevRule: Record<Severity, string> = { High: "before:bg-fail", Medium: "before:bg-wait", Low: "before:bg-ink-3" };

// One finding as a card: the essentials up front, the reasoning one click away.
function FindingCard({ f, selected, onOpen }: { f: FindingLite; selected: boolean; onOpen: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <article
      className={cx(
        "relative flex flex-col overflow-hidden rounded-lg border bg-paper pl-4 transition-colors duration-150 before:absolute before:inset-y-0 before:left-0 before:w-[3px]",
        sevRule[f.severity],
        selected ? "border-brand" : "border-line hover:border-ink-3",
      )}
    >
      <button onClick={onOpen} className="flex flex-1 flex-col px-4 pt-3.5 pb-3 text-left focus-visible:outline-none" aria-label={`Open ${f.title}`}>
        <div className="flex items-start justify-between gap-4">
          <span className="text-sm leading-snug font-medium text-ink">{f.title}</span>
          <span className="shrink-0 text-right">
            <span className={cx("num block text-[15px] font-medium", f.status === "confirmed" ? "text-pass" : "text-ink")}>{f.amount_impact ? inr(f.amount_impact) : "—"}</span>
            <span className="block text-[12px] text-ink-3">{f.amount_impact ? (f.status === "confirmed" ? "confirmed" : "potential") : "no amount"}</span>
          </span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-ink-2">
          <SeverityBadge severity={f.severity} compact />
          <span className="inline-flex items-center gap-1.5">
            <Swatch color={catColor(f.category)} shape="dot" />
            {category(f.category)}
          </span>
          {f.subject?.label && <span className="max-w-48 truncate" title={f.subject.label}>{f.subject.label}</span>}
          {(f.sample_ids?.length ?? 0) > 0 && <span>{plural(f.sample_ids!.length, "sample")}</span>}
        </div>
      </button>
      <div className="flex items-center justify-between gap-3 border-t border-line-soft px-4 py-2">
        <Status tone={statusTone(f.status)}>{findingStatus[f.status] ?? f.status}</Status>
        {f.reason && (
          <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="text-xs font-medium text-ink-2 transition-colors hover:text-ink">
            {open ? "Hide reason" : "Why it was raised"}
          </button>
        )}
      </div>
      {open && f.reason && <p className="view border-t border-line-soft px-4 py-3 text-[14px] leading-relaxed text-ink-2">{f.reason}</p>}
    </article>
  );
}

type Sort = "priority" | "value" | "newest" | "category";
const sorts: { value: Sort; label: string }[] = [
  { value: "priority", label: "Priority" },
  { value: "value", label: "Largest value" },
  { value: "newest", label: "Newest" },
  { value: "category", label: "Category" },
];
const GROUP_PAGE = 12;
const sevInk: Record<string, string> = { High: ink.high, Medium: ink.medium, Low: ink.low };
const inrTick = (v: number) => (v >= 1e7 ? `${v / 1e7}Cr` : v >= 1e5 ? `${v / 1e5}L` : v >= 1e3 ? `${v / 1e3}K` : String(v));
const selectClass = inputClass.replace("w-full", "w-auto");

export default function Findings({ identity, pulse, focus, goTo, can }: ViewProps) {
  const [severity, setSeverity] = useState("");
  const [cat, setCat] = useState("");
  const [state, setState] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("priority");
  const [layout, setLayout] = useState<"cards" | "table">("cards");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const { data, error, loading, reload } = useTool<{ findings: FindingLite[]; totals?: { count: number } }>("get_findings", { limit: 500 }, [pulse]);

  // Other views link here with a finding, or with a filter to apply.
  useEffect(() => {
    if (!focus) return;
    if (focus.startsWith("f:")) {
      const q = new URLSearchParams(focus.slice(2));
      setSeverity(q.get("severity") ?? "");
      setCat(q.get("category") ?? "");
      setState(q.get("status") ?? "");
    } else setSelected(focus);
  }, [focus]);

  const everything = data?.findings ?? [];
  const total = Number(data?.totals?.count ?? everything.length);
  const categories = useMemo(() => [...new Set(everything.map((f) => f.category))].sort((a, b) => category(a).localeCompare(category(b))), [everything]);

  // Filtering, search and sorting all happen here, on the list already loaded.
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = everything.filter(
      (f) =>
        (!severity || f.severity === severity) &&
        (!cat || f.category === cat) &&
        (!state || f.status === state) &&
        (!q || [f.title, f.subject?.label, f.subject?.id, f.finding_id, category(f.category), f.reason].some((t) => t?.toLowerCase().includes(q))),
    );
    const order: Record<Sort, (a: FindingLite, b: FindingLite) => number> = {
      priority: byPriority,
      value: (a, b) => (Number(b.amount_impact) || 0) - (Number(a.amount_impact) || 0),
      newest: (a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""),
      category: (a, b) => category(a.category).localeCompare(category(b.category)) || byPriority(a, b),
    };
    return list.sort(order[sort]);
  }, [everything, severity, cat, state, query, sort]);

  const live = everything.filter((f) => f.status !== "rejected");
  const confirmed = everything.filter((f) => f.status === "confirmed");
  // Totals count each subject once, as on the Overview.
  const once = (list: FindingLite[]) => sum(dedupe(list).kept);
  const filtered = !!(severity || cat || state || query);
  // Areas follow every filter except the area itself, so the chart can switch between them.
  const areas = useMemo(() => {
    const q = query.trim().toLowerCase();
    const m = new Map<string, { cat: string; value: number; count: number; high: number; medium: number }>();
    const pool = dedupe(
      everything.filter(
        (f) =>
          f.status !== "rejected" &&
          (!severity || f.severity === severity) &&
          (!state || f.status === state) &&
          (!q || [f.title, f.subject?.label, f.finding_id, f.reason].some((t) => t?.toLowerCase().includes(q))),
      ),
    ).kept;
    for (const f of pool) {
      const a = m.get(f.category) ?? { cat: f.category, value: 0, count: 0, high: 0, medium: 0 };
      a.value += Number(f.amount_impact) || 0;
      a.count++;
      if (f.severity === "High") a.high++;
      if (f.severity === "Medium") a.medium++;
      m.set(f.category, a);
    }
    return [...m.values()].sort((a, b) => b.value - a.value);
  }, [everything, severity, state, query]);
  const bigHigh = shown.filter((f) => f.severity === "High" && f.status !== "rejected").sort((a, b) => (Number(b.amount_impact) || 0) - (Number(a.amount_impact) || 0))[0];
  const riskTakeaway = bigHigh ? `The largest high-severity finding is ${inr(bigHigh.amount_impact)}: ${bigHigh.subject?.label ?? category(bigHigh.category)}.` : undefined;
  const noAmount = shown.filter((f) => !(Number(f.amount_impact) > 0)).length;
  const index = selected ? shown.findIndex((f) => f.finding_id === selected) : -1;
  const step = (d: number) => {
    if (!shown.length) return;
    const i = index < 0 ? 0 : (index + d + shown.length) % shown.length;
    setSelected(shown[i].finding_id);
  };

  // With a finding open, the arrow keys (or J and K) step through the list in view.
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select")) return;
      if (e.key === "ArrowRight" || e.key === "j") step(1);
      if (e.key === "ArrowLeft" || e.key === "k") step(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const groups = severities.map((sev) => ({ sev, list: shown.filter((f) => f.severity === sev) })).filter((g) => g.list.length);

  const columns: Column<FindingLite>[] = [
    { key: "sev", label: "Severity", render: (f) => <SeverityBadge severity={f.severity} compact />, width: "104px" },
    {
      key: "title",
      label: "Finding",
      render: (f) => (
        <div>
          <div className="font-medium">{f.title}</div>
          <div className="text-xs text-ink-2">
            {category(f.category)}
            {f.subject?.label ? `, ${f.subject.label}` : ""}
          </div>
        </div>
      ),
    },
    { key: "amount", label: "Amount (₹)", align: "right", render: (f) => (f.amount_impact ? money(f.amount_impact) : "") },
    { key: "samples", label: "Samples", align: "right", render: (f) => f.sample_ids?.length || "" },
    { key: "status", label: "Review", render: (f) => <Status tone={statusTone(f.status)}>{findingStatus[f.status] ?? f.status}</Status> },
  ];

  const clear = () => {
    setSeverity("");
    setCat("");
    setState("");
    setQuery("");
  };

  return (
    <>
      <ViewHead
        title="Findings"
        action={
          <>
            {can("send_report_email") && (
              <EmailAction
                kind="findings_review"
                label="Email the manager"
                audience="the audit manager"
                what="the count of findings awaiting review, by severity, with the largest high-severity findings"
                disabledReason={everything.some((f) => f.status === "proposed" || f.status === "needs_info") ? undefined : "No findings are awaiting review"}
              />
            )}
          </>
        }
      />

      {everything.length > 0 && (
        <PageBrief
          lead={`${inr(once(live))} of potential misstatement across ${plural(live.length, "open finding")}.`}
          detail={
            <>
              Each subject is counted once. {confirmed.length ? `${inr(once(confirmed))} is confirmed by the manager.` : "None is confirmed yet."} Select a severity to show only those findings; select it again to show all.
            </>
          }
          stats={[
            ...severities.map((sev) => {
              const list = live.filter((f) => f.severity === sev);
              return {
                label: `${sev} severity, ${plural(list.length, "finding")}`,
                value: inr(once(list)),
                tone: sev === "High" ? ("bad" as const) : sev === "Medium" ? ("warn" as const) : undefined,
                active: severity === sev,
                onClick: () => setSeverity(severity === sev ? "" : sev),
                hint: `Show only ${sev.toLowerCase()} severity`,
              };
            }),
            {
              label: "Awaiting the manager's review",
              value: everything.filter((f) => f.status === "proposed").length,
              active: state === "proposed",
              onClick: () => setState(state === "proposed" ? "" : "proposed"),
              hint: "Show only findings awaiting review",
            },
          ]}
          guide={[
            { label: "Severe and large", target: "fd-risk" },
            { label: "Which areas", target: "fd-areas" },
            { label: "Every finding", target: "fd-list" },
          ]}
        />
      )}

      {everything.length > 0 && <MoreBar group="fd" title="More analysis" items="Every finding plotted by size and severity, and the areas that carry the most money." />}
      {/* Charts: where each finding sits by value, and which areas carry the most. */}
      {everything.length > 0 && (
        <div data-more="fd" className="mb-6 grid gap-5 xl:grid-cols-[1fr_380px]">
          <div id="fd-risk" className="min-w-0">
          <Panel title="Which findings are both severe and large?" takeaway={riskTakeaway} meta={<span className="text-xs">Each dot is a finding; value on a log scale</span>}>
            <RiskMap
              height={232}
              format={inrTick}
              selected={selected}
              onSelect={setSelected}
              lanes={severities.map((sev) => ({ name: sev, color: sevInk[sev] }))}
              points={shown.map((f) => ({
                key: f.finding_id,
                x: Number(f.amount_impact) || 0,
                lane: severities.indexOf(f.severity),
                color: f.status === "confirmed" ? ink.good : sevInk[f.severity],
                hollow: f.status === "rejected",
                size: 4 + Math.min(4, f.sample_ids?.length ?? 0),
                label: (
                  <>
                    <div className="font-medium">{f.title}</div>
                    <div className="num mt-0.5">{f.amount_impact ? inr(f.amount_impact) : "No direct amount"}</div>
                    <div className="text-ink-2">
                      {category(f.category)}, {(findingStatus[f.status] ?? f.status).toLowerCase()}
                    </div>
                  </>
                ),
              }))}
            />
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-ink-2">
              <span>Dot size: samples affected</span>
              {noAmount > 0 && <span>{plural(noAmount, "finding")} with no direct amount not plotted</span>}
              <span className="flex items-center gap-1.5">
                <Swatch color={ink.good} shape="dot" />
                Confirmed
              </span>
              <span className="flex items-center gap-1.5">
                <i className="inline-block h-2.5 w-2.5 rounded-full border-[1.5px] border-ink-3" />
                Rejected (hollow)
              </span>
            </div>
          </Panel>
          </div>
          <div id="fd-areas" className="min-w-0">
          <Panel title="Which areas carry the most potential misstatement?" takeaway={areas[0] ? `${category(areas[0].cat)} is the largest area at ${inr(areas[0].value)}.` : undefined} meta={cat ? <button onClick={() => setCat("")} className="font-medium text-brand hover:underline">Show all</button> : undefined}>
            <div className="thin-scroll max-h-[272px] overflow-y-auto pr-1">
              <Ranked
                format={inr}
                selected={cat}
                onSelect={(c) => setCat(cat === c ? "" : c)}
                items={areas.map((a) => ({
                  key: a.cat,
                  label: category(a.cat),
                  value: a.value,
                  color: catColor(a.cat),
                  tag: a.high ? <span className="inline-flex items-center gap-0.5 text-[12px] font-semibold text-fail" title={`${a.high} high severity`}><SeverityIcon severity="High" size={10} />{a.high}</span> : undefined,
                  note: plural(a.count, "finding"),
                }))}
              />
            </div>
          </Panel>
          </div>
        </div>
      )}

      {/* Toolbar */}
      <div id="fd-list" />
      <div className="toolbar mb-5">
        <div className="search">
          <SearchBox value={query} onChange={setQuery} label="Search findings" placeholder="Search title, party, reference" />
        </div>
        <select aria-label="Category" className={selectClass + " max-w-[230px]"} value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {category(c)}
            </option>
          ))}
        </select>
        <select aria-label="Review status" className={selectClass} value={state} onChange={(e) => setState(e.target.value)}>
          <option value="">Any review status</option>
          {Object.entries(findingStatus).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <select aria-label="Sort by" className={selectClass} value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
          {sorts.map((s) => (
            <option key={s.value} value={s.value}>
              Sort: {s.label}
            </option>
          ))}
        </select>
        <div className="ml-auto">
          <Pills value={layout} onChange={setLayout} options={[{ value: "cards", label: "Cards" }, { value: "table", label: "Table" }]} />
        </div>
      </div>

      {filtered && (
        <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[14px] text-ink-2">
          <Tally n={shown.length} label={`of ${everything.length} findings`} />
          <Tally n={inr(sum(shown.filter((f) => f.status !== "rejected")))} label="potential" />
          <button onClick={clear} className="font-medium text-brand hover:underline">
            Clear filters
          </button>
        </div>
      )}

      {loading && !data ? (
        <Card>
          <ListSkeleton rows={8} />
        </Card>
      ) : error ? (
        <Card>
          <ErrorNote error={error} onRetry={reload} />
        </Card>
      ) : everything.length === 0 ? (
        <Card>
          <Empty title="No findings yet" hint="Findings are raised as the audit steps run on the Overview tab." />
        </Card>
      ) : shown.length === 0 ? (
        <Card>
          <Empty title="No findings match" hint="Try a different search or clear the filters." action={<Button kind="ghost" small onClick={clear}>Clear filters</Button>} />
        </Card>
      ) : layout === "table" ? (
        <Card>
          <Table columns={columns} rows={shown} rowKey={(f) => f.finding_id} onRow={(f) => setSelected(f.finding_id)} selected={selected ?? undefined} marked={(f) => f.severity === "High" && f.status === "proposed"} />
        </Card>
      ) : sort === "priority" ? (
        // Grouped by severity, so the hierarchy is the layout.
        <div className="space-y-8">
          {groups.map(({ sev, list }) => {
            const all = expanded[sev] || list.length <= GROUP_PAGE;
            return (
              <section key={sev} aria-label={`${sev} severity`}>
                <div className="mb-3 flex items-center gap-3">
                  <span className={cx("h-2 w-2 rounded-full", sevFill[sev])} />
                  <h2 className="text-sm font-semibold text-ink">{sev} severity</h2>
                  <span className="text-[14px] text-ink-2">
                    {plural(list.length, "finding")}, {inr(sum(list.filter((f) => f.status !== "rejected")))}
                  </span>
                  <span className="h-px flex-1 bg-line-soft" />
                </div>
                <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
                  {(all ? list : list.slice(0, GROUP_PAGE)).map((f) => (
                    <FindingCard key={f.finding_id} f={f} selected={selected === f.finding_id} onOpen={() => setSelected(f.finding_id)} />
                  ))}
                </div>
                {!all && (
                  <div className="mt-3">
                    <Button kind="ghost" small onClick={() => setExpanded((e) => ({ ...e, [sev]: true }))}>
                      Show all {list.length}
                    </Button>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
          {shown.map((f) => (
            <FindingCard key={f.finding_id} f={f} selected={selected === f.finding_id} onOpen={() => setSelected(f.finding_id)} />
          ))}
        </div>
      )}
      {total > everything.length && <p className="mt-4 text-[14px] text-ink-2">Showing the first {everything.length} of {total} findings.</p>}

      <Drawer
        open={!!selected}
        onClose={() => setSelected(null)}
        title={everything.find((f) => f.finding_id === selected)?.title ?? "Finding"}
        footer={
          index >= 0 && shown.length > 1 ? (
            <div className="flex items-center justify-between gap-3">
              <Button kind="ghost" small onClick={() => step(-1)}>
                Previous
              </Button>
              <span className="text-xs text-ink-2">
                <span className="num">{index + 1}</span> of <span className="num">{shown.length}</span>
                <span className="ml-2 hidden text-ink-3 sm:inline">Arrow keys move between findings</span>
              </span>
              <Button kind="ghost" small onClick={() => step(1)}>
                Next
              </Button>
            </div>
          ) : undefined
        }
      >
        {selected && <Detail id={selected} manager={identity.role === "audit_manager"} onDecided={reload} onNext={shown.length > 1 ? () => step(1) : undefined} goTo={goTo} />}
      </Drawer>
    </>
  );
}

