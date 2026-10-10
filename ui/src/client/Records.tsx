import { useEffect, useState } from "react";
import { callTool, money, when } from "../api";
import type { ViewProps } from "../App";
import { Button, Card, Column, Drawer, Empty, ErrorNote, Header, KeyValues, Loading, Section, Status, Table, inputClass, useTool } from "../ui";

export interface RecordRow {
  id: string;
  type: string;
  seq: number;
  date?: string;
  sale_id?: string;
  reversed: boolean;
  recorded_at: string;
  recorded_by: string;
  data: Record<string, any>;
}

export const recordTypes: { value: string; label: string }[] = [
  { value: "invoice", label: "Invoices" },
  { value: "order", label: "Orders" },
  { value: "customer", label: "Customers" },
  { value: "dispatch", label: "Dispatches" },
  { value: "eway_bill", label: "E-way bills" },
  { value: "lorry_receipt", label: "Lorry receipts" },
  { value: "delivery", label: "Deliveries" },
  { value: "receipt", label: "Receipts" },
  { value: "credit_note", label: "Credit notes" },
  { value: "sales_return", label: "Sales returns" },
  { value: "journal", label: "Journals" },
  { value: "gstr1", label: "GSTR-1" },
  { value: "promotion", label: "Promotions" },
  { value: "price", label: "Prices" },
  { value: "enquiry", label: "Enquiries" },
  { value: "vendor", label: "Vendors" },
  { value: "purchase_invoice", label: "Purchase invoices" },
  { value: "goods_receipt", label: "Goods receipts" },
  { value: "payment", label: "Payments" },
  { value: "bank_statement", label: "Bank statements" },
  { value: "officer", label: "Officers" },
];

// The field that best names a record of each type.
export function recordTitle(r: RecordRow): string {
  const d = r.data ?? {};
  return (
    d.invoice_no ?? d.order_no ?? d.credit_note_no ?? d.ewb_no ?? d.lr_no ?? d.name ?? d.scheme_id ?? d.item_code ?? d.narration ?? d.utr ?? d.return_period ?? d.pod_reference ?? r.id
  );
}

export function recordAmount(r: RecordRow): number | undefined {
  const d = r.data ?? {};
  return d.gross ?? d.amount ?? d.value ?? d.rate;
}

const moneyFields = new Set(["gross", "amount", "value", "rate", "taxable_value", "discount", "packing", "freight", "insurance", "cgst", "sgst", "igst", "tcs", "round_off", "tax", "debit", "credit"]);

// Field names as an accountant writes them.
const acronyms: Record<string, string> = {
  cgst: "CGST", sgst: "SGST", igst: "IGST", tcs: "TCS", gstin: "GSTIN", pan: "PAN", irn: "IRN", utr: "UTR",
  hsn: "HSN", din: "DIN", ifsc: "IFSC", ewb: "e-way bill", lr: "LR", pod: "POD", id: "ID", no: "no.", qty: "quantity",
};

export function fieldLabel(key: string): string {
  return key
    .split("_")
    .map((w) => acronyms[w] ?? w)
    .join(" ");
}

export function show(key: string, v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return moneyFields.has(key) ? money(v) : String(v);
  if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? "" : "s"}`;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function RecordDetail({ record, tool, extraArgs }: { record: RecordRow; tool: string | null; extraArgs?: Record<string, unknown> }) {
  // The client can load full history; the auditor sees the snapshot row.
  const detail = useTool<any>(tool, { id: record.id, ...extraArgs }, [record.id]);
  const data = detail.data?.data ?? record.data;
  const scalars = Object.entries(data).filter(([, v]) => typeof v !== "object" || v === null);
  const lists = Object.entries(data).filter(([, v]) => Array.isArray(v) && v.length > 0) as [string, any[]][];
  const history: any[] = detail.data?.history ?? [];
  const postings = history.flatMap((h) => (h.postings ?? []).map((p: any) => ({ ...p, event: h.event })));

  return (
    <>
      <Section title="Details">
        <KeyValues
          items={[
            ["ID", <span className="font-mono text-xs">{record.id}</span>],
            ["Sale", record.sale_id && <span className="font-mono text-xs">{record.sale_id}</span>],
            ["Recorded", `${when(record.recorded_at)} by ${record.recorded_by}`],
            ...scalars.map(([k, v]) => [fieldLabel(k), show(k, v)] as [string, string]),
          ]}
        />
      </Section>
      {lists.map(([name, items]) => (
        <Section key={name} title={name.replace(/_/g, " ")}>
          <div className="space-y-2">
            {items.map((item, i) => (
              <div key={i} className="rounded-md bg-wash px-3 py-2 text-sm text-ink">
                {typeof item === "object"
                  ? Object.entries(item)
                      .map(([k, v]) => `${fieldLabel(k)} ${show(k, v)}`)
                      .join(", ")
                  : String(item)}
              </div>
            ))}
          </div>
        </Section>
      ))}
      {postings.length > 0 && (
        <Section title="Ledger postings">
          <table className="w-full text-sm">
            <tbody>
              {postings.map((p, i) => (
                <tr key={i} className="border-b border-line-soft last:border-0">
                  <td className="py-1.5 text-ink">
                    {p.account_code} {p.account_name}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">{p.debit ? money(p.debit) : ""}</td>
                  <td className="py-1.5 text-right tabular-nums text-ink-2">{p.credit ? money(p.credit) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
      {history.length > 1 && (
        <Section title="History">
          <div className="space-y-1.5 text-sm">
            {history.map((h) => (
              <div key={h.seq} className="flex justify-between text-ink">
                <span>
                  v{h.version} {h.event}
                </span>
                <span className="text-ink-3">{when(h.recorded_at)}</span>
              </div>
            ))}
          </div>
        </Section>
      )}
    </>
  );
}

export function recordColumns(): Column<RecordRow>[] {
  return [
    { key: "title", label: "Record", render: (r) => <span className="font-medium">{recordTitle(r)}</span> },
    { key: "date", label: "Date", render: (r) => r.date ?? "" },
    { key: "party", label: "Party", render: (r) => <span className="font-mono text-xs text-ink-2">{r.data.customer_id ?? r.data.vendor_id ?? ""}</span> },
    { key: "amount", label: "Amount", align: "right", render: (r) => (recordAmount(r) !== undefined ? money(recordAmount(r)) : "") },
    { key: "state", label: "", render: (r) => (r.reversed ? <Status tone="bad">Reversed</Status> : null) },
  ];
}

export default function Records({ pulse }: ViewProps) {
  const [type, setType] = useState("invoice");
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<RecordRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<RecordRow | null>(null);
  const [more, setMore] = useState(false);
  const first = useTool<{ records: RecordRow[]; next_cursor: string | null }>("list_records", { type, text: query, limit: 50 }, [pulse]);

  useEffect(() => {
    setRows(first.data?.records ?? []);
    setCursor(first.data?.next_cursor ?? null);
  }, [first.data]);

  const loadMore = async () => {
    if (!cursor) return;
    setMore(true);
    try {
      const page = await callTool("list_records", { type, text: query, limit: 50, cursor });
      setRows((r) => [...r, ...page.records]);
      setCursor(page.next_cursor ?? null);
    } finally {
      setMore(false);
    }
  };

  return (
    <>
      <Header title="Records" hint="Every business record behind the register. Nothing here can be edited or deleted, only reversed." />
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
          <select aria-label="Record type" className={inputClass + " max-w-56"} value={type} onChange={(e) => setType(e.target.value)}>
            {recordTypes.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <form
            className="flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              setQuery(text);
            }}
          >
            <input aria-label="Search records" className={inputClass + " max-w-sm"} placeholder="Search by number or name" value={text} onChange={(e) => setText(e.target.value)} onBlur={() => setQuery(text)} />
          </form>
          <span className="text-xs text-ink-3 tabular-nums">{rows.length} records</span>
        </div>
        {first.loading && rows.length === 0 ? (
          <Loading />
        ) : first.error ? (
          <ErrorNote error={first.error} onRetry={first.reload} />
        ) : rows.length === 0 ? (
          <Empty title="No records of this type" />
        ) : (
          <>
            <Table columns={recordColumns()} rows={rows} rowKey={(r) => r.id} onRow={setSelected} selected={selected?.id} />
            {cursor && (
              <div className="flex justify-center border-t border-line-soft py-3">
                <Button kind="ghost" small busy={more} onClick={loadMore}>
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </Card>
      <Drawer open={!!selected} onClose={() => setSelected(null)} title={selected ? recordTitle(selected) : ""}>
        {selected && <RecordDetail record={selected} tool="get_record" />}
      </Drawer>
    </>
  );
}
