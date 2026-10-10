// The front page: the whole system told as one story, in six chapters, over a
// 3D scene of a year's sales. Each chapter is one page of the workspace.

import { Component, ReactNode, Suspense, lazy, useEffect, useRef, useState } from "react";
import { BrandMark, Mark, cx } from "../ui";
import { Stamp } from "../Stamp";
import { Guilloche, Microtext, Serial, ShiftInk, Thread, Watermark } from "../print";
import { prefersReducedMotion, usePalette, useUv } from "../theme";
import { PalettePicker, UvSwitch } from "../inks";
import type { StoryState } from "./Scene";
// Devanagari for the name, as a note carries its words in Hindi too. Loaded with this page only.
import "@fontsource-variable/anek-devanagari/wght.css";

const Scene = lazy(() => import("./Scene"));

interface Chapter {
  n: string;
  tab: string;
  tabLabel: string;
  title: string;
  body: string;
  stat: [string, string];
}

// Figures in the stats are from the planted FY 2025-26 demo year as the engine audited it.
export const chapters: Chapter[] = [
  {
    n: "01",
    tab: "register",
    tabLabel: "Register",
    title: "A year of business. 6,885 sales.",
    body: "Each sale is an order, a dispatch, an invoice and a payment. Sanchay records every step as an event in a ledger nobody can edit, then reads the client's own register against it, row by row.",
    stat: ["6,885", "register rows compared with the books"],
  },
  {
    n: "02",
    tab: "samples",
    tabLabel: "Samples",
    title: "An auditor can test thirty.",
    body: "The thirty are weighted by risk and drawn from a seed sealed before the auditor ever sees the register. Nobody picks them, so nobody can steer them away from a problem.",
    stat: ["30", "sales tested against their papers"],
  },
  {
    n: "03",
    tab: "findings",
    tabLabel: "Findings",
    title: "Hold them to the light.",
    body: "Sixteen detectors look for the marks a fake sale leaves: an invoice with no dispatch, a GSTIN that cannot exist, a credit note after the year end, a document made only for the request.",
    stat: ["118", "findings in the demo year, 46 of them high"],
  },
  {
    n: "04",
    tab: "graph",
    tabLabel: "Graph",
    title: "Money that goes round in circles.",
    body: "Goods sold to a friend who sells them back are revenue that never happened. The counterparty graph follows goods and money until they come back to where they started.",
    stat: ["₹1.54 Cr", "of circular trading found in the demo year"],
  },
  {
    n: "05",
    tab: "trail",
    tabLabel: "Trail",
    title: "Sealed, so no one can change it.",
    body: "Every event is hashed into the one before it. Change a single stored record and every hash after it breaks, and the audit trail shows exactly where.",
    stat: ["SHA-256", "on every event and every tool call"],
  },
  {
    n: "06",
    tab: "export",
    tabLabel: "Export",
    title: "Then a person signs.",
    body: "The agent proposes and the audit manager decides. No finding is final until a person confirms it, and the memo, the workpaper and the summary each carry the ledger hash they rest on.",
    stat: ["0", "findings made final without a person"],
  },
];

// If WebGL fails, the page keeps its story over a still rosette.
class Safe extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function useInView<T extends HTMLElement>(threshold = 0.35) {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setSeen(true), { threshold });
    io.observe(el);
    return () => io.disconnect();
  }, [threshold]);
  return [ref, seen] as const;
}

function ChapterPanel({ c, i, onOpen }: { c: Chapter; i: number; onOpen: (tab: string) => void }) {
  const [ref, seen] = useInView<HTMLDivElement>();
  const right = i % 2 === 1;
  return (
    <section className={cx("relative flex h-screen items-center px-6 md:px-16 lg:pr-28", right ? "justify-end" : "justify-start")} aria-labelledby={`ch-${c.n}`}>
      <div ref={ref} className={cx("note relative w-full max-w-[540px] overflow-hidden rounded-[26px] border border-white/12 bg-[color-mix(in_oklab,var(--color-spine)_88%,transparent)] p-8 text-spine-ink shadow-[0_40px_100px_-40px_rgba(0,0,0,0.8)] backdrop-blur-md transition-[opacity,transform] duration-700 md:p-10", seen ? "translate-y-0 opacity-100" : "translate-y-10 opacity-0")}>
        <Guilloche size={300} className="absolute -top-24 -right-24 opacity-40" tone="var(--color-spine-ink-2)" layers={2} />
        <Watermark className="absolute right-8 bottom-8 h-24 w-24" />
        <div className="relative">
          <div className="flex items-center gap-4">
            <ShiftInk className="display text-[64px] leading-none" >
              <Serial value={c.n} from={0.6} />
            </ShiftInk>
            <Thread className="h-2.5 flex-1" />
          </div>
          <h2 id={`ch-${c.n}`} className="display mt-5 text-[40px] leading-[1.02] md:text-[50px]">
            {c.title}
          </h2>
          <p className="mt-4 text-[17px] leading-relaxed text-spine-ink-2">{c.body}</p>
          <div className="mt-6 flex flex-wrap items-end justify-between gap-4 border-t border-white/12 pt-5">
            <div>
              <div className="amount text-[40px] leading-none text-highlight">{c.stat[0]}</div>
              <div className="mt-1 text-[14px] text-spine-ink-2">{c.stat[1]}</div>
            </div>
            <button onClick={() => onOpen(c.tab)} className="group inline-flex h-11 items-center gap-2 rounded-full bg-spine-ink px-5 text-[15px] font-bold text-spine transition-transform hover:-translate-y-0.5">
              Open the {c.tabLabel} page
              <svg className="transition-transform group-hover:translate-x-0.5" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M6 3.5L10.5 8 6 12.5" />
              </svg>
            </button>
          </div>
          <Microtext className="mt-6 opacity-70" />
        </div>
        {i === 5 && seen && <Stamp word="SIGNED OFF" tone="pass" className="stamp -top-4 right-4" small />}
      </div>
    </section>
  );
}

export default function Landing({ onInspect, onWorkspace }: { onInspect: () => void; onWorkspace: (tab?: string) => void }) {
  const story = useRef<StoryState>({ p: 0, px: 0, py: 0 });
  const [at, setAt] = useState(0);
  const [palette] = usePalette();
  const [uv] = useUv();
  const [ok3d, setOk3d] = useState(true);

  useEffect(() => {
    try {
      const c = document.createElement("canvas");
      setOk3d(!!(c.getContext("webgl2") || c.getContext("webgl")));
    } catch {
      setOk3d(false);
    }
    const onScroll = () => {
      const p = window.scrollY / window.innerHeight;
      story.current.p = p;
      setAt(Math.round(p));
    };
    const onMove = (e: PointerEvent) => {
      story.current.px = (e.clientX / window.innerWidth) * 2 - 1;
      story.current.py = (e.clientY / window.innerHeight) * 2 - 1;
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pointermove", onMove);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pointermove", onMove);
    };
  }, []);

  const go = (i: number) => window.scrollTo({ top: i * window.innerHeight, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  const still = (
    <div className="flex h-full items-center justify-center">
      <Guilloche size={760} tone="var(--color-spine-ink-2)" layers={4} className="opacity-30" />
    </div>
  );

  return (
    <div className="relative bg-spine text-spine-ink">
      {/* The scene sits behind every chapter. */}
      <div className="fixed inset-0" aria-hidden>
        {ok3d ? (
          <Safe fallback={still}>
            <Suspense fallback={still}>
              <Scene key={`${palette}-${uv}`} story={story} />
            </Suspense>
          </Safe>
        ) : (
          still
        )}
      </div>

      <header className="fixed inset-x-0 top-0 z-30 flex items-center justify-between gap-4 px-6 py-4 md:px-10">
        <button onClick={() => go(0)} className="flex items-center gap-3">
          <BrandMark size={38} />
          <span className="display text-[24px]">Sanchay</span>
        </button>
        <div className="flex items-center gap-3">
          <div className="hidden items-center gap-3 rounded-full border border-white/15 bg-black/20 px-3 py-1.5 backdrop-blur md:flex">
            <span className="text-[13px] font-semibold text-spine-ink-2">Ink</span>
            <PalettePicker compact onDark />
          </div>
          <UvSwitch onDark />
          <button onClick={() => onWorkspace()} className="hidden h-9 items-center rounded-full bg-spine-ink px-4 text-[14px] font-bold text-spine sm:inline-flex">
            Open the workspace
          </button>
        </div>
      </header>

      {/* Chapter rail. */}
      <nav className="fixed top-1/2 right-4 z-30 hidden -translate-y-1/2 flex-col gap-2.5 lg:flex" aria-label="Chapters">
        {["Start", ...chapters.map((c) => c.tabLabel), "Try it"].map((label, i) => (
          <button key={label} onClick={() => go(i)} className="group flex items-center justify-end gap-2.5" aria-current={at === i ? "step" : undefined}>
            <span className={cx("text-[13px] font-semibold transition-opacity", at === i ? "text-spine-ink opacity-100" : "text-spine-ink-2 opacity-0 group-hover:opacity-100")}>{label}</span>
            <span className={cx("block rounded-full transition-all duration-300", at === i ? "h-3 w-3 bg-highlight shadow-[0_0_12px_var(--color-highlight)]" : "h-2 w-2 bg-white/35")} />
          </button>
        ))}
      </nav>

      <div className="relative z-10">
        {/* The question. A shade behind the words keeps them readable over the scene. */}
        <section className="relative flex h-screen flex-col justify-end px-6 pb-16 md:px-16">
          <div className="pointer-events-none absolute inset-y-0 left-0 w-full bg-gradient-to-r from-spine via-spine/70 to-transparent md:w-[62%]" aria-hidden />
          <div className="pointer-events-none absolute top-24 left-1/2 -translate-x-1/2 text-center">
            <div className="text-[13vw] leading-none font-bold text-white/[0.04] select-none" style={{ fontFamily: '"Anek Devanagari Variable", sans-serif' }} aria-hidden>
              सञ्चय
            </div>
          </div>
          <div className="relative max-w-3xl">
            <h1 className="display text-[56px] leading-[0.95] md:text-[96px]" style={{ fontVariationSettings: '"wdth" 76' }}>
              Is this sale <ShiftInk>genuine?</ShiftInk>
            </h1>
            <p className="mt-5 max-w-xl text-[19px] leading-relaxed text-spine-ink-2">
              A bank checks every note it is handed. An auditor checks thirty sales out of seven thousand. Sanchay checks every sale against its record, and shows you which ones would not pass.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <button onClick={onInspect} className="inline-flex h-13 items-center gap-2.5 rounded-full bg-highlight px-6 text-[17px] font-bold text-spine shadow-[0_10px_40px_-10px_var(--color-highlight)] transition-transform hover:-translate-y-0.5">
                <Mark tone="good" size={18} />
                Inspect a register now
              </button>
              <button onClick={() => go(1)} className="inline-flex h-13 items-center gap-2 rounded-full border border-white/25 px-6 text-[17px] font-bold transition-colors hover:border-white/60">
                See how it works
              </button>
            </div>
          </div>
          <div className="relative mt-10 flex items-center gap-3 text-[14px] text-spine-ink-2">
            <span className="scroll-cue block h-10 w-[2px] overflow-hidden rounded-full bg-white/15" />
            Scroll: six chapters, one sale at a time
          </div>
        </section>

        {chapters.map((c, i) => (
          <ChapterPanel key={c.n} c={c} i={i} onOpen={(tab) => onWorkspace(tab)} />
        ))}

        {/* Try it. */}
        <section className="relative flex min-h-screen items-center px-6 py-24 md:px-16">
          <div className="mx-auto grid w-full max-w-6xl gap-6 lg:grid-cols-2">
            <div className="lg:col-span-2">
              <h2 className="display text-[48px] leading-none md:text-[76px]" style={{ fontVariationSettings: '"wdth" 78' }}>
                Try it on a register.
              </h2>
              <p className="mt-4 max-w-2xl text-[18px] text-spine-ink-2">Two ways in. Neither needs anything installed.</p>
            </div>
            <button onClick={onInspect} className="note group relative overflow-hidden rounded-[26px] bg-paper p-8 text-left text-ink shadow-[0_40px_100px_-40px_rgba(0,0,0,0.8)] transition-transform hover:-translate-y-1">
              <Guilloche size={340} className="absolute -right-24 -bottom-24 opacity-70" />
              <Watermark className="absolute top-6 right-6 h-20 w-20" />
              <div className="relative">
                <div className="text-[15px] font-bold text-brand">In this browser, right now</div>
                <div className="display mt-2 text-[36px] leading-[1.05]">Inspect a register</div>
                <p className="mt-3 max-w-sm text-[16px] text-ink-2">Drop any Excel, CSV or JSON file, or use the demo year. Sanchay reads it, builds the page it deserves, seals every row and runs fourteen tests.</p>
                <span className="mt-6 inline-flex h-11 items-center rounded-full bg-brand px-5 text-[15px] font-bold text-on-brand">Open the Lens</span>
              </div>
            </button>
            <button onClick={() => onWorkspace()} className="note group relative overflow-hidden rounded-[26px] border border-white/15 bg-[color-mix(in_oklab,var(--color-spine)_85%,transparent)] p-8 text-left backdrop-blur transition-transform hover:-translate-y-1">
              <Guilloche size={340} className="absolute -right-24 -bottom-24 opacity-40" tone="var(--color-spine-ink-2)" />
              <div className="relative">
                <div className="text-[15px] font-bold text-highlight">The full system</div>
                <div className="display mt-2 text-[36px] leading-[1.05]">Open the workspace</div>
                <p className="mt-3 max-w-sm text-[16px] text-spine-ink-2">Sign in as the auditor, the audit manager or a department of the client. Each sees only what its role allows.</p>
                <span className="mt-6 inline-flex h-11 items-center rounded-full bg-spine-ink px-5 text-[15px] font-bold text-spine">Sign in</span>
              </div>
            </button>
            <div className="flex flex-wrap items-center justify-between gap-4 rounded-[22px] border border-white/12 bg-black/20 px-6 py-5 backdrop-blur lg:col-span-2">
              <div>
                <div className="text-[16px] font-bold">Print it in another ink</div>
                <div className="text-[14px] text-spine-ink-2">Each palette is the ink of an Indian banknote. The whole system follows, the 3D included.</div>
              </div>
              <PalettePicker onDark />
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
