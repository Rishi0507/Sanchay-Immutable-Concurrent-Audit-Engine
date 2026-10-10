// The audit, played as it runs. Every figure on the stage is the real one:
// the row count, the columns as read, the hash of each row as it is sealed,
// each test's result, the samples drawn from the seal.

import { useEffect, useRef, useState } from "react";
import { Mark, cx } from "../ui";
import { Stamp } from "../Stamp";
import { Check, Sample, Seal, seal as sealRows } from "./audit";
import { Profile, roleNames } from "./profile";
import { Field, verdictTone, verdictWord } from "./widgets";

const steps = [
  { key: "read", label: "Read the file" },
  { key: "columns", label: "Understand each column" },
  { key: "seal", label: "Seal every row" },
  { key: "tests", label: "Run the tests" },
  { key: "samples", label: "Pick the samples" },
  { key: "stamp", label: "Stamp the file" },
] as const;

type Step = (typeof steps)[number]["key"];

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function Theater({
  p,
  checks,
  samples,
  onSealed,
  sealed,
  onDone,
}: {
  p: Profile;
  checks: Check[];
  // Drawn from the seal, so known only once it is made.
  samples: Sample[] | null;
  onSealed: (s: Seal) => void;
  sealed: Seal | null;
  onDone: () => void;
}) {
  const [step, setStep] = useState<Step>("read");
  const [rowsRead, setRowsRead] = useState(0);
  const [colsShown, setColsShown] = useState(0);
  const [sealing, setSealing] = useState<{ done: number; hash: string; links: { row: number; hash: string }[] }>({ done: 0, hash: "", links: [] });
  const [testsShown, setTestsShown] = useState(0);
  const [stamped, setStamped] = useState(false);
  const live = useRef(true);
  const still = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  useEffect(() => {
    live.current = true;
    const pace = still ? 0 : 1;
    (async () => {
      // Read: count the rows up.
      const n = p.data.length;
      for (let f = 1; f <= 24 && live.current; f++) {
        setRowsRead(Math.round((n * f) / 24));
        await wait(32 * pace);
      }
      await wait(350 * pace);
      if (!live.current) return;
      setStep("columns");
      for (let i = 1; i <= p.columns.length && live.current; i++) {
        setColsShown(i);
        await wait(Math.min(140, 2400 / p.columns.length) * pace);
      }
      await wait(600 * pace);
      if (!live.current) return;
      setStep("seal");
      const started = Date.now();
      const s = sealed ?? (await sealRows(p, (done, hash) => live.current && setSealing((x) => ({ done, hash, links: [...x.links.slice(-11), { row: done, hash }] }))));
      if (!live.current) return;
      setSealing((x) => ({ ...x, done: s.rows, hash: s.head }));
      onSealed(s);
      await wait(Math.max(0, 2200 - (Date.now() - started)) * pace);
      await wait(500 * pace);
      if (!live.current) return;
      setStep("tests");
      for (let i = 1; i <= checks.length && live.current; i++) {
        setTestsShown(i);
        await wait(230 * pace);
      }
      await wait(700 * pace);
      if (!live.current) return;
      setStep("samples");
      await wait(2600 * pace);
      if (!live.current) return;
      setStep("stamp");
      await wait(150 * pace);
      setStamped(true);
      await wait(1900 * pace);
      if (live.current) onDone();
    })();
    return () => {
      live.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const at = steps.findIndex((s) => s.key === step);
  const flagged = new Set(checks.filter((c) => c.verdict === "flag").flatMap((c) => c.rows));
  const problems = checks.filter((c) => c.verdict === "flag").length;

  return (
    <div className="view fixed inset-0 z-50 flex flex-col overflow-hidden bg-spine text-spine-ink" role="dialog" aria-label="The audit, running">
      <div className="pointer-events-none absolute inset-0 opacity-[0.06]" style={{ backgroundImage: "repeating-linear-gradient(to bottom, transparent 0 39px, #eaf4ee 39px 40px)" }} aria-hidden />
      <header className="relative flex items-center justify-between gap-4 px-6 py-4 md:px-10">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-spine-ink-2">Auditing in your browser</div>
          <div className="truncate text-[17px] font-bold">{p.table.name}</div>
        </div>
        <button onClick={onDone} className="rounded-lg border border-white/20 px-4 py-2 text-[14px] font-semibold text-spine-ink-2 transition-colors hover:border-white/40 hover:text-spine-ink">
          Skip to the results
        </button>
      </header>

      <div className="relative grid min-h-0 flex-1 gap-8 px-6 pb-8 md:grid-cols-[280px_minmax(0,1fr)] md:px-10">
        {/* The run sheet: each step ticked in green ink as it finishes. */}
        <ol className="hidden flex-col gap-1 md:flex" aria-label="Steps">
          {steps.map((s, i) => {
            const done = i < at || (s.key === "stamp" && stamped);
            const now = i === at && !done;
            return (
              <li key={s.key} className={cx("flex items-center gap-3 rounded-xl px-3 py-3 transition-colors", now && "bg-white/[0.08]")}>
                <span className={cx("flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2", done ? "border-highlight bg-highlight text-spine" : now ? "border-highlight text-highlight" : "border-white/20 text-spine-ink-2")}>
                  {done ? <Mark tone="good" size={18} draw /> : now ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-highlight/30 border-t-highlight" /> : <span className="text-[14px] font-bold">{i + 1}</span>}
                </span>
                <span className={cx("text-[16px] font-semibold", done || now ? "text-spine-ink" : "text-spine-ink-2")}>{s.label}</span>
              </li>
            );
          })}
        </ol>

        {/* The stage. */}
        <div className="relative flex min-h-0 flex-col justify-center">
          {step === "read" && (
            <div className="view">
              <div className="text-[18px] font-semibold text-spine-ink-2">Rows read</div>
              <div className="display text-[96px] leading-none md:text-[150px]" style={{ fontVariationSettings: '"wdth" 75' }}>
                {rowsRead.toLocaleString("en-IN")}
              </div>
              <div className="mt-2 text-[18px] text-spine-ink-2">
                {p.columns.length} columns{p.table.sheet ? `, from the sheet ${p.table.sheet}` : ""}
                {p.totals.length ? `, and ${p.totals.length} total row${p.totals.length === 1 ? "" : "s"} set aside` : ""}
              </div>
            </div>
          )}

          {step === "columns" && (
            <div className="view">
              <div className="mb-5 text-[22px] font-bold">What each column means</div>
              <div className="grid max-h-[60vh] grid-cols-1 gap-2 overflow-hidden sm:grid-cols-2 xl:grid-cols-3">
                {p.columns.slice(0, colsShown).map((c) => (
                  <div key={c.index} className="view flex items-center justify-between gap-3 rounded-xl bg-white/[0.07] px-4 py-2.5">
                    <span className="truncate text-[15px] font-semibold">{c.name}</span>
                    <span className={cx("shrink-0 rounded-full px-2.5 py-0.5 text-[13px] font-bold", c.role === "text" || c.role === "empty" ? "bg-white/10 text-spine-ink-2" : "bg-highlight text-spine")}>{roleNames[c.role]}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {step === "seal" && (
            <div className="view">
              <div className="text-[18px] font-semibold text-spine-ink-2">Each row's SHA-256 hash covers the row before it</div>
              <div className="display mt-1 text-[64px] leading-none md:text-[96px]" style={{ fontVariationSettings: '"wdth" 75' }}>
                {sealing.done.toLocaleString("en-IN")}
                <span className="text-spine-ink-2"> of {p.data.length.toLocaleString("en-IN")}</span>
              </div>
              <div className="mt-6 flex items-center gap-0 overflow-hidden" aria-hidden>
                {sealing.links.slice(-8).map((l, i, all) => (
                  <div key={`${l.row}-${l.hash}`} className="view flex shrink-0 items-center">
                    <div className={cx("rounded-lg border px-3 py-2 font-mono text-[12px]", i === all.length - 1 ? "border-highlight bg-highlight/15 text-highlight" : "border-white/15 text-spine-ink-2")}>
                      <div className="font-sans text-[11px] font-bold">Row {l.row.toLocaleString("en-IN")}</div>
                      {l.hash.slice(0, 10)}…
                    </div>
                    {i < all.length - 1 && <span className="h-0.5 w-6 bg-white/25" />}
                  </div>
                ))}
              </div>
              <div className="mt-6 break-all font-mono text-[15px] text-highlight md:text-[20px]">{sealing.hash || "…"}</div>
            </div>
          )}

          {step === "tests" && (
            <div className="view">
              <div className="mb-5 text-[22px] font-bold">
                {testsShown} of {checks.length} tests
              </div>
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
                {checks.map((c, i) => {
                  const shown = i < testsShown;
                  const tone = verdictTone[c.verdict];
                  return (
                    <div key={c.id} className={cx("flex items-start gap-3 rounded-xl px-4 py-3 transition-[background-color,opacity] duration-300", shown ? (c.verdict === "flag" ? "bg-[#e5532f]/20" : "bg-white/[0.07]") : "bg-white/[0.03] opacity-50")}>
                      <span className={cx("mt-0.5", !shown ? "text-spine-ink-2" : tone === "good" ? "text-highlight" : tone === "bad" ? "text-[#ff8a70]" : "text-spine-ink-2")}>
                        {shown ? <Mark tone={tone} size={20} draw /> : <span className="block h-5 w-5 animate-pulse rounded-full bg-white/15" />}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[15px] font-bold">{c.title}</span>
                        <span className="block text-[13px] leading-snug text-spine-ink-2">{shown ? (c.verdict === "flag" || c.verdict === "note" ? `${verdictWord[c.verdict]}: ${c.rows.length ? `${c.rows.length.toLocaleString("en-IN")} rows` : c.result}` : verdictWord[c.verdict]) : "Testing"}</span>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {step === "samples" && p.date !== undefined && p.amount !== undefined && (
            <div className="view rounded-2xl bg-paper p-4 text-ink">
              <div className="mb-2 flex items-baseline justify-between gap-3 px-1">
                <span className="text-[18px] font-bold">{samples?.length ?? 0} samples, drawn with the seal as the seed</span>
                <span className="text-[13px] text-ink-2">Red: caught by a test. Ringed: picked to test against documents.</span>
              </div>
              <Field p={p} date={p.date} amount={p.amount} flagged={flagged} samples={samples ?? []} height={Math.min(420, window.innerHeight * 0.5)} />
            </div>
          )}
          {step === "samples" && (p.date === undefined || p.amount === undefined) && (
            <div className="view display text-[64px] leading-none">{samples?.length ?? 0} samples drawn</div>
          )}

          {step === "stamp" && (
            <div className="view flex flex-col items-center justify-center text-center">
              <div className={cx("relative", stamped && "stage-shake")}>
                <div className="rounded-2xl bg-paper px-10 py-8 text-left text-ink shadow-[0_30px_80px_rgba(0,0,0,0.4)] md:px-16 md:py-12">
                  <div className="text-[15px] font-semibold text-ink-2">{p.table.name}</div>
                  <div className="display mt-2 text-[44px] leading-none md:text-[60px]">
                    {problems ? `${problems} problem${problems === 1 ? "" : "s"} found` : "Nothing wrong found"}
                  </div>
                  <div className="mt-3 text-[16px] text-ink-2">
                    {checks.filter((c) => c.verdict === "pass").length} tests passed, {flagged.size.toLocaleString("en-IN")} rows caught, {samples?.length ?? 0} samples to test
                  </div>
                </div>
                {stamped && <Stamp word={problems ? "EXCEPTIONS" : "AUDITED"} tone={problems ? "fail" : "pass"} detail={sealed ? `seal ${sealed.head.slice(0, 8)}…${sealed.head.slice(-6)}` : undefined} />}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
