// Sanchay Lens: drop any register, and the browser reads it, builds the page
// it needs, and audits it. Nothing is uploaded and no model is called.

import { ReactNode, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrandMark, Button, Drawer, Mark, cx, toast } from "../ui";
import { inr } from "../auditor/kit";
import { Check, Sample, Seal, periodOf, pickSamples, runChecks, seal } from "./audit";
import { Profile, Role, profile, roleNames, text, toDay, toNumber } from "./profile";
import { Table, readFile, readUrl } from "./read";
import { Widget, buildSpec } from "./spec";
import { Stamp } from "../Stamp";
import { Theater } from "./Theater";
import { Benford, Category, Days, Field, IndiaMap, Parties, Sizes, Timeline, caughtRows, verdictTone, verdictWord } from "./widgets";

// three.js loads only for a file that earns the city.
const City3D = lazy(() => import("./City3D"));

const SAMPLE = { url: "/samples/sales_register_FY2025-26.xlsx", name: "sales_register_FY2025-26.xlsx" };
const SAMPLE_PARTIES = { url: "/samples/related_parties.csv", name: "related_parties.csv" };

// A list of related parties is told apart from a register by its columns.
function isPartyList(t: Table) {
  const h = t.columns.join(" ").toLowerCase();
  return /relationship|related/.test(h) && t.rows.length < 500;
}

export default function Lens({ embedded, onSignIn, onStory }: { embedded?: boolean; onSignIn?: () => void; onStory?: () => void }) {
  const [table, setTable] = useState<Table | null>(null);
  const [related, setRelated] = useState<Table | null>(null);
  const [overrides, setOverrides] = useState<Record<number, Role>>({});
  const [sealed, setSealed] = useState<Seal | null>(null);
  const [phase, setPhase] = useState<"idle" | "loading" | "running" | "done">("idle");
  const [error, setError] = useState("");

  const prof = useMemo(() => (table ? profile(table, overrides) : null), [table, overrides]);
  const checks = useMemo(() => (prof ? runChecks(prof, related) : []), [prof, related]);
  const samples = useMemo(() => (prof && sealed ? pickSamples(prof, checks, sealed.head) : null), [prof, checks, sealed]);
  const spec = useMemo(() => (prof ? buildSpec(prof) : []), [prof]);

  const start = useCallback(async (files: File[] | "sample") => {
    setError("");
    setPhase("loading");
    try {
      let tables: Table[];
      if (files === "sample") tables = await Promise.all([readUrl(SAMPLE.url, SAMPLE.name), readUrl(SAMPLE_PARTIES.url, SAMPLE_PARTIES.name)]);
      else tables = await Promise.all(files.map(readFile));
      const parties = tables.find(isPartyList) ?? null;
      const main = tables.filter((t) => t !== parties).sort((a, b) => b.rows.length - a.rows.length)[0] ?? parties;
      if (!main || main.rows.length === 0) throw new Error("The file has no rows to read.");
      setTable(main);
      setRelated(main === parties ? null : parties);
      setOverrides({});
      setSealed(null);
      setPhase("running");
    } catch (e) {
      setError((e as Error).message || "The file could not be read.");
      setPhase("idle");
    }
  }, []);

  if (phase === "running" && prof)
    return <Theater p={prof} checks={checks} samples={samples} sealed={sealed} onSealed={setSealed} onDone={() => setPhase("done")} />;

  if (phase === "done" && prof)
    return (
      <Results
        p={prof}
        checks={checks}
        samples={samples ?? []}
        sealed={sealed}
        spec={spec}
        related={related}
        embedded={embedded}
        onRole={(i, r) => setOverrides((o) => ({ ...o, [i]: r }))}
        onReplay={() => setPhase("running")}
        onAnother={() => {
          setTable(null);
          setPhase("idle");
        }}
        onSealed={setSealed}
        header={!embedded && <TopBar onSignIn={onSignIn} onStory={onStory} light />}
      />
    );

  return <FrontDoor embedded={embedded} busy={phase === "loading"} error={error} onFiles={start} onSignIn={onSignIn} onStory={onStory} />;
}

// ---------------------------------------------------------------- The front door

function TopBar({ onSignIn, onStory, light }: { onSignIn?: () => void; onStory?: () => void; light?: boolean }) {
  return (
    <header className={cx("relative z-10 flex items-center justify-between gap-4 px-6 py-5 md:px-10", light ? "text-ink" : "text-spine-ink")}>
      <div className="flex items-center gap-3">
        <BrandMark size={36} />
        <span className="display text-[23px]">Sanchay</span>
      </div>
      <nav className="flex items-center gap-2 text-[15px] font-semibold">
        {onStory && (
          <button onClick={onStory} className={cx("rounded-lg px-3 py-2 transition-colors", light ? "text-ink-2 hover:text-ink" : "text-spine-ink-2 hover:text-spine-ink")}>
            How it works
          </button>
        )}
        {onSignIn && (
          <button onClick={onSignIn} className={cx("rounded-lg border px-4 py-2 transition-colors", light ? "border-line bg-paper hover:border-brand" : "border-white/25 hover:border-white/50")}>
            Open the workspace
          </button>
        )}
      </nav>
    </header>
  );
}

// A strip of real SHA-256 links running under the page, as the ledger runs under the business.
function LedgerTape() {
  const [links, setLinks] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    (async () => {
      const enc = new TextEncoder();
      let prev = "0".repeat(64);
      const out: string[] = [];
      for (let i = 0; i < 26; i++) {
        const buf = await crypto.subtle.digest("SHA-256", enc.encode(prev + `sale ${i + 1}`));
        prev = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
        out.push(prev);
      }
      if (live) setLinks(out);
    })();
    return () => {
      live = false;
    };
  }, []);
  if (!links.length) return <div className="h-[74px]" />;
  const row = (dup: boolean) =>
    links.map((h, i) => (
      <div key={`${dup}-${i}`} className="flex shrink-0 items-center">
        <div className="rounded-lg border border-white/15 bg-white/[0.04] px-3 py-2 font-mono text-[12px] text-spine-ink-2">
          <div className="font-sans text-[11px] font-bold text-spine-ink">Event {String(i + 1).padStart(5, "0")}</div>
          {h.slice(0, 12)}…
        </div>
        <span className="h-0.5 w-7 bg-highlight/40" />
      </div>
    ));
  return (
    <div className="relative overflow-hidden py-3" aria-hidden>
      <div className="marquee flex w-max">
        {row(false)}
        {row(true)}
      </div>
      <div className="pointer-events-none absolute inset-y-0 left-0 w-24 bg-gradient-to-r from-spine to-transparent" />
      <div className="pointer-events-none absolute inset-y-0 right-0 w-24 bg-gradient-to-l from-spine to-transparent" />
    </div>
  );
}

function FrontDoor({ embedded, busy, error, onFiles, onSignIn, onStory }: { embedded?: boolean; busy: boolean; error: string; onFiles: (f: File[] | "sample") => void; onSignIn?: () => void; onStory?: () => void }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const drop = (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const files = [...e.dataTransfer.files];
        if (files.length) onFiles(files);
      }}
      className={cx(
        "ledger-paper relative rounded-[22px] border-2 border-dashed py-9 pr-7 pl-[72px] text-ink shadow-[0_40px_90px_-30px_rgba(0,0,0,0.55)] transition-[transform,border-color] duration-200",
        over ? "scale-[1.02] border-highlight" : "border-transparent",
        !embedded && "lg:rotate-[-1.2deg]",
      )}
    >
      <div className="flex items-center gap-3 text-brand">
        <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M6 3h8l4 4v14H6z" />
          <path d="M14 3v4h4M9 12h6M9 16h6" />
        </svg>
        <span className="text-[15px] font-bold text-ink-2">Excel, CSV or JSON</span>
      </div>
      <p className="display mt-4 text-[30px] leading-[1.08] text-ink">{over ? "Let go to audit it" : "Drop a sales register here"}</p>
      <p className="mt-2 max-w-sm text-[15px] leading-relaxed text-ink-2">Add the related-party list in the same drop and sales to those parties are found too. The file stays on this computer.</p>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button
          onClick={() => onFiles("sample")}
          disabled={busy}
          className="group inline-flex h-12 items-center gap-3 rounded-xl bg-brand px-5 text-[16px] font-bold text-on-brand shadow-[inset_0_-3px_0_rgba(0,0,0,0.2)] transition-transform hover:-translate-y-0.5 disabled:opacity-60"
        >
          {busy ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" /> : <Mark tone="good" size={18} />}
          Audit the sample register
        </button>
        <Button kind="ghost" onClick={() => input.current?.click()} disabled={busy}>
          Choose a file
        </Button>
        <input
          ref={input}
          type="file"
          multiple
          accept=".xlsx,.xls,.csv,.tsv,.txt,.json"
          className="hidden"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            if (files.length) onFiles(files);
            e.target.value = "";
          }}
        />
      </div>
      <p className="mt-3 text-[13px] text-ink-3">The sample is FY 2025-26 of a synthetic manufacturer: 6,885 sales with problems planted in them.</p>
      {error && <p className="mt-3 text-[14px] font-semibold text-fail">{error}</p>}
    </div>
  );

  if (embedded)
    return (
      <div>
        <div className="mb-6">
          <h1 className="display text-[40px] leading-[1.02]">Lens</h1>
          <p className="mt-2 max-w-2xl text-[16px] text-ink-2">Audit any register in the browser. Sanchay reads the columns, builds the page the file needs, seals every row and runs fourteen tests.</p>
        </div>
        <div className="max-w-2xl">{drop}</div>
      </div>
    );

  return (
    <div className="relative flex min-h-full flex-col overflow-hidden bg-spine text-spine-ink">
      <div className="pointer-events-none absolute inset-0 opacity-[0.06]" style={{ backgroundImage: "repeating-linear-gradient(to bottom, transparent 0 39px, #eaf4ee 39px 40px)" }} aria-hidden />
      <div className="pointer-events-none absolute top-0 bottom-0 left-[8%] w-[3px] border-x border-[#e5532f]/40" aria-hidden />
      <TopBar onSignIn={onSignIn} onStory={onStory} />
      <main className="relative grid flex-1 items-center gap-12 px-6 py-10 md:px-10 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:px-[10%]">
        <div>
          <h1 className="display text-[58px] leading-[0.95] md:text-[88px]" style={{ fontVariationSettings: '"wdth" 78' }}>
            Drop a register.
            <br />
            <span className="text-highlight">Watch it audited.</span>
          </h1>
          <p className="mt-7 max-w-xl text-[19px] leading-relaxed text-spine-ink-2">
            Sanchay reads any sales file, works out what each column means, builds the page that file deserves, seals every row into a hash chain and runs fourteen audit tests on it. All of it here, in your browser.
          </p>
          <ul className="mt-8 grid max-w-xl gap-3 text-[16px] sm:grid-cols-2">
            {["Builds its own charts for your columns", "Every row sealed with SHA-256", "GSTIN, GST type and number series checked", "Thirty samples nobody gets to choose"].map((t) => (
              <li key={t} className="flex items-start gap-2.5">
                <span className="mt-0.5 text-highlight">
                  <Mark tone="good" size={19} draw />
                </span>
                {t}
              </li>
            ))}
          </ul>
        </div>
        {drop}
      </main>
      <LedgerTape />
    </div>
  );
}

// ---------------------------------------------------------------- Results

function Section({ title, note, children, action }: { title: string; note?: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="mb-10">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="display text-[30px] leading-none">{title}</h2>
          {note && <p className="mt-1.5 max-w-3xl text-[15px] text-ink-2">{note}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function Results({
  p,
  checks,
  samples,
  sealed,
  spec,
  related,
  embedded,
  header,
  onRole,
  onReplay,
  onAnother,
  onSealed,
}: {
  p: Profile;
  checks: Check[];
  samples: Sample[];
  sealed: Seal | null;
  spec: Widget[];
  related: Table | null;
  embedded?: boolean;
  header: ReactNode;
  onRole: (i: number, r: Role) => void;
  onReplay: () => void;
  onAnother: () => void;
  onSealed: (s: Seal) => void;
}) {
  const [open, setOpen] = useState<Check | null>(null);
  const [showSpec, setShowSpec] = useState(false);
  const [rowOpen, setRowOpen] = useState<number | null>(null);
  const flagged = useMemo(() => caughtRows(checks), [checks]);
  const period = useMemo(() => periodOf(p), [p]);
  const problems = checks.filter((c) => c.verdict === "flag");
  const caughtValue = useMemo(() => {
    const amt = p.amount !== undefined ? p.data.map((ri) => Math.abs(toNumber(p.table.rows[ri][p.amount!]) ?? 0)) : [];
    return [...flagged].reduce((t, k) => t + (amt[k] ?? 0), 0);
  }, [p, flagged]);
  const total = useMemo(() => (p.amount !== undefined ? p.data.reduce((t, ri) => t + Math.abs(toNumber(p.table.rows[ri][p.amount!]) ?? 0), 0) : 0), [p]);

  // If the run was skipped before the seal finished, finish it here.
  useEffect(() => {
    if (sealed) return;
    seal(p).then(onSealed);
  }, [sealed, p, onSealed]);

  const cell = (k: number, i?: number) => (i === undefined ? "" : text(p.table.rows[p.data[k]][i]));

  const widget = (w: Widget) => {
    switch (w.kind) {
      case "field":
        return <Field p={p} date={w.date} amount={w.amount} flagged={flagged} samples={samples} onPick={setRowOpen} />;
      case "timeline":
        return <Timeline p={p} date={w.date} amount={w.amount} flagged={flagged} />;
      case "calendar":
        return <Days p={p} date={w.date} amount={w.amount} flagged={flagged} period={period} />;
      case "map":
        return <IndiaMap p={p} state={w.state} gstin={w.gstin} amount={w.amount} />;
      case "pareto":
        return <Parties p={p} party={w.party} amount={w.amount} flagged={flagged} />;
      case "category":
        return <Category p={p} column={w.column} amount={w.amount} />;
      case "benford":
        return <Benford p={p} amount={w.amount} />;
      case "histogram":
        return <Sizes p={p} amount={w.amount} />;
      case "city":
        return (
          <Suspense fallback={<div className="h-[420px] rounded-xl bg-wash" />}>
            <City3D p={p} date={w.date} party={w.party} amount={w.amount} flagged={flagged} />
          </Suspense>
        );
    }
  };

  return (
    <div className={cx("min-h-full", !embedded && "bg-canvas")}>
      {header}
      <div className={cx("mx-auto w-full", !embedded && "max-w-[1320px] px-4 pb-24 sm:px-8")}>
        {/* The verdict, stamped. */}
        <section className="relative mb-10 grid overflow-hidden rounded-[22px] border border-line shadow-[0_24px_60px_-34px_rgba(12,58,43,0.45)] lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="ledger-paper relative py-8 pr-8 pl-[72px]">
            <div className="text-[15px] font-semibold text-ink-2">
              {p.table.name}
              {period ? `, ${period.label}` : ""}
            </div>
            <h1 className="display mt-2 text-[48px] leading-[0.98] md:text-[64px]" style={{ fontVariationSettings: '"wdth" 78' }}>
              {problems.length ? (
                <>
                  <span className="text-fail">{flagged.size.toLocaleString("en-IN")} rows</span> need a look
                </>
              ) : (
                "Nothing wrong found"
              )}
            </h1>
            <p className="mt-3 max-w-2xl text-[17px] leading-relaxed text-ink-2">
              {problems.length ? `${problems.length} of ${checks.filter((c) => c.verdict !== "skip").length} tests found a problem. The rows they caught carry ${inr(caughtValue)}` : `All ${checks.filter((c) => c.verdict !== "skip").length} tests that could run passed`}
              {total ? ` of ${inr(total)} in ${p.data.length.toLocaleString("en-IN")} rows.` : "."}
            </p>
            <div className="mt-6 flex flex-wrap gap-2.5">
              <Button onClick={onReplay}>Replay the audit</Button>
              <Button kind="ghost" onClick={() => setShowSpec(true)}>
                Show the page spec
              </Button>
              <Button kind="ghost" onClick={onAnother}>
                Audit another file
              </Button>
            </div>
            <Stamp word={problems.length ? "EXCEPTIONS" : "AUDITED"} tone={problems.length ? "fail" : "pass"} detail={sealed ? `seal ${sealed.head.slice(0, 8)}…${sealed.head.slice(-6)}` : undefined} small />
          </div>
          <div className="flex flex-col justify-between gap-5 bg-spine p-7 text-spine-ink">
            <div>
              <div className="text-[14px] font-semibold text-spine-ink-2">Sealed in the browser</div>
              <div className="mt-1 text-[15px]">Every row hashed with SHA-256, each hash covering the one before. Change one cell and this changes.</div>
              <div className="mt-3 rounded-lg bg-black/25 px-3 py-2.5 font-mono text-[12.5px] break-all text-highlight">{sealed?.head ?? "Sealing…"}</div>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              {[
                ["Passed", checks.filter((c) => c.verdict === "pass").length],
                ["Problems", problems.length],
                ["Samples", samples.length],
              ].map(([l, v]) => (
                <div key={l as string} className="rounded-xl bg-white/[0.07] py-3">
                  <div className="amount text-[28px] leading-none">{v}</div>
                  <div className="mt-1 text-[12.5px] text-spine-ink-2">{l}</div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <Section title="The tests" note="Each answers one question about the file. Open a test to see the rows it caught, and why.">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {checks.map((c, i) => {
              const tone = verdictTone[c.verdict];
              return (
                <button
                  key={c.id}
                  onClick={() => c.rows.length && setOpen(c)}
                  className={cx(
                    "settle-item group flex items-start gap-3.5 rounded-2xl border bg-paper p-4 text-left transition-[border-color,box-shadow,transform] duration-150",
                    c.verdict === "flag" ? "border-fail/40" : "border-line",
                    c.rows.length ? "hover:-translate-y-0.5 hover:shadow-[0_14px_30px_rgba(12,58,43,0.12)]" : "cursor-default",
                  )}
                  style={{ animationDelay: `${i * 40}ms` }}
                >
                  <span className={cx("flex h-10 w-10 shrink-0 items-center justify-center rounded-full", tone === "good" ? "bg-pass-wash text-pass" : tone === "bad" ? "bg-fail-wash text-fail" : tone === "warn" ? "bg-wait-wash text-wait" : "bg-wash text-ink-3")}>
                    <Mark tone={tone} size={20} draw />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="text-[16px] font-bold text-ink">{c.title}</span>
                      <span className={cx("shrink-0 text-[12.5px] font-bold", tone === "good" ? "text-pass" : tone === "bad" ? "text-fail" : tone === "warn" ? "text-wait" : "text-ink-3")}>{verdictWord[c.verdict]}</span>
                    </span>
                    <span className="mt-0.5 block text-[13.5px] text-ink-2">{c.asks}</span>
                    <span className="mt-2 block text-[14px] font-medium text-ink">{c.result}</span>
                    {c.rows.length > 0 && c.amount > 0 && <span className="mt-1 block text-[13px] text-ink-2">Rows worth {inr(c.amount)}. Open to see them.</span>}
                  </span>
                </button>
              );
            })}
          </div>
        </Section>

        <Section
          title="The page Sanchay built for this file"
          note={`Nobody designed this page. Sanchay chose ${spec.length} views from what your columns mean, and each says why it is here. Change a column's meaning below and the page rebuilds itself.`}
        >
          <div className="grid gap-5 lg:grid-cols-2">
            {spec.map((w, i) => (
              <article key={w.id} className={cx("view rounded-2xl border border-line bg-paper", w.wide && "lg:col-span-2")} style={{ animationDelay: `${i * 70}ms` }}>
                <div className="border-b border-line-soft px-5 py-4">
                  <h3 className="text-[18px] font-bold text-ink">{w.title}</h3>
                  <p className="mt-1 flex items-start gap-2 text-[13.5px] text-ink-2">
                    <span className="mt-[3px] shrink-0 rounded-full bg-brand-wash px-2 py-0.5 text-[11.5px] font-bold text-brand">Built because</span>
                    <span>{w.why}</span>
                  </p>
                </div>
                <div className="p-5">{widget(w)}</div>
              </article>
            ))}
            {spec.length === 0 && <p className="text-[15px] text-ink-2">No column could be read as a date, an amount or a party, so there is nothing to draw. Set a column's meaning below.</p>}
          </div>
        </Section>

        {samples.length > 0 && (
          <Section title="Samples to test" note={`Drawn with the first eight characters of the seal, ${sealed?.head.slice(0, 8) ?? "…"}, as the seed. The same file always gives the same samples, and nobody picks them.`}>
            <div className="overflow-hidden rounded-2xl border border-line bg-paper">
              <table className="w-full text-[14px]">
                <thead>
                  <tr className="border-b border-line bg-wash text-left text-[12.5px] text-ink-2">
                    <th className="px-4 py-2.5 font-semibold">#</th>
                    <th className="px-4 py-2.5 font-semibold">{p.docno !== undefined ? p.columns[p.docno].name : "Row"}</th>
                    <th className="hidden px-4 py-2.5 font-semibold md:table-cell">{p.party !== undefined ? p.columns[p.party].name : ""}</th>
                    <th className="hidden px-4 py-2.5 font-semibold sm:table-cell">Why</th>
                    <th className="px-4 py-2.5 text-right font-semibold">{p.amount !== undefined ? p.columns[p.amount].name : ""}</th>
                  </tr>
                </thead>
                <tbody>
                  {samples.map((s, i) => (
                    <tr key={s.row} onClick={() => setRowOpen(s.row)} className={cx("cursor-pointer border-b border-line-soft transition-colors last:border-0 hover:bg-wash", flagged.has(s.row) && "bg-mark hover:bg-mark-hover")}>
                      <td className="num px-4 py-2.5 text-ink-3">{i + 1}</td>
                      <td className="px-4 py-2.5 font-semibold">
                        {p.docno !== undefined ? cell(s.row, p.docno) : `Row ${s.row + 1}`}
                        <span className="ml-2 font-normal text-ink-2">{p.date !== undefined ? toDay(p.table.rows[p.data[s.row]][p.date]) : ""}</span>
                      </td>
                      <td className="hidden px-4 py-2.5 md:table-cell">{cell(s.row, p.party)}</td>
                      <td className="hidden px-4 py-2.5 text-ink-2 sm:table-cell">{s.reason}</td>
                      <td className="num px-4 py-2.5 text-right font-semibold">{p.amount !== undefined ? inr(toNumber(p.table.rows[p.data[s.row]][p.amount]) ?? 0) : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        )}

        <Section title="How Sanchay read your columns" note="Every decision and its reason. If one is wrong, set it right and every test and chart above follows.">
          <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
            {p.columns.map((c) => (
              <div key={c.index} className="rounded-xl border border-line bg-paper px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate text-[15px] font-bold text-ink" title={c.name}>
                    {c.name}
                  </span>
                  <select
                    value={c.role}
                    onChange={(e) => {
                      onRole(c.index, e.target.value as Role);
                      toast(`${c.name} is now read as ${roleNames[e.target.value as Role].toLowerCase()}. The page rebuilt itself.`);
                    }}
                    className="h-8 shrink-0 rounded-lg border border-line bg-brand-wash px-2 text-[13px] font-bold text-brand outline-none focus:border-brand"
                    aria-label={`What ${c.name} means`}
                  >
                    {(Object.keys(roleNames) as Role[]).map((r) => (
                      <option key={r} value={r}>
                        {roleNames[r]}
                      </option>
                    ))}
                  </select>
                </div>
                <p className="mt-1.5 text-[13px] leading-snug text-ink-2">{c.reason}</p>
                <p className="mt-1 truncate text-[12.5px] text-ink-3">
                  {c.filled.toLocaleString("en-IN")} filled, {c.distinct.toLocaleString("en-IN")} different. {c.examples.length ? `For example ${c.examples.join(", ")}` : ""}
                </p>
              </div>
            ))}
          </div>
          {related && <p className="mt-4 text-[14px] text-ink-2">The related-party list, {related.name}, was read too: {related.rows.length} parties.</p>}
        </Section>
      </div>

      <Drawer open={!!open} onClose={() => setOpen(null)} title={open ? `${open.title}: ${open.rows.length.toLocaleString("en-IN")} rows` : ""}>
        {open && (
          <>
            <p className="mb-4 text-[15px] text-ink-2">{open.asks}</p>
            <ul className="divide-y divide-line-soft rounded-xl border border-line">
              {open.rows.slice(0, 200).map((k) => (
                <li key={k}>
                  <button onClick={() => setRowOpen(k)} className="w-full px-4 py-3 text-left transition-colors hover:bg-wash">
                    <span className="flex items-baseline justify-between gap-3">
                      <span className="font-semibold">{p.docno !== undefined ? cell(k, p.docno) : `Row ${p.data[k] + 2}`}</span>
                      <span className="num font-semibold">{p.amount !== undefined ? inr(toNumber(p.table.rows[p.data[k]][p.amount]) ?? 0) : ""}</span>
                    </span>
                    <span className="block text-[13.5px] text-ink-2">
                      {[p.date !== undefined ? toDay(p.table.rows[p.data[k]][p.date]) : "", cell(k, p.party)].filter(Boolean).join(", ")}
                    </span>
                    {open.why?.get(k) && <span className="mt-0.5 block text-[13.5px] font-medium text-fail">{open.why.get(k)}</span>}
                  </button>
                </li>
              ))}
            </ul>
            {open.rows.length > 200 && <p className="mt-3 text-[13px] text-ink-2">The first 200 of {open.rows.length.toLocaleString("en-IN")} are shown.</p>}
          </>
        )}
      </Drawer>

      <Drawer open={rowOpen !== null} onClose={() => setRowOpen(null)} title={rowOpen !== null ? (p.docno !== undefined ? cell(rowOpen, p.docno) : `Row ${rowOpen + 1}`) : ""}>
        {rowOpen !== null && (
          <>
            {checks.filter((c) => c.rows.includes(rowOpen)).map((c) => (
              <div key={c.id} className="mb-2 flex items-start gap-2 rounded-lg bg-fail-wash px-3 py-2 text-[14px] text-fail">
                <Mark tone="bad" size={16} />
                <span>
                  <b>{c.title}.</b> {c.why?.get(rowOpen) ?? c.result}
                </span>
              </div>
            ))}
            {samples.find((s) => s.row === rowOpen) && (
              <div className="mb-2 rounded-lg bg-brand-wash px-3 py-2 text-[14px] font-semibold text-brand">Sampled: {samples.find((s) => s.row === rowOpen)!.reason}</div>
            )}
            <dl className="mt-4 grid grid-cols-[minmax(120px,auto)_1fr] gap-x-5 gap-y-2 text-[14px]">
              {p.columns.map((c) => (
                <div key={c.index} className="contents">
                  <dt className="text-ink-2">{c.name}</dt>
                  <dd className="min-w-0 break-words font-medium text-ink">{cell(rowOpen, c.index) || <span className="text-ink-3">blank</span>}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </Drawer>

      <Drawer open={showSpec} onClose={() => setShowSpec(false)} title="The spec Sanchay wrote for this page">
        <p className="mb-4 text-[15px] text-ink-2">The page is drawn from this list. It was written from the column meanings alone, so a different file gets a different page.</p>
        <pre className="thin-scroll overflow-auto rounded-xl bg-spine p-4 font-mono text-[12.5px] leading-relaxed text-spine-ink">
          {JSON.stringify(
            {
              file: p.table.name,
              rows: p.data.length,
              columns: Object.fromEntries(p.columns.map((c) => [c.name, roleNames[c.role]])),
              views: spec.map(({ kind, title, why, ...rest }) => ({ view: kind, title, ...Object.fromEntries(Object.entries(rest).filter(([k]) => !["id", "wide"].includes(k)).map(([k, v]) => [k, typeof v === "number" ? p.columns[v].name : v])), why })),
            },
            null,
            2,
          )}
        </pre>
      </Drawer>
    </div>
  );
}
