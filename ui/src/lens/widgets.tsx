// The views a generated page is made of. Each takes the profile and the
// columns its spec names, and draws only what the file holds.

import { useEffect, useMemo, useRef, useState } from "react";
import { Calendar, Columns, DayCell, Donut, Pareto, Ranked } from "../auditor/charts";
import { inr, scaleFor } from "../auditor/kit";
import { cx } from "../ui";
import type { Check, Period, Sample } from "./audit";
import { Profile, col, text, toDay, toNumber } from "./profile";

const fam = ["var(--color-fam-1)", "var(--color-fam-2)", "var(--color-fam-3)", "var(--color-fam-4)", "var(--color-fam-5)", "var(--color-fam-6)"];
const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// ---------------------------------------------------------------- Every row as a point

// The whole register on one canvas: each row stands at its date, as high as
// its amount on a scale of tens. Caught rows are red; samples carry a ring.
// `reveal` draws the points in date order, like ink running along the page.
export function Field({ p, date, amount, flagged, samples, reveal = true, height = 340, onPick }: { p: Profile; date: number; amount: number; flagged: Set<number>; samples?: Sample[]; reveal?: boolean; height?: number; onPick?: (k: number) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState<{ k: number; x: number; y: number } | null>(null);
  const pts = useMemo(() => {
    const days = col(p, date).map(toDay);
    const amt = col(p, amount).map(toNumber);
    const list: { k: number; t: number; v: number }[] = [];
    days.forEach((d, k) => {
      const v = amt[k];
      if (d && v !== null && v > 0) list.push({ k, t: new Date(d + "T00:00:00").getTime(), v: Math.log10(v) });
    });
    list.sort((a, b) => a.t - b.t);
    const t0 = list[0]?.t ?? 0;
    const t1 = list[list.length - 1]?.t ?? 1;
    // The scale runs from just below the smallest tenth of a percent to just above the largest.
    const vs = list.map((x) => x.v).sort((a, b) => a - b);
    const v0 = (vs[Math.floor(vs.length * 0.001)] ?? 0) - 0.08;
    const v1 = (vs[vs.length - 1] ?? 1) + 0.08;
    return { list, t0, t1: t1 === t0 ? t0 + 1 : t1, v0, v1: v1 <= v0 ? v0 + 1 : v1 };
  }, [p, date, amount]);
  const sampled = useMemo(() => new Map((samples ?? []).map((s) => [s.row, s])), [samples]);
  const pad = { l: 56, r: 16, t: 14, b: 30 };
  const X = (t: number) => pad.l + ((t - pts.t0) / (pts.t1 - pts.t0)) * (width - pad.l - pad.r);
  const Y = (v: number) => pad.t + (1 - (v - pts.v0) / (pts.v1 - pts.v0)) * (height - pad.t - pad.b);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = width * dpr;
    cv.height = height * dpr;
    const ctx = cv.getContext("2d")!;
    ctx.scale(dpr, dpr);
    const ink = cssVar("--color-ink-3");
    const line = cssVar("--color-line-soft");
    const fail = cssVar("--color-fail");
    const brand = cssVar("--color-brand");
    const hi = cssVar("--color-highlight");
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches || !reveal;
    let frame = 0;
    let raf = 0;
    const total = pts.list.length;
    const frames = still ? 1 : 70;
    const draw = () => {
      frame++;
      const upto = Math.ceil((total * frame) / frames);
      ctx.clearRect(0, 0, width, height);
      ctx.strokeStyle = line;
      ctx.lineWidth = 1;
      ctx.fillStyle = cssVar("--color-ink-2");
      ctx.font = `12px ${cssVar("--font-sans") || "sans-serif"}`;
      for (let e = Math.floor(pts.v0); e <= Math.ceil(pts.v1); e++) {
        for (const m of [1, 2, 5]) {
          const v = e + Math.log10(m);
          if (v < pts.v0 || v > pts.v1) continue;
          const y = Y(v);
          ctx.beginPath();
          ctx.moveTo(pad.l, y);
          ctx.lineTo(width - pad.r, y);
          ctx.stroke();
          ctx.fillText(short(10 ** v), 4, y + 4);
        }
      }
      // Month ticks along the foot.
      const d0 = new Date(pts.t0);
      for (let d = new Date(d0.getFullYear(), d0.getMonth(), 1); d.getTime() <= pts.t1; d.setMonth(d.getMonth() + 1)) {
        const x = X(d.getTime());
        if (x < pad.l) continue;
        ctx.fillText(months[d.getMonth()], x + 2, height - 10);
      }
      for (let i = 0; i < upto; i++) {
        const q = pts.list[i];
        const bad = flagged.has(q.k);
        ctx.fillStyle = bad ? fail : ink;
        ctx.globalAlpha = bad ? 0.95 : 0.38;
        ctx.beginPath();
        ctx.arc(X(q.t), Y(q.v), bad ? 3.2 : 1.7, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (upto >= total) {
        for (const q of pts.list) {
          if (!sampled.has(q.k)) continue;
          ctx.strokeStyle = brand;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(X(q.t), Y(q.v), 6, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = hi;
          ctx.beginPath();
          ctx.arc(X(q.t), Y(q.v), 2.4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      if (frame < frames) raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pts, width, height, flagged, sampled, reveal]);

  const nearest = (x: number, y: number) => {
    let best = -1;
    let dist = 144;
    for (const q of pts.list) {
      const d = (X(q.t) - x) ** 2 + (Y(q.v) - y) ** 2;
      if (d < dist) {
        dist = d;
        best = q.k;
      }
    }
    return best;
  };

  const hk = hover?.k;
  const row = hk !== undefined ? p.table.rows[p.data[hk]] : null;
  return (
    <div ref={wrap} className="relative" style={{ height }}>
      <canvas
        ref={ref}
        style={{ width, height }}
        className={cx("block", onPick && "cursor-pointer")}
        role="img"
        aria-label={`${pts.list.length} rows by date and amount, ${flagged.size} caught by the tests`}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const k = nearest(e.clientX - r.left, e.clientY - r.top);
          setHover(k >= 0 ? { k, x: e.clientX - r.left, y: e.clientY - r.top } : null);
        }}
        onMouseLeave={() => setHover(null)}
        onClick={() => hk !== undefined && onPick?.(hk)}
      />
      {hover && row && (
        <div className="pointer-events-none absolute z-10 w-64 rounded-lg bg-spine px-3 py-2 text-[13px] text-spine-ink shadow-xl" style={{ left: Math.min(hover.x + 14, width - 270), top: Math.max(0, hover.y - 70) }}>
          <div className="font-bold">{p.docno !== undefined ? text(row[p.docno]) : `Row ${hover.k + 1}`}</div>
          <div className="text-spine-ink-2">
            {toDay(row[date])} {p.party !== undefined ? `· ${text(row[p.party])}` : ""}
          </div>
          <div className="mt-1 font-semibold">{inr(toNumber(row[amount]) ?? 0)}</div>
          {flagged.has(hover.k) && <div className="mt-1 font-semibold text-[#ff9a80]">Caught by a test</div>}
          {sampled.get(hover.k) && <div className="mt-1 font-semibold text-highlight">Sampled: {sampled.get(hover.k)!.reason}</div>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Month by month

export function Timeline({ p, date, amount, flagged }: { p: Profile; date: number; amount?: number; flagged: Set<number> }) {
  const data = useMemo(() => {
    const days = col(p, date).map(toDay);
    const amt = amount !== undefined ? col(p, amount).map(toNumber) : [];
    const m = new Map<string, { ok: number; bad: number; rows: number }>();
    days.forEach((d, k) => {
      if (!d) return;
      const key = d.slice(0, 7);
      const b = m.get(key) ?? { ok: 0, bad: 0, rows: 0 };
      const v = amount !== undefined ? Math.abs(amt[k] ?? 0) : 1;
      if (flagged.has(k)) b.bad += v;
      else b.ok += v;
      b.rows++;
      m.set(key, b);
    });
    return [...m.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-24)
      .map(([key, b]) => ({
        key,
        label: `${months[+key.slice(5) - 1]} ${key.slice(2, 4)}`,
        parts: [
          { key: "ok", label: "Passed every test", value: b.ok, color: "color-mix(in oklab, var(--color-brand) 55%, transparent)" },
          { key: "bad", label: "Caught by a test", value: b.bad, color: "var(--color-fail)" },
        ],
        note: `${b.rows.toLocaleString("en-IN")} rows`,
      }));
  }, [p, date, amount, flagged]);
  const max = Math.max(0, ...data.map((d) => d.parts[0].value + d.parts[1].value));
  const s = amount !== undefined ? scaleFor(max) : { label: (v: number) => v.toLocaleString("en-IN"), axis: (v: number) => v.toLocaleString("en-IN") };
  return <Columns data={data} height={300} format={s.label} axisFormat={s.axis} />;
}

// ---------------------------------------------------------------- Day by day

export function Days({ p, date, amount, flagged, period }: { p: Profile; date: number; amount?: number; flagged: Set<number>; period: Period | null }) {
  const { days, start, end } = useMemo(() => {
    const ds = col(p, date).map(toDay);
    const amt = amount !== undefined ? col(p, amount).map(toNumber) : [];
    const m = new Map<string, DayCell>();
    ds.forEach((d, k) => {
      if (!d) return;
      const c = m.get(d) ?? { date: d, value: 0, rows: 0, flagged: 0 };
      c.value += amount !== undefined ? Math.abs(amt[k] ?? 0) : 1;
      c.rows++;
      if (flagged.has(k)) c.flagged++;
      m.set(d, c);
    });
    const keys = [...m.keys()].sort();
    return { days: m, start: period?.start ?? keys[0], end: period?.end ?? keys[keys.length - 1] };
  }, [p, date, amount, flagged, period]);
  if (!start || !end) return null;
  return <Calendar start={start} end={end} days={days} format={(v) => (amount !== undefined ? inr(v) : `${v} rows`)} flagWord="caught by a test" flagNote={(n) => `${n === 1 ? "1 row" : `${n} rows`} caught by a test`} />;
}

// ---------------------------------------------------------------- India

// States of India as a tile grid, roughly where they lie, keyed by GST state code.
const tiles: [string, string, string, number, number][] = [
  ["01", "JK", "Jammu and Kashmir", 3, 0],
  ["38", "LA", "Ladakh", 4, 0],
  ["03", "PB", "Punjab", 2, 1],
  ["02", "HP", "Himachal Pradesh", 3, 1],
  ["04", "CH", "Chandigarh", 4, 1],
  ["08", "RJ", "Rajasthan", 1, 2],
  ["06", "HR", "Haryana", 2, 2],
  ["07", "DL", "Delhi", 3, 2],
  ["05", "UK", "Uttarakhand", 4, 2],
  ["11", "SK", "Sikkim", 6, 2],
  ["12", "AR", "Arunachal Pradesh", 8, 2],
  ["24", "GJ", "Gujarat", 0, 3],
  ["23", "MP", "Madhya Pradesh", 2, 3],
  ["09", "UP", "Uttar Pradesh", 3, 3],
  ["10", "BR", "Bihar", 4, 3],
  ["18", "AS", "Assam", 7, 3],
  ["13", "NL", "Nagaland", 8, 3],
  ["26", "DN", "Dadra, Nagar Haveli, Daman and Diu", 0, 4],
  ["27", "MH", "Maharashtra", 1, 4],
  ["22", "CG", "Chhattisgarh", 3, 4],
  ["20", "JH", "Jharkhand", 4, 4],
  ["19", "WB", "West Bengal", 5, 4],
  ["17", "ML", "Meghalaya", 7, 4],
  ["14", "MN", "Manipur", 8, 4],
  ["30", "GA", "Goa", 1, 5],
  ["29", "KA", "Karnataka", 2, 5],
  ["36", "TS", "Telangana", 3, 5],
  ["21", "OD", "Odisha", 4, 5],
  ["16", "TR", "Tripura", 7, 5],
  ["15", "MZ", "Mizoram", 8, 5],
  ["32", "KL", "Kerala", 2, 6],
  ["37", "AP", "Andhra Pradesh", 3, 6],
  ["33", "TN", "Tamil Nadu", 3, 7],
  ["34", "PY", "Puducherry", 4, 7],
  ["31", "LD", "Lakshadweep", 0, 7],
  ["35", "AN", "Andaman and Nicobar", 6, 7],
];

export function IndiaMap({ p, state, gstin, amount }: { p: Profile; state?: number; gstin?: number; amount?: number }) {
  const [hover, setHover] = useState<string | null>(null);
  const by = useMemo(() => {
    const codes = state !== undefined ? col(p, state).map((v) => text(v).padStart(2, "0")) : col(p, gstin).map((v) => text(v).slice(0, 2));
    const amt = amount !== undefined ? col(p, amount).map(toNumber) : [];
    const m = new Map<string, { value: number; rows: number }>();
    codes.forEach((c, k) => {
      if (!c) return;
      const b = m.get(c) ?? { value: 0, rows: 0 };
      b.value += amount !== undefined ? Math.abs(amt[k] ?? 0) : 1;
      b.rows++;
      m.set(c, b);
    });
    return m;
  }, [p, state, gstin, amount]);
  const max = Math.max(1, ...[...by.values()].map((b) => b.value));
  const total = [...by.values()].reduce((t, b) => t + b.value, 0) || 1;
  const home = [...by.entries()].sort((a, b) => b[1].rows - a[1].rows)[0]?.[0];
  const size = 46;
  const gap = 5;
  const hovered = hover ? tiles.find((t) => t[0] === hover) : null;
  const top = [...by.entries()].sort((a, b) => b[1].value - a[1].value).slice(0, 4);
  return (
    <div className="grid items-center gap-6 md:grid-cols-[auto_minmax(0,1fr)]">
      <svg width={9 * (size + gap)} height={8 * (size + gap)} viewBox={`0 0 ${9 * (size + gap)} ${8 * (size + gap)}`} className="max-w-full" role="img" aria-label="Sales by state of India">
        {tiles.map(([code, abbr, , c, r], i) => {
          const b = by.get(code);
          const share = b ? b.value / max : 0;
          const fill = b ? `color-mix(in oklab, var(--color-brand) ${Math.round(18 + share * 82)}%, var(--color-paper))` : "var(--color-wash)";
          return (
            <g key={code} transform={`translate(${c * (size + gap)},${r * (size + gap)})`} onMouseEnter={() => setHover(code)} onMouseLeave={() => setHover(null)} className="cursor-default">
              <rect
                width={size}
                height={size}
                rx={9}
                fill={fill}
                stroke={code === home ? "var(--color-highlight)" : hover === code ? "var(--color-ink)" : "var(--color-line-soft)"}
                strokeWidth={code === home || hover === code ? 2.5 : 1}
                className="col-grow"
                style={{ animationDelay: `${i * 18}ms`, transformOrigin: "center bottom", transformBox: "fill-box" }}
              />
              <text x={size / 2} y={size / 2 + 4} textAnchor="middle" fontSize={12.5} fontWeight={700} fill={share > 0.45 ? "var(--color-paper)" : b ? "var(--color-ink)" : "var(--color-ink-3)"}>
                {abbr}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="min-w-0 text-[14px]">
        {hovered ? (
          <div>
            <div className="text-[18px] font-bold text-ink">{hovered[2]}</div>
            <div className="text-ink-2">State code {hovered[0]}</div>
            {by.get(hovered[0]) ? (
              <div className="mt-2">
                <div className="amount text-[28px] text-ink">{amount !== undefined ? inr(by.get(hovered[0])!.value) : by.get(hovered[0])!.rows.toLocaleString("en-IN")}</div>
                <div className="text-ink-2">
                  {by.get(hovered[0])!.rows.toLocaleString("en-IN")} rows, {((by.get(hovered[0])!.value / total) * 100).toFixed(1)}% of the file
                </div>
              </div>
            ) : (
              <div className="mt-2 text-ink-3">No sales here.</div>
            )}
          </div>
        ) : (
          <ul className="space-y-2.5">
            {top.map(([code, b]) => {
              const t = tiles.find((x) => x[0] === code);
              return (
                <li key={code}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate font-semibold text-ink">
                      {t?.[2] ?? `State ${code}`}
                      {code === home && <span className="ml-2 rounded-full bg-highlight/40 px-1.5 text-[12px] font-bold text-ink">Home</span>}
                    </span>
                    <span className="amount text-[17px]">{amount !== undefined ? inr(b.value) : b.rows}</span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-wash">
                    <div className="grow-x h-full rounded-full bg-brand" style={{ width: `${(b.value / total) * 100}%` }} />
                  </div>
                </li>
              );
            })}
            <li className="pt-1 text-[13px] text-ink-2">Point at a state to read it. The ringed state sells the most often: the home state.</li>
          </ul>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Who

export function Parties({ p, party, amount, flagged }: { p: Profile; party: number; amount?: number; flagged: Set<number> }) {
  const items = useMemo(() => {
    const names = col(p, party).map(text);
    const amt = amount !== undefined ? col(p, amount).map(toNumber) : [];
    const m = new Map<string, { value: number; caught: number }>();
    names.forEach((n, k) => {
      if (!n) return;
      const b = m.get(n) ?? { value: 0, caught: 0 };
      const v = amount !== undefined ? Math.abs(amt[k] ?? 0) : 1;
      b.value += v;
      if (flagged.has(k)) b.caught += v;
      m.set(n, b);
    });
    // A party is marked when at least a tenth of its value sits in caught rows.
    return [...m.entries()]
      .sort((a, b) => b[1].value - a[1].value)
      .slice(0, 15)
      .map(([label, b]) => ({
        key: label,
        label,
        value: b.value,
        color: "color-mix(in oklab, var(--color-brand) 60%, transparent)",
        flagged: b.caught >= b.value * 0.1,
        note: b.caught ? `${Math.round((b.caught / b.value) * 100)}% of it in rows caught by a test` : undefined,
      }));
  }, [p, party, amount, flagged]);
  const s = scaleFor(Math.max(0, ...items.map((i) => i.value)));
  return <Pareto items={items} height={300} format={amount !== undefined ? s.label : (v) => String(v)} axisFormat={amount !== undefined ? s.axis : undefined} />;
}

// ---------------------------------------------------------------- A category

export function Category({ p, column, amount }: { p: Profile; column: number; amount?: number }) {
  const slices = useMemo(() => {
    const vals = col(p, column).map((v) => text(v) || "Blank");
    const amt = amount !== undefined ? col(p, amount).map(toNumber) : [];
    const m = new Map<string, number>();
    vals.forEach((v, k) => m.set(v, (m.get(v) ?? 0) + (amount !== undefined ? Math.abs(amt[k] ?? 0) : 1)));
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([label, value], i) => ({ key: label, label, value, color: fam[i % fam.length] }));
  }, [p, column, amount]);
  const total = slices.reduce((t, s) => t + s.value, 0);
  const fmt = (v: number) => (amount !== undefined ? inr(v) : `${v.toLocaleString("en-IN")} rows`);
  if (slices.length <= 6) return <Donut slices={slices} center={<span className="amount text-[20px]">{amount !== undefined ? inr(total) : total}</span>} centerNote={amount !== undefined ? "in all" : "rows"} format={fmt} />;
  return <Ranked items={slices.slice(0, 10)} format={fmt} />;
}

// ---------------------------------------------------------------- Benford

const expected = [0, ...Array.from({ length: 9 }, (_, i) => Math.log10(1 + 1 / (i + 1)))];

export function Benford({ p, amount }: { p: Profile; amount: number }) {
  const { share, n } = useMemo(() => {
    const counts = Array(10).fill(0);
    let n = 0;
    for (const v of col(p, amount).map(toNumber)) {
      if (v === null || Math.abs(v) < 10) continue;
      counts[+String(Math.floor(Math.abs(v)))[0]]++;
      n++;
    }
    return { share: counts.map((c) => (n ? c / n : 0)), n };
  }, [p, amount]);
  const w = 460;
  const h = 230;
  const pad = { l: 34, b: 26, t: 10 };
  const bw = (w - pad.l) / 9;
  const max = Math.max(0.32, ...share);
  const Y = (v: number) => pad.t + (1 - v / max) * (h - pad.t - pad.b);
  const [hover, setHover] = useState<number | null>(null);
  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full" role="img" aria-label={`First digits of ${n} amounts against Benford's law`}>
        {[0, 0.1, 0.2, 0.3].map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={w} y1={Y(t)} y2={Y(t)} stroke="var(--color-line-soft)" />
            <text x={0} y={Y(t) + 4} fontSize={11} fill="var(--color-ink-3)">
              {Math.round(t * 100)}%
            </text>
          </g>
        ))}
        {share.slice(1).map((s, i) => {
          const d = i + 1;
          const x = pad.l + i * bw + 6;
          const off = Math.abs(s - expected[d]) > 0.02;
          return (
            <g key={d} onMouseEnter={() => setHover(d)} onMouseLeave={() => setHover(null)}>
              <rect x={x} y={Y(s)} width={bw - 12} height={Math.max(0, h - pad.b - Y(s))} rx={4} fill={off ? "var(--color-fail)" : "color-mix(in oklab, var(--color-brand) 70%, transparent)"} opacity={hover && hover !== d ? 0.5 : 1} className="col-grow" style={{ animationDelay: `${i * 50}ms`, transformOrigin: "center bottom", transformBox: "fill-box" }} />
              <text x={x + (bw - 12) / 2} y={h - 8} textAnchor="middle" fontSize={12} fontWeight={700} fill="var(--color-ink-2)">
                {d}
              </text>
            </g>
          );
        })}
        <polyline fill="none" stroke="var(--color-ink)" strokeWidth={2} strokeDasharray="5 4" points={expected.slice(1).map((e, i) => `${pad.l + i * bw + bw / 2},${Y(e)}`).join(" ")} />
        {expected.slice(1).map((e, i) => (
          <circle key={i} cx={pad.l + i * bw + bw / 2} cy={Y(e)} r={3.5} fill="var(--color-paper)" stroke="var(--color-ink)" strokeWidth={2} />
        ))}
      </svg>
      <p className="mt-2 text-[13.5px] text-ink-2">
        {hover ? (
          <>
            Digit {hover}: <b className="text-ink">{(share[hover] * 100).toFixed(1)}%</b> of amounts start with it; Benford's law expects <b className="text-ink">{(expected[hover] * 100).toFixed(1)}%</b>.
          </>
        ) : (
          <>Bars are this file; the dashed line is what natural figures do. Red bars stray more than two points.</>
        )}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- Sizes

// ₹17.8K, ₹1.8L, ₹3.2Cr: two significant figures, enough to tell bins apart.
function short(v: number) {
  const [d, u] = v >= 1e7 ? [1e7, "Cr"] : v >= 1e5 ? [1e5, "L"] : v >= 1e3 ? [1e3, "K"] : [1, ""];
  return `₹${(v / d).toPrecision(2).replace(/\.0$/, "")}${u}`;
}

export function Sizes({ p, amount }: { p: Profile; amount: number }) {
  const data = useMemo(() => {
    const bins = new Map<number, number>();
    for (const v of col(p, amount).map(toNumber)) {
      if (v === null || v <= 0) continue;
      const b = Math.floor(Math.log10(v) * 4) / 4;
      bins.set(b, (bins.get(b) ?? 0) + 1);
    }
    return [...bins.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([b, c]) => ({ key: String(b), label: short(10 ** b), parts: [{ key: "n", label: "Rows", value: c, color: "color-mix(in oklab, var(--color-fam-1) 75%, transparent)" }] }));
  }, [p, amount]);
  return <Columns data={data} height={260} format={(v) => `${v.toLocaleString("en-IN")} rows`} />;
}

// ---------------------------------------------------------------- Checks

export const verdictTone = { pass: "good", flag: "bad", note: "warn", skip: "neutral" } as const;
export const verdictWord = { pass: "Passed", flag: "Problem found", note: "Worth a look", skip: "Did not run" } as const;

export function caughtRows(checks: Check[]): Set<number> {
  return new Set(checks.filter((c) => c.verdict === "flag").flatMap((c) => c.rows));
}
