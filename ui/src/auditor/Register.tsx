import { useEffect, useState } from "react";
import { callTool } from "../api";
import type { ViewProps } from "../App";
import { Button, Card, Chip, Empty, ErrorNote, Header, Loading, Pills, Status, cx } from "../ui";
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
  { value: "MATCHED", label: "Agrees" },
  { value: "FIELD_DIFFERENCE", label: "Differs" },
  { value: "NOT_IN_SYSTEM", label: "Not in system" },
  { value: "DUPLICATE_ROW", label: "Duplicates" },
] as const;

const reconLabel: Record<string, string> = {
  MATCHED: "Agrees",
  FIELD_DIFFERENCE: "Differs",
  NOT_IN_SYSTEM: "Not in system",
  MISSING_IN_REGISTER: "Missing in register",
  DUPLICATE_ROW: "Duplicate",
  ROW_ARITHMETIC: "Does not foot",
  REVERSED_IN_SYSTEM: "Reversed in system",
};

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
        hint="The client's register exactly as provided, with the auditor's marks pinned on the right."
        action={<Pills value={status} onChange={setStatus} options={filters.map((f) => ({ value: f.value, label: f.label }))} />}
      />
      <Card>
        {first.loading && rows.length === 0 ? (
          <Loading />
        ) : first.error ? (
          <ErrorNote error={first.error} onRetry={first.reload} />
        ) : rows.length === 0 ? (
          <Empty title={status ? "No rows have this status" : "The register is not imported yet"} hint={status ? undefined : "Run Import the register on the Overview tab."} />
        ) : (
          <>
            <div className="thin-scroll max-h-[68vh] overflow-auto">
              <table className="w-full text-[13px]">
                <thead className="sticky top-0 z-10 bg-paper">
                  <tr className="border-b border-line text-left text-xs text-ink-2">
                    <th className="px-3 py-2.5 font-medium">Row</th>
                    {columns.map((c) => (
                      <th key={c} className="px-3 py-2.5 font-medium whitespace-nowrap">
                        {c}
                      </th>
                    ))}
                    {/* The auditor's own columns stay pinned, so they are in view
                        however wide the client's register is. */}
                    <th className="sticky right-0 border-l border-line bg-brand-wash px-3 py-2.5 font-medium whitespace-nowrap text-brand">Auditor's marks</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const marked = !!r.recon_status && r.recon_status !== "MATCHED";
                    return (
                    <tr key={r.row_no} className={cx("border-b border-line-soft last:border-0", marked && "bg-mark")}>
                      <td className="px-3 py-2 text-ink-3 tabular-nums">{r.row_no}</td>
                      {columns.map((c) => (
                        <td key={c} className="px-3 py-2 whitespace-nowrap">
                          {r.raw[c] === null || r.raw[c] === undefined ? "" : String(r.raw[c])}
                        </td>
                      ))}
                      <td className={cx("sticky right-0 border-l border-line px-3 py-2", marked ? "bg-mark" : "bg-paper")}>
                        <div className="flex items-center gap-3 whitespace-nowrap">
                          <span className="w-[76px]">{r.rp_tag === "Related Party" ? <Chip tone="rp">Related</Chip> : r.rp_tag ? <span className="text-ink-2">Non related</span> : null}</span>
                          {r.suggested_rp && <Chip tone="warn" title={r.suggested_rp}>Suggested related</Chip>}
                          {r.recon_status && <Status tone={r.recon_status === "MATCHED" ? "good" : "bad"}>{reconLabel[r.recon_status] ?? r.recon_status.replace(/_/g, " ").toLowerCase()}</Status>}
                          {r.finding_ids?.length > 0 && (
                            <button className="text-xs font-medium text-brand hover:underline" onClick={() => goTo("findings", r.finding_ids[0])}>
                              {r.finding_ids.length} finding{r.finding_ids.length === 1 ? "" : "s"}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t border-line-soft px-4 py-3 text-xs text-ink-3">
              <span className="tabular-nums">{rows.length} rows</span>
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
