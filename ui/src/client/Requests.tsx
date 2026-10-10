import { useMemo, useRef, useState } from "react";
import { callTool, idempotencyKey, money, uploadFile } from "../api";
import type { ViewProps } from "../App";
import { Card, Empty, ErrorNote, Header, Loading, Pills, Status, cx, toast, useAction, useTool } from "../ui";

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

  // The honest answer when the auditor asks for a document that was never made.
  const decline = (r: Request) =>
    run(r.request_id, async () => {
      await callTool("upload_evidence", {
        sample_id: r.sample_id,
        document_type: r.document_type,
        not_available: true,
        note: "No such document exists for this transaction.",
        idempotency_key: idempotencyKey("evidence"),
      });
      toast(`Answered: no ${(docLabel[r.document_type] ?? r.document_type).toLowerCase()} exists.`);
      reload();
    });

  return (
    <>
      <Header
        title="Requests"
        hint="The auditor needs these documents for the sales it is testing."
        action={
          <Pills
            value={filter}
            onChange={setFilter}
            options={[
              { value: "pending", label: "Outstanding", count: pendingTotal },
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
          <Empty title={filter === "pending" ? "Nothing is outstanding" : "No requests yet"} hint="Requests appear here once the auditor selects its samples." />
        </Card>
      ) : (
        <Card className="divide-y divide-line-soft">
          {groups.map((g) => {
            const s = g.items[0].subject ?? {};
            return (
              <div key={g.sampleId} className="flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-3.5">
                <div className="min-w-48 flex-1">
                  <div className="font-medium">{s.invoice_no ?? g.sampleId}</div>
                  <div className="text-sm text-ink-2">
                    {[s.customer, s.date, s.amount !== undefined ? `₹ ${money(s.amount)}` : null].filter(Boolean).join(", ")}
                  </div>
                </div>
                <span className="text-[14px] text-ink-2">{sheetLabel[g.items[0].sheet] ?? g.items[0].sheet}</span>
                <div className="flex flex-wrap gap-2">
                  {g.items.map((r) =>
                    r.status === "pending" ? (
                      // Upload the document, or answer that it does not exist.
                      <span key={r.request_id} className={cx("inline-flex h-7 items-stretch overflow-hidden rounded-md border border-dashed border-brand/50 text-xs font-medium", busy === r.request_id && "opacity-50")}>
                        <button onClick={() => pick(r)} disabled={busy === r.request_id} title={r.note} className="inline-flex items-center gap-1.5 px-2.5 text-brand transition-colors hover:bg-brand-wash">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
                          {docLabel[r.document_type] ?? r.document_type}
                        </button>
                        <button
                          onClick={() => decline(r)}
                          disabled={busy === r.request_id}
                          title="This document does not exist"
                          aria-label={`${docLabel[r.document_type] ?? r.document_type} does not exist`}
                          className="inline-flex items-center border-l border-dashed border-brand/50 px-1.5 text-ink-3 transition-colors hover:bg-wash hover:text-ink"
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                        </button>
                      </span>
                    ) : (
                      <span key={r.request_id} className="inline-flex h-7 items-center">
                        {r.status === "declined" ? (
                          <Status tone="neutral">{docLabel[r.document_type] ?? r.document_type}: none</Status>
                        ) : (
                          <Status tone="good">{docLabel[r.document_type] ?? r.document_type}</Status>
                        )}
                      </span>
                    ),
                  )}
                </div>
              </div>
            );
          })}
        </Card>
      )}
    </>
  );
}
