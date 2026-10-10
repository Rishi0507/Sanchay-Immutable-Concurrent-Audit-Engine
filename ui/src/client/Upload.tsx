import { useRef, useState } from "react";
import { callTool, idempotencyKey, uploadFile, when } from "../api";
import type { ViewProps } from "../App";
import { Button, Card, Field, Header, Status, inputClass, toast, useAction, useTool } from "../ui";

// Financial year that contains today, April to March.
function defaultPeriod(): [string, string] {
  const now = new Date();
  const startYear = now.getMonth() >= 3 ? now.getFullYear() - 1 : now.getFullYear() - 2;
  return [`${startYear}-04-01`, `${startYear + 1}-03-31`];
}

// Reads a related-party list from CSV with a header row. Recognised columns:
// name, pan, gstin, relationship, effective_from.
function parseParties(text: string) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return [];
  const split = (line: string) => line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
  const header = split(lines[0]).map((h) => h.toLowerCase().replace(/[^a-z]/g, "_"));
  const find = (...names: string[]) => header.findIndex((h) => names.some((n) => h.includes(n)));
  const col = {
    name: find("name", "party"),
    pan: find("pan"),
    gstin: find("gstin", "gst"),
    relationship: find("relation"),
    effective_from: find("effective", "from", "date"),
  };
  return lines
    .slice(1)
    .map(split)
    .map((cells) => {
      const get = (i: number) => (i >= 0 ? cells[i] ?? "" : "");
      const party: Record<string, string> = { name: get(col.name) };
      for (const key of ["pan", "gstin", "relationship", "effective_from"] as const) {
        const v = get(col[key]);
        if (v) party[key] = v;
      }
      return party;
    })
    .filter((p) => p.name);
}

export default function Upload({ pulse }: ViewProps) {
  const [start, end] = defaultPeriod();
  const [periodStart, setPeriodStart] = useState(start);
  const [periodEnd, setPeriodEnd] = useState(end);
  const registerInput = useRef<HTMLInputElement>(null);
  const partiesInput = useRef<HTMLInputElement>(null);
  const { busy, run } = useAction();

  const registers = useTool("list_records", { type: "sales_register", limit: 500 }, [pulse]);
  const partyLists = useTool("list_records", { type: "related_party_list", limit: 500 }, [pulse]);
  const lastRegister = registers.data?.records?.at(-1);
  const lastParties = partyLists.data?.records?.at(-1);

  const sendRegister = (file: File) =>
    run("register", async () => {
      const stored = await uploadFile(file);
      await callTool("upload_sales_register", {
        file_hash: stored.file_hash,
        file_name: file.name,
        period_start: periodStart,
        period_end: periodEnd,
        idempotency_key: idempotencyKey("register"),
      });
      toast("Sales register uploaded. The auditor has been notified.");
      registers.reload();
    });

  const generateRegister = () =>
    run("generate", async () => {
      const exported = await callTool("export_sales_register", { period_start: periodStart, period_end: periodEnd });
      await callTool("upload_sales_register", {
        file_hash: exported.file_hash,
        file_name: exported.file_name,
        period_start: periodStart,
        period_end: periodEnd,
        idempotency_key: idempotencyKey("register"),
      });
      toast(`Register with ${exported.row_count} rows uploaded. The auditor has been notified.`);
      registers.reload();
    });

  const sendParties = (file: File) =>
    run("parties", async () => {
      const parties = parseParties(await file.text());
      if (parties.length === 0) throw new Error("No parties were found. The file needs a header row with a name column.");
      const stored = await uploadFile(file);
      await callTool("upload_related_parties", {
        as_of: periodEnd,
        file_hash: stored.file_hash,
        file_name: file.name,
        parties,
        idempotency_key: idempotencyKey("parties"),
      });
      toast(`${parties.length} related parties uploaded. The auditor has been notified.`);
      partyLists.reload();
    });

  return (
    <>
      <Header title="Upload" hint="Send the auditor your sales register and your list of related parties for the period." />
      <div className="mb-6 flex flex-wrap items-end gap-4">
        <Field label="Period start">
          <input type="date" className={inputClass} value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
        </Field>
        <Field label="Period end">
          <input type="date" className={inputClass} value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
        </Field>
      </div>
      <div className="grid gap-5 md:grid-cols-2">
        <Card className="p-6">
          <div className="mb-1 flex items-center justify-between">
            <div className="text-base font-semibold">Sales register</div>
            <Status tone={lastRegister ? "good" : "warn"}>{lastRegister ? "Uploaded" : "Not uploaded yet"}</Status>
          </div>
          <div className="mb-5 min-h-5 text-sm text-ink-2">
            {lastRegister ? `${lastRegister.data.file_name}, ${when(lastRegister.recorded_at)}` : "Excel or CSV, in the layout you already export."}
          </div>
          <input ref={registerInput} type="file" accept=".xlsx,.csv" hidden onChange={(e) => e.target.files?.[0] && sendRegister(e.target.files[0])} />
          <div className="flex gap-2">
            <Button busy={busy === "register"} onClick={() => registerInput.current?.click()}>
              Upload a file
            </Button>
            <Button kind="ghost" busy={busy === "generate"} onClick={generateRegister}>
              Build from the records
            </Button>
          </div>
        </Card>
        <Card className="p-6">
          <div className="mb-1 flex items-center justify-between">
            <div className="text-base font-semibold">Related parties</div>
            <Status tone={lastParties ? "good" : "warn"}>{lastParties ? "Uploaded" : "Not uploaded yet"}</Status>
          </div>
          <div className="mb-5 min-h-5 text-sm text-ink-2">
            {lastParties
              ? `${lastParties.data.parties?.length ?? 0} parties, ${when(lastParties.recorded_at)}`
              : "CSV with the columns name, pan, gstin, relationship, effective_from."}
          </div>
          <input ref={partiesInput} type="file" accept=".csv" hidden onChange={(e) => e.target.files?.[0] && sendParties(e.target.files[0])} />
          <Button busy={busy === "parties"} onClick={() => partiesInput.current?.click()}>
            Upload a file
          </Button>
        </Card>
      </div>
    </>
  );
}
