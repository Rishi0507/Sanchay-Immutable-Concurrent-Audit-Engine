import { useEffect, useState } from "react";
import { callTool, fileUrl, shortHash, when } from "../api";
import type { ViewProps } from "../App";
import { Button, Card, Column, Empty, ErrorNote, Header, Loading, Status, Table, useAction, useTool } from "../ui";

interface Entry {
  trail_seq: number;
  ts: string;
  user: string;
  role: string;
  tool: string;
  status: string;
  engagement_id?: string;
  prev_hash: string;
  hash: string;
}

const roleLabel: Record<string, string> = { client_employee: "Client", auditor: "Auditor", audit_manager: "Audit manager" };
const resultLabel: Record<string, string> = { ok: "Done", permission_denied: "Denied", validation_failed: "Rejected input", no_engagement: "No engagement", not_found: "Not found" };

export default function Trail({ pulse }: ViewProps) {
  const [rows, setRows] = useState<Entry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  // The trail records this view's own reads, so it reloads on demand and on
  // activity by other users, not on every render.
  const first = useTool<{ entries: Entry[]; next_cursor: string | null; verification: any }>("get_audit_trail", { limit: 100 }, [pulse]);
  const { busy, run } = useAction();

  useEffect(() => {
    setRows(first.data?.entries ?? []);
    setCursor(first.data?.next_cursor ?? null);
  }, [first.data]);

  const loadMore = async () => {
    if (!cursor) return;
    setMore(true);
    try {
      const page = await callTool("get_audit_trail", { limit: 100, cursor });
      setRows((r) => [...r, ...page.entries]);
      setCursor(page.next_cursor ?? null);
    } finally {
      setMore(false);
    }
  };

  const exportTrail = () =>
    run("export", async () => {
      const file = await callTool("get_audit_trail", { export: true });
      window.location.href = fileUrl(file.file_hash, file.file_name);
    });

  const v = first.data?.verification;

  const columns: Column<Entry>[] = [
    { key: "seq", label: "Entry", render: (e) => <span className="text-ink-3 tabular-nums">{e.trail_seq}</span>, width: "64px" },
    { key: "ts", label: "Time", render: (e) => <span className="whitespace-nowrap">{when(e.ts)}</span> },
    { key: "user", label: "Who", render: (e) => e.user },
    { key: "role", label: "Role", render: (e) => <span className="text-ink-2">{roleLabel[e.role] ?? e.role}</span> },
    { key: "tool", label: "Action", render: (e) => <span className="font-mono text-xs">{e.tool}</span> },
    { key: "status", label: "Result", render: (e) => <Status tone={e.status === "ok" ? "good" : e.status === "permission_denied" ? "bad" : "warn"}>{resultLabel[e.status] ?? e.status.replace(/_/g, " ")}</Status> },
    { key: "hash", label: "Hash", render: (e) => <span className="font-mono text-xs text-ink-2" title={e.hash}>{shortHash(e.hash, 12)}</span> },
  ];

  return (
    <>
      <Header
        title="Trail"
        hint="Every action by every identity, each chained to the one before by its hash."
        action={
          <div className="flex items-center gap-3">
            {v && (
              <Status tone={v.ok ? "good" : "bad"}>{v.ok ? `All ${v.checked} entries verify` : `Chain broken at entry ${v.first_bad_seq}`}</Status>
            )}
            <Button kind="ghost" busy={busy === "export"} onClick={exportTrail}>
              Export the trail
            </Button>
          </div>
        }
      />
      <Card>
        {first.loading && rows.length === 0 ? (
          <Loading />
        ) : first.error ? (
          <ErrorNote error={first.error} onRetry={first.reload} />
        ) : rows.length === 0 ? (
          <Empty title="No entries yet" />
        ) : (
          <>
            <Table columns={columns} rows={rows} rowKey={(e) => String(e.trail_seq)} marked={(e) => e.status === "permission_denied"} />
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
    </>
  );
}
