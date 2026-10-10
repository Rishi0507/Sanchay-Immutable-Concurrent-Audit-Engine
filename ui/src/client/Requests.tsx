import { useMemo, useRef, useState } from "react";
import { callTool, idempotencyKey, money, uploadFile } from "../api";
import type { ViewProps } from "../App";
import { Card, Chip, Empty, ErrorNote, Header, Loading, Pills, toast, useAction, useTool } from "../ui";

interface Request {
  request_id: string;
  sample_id: string;
  sheet: string;
  document_type: string;
  status: string;
  note?: string;
  subject?: { invoice_no?: string; date?: string; customer?: string; amount?: number };
}

const docLabel: Record<string, string> = {
  invoice: "Invoice",
  eway_bill: "E-way bill",
  lr_copy: "LR copy",
  proof_of_delivery: "Proof of delivery",
  credit_note: "Credit note",
  sales_return: "Sales return",
  other: "Other",
};

const sheetLabel: Record<string, string> = {
  sales_tod: "Sales TOD",
  cutoff_tod: "Cut-off TOD",
  credit_note_tod: "Credit Note TOD",
};

export default function Requests({ pulse }: ViewProps) {
  const [filter, setFilter] = useState<"pending" | "all">("pending");
  const { data, error, loading, reload } = useTool<{ requests: Request[] }>("list_evidence_requests", { limit: 500 }, [pulse]);
  const { busy, run } = useAction();
  const input = useRef<HTMLInputElement>(null);
  const target = useRef<Request | null>(null);

  const groups = useMemo(() => {
    const bySample = new Map<string, Request[]>();
    for (const r of data?.requests ?? []) {
      bySample.set(r.sample_id, [...(bySample.get(r.sample_id) ?? []), r]);
    }
    return [...bySample.entries()]
      .map(([sampleId, items]) => ({ sampleId, items, pending: items.filter((i) => i.status === "pending").length }))
      .filter((g) => filter === "all" || g.pending > 0);
  }, [data, filter]);

  const pendingTotal = (data?.requests ?? []).filter((r) => r.status === "pending").length;

  const pick = (r: Request) => {
    target.current = r;
    input.current?.click();
  };

  const send = (file: File) => {
    const r = target.current;
    if (!r) return;
    run(r.request_id, async () => {
      const stored = await uploadFile(file);
      await callTool("upload_evidence", {
        sample_id: r.sample_id,
        document_type: r.document_type,
        file_hash: stored.file_hash,
        file_name: file.name,
        idempotency_key: idempotencyKey("evidence"),
      });
      toast(`${docLabel[r.document_type] ?? r.document_type} uploaded.`);
      reload();
    });
  };

  return (
    <>
      <Header
        title="Requests"
        hint="Documents the auditor needs for its samples."
        action={
          <Pills
            value={filter}
            onChange={setFilter}
            options={[
              { value: "pending", label: "Pending", count: pendingTotal },
              { value: "all", label: "All" },
            ]}
          />
        }
      />
      <input
        ref={input}
        type="file"
        hidden
        onChange={(e) => {
          if (e.target.files?.[0]) send(e.target.files[0]);
          e.target.value = "";
        }}
      />
      {loading && !data ? (
        <Loading />
      ) : error ? (
        <Card>
          <ErrorNote error={error} onRetry={reload} />
        </Card>
      ) : groups.length === 0 ? (
        <Card>
          <Empty title={filter === "pending" ? "Nothing pending" : "No requests yet"} hint="Requests appear here when the auditor selects samples." />
        </Card>
      ) : (
        <div className="space-y-3">
          {groups.map((g) => {
            const s = g.items[0].subject ?? {};
            return (
              <Card key={g.sampleId} className="flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4">
                <div className="min-w-48 flex-1">
                  <div className="font-medium">{s.invoice_no ?? g.sampleId}</div>
                  <div className="text-sm text-slate-500">
                    {[s.customer, s.date, s.amount !== undefined ? `₹ ${money(s.amount)}` : null].filter(Boolean).join(" · ")}
                  </div>
                </div>
                <Chip>{sheetLabel[g.items[0].sheet] ?? g.items[0].sheet}</Chip>
                <div className="flex flex-wrap gap-2">
                  {g.items.map((r) =>
                    r.status === "pending" ? (
                      <button
                        key={r.request_id}
                        onClick={() => pick(r)}
                        disabled={busy === r.request_id}
                        title={r.note}
                        className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-indigo-300 px-3 py-1 text-xs font-medium text-indigo-700 transition-colors hover:bg-indigo-50 disabled:opacity-50"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
                        {docLabel[r.document_type] ?? r.document_type}
                      </button>
                    ) : (
                      <Chip key={r.request_id} tone="good">
                        {docLabel[r.document_type] ?? r.document_type}
                      </Chip>
                    ),
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
