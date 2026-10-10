// One moment of motion per page, each the page's chapter of the story on the
// front page: the register as a wall of rows, the samples stepping out of the
// year, the findings held to the light, the trail as a chain of real hashes.
// Every figure is the page's own data; nothing here makes one up.

import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Mark, Tone, cx } from "../ui";
import { prefersReducedMotion, useUv } from "../theme";
import { RegisterRow, inr } from "./kit";

// ---------------------------------------------------------------- Colours for a canvas

// A canvas cannot read CSS variables, so a colour is resolved once through a
// throwaway element and a one-pixel canvas.
const resolved = new Map<string, string>();
function solid(css: string): string {
  const hit = resolved.get(css);
  if (hit) return hit;
  const el = document.createElement("span");
  el.style.color = css;
  document.body.appendChild(el);
  const computed = getComputedStyle(el).color;
  el.remove();
  const c = document.createElement("canvas");
  c.width = c.height = 1;
  const g = c.getContext("2d")!;
  g.fillStyle = computed;
  g.fillRect(0, 0, 1, 1);
  const [r, gg, b, a] = g.getImageData(0, 0, 1, 1).data;
  const out = `rgba(${r},${gg},${b},${(a / 255).toFixed(3)})`;
  resolved.set(css, out);
  return out;
}

// ---------------------------------------------------------------- The register as a wall

// Every row of the client's register as one square, in the order the client
// listed them, coloured by how it reconciled. The wall builds itself once, the
// way the register wall forms on the front page. Point at a square to read the
// row; select it to open the row below.
export function RegisterWall({
  rows,
  colorOf,
  highlight,
  label,
  emphasis,
  onPick,
}: {
  rows: RegisterRow[];
  colorOf: (r: RegisterRow) => string;
  // Rows outside the current filters are drawn faint.
  highlight?: (r: RegisterRow) => boolean;
  label: (r: RegisterRow) => { title: string; meta: string; value?: number; status: string };
  // Rows drawn larger and ringed, so a handful among thousands still stand out.
  emphasis?: (r: RegisterRow) => boolean;
  onPick?: (r: RegisterRow) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(900);
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const built = useRef(false);
  const n = rows.length;
  // Square size chosen so the wall is about 230 pixels tall at this width.
  const geo = useMemo(() => {
    const gap = 1.5;
    const cell = Math.max(3, Math.min(10, Math.sqrt((width * 230) / Math.max(1, n)) - gap));
    const cols = Math.max(1, Math.floor((width + gap) / (cell + gap)));
    const lines = Math.ceil(n / cols);
    return { gap, cell, cols, height: Math.ceil(lines * (cell + gap)) };
  }, [width, n]);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const cv = canvas.current;
    if (!cv || !n) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = width * dpr;
    cv.height = geo.height * dpr;
    const g = cv.getContext("2d")!;
    g.scale(dpr, dpr);
    const fills = rows.map((r) => solid(colorOf(r)));
    const on = rows.map((r) => (highlight ? highlight(r) : true));
    const big = emphasis ? rows.map(emphasis) : [];
    const ring = solid("var(--color-ink)");
    const step = geo.cell + geo.gap;
    const draw = (upto: number) => {
      g.clearRect(0, 0, width, geo.height);
      for (let i = 0; i < upto; i++) {
        g.globalAlpha = on[i] ? 1 : 0.18;
        g.fillStyle = fills[i];
        g.fillRect((i % geo.cols) * step, Math.floor(i / geo.cols) * step, geo.cell, geo.cell);
      }
      // The rows that matter, drawn last, larger and ringed.
      for (let i = 0; i < upto; i++) {
        if (!big[i] || !on[i]) continue;
        const x = (i % geo.cols) * step;
        const y = Math.floor(i / geo.cols) * step;
        const grow = geo.cell * 0.9;
        g.globalAlpha = 1;
        g.fillStyle = fills[i];
        g.fillRect(x - grow / 2, y - grow / 2, geo.cell + grow, geo.cell + grow);
        g.strokeStyle = ring;
        g.lineWidth = 1.2;
        g.strokeRect(x - grow / 2, y - grow / 2, geo.cell + grow, geo.cell + grow);
      }
      g.globalAlpha = 1;
    };
    // The first time, the wall fills row by row; after that, it redraws at once.
    if (built.current || prefersReducedMotion()) {
      draw(n);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const frame = (t: number) => {
      const k = Math.min(1, (t - start) / 1100);
      draw(Math.ceil(n * (1 - (1 - k) ** 2)));
      if (k < 1) raf = requestAnimationFrame(frame);
      else built.current = true;
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [rows, colorOf, highlight, emphasis, width, geo, n]);

  const at = (x: number, y: number) => {
    const step = geo.cell + geo.gap;
    const c = Math.floor(x / step);
    const r = Math.floor(y / step);
    const i = r * geo.cols + c;
    return c < geo.cols && i >= 0 && i < n ? i : -1;
  };
  const tip = hover ? label(rows[hover.i]) : null;

  return (
    <div ref={wrap} className="relative" style={{ height: geo.height }}>
      <canvas
        ref={canvas}
        style={{ width, height: geo.height }}
        className={cx("block", onPick && "cursor-pointer")}
        role="img"
        aria-label={`${n.toLocaleString("en-IN")} register rows as squares, coloured by how each reconciled`}
        onMouseMove={(e) => {
          const b = e.currentTarget.getBoundingClientRect();
          const i = at(e.clientX - b.left, e.clientY - b.top);
          setHover(i >= 0 ? { i, x: e.clientX - b.left, y: e.clientY - b.top } : null);
        }}
        onMouseLeave={() => setHover(null)}
        onClick={() => hover && onPick?.(rows[hover.i])}
      />
      {hover && tip && (
        <div className="pointer-events-none absolute z-20 w-64 rounded-lg bg-spine px-3 py-2 text-[13px] text-spine-ink shadow-xl" style={{ left: Math.min(hover.x + 14, width - 268), top: Math.max(0, hover.y - 78) }}>
          <div className="font-bold">{tip.title}</div>
          <div className="truncate text-spine-ink-2">{tip.meta}</div>
          <div className="mt-1 flex items-baseline justify-between gap-3">
            <span className="font-semibold">{tip.status}</span>
            {tip.value !== undefined && <span className="num">{inr(tip.value)}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Samples stepping out of the year

export interface RiseItem {
  key: string;
  date?: string;
  value: number;
  label: string;
  note: string;
  tone: Tone;
  color: string;
}

// The period as a line. Each sample steps up out of it, as high as its value
// on a scale of tens, one after another in the order they were drawn, and its
// result is written on it in the auditor's pen as it lands.
export function SampleRise({ items, periodEnd, onPick }: { items: RiseItem[]; periodEnd?: string; onPick?: (key: string) => void }) {
  const [hover, setHover] = useState<string | null>(null);
  const W = 1000;
  const H = 230;
  const base = 182;
  const dated = items.filter((i) => i.date);
  const time = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00`).getTime();
  const ts = dated.map((i) => time(i.date!));
  const pad = 6 * 864e5;
  const t0 = Math.min(...ts) - pad;
  const t1 = Math.max(...ts) + pad;
  const X = (d: string) => 40 + ((time(d) - t0) / Math.max(1, t1 - t0)) * (W - 80);
  const vs = items.map((i) => Math.log10(Math.max(1, i.value)));
  const v0 = Math.min(...vs);
  const v1 = Math.max(...vs);
  const Y = (v: number) => base - 34 - ((Math.log10(Math.max(1, v)) - v0) / Math.max(0.0001, v1 - v0)) * (base - 70);
  // Month marks along the line.
  const months: { x: number; label: string }[] = [];
  if (dated.length) {
    const d = new Date(t0);
    for (let m = new Date(d.getFullYear(), d.getMonth() + 1, 1); m.getTime() < t1; m.setMonth(m.getMonth() + 1)) {
      months.push({ x: 40 + ((m.getTime() - t0) / (t1 - t0)) * (W - 80), label: m.toLocaleDateString("en-IN", { month: "short" }) });
    }
  }
  const pe = periodEnd && time(periodEnd) > t0 && time(periodEnd) < t1 ? X(periodEnd) : null;
  // Notes that would cover each other move aside, nearest free place first,
  // and their stems lean back to the true date on the line.
  const placed: { it: RiseItem; i: number; x: number; y: number; nx: number; ny: number }[] = [];
  const order = items.map((it, i) => ({ it, i })).filter(({ it }) => it.date).sort((a, b) => time(a.it.date!) - time(b.it.date!));
  const tries: [number, number][] = [[0, 0]];
  for (let r = 1; r <= 8; r++) for (const [dx, dy] of [[0, -26], [34, 0], [-34, 0], [34, -26], [-34, -26], [0, 26], [34, 26], [-34, 26]]) tries.push([dx * r, dy * r]);
  for (const { it, i } of order) {
    const x = X(it.date!);
    const y = Y(it.value);
    const free = tries
      .map(([dx, dy]) => [x + dx, y + dy] as const)
      .find(([nx, ny]) => ny >= 14 && ny <= base - 30 && nx >= 20 && nx <= W - 20 && !placed.some((p) => Math.abs(p.nx - nx) < 32 && Math.abs(p.ny - ny) < 24));
    const [nx, ny] = free ?? [x, y];
    placed.push({ it, i, x, y, nx, ny });
  }
  const shown = items.find((i) => i.key === hover);

  if (!dated.length) return null;
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full overflow-visible" role="img" aria-label={`${items.length} samples along the period, each as high as its value`}>
        <line x1={20} x2={W - 20} y1={base} y2={base} stroke="var(--color-ink-3)" strokeWidth={1.5} />
        {months.map((m) => (
          <g key={m.x}>
            <line x1={m.x} x2={m.x} y1={base - 4} y2={base + 4} stroke="var(--color-ink-3)" />
            <text x={m.x + 3} y={base + 20} fontSize={12} fill="var(--color-ink-2)">
              {m.label}
            </text>
          </g>
        ))}
        {pe !== null && (
          <g>
            <line x1={pe} x2={pe} y1={16} y2={base} stroke="var(--color-fail)" strokeDasharray="4 4" />
            <text x={pe + 5} y={22} fontSize={12} fontWeight={700} fill="var(--color-fail)">
              Period end
            </text>
          </g>
        )}
        {placed.map(({ it, i, x, y, nx, ny }) => {
          const on = hover === it.key;
          return (
            <g key={it.key} className="cursor-pointer" onMouseEnter={() => setHover(it.key)} onMouseLeave={() => setHover(null)} onClick={() => onPick?.(it.key)}>
              {nx === x ? (
                <line x1={x} x2={x} y1={base} y2={ny + 11} stroke={it.color} strokeWidth={on ? 2.5 : 1.5} pathLength={1} className="ink-draw" style={{ animationDelay: `${i * 70}ms` }} />
              ) : (
                // A note moved aside hangs from its date on a light curved thread.
                <path d={`M${x} ${base} C${x} ${base - 34} ${nx} ${ny + 40} ${nx} ${ny + 11}`} fill="none" stroke={it.color} strokeWidth={on ? 2 : 1} strokeDasharray="3 3" opacity={on ? 1 : 0.45} />
              )}
              <g className="rise-in" style={{ animationDelay: `${i * 70 + 120}ms`, transformOrigin: `${x}px ${base}px` }}>
                <rect x={nx - 15} y={ny - 11} width={30} height={22} rx={5} fill="var(--color-paper)" stroke={it.color} strokeWidth={on ? 2.5 : 1.6} />
                <foreignObject x={nx - 8} y={ny - 8} width={16} height={16} style={{ color: it.color }}>
                  <Mark tone={it.tone} size={16} draw />
                </foreignObject>
              </g>
              {/* A dot on the line marks the true date when the note had to move aside. */}
              {(nx !== x || ny !== y) && <circle cx={x} cy={base} r={2.5} fill={it.color} />}
            </g>
          );
        })}
      </svg>
      {shown && (
        <div className="pointer-events-none absolute top-0 left-1/2 z-10 w-72 -translate-x-1/2 rounded-lg bg-spine px-3 py-2 text-[13px] text-spine-ink shadow-xl">
          <div className="font-bold">{shown.label}</div>
          <div className="text-spine-ink-2">{shown.note}</div>
          <div className="mt-1 num font-semibold">{inr(shown.value)}</div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Held to the light

// Switches the UV lamp with a band of violet light sweeping across the page.
export function HoldToLight() {
  const [uv, setUv] = useUv();
  const [sweep, setSweep] = useState(0);
  const go = () => {
    setSweep((k) => k + 1);
    window.setTimeout(() => setUv(!uv), prefersReducedMotion() ? 0 : 380);
  };
  return (
    <>
      <Button kind="ghost" onClick={go}>
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M7 3h6l-1 6H8z" />
          <path d="M10 9v3M5 15l2-2M15 15l-2-2M10 17v1" />
        </svg>
        {uv ? "Put the lamp away" : "Hold them to the light"}
      </Button>
      {sweep > 0 && <div key={sweep} className="uv-sweep pointer-events-none fixed inset-0 z-[60]" aria-hidden />}
    </>
  );
}

// ---------------------------------------------------------------- The chain

export interface ChainLink {
  seq: number;
  hash: string;
  prev: string;
  title: string;
  who: string;
  ok: boolean;
}

// The latest entries of the trail as linked blocks, oldest on the left. Each
// link is checked here, in the browser: a block's previous hash must be the
// hash of the block before it. A new entry slides in at the right.
export function ChainStrip({ links }: { links: ChainLink[] }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTo({ left: el.scrollWidth, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [links]);
  return (
    <div ref={box} className="thin-scroll flex items-center overflow-x-auto pb-2">
      {links.map((l, i) => {
        const prev = links[i - 1];
        const linked = prev ? l.prev === prev.hash : null;
        const latest = i === links.length - 1;
        return (
          <div key={l.seq} className="chain-in flex shrink-0 items-center" style={{ animationDelay: `${i * 55}ms` }}>
            {prev && (
              <span className="relative mx-1 flex w-14 items-center" title={linked ? "This block names the hash of the one before it" : "This block does not name the hash of the one before it"}>
                <span className={cx("h-0.5 flex-1", linked ? "bg-pass" : "bg-fail")} />
                <span className={cx("absolute left-1/2 -translate-x-1/2 rounded-full bg-paper p-0.5", linked ? "text-pass" : "text-fail")}>
                  <Mark tone={linked ? "good" : "bad"} size={14} draw />
                </span>
              </span>
            )}
            <div className={cx("w-[176px] rounded-xl border px-3 py-2.5", latest ? "border-highlight bg-wait-wash shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-highlight)_25%,transparent)]" : l.ok ? "border-line bg-paper" : "border-fail/50 bg-fail-wash")}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="num text-[13px] font-bold text-ink">#{l.seq.toLocaleString("en-IN")}</span>
                {latest && <span className="text-[11.5px] font-bold text-wait">Latest</span>}
              </div>
              <div className="truncate text-[13px] font-semibold text-ink" title={l.title}>
                {l.title}
              </div>
              <div className="truncate text-[12px] text-ink-2">{l.who}</div>
              <div className="mt-1 font-mono text-[11px] text-ink-3" title={l.hash}>
                {l.hash.slice(0, 16)}…
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

