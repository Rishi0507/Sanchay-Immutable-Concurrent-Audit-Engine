// Small pieces of the story page: reveals, counters, the ticker, the rail.

import { ReactNode, useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "../theme";
import { cx } from "../ui";

// Adds the class "in" the first time the element enters the viewport.
export function Reveal({ children, className, as: Tag = "div" }: { children: ReactNode; className?: string; as?: "div" | "section" | "li" }) {
  const ref = useRef<HTMLElement>(null);
  // Held in state, so a re-render of the page cannot take the class away.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const seen = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShown(true);
          seen.disconnect();
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -6% 0px" },
    );
    seen.observe(el);
    return () => seen.disconnect();
  }, []);
  return (
    <Tag ref={ref as any} className={cx("reveal", shown && "in", className)}>
      {children}
    </Tag>
  );
}

// A headline that arrives one line at a time, each rising out of a mask.
export function Headline({ lines, className, as: Tag = "h2" }: { lines: string[]; className?: string; as?: "h1" | "h2" }) {
  return (
    <Tag className={cx("serif font-[430] tracking-[-0.022em] text-ink", className)}>
      {lines.map((line, i) => (
        <span key={line} className="line-mask lg:w-max">
          <span className="lg:whitespace-nowrap" style={{ transitionDelay: `${i * 110}ms` }}>{line}</span>
        </span>
      ))}
    </Tag>
  );
}

export function Rise({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  return (
    <div className={cx("rise", className)} style={{ transitionDelay: `${delay}ms` }}>
      {children}
    </div>
  );
}

export type Provenance = "Live" | "Measured" | "Tested" | "Specified" | "Illustrative";

const provenanceTone: Record<Provenance, string> = {
  Live: "text-pass border-pass/40",
  Measured: "text-wait border-wait/40",
  Tested: "text-wait border-wait/40",
  Specified: "text-ink-2 border-line",
  Illustrative: "text-ink-2 border-line",
};

// Where a figure comes from. No number on the page appears without one.
export function Source({ kind }: { kind: Provenance }) {
  return (
    <span className={cx("label inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-[3px]", provenanceTone[kind])}>
      {kind === "Live" && <span className="h-1.5 w-1.5 rounded-full bg-pass" />}
      {kind}
    </span>
  );
}

// Counts up once when it enters the viewport, then holds. Tabular figures
// keep the width steady while it runs.
export function CountUp({ value, suffix = "", className }: { value: number | null; suffix?: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState<number | null>(prefersReducedMotion() ? value : 0);
  const started = useRef(false);

  useEffect(() => {
    if (value === null) return;
    if (prefersReducedMotion()) {
      setShown(value);
      return;
    }
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const run = () => {
      const begin = performance.now();
      const tick = (now: number) => {
        const t = Math.min(1, (now - begin) / 1400);
        setShown(Math.round(value * (1 - Math.pow(1 - t, 3))));
        if (t < 1) frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    };
    if (started.current) {
      setShown(value);
      return;
    }
    const seen = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        started.current = true;
        seen.disconnect();
        run();
      }
    });
    seen.observe(el);
    return () => {
      seen.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [value]);

  return (
    <span ref={ref} className={cx("figure", className)}>
      {value === null || shown === null ? "n/a" : shown.toLocaleString("en-IN")}
      {value !== null && suffix}
    </span>
  );
}

export function Ticker({ items }: { items: string[] }) {
  const row = (hidden: boolean) => (
    <div className="flex shrink-0 items-center" aria-hidden={hidden}>
      {items.map((item) => (
        <span key={item} className="flex items-center whitespace-nowrap">
          <span className="serif px-8 text-[26px] italic text-ink md:text-[32px]">{item}</span>
          <span className="h-1.5 w-1.5 rotate-45 bg-brand" />
        </span>
      ))}
    </div>
  );
  return (
    <div className="overflow-hidden border-y border-line bg-paper/85 py-5 backdrop-blur-sm">
      <div className="marquee flex w-max">
        {row(false)}
        {row(true)}
      </div>
    </div>
  );
}

// The primary call to action leans toward the pointer. Only this one does.
export function Magnetic({ children, onClick, className }: { children: ReactNode; onClick: () => void; className?: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion()) return;
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      const near = Math.hypot(dx, dy) < Math.max(r.width, 140);
      el.style.transform = near ? `translate(${dx * 0.22}px, ${dy * 0.3}px)` : "";
    };
    window.addEventListener("pointermove", move);
    return () => window.removeEventListener("pointermove", move);
  }, []);
  return (
    <button
      ref={ref}
      onClick={onClick}
      className={cx(
        "inline-flex h-12 items-center gap-3 rounded-full bg-brand pr-5 pl-6 text-[15px] font-semibold text-on-brand transition-[transform,background-color] duration-200 ease-out hover:bg-brand-deep",
        className,
      )}
    >
      {children}
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M3 8h10M9 4l4 4-4 4" />
      </svg>
    </button>
  );
}

// A thin rail that shows where the visitor is in the story.
export function Rail({ chapters, active, onGo }: { chapters: { n: string; label: string }[]; active: number; onGo: (i: number) => void }) {
  return (
    <nav className="fixed top-1/2 right-5 z-30 hidden -translate-y-1/2 lg:block" aria-label="Chapters">
      <ol className="relative flex flex-col gap-[14px] border-r border-line pr-3">
        {chapters.map((c, i) => (
          <li key={c.n} className="flex justify-end">
            <button onClick={() => onGo(i)} aria-current={i === active ? "step" : undefined} className="group relative flex items-center gap-2 text-right">
              <span className={cx("label transition-all duration-200", i === active ? "text-ink opacity-100" : "text-ink-3 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100")}>{c.label}</span>
              <span className={cx("figure text-[11px] transition-colors duration-200", i === active ? "text-brand" : "text-ink-3")}>{c.n}</span>
              <span className={cx("absolute top-1/2 -right-[13px] h-3 w-px -translate-y-1/2 transition-all duration-200", i === active ? "w-[3px] bg-brand" : "bg-transparent")} />
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

const swatch: Record<string, string> = {
  gold: "bg-brand",
  ice: "bg-wait",
  teal: "bg-pass",
  vermilion: "bg-fail",
  violet: "bg-rp",
  frame: "border border-fail bg-transparent",
  dim: "bg-ink-3",
};

export interface LegendItem {
  colour: keyof typeof swatch;
  text: string;
}

// The caption under each 3D moment: what every colour and shape encodes.
export function Caption({ items, source = "Illustrative", note }: { items: LegendItem[]; source?: Provenance; note?: string }) {
  return (
    <figcaption className="mt-8 border-t border-line pt-4">
      <div className="mb-3 flex items-center justify-between gap-4">
        <span className="label text-ink-2">What you are looking at</span>
        <Source kind={source} />
      </div>
      <ul className="space-y-1.5">
        {items.map((item) => (
          <li key={item.text} className="flex items-baseline gap-2.5 text-[13px] leading-snug text-ink-2">
            <span className={cx("relative top-px h-2.5 w-2.5 shrink-0 rounded-[2px]", swatch[item.colour])} />
            {item.text}
          </li>
        ))}
      </ul>
      {note && <p className="mt-3 text-[13px] text-ink-3">{note}</p>}
    </figcaption>
  );
}
