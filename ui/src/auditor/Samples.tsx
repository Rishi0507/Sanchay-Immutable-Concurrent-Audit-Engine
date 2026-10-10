import { useState } from "react";
import { callTool, money } from "../api";
import type { ViewProps } from "../App";
import { Button, Card, Chip, Column, Drawer, Empty, ErrorNote, Header, KeyValues, Loading, Pills, Section, Status, Table, toast, toneFor, useAction, useTool } from "../ui";

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
}

const sheets: { value: Sheet; label: string; tool: string }[] = [
  { value: "sales_tod", label: "Sales TOD", tool: "select_sales_tod" },
  { value: "cutoff_tod", label: "Cut-off TOD", tool: "select_cutoff_tod" },
  { value: "credit_note_tod", label: "Credit Note TOD", tool: "select_credit_note_tod" },
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

function worst(tests?: Record<string, string>): string {
  const values = Object.values(tests ?? {});
  for (const level of ["Changed after testing", "Exception", "Needs human review", "Pending evidence"]) {
    if (values.includes(level)) return level;
  }
  return values.length ? "Pass" : "";
}

export default function Samples({ pulse, goTo }: ViewProps) {
  const [sheet, setSheet] = useState<Sheet>("sales_tod");
  const [selected, setSelected] = useState<Sample | null>(null);
  const { data, error, loading, reload } = useTool<{ samples: Sample[] }>("get_samples", { sheet }, [pulse]);
  const { busy, run } = useAction();
  const samples = data?.samples ?? [];
  const def = sheets.find((s) => s.value === sheet)!;

  const select = () =>
    run("select", async () => {
      const result = await callTool(def.tool, {});
      toast(`${result.samples?.length ?? 0} samples selected. The client has been asked for the documents.`);
      reload();
    });

  const verify = () =>
    run("verify", async () => {
      const result = await callTool("verify_evidence", {});
      toast(`Evidence tested for ${result.results?.length ?? 0} samples.`);
      reload();
    });

  const columns: Column<Sample>[] = [
    { key: "n", label: "#", render: (s) => <span className="text-ink-3 tabular-nums">{s.position}</span>, width: "48px" },
    { key: "doc", label: sheet === "credit_note_tod" ? "Credit note" : "Bill no.", render: (s) => <span className="font-medium">{s.credit_note_no ?? s.invoice_no ?? s.subject_id}</span> },
    { key: "date", label: "Date", render: (s) => s.date ?? "" },
    { key: "customer", label: "Customer", render: (s) => <span className="block max-w-56 truncate">{s.customer}</span> },
    { key: "rp", label: "Party", render: (s) => (s.related === "Related Party" ? <Chip tone="rp">Related</Chip> : s.related ? <span className="text-ink-2">Non related</span> : null) },
    { key: "value", label: "Taxable value", align: "right", render: (s) => (s.taxable_value !== undefined ? money(s.taxable_value) : "") },
    {
      key: "why",
      label: "Selected for",
      render: (s) => (
        <span className="text-ink-2">{(s.reason_codes ?? []).map((c) => reasonLabel[c] ?? c.replace(/_/g, " ").toLowerCase()).join(", ")}</span>
      ),
    },
    { key: "result", label: "Result", render: (s) => worst(s.tests) && <Status tone={toneFor(worst(s.tests))}>{worst(s.tests)}</Status> },
  ];

  return (
    <>
      <Header
        title="Samples"
        action={
          <div className="flex items-center gap-3">
            <Pills value={sheet} onChange={setSheet} options={sheets.map((s) => ({ value: s.value, label: s.label }))} />
            {samples.length === 0 ? (
              <Button busy={busy === "select"} onClick={select}>
                Select samples
              </Button>
            ) : (
              <Button busy={busy === "verify"} onClick={verify}>
                Test the evidence
              </Button>
            )}
          </div>
        }
      />
      <Card>
        {loading && !data ? (
          <Loading />
        ) : error ? (
          <ErrorNote error={error} onRetry={reload} />
        ) : samples.length === 0 ? (
          <Empty title="No samples selected for this sheet" hint="The same seed and snapshot always select the same samples." />
        ) : (
          <Table columns={columns} rows={samples} rowKey={(s) => s.sample_id} onRow={setSelected} selected={selected?.sample_id} marked={(s) => ["Exception", "Changed after testing"].includes(worst(s.tests))} />
        )}
      </Card>
      <Drawer open={!!selected} onClose={() => setSelected(null)} title={selected ? selected.credit_note_no ?? selected.invoice_no ?? selected.subject_id : ""}>
        {selected && (
          <>
            <Section title="Why it was selected">
              <p className="text-sm leading-relaxed text-ink">{selected.reason}</p>
            </Section>
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
            {selected.tests && Object.keys(selected.tests).length > 0 && (
              <Section title="Tests">
                <div className="space-y-2">
                  {Object.entries(selected.tests).map(([test, result]) => (
                    <div key={test} className="flex items-center justify-between text-sm">
                      <span className="text-ink">{test}</span>
                      <Status tone={toneFor(result)}>{result}</Status>
                    </div>
                  ))}
                </div>
              </Section>
            )}
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
    </>
  );
}
