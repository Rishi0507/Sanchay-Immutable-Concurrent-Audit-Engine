// The story page: one 3D scene, fixed behind the page, and a sequence of
// chapters that move the camera through it as the visitor scrolls.

import Lenis from "lenis";
import { Component, ReactNode, Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { callToolAs, health, money } from "../api";
import { Theme, prefersReducedMotion, token, useTheme } from "../theme";
import { BrandMark, Mark, cx } from "../ui";
import { ChapterCopy, buildStatus, chapters, claims, closing, detectors, disclosure, handling, provenanceKey, stats, weClaim, weDoNotClaim } from "./content";
import { Field, flagLabel, makeField } from "./data";
import { Caption, CountUp, Headline, Magnetic, Rail, Reveal, Rise, Source, Ticker } from "./parts";
import Proof from "./Proof";
import type { Palette } from "./Scene";
import { Hover, onHover, story } from "./store";

const Scene = lazy(() => import("./Scene"));
const DEMO_AUDITOR = "auditor-demo-token";

// If WebGL fails, the poster stays and the page still reads.
class Fallback extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function paletteFor(theme: Theme): Palette {
  return {
    background: token("paper"),
    grid: token("line-soft"),
    ice: theme === "dark" ? "#4f86a8" : "#7fb3d3",
    gold: theme === "dark" ? "#d4a84b" : "#b8891c",
    teal: token("pass"),
    vermilion: theme === "dark" ? "#f2603f" : "#d4472a",
    violet: theme === "dark" ? "#a98cf0" : "#7d5bd0",
    dim: theme === "dark" ? 0.2 : 0.35,
    glow: theme === "dark" ? 1.9 : 1,
  };
}

// The same field drawn flat, for reduced motion, no WebGL, and first paint.
function Poster({ field }: { field: Field }) {
  const weeks = useMemo(() => {
    const totals = Array(field.weeks).fill(0);
    for (const s of field.sales) totals[s.week] += s.value;
    const max = Math.max(...totals);
    return totals.map((t) => t / max);
  }, [field]);
  return (
    <svg className="h-full w-full" viewBox="0 0 1000 600" preserveAspectRatio="xMidYMid slice" role="img" aria-label="Weekly sales for a year, rising in the last weeks, above a gold ledger line.">
      {weeks.map((h, i) => (
        <rect key={i} x={120 + i * (780 / weeks.length)} y={420 - h * 240} width={780 / weeks.length - 4} height={h * 240} fill={i >= weeks.length - 3 ? "var(--color-fail)" : "var(--color-wait)"} opacity={0.5} />
      ))}
      <line x1="80" y1="470" x2="920" y2="470" stroke="var(--color-brand)" strokeWidth="3" />
      {Array.from({ length: 22 }, (_, i) => (
        <rect key={i} x={86 + i * 38} y={461} width={22} height={18} fill="var(--color-brand)" />
      ))}
    </svg>
  );
}

function Tooltip() {
  const [hover, setHoverState] = useState<Hover | null>(null);
  useEffect(() => onHover(setHoverState), []);
  if (!hover) return null;
  const s = hover.sale;
  return (
    <div className="pointer-events-none fixed z-40 w-64 rounded-md border border-line bg-paper/95 p-3 shadow-xl backdrop-blur" style={{ left: Math.min(hover.x + 16, window.innerWidth - 280), top: hover.y + 16 }}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="figure text-[13px]">{s.invoiceNo}</span>
        <span className="figure text-[13px] text-ink-2">₹ {money(s.value)}</span>
      </div>
      <ul className="mt-2 space-y-1 text-xs text-ink-2">
        {s.relatedParty && <li className="text-rp">Related party</li>}
        {s.flag && <li className="text-fail">{flagLabel[s.flag]}</li>}
        {s.sampled && <li className="text-brand">Sampled: {s.sampleReason}</li>}
        {!s.relatedParty && !s.flag && !s.sampled && <li>Nothing raised</li>}
      </ul>
      <div className="mt-2">
        <Source kind="Illustrative" />
      </div>
    </div>
  );
}

function Chapter({ copy, index, register, children, hero, action }: { copy: ChapterCopy; index: number; register: (i: number, el: HTMLElement | null) => void; children?: ReactNode; hero?: boolean; action?: ReactNode }) {
  return (
    <section ref={(el) => register(index, el)} className={cx("relative flex items-center px-6 md:px-12 lg:px-20", hero ? "min-h-screen pt-24 pb-16" : "min-h-[118vh] py-24")}>
      {/* A soft fall-off behind the text, so it reads over the scene without a panel. */}
      <div
        aria-hidden
        className={cx("pointer-events-none absolute inset-y-0 w-full lg:w-[62%]", copy.side === "right" ? "right-0" : "left-0")}
        style={{ background: `linear-gradient(to ${copy.side === "right" ? "left" : "right"}, var(--color-paper) 0%, color-mix(in srgb, var(--color-paper) 90%, transparent) 48%, color-mix(in srgb, var(--color-paper) 55%, transparent) 72%, transparent 100%)` }}
      />
      <Reveal className={cx("relative w-full", copy.side === "right" ? "lg:ml-auto" : "", children ? "max-w-none" : copy.side === "right" ? "max-w-[40rem]" : "max-w-[34rem]")}>
        <figure className={cx("max-w-[34rem]", copy.side === "right" && children ? "lg:ml-auto" : "", copy.side === "right" && "lg:mr-24")}>
          <Rise className="mb-6 flex items-center gap-3">
            <span className="figure text-[13px] text-brand">{copy.n}</span>
            <span className="h-px w-8 bg-line" />
            <span className="label text-ink-2">{copy.label}</span>
          </Rise>
          <Headline as={hero ? "h1" : "h2"} lines={copy.lines} className={hero ? "text-[42px] leading-[1.03] sm:text-[58px] lg:text-[72px]" : "text-[34px] leading-[1.06] sm:text-[44px] lg:text-[52px]"} />
          <Rise delay={260} className="mt-6">
            <p className="max-w-[30rem] text-[16px] leading-[1.6] text-ink-2">{copy.body}</p>
          </Rise>
          {action && (
            <Rise delay={380} className="mt-9">
              {action}
            </Rise>
          )}
          <Rise delay={hero ? 520 : 380}>
            <Caption items={copy.legend} note={copy.note} />
          </Rise>
        </figure>
        {children && <Rise delay={460} className="mt-14">{children}</Rise>}
      </Reveal>
    </section>
  );
}

// A full-width band for dense content. It is nearly opaque so tables stay
// legible; the scene shows again as soon as the band ends.
function Band({ children, label, title, source }: { children: ReactNode; label: string; title: string; source?: ReactNode }) {
  return (
    <section className="relative border-y border-line bg-paper/90 px-6 py-20 backdrop-blur-md md:px-12 lg:px-20">
      <Reveal className="mx-auto max-w-[1180px]">
        <Rise className="mb-10 flex flex-wrap items-end justify-between gap-6">
          <div>
            <div className="label mb-3 text-ink-2">{label}</div>
            <h2 className="serif max-w-2xl text-[32px] leading-[1.1] font-[430] tracking-[-0.02em] sm:text-[40px]">{title}</h2>
          </div>
          {source}
        </Rise>
        <Rise delay={140}>{children}</Rise>
      </Reveal>
    </section>
  );
}

function DetectorExplorer() {
  const [open, setOpen] = useState(0);
  const d = detectors[open];
  return (
    <div className="grid gap-px overflow-hidden rounded-lg border border-line bg-line lg:grid-cols-[1fr_1.15fr]">
      <ul className="grid grid-cols-1 gap-px bg-line sm:grid-cols-2" onMouseLeave={() => undefined}>
        {detectors.map((item, i) => (
          <li key={item.id} className="bg-paper">
            <button
              onMouseEnter={() => setOpen(i)}
              onFocus={() => setOpen(i)}
              onClick={() => setOpen(i)}
              aria-pressed={i === open}
              className={cx("flex h-full w-full items-baseline gap-3 px-4 py-3 text-left transition-colors duration-150", i === open ? "bg-brand-wash text-ink" : "text-ink-2 hover:text-ink")}
            >
              <span className={cx("figure text-xs", i === open ? "text-brand" : "text-ink-3")}>{item.id}</span>
              <span className="text-sm font-medium">{item.name}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="bg-paper p-6 md:p-8" aria-live="polite">
        <div className="figure mb-2 text-xs text-brand">{d.id}</div>
        <h3 className="serif mb-6 text-[28px] leading-tight font-[430] tracking-[-0.015em]">{d.name}</h3>
        <dl className="space-y-5">
          <div>
            <dt className="label mb-1.5 text-ink-2">How it works</dt>
            <dd className="text-[15px] leading-relaxed text-ink">{d.how}</dd>
          </div>
          <div>
            <dt className="label mb-1.5 text-pass">What it catches</dt>
            <dd className="text-[15px] leading-relaxed text-ink">{d.catches}</dd>
          </div>
          <div>
            <dt className="label mb-1.5 text-fail">Its limit</dt>
            <dd className="text-[15px] leading-relaxed text-ink">{d.limit}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

const handlingTone = { refused: "text-fail", accepted: "text-pass", caught: "text-brand" } as const;
const handlingWord = { refused: "Refused", accepted: "Handled", caught: "Caught" } as const;

function HandlingMatrix() {
  return (
    <div className="thin-scroll overflow-x-auto rounded-lg border border-line bg-paper">
      <table className="w-full min-w-[760px] text-[14px]">
        <thead>
          <tr className="border-b border-line text-left">
            <th className="label px-5 py-3 font-normal text-ink-2">Scenario</th>
            <th className="label px-5 py-3 font-normal text-ink-2">What happens</th>
            <th className="label px-5 py-3 font-normal text-ink-2">Result</th>
          </tr>
        </thead>
        <tbody>
          {handling.map((h) => (
            <tr key={h.scenario} className="border-b border-line-soft last:border-0 transition-colors duration-150 hover:bg-wash">
              <td className="px-5 py-3.5 font-medium text-ink">{h.scenario}</td>
              <td className="px-5 py-3.5 text-ink-2">{h.happens}</td>
              <td className="px-5 py-3.5 whitespace-nowrap">
                <span className={cx("label mr-2.5", handlingTone[h.tone])}>{handlingWord[h.tone]}</span>
                <span className="figure text-[13px] text-ink">{h.result}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Story({ onOpen }: { onOpen: () => void }) {
  const [theme, setTheme] = useTheme();
  const [active, setActive] = useState(0);
  const [live, setLive] = useState<{ ledger: number | null; trail: number | null; up: boolean | null }>({ ledger: null, trail: null, up: null });
  const sections = useRef<(HTMLElement | null)[]>([]);
  const lenis = useRef<Lenis | null>(null);
  const still = useMemo(prefersReducedMotion, []);
  const compact = useMemo(() => window.innerWidth < 768, []);
  const field = useMemo(() => (compact ? makeField(30, 14) : makeField(52, 24)), [compact]);
  // Tokens are read after the theme attribute has been applied.
  const palette = useMemo(() => paletteFor(theme), [theme]);

  const register = (i: number, el: HTMLElement | null) => {
    sections.current[i] = el;
  };

  // Smooth scrolling, and the story position that drives the camera.
  useEffect(() => {
    const update = () => {
      const mid = window.scrollY + window.innerHeight / 2;
      const centres = sections.current.map((el) => (el ? el.offsetTop + el.offsetHeight / 2 : 0));
      let p = 0;
      if (mid <= centres[0]) p = 0;
      else if (mid >= centres[centres.length - 1]) p = centres.length - 1;
      else {
        for (let i = 0; i < centres.length - 1; i++) {
          if (mid >= centres[i] && mid < centres[i + 1]) {
            p = i + (mid - centres[i]) / (centres[i + 1] - centres[i]);
            break;
          }
        }
      }
      story.p = p;
      setActive((a) => (Math.round(p) === a ? a : Math.round(p)));
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);

    let frame = 0;
    if (!still) {
      const l = new Lenis({ lerp: 0.11, wheelMultiplier: 0.9 });
      lenis.current = l;
      const loop = (time: number) => {
        l.raf(time);
        frame = requestAnimationFrame(loop);
      };
      frame = requestAnimationFrame(loop);
    }
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      cancelAnimationFrame(frame);
      lenis.current?.destroy();
      lenis.current = null;
      story.p = 0;
    };
  }, [still]);

  // Live figures: service health, and a real recomputation of the ledger.
  useEffect(() => {
    health().then((h) => setLive((v) => ({ ...v, up: h ? h.ledger && h.database : false })));
    callToolAs(DEMO_AUDITOR, "verify_ledger_integrity", {})
      .then((r) => setLive((v) => ({ ...v, ledger: Number(r.business_chain?.checked ?? 0), trail: Number(r.trail_chain?.checked ?? 0) })))
      .catch(() => undefined);
  }, []);

  const go = (i: number) => {
    const el = sections.current[i];
    if (!el) return;
    const top = el.offsetTop + el.offsetHeight / 2 - window.innerHeight / 2;
    if (lenis.current) lenis.current.scrollTo(top, { duration: 1.4 });
    else window.scrollTo({ top });
  };

  const rail = [...chapters.map((c) => ({ n: c.n, label: c.label })), { n: "09", label: "Begin" }];
  const poster = <Poster field={field} />;

  return (
    <div className="grain relative">
      <div className="fixed inset-0 z-0" aria-hidden>
        {still ? (
          <div className="h-full w-full opacity-70">{poster}</div>
        ) : (
          <Fallback fallback={<div className="h-full w-full opacity-70">{poster}</div>}>
            <Suspense fallback={null}>
              <Scene key={theme} field={field} palette={palette} compact={compact} />
            </Suspense>
          </Fallback>
        )}
      </div>

      <header className="fixed inset-x-0 top-0 z-30 flex h-16 items-center justify-between gap-6 px-6 md:px-12 lg:px-20" style={{ background: "linear-gradient(to bottom, var(--color-paper) 0%, color-mix(in srgb, var(--color-paper) 70%, transparent) 60%, transparent 100%)" }}>
        <div className="flex items-center gap-2.5 text-[15px] font-semibold tracking-[-0.01em]">
          <BrandMark size={28} />
          Sanchay
        </div>
        <div className="flex items-center gap-5 text-[13px]">
          {live.up !== null && (
            <span className="hidden items-center gap-2 text-ink-2 sm:flex">
              <span className={cx("h-1.5 w-1.5 rounded-full", live.up ? "bg-pass" : "bg-fail")} />
              {live.up ? "Ledger running" : "Ledger not reachable"}
            </span>
          )}
          <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")} className="font-medium text-ink-2 transition-colors hover:text-ink">
            {theme === "dark" ? "Light" : "Dark"}
          </button>
          <button onClick={onOpen} className="inline-flex h-9 items-center rounded-full border border-line px-4 font-medium text-ink transition-colors hover:border-brand hover:text-brand">
            Sign in
          </button>
        </div>
      </header>

      <Rail chapters={rail} active={active} onGo={go} />
      <Tooltip />

      <main className="relative z-10">
        <Chapter
          copy={chapters[0]}
          index={0}
          register={register}
          hero
          action={
            <div className="flex flex-wrap items-center gap-x-7 gap-y-4">
              <Magnetic onClick={onOpen}>Open the workspace</Magnetic>
              <button onClick={() => go(1)} className="text-[15px] font-medium text-ink-2 underline decoration-line underline-offset-[6px] transition-colors hover:text-ink hover:decoration-brand">
                See how it works
              </button>
            </div>
          }
        />

        <section className="relative border-y border-line bg-paper/88 backdrop-blur-md">
          <Reveal className="mx-auto grid max-w-[1320px] gap-px bg-line sm:grid-cols-2 lg:grid-cols-4">
            {stats.map((s, i) => {
              const value = s.value === "ledger" ? live.ledger : s.value === "trail" ? live.trail : s.value;
              return (
                <Rise key={s.text} delay={i * 90} className="bg-paper px-6 py-8 md:px-8">
                  <div className="mb-4">
                    <Source kind={s.source} />
                  </div>
                  <div className="text-[44px] leading-none tracking-[-0.03em] text-ink lg:text-[52px]">
                    <CountUp value={value} suffix={s.suffix} />
                  </div>
                  <p className="mt-3 max-w-[15rem] text-[13px] leading-snug text-ink-2">{value === null && s.value === "ledger" ? "the ledger could not be reached from this page" : s.text}</p>
                </Rise>
              );
            })}
          </Reveal>
          <div className="mx-auto flex max-w-[1320px] flex-wrap gap-x-7 gap-y-2 border-t border-line px-6 py-3.5 md:px-8">
            {provenanceKey.map((k) => (
              <span key={k.kind} className="flex items-center gap-2 text-xs text-ink-3">
                <Source kind={k.kind} />
                {k.text}
              </span>
            ))}
          </div>
        </section>

        <Chapter copy={chapters[1]} index={1} register={register} />
        <Ticker items={claims} />
        <Chapter copy={chapters[2]} index={2} register={register} />
        <Chapter copy={chapters[3]} index={3} register={register} />
        <Chapter copy={chapters[4]} index={4} register={register} />

        <Band label="How it handles" title="What happens when something goes wrong, or someone tries." source={<Source kind="Measured" />}>
          <HandlingMatrix />
          <p className="mt-4 text-[13px] text-ink-3">Each row is asserted by the end-to-end check that runs against the live services.</p>
        </Band>

        <Chapter copy={chapters[5]} index={5} register={register} />

        <Band label="Sixteen detectors" title="What each one does, what it catches, and where it stops." source={<Source kind="Specified" />}>
          <DetectorExplorer />
        </Band>

        <Chapter copy={chapters[6]} index={6} register={register} />

        <Band label="In plain terms" title="What we claim, and what we do not.">
          <div className="grid gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-2">
            <div className="bg-paper p-6 md:p-8">
              <div className="label mb-5 text-pass">We claim</div>
              <ul className="space-y-4">
                {weClaim.map((c) => (
                  <li key={c} className="flex gap-3 text-[15px] leading-relaxed text-ink">
                    <span className="mt-1 shrink-0 text-pass">
                      <Mark tone="good" />
                    </span>
                    {c}
                  </li>
                ))}
              </ul>
            </div>
            <div className="bg-paper p-6 md:p-8">
              <div className="label mb-5 text-fail">We do not claim</div>
              <ul className="space-y-4">
                {weDoNotClaim.map((c) => (
                  <li key={c} className="flex gap-3 text-[15px] leading-relaxed text-ink">
                    <span className="mt-1 shrink-0 text-fail">
                      <Mark tone="bad" />
                    </span>
                    {c}
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <p className="mt-5 max-w-3xl border-l-2 border-brand pl-4 text-[14px] leading-relaxed text-ink-2">{buildStatus}</p>
        </Band>

        <Chapter copy={chapters[7]} index={7} register={register}>
          <Proof />
        </Chapter>

        <section ref={(el) => register(8, el)} className="relative flex min-h-screen items-center justify-center px-6 py-24 text-center">
          <Reveal className="mx-auto max-w-3xl">
            <Headline lines={closing.lines} className="text-[44px] leading-[1.02] sm:text-[64px] lg:text-[80px]" />
            <Rise delay={280} className="mx-auto mt-7 max-w-md">
              <p className="text-[16px] leading-[1.6] text-ink-2">{closing.body}</p>
            </Rise>
            <Rise delay={400} className="mt-10 flex justify-center">
              <Magnetic onClick={onOpen}>Open the workspace</Magnetic>
            </Rise>
          </Reveal>
        </section>

        <footer className="relative border-t border-line bg-paper/90 px-6 py-6 backdrop-blur-md md:px-12 lg:px-20">
          <div className="ticks mx-auto flex max-w-[1320px] flex-wrap items-center justify-between gap-4 pb-4">
            <p className="max-w-3xl text-xs leading-relaxed text-ink-3">{disclosure}</p>
            <span className="label text-ink-3">ELEV05, Elevate 1.0</span>
          </div>
        </footer>
      </main>
    </div>
  );
}
