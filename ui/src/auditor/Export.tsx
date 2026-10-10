import { useState } from "react";
import { callTool, fileUrl, money, shortHash } from "../api";
import type { ViewProps } from "../App";
import { Button, Card, Chip, Header, toast, useAction } from "../ui";

interface FileRef {
  file_hash: string;
  file_name: string;
  content_type?: string;
}

function Download({ file }: { file: FileRef }) {
  return (
    <a
      href={fileUrl(file.file_hash, file.file_name)}
      className="flex items-center justify-between rounded-xl border border-slate-200 px-4 py-3 text-sm transition-colors hover:border-indigo-300 hover:bg-indigo-50"
    >
      <span className="font-medium text-slate-800">{file.file_name}</span>
      <span className="font-mono text-xs text-slate-400">{shortHash(file.file_hash, 10)}</span>
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
      toast("Workpaper produced.");
    });

  const makeMemo = () =>
    run("memo", async () => {
      setMemo(await callTool("draft_findings_memo", {}));
      toast("Findings memo produced.");
    });

  return (
    <>
      <Header title="Export" hint="Outputs are produced from the engagement's snapshot and state the ledger hash they rest on." />
      <div className="grid gap-5 md:grid-cols-2">
        <Card className="p-6">
          <div className="mb-1 text-base font-semibold">Workpaper</div>
          <div className="mb-4 flex flex-wrap gap-1.5">
            {(workpaper?.sheets ?? ["Sales Register", "Sales TOD", "Sales Cut-off TOD", "Credit Note TOD"]).map((s: string) => (
              <Chip key={s}>{s}</Chip>
            ))}
          </div>
          {workpaper?.file && (
            <div className="mb-4">
              <Download file={workpaper.file} />
            </div>
          )}
          <Button busy={busy === "workpaper"} kind={workpaper ? "ghost" : "primary"} onClick={makeWorkpaper}>
            {workpaper ? "Produce again" : "Produce workpaper"}
          </Button>
        </Card>
        <Card className="p-6">
          <div className="mb-1 text-base font-semibold">Findings memo</div>
          <div className="mb-4 flex flex-wrap gap-1.5">
            {memo ? (
              <>
                <Chip>{memo.findings} findings</Chip>
                <Chip>Adjustment ₹ {money(memo.total_adjustment)}</Chip>
              </>
            ) : (
              <>
                <Chip>Impact</Chip>
                <Chip>Proposed adjustments</Chip>
                <Chip>Integrity statement</Chip>
              </>
            )}
          </div>
          {memo?.files?.length > 0 && (
            <div className="mb-4 space-y-2">
              {memo.files.map((f: FileRef) => (
                <Download key={f.file_hash} file={f} />
              ))}
            </div>
          )}
          <Button busy={busy === "memo"} kind={memo ? "ghost" : "primary"} onClick={makeMemo}>
            {memo ? "Produce again" : "Produce memo"}
          </Button>
        </Card>
      </div>
    </>
  );
}
