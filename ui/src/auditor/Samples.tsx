import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { callTool, money } from "../api";
import type { ViewProps } from "../App";
import { Button, Card, Chip, Column, Drawer, Empty, ErrorNote, KeyValues, Mark, Pills, Section, Status, Table, cx, toast, toneFor, useAction, useTool } from "../ui";
import { Columns, CutoffItem, CutoffTimeline, Donut, Ranked, ink } from "./charts";
import { EmailAction, LedgerRows, ListSkeleton, MoreBar, PageBrief, Panel, SearchBox, Tally, Term, ViewHead, inr, monthKey, monthLabel, monthRange, plural, scaleFor } from "./kit";
import type { EvidenceDoc } from "./Lamp";
import { SampleRise } from "./motion";

// The document viewer brings a PDF reader with it, so it loads only when a document is opened.
const Lamp = lazy(() => import("./Lamp"));
const docName: Record<string, string> = { invoice: "Invoice", eway_bill: "E-way bill", lr_copy: "Lorry receipt", proof_of_delivery: "Proof of delivery", credit_note: "Credit note", sales_return: "Goods return note" };

type Sheet = "sales_tod" | "cutoff_tod" | "credit_note_tod";

interface Sample {
  sample_id: string;
  sheet: Sheet;
  position: number;
  subject_id: string;
  sale_id?: string;
  invoice_no?: string;
  credit_note_no?: string;
  date?: string;
  customer?: string;
  related?: string;
  taxable_value?: number;
  reason: string;
  reason_codes: string[];
  tests?: Record<string, string>;
  finding_ids?: string[];
  detail?: Record<string, any>;
  delivery_date?: string;
  correct_period?: string;
  period_recognised?: string;
  conclusion?: string;
}

const sheets: { value: Sheet; label: string; tool: string; about: string }[] = [
  { value: "sales_tod", label: "Sales", tool: "select_sales_tod", about: "Invoices tested from order to cash." },
  { value: "cutoff_tod", label: "Cut-off", tool: "select_cutoff_tod", about: "Sales either side of the period end, tested for the right period." },
  { value: "credit_note_tod", label: "Credit notes", tool: "select_credit_note_tod", about: "Credit notes tested for a genuine return or price change." },
];

const reasonLabel: Record<string, string> = {
  KEY_ITEM: "Largest by value",
  RELATED_PARTY: "Related party",
  DETECTOR_HIT: "Detector hit",
  CUSTOMER_COVERAGE: "Customer coverage",
  MUS: "Value-weighted sample",
  BEFORE_PERIOD_END: "Before period end",
  AFTER_PERIOD_END: "After period end",
  POST_PERIOD_END: "After period end",
  CUTOFF_BEFORE: "Before period end",
  CUTOFF_AFTER: "After period end",
  POST_PERIOD: "After period end",
  IN_PERIOD: "In period",
};

// Results from worst to best; a sample shows its worst test.
const outcomes = [
  { value: "Changed after testing", short: "Changed after testing", color: "color-mix(in oklab, var(--color-fail) 60%, var(--color-ink))" },
  { value: "Exception", short: "Exception", color: ink.high },
  { value: "Needs human review", short: "Needs review", color: ink.medium },
  { value: "Pending evidence", short: "Awaiting evidence", color: ink.muted },
  { value: "Pass", short: "Pass", color: ink.good },
];

function worst(tests?: Record<string, string>): string {
  const values = Object.values(tests ?? {});
  for (const level of ["Changed after testing", "Exception", "Needs human review", "Pending evidence"]) {
    if (values.includes(level)) return level;
  }
  return values.length ? "Pass" : "";
}

export default function Samples({ pulse, goTo, engagementId, focus, can }: ViewProps) {
  const [sheet, setSheet] = useState<Sheet>("sales_tod");
  const [outcome, setOutcome] = useState("");
  const [query, setQuery] = useState("");
  const [rowView, setRowView] = useState<"ledger" | "table">("ledger");
  const [month, setMonth] = useState("");
  const [reasonPick, setReasonPick] = useState("");
  const [selected, setSelected] = useState<Sample | null>(null);
  // The document of the selected sample that is held to the light, by its place in the list.
  const [lit, setLit] = useState<number | null>(null);
  const evidence = useTool<{ samples: { sample_id: string; documents: EvidenceDoc[] }[] }>(engagementId ? "get_evidence_status" : null, {}, [pulse]);
  const docs = (selected && evidence.data?.samples.find((x) => x.sample_id === selected.sample_id)?.documents) || [];
  const { data, error, loading, reload } = useTool<{ samples: Sample[] }>("get_samples", { sheet }, [pulse]);
  const status = useTool<any>(engagementId ? "get_engagement_status" : null, {}, [pulse]);
  const { busy, run } = useAction();
  const samples = data?.samples ?? [];
  const def = sheets.find((s) => s.value === sheet)!;
  const bySheet: Record<string, number> = status.data?.counts?.samples_by_sheet ?? {};
  const pending = Number(status.data?.counts?.evidence_pending ?? 0);

  const select = () =>
    run("select", async () => {
      const result = await callTool(def.tool, {});
      toast(`${result.samples?.length ?? 0} samples selected. The client has been asked for the documents.`);
      reload();
      status.reload();
    });

  const verify = () =>
    run("verify", async () => {
      const result = await callTool("verify_evidence", {});
      toast(`Evidence tested for ${result.results?.length ?? 0} samples.`);
      reload();
      status.reload();
    });

  const counts = useMemo(() => Object.fromEntries(outcomes.map((o) => [o.value, samples.filter((s) => worst(s.tests) === o.value).length])), [samples]);
  const tested = samples.filter((s) => worst(s.tests) && worst(s.tests) !== "Pending evidence").length;
  const value = samples.reduce((t, s) => t + (Number(s.taxable_value) || 0), 0);
  const problems = (counts["Changed after testing"] ?? 0) + (counts.Exception ?? 0);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return samples.filter(
      (s) =>
        (!outcome || worst(s.tests) === outcome) &&
        (!month || monthKey(s.date) === month) &&
        (!reasonPick || (s.reason_codes ?? []).includes(reasonPick)) &&
        (!q || [s.invoice_no, s.credit_note_no, s.subject_id, s.customer, s.reason].some((t) => t?.toLowerCase().includes(q))),
    );
  }, [samples, outcome, query, month, reasonPick]);

  const byMonth = useMemo(() => {
    const m = new Map<string, Record<string, number>>();
    for (const x of samples) {
      const k = monthKey(x.date);
      if (!k) continue;
      const row = m.get(k) ?? {};
      const w = worst(x.tests) || "Pending evidence";
      row[w] = (row[w] ?? 0) + (Number(x.taxable_value) || 0);
      m.set(k, row);
    }
    return monthRange([...m.keys()]).map((k) => ({ key: k, label: monthLabel(k), parts: outcomes.map((o) => ({ key: o.value, label: o.short, value: m.get(k)?.[o.value] ?? 0, color: o.color })) }));
  }, [samples]);

  const monthScale = scaleFor(Math.max(0, ...byMonth.map((m) => m.parts.reduce((t, p) => t + p.value, 0))));
  const peakMonth = byMonth.reduce<{ label: string; v: number } | null>((best, m) => {
    const v = m.parts.reduce((t, p) => t + p.value, 0);
    return v > 0 && (!best || v > best.v) ? { label: m.label, v } : best;
  }, null);

  // Cut-off samples as invoice-to-delivery arrows. Wrong period: the engine's
  // own correct period differs from the period the sale was recognised in.
  const cutoffItems = useMemo<CutoffItem[]>(
    () =>
      samples
        .filter((x) => x.date)
        .map((x) => ({
          key: x.sample_id,
          label: x.invoice_no ?? x.subject_id,
          invoiced: String(x.date),
          delivered: x.delivery_date ? String(x.delivery_date) : undefined,
          wrong: !!x.correct_period && !!x.period_recognised && x.correct_period !== x.period_recognised,
          note: x.conclusion,
        })),
    [samples],
  );
  const wrongPeriod = cutoffItems.filter((i) => i.wrong).length;

  // A finding links here as "sheet:sample_id": show that sheet and open the sample.
  const [wanted, setWanted] = useState<string | null>(null);
  useEffect(() => {
    if (!focus || !focus.includes(":")) return;
    const [sh, sid] = focus.split(":");
    if (sheets.some((x) => x.value === sh)) {
      setSheet(sh as Sheet);
      setWanted(sid);
    }
  }, [focus]);
  useEffect(() => {
    if (!wanted) return;
    const hit = samples.find((x) => x.sample_id === wanted);
    if (hit) {
      setSelected(hit);
      setWanted(null);
    }
  }, [wanted, samples]);

  const reasons = useMemo(() => {
    const c = new Map<string, number>();
    for (const x of samples) for (const r of x.reason_codes ?? []) c.set(r, (c.get(r) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1]);
  }, [samples]);

  const columns: Column<Sample>[] = [
    { key: "n", label: "#", render: (s) => <span className="text-ink-3 tabular-nums">{s.position}</span>, width: "48px" },
    { key: "doc", label: sheet === "credit_note_tod" ? "Credit note" : "Bill no.", render: (s) => <span className="font-medium">{s.credit_note_no ?? s.invoice_no ?? s.subject_id}</span> },
    { key: "date", label: "Date", render: (s) => <span className="whitespace-nowrap">{s.date ?? ""}</span> },
    {
      key: "customer",
      label: "Customer",
      render: (s) => (
        <span className="flex items-center gap-2">
          <span className="block max-w-56 truncate">{s.customer}</span>
          {s.related === "Related Party" && <Chip tone="rp">Related</Chip>}
        </span>
      ),
    },
    { key: "value", label: "Taxable value (₹)", align: "right", render: (s) => (s.taxable_value !== undefined ? money(s.taxable_value) : "") },
    {
      key: "why",
      label: "Selected for",
      render: (s) => <span className="text-ink-2">{(s.reason_codes ?? []).map((c) => reasonLabel[c] ?? c.replace(/_/g, " ").toLowerCase()).join(", ")}</span>,
    },
    { key: "result", label: "Result", render: (s) => worst(s.tests) && <Status tone={toneFor(worst(s.tests))}>{worst(s.tests)}</Status> },
  ];

  return (
    <>
      <ViewHead
        title="Samples"
        action={
          samples.length === 0 ? (
            <Button busy={busy === "select"} onClick={select}>
              Select {def.label.toLowerCase()} samples
            </Button>
          ) : (
            <span className="flex flex-wrap items-center gap-2">
              {can("send_report_email") && (
                <EmailAction
                  kind="evidence_reminder"
                  label="Remind the client"
                  audience="the client's staff"
                  what="the list of documents still awaited, by sample"
                  disabledReason={pending ? undefined : "No documents are awaited"}
                />
              )}
              <Button busy={busy === "verify"} onClick={verify}>
                Test the evidence
              </Button>
            </span>
          )
        }
      />

      <PageBrief
        lead={
          samples.length
            ? `${plural(samples.length, "sample")} on the ${def.label.toLowerCase()} sheet, worth ${inr(value)}. ${problems ? `${plural(problems, "exception")} found.` : "No exceptions found."}`
            : def.about
        }
        detail="Each sample is an invoice or credit note picked for a reason and checked against its documents. Select a result to show only those samples."
        stats={[
          { label: "Samples on this sheet", value: samples.length, active: !outcome && !month && !reasonPick && !query, onClick: () => {
            setOutcome("");
            setMonth("");
            setReasonPick("");
            setQuery("");
          }, hint: "Show every sample" },
          { label: "Passed every test", value: counts.Pass ?? 0, tone: "good", active: outcome === "Pass", onClick: () => setOutcome(outcome === "Pass" ? "" : "Pass"), hint: "Show only samples that passed" },
          { label: "Exceptions", value: problems, tone: problems ? "bad" : undefined, active: outcome === "Exception", onClick: () => setOutcome(outcome === "Exception" ? "" : "Exception"), hint: "Show only exceptions" },
          { label: "Documents awaited", value: pending, tone: pending ? "warn" : undefined, active: outcome === "Pending evidence", onClick: () => setOutcome(outcome === "Pending evidence" ? "" : "Pending evidence"), hint: "Show samples still waiting for documents" },
        ]}
        guide={[
          { label: "Results", target: "sm-results" },
          ...(sheet === "cutoff_tod" ? [{ label: "The year end", target: "sm-cutoff" }] : []),
          { label: "Every sample", target: "sm-rows" },
        ]}
      />

      {/* Shown when the engagement reports its seed and snapshot. */}
      {status.data?.seed && status.data?.snapshot_seq !== undefined && (
        <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-[14px] text-ink-2">
          <span
            className="inline-flex items-center gap-2 rounded-md border border-pass/40 bg-pass-wash px-2.5 py-1 font-medium text-pass"
            title="The samples are a function of the seed and the snapshot. Running the selection again on the same snapshot with the same seed returns exactly these samples."
          >
            <Mark tone="good" size={13} />
            Reproducible
          </span>
          <span>
            Seed <span className="font-mono text-xs text-ink">{status.data.seed}</span>
            {status.data.seed_source && <span className="text-ink-3"> ({status.data.seed_source === "sealed" ? "sealed, chosen by nobody" : "chosen by the auditor"})</span>}
          </span>
          <span>
            <Term word="snapshot">Snapshot</Term> event <span className="num text-ink">{status.data.snapshot_seq}</span>
            {status.data.snapshot_hash && (
              <span className="ml-1.5 font-mono text-xs text-ink-3" title={status.data.snapshot_hash}>
                {String(status.data.snapshot_hash).slice(0, 10)}…
              </span>
            )}
          </span>
          <span>Re-running gives the same samples.</span>
        </div>
      )}

      {/* One tile per sheet, with how many samples each holds. */}
      <div className="mb-5 grid gap-3 sm:grid-cols-3" role="tablist" aria-label="Sheet">
        {sheets.map((s) => {
          const on = s.value === sheet;
          return (
            <button
              key={s.value}
              role="tab"
              aria-selected={on}
              onClick={() => {
                setSheet(s.value);
                setOutcome("");
                setMonth("");
                setReasonPick("");
                setSelected(null);
              }}
              className={cx("rounded-lg border bg-paper px-4 py-3 text-left transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-brand", on ? "border-ink" : "border-line hover:border-ink-3")}
            >
              <span className="flex items-baseline justify-between gap-3">
                <span className={cx("text-sm font-medium", on ? "text-ink" : "text-ink-2")}>{s.label}</span>
                <span className="num text-lg font-medium text-ink">{bySheet[s.value] ?? "—"}</span>
              </span>
              <span className="mt-0.5 block text-xs text-ink-2">{s.about}</span>
            </button>
          );
        })}
      </div>

      {/* Chapter 02 on the front page: the samples step out of the year. */}
      {samples.length > 0 && (
        <Panel
          id="sm-draw"
          className="mb-5"
          title={`${plural(samples.length, "sample")}, stepping out of the ${sheet === "cutoff_tod" ? "year end" : "year"}`}
          takeaway="Each note is one sample, at its date and as high as its value, with its result written on it. Select a note to open the sample."
        >
          <SampleRise
            items={samples.map((x) => {
              const o = worst(x.tests);
              return {
                key: x.sample_id,
                date: x.date,
                value: Number(x.taxable_value) || 0,
                label: x.credit_note_no ?? x.invoice_no ?? x.subject_id,
                note: [x.customer, reasonLabel[x.reason_codes?.[0]] ?? x.reason, o ? outcomes.find((c) => c.value === o)?.short : ""].filter(Boolean).join(", "),
                tone: o === "Pass" ? "good" : o === "Exception" || o === "Changed after testing" ? "bad" : "warn",
                color: outcomes.find((c) => c.value === o)?.color ?? ink.muted,
              };
            })}
            periodEnd={status.data?.period_end}
            onPick={(k) => setSelected(samples.find((x) => x.sample_id === k) ?? null)}
          />
        </Panel>
      )}

      {samples.length > 0 && <MoreBar group="sm" title="More analysis" items="Test results as a chart, when the sampled sales were booked, and why each one was picked." />}
      {samples.length > 0 && (
        <div id="sm-results" data-more="sm" className="mb-5 grid gap-5 lg:grid-cols-2 xl:grid-cols-[340px_1.3fr_1fr]">
          <Panel
            title="Did the samples pass their tests?"
            takeaway={
              <>
                {counts.Pass ?? 0} of {samples.length} passed{problems ? <>; {problems} <Term word="exception">{problems === 1 ? "exception" : "exceptions"}</Term></> : ""}.
              </>
            }
            meta={outcome ? <button onClick={() => setOutcome("")} className="font-medium text-brand hover:underline">All</button> : undefined}
          >
            <Donut
              size={140}
              thickness={18}
              center={`${tested}/${samples.length}`}
              centerNote="tested"
              selected={outcome || undefined}
              onSelect={(k) => setOutcome(outcome === k ? "" : k)}
              slices={outcomes.filter((o) => counts[o.value]).map((o) => ({ key: o.value, label: o.short, value: counts[o.value], color: o.color }))}
            />
            <p className="mt-3 text-xs text-ink-2">{pending ? `${plural(pending, "document")} still awaited from the client.` : "No documents awaited."}</p>
          </Panel>
          <Panel title="When were the sampled sales booked?" takeaway={peakMonth ? `${peakMonth.label} holds the most sampled value, ${monthScale.label(peakMonth.v)}.` : undefined}>
            <Columns data={byMonth} height={200} format={monthScale.label} axisFormat={monthScale.axis} selected={month || undefined} onSelect={(m) => setMonth(month === m ? "" : m)} />
            <p className="mt-2 text-xs text-ink-2">Coloured by each sample's result. Select a month to filter.</p>
          </Panel>
          <Panel title="Why was each one picked?" takeaway={reasons[0] ? `${reasonLabel[reasons[0][0]] ?? reasons[0][0]} is the most common reason, for ${plural(reasons[0][1], "sample")}.` : undefined}>
            <Ranked
              format={(v) => String(v)}
              selected={reasonPick}
              onSelect={(k) => setReasonPick(reasonPick === k ? "" : k)}
              items={reasons.map(([code, n]) => ({ key: code, label: reasonLabel[code] ?? code.replace(/_/g, " ").toLowerCase(), value: n, color: "color-mix(in oklab, var(--color-brand) 60%, transparent)" }))}
            />
          </Panel>
        </div>
      )}

      {sheet === "cutoff_tod" && cutoffItems.length > 0 && status.data?.period_end && (
        <Panel
          id="sm-cutoff"
          className="mb-5"
          title={<Term word="cut-off">Did each sale land in the right year?</Term>}
          takeaway={
            wrongPeriod
              ? `${wrongPeriod} of ${cutoffItems.length} sales were recorded in one period but delivered in the other, so they belong to the other period.`
              : `All ${cutoffItems.length} cut-off samples are in the right period.`
          }
          meta={
            <span className="flex flex-wrap items-center gap-4 text-xs">
              <span className="flex items-center gap-1.5">
                <i className="inline-block h-0.5 w-4 bg-ink-3" />
                Invoice to delivery
              </span>
              <span className="flex items-center gap-1.5">
                <i className="inline-block h-0.5 w-4 bg-fail" />
                Wrong period
              </span>
            </span>
          }
        >
          <CutoffTimeline items={cutoffItems} periodEnd={String(status.data.period_end)} onSelect={(k) => setSelected(samples.find((x) => x.sample_id === k) ?? null)} />
        </Panel>
      )}

      {samples.length > 0 && (
        <div id="sm-rows" className="mb-3 flex flex-wrap items-center gap-3">
          <div className="w-full sm:w-80">
            <SearchBox value={query} onChange={setQuery} label="Search samples" placeholder="Search bill no., customer" />
          </div>
          <Tally n={shown.length} label={`of ${samples.length} shown`} />
          <span className="ml-auto">
            <Pills value={rowView} onChange={setRowView} options={[{ value: "ledger", label: "Ledger" }, { value: "table", label: "Table" }]} />
          </span>
          {(outcome || query || month || reasonPick) && (
            <button
              onClick={() => {
                setOutcome("");
                setQuery("");
                setMonth("");
                setReasonPick("");
              }}
              className="text-[14px] font-medium text-brand hover:underline"
            >
              Clear
            </button>
          )}
        </div>
      )}

      <Card>
        {loading && !data ? (
          <ListSkeleton rows={6} />
        ) : error ? (
          <ErrorNote error={error} onRetry={reload} />
        ) : samples.length === 0 ? (
          <Empty title="No samples on this sheet yet" hint="Select the samples with the button above. The same seed and snapshot always pick the same ones." />
        ) : shown.length === 0 ? (
          <Empty title="No samples match" />
        ) : (
          rowView === "table" ? (
            <Table columns={columns} rows={shown} rowKey={(s) => s.sample_id} onRow={setSelected} selected={selected?.sample_id} marked={(s) => ["Exception", "Changed after testing"].includes(worst(s.tests))} />
          ) : (
            <LedgerRows
              items={shown.map((x) => {
                const w = worst(x.tests);
                return {
                  key: x.sample_id,
                  rail: outcomes.find((o) => o.value === w)?.color ?? "var(--color-line)",
                  group: x.date ? monthLabel(String(x.date).slice(0, 7)) : undefined,
                  title: (
                    <>
                      {x.credit_note_no ?? x.invoice_no ?? x.subject_id}
                      <span className="ml-2 font-normal text-ink-2">{x.customer}</span>
                      {x.related === "Related Party" && (
                        <span className="ml-2 align-middle">
                          <Chip tone="rp">Related</Chip>
                        </span>
                      )}
                    </>
                  ),
                  meta: `${x.date ? x.date : ""}${(x.reason_codes ?? []).length ? `, picked for ${(x.reason_codes ?? []).map((c) => (reasonLabel[c] ?? c).toLowerCase()).join(", ")}` : ""}`,
                  amount: x.taxable_value,
                  status: w ? <Status tone={toneFor(w)}>{w}</Status> : null,
                  detail: (
                    <>
                      <p className="mb-3 text-[14px] leading-relaxed text-ink">{x.reason}</p>
                      {x.tests && Object.keys(x.tests).length > 0 && (
                        <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1.5">
                          {Object.entries(x.tests).map(([t, r]) => (
                            <Status key={t} tone={toneFor(r)}>
                              {t}
                            </Status>
                          ))}
                        </div>
                      )}
                      <div className="flex flex-wrap items-center gap-4 text-[14px]">
                        <button onClick={() => setSelected(x)} className="font-medium text-brand hover:underline">
                          Open the full sample
                        </button>
                        {(x.finding_ids?.length ?? 0) > 0 && (
                          <button onClick={() => goTo("findings", x.finding_ids![0])} className="font-medium text-fail hover:underline">
                            Open {plural(x.finding_ids!.length, "finding")}
                          </button>
                        )}
                      </div>
                    </>
                  ),
                };
              })}
            />
          )
        )}
      </Card>

      <Drawer open={!!selected} onClose={() => setSelected(null)} title={selected ? selected.credit_note_no ?? selected.invoice_no ?? selected.subject_id : ""}>
        {selected && (
          <>
            <div className="mb-6 flex flex-wrap items-center gap-3">
              {worst(selected.tests) && <Status tone={toneFor(worst(selected.tests))}>{worst(selected.tests)}</Status>}
              {selected.related === "Related Party" && <Chip tone="rp">Related party</Chip>}
              <span className="num ml-auto text-lg font-medium">{selected.taxable_value !== undefined ? `₹ ${money(selected.taxable_value)}` : ""}</span>
            </div>
            <Section title="Why it was selected">
              <p className="text-sm leading-relaxed text-ink">{selected.reason}</p>
              {(selected.reason_codes?.length ?? 0) > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {selected.reason_codes.map((c) => (
                    <Chip key={c}>{reasonLabel[c] ?? c.replace(/_/g, " ").toLowerCase()}</Chip>
                  ))}
                </div>
              )}
            </Section>
            {selected.tests && Object.keys(selected.tests).length > 0 && (
              <Section title="Tests">
                <ul className="divide-y divide-line-soft">
                  {Object.entries(selected.tests).map(([test, result]) => (
                    <li key={test} className="flex items-center justify-between gap-4 py-2 text-sm">
                      <span className="text-ink">{test}</span>
                      <Status tone={toneFor(result)}>{result}</Status>
                    </li>
                  ))}
                </ul>
              </Section>
            )}
            {docs.length > 0 && (
              <Section title="Documents the client sent">
                <ul className="divide-y divide-line-soft">
                  {docs.map((d, i) => (
                    <li key={d.document_type} className="flex items-center justify-between gap-4 py-2 text-sm">
                      <span className="text-ink">{docName[d.document_type] ?? d.document_type.replace(/_/g, " ")}</span>
                      {d.file_hash ? (
                        <Button kind="ghost" small onClick={() => setLit(i)}>
                          Hold to the light
                        </Button>
                      ) : (
                        <span className="text-ink-3">{d.status === "declined" ? "Client says there is none" : "Not sent yet"}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </Section>
            )}
            <Section title="Sample">
              <KeyValues
                items={[
                  ["Customer", selected.customer],
                  ["Date", selected.date],
                  ["Taxable value", selected.taxable_value !== undefined ? money(selected.taxable_value) : undefined],
                  ["Party", selected.related],
                  ...Object.entries(selected.detail ?? {})
                    .filter(([, v]) => typeof v !== "object")
                    .map(([k, v]) => [k.replace(/_/g, " "), String(v)] as [string, string]),
                ]}
              />
            </Section>
            {(selected.finding_ids?.length ?? 0) > 0 && (
              <Section title="Findings">
                <div className="flex flex-wrap gap-2">
                  {selected.finding_ids!.map((id) => (
                    <button key={id} onClick={() => goTo("findings", id)} className="rounded bg-fail-wash px-2 py-0.5 font-mono text-xs text-fail hover:underline">
                      {id}
                    </button>
                  ))}
                </div>
              </Section>
            )}
          </>
        )}
      </Drawer>
      {selected && lit !== null && (
        <Suspense fallback={null}>
          <Lamp
            sample={selected}
            docs={docs}
            start={lit}
            onClose={() => setLit(null)}
            onFinding={(id) => {
              setLit(null);
              goTo("findings", id);
            }}
          />
        </Suspense>
      )}
    </>
  );
}
