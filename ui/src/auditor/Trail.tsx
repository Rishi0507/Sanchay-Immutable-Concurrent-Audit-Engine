import { useEffect, useState } from "react";
import { callTool, fileUrl, shortHash, when } from "../api";
import type { ViewProps } from "../App";
import { Button, Card, Chip, Column, Empty, ErrorNote, Header, Loading, Table, toneFor, useAction, useTool } from "../ui";

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

const roleLabel: Record<string, string> = { client_employee: "Client", auditor: "Auditor", audit_manager: "Manager" };

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
    { key: "seq", label: "#", render: (e) => <span className="text-slate-400 tabular-nums">{e.trail_seq}</span>, width: "64px" },
    { key: "ts", label: "Time", render: (e) => <span className="whitespace-nowrap">{when(e.ts)}</span> },
    { key: "user", label: "Identity", render: (e) => e.user },
    { key: "role", label: "Role", render: (e) => <Chip tone={e.role === "client_employee" ? "neutral" : "accent"}>{roleLabel[e.role] ?? e.role}</Chip> },
    { key: "tool", label: "Tool", render: (e) => <span className="font-mono text-xs">{e.tool}</span> },
    { key: "status", label: "Result", render: (e) => <Chip tone={e.status === "ok" ? "good" : e.status === "permission_denied" ? "bad" : "warn"}>{e.status.replace(/_/g, " ")}</Chip> },
    { key: "hash", label: "Hash", render: (e) => <span className="font-mono text-xs text-slate-500" title={e.hash}>{shortHash(e.hash, 12)}</span> },
  ];

  return (
    <>
      <Header
        title="Trail"
        hint="Every tool call by every identity, chained by hash."
        action={
          <div className="flex items-center gap-3">
            {v && (
              <Chip tone={toneFor(v.ok ? "ok" : "failed")}>
                {v.ok ? `Chain verified · ${v.checked} entries` : `Chain broken at ${v.first_bad_seq}`}
              </Chip>
            )}
            <Button kind="ghost" busy={busy === "export"} onClick={exportTrail}>
              Export
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
            <Table columns={columns} rows={rows} rowKey={(e) => String(e.trail_seq)} />
            {cursor && (
              <div className="flex justify-center border-t border-slate-100 py-3">
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
