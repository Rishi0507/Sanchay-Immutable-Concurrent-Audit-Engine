// Two things a visitor can check without trusting the page.
//
// 1. A real hash chain, computed in the browser with SHA-256. Change one
//    amount and verification fails from that record on. The same rule
//    protects the ledger: hash_n = SHA256(hash_(n-1) || record_n).
// 2. The actual ledger of this deployment, recomputed on request.

import { useEffect, useState } from "react";
import { callToolAs, money, shortHash } from "../api";
import { Mark, cx } from "../ui";
import { proofRecords } from "./data";
import { Source } from "./parts";
import { story } from "./store";

const GENESIS = "0".repeat(64);
const DEMO_AUDITOR = "auditor-demo-token";
// Where the six records sit on the 22-block chain in the scene.
const FIRST_BLOCK = 8;

async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function canonical(r: { seq: number; invoiceNo: string; amount: number }) {
  return JSON.stringify({ amount: Math.round(r.amount * 100), invoice_no: r.invoiceNo, seq: r.seq });
}

async function chain(records: { seq: number; invoiceNo: string; amount: number }[]) {
  const out: string[] = [];
  let prev = GENESIS;
  for (const r of records) {
    prev = await sha256(prev + canonical(r));
    out.push(prev);
  }
  return out;
}

export default function Proof() {
  const [amounts, setAmounts] = useState(proofRecords.map((r) => r.amount));
  const [stored, setStored] = useState<string[]>([]);
  const [now, setNow] = useState<string[]>([]);
  const [live, setLive] = useState<{ state: "idle" | "running" | "done" | "failed"; data?: any; ms?: number }>({ state: "idle" });
  const supported = typeof crypto !== "undefined" && !!crypto.subtle;

  // The hashes recorded when the records were first written.
  useEffect(() => {
    if (supported) chain(proofRecords).then(setStored);
  }, [supported]);

  // The hashes recomputed from what the records say now.
  useEffect(() => {
    if (!supported) return;
    chain(proofRecords.map((r, i) => ({ ...r, amount: amounts[i] }))).then(setNow);
  }, [amounts, supported]);

  const firstBad = stored.length && now.length ? stored.findIndex((h, i) => h !== now[i]) : -1;

  // The gold chain in the scene follows this table.
  useEffect(() => {
    story.brokenAt = firstBad >= 0 ? FIRST_BLOCK + firstBad : -1;
    return () => {
      story.brokenAt = -1;
    };
  }, [firstBad]);

  const verifyLive = async () => {
    setLive({ state: "running" });
    const begin = performance.now();
    try {
      const data = await callToolAs(DEMO_AUDITOR, "verify_ledger_integrity", {});
      setLive({ state: "done", data, ms: Math.round(performance.now() - begin) });
    } catch {
      setLive({ state: "failed" });
    }
  };

  return (
    <div className="grid gap-px overflow-hidden rounded-lg border border-line bg-line lg:grid-cols-[1.5fr_1fr]">
      <div className="bg-paper/92 p-6 backdrop-blur-sm md:p-8">
        <div className="mb-1 flex items-center justify-between gap-4">
          <h3 className="text-[17px] font-semibold">Break a chain in your browser</h3>
          <Source kind="Live" />
        </div>
        <p className="mb-5 max-w-lg text-[13px] text-ink-2">Six records, hashed here with SHA-256. Each hash includes the one before it. Change any amount and watch what no longer verifies.</p>

        {supported ? (
          <div className="thin-scroll overflow-x-auto">
            <table className="w-full min-w-[520px] text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-xs text-ink-2">
                  <th className="py-2 pr-3 font-medium">Record</th>
                  <th className="py-2 pr-3 font-medium">Invoice</th>
                  <th className="py-2 pr-3 text-right font-medium">Amount, ₹</th>
                  <th className="py-2 pr-3 font-medium">Recomputed hash</th>
                  <th className="py-2 font-medium">Verifies</th>
                </tr>
              </thead>
              <tbody>
                {proofRecords.map((r, i) => {
                  const ok = stored[i] !== undefined && stored[i] === now[i];
                  const edited = amounts[i] !== r.amount;
                  return (
                    <tr key={r.seq} className={cx("border-b border-line-soft last:border-0 transition-colors duration-200", !ok && stored.length > 0 && "bg-mark")}>
                      <td className="figure py-2 pr-3 text-ink-3">{r.seq}</td>
                      <td className="py-2 pr-3">
                        <div className="figure">{r.invoiceNo}</div>
                        <div className="text-xs text-ink-3">{r.customer}</div>
                      </td>
                      <td className="py-2 pr-3 text-right">
                        <input
                          aria-label={`Amount of record ${r.seq}`}
                          inputMode="numeric"
                          value={amounts[i]}
                          onChange={(e) => {
                            const n = Number(e.target.value.replace(/[^0-9]/g, ""));
                            setAmounts((a) => a.map((v, j) => (j === i ? n : v)));
                          }}
                          className={cx(
                            "figure h-8 w-28 rounded-md border bg-transparent px-2 text-right outline-none transition-colors focus:border-brand",
                            edited ? "border-fail text-fail" : "border-line hover:border-ink-3",
                          )}
                        />
                      </td>
                      <td className={cx("figure py-2 pr-3 text-xs", ok ? "text-ink-2" : "text-fail")}>{shortHash(now[i], 14)}</td>
                      <td className="py-2">
                        {stored.length > 0 && (
                          <span className={cx("inline-flex items-center gap-1.5 font-medium", ok ? "text-pass" : "text-fail")}>
                            <Mark tone={ok ? "good" : "bad"} />
                            {ok ? "Yes" : "No"}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-[13px] text-ink-2">This browser does not allow hashing on an insecure address. Open the page over HTTPS or on localhost to run it.</p>
        )}

        <div className="mt-5 flex min-h-10 flex-wrap items-center justify-between gap-3" aria-live="polite">
          <p className={cx("text-sm", firstBad >= 0 ? "text-fail" : "text-ink-2")}>
            {firstBad >= 0
              ? `Record ${firstBad + 1} was altered. ${proofRecords.length - firstBad === 1 ? "It no longer verifies." : `It and the ${proofRecords.length - firstBad - 1} after it no longer verify.`}`
              : `All six verify. Total ₹ ${money(amounts.reduce((a, b) => a + b, 0))}.`}
          </p>
          {firstBad >= 0 && (
            <button onClick={() => setAmounts(proofRecords.map((r) => r.amount))} className="text-sm font-medium text-brand hover:text-brand-deep">
              Restore the original amounts
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-col bg-paper/92 p-6 backdrop-blur-sm md:p-8">
        <div className="mb-1 flex items-center justify-between gap-4">
          <h3 className="text-[17px] font-semibold">Recompute this ledger</h3>
          <Source kind="Live" />
        </div>
        <p className="mb-6 text-[13px] text-ink-2">Asks the running system to recompute every hash in its business ledger and its audit trail, as the demo auditor.</p>

        <div className="mb-6 min-h-[124px]" aria-live="polite">
          {live.state === "done" && live.data && (
            <dl className="space-y-3">
              <div className="flex items-baseline justify-between gap-4 border-b border-line-soft pb-3">
                <dt className="text-[13px] text-ink-2">Ledger events recomputed</dt>
                <dd className="figure text-2xl">{Number(live.data.business_chain?.checked ?? 0).toLocaleString("en-IN")}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 border-b border-line-soft pb-3">
                <dt className="text-[13px] text-ink-2">Trail entries recomputed</dt>
                <dd className="figure text-2xl">{Number(live.data.trail_chain?.checked ?? 0).toLocaleString("en-IN")}</dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className={cx("inline-flex items-center gap-1.5 text-sm font-medium", live.data.ok ? "text-pass" : "text-fail")}>
                  <Mark tone={live.data.ok ? "good" : "bad"} />
                  {live.data.ok ? "Every hash verifies" : `Altered at record ${live.data.business_chain?.first_bad_seq ?? live.data.trail_chain?.first_bad_seq}`}
                </dt>
                <dd className="figure text-xs text-ink-3">{live.ms} ms</dd>
              </div>
            </dl>
          )}
          {live.state === "failed" && <p className="text-[13px] text-ink-2">The demo auditor identity is not available on this deployment. Sign in as an auditor and use Verify the ledger on the Overview tab.</p>}
          {live.state === "idle" && <p className="text-[13px] text-ink-3">Nothing has been run yet.</p>}
          {live.state === "running" && <p className="text-[13px] text-ink-2">Recomputing.</p>}
        </div>

        <button
          onClick={verifyLive}
          disabled={live.state === "running"}
          className="mt-auto inline-flex h-10 items-center justify-center gap-2 self-start rounded-md border border-line px-4 text-sm font-medium text-ink transition-colors hover:border-brand hover:text-brand disabled:opacity-50"
        >
          {live.state === "running" && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
          {live.state === "done" ? "Recompute again" : "Recompute the ledger"}
        </button>
      </div>
    </div>
  );
}
