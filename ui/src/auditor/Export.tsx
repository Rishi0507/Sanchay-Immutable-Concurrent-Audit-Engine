import { useState } from "react";
import { callTool, fileUrl, money, shortHash } from "../api";
import type { ViewProps } from "../App";
import { Button, Card, Header, toast, useAction } from "../ui";

interface FileRef {
  file_hash: string;
  file_name: string;
  content_type?: string;
}

function Download({ file }: { file: FileRef }) {
  return (
    <a
      href={fileUrl(file.file_hash, file.file_name)}
      className="flex items-center justify-between gap-4 rounded-md border border-line px-3.5 py-2.5 text-sm transition-colors hover:border-brand/50 hover:bg-brand-wash"
    >
      <span className="flex min-w-0 items-center gap-2 font-medium text-brand">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M8 2.5v8M4.5 7.5L8 11l3.5-3.5M3 13.5h10" />
        </svg>
        <span className="truncate">{file.file_name}</span>
      </span>
      <span className="font-mono text-xs text-ink-3" title="SHA-256 of the file">{shortHash(file.file_hash, 10)}</span>
    </a>
  );
}

export default function Export(_: ViewProps) {
  const [workpaper, setWorkpaper] = useState<any>(null);
  const [memo, setMemo] = useState<any>(null);
  const { busy, run } = useAction();

  const makeWorkpaper = () =>
    run("workpaper", async () => {
      setWorkpaper(await callTool("export_workpaper", {}));
      toast("Workpaper exported.");
    });

  const makeMemo = () =>
    run("memo", async () => {
      setMemo(await callTool("draft_findings_memo", {}));
      toast("Findings memo drafted.");
    });

  return (
    <>
      <Header title="Export" hint="Both files are produced from the snapshot and state the ledger hash they rest on." />
      <div className="grid gap-5 md:grid-cols-2">
        <Card className="p-6">
          <div className="text-base font-semibold">Workpaper</div>
          <p className="mt-1 mb-5 text-[13px] text-ink-2">Excel file with these sheets: {(workpaper?.sheets ?? ["Sales Register", "Sales TOD", "Sales Cut-off TOD", "Credit Note TOD"]).join(", ")}.</p>
          {workpaper?.file && (
            <div className="mb-4">
              <Download file={workpaper.file} />
            </div>
          )}
          <Button busy={busy === "workpaper"} kind={workpaper ? "ghost" : "primary"} onClick={makeWorkpaper}>
            {workpaper ? "Export again" : "Export the workpaper"}
          </Button>
        </Card>
        <Card className="p-6">
          <div className="text-base font-semibold">Findings memo</div>
          <p className="mt-1 mb-5 text-[13px] text-ink-2">
            {memo
              ? `${memo.findings} findings, with proposed adjustments of ₹ ${money(memo.total_adjustment)} in total.`
              : "Each finding with its impact, proposed adjusting entry and evidence, and a statement of ledger integrity."}
          </p>
          {memo?.files?.length > 0 && (
            <div className="mb-4 space-y-2">
              {memo.files.map((f: FileRef) => (
                <Download key={f.file_hash} file={f} />
              ))}
            </div>
          )}
          <Button busy={busy === "memo"} kind="ghost" onClick={makeMemo}>
            {memo ? "Draft again" : "Draft the memo"}
          </Button>
        </Card>
      </div>
    </>
  );
}
