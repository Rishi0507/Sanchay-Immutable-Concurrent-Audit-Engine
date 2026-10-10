// Security print: the marks a banknote carries to prove it is genuine, drawn
// for the screen. Sanchay asks the same question of every sale.

import { CSSProperties, ReactNode, useEffect, useMemo } from "react";
import { cx } from "./ui";

// ---------------------------------------------------------------- Guilloche

// One rosette: a hypotrochoid, the curve a spirograph draws, which is what the
// engraving lathes on a note cut. Several are laid over each other.
function rosette(R: number, r: number, d: number, turns: number, cx0: number, cy0: number, scale: number) {
  const pts: string[] = [];
  const steps = Math.ceil(turns * 1440);
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * turns * Math.PI * 2;
    const x = (R - r) * Math.cos(t) + d * Math.cos(((R - r) / r) * t);
    const y = (R - r) * Math.sin(t) - d * Math.sin(((R - r) / r) * t);
    pts.push(`${(cx0 + x * scale).toFixed(1)},${(cy0 + y * scale).toFixed(1)}`);
  }
  return `M${pts.join("L")}`;
}

// A guilloche medallion. It turns slowly, and the layers turn against each other.
export function Guilloche({ size = 320, className, style, spin = true, layers = 3, tone = "var(--color-guilloche)" }: { size?: number; className?: string; style?: CSSProperties; spin?: boolean; layers?: number; tone?: string }) {
  const paths = useMemo(() => {
    const c = size / 2;
    const s = size / 220;
    // Whole-number ratios close in one turn and give that many petals. Each
    // reach, R - r + d, stays inside the medallion.
    const sets: [number, number, number, number][] = [
      [80, 10, 26, 1],
      [80, 8, 20, 1],
      [72, 4, 14, 1],
      [48, 6, 14, 1],
    ];
    return sets.slice(0, layers).map(([R, r, d, turns]) => rosette(R, r, d, turns, c, c, s));
  }, [size, layers]);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={cx("pointer-events-none", className)} style={style} aria-hidden fill="none">
      {paths.map((d, i) => (
        <path key={i} d={d} stroke={tone} strokeWidth={i === 0 ? 0.7 : 0.55} opacity={0.9 - i * 0.18} className={spin ? (i % 2 ? "spin-rev" : "spin") : undefined} style={{ transformOrigin: "50% 50%", animationDuration: `${90 + i * 40}s` }} />
      ))}
    </svg>
  );
}

// Fine parallel waves, the background of a note's panel.
export function WaveLines({ className, rows = 14, tone = "var(--color-guilloche)" }: { className?: string; rows?: number; tone?: string }) {
  const d = useMemo(() => {
    const out: string[] = [];
    for (let r = 0; r < rows; r++) {
      const y0 = 6 + r * 7;
      const pts: string[] = [];
      for (let x = 0; x <= 600; x += 6) pts.push(`${x},${(y0 + Math.sin(x / 38 + r * 0.55) * 4 + Math.sin(x / 11 + r) * 0.8).toFixed(1)}`);
      out.push(`M${pts.join("L")}`);
    }
    return out.join("");
  }, [rows]);
  return (
    <svg viewBox={`0 0 600 ${rows * 7 + 12}`} preserveAspectRatio="none" className={cx("pointer-events-none", className)} aria-hidden>
      <path d={d} fill="none" stroke={tone} strokeWidth={0.6} vectorEffect="non-scaling-stroke" opacity={0.55} />
    </svg>
  );
}

// ---------------------------------------------------------------- Security thread

// The windowed metal thread, its foil shifting colour as the page moves.
export function Thread({ vertical, className }: { vertical?: boolean; className?: string }) {
  // It takes the caller's positioning, and has none of its own, so it can run
  // down an edge (absolute) or sit in a row (in the flow).
  return <div className={cx("thread", vertical ? "thread-v w-1.5" : "h-1.5", className)} aria-hidden />;
}

// ---------------------------------------------------------------- Microtext

// A line of tiny repeated words: readable under a lens, a texture to the eye.
export function Microtext({ text = "SANCHAY GENUINE SALE VERIFIED AGAINST ITS RECORD", className }: { text?: string; className?: string }) {
  return (
    <div className={cx("overflow-hidden font-mono text-[6.5px] leading-none whitespace-nowrap text-guilloche select-none", className)} aria-hidden>
      {Array.from({ length: 12 }, () => text).join("   ")}
    </div>
  );
}

// ---------------------------------------------------------------- Serial

// Digits that grow from left to right, the way a note's serial number does.
export function Serial({ value, from = 0.55, className }: { value: string; from?: number; className?: string }) {
  const chars = [...value];
  return (
    <span className={cx("inline-flex items-baseline", className)} aria-label={value}>
      {chars.map((c, i) => (
        <span key={i} aria-hidden style={{ fontSize: `${from + ((1 - from) * i) / Math.max(1, chars.length - 1)}em` }}>
          {c}
        </span>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------- Colour-shift ink

// Text printed in colour-shift ink: it moves from one colour to the other as
// the pointer moves, the way the numeral on a note does when it is tilted.
export function ShiftInk({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("shift-ink", className)}>{children}</span>;
}

// Follows the pointer across the window and writes it to two CSS variables
// that colour-shift ink and holograms read. Mounted once, at the root.
export function useTilt() {
  useEffect(() => {
    let raf = 0;
    const on = (e: PointerEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const x = e.clientX / window.innerWidth;
        const y = e.clientY / window.innerHeight;
        const h = document.documentElement.style;
        h.setProperty("--tilt-x", x.toFixed(3));
        h.setProperty("--tilt-y", y.toFixed(3));
      });
    };
    window.addEventListener("pointermove", on);
    return () => {
      window.removeEventListener("pointermove", on);
      cancelAnimationFrame(raf);
    };
  }, []);
}

// ---------------------------------------------------------------- Watermark

// The emblem, faint until the reader holds the panel to the light (hovers it).
export function Watermark({ className }: { className?: string }) {
  return <img src="/logo-mark.png" alt="" aria-hidden className={cx("watermark pointer-events-none select-none", className)} />;
}

// ---------------------------------------------------------------- Denomination

// A chapter number printed the way a note prints its value: inside a small
// rosette, in colour-shift ink.
export function Denomination({ n, size = 50, onDark }: { n: string; size?: number; onDark?: boolean }) {
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }} aria-label={`Chapter ${n}`}>
      <Guilloche size={size} layers={2} tone={onDark ? "var(--color-spine-ink-2)" : "var(--color-guilloche)"} className="absolute inset-0" />
      <ShiftInk className="display relative text-[26px] leading-none" >
        {n}
      </ShiftInk>
    </span>
  );
}

// ---------------------------------------------------------------- The note band

// Each page opens like a note: its chapter of the story on the front page,
// a turning rosette, the watermark when held to the light, and the thread.
const pageStory: { test: RegExp; n?: string; line: string }[] = [
  { test: /^overview$/i, line: "Is this sale genuine? The answer, on one page." },
  { test: /register/i, n: "01", line: "A year of business, read against the books row by row." },
  { test: /sample/i, n: "02", line: "Thirty sales, drawn from a seed nobody chooses." },
  { test: /finding/i, n: "03", line: "Held to the light: the marks a fake sale leaves." },
  { test: /graph/i, n: "04", line: "Money that goes round in circles." },
  { test: /trail/i, n: "05", line: "Sealed, so no one can change it." },
  { test: /export/i, n: "06", line: "Then a person signs." },
  { test: /open an engagement/i, line: "Freeze the books, then the audit begins." },
  { test: /upload/i, line: "The register you send is sealed the moment it arrives." },
  { test: /request/i, line: "The auditor asks. You answer with the paper, or say it does not exist." },
  { test: /new record/i, line: "A new event, appended under your name. Never edited, only reversed." },
  { test: /record/i, line: "Every step of every sale, in a ledger nobody can edit." },
  { test: /access/i, line: "No one department can sell, ship, bill and collect." },
  { test: /lens/i, line: "Any register, audited in this browser." },
];

export function NoteBand({ title, eyebrow, summary, action }: { title: string; eyebrow?: ReactNode; summary?: ReactNode; action?: ReactNode }) {
  const story = pageStory.find((s) => s.test.test(title));
  return (
    <section className="note note-band relative mb-6 overflow-hidden rounded-[26px] border border-line bg-paper shadow-[0_1px_0_var(--color-line-soft),0_22px_50px_-40px_rgba(0,0,0,0.5)]">
      <WaveLines className="absolute inset-x-0 top-0 h-full w-full opacity-40" rows={16} />
      {/* The medallion, with the watermark in its window. */}
      <div className="absolute top-1/2 right-6 hidden -translate-y-1/2 md:block">
        <Guilloche size={160} />
        <Watermark className="absolute inset-0 m-auto h-14 w-14 rounded-full" />
      </div>
      <div className="relative flex flex-wrap items-end justify-between gap-x-8 gap-y-3 px-6 pt-5 pb-3.5 md:px-8 md:pr-[210px]">
        <div className="min-w-0 max-w-3xl">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {story?.n && <Denomination n={story.n} />}
            <span className="text-[14.5px] font-semibold text-ink-2">{eyebrow ?? story?.line}</span>
          </div>
          <h1 className="display mt-1 text-[38px] leading-[1.02] text-ink md:text-[44px]" style={{ fontVariationSettings: '"wdth" 80' }}>
            {title}
          </h1>
          {eyebrow && story && <p className="mt-1 text-[15px] font-medium text-brand">{story.line}</p>}
          {summary && <p className="mt-2 max-w-2xl text-[16px] leading-relaxed text-ink-2">{summary}</p>}
        </div>
        {action && <div className="relative flex flex-wrap items-center gap-3">{action}</div>}
      </div>
      <div className="relative flex items-center gap-4 px-6 pb-2.5 md:px-8">
        <Thread className="h-2 w-40 shrink-0 rounded-full" />
        <Microtext className="flex-1" />
      </div>
    </section>
  );
}
