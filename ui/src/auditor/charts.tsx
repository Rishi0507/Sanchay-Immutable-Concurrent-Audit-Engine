// Charts for the auditor dashboards, drawn with Recharts and dressed in the
// theme tokens. Each one reports clicks so it can act as a filter, shows its
// figures on hover or keyboard focus, and stays still when the reader asks
// for reduced motion.

import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Brush,
  CartesianGrid,
  Cell,
  ComposedChart,
  LabelList,
  Line,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Sankey,
  Sector,
  Tooltip,
  Treemap,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import { cx } from "../ui";

export const ink = {
  high: "var(--color-fail)",
  medium: "var(--color-wait)",
  low: "var(--color-ink-3)",
  good: "var(--color-pass)",
  brand: "var(--color-brand)",
  rp: "var(--color-rp)",
  warm: "var(--color-warm)",
  line: "var(--color-line)",
  muted: "var(--color-ink-3)",
};

const still = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const motion = { isAnimationActive: !still, animationDuration: 550, animationEasing: "ease-out" as const };
// Evenly spaced axis ticks on a round step (1, 2, 2.5 or 5 times a power of
// ten), so every label is exact in the chart's unit.
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? 10 * p;
  const out: number[] = [];
  for (let v = 0; v <= max + step * 0.999; v += step) out.push(+v.toFixed(10));
  return out;
}

const axisTick = { fill: "var(--color-ink-3)", fontSize: 11, fontFamily: "var(--font-sans)" };

export function Swatch({ color, shape = "square" }: { color: string; shape?: "square" | "dot" | "line" }) {
  return <i className={cx("inline-block shrink-0", shape === "dot" ? "h-2.5 w-2.5 rounded-full" : shape === "line" ? "h-0.5 w-3.5" : "h-2.5 w-2.5 rounded-[3px]")} style={{ background: color }} />;
}

// The tooltip surface every chart shares.
function TipCard({ children }: { children: ReactNode }) {
  return <div className="max-w-[280px] rounded-md border border-line bg-paper px-3 py-2 text-xs leading-relaxed text-ink shadow-[0_10px_30px_rgba(0,0,0,0.28)]">{children}</div>;
}

// ---------------------------------------------------------------- Stacked columns

export interface Part {
  key: string;
  label: string;
  value: number;
  color: string;
}

export interface ColumnDatum {
  key: string;
  label: string;
  parts: Part[];
  note?: ReactNode;
}

export function Columns({
  data,
  height = 240,
  format = (v: number) => String(v),
  axisFormat,
  selected,
  onSelect,
  marker,
  brush,
}: {
  data: ColumnDatum[];
  height?: number;
  format?: (v: number) => string;
  axisFormat?: (v: number) => string;
  selected?: string;
  onSelect?: (key: string) => void;
  // A vertical rule after one column, such as the period end.
  marker?: { after: string; label: string };
  // A range handle under the chart, to zoom into a stretch of columns.
  brush?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const series = useMemo(() => {
    const seen = new Map<string, Part>();
    for (const d of data) for (const p of d.parts) if (!seen.has(p.key)) seen.set(p.key, p);
    return [...seen.values()];
  }, [data]);
  const rows = useMemo(() => data.map((d) => ({ key: d.key, label: d.label, note: d.note, ...Object.fromEntries(d.parts.map((p) => [p.key, p.value])) })), [data]);
  const markerIndex = marker ? data.findIndex((d) => d.key === marker.after) : -1;
  const ticks = niceTicks(Math.max(0, ...rows.map((r: any) => series.reduce((t, p) => t + (Number(r[p.key]) || 0), 0))));
  const showBrush = brush && data.length > 6;

  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={rows}
          margin={{ top: 14, right: 8, left: 0, bottom: 0 }}
          barCategoryGap="22%"
          onMouseMove={(s: any) => setHover(s?.activeTooltipIndex ?? null)}
          onMouseLeave={() => setHover(null)}
          onClick={(s: any) => {
            const row = s?.activePayload?.[0]?.payload;
            if (row) onSelect?.(row.key);
          }}
          style={{ cursor: onSelect ? "pointer" : undefined }}
          accessibilityLayer
        >
          <CartesianGrid vertical={false} stroke="var(--color-line-soft)" strokeDasharray="3 4" />
          <XAxis dataKey="label" tick={axisTick} tickLine={false} axisLine={{ stroke: "var(--color-line)" }} interval="preserveStartEnd" minTickGap={8} />
          <YAxis tick={axisTick} tickLine={false} axisLine={false} width={56} domain={[0, ticks[ticks.length - 1]]} ticks={ticks} tickFormatter={(v) => (axisFormat ?? format)(Number(v))} />
          <Tooltip
            cursor={{ fill: "var(--color-wash)" }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const row: any = payload[0].payload;
              const parts = series.filter((p) => Number(row[p.key]) > 0);
              const total = series.reduce((t, p) => t + (Number(row[p.key]) || 0), 0);
              return (
                <TipCard>
                  <div className="mb-1 font-semibold">{row.label}</div>
                  {parts.map((p) => (
                    <div key={p.key} className="flex items-center justify-between gap-5">
                      <span className="flex items-center gap-1.5 text-ink-2">
                        <Swatch color={p.color} />
                        {p.label}
                      </span>
                      <span className="num">{format(Number(row[p.key]))}</span>
                    </div>
                  ))}
                  {parts.length > 1 && (
                    <div className="mt-1 flex justify-between gap-5 border-t border-line-soft pt-1 font-medium">
                      <span>Total</span>
                      <span className="num">{format(total)}</span>
                    </div>
                  )}
                  {row.note && <div className="mt-1 text-ink-2">{row.note}</div>}
                </TipCard>
              );
            }}
          />
          {markerIndex >= 0 && (
            <ReferenceLine
              x={data[markerIndex].label}
              stroke="var(--color-ink-2)"
              strokeDasharray="3 3"
              position="end"
              label={{ value: marker!.label, position: "insideTopRight", fill: "var(--color-ink-2)", fontSize: 11, offset: 4 }}
            />
          )}
          {series.map((p, si) => (
            <Bar key={p.key} dataKey={p.key} name={p.label} stackId="a" fill={p.color} radius={si === series.length - 1 ? [3, 3, 0, 0] : 0} {...motion} maxBarSize={46}>
              {rows.map((r, i) => (
                <Cell key={r.key} fillOpacity={(selected && selected !== r.key) || (hover !== null && hover !== i && !selected) ? 0.38 : 1} />
              ))}
            </Bar>
          ))}
          {showBrush && <Brush dataKey="label" height={22} travellerWidth={8} stroke="var(--color-line)" fill="var(--color-wash)" tickFormatter={() => ""} />}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------------------------------------------------------------- Donut

export interface Slice {
  key: string;
  label: string;
  value: number;
  color: string;
  detail?: ReactNode;
}

// The hovered or chosen slice grows outward and carries a thin outer ring.
function ActiveSlice(props: any) {
  const { cx: x, cy: y, innerRadius, outerRadius, startAngle, endAngle, fill } = props;
  return (
    <g>
      <Sector cx={x} cy={y} innerRadius={innerRadius} outerRadius={outerRadius + 6} startAngle={startAngle} endAngle={endAngle} fill={fill} cornerRadius={3} />
      <Sector cx={x} cy={y} innerRadius={outerRadius + 9} outerRadius={outerRadius + 11} startAngle={startAngle} endAngle={endAngle} fill={fill} opacity={0.6} />
    </g>
  );
}

export function Donut({
  slices,
  size = 180,
  thickness = 22,
  center,
  centerNote,
  selected,
  onSelect,
  format = (v: number) => String(v),
  legend = true,
}: {
  slices: Slice[];
  size?: number;
  thickness?: number;
  center: ReactNode;
  centerNote?: ReactNode;
  selected?: string;
  onSelect?: (key: string) => void;
  format?: (v: number) => string;
  legend?: boolean;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const shown = slices.filter((s) => s.value > 0);
  const total = shown.reduce((t, s) => t + s.value, 0);
  const focus = hover ?? selected ?? null;
  const activeIndex = focus ? shown.findIndex((s) => s.key === focus) : -1;
  const focused = activeIndex >= 0 ? shown[activeIndex] : null;
  const outer = size / 2 - 14;
  const data = shown.length ? shown : [{ key: "none", label: "None", value: 1, color: "var(--color-wash)" }];

  return (
    <div className={cx("flex flex-wrap items-center gap-x-6 gap-y-4", !legend && "justify-center")}>
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <PieChart width={size} height={size}>
          <Pie
            data={data}
            dataKey="value"
            nameKey="label"
            innerRadius={outer - thickness}
            outerRadius={outer}
            paddingAngle={shown.length > 1 ? 1.5 : 0}
            cornerRadius={2}
            stroke="none"
            startAngle={90}
            endAngle={-270}
            activeIndex={activeIndex >= 0 ? activeIndex : undefined}
            activeShape={ActiveSlice}
            onMouseEnter={(_, i) => shown[i] && setHover(shown[i].key)}
            onMouseLeave={() => setHover(null)}
            onClick={(_, i) => shown[i] && onSelect?.(shown[i].key)}
            style={{ cursor: onSelect ? "pointer" : undefined, outline: "none" }}
            {...motion}
          >
            {data.map((s) => (
              <Cell key={s.key} fill={s.color} fillOpacity={focus && focus !== s.key ? 0.35 : 1} />
            ))}
          </Pie>
        </PieChart>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-7 text-center">
          {focused ? (
            <>
              <div className={cx("amount leading-6 text-ink", size >= 170 ? "text-xl" : "text-[16px]")}>{format(focused.value)}</div>
              <div className="mt-0.5 text-[12px] leading-tight text-ink-2">
                {total ? Math.round((focused.value / total) * 100) : 0}% of the total
              </div>
            </>
          ) : (
            <>
              <div className={cx("amount leading-6 text-ink", size >= 170 ? "text-xl" : "text-[16px]")}>{center}</div>
              {centerNote && <div className="mt-0.5 text-[12px] leading-tight text-ink-2">{centerNote}</div>}
            </>
          )}
        </div>
      </div>
      {legend && (
        <ul className="min-w-[170px] flex-1 space-y-0.5" aria-label="Legend">
          {slices.map((s) => (
            <li key={s.key}>
              <button
                onClick={() => onSelect?.(s.key)}
                onPointerEnter={() => setHover(s.key)}
                onPointerLeave={() => setHover(null)}
                onFocus={() => setHover(s.key)}
                onBlur={() => setHover(null)}
                aria-pressed={selected === s.key}
                disabled={!onSelect}
                className={cx("flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[14px] transition-colors", focus === s.key ? "bg-wash" : "enabled:hover:bg-wash", selected && selected !== s.key && "opacity-55")}
              >
                <Swatch color={s.color} shape="dot" />
                <span className="min-w-0 flex-1 truncate text-ink-2">
                  {s.label}
                  {s.detail && <span className="ml-1.5 text-ink-3">{s.detail}</span>}
                </span>
                <span className="num font-medium text-ink">{format(s.value)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Risk map

export interface Point {
  key: string;
  x: number;
  lane: number;
  color: string;
  label: ReactNode;
  size?: number;
  // Drawn as an outline only, for findings set aside.
  hollow?: boolean;
}

// Hashes a key to a stable offset, so points keep their place between renders.
function jitter(key: string) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return ((h >>> 0) % 1000) / 1000;
}

// Findings placed by value on a log scale, one lane per severity. Points with
// no amount cannot sit on a log scale; the caller reports them separately.
export function RiskMap({
  points,
  lanes,
  height = 250,
  format,
  selected,
  onSelect,
}: {
  points: Point[];
  lanes: { name: string; color: string }[];
  height?: number;
  format: (v: number) => string;
  selected?: string | null;
  onSelect?: (key: string) => void;
}) {
  const n = lanes.length;
  const plotted = points.filter((p) => p.x > 0);
  const byLane = lanes.map((_, i) =>
    plotted
      .filter((p) => p.lane === i)
      .map((p) => ({ ...p, y: n - 1 - i + 0.16 + 0.68 * jitter(p.key), z: p.size ?? 5 })),
  );
  const xs = plotted.map((p) => p.x);
  const lo = xs.length ? Math.pow(10, Math.floor(Math.log10(Math.min(...xs)))) : 1;
  const hi = xs.length ? Math.pow(10, Math.ceil(Math.log10(Math.max(...xs) * 1.0001))) : 10;
  const ticks: number[] = [];
  for (let v = lo; v <= hi * 1.0001; v *= 10) ticks.push(v);

  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart margin={{ top: 8, right: 16, bottom: 0, left: 4 }}>
          <CartesianGrid stroke="var(--color-line-soft)" strokeDasharray="3 4" horizontal={false} />
          {lanes.slice(1).map((_, i) => (
            <ReferenceLine key={i} y={i + 1} stroke="var(--color-line-soft)" />
          ))}
          <XAxis type="number" dataKey="x" scale="log" domain={[lo, hi]} ticks={ticks} tickFormatter={(v) => format(Number(v))} tick={axisTick} tickLine={false} axisLine={{ stroke: "var(--color-line)" }} allowDataOverflow />
          <YAxis
            type="number"
            dataKey="y"
            domain={[0, n]}
            ticks={lanes.map((_, i) => n - 1 - i + 0.5)}
            tick={(props: any) => {
              const lane = lanes[n - 1 - Math.floor(Number(props.payload.value))];
              return (
                <text x={props.x - 4} y={props.y} textAnchor="end" dominantBaseline="middle" fontSize={12} fontWeight={500} fill={lane?.color}>
                  {lane?.name}
                </text>
              );
            }}
            tickLine={false}
            axisLine={false}
            width={64}
          />
          <ZAxis type="number" dataKey="z" range={[36, 220]} domain={[4, 9]} />
          <Tooltip cursor={{ strokeDasharray: "3 3", stroke: "var(--color-line)" }} content={({ active, payload }) => (active && payload?.length ? <TipCard>{(payload[0].payload as Point).label}</TipCard> : null)} />
          {byLane.map((data, i) => (
            <Scatter key={i} data={data} fill={lanes[i].color} onClick={(d: any) => onSelect?.(d?.key ?? d?.payload?.key)} style={{ cursor: "pointer" }} {...motion}>
              {data.map((p) => (
                <Cell key={p.key} fill={p.color} fillOpacity={p.hollow ? 0 : selected && selected !== p.key ? 0.3 : 0.75} stroke={selected === p.key ? "var(--color-ink)" : p.color} strokeWidth={selected === p.key ? 2 : p.hollow ? 1.5 : 1} strokeDasharray={p.hollow ? "2 2" : undefined} />
              ))}
            </Scatter>
          ))}
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------------------------------------------------------------- Treemap

export interface Tile {
  key: string;
  label: string;
  value: number;
  color: string;
  note?: string;
}

// Areas sized by value. Tiles large enough carry their name and amount.
export function Tiles({ tiles, height = 280, format, onSelect }: { tiles: Tile[]; height?: number; format: (v: number) => string; onSelect?: (key: string) => void }) {
  const data = tiles.filter((t) => t.value > 0).map((t) => ({ ...t, name: t.label, size: t.value }));
  const [hover, setHover] = useState<string | null>(null);

  const Content = (props: any) => {
    const { x, y, width, height: h, depth } = props;
    if (depth !== 1 || !(width > 0) || !(h > 0)) return null;
    const t = props as Tile;
    const on = hover === t.key;
    const fit = Math.max(3, Math.floor((width - 22) / 6.8));
    return (
      <g
        onMouseEnter={() => setHover(t.key)}
        onMouseLeave={() => setHover(null)}
        onClick={() => onSelect?.(t.key)}
        style={{ cursor: onSelect ? "pointer" : undefined, outline: "none" }}
        role="button"
        tabIndex={0}
        aria-label={`${t.label}: ${format(t.value)}`}
        onFocus={() => setHover(t.key)}
        onBlur={() => setHover(null)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect?.(t.key);
          }
        }}
      >
        <rect x={x + 1.5} y={y + 1.5} width={Math.max(0, width - 3)} height={Math.max(0, h - 3)} rx={5} fill={t.color} fillOpacity={hover && !on ? 0.42 : on ? 1 : 0.84} stroke={on ? "var(--color-ink)" : "none"} strokeWidth={1.5} />
        {width > 80 && h > 44 && (
          <>
            <text x={x + 11} y={y + 21} fontSize={12} fontWeight={600} fill="var(--color-paper)">
              {t.label.length > fit ? t.label.slice(0, fit - 1) + "…" : t.label}
            </text>
            <text x={x + 11} y={y + 38} fontSize={12} fill="var(--color-paper)" opacity={0.88} style={{ fontVariantNumeric: "tabular-nums" }}>
              {format(t.value)}
            </text>
          </>
        )}
      </g>
    );
  };

  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <Treemap data={data} dataKey="size" aspectRatio={1.6} stroke="none" content={<Content />} isAnimationActive={false}>
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const t = payload[0].payload as Tile;
              return (
                <TipCard>
                  <div className="font-semibold">{t.label}</div>
                  <div className="num">{format(t.value)}</div>
                  {t.note && <div className="text-ink-2">{t.note}</div>}
                </TipCard>
              );
            }}
          />
        </Treemap>
      </ResponsiveContainer>
    </div>
  );
}

// ---------------------------------------------------------------- Sparkline

let sparkId = 0;

export function Spark({ values, color, height = 34 }: { values: number[]; color: string; height?: number }) {
  const data = values.map((v, i) => ({ i, v }));
  const [id] = useState(() => `spark-${++sparkId}`);
  if (values.length < 2) return null;
  return (
    <div style={{ height }} className="w-full" aria-hidden>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.3} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area type="monotone" dataKey="v" stroke={color} strokeWidth={1.5} fill={`url(#${id})`} {...motion} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------------------------------------------------------------- Heat matrix

export function Matrix({
  rows,
  cols,
  cell,
  format,
  onSelect,
}: {
  rows: { key: string; label: string }[];
  cols: { key: string; label: ReactNode; color: string }[];
  cell: (row: string, col: string) => { count: number; value: number };
  format: (v: number) => string;
  onSelect?: (row: string, col: string) => void;
}) {
  const max = Math.max(1, ...rows.flatMap((r) => cols.map((c) => cell(r.key, c.key).value)));
  return (
    <div className="thin-scroll overflow-x-auto">
      <table className="w-full border-separate border-spacing-1 text-[14px]">
        <thead>
          <tr>
            <th />
            {cols.map((c) => (
              <th key={c.key} className="px-2 pb-1 text-left text-xs font-medium text-ink-2">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th className="max-w-[200px] truncate pr-3 text-left font-normal text-ink-2" title={r.label}>
                {r.label}
              </th>
              {cols.map((c) => {
                const v = cell(r.key, c.key);
                const pct = v.count ? 12 + Math.round((v.value / max) * 58) : 0;
                return (
                  <td key={c.key} className="p-0">
                    <button
                      disabled={!v.count}
                      onClick={() => onSelect?.(r.key, c.key)}
                      title={v.count ? `${v.count} finding${v.count === 1 ? "" : "s"}, ${format(v.value)}` : "None"}
                      className="flex h-11 w-full min-w-[92px] flex-col justify-center rounded-md px-2.5 text-left transition-[filter] duration-150 enabled:hover:brightness-125 disabled:cursor-default"
                      style={{ background: v.count ? `color-mix(in oklab, ${c.color} ${pct}%, transparent)` : "var(--color-wash)" }}
                    >
                      {v.count ? (
                        <>
                          <span className="num text-[14px] leading-4 font-medium text-ink">{format(v.value)}</span>
                          <span className="text-[12px] leading-4 text-ink-2">{v.count === 1 ? "1 finding" : `${v.count} findings`}</span>
                        </>
                      ) : (
                        <span className="text-xs text-ink-3">–</span>
                      )}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- Ranked bars

export interface Rank {
  key: string;
  label: string;
  value: number;
  color: string;
  tag?: ReactNode;
  note?: ReactNode;
}

export function Ranked({ items, format, onSelect, selected }: { items: Rank[]; format: (v: number) => string; onSelect?: (key: string) => void; selected?: string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className="space-y-0.5">
      {items.map((it) => (
        <li key={it.key}>
          <button
            onClick={() => onSelect?.(it.key)}
            disabled={!onSelect}
            aria-pressed={selected === it.key}
            className={cx("group grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 rounded-md px-2 py-1.5 text-left transition-colors enabled:hover:bg-wash", selected === it.key && "bg-wash", selected && selected !== it.key && "opacity-55")}
          >
            <span className="flex min-w-0 items-center gap-2 text-[14px] text-ink">
              <span className="truncate">{it.label}</span>
              {it.tag}
            </span>
            <span className="num text-[14px] font-medium text-ink">{format(it.value)}</span>
            <span className="col-span-2 h-1.5 overflow-hidden rounded-full bg-wash">
              <span className="grow-x block h-full rounded-full" style={{ width: `${(it.value / max) * 100}%`, background: it.color }} />
            </span>
            {it.note && <span className="col-span-2 text-xs text-ink-2">{it.note}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- Revenue bridge

export interface BridgeStep {
  key: string;
  label: string;
  // A total stands on the axis; a step hangs from the running balance.
  kind: "total" | "step";
  value: number;
  confirmed?: number;
  // Text before a total's value label, such as "At least".
  prefix?: string;
  note?: ReactNode;
}

// A waterfall: the opening total, each deduction hanging from the running
// balance, and the closing total. Deductions show the confirmed part in green.
export function Bridge({ steps, height = 320, format, axisFormat, onSelect }: { steps: BridgeStep[]; height?: number; format: (v: number) => string; axisFormat?: (v: number) => string; onSelect?: (key: string) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  const rows = useMemo(() => {
    let running = 0;
    return steps.map((st) => {
      if (st.kind === "total") {
        running = st.value;
        return { ...st, base: 0, total: st.value, potential: 0, confirmedPart: 0, totalLabel: `${st.prefix ? st.prefix + " " : ""}${format(st.value)}`, stepLabel: "" };
      }
      const c = Math.min(st.confirmed ?? 0, st.value);
      running -= st.value;
      return { ...st, base: running, total: 0, potential: st.value - c, confirmedPart: c, totalLabel: "", stepLabel: st.value ? `−${format(st.value)}` : "" };
    });
  }, [steps, format]);
  const bridgeTicks = niceTicks(Math.max(0, ...steps.map((st) => st.value)));

  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={rows}
          margin={{ top: 26, right: 8, left: 0, bottom: 4 }}
          barCategoryGap="16%"
          onMouseMove={(s: any) => setHover(s?.activeTooltipIndex ?? null)}
          onMouseLeave={() => setHover(null)}
          onClick={(s: any) => {
            const r = s?.activePayload?.[0]?.payload;
            if (r && r.kind === "step") onSelect?.(r.key);
          }}
          style={{ cursor: onSelect ? "pointer" : undefined }}
          accessibilityLayer
        >
          <CartesianGrid vertical={false} stroke="var(--color-line-soft)" strokeDasharray="3 4" />
          <XAxis
            dataKey="label"
            interval={0}
            tickLine={false}
            axisLine={{ stroke: "var(--color-line)" }}
            height={44}
            tick={(p: any) => {
              const words = String(p.payload.value).split(" ");
              const lines: string[] = [];
              for (const w of words) {
                const last = lines[lines.length - 1];
                if (last && (last + " " + w).length <= 14) lines[lines.length - 1] = last + " " + w;
                else lines.push(w);
              }
              return (
                <text x={p.x} y={p.y + 12} textAnchor="middle" fontSize={11} fill={hover === p.index ? "var(--color-ink)" : "var(--color-ink-2)"}>
                  {lines.slice(0, 2).map((l, i) => (
                    <tspan key={i} x={p.x} dy={i ? 13 : 0}>
                      {i === 1 && lines.length > 2 ? l + "…" : l}
                    </tspan>
                  ))}
                </text>
              );
            }}
          />
          <YAxis tick={axisTick} tickLine={false} axisLine={false} width={56} domain={[0, bridgeTicks[bridgeTicks.length - 1]]} ticks={bridgeTicks} tickFormatter={(v) => (axisFormat ?? format)(Number(v))} />
          <Tooltip
            cursor={{ fill: "var(--color-wash)" }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const r: any = payload[0].payload;
              return (
                <TipCard>
                  <div className="font-semibold">{r.label}</div>
                  {r.kind === "total" ? (
                    <div className="num mt-0.5">{format(r.total)}</div>
                  ) : (
                    <>
                      <div className="mt-0.5 flex justify-between gap-5">
                        <span className="text-ink-2">Potential</span>
                        <span className="num">{format(r.value)}</span>
                      </div>
                      <div className="flex justify-between gap-5">
                        <span className="text-ink-2">Confirmed</span>
                        <span className="num">{format(r.confirmedPart)}</span>
                      </div>
                      <div className="flex justify-between gap-5">
                        <span className="text-ink-2">Balance after</span>
                        <span className="num">{format(r.base)}</span>
                      </div>
                    </>
                  )}
                  {r.note && <div className="mt-1 text-ink-2">{r.note}</div>}
                </TipCard>
              );
            }}
          />
          <Bar dataKey="base" stackId="w" fill="transparent" isAnimationActive={false} />
          <Bar dataKey="total" stackId="w" {...motion}>
            {rows.map((r, i) => (
              <Cell
                key={r.key}
                fill={i === rows.length - 1 ? "color-mix(in oklab, var(--color-pass) 75%, transparent)" : "color-mix(in oklab, var(--color-brand) 70%, transparent)"}
                fillOpacity={hover !== null && hover !== i ? 0.45 : 1}
              />
            ))}
            <LabelList dataKey="totalLabel" position="top" style={{ fill: "var(--color-ink)", fontSize: 11.5, fontWeight: 600 }} />
          </Bar>
          <Bar dataKey="confirmedPart" stackId="w" fill={ink.good} {...motion}>
            {rows.map((r, i) => (
              <Cell key={r.key} fillOpacity={hover !== null && hover !== i ? 0.45 : 1} />
            ))}
          </Bar>
          <Bar dataKey="potential" stackId="w" fill={ink.high} radius={[2, 2, 0, 0]} {...motion}>
            {rows.map((r, i) => (
              <Cell key={r.key} fillOpacity={hover !== null && hover !== i ? 0.4 : 0.9} />
            ))}
            <LabelList dataKey="stepLabel" position="top" style={{ fill: "var(--color-fail)", fontSize: 11, fontWeight: 500 }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------------------------------------------------------------- Sales calendar

export interface DayCell {
  date: string; // YYYY-MM-DD
  value: number;
  rows: number;
  flagged: number;
}

const weekday = ["Mon", "", "Wed", "", "Fri", "", ""];
const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Every day of the period as a cell, one column per week. Shade is the day's
// value; a red ring marks days with rows that do not agree with the books.
export function Calendar({
  start,
  end,
  days,
  format,
  selected,
  onSelect,
  flagWord = "not agreeing",
  flagNote = (n: number) => `${n === 1 ? "1 row does" : `${n} rows do`} not agree with the books`,
}: {
  // How a flagged day is described: the register calls it "not agreeing".
  flagWord?: string;
  flagNote?: (n: number) => string;
  start: string;
  end: string;
  days: Map<string, DayCell>;
  format: (v: number) => string;
  selected?: string;
  onSelect?: (date: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number; d: DayCell } | null>(null);
  const cells = useMemo(() => {
    const out: { date: string; col: number; row: number; month: number; first: boolean }[] = [];
    const s = new Date(start + "T00:00:00");
    const e = new Date(end + "T00:00:00");
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e < s) return out;
    const offset = (s.getDay() + 6) % 7; // weeks start on Monday
    let i = 0;
    for (const d = new Date(s); d <= e && i < 400; d.setDate(d.getDate() + 1), i++) {
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const idx = i + offset;
      out.push({ date: k, col: Math.floor(idx / 7), row: idx % 7, month: d.getMonth(), first: d.getDate() === 1 || i === 0 });
    }
    return out;
  }, [start, end]);
  const values = useMemo(() => [...days.values()].map((d) => d.value).filter((v) => v > 0).sort((a, b) => a - b), [days]);
  // Quartile shading, so one large day does not wash out the rest.
  const level = (v: number) => {
    if (!v || !values.length) return 0;
    let lo = 0;
    let hi = values.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (values[m] < v) lo = m + 1;
      else hi = m;
    }
    return 1 + Math.min(3, Math.floor((lo / values.length) * 4));
  };
  const shade = [
    "var(--color-wash)",
    "color-mix(in oklab, var(--color-brand) 24%, var(--color-wash))",
    "color-mix(in oklab, var(--color-brand) 46%, var(--color-wash))",
    "color-mix(in oklab, var(--color-brand) 70%, var(--color-wash))",
    "var(--color-brand)",
  ];
  // Legend bands from the same quartiles as the shading, in the chart's unit.
  const q = (p: number) => values[Math.min(values.length - 1, Math.floor(p * values.length))] ?? 0;
  const bands = values.length ? [`up to ${format(q(0.25))}`, `up to ${format(q(0.5))}`, `up to ${format(q(0.75))}`, `up to ${format(values[values.length - 1])}`] : [];
  const cols = (cells[cells.length - 1]?.col ?? 0) + 1;
  const c = 14;
  const g = 3;
  const left = 30;
  const top = 18;
  const w = left + cols * (c + g);
  const h = top + 7 * (c + g);
  const place = (x: number, y: number, d: DayCell) => {
    const r = box.current?.getBoundingClientRect();
    if (r) setTip({ x: x - r.left, y: y - r.top, d });
  };

  return (
    <div ref={box} className="relative">
      <div className="thin-scroll overflow-x-auto pb-1">
        <svg width={w} height={h} role="grid" aria-label="Sales by day" className="block">
          {weekday.map((d, i) =>
            d ? (
              <text key={i} x={0} y={top + i * (c + g) + c - 3} fontSize={10} fill="var(--color-ink-3)">
                {d}
              </text>
            ) : null,
          )}
          {cells
            .filter((x) => x.first)
            .map((x) => (
              <text key={"m" + x.date} x={left + x.col * (c + g)} y={11} fontSize={10.5} fill="var(--color-ink-2)">
                {monthNames[x.month]}
              </text>
            ))}
          {cells.map((x) => {
            const d = days.get(x.date);
            const empty = { date: x.date, value: 0, rows: 0, flagged: 0 };
            const flagged = (d?.flagged ?? 0) > 0;
            const on = selected === x.date;
            return (
              <rect
                key={x.date}
                x={left + x.col * (c + g)}
                y={top + x.row * (c + g)}
                width={c}
                height={c}
                rx={3}
                fill={shade[level(d?.value ?? 0)]}
                stroke={on ? "var(--color-ink)" : flagged ? "var(--color-fail)" : "none"}
                strokeWidth={on ? 2 : flagged ? 2 : 0}
                tabIndex={d ? 0 : -1}
                role="gridcell"
                aria-label={`${x.date}: ${d ? format(d.value) : "no sales"}${flagged ? `, ${d!.flagged} ${flagWord}` : ""}`}
                style={{ cursor: d && onSelect ? "pointer" : undefined, outline: "none" }}
                onPointerEnter={(e) => place(e.clientX, e.clientY, d ?? empty)}
                onPointerLeave={() => setTip(null)}
                onFocus={(e) => {
                  const t = (e.target as Element).getBoundingClientRect();
                  place(t.left + c / 2, t.top, d ?? empty);
                }}
                onBlur={() => setTip(null)}
                onClick={() => d && onSelect?.(x.date)}
                onKeyDown={(e) => {
                  if (d && (e.key === "Enter" || e.key === " ")) {
                    e.preventDefault();
                    onSelect?.(x.date);
                  }
                }}
              />
            );
          })}
        </svg>
      </div>
      {tip && (
        <div className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-full" style={{ left: tip.x, top: tip.y - 10 }}>
          <TipCard>
            <div className="font-semibold">{new Date(tip.d.date + "T00:00:00").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" })}</div>
            {tip.d.rows ? (
              <>
                <div className="num">
                  {format(tip.d.value)} in {tip.d.rows} {tip.d.rows === 1 ? "row" : "rows"}
                </div>
                {tip.d.flagged > 0 && <div className="text-fail">{flagNote(tip.d.flagged)}</div>}
              </>
            ) : (
              <div className="text-ink-2">No sales</div>
            )}
          </TipCard>
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-ink-2">
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>Sales that day:</span>
          <span className="flex items-center gap-1.5">
            <i className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: shade[0] }} />
            none
          </span>
          {bands.map((b, i) => (
            <span key={i} className="flex items-center gap-1.5">
              <i className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: shade[i + 1] }} />
              <span className="num">{b}</span>
            </span>
          ))}
        </span>
        <span className="flex items-center gap-1.5">
          <i className="inline-block h-2.5 w-2.5 rounded-[2px] border-2 border-fail" />
          Rows {flagWord} that day
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Pareto

export interface ParetoItem {
  key: string;
  label: string;
  value: number;
  color: string;
  // Outlined in red and marked above the bar, whatever its fill.
  flagged?: boolean;
  note?: string;
}

// Bars from largest to smallest with the running share as a line, so the
// concentration of revenue in a few names is visible at once.
export function Pareto({ items, height = 280, format, axisFormat, selected, onSelect }: { items: ParetoItem[]; height?: number; format: (v: number) => string; axisFormat?: (v: number) => string; selected?: string; onSelect?: (key: string) => void }) {
  const total = items.reduce((t, i) => t + i.value, 0);
  const rows = useMemo(() => {
    let run = 0;
    return items.map((i) => {
      run += i.value;
      return { ...i, share: total ? (run / total) * 100 : 0, flagMark: i.flagged ? "!" : "" };
    });
  }, [items, total]);
  const vTicks = niceTicks(Math.max(0, ...items.map((i) => i.value)));
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={rows}
          margin={{ top: 10, right: 4, left: 0, bottom: 0 }}
          onClick={(s: any) => {
            const r = s?.activePayload?.[0]?.payload;
            if (r) onSelect?.(r.key);
          }}
          style={{ cursor: onSelect ? "pointer" : undefined }}
        >
          <CartesianGrid vertical={false} stroke="var(--color-line-soft)" strokeDasharray="3 4" />
          <XAxis dataKey="label" tick={false} tickLine={false} axisLine={{ stroke: "var(--color-line)" }} height={6} />
          <YAxis yAxisId="v" tick={axisTick} tickLine={false} axisLine={false} width={56} domain={[0, vTicks[vTicks.length - 1]]} ticks={vTicks} tickFormatter={(v) => (axisFormat ?? format)(Number(v))} />
          <YAxis yAxisId="p" orientation="right" domain={[0, 100]} ticks={[0, 50, 80, 100]} tick={axisTick} tickLine={false} axisLine={false} width={38} tickFormatter={(v) => `${v}%`} />
          <ReferenceLine yAxisId="p" y={80} stroke="var(--color-ink-3)" strokeDasharray="3 3" />
          <Tooltip
            cursor={{ fill: "var(--color-wash)" }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const r: any = payload[0].payload;
              return (
                <TipCard>
                  <div className="font-semibold">{r.label}</div>
                  <div className="num">{format(r.value)}</div>
                  {r.note && <div className={r.flagged ? "text-fail" : "text-ink-2"}>{r.note}</div>}
                  <div className="text-ink-2">
                    {total ? ((r.value / total) * 100).toFixed(1) : 0}% of the total; {r.share.toFixed(0)}% with every larger customer
                  </div>
                </TipCard>
              );
            }}
          />
          <Bar yAxisId="v" dataKey="value" radius={[2, 2, 0, 0]} {...motion}>
            {rows.map((r) => (
              <Cell key={r.key} fill={r.color} fillOpacity={selected && selected !== r.key ? 0.35 : 1} stroke={r.flagged ? "var(--color-fail)" : "none"} strokeWidth={r.flagged ? 2 : 0} />
            ))}
            <LabelList dataKey="flagMark" position="top" style={{ fill: "var(--color-fail)", fontSize: 11, fontWeight: 700 }} />
          </Bar>
          <Line yAxisId="p" type="monotone" dataKey="share" stroke="var(--color-ink)" strokeWidth={1.5} dot={false} {...motion} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------------------------------------------------------------- Flow

export interface FlowNode {
  name: string;
  color: string;
}

// Value moving from one grouping to the next, left to right.
export function Flow({ nodes, links, height = 360, format }: { nodes: FlowNode[]; links: { source: number; target: number; value: number }[]; height?: number; format: (v: number) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!links.length) return null;

  const Node = (p: any) => {
    const n = nodes[p.index];
    if (!n) return null;
    const last = p.payload?.sourceLinks?.length === 0;
    return (
      <g onMouseEnter={() => setHover(p.index)} onMouseLeave={() => setHover(null)} style={{ cursor: "default" }}>
        <rect x={p.x} y={p.y} width={p.width} height={Math.max(2, p.height)} rx={2} fill={n.color} />
        {p.height > 8 && (
          <text x={last ? p.x + p.width + 8 : p.x + p.width + 8} y={p.y + p.height / 2} textAnchor="start" dominantBaseline="middle" fontSize={11.5} fill="var(--color-ink)" style={{ paintOrder: "stroke", stroke: "var(--color-paper)", strokeWidth: 3 }}>
            {n.name}
            <tspan fill="var(--color-ink-2)" dx={6}>
              {format(p.payload.value)}
            </tspan>
          </text>
        )}
      </g>
    );
  };

  const Link = (p: any) => {
    const { sourceX, targetX, sourceY, targetY, sourceControlX, targetControlX, linkWidth, payload } = p;
    const si = payload?.source?.index ?? payload?.source;
    const ti = payload?.target?.index ?? payload?.target;
    const lit = hover === null || hover === si || hover === ti;
    return (
      <path
        d={`M${sourceX},${sourceY} C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${targetX},${targetY}`}
        fill="none"
        stroke={nodes[si]?.color ?? "var(--color-line)"}
        strokeOpacity={lit ? 0.3 : 0.06}
        strokeWidth={Math.max(1, linkWidth)}
      />
    );
  };

  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <Sankey data={{ nodes: nodes.map((n) => ({ name: n.name })), links }} node={<Node />} link={<Link />} nodePadding={16} nodeWidth={10} margin={{ top: 8, right: 170, bottom: 8, left: 8 }} iterations={48}>
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const d: any = payload[0].payload?.payload ?? payload[0].payload;
              const name = d?.source && d?.target ? `${d.source.name} to ${d.target.name}` : d?.name;
              return (
                <TipCard>
                  <div className="font-semibold">{name}</div>
                  <div className="num">{format(Number(d?.value ?? payload[0].value ?? 0))}</div>
                </TipCard>
              );
            }}
          />
        </Sankey>
      </ResponsiveContainer>
    </div>
  );
}

// ---------------------------------------------------------------- Cut-off timeline

export interface CutoffItem {
  key: string;
  label: string;
  invoiced: string; // YYYY-MM-DD
  delivered?: string; // YYYY-MM-DD
  wrong: boolean;
  note?: string;
}

const dayMs = 86400000;
const toDay = (iso: string) => Date.parse(iso.slice(0, 10) + "T00:00:00Z") / dayMs;
const shortDate = (d: number) => new Date(d * dayMs).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

// Each sale as an arrow from the day it was invoiced to the day it was
// delivered, around the period end. Sales whose delivery falls in the other
// period are drawn in red.
export function CutoffTimeline({ items, periodEnd, onSelect }: { items: CutoffItem[]; periodEnd: string; onSelect?: (key: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<string | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const end = toDay(periodEnd);
  const points = items.flatMap((i) => [toDay(i.invoiced), i.delivered ? toDay(i.delivered) : toDay(i.invoiced)]);
  const lo = Math.min(end - 3, ...points) - 1;
  const hi = Math.max(end + 3, ...points) + 1;
  const rows = [...items].sort((a, b) => a.invoiced.localeCompare(b.invoiced) || a.key.localeCompare(b.key));
  const left = width < 480 ? 96 : 128;
  const right = 16;
  const rowH = 18;
  const top = 26;
  const plotBottom = top + rows.length * rowH;
  const h = plotBottom + 24;
  const x = (d: number) => left + ((d - lo) / Math.max(1, hi - lo)) * Math.max(1, width - left - right);
  const step = Math.max(1, Math.ceil((hi - lo) / Math.max(3, Math.floor((width - left) / 64))));
  const ticks: number[] = [];
  for (let d = Math.ceil(lo); d <= hi; d += step) ticks.push(d);
  const cut = x(end + 0.5);

  return (
    <div ref={box} className="w-full">
      {width > 0 && (
        <svg width={width} height={h} role="img" aria-label="Invoice and delivery dates around the period end" className="block">
          <defs>
            <marker id="cut-ok" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0 0L8 4L0 8z" fill="var(--color-ink-3)" />
            </marker>
            <marker id="cut-bad" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0 0L8 4L0 8z" fill="var(--color-fail)" />
            </marker>
          </defs>
          <rect x={cut} y={top - 6} width={Math.max(0, width - right - cut)} height={plotBottom - top + 6} fill="var(--color-wash)" opacity={0.75} />
          <text x={cut - 6} y={14} fontSize={11} fill="var(--color-ink-2)" textAnchor="end">
            This period
          </text>
          <text x={cut + 6} y={14} fontSize={11} fill="var(--color-ink-2)">
            Next period
          </text>
          {ticks.map((d) => (
            <g key={d}>
              <line x1={x(d)} x2={x(d)} y1={top - 6} y2={plotBottom} stroke="var(--color-line-soft)" />
              <text x={x(d)} y={plotBottom + 16} fontSize={10.5} fill="var(--color-ink-3)" textAnchor="middle">
                {shortDate(d)}
              </text>
            </g>
          ))}
          <line x1={cut} x2={cut} y1={top - 6} y2={plotBottom} stroke="var(--color-ink-2)" strokeDasharray="3 3" />
          {rows.map((r, i) => {
            const y = top + i * rowH + rowH / 2;
            const a = x(toDay(r.invoiced));
            const b = r.delivered ? x(toDay(r.delivered)) : a;
            const on = hover === r.key;
            const color = r.wrong ? "var(--color-fail)" : "var(--color-ink-3)";
            return (
              <g
                key={r.key}
                onMouseEnter={() => setHover(r.key)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(r.key)}
                onBlur={() => setHover(null)}
                onClick={() => onSelect?.(r.key)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect?.(r.key);
                  }
                }}
                tabIndex={0}
                role="button"
                aria-label={`${r.label}: invoiced ${r.invoiced}, delivered ${r.delivered ?? "unknown"}${r.wrong ? ", in the wrong period" : ""}`}
                style={{ cursor: onSelect ? "pointer" : undefined, outline: "none" }}
              >
                <rect x={0} y={y - rowH / 2} width={width} height={rowH} fill={on ? "var(--color-wash)" : "transparent"} />
                <text x={left - 10} y={y} dominantBaseline="middle" textAnchor="end" fontSize={11} fill={r.wrong ? "var(--color-fail)" : "var(--color-ink-2)"} fontWeight={r.wrong ? 600 : 400}>
                  {r.label}
                </text>
                <circle cx={a} cy={y} r={3} fill={color} />
                {Math.abs(b - a) > 6 ? (
                  <line x1={a + (b > a ? 4 : -4)} x2={b + (b > a ? -1 : 1)} y1={y} y2={y} stroke={color} strokeWidth={r.wrong ? 2 : 1.5} markerEnd={`url(#${r.wrong ? "cut-bad" : "cut-ok"})`} />
                ) : (
                  <circle cx={b} cy={y} r={5} fill="none" stroke={color} strokeWidth={1.5} />
                )}
                {on && (
                  <text
                    x={b + 200 > width ? a - 10 : b + 10}
                    y={y}
                    dominantBaseline="middle"
                    fontSize={11}
                    fill="var(--color-ink)"
                    textAnchor={b + 200 > width ? "end" : "start"}
                    style={{ paintOrder: "stroke", stroke: "var(--color-paper)", strokeWidth: 3 }}
                  >
                    {shortDate(toDay(r.invoiced))} to {r.delivered ? shortDate(toDay(r.delivered)) : "not delivered"}
                    {r.note ? `, ${r.note}` : ""}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}
