import { useEffect, useState } from "react";
import { callTool } from "../api";
import type { ViewProps } from "../App";
import { Button, Card, Chip, Empty, ErrorNote, Header, Loading, Pills, cx, toneFor } from "../ui";
import { useTool } from "../ui";

interface Row {
  row_no: number;
  raw: Record<string, any>;
  rp_tag?: string;
  suggested_rp?: string;
  recon_status?: string;
  finding_ids: string[];
}

const filters = [
  { value: "", label: "All" },
  { value: "MATCHED", label: "Matched" },
  { value: "FIELD_DIFFERENCE", label: "Differences" },
  { value: "NOT_IN_SYSTEM", label: "Not in system" },
  { value: "DUPLICATE_ROW", label: "Duplicates" },
] as const;

function reconTone(status?: string) {
  if (!status) return "neutral" as const;
  return status === "MATCHED" ? ("good" as const) : ("bad" as const);
}

export default function Register({ pulse, goTo }: ViewProps) {
  const [status, setStatus] = useState<string>("");
  const [rows, setRows] = useState<Row[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const first = useTool<{ columns: string[]; rows: Row[]; next_cursor: string | null }>("get_register_rows", { recon_status: status, limit: 100 }, [pulse]);

  useEffect(() => {
    setRows(first.data?.rows ?? []);
    setCursor(first.data?.next_cursor ?? null);
  }, [first.data]);

  const columns = first.data?.columns ?? (rows[0] ? Object.keys(rows[0].raw) : []);

  const loadMore = async () => {
    if (!cursor) return;
    setMore(true);
    try {
      const page = await callTool("get_register_rows", { recon_status: status, limit: 100, cursor });
      setRows((r) => [...r, ...page.rows]);
      setCursor(page.next_cursor ?? null);
    } finally {
      setMore(false);
    }
  };

  return (
    <>
      <Header
        title="Register"
        hint="The client's sales register exactly as provided. Added columns are on the right."
        action={<Pills value={status} onChange={setStatus} options={filters.map((f) => ({ value: f.value, label: f.label }))} />}
      />
      <Card>
        {first.loading && rows.length === 0 ? (
          <Loading />
        ) : first.error ? (
          <ErrorNote error={first.error} onRetry={first.reload} />
        ) : rows.length === 0 ? (
          <Empty title="No rows" hint={status ? "No rows have this status." : "Import the register from the Overview tab."} />
        ) : (
          <>
            <div className="thin-scroll max-h-[68vh] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10 bg-white">
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-3 py-3 font-medium">#</th>
                    {columns.map((c) => (
                      <th key={c} className="px-3 py-3 font-medium whitespace-nowrap">
                        {c}
                      </th>
                    ))}
                    <th className="border-l border-slate-200 bg-indigo-50/60 px-3 py-3 font-medium whitespace-nowrap text-indigo-700">Related / Non Related</th>
                    <th className="bg-indigo-50/60 px-3 py-3 font-medium whitespace-nowrap text-indigo-700">Suggested RP</th>
                    <th className="bg-indigo-50/60 px-3 py-3 font-medium whitespace-nowrap text-indigo-700">Recon</th>
                    <th className="bg-indigo-50/60 px-3 py-3 font-medium whitespace-nowrap text-indigo-700">Findings</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.row_no} className={cx("border-b border-slate-100 last:border-0", r.recon_status && r.recon_status !== "MATCHED" && "bg-amber-50/40")}>
                      <td className="px-3 py-2 text-slate-400 tabular-nums">{r.row_no}</td>
                      {columns.map((c) => (
                        <td key={c} className="px-3 py-2 whitespace-nowrap">
                          {r.raw[c] === null || r.raw[c] === undefined ? "" : String(r.raw[c])}
                        </td>
                      ))}
                      <td className="border-l border-slate-200 px-3 py-2">{r.rp_tag && <Chip tone={toneFor(r.rp_tag)}>{r.rp_tag}</Chip>}</td>
                      <td className="px-3 py-2">{r.suggested_rp && <Chip tone="warn">{r.suggested_rp}</Chip>}</td>
                      <td className="px-3 py-2">{r.recon_status && <Chip tone={reconTone(r.recon_status)}>{r.recon_status.replace(/_/g, " ").toLowerCase()}</Chip>}</td>
                      <td className="px-3 py-2">
                        {r.finding_ids?.length > 0 && (
                          <button className="text-xs font-medium text-indigo-600 hover:underline" onClick={() => goTo("findings", r.finding_ids[0])}>
                            {r.finding_ids.length} finding{r.finding_ids.length === 1 ? "" : "s"}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3 text-xs text-slate-400">
              <span className="tabular-nums">{rows.length} rows shown</span>
              {cursor && (
                <Button kind="ghost" small busy={more} onClick={loadMore}>
                  Load more
                </Button>
              )}
            </div>
          </>
        )}
      </Card>
    </>
  );
}
