import { useEffect, useState } from "react";
import { callTool, money, when } from "../api";
import type { ViewProps } from "../App";
import { Button, Card, Chip, Column, Drawer, Empty, ErrorNote, Header, KeyValues, Loading, Pills, Section, Table, inputClass, toast, toneFor, useAction, useTool } from "../ui";

interface Finding {
  finding_id: string;
  detector_id: string;
  category: string;
  subtype?: string;
  severity: "High" | "Medium" | "Low";
  title: string;
  subject?: { type: string; id: string; label?: string };
  amount_impact: number;
  period_effect?: string;
  status: string;
  sample_ids?: string[];
  reason?: string;
  explanation?: string;
  proposed_adjustment?: { account: string; debit: number; credit: number; narration?: string }[];
  standard_refs?: string[];
  lineage?: Record<string, any>;
  decided_by?: string;
  decided_at?: string;
  decision_note?: string;
}

const statusLabel: Record<string, string> = {
  proposed: "Pending confirmation",
  confirmed: "Confirmed",
  rejected: "Rejected",
  needs_info: "Needs info",
};

function category(c: string) {
  const text = c.replace(/_/g, " ").toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function Detail({ id, manager, onDecided }: { id: string; manager: boolean; onDecided: () => void }) {
  const { data, error, loading, reload } = useTool<Finding>("explain_finding", { finding_id: id }, [id]);
  const [note, setNote] = useState("");
  const { busy, run } = useAction();

  if (loading && !data) return <Loading />;
  if (error) return <ErrorNote error={error} onRetry={reload} />;
  if (!data) return null;
  const f = data;
  const lineage = f.lineage ?? {};

  const decide = (decision: string) =>
    run(decision, async () => {
      await callTool("confirm_finding", { finding_id: id, decision, note });
      toast(`Finding ${statusLabel[decision].toLowerCase()}.`);
      setNote("");
      reload();
      onDecided();
    });

  return (
    <>
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Chip tone={toneFor(f.severity)}>{f.severity}</Chip>
        <Chip>{category(f.category)}</Chip>
        <Chip tone={toneFor(f.status)}>{statusLabel[f.status] ?? f.status}</Chip>
      </div>
      <Section title="Why this is a finding">
        <p className="text-sm leading-relaxed text-slate-700">{f.explanation ?? f.reason}</p>
      </Section>
      <Section title="Impact">
        <KeyValues
          items={[
            ["Amount", `₹ ${money(f.amount_impact)}`],
            ["Period revenue", f.period_effect && f.period_effect !== "None" ? f.period_effect : undefined],
            ["Subject", f.subject?.label ?? f.subject?.id],
            ["Detector", `${f.detector_id}${f.subtype ? " · " + f.subtype.replace(/_/g, " ").toLowerCase() : ""}`],
            ["Samples", f.sample_ids?.length ? `${f.sample_ids.length} affected` : undefined],
          ]}
        />
      </Section>
      {(f.proposed_adjustment?.length ?? 0) > 0 && (
        <Section title="Proposed adjustment">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="pb-1 font-medium">Account</th>
                <th className="pb-1 text-right font-medium">Debit</th>
                <th className="pb-1 text-right font-medium">Credit</th>
              </tr>
            </thead>
            <tbody>
              {f.proposed_adjustment!.map((l, i) => (
                <tr key={i} className="border-t border-slate-100">
                  <td className="py-1.5 text-slate-700">{l.account}</td>
                  <td className="py-1.5 text-right tabular-nums">{l.debit ? money(l.debit) : ""}</td>
                  <td className="py-1.5 text-right tabular-nums">{l.credit ? money(l.credit) : ""}</td>
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
      {f.decided_by && (
        <Section title="Decision">
          <KeyValues items={[["By", f.decided_by], ["At", when(f.decided_at)], ["Note", f.decision_note]]} />
        </Section>
      )}
      {manager ? (
        <Section title="Your decision">
          <textarea className={inputClass + " mb-3 min-h-20"} placeholder="Note" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="flex gap-2">
            <Button busy={busy === "confirmed"} onClick={() => decide("confirmed")}>
              Confirm
            </Button>
            <Button kind="danger" busy={busy === "rejected"} onClick={() => decide("rejected")}>
              Reject
            </Button>
            <Button kind="ghost" busy={busy === "needs_info"} onClick={() => decide("needs_info")}>
              Needs info
            </Button>
          </div>
        </Section>
      ) : (
        f.status === "proposed" && <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">Awaiting confirmation by the audit manager.</div>
      )}
    </>
  );
}

export default function Findings({ identity, pulse, focus }: ViewProps) {
  const [severity, setSeverity] = useState("");
  const [cat, setCat] = useState("");
  const [selected, setSelected] = useState<string | null>(focus ?? null);
  const { data, error, loading, reload } = useTool<{ findings: Finding[]; totals?: any }>("get_findings", { severity, category: cat, limit: 500 }, [pulse]);
  const all = useTool<{ findings: Finding[] }>("get_findings", { limit: 500 }, [pulse]);

  useEffect(() => {
    if (focus) setSelected(focus);
  }, [focus]);

  const findings = data?.findings ?? [];
  const everything = all.data?.findings ?? [];
  const count = (s: string) => everything.filter((f) => f.severity === s).length;
  const categories = [...new Set(everything.map((f) => f.category))].sort();

  const columns: Column<Finding>[] = [
    { key: "sev", label: "Severity", render: (f) => <Chip tone={toneFor(f.severity)}>{f.severity}</Chip>, width: "96px" },
    {
      key: "title",
      label: "Finding",
      render: (f) => (
        <div>
          <div className="font-medium">{f.title}</div>
          <div className="text-xs text-slate-500">{category(f.category)}</div>
        </div>
      ),
    },
    { key: "amount", label: "Amount", align: "right", render: (f) => (f.amount_impact ? money(f.amount_impact) : "") },
    { key: "samples", label: "Samples", align: "right", render: (f) => f.sample_ids?.length || "" },
    { key: "status", label: "Status", render: (f) => <Chip tone={toneFor(f.status)}>{statusLabel[f.status] ?? f.status}</Chip> },
  ];

  return (
    <>
      <Header
        title="Findings"
        action={
          <div className="flex items-center gap-3">
            <select className={inputClass + " w-56"} value={cat} onChange={(e) => setCat(e.target.value)}>
              <option value="">All categories</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {category(c)}
                </option>
              ))}
            </select>
            <Pills
              value={severity}
              onChange={setSeverity}
              options={[
                { value: "", label: "All", count: everything.length },
                { value: "High", label: "High", count: count("High") },
                { value: "Medium", label: "Medium", count: count("Medium") },
                { value: "Low", label: "Low", count: count("Low") },
              ]}
            />
          </div>
        }
      />
      <Card>
        {loading && !data ? (
          <Loading />
        ) : error ? (
          <ErrorNote error={error} onRetry={reload} />
        ) : findings.length === 0 ? (
          <Empty title="No findings" hint="Findings appear as the audit steps run." />
        ) : (
          <Table columns={columns} rows={findings} rowKey={(f) => f.finding_id} onRow={(f) => setSelected(f.finding_id)} selected={selected ?? undefined} />
        )}
      </Card>
      <Drawer open={!!selected} onClose={() => setSelected(null)} title={findings.find((f) => f.finding_id === selected)?.title ?? everything.find((f) => f.finding_id === selected)?.title ?? "Finding"}>
        {selected && (
          <Detail
            id={selected}
            manager={identity.role === "audit_manager"}
            onDecided={() => {
              reload();
              all.reload();
            }}
          />
        )}
      </Drawer>
    </>
  );
}
