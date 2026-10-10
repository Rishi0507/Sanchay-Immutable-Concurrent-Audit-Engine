import { useEffect, useMemo, useState } from "react";
import { callTool, fileUrl, shortHash, when } from "../api";
import type { ViewProps } from "../App";
import { Button, Card, Column, Empty, ErrorNote, Mark, Pills, Status, Table, cx, useAction, useTool } from "../ui";
import { Columns, ink } from "./charts";
import { FieldGrid, LedgerRows, ListSkeleton, MoreBar, PageBrief, Panel, SearchBox, ViewHead, plural, spotlight } from "./kit";
import { ChainStrip } from "./motion";

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
const roleColor: Record<string, string> = { client_employee: ink.medium, auditor: "color-mix(in oklab, var(--color-brand) 70%, transparent)", audit_manager: ink.rp };
const dayKey = (ts: string) => {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? String(ts).slice(0, 10) : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const isRead = (tool: string) => /^(get_|list_|explain_|whoami|query_)/.test(tool);

export default function Trail({ pulse }: ViewProps) {
  const [rows, setRows] = useState<Entry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [role, setRole] = useState("");
  const [kind, setKind] = useState<"actions" | "all" | "problems">("all");
  const [query, setQuery] = useState("");
  const [day, setDay] = useState("");
  const [person, setPerson] = useState("");
  const [rowView, setRowView] = useState<"ledger" | "table">("ledger");
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState("");
  // The trail records this view's own reads, so it reloads on demand and on
  // activity by other users, not on every render.
  const first = useTool<{ entries: Entry[]; next_cursor: string | null; verification: any }>("get_audit_trail", { limit: 500 }, [pulse]);
  const { busy, run } = useAction();
  // The newest entries in order, for the chain strip.
  const links = useMemo(
    () =>
      [...(first.data?.entries ?? [])]
        .sort((a, b) => a.trail_seq - b.trail_seq)
        .slice(-10)
        .map((e) => ({
          seq: e.trail_seq,
          hash: e.hash,
          prev: e.prev_hash,
          title: e.tool.replace(/_/g, " "),
          who: `${roleLabel[e.role] ?? e.role}, ${new Date(e.ts).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`,
          ok: e.status === "ok",
        })),
    [first.data],
  );

  useEffect(() => {
    setRows(first.data?.entries ?? []);
    setCursor(first.data?.next_cursor ?? null);
  }, [first.data]);

  const loadMore = async () => {
    if (!cursor) return;
    setMore(true);
    try {
      const page = await callTool("get_audit_trail", { limit: 500, cursor });
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
  const total = Number(v?.checked ?? 0);

  // Asks the trail again; its answer carries a fresh verification of the whole chain.
  const verifyAgain = async () => {
    setChecking(true);
    const started = Date.now();
    await first.reload();
    const wait = Math.max(0, 1200 - (Date.now() - started));
    setTimeout(() => {
      setChecking(false);
      setCheckedAt(new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    }, window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : wait);
  };

  // One day of entries is drawn by hour, more than one by day.
  const hourly = useMemo(() => new Set(rows.map((e) => dayKey(e.ts))).size <= 1, [rows]);
  const slot = (ts: string) => {
    if (!hourly) return dayKey(ts);
    const d = new Date(ts);
    return `${dayKey(ts)}T${String(d.getHours()).padStart(2, "0")}`;
  };

  // Filters apply to the entries already loaded.
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter(
      (e) =>
        (!role || e.role === role) &&
        (!person || e.user === person) &&
        (!day || slot(e.ts) === day) &&
        (kind === "all" || (kind === "problems" ? e.status !== "ok" : !isRead(e.tool))) &&
        (!q || [e.user, e.tool, e.hash, String(e.trail_seq)].some((t) => (t ?? "").toLowerCase().includes(q))),
    );
  }, [rows, role, person, kind, query, day, hourly]); // eslint-disable-line react-hooks/exhaustive-deps

  // Loaded entries by day and by role, for the activity chart and the role split.
  const activity = useMemo(() => {
    const days = new Map<string, Record<string, number>>();
    const byRole = new Map<string, number>();
    for (const e of rows) {
      const d = slot(e.ts);
      const row = days.get(d) ?? {};
      row[e.role] = (row[e.role] ?? 0) + 1;
      days.set(d, row);
      if (!day || d === day) byRole.set(e.role, (byRole.get(e.role) ?? 0) + 1);
    }
    return {
      days: [...days.keys()].sort().slice(-31).map((d) => ({
        key: d,
        label: hourly ? `${d.slice(11)}:00` : new Date(d + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" }),
        parts: Object.keys(roleColor).map((r) => ({ key: r, label: roleLabel[r] ?? r, value: days.get(d)?.[r] ?? 0, color: roleColor[r] })),
      })),
      byRole,
    };
  }, [rows, day, hourly]); // eslint-disable-line react-hooks/exhaustive-deps

  const roles = [...new Set(rows.map((e) => e.role))];
  // Each identity's entries among those loaded, largest first.
  const people = useMemo(() => {
    const m = new Map<string, { user: string; role: string; n: number; refused: number }>();
    for (const e of rows) {
      const p = m.get(e.user) ?? { user: e.user, role: e.role, n: 0, refused: 0 };
      p.n++;
      if (e.status !== "ok") p.refused++;
      m.set(e.user, p);
    }
    return [...m.values()].sort((a, b) => b.n - a.n);
  }, [rows]);
  const busiest = activity.days.reduce<{ label: string; n: number } | null>((best, d) => {
    const n = d.parts.reduce((t, p) => t + p.value, 0);
    return n > 0 && (!best || n > best.n) ? { label: d.label, n } : best;
  }, null);
  const problems = rows.filter((e) => e.status !== "ok").length;

  const columns: Column<Entry>[] = [
    { key: "seq", label: "Entry", render: (e) => <span className="text-ink-3 tabular-nums">{e.trail_seq}</span>, width: "64px" },
    { key: "ts", label: "Time", render: (e) => <span className="whitespace-nowrap">{when(e.ts)}</span> },
    {
      key: "user",
      label: "Who",
      render: (e) => (
        <span>
          <span className="block text-ink">{e.user}</span>
          <span className="block text-xs text-ink-2">{roleLabel[e.role] ?? e.role}</span>
        </span>
      ),
    },
    { key: "tool", label: "Action", render: (e) => <span className={cx("font-mono text-xs", isRead(e.tool) ? "text-ink-2" : "text-ink")}>{e.tool}</span> },
    { key: "status", label: "Result", render: (e) => <Status tone={e.status === "ok" ? "good" : e.status === "permission_denied" ? "bad" : "warn"}>{resultLabel[e.status] ?? e.status.replace(/_/g, " ")}</Status> },
    {
      key: "hash",
      label: "Chained hash",
      render: (e) => (
        <span className="font-mono text-xs text-ink-2" title={`${e.hash}\nfollows ${e.prev_hash}`}>
          <span className="text-ink-3">{shortHash(e.prev_hash, 6)} → </span>
          {shortHash(e.hash, 10)}
        </span>
      ),
    },
  ];

  return (
    <>
      <ViewHead
        title="Audit trail"
        action={
          <Button kind="ghost" busy={busy === "export"} onClick={exportTrail}>
            Export the trail
          </Button>
        }
      />

      {v && (
        <PageBrief
          lead={v.ok ? `The trail is intact: ${total.toLocaleString("en-IN")} entries, each chained to the one before.` : `The trail breaks at entry ${v.first_bad_seq}.`}
          detail="Every action by every identity is recorded with a hash of the entry before it, so an edited or deleted entry breaks the chain. Refused attempts show what the audit side tried and was not allowed to do."
          stats={[
            { label: "Entries in the trail", value: total.toLocaleString("en-IN"), onClick: verifyAgain, hint: "Verify the whole chain again" },
            { label: "Loaded on this page", value: rows.length.toLocaleString("en-IN"), active: kind === "all" && !person && !day && !role && !query, onClick: () => {
              setKind("all");
              setPerson("");
              setDay("");
              setRole("");
              setQuery("");
            }, hint: "Show every loaded entry" },
            { label: "Refused attempts, latest entries", value: problems, tone: problems ? "bad" : undefined, active: kind === "problems", onClick: () => setKind(kind === "problems" ? "all" : "problems"), hint: "Show only refused attempts" },
            { label: "Identities that acted", value: people.length, onClick: () => spotlight("tr-who"), hint: "Go to who acted" },
          ]}
          guide={[
            { label: "The chain check", target: "tr-check" },
            { label: "When", target: "tr-activity" },
            { label: "Who", target: "tr-who" },
            { label: "Every entry", target: "tr-rows" },
          ]}
        />
      )}

      {/* Chapter 05 on the front page: sealed, so no one can change it. */}
      {links.length > 1 && (
        <Panel
          id="tr-chain"
          className="mb-5"
          title="The latest links of the chain"
          takeaway="Each entry names the hash of the one before it. The browser checks every link shown here, and a new entry slides in at the right as it happens."
          flush
        >
          <div className="px-5 pt-4 pb-3">
            <ChainStrip links={links} />
          </div>
        </Panel>
      )}

      {/* Chain integrity first: it is what makes the rest trustworthy. */}
      <div id="tr-check" />
      {v && (
        <div className={cx("mb-5 rounded-lg border px-5 py-4", checking ? "border-line bg-paper" : v.ok ? "border-line bg-pass-wash" : "border-fail/40 bg-fail-wash")}>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <span className={cx("flex h-9 w-9 items-center justify-center rounded-full bg-paper", checking ? "text-ink-3" : v.ok ? "text-pass" : "text-fail")}>
              {checking ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-pass" /> : <Mark tone={v.ok ? "good" : "bad"} size={18} />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-ink">{checking ? "Recomputing every hash in the chain" : v.ok ? "The trail is intact" : "The trail has been altered"}</span>
              <span className="block text-[14px] text-ink-2">
                {checking
                  ? "Each entry's hash is recomputed from the one before it."
                  : v.ok
                    ? `All ${total.toLocaleString("en-IN")} entries recomputed and verified${checkedAt ? `, last checked ${checkedAt}` : ""}.`
                    : `The chain breaks at entry ${v.first_bad_seq}. Entries from there on cannot be relied on.`}
              </span>
            </span>
            <Button kind="ghost" small busy={checking} onClick={verifyAgain}>
              Verify again
            </Button>
          </div>
          {checking && (
            <div className="mt-3 flex gap-1" aria-hidden>
              {Array.from({ length: 24 }, (_, i) => (
                <span key={i} className="chain-link h-1.5 flex-1 rounded-full bg-wash" style={{ animationDelay: `${i * 45}ms` }} />
              ))}
            </div>
          )}
        </div>
      )}

      {rows.length > 0 && <MoreBar group="tr" title="More analysis" items="When the activity happened, and each identity with its own count of actions and refusals." />}
      {rows.length > 0 && (
        <div id="tr-activity" data-more="tr" className="mb-5 grid gap-5 xl:grid-cols-[1fr_380px]">
          <Panel
            title={hourly ? "When did the activity happen?" : "Which days were busiest?"}
            takeaway={busiest ? `${busiest.label} was the busiest ${hourly ? "hour" : "day"}, with ${plural(busiest.n, "entry", "entries")}.` : undefined}
            meta={day ? <button onClick={() => setDay("")} className="font-medium text-brand hover:underline">Show all</button> : <span className="text-xs">Select a bar to filter</span>}
          >
            <Columns data={activity.days} height={190} format={(v) => plural(v, "entry", "entries")} axisFormat={(v) => (Number.isInteger(v) ? String(v) : "")} selected={day || undefined} onSelect={(d) => setDay(day === d ? "" : d)} />
          </Panel>
          <Panel id="tr-who" title="Who acted, and was anyone refused?" takeaway={`In the latest ${rows.length.toLocaleString("en-IN")} entries.`}>
            <button
              onClick={() => setKind(kind === "problems" ? "all" : "problems")}
              aria-pressed={kind === "problems"}
              className={cx("mb-4 flex w-full items-center gap-4 rounded-md border px-4 py-3 text-left transition-colors", kind === "problems" ? "border-ink bg-wash" : "border-line hover:bg-wash", problems ? "" : "")}
            >
              <span className={cx("amount text-[30px] leading-9", problems ? "text-fail" : "text-ink")}>{problems}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-semibold text-ink">Refused attempts</span>
                <span className="block text-xs text-ink-2">{problems ? "Actions the system turned away. Select to list them." : "Nothing was refused. Every action was allowed for its role."}</span>
              </span>
            </button>
            <ul className="space-y-1">
              {people.map((p) => (
                <li key={p.user}>
                  <button
                    onClick={() => setPerson(person === p.user ? "" : p.user)}
                    aria-pressed={person === p.user}
                    className={cx("grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-wash", person === p.user && "bg-wash", person && person !== p.user && "opacity-55")}
                  >
                    <span className="min-w-0 truncate text-[14px] text-ink">
                      {p.user} <span className="text-ink-3">{roleLabel[p.role] ?? p.role}</span>
                    </span>
                    <span className="num text-[14px] font-medium text-ink">
                      {p.n.toLocaleString("en-IN")}
                      {p.refused > 0 && <span className="ml-2 text-fail">{p.refused} refused</span>}
                    </span>
                    <span className="col-span-2 h-1.5 overflow-hidden rounded-full bg-wash">
                      <span className="grow-x block h-full rounded-full" style={{ width: `${(p.n / Math.max(1, people[0]?.n ?? 1)) * 100}%`, background: roleColor[p.role] ?? ink.muted }} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      )}

      <div id="tr-rows" className="toolbar mb-3">
        <div className="search">
          <SearchBox value={query} onChange={setQuery} label="Search the trail" placeholder="Search user, action, hash" />
        </div>
        <Pills
          value={kind}
          onChange={setKind}
          options={[
            { value: "actions", label: "Actions" },
            { value: "problems", label: "Refused", count: problems },
            { value: "all", label: "Everything" },
          ]}
        />
        <select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value)} className="h-9 rounded-md border border-line bg-paper px-2.5 text-sm text-ink outline-none transition-colors hover:border-ink-3 focus:border-brand">
          <option value="">Every role</option>
          {roles.map((r) => (
            <option key={r} value={r}>
              {roleLabel[r] ?? r}
            </option>
          ))}
        </select>
        <span className="ml-auto order-last">
          <Pills value={rowView} onChange={setRowView} options={[{ value: "ledger", label: "Ledger" }, { value: "table", label: "Table" }]} />
        </span>
        <span className="text-[14px] text-ink-2">
          {plural(shown.length, "entry", "entries")} shown; <span className="num">{rows.length.toLocaleString("en-IN")}</span> loaded of <span className="num">{total.toLocaleString("en-IN")}</span> entries in the trail
        </span>
        {person && (
          <button onClick={() => setPerson("")} className="text-[14px] font-medium text-brand hover:underline">
            Show every identity
          </button>
        )}
      </div>

      <Card>
        {first.loading && rows.length === 0 ? (
          <ListSkeleton rows={8} />
        ) : first.error ? (
          <ErrorNote error={first.error} onRetry={first.reload} />
        ) : rows.length === 0 ? (
          <Empty title="No entries yet" />
        ) : shown.length === 0 ? (
          <Empty title="No loaded entries match" hint={kind === "actions" ? "Reads are hidden. Choose Everything to see them." : undefined} />
        ) : (
          rowView === "table" ? (
            <Table columns={columns} rows={shown} rowKey={(e) => String(e.trail_seq)} marked={(e) => e.status === "permission_denied"} />
          ) : (
            <div className="thin-scroll max-h-[640px] overflow-auto">
              <LedgerRows
                items={shown.slice(0, 300).map((e) => ({
                  key: String(e.trail_seq),
                  rail: e.status === "ok" ? (isRead(e.tool) ? "var(--color-line)" : roleColor[e.role] ?? "var(--color-ink-3)") : "var(--color-fail)",
                  group: new Date(e.ts).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" }),
                  title: (
                    <>
                      <span className={cx("font-mono text-xs", isRead(e.tool) ? "text-ink-2" : "text-ink")}>{e.tool}</span>
                      <span className="ml-2 font-normal text-ink-2">
                        {e.user}, {roleLabel[e.role] ?? e.role}
                      </span>
                    </>
                  ),
                  meta: `Entry ${e.trail_seq}, ${new Date(e.ts).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`,
                  status: <Status tone={e.status === "ok" ? "good" : e.status === "permission_denied" ? "bad" : "warn"}>{resultLabel[e.status] ?? e.status.replace(/_/g, " ")}</Status>,
                  detail: (
                    <>
                      <FieldGrid
                        fields={[
                          ["Entry", e.trail_seq],
                          ["Time", when(e.ts)],
                          ["Who", e.user],
                          ["Role", roleLabel[e.role] ?? e.role],
                          ["Action", <span className="font-mono text-xs">{e.tool}</span>],
                          ["Result", resultLabel[e.status] ?? e.status],
                          ["Engagement", e.engagement_id ? <span className="font-mono text-xs">{e.engagement_id}</span> : undefined],
                        ]}
                      />
                      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line-soft pt-3 font-mono text-xs">
                        <span className="text-ink-3">Chained from</span>
                        <span className="break-all text-ink-2">{e.prev_hash}</span>
                        <span className="text-ink-3" aria-hidden>
                          →
                        </span>
                        <span className="break-all text-ink">{e.hash}</span>
                      </div>
                    </>
                  ),
                }))}
              />
              {shown.length > 300 && <p className="px-5 py-3 text-xs text-ink-2">Showing the latest 300 of {shown.length} matching entries. Narrow the filters, or use the table, to see the rest.</p>}
            </div>
          )
        )}
        {cursor && rows.length > 0 && (
          <div className="flex items-center justify-between border-t border-line-soft px-4 py-3 text-xs text-ink-3">
            <span>Filters apply to the {rows.length} entries loaded.</span>
            <Button kind="ghost" small busy={more} onClick={loadMore}>
              Load older entries
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}
