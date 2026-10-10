// Presentation pieces shared by the auditor views: severity marks, money in
// lakh and crore, num tiles and bar lists. Every num they show is passed
// in from a tool result; nothing here makes up a number.

import { CSSProperties, KeyboardEvent as RKeyboardEvent, ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import { callTool, money } from "../api";
import { Button, Mark, cx, toast, useAction } from "../ui";
import { NoteBand } from "../print";

export type Severity = "High" | "Medium" | "Low";
export const severities: Severity[] = ["High", "Medium", "Low"];
export const severityRank: Record<string, number> = { High: 0, Medium: 1, Low: 2 };

export interface FindingLite {
  finding_id: string;
  detector_id: string;
  category: string;
  subtype?: string;
  severity: Severity;
  title: string;
  subject?: { type: string; id: string; label?: string };
  amount_impact: number;
  period_effect?: string;
  status: string;
  sample_ids?: string[];
  reason?: string;
  created_at?: string;
  decided_by?: string;
  decided_at?: string;
}

export const findingStatus: Record<string, string> = {
  proposed: "Awaiting review",
  confirmed: "Confirmed",
  rejected: "Rejected",
  needs_info: "Needs info",
};

// Plain names for the detector categories (PRD section 13.2).
const categoryNames: Record<string, string> = {
  REGISTER_MISMATCH: "Register differs from the books",
  RP_UNDISCLOSED: "Undisclosed related party",
  RP_MID_PERIOD: "Related party from mid-period",
  CIRCULAR_TRADING: "Circular trading",
  NO_MOVEMENT: "No physical movement",
  CUTOFF: "Cut-off",
  PERIOD_END_CONCENTRATION: "Period-end concentration",
  DOC_TAX_MISMATCH: "Tax documents and GSTR-1",
  NON_SALE_REVENUE: "Revenue not from a sale",
  EVIDENCE_SUSPECT: "Suspect evidence",
  CREDIT_NOTE: "Credit note",
  PROMOTION_DISCOUNT: "Promotion or discount",
  SETTLEMENT: "Settlement",
  DOCUMENT_INTEGRITY: "Document integrity",
  POST_TESTING_CHANGE: "Changed after testing",
  LEDGER_INTEGRITY: "Ledger integrity",
};

export function category(c: string) {
  if (categoryNames[c]) return categoryNames[c];
  const text = c.replace(/_/g, " ").toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Rupees in the units an Indian finance reader scans: crore, lakh, then whole.
export function inr(v: unknown): string {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return "";
  const a = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  if (a >= 1e7) return `${sign}₹ ${(a / 1e7).toFixed(a >= 1e9 ? 0 : 2)} Cr`;
  if (a >= 1e5) return `${sign}₹ ${(a / 1e5).toFixed(2)} L`;
  return `${sign}₹ ${money(a).replace(/\.00$/, "")}`;
}

export function sum(items: FindingLite[]) {
  return items.reduce((t, f) => t + (Number(f.amount_impact) || 0), 0);
}

// Most urgent first: severity, then value, then the ones still awaiting review.
export function byPriority(a: FindingLite, b: FindingLite) {
  return (
    (severityRank[a.severity] ?? 3) - (severityRank[b.severity] ?? 3) ||
    (Number(b.amount_impact) || 0) - (Number(a.amount_impact) || 0) ||
    Number(b.status === "proposed") - Number(a.status === "proposed")
  );
}

const sevText: Record<Severity, string> = { High: "text-fail", Medium: "text-wait", Low: "text-ink-2" };
const sevWash: Record<Severity, string> = { High: "bg-fail-wash", Medium: "bg-wait-wash", Low: "bg-wash" };
// Severity colours as CSS values, for charts. Red is kept for high severity alone.
export const sevColor: Record<string, string> = { High: "var(--color-fail)", Medium: "var(--color-wait)", Low: "var(--color-ink-3)" };
export const sevFill: Record<Severity, string> = { High: "bg-fail", Medium: "bg-wait", Low: "bg-ink-3" };

// Severity has its own shape as well as its colour, so it reads without colour:
// a filled triangle for high, a diamond for medium, a ring for low.
export function SeverityIcon({ severity, size = 14 }: { severity: Severity; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 16 16", "aria-hidden": true } as const;
  if (severity === "High")
    return (
      <svg {...common}>
        <path d="M8 1.8L15 14H1z" fill="currentColor" />
        <path d="M8 6.2v3.6M8 11.7v.1" stroke="var(--color-paper)" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    );
  if (severity === "Medium")
    return (
      <svg {...common}>
        <path d="M8 2l6 6-6 6-6-6z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        <path d="M8 5.6l2.4 2.4L8 10.4 5.6 8z" fill="currentColor" />
      </svg>
    );
  return (
    <svg {...common}>
      <circle cx="8" cy="8" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

export function SeverityBadge({ severity, compact }: { severity: Severity; compact?: boolean }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[12.5px] font-bold whitespace-nowrap", sevText[severity], sevWash[severity])}>
      <SeverityIcon severity={severity} size={12} />
      {compact ? severity : `${severity} severity`}
    </span>
  );
}

// The line above a view's title: where in the audit this page sits.
export function Eyebrow({ children }: { children: ReactNode }) {
  return <div className="mb-1 text-[14px] font-medium text-ink-2">{children}</div>;
}

// Every auditor page opens with its note band (print.tsx).
export function ViewHead({ eyebrow, title, summary, action }: { eyebrow?: ReactNode; title: string; summary?: ReactNode; action?: ReactNode }) {
  return <NoteBand title={title} eyebrow={eyebrow} summary={summary} action={action} />;
}

// One headline figure. `tone` colours the figure only when it carries meaning.
export function Kpi({
  label,
  value,
  note,
  tone,
  onClick,
  children,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  tone?: "bad" | "good" | "warn" | "accent";
  onClick?: () => void;
  children?: ReactNode;
}) {
  const toneClass = { bad: "text-fail", good: "text-pass", warn: "text-wait", accent: "text-brand" };
  const body = (
    <>
      <div className="flex items-center justify-between gap-3 text-[14px] font-semibold text-ink-2">
        <span>{label}</span>
        {onClick && (
          <svg className="text-ink-3 transition-transform duration-150 group-hover:translate-x-0.5" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M6 3.5L10.5 8 6 12.5" />
          </svg>
        )}
      </div>
      <div className={cx("amount mt-1.5 text-[36px] leading-10", tone && toneClass[tone])}>{value}</div>
      {note && <div className="mt-1 text-[14px] leading-snug text-ink-2">{note}</div>}
      {children && <div className="mt-3">{children}</div>}
    </>
  );
  const base = "kpi flex flex-col rounded-xl border border-line bg-paper px-5 py-4 text-left";
  return onClick ? (
    <button onClick={onClick} className={cx(base, "group transition-[border-color,box-shadow,transform] duration-150 hover:-translate-y-0.5 hover:border-brand/50 hover:shadow-[0_8px_24px_rgba(12,58,43,0.10)] focus-visible:border-brand focus-visible:outline-none")}>
      {body}
    </button>
  ) : (
    <div className={base}>{body}</div>
  );
}

// A titled panel: the workspace's basic surface.
export function Panel({
  id,
  more,
  title,
  takeaway,
  meta,
  action,
  children,
  className,
  flush,
}: {
  id?: string;
  // The folded group this panel belongs to in simple view.
  more?: string;
  title: ReactNode;
  // One plain sentence, computed from the data, saying what the chart shows.
  takeaway?: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  flush?: boolean;
}) {
  return (
    <section id={id} data-more={more} className={cx("rounded-xl border border-line bg-paper shadow-[0_1px_0_var(--color-line-soft)]", className)}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-line-soft px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-[17px] leading-snug font-bold text-ink">{title}</h2>
          {takeaway && <p className="mt-0.5 text-[14px] text-ink-2">{takeaway}</p>}
        </div>
        <div className="flex items-center gap-3 text-[14px] text-ink-2">
          {meta}
          {action}
        </div>
      </div>
      <div className={flush ? "" : "px-5 py-4"}>{children}</div>
    </section>
  );
}

// A horizontal bar whose length is the value's share of the largest one.
export function Bar({ share, className }: { share: number; className?: string }) {
  const pct = Math.max(0, Math.min(1, share)) * 100;
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-wash">
      <div className={cx("grow-x h-full rounded-full", className ?? "bg-brand")} style={{ width: `${pct}%` }} />
    </div>
  );
}

// Proportions of one total in a single line, each part labelled for screen readers.
export function Stack({ parts, label }: { parts: { value: number; className: string; name: string }[]; label: string }) {
  const total = parts.reduce((t, p) => t + p.value, 0);
  if (total <= 0) return <div className="h-2.5 rounded-full bg-wash" />;
  return (
    <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-full" role="img" aria-label={label}>
      {parts
        .filter((p) => p.value > 0)
        .map((p) => (
          <div key={p.name} title={p.name} className={cx("grow-x h-full", p.className)} style={{ width: `${(p.value / total) * 100}%` }} />
        ))}
    </div>
  );
}

// A ring that fills with progress, with the num in its middle.
export function Ring({ done, total, size = 64 }: { done: number; total: number; size?: number }) {
  const r = size / 2 - 5;
  const c = 2 * Math.PI * r;
  const share = total ? done / total : 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${done} of ${total} done`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-wash)" strokeWidth="6" />
      <circle
        className="ring-fill"
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={share >= 1 ? "var(--color-pass)" : "var(--color-brand)"}
        strokeWidth="6"
        strokeLinecap="round"
        strokeDasharray={`${c * share} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" className="num" fontSize={size / 4.4} fill="var(--color-ink)">
        {Math.round(share * 100)}%
      </text>
    </svg>
  );
}

export function SearchBox({ value, onChange, placeholder, label }: { value: string; onChange: (v: string) => void; placeholder: string; label: string }) {
  return (
    <div className="relative">
      <svg className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
        <circle cx="7" cy="7" r="4.5" />
        <path d="M10.5 10.5L14 14" />
      </svg>
      <input
        type="search"
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-10 w-full rounded-lg border border-line bg-paper pr-3 pl-9 text-[15px] text-ink outline-none transition-colors placeholder:text-ink-3 hover:border-ink-3 focus:border-brand focus:ring-[3px] focus:ring-brand/15"
      />
    </div>
  );
}

// A count with its label, for summary strips.
export function Tally({ n, label, className }: { n: ReactNode; label: string; className?: string }) {
  return (
    <span className="whitespace-nowrap">
      <span className={cx("num text-[16px] font-bold", className)}>{n}</span>
      <span className="ml-1.5 text-[14px] text-ink-2">{label}</span>
    </span>
  );
}

// "6,885 rows": counts carry Indian digit grouping wherever they are written.
export const plural = (n: number, one: string, many = one + "s") => `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------- Register

export interface RegisterRow {
  row_no: number;
  raw: Record<string, any>;
  rp_tag?: string;
  suggested_rp?: string;
  recon_status?: string;
  finding_ids: string[];
}

// The whole register, read page by page with the register tool.
export function useRegisterAll(enabled: boolean, pulse: number) {
  const [state, setState] = useState<{ columns: string[]; rows: RegisterRow[]; loading: boolean; error: Error | null }>({ columns: [], rows: [], loading: enabled, error: null });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    (async () => {
      setState((s) => ({ ...s, loading: true }));
      try {
        let cursor: string | null = null;
        let columns: string[] = [];
        const rows: RegisterRow[] = [];
        do {
          const page: { columns: string[]; rows: RegisterRow[]; next_cursor: string | null } = await callTool("get_register_rows", cursor ? { limit: 500, cursor } : { limit: 500 });
          columns = page.columns ?? columns;
          rows.push(...(page.rows ?? []));
          cursor = page.next_cursor ?? null;
        } while (cursor && live);
        if (live) setState({ columns, rows, loading: false, error: null });
      } catch (e) {
        if (live) setState((s) => ({ ...s, loading: false, error: e as Error }));
      }
    })();
    return () => {
      live = false;
    };
  }, [enabled, pulse]);
  return state;
}

// The client's register has its own headings, so the date, value and customer
// columns are found by name.
export function registerFields(columns: string[]) {
  const find = (...res: RegExp[]) => {
    for (const re of res) {
      const c = columns.find((x) => re.test(x));
      if (c) return c;
    }
    return undefined;
  };
  return {
    date: find(/^date$/i, /invoice date|bill date/i, /date/i),
    value: find(/gross/i, /invoice (value|amount)/i, /amount|amt/i, /total/i, /taxable/i),
    customer: find(/customer/i, /party|buyer/i),
    bill: find(/bill no|invoice no/i, /bill|invoice/i),
  };
}

export function num(v: unknown): number {
  if (typeof v === "number") return v;
  const n = Number(String(v ?? "").replace(/[,₹\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

// "08-04-2025", "08/04/2025" or "2025-04-08" to "2025-04".
export function monthKey(v: unknown): string | null {
  const s = String(v ?? "").trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}`;
  return null;
}

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function monthLabel(key: string) {
  const [y, m] = key.split("-");
  return `${months[Number(m) - 1] ?? m} ${y.slice(2)}`;
}

// Every month from the first key to the last, so gaps show as empty columns.
export function monthRange(keys: string[]): string[] {
  const sorted = [...new Set(keys)].sort();
  if (!sorted.length) return [];
  const out: string[] = [];
  let [y, m] = sorted[0].split("-").map(Number);
  const [ly, lm] = sorted[sorted.length - 1].split("-").map(Number);
  while (y < ly || (y === ly && m <= lm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out.slice(-24);
}

// A short rupee num for chart axes: 12K, 3.4L, 1.2Cr.
export function inrAxis(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e7) return `${+(v / 1e7).toFixed(1)}Cr`;
  if (a >= 1e5) return `${+(v / 1e5).toFixed(1)}L`;
  if (a >= 1e3) return `${+(v / 1e3).toFixed(0)}K`;
  return String(Math.round(v));
}

// "2025-04-01" to "1 Apr 2025".
export function day(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

// "08-04-2025", "08/04/2025" or "2025-04-08" to "2025-04-08".
export function dateKey(v: unknown): string | null {
  const s = String(v ?? "").trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}

// ---------------------------------------------------------------- Kinds of problem

// Sixteen detector categories are too many colours to tell apart, so each
// belongs to one of six kinds of problem, named in plain words. A kind has
// one colour, the same on every page; none of them is red, which means high
// severity, or green, which means checked. The six colours were validated for
// colour-blind separation in both themes (tokens --color-fam-1 to 6).
export const families: { key: string; label: string; color: string; cats: string[] }[] = [
  { key: "real", label: "Sales that may not be real", color: "var(--color-fam-1)", cats: ["CIRCULAR_TRADING", "NO_MOVEMENT", "NON_SALE_REVENUE"] },
  { key: "timing", label: "Booked in the wrong period", color: "var(--color-fam-2)", cats: ["CUTOFF", "PERIOD_END_CONCENTRATION"] },
  { key: "rp", label: "Related parties", color: "var(--color-fam-3)", cats: ["RP_UNDISCLOSED", "RP_MID_PERIOD"] },
  { key: "docs", label: "Documents and tax", color: "var(--color-fam-4)", cats: ["DOC_TAX_MISMATCH", "DOCUMENT_INTEGRITY", "EVIDENCE_SUSPECT"] },
  { key: "money", label: "Money in and out", color: "var(--color-fam-5)", cats: ["SETTLEMENT", "CREDIT_NOTE", "PROMOTION_DISCOUNT"] },
  { key: "books", label: "Books and records", color: "var(--color-fam-6)", cats: ["REGISTER_MISMATCH", "POST_TESTING_CHANGE", "LEDGER_INTEGRITY"] },
];

export function family(c: string) {
  return families.find((f) => f.cats.includes(c)) ?? families[5];
}

export function catColor(c: string): string {
  return family(c).color;
}

// ---------------------------------------------------------------- One unit per chart

export interface Scale {
  unit: string;
  // Axis ticks and data labels, all in the same unit.
  axis: (v: number) => string;
  label: (v: number) => string;
}

// Picks crore, lakh or thousand from the largest value and keeps it for every
// figure on that chart.
export function scaleFor(max: number): Scale {
  const [div, unit] = max >= 1e7 ? [1e7, "Cr"] : max >= 1e5 ? [1e5, "L"] : max >= 1e3 ? [1e3, "K"] : [1, ""];
  const fmt = (v: number, dp: number) => {
    const text = (v / (div as number)).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: dp });
    return unit ? `${text} ${unit}` : text;
  };
  return { unit: unit as string, axis: (v) => fmt(v, 1), label: (v) => `₹ ${fmt(v, 2)}` };
}

// ---------------------------------------------------------------- Definitions

const terms: Record<string, string> = {
  TOD: "Test of details: the auditor picks individual invoices and checks each one against its documents.",
  "cut-off": "Whether a sale is recorded in the right year. Goods delivered after 31 March belong to the next year.",
  "related party": "A customer or supplier connected to the company's owners or management, where prices may not be at arm's length.",
  misstatement: "An amount in the books that is wrong. It stays potential until the audit manager confirms it.",
  snapshot: "A frozen copy of the client's records taken when the engagement opened. Every test runs on it, so later edits cannot change the result.",
  exception: "A sample that failed a test: the documents do not support what the books say.",
};

// A word with a small info mark; its definition shows on hover or keyboard focus.
export function Term({ word, children }: { word: string; children?: ReactNode }) {
  const text = terms[word];
  if (!text) return <>{children ?? word}</>;
  return (
    <span className="group/term relative inline-flex items-center gap-1">
      {children ?? word}
      <button type="button" className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full text-ink-3 transition-colors hover:text-ink focus-visible:text-ink" aria-label={`What ${word} means: ${text}`}>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
          <circle cx="8" cy="8" r="6.3" />
          <path d="M8 7.2v4M8 4.9v.2" strokeLinecap="round" strokeWidth="1.8" />
        </svg>
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute top-full left-0 z-30 mt-1.5 hidden w-72 max-w-[calc(100vw-2rem)] rounded-lg bg-spine px-3.5 py-2.5 text-[14px] leading-relaxed font-normal text-spine-ink shadow-[0_14px_34px_rgba(6,21,15,0.35)] group-focus-within/term:block group-hover/term:block"
      >
        {text}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------- Loading

export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return <div className={cx("skeleton rounded-md", className)} style={style} aria-hidden />;
}

const skeletonBars = [46, 70, 58, 82, 64, 90, 52, 76, 60, 88, 68, 95];

// The shape of a chart while its data loads.
export function ChartSkeleton({ height = 220 }: { height?: number }) {
  return (
    <div className="flex items-end gap-2 px-1" style={{ height }} role="status" aria-label="Loading">
      {skeletonBars.map((h, i) => (
        <Skeleton key={i} className="flex-1" style={{ height: `${h}%` }} />
      ))}
    </div>
  );
}

export function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-3 px-5 py-4" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-4">
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-20" />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- Review progress

export function ReviewProgress({ findings }: { findings: FindingLite[] }) {
  const total = findings.length;
  const by = (st: string) => findings.filter((f) => f.status === st).length;
  const confirmed = by("confirmed");
  const rejected = by("rejected");
  const info = by("needs_info");
  const reviewed = confirmed + rejected;
  const pct = (n: number) => (total ? (n / total) * 100 : 0);
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-[14px] text-ink-2">
          <span className="num text-[17px] font-bold text-ink">{reviewed}</span> of <span className="num">{total}</span> findings reviewed by the manager
        </span>
        <span className="num text-[14px] font-semibold text-ink-2">{total ? Math.round(pct(reviewed)) : 0}%</span>
      </div>
      <div className="mt-2 flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-wash" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={reviewed} aria-label="Findings reviewed">
        <div className="grow-x h-full bg-pass" style={{ width: `${pct(confirmed)}%` }} title={`${confirmed} confirmed`} />
        <div className="grow-x h-full bg-ink-3" style={{ width: `${pct(rejected)}%` }} title={`${rejected} rejected`} />
        <div className="grow-x h-full bg-wait/60" style={{ width: `${pct(info)}%` }} title={`${info} need more information`} />
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[14px] text-ink-2">
        <span>{confirmed} confirmed</span>
        <span>{rejected} rejected</span>
        {info > 0 && <span>{info} need more information</span>}
        <span>{total - reviewed - info} awaiting review</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Counting once

// Findings on the same subject (one invoice, one customer, one cycle) can each
// carry the subject's amount. Each subject is counted once, under its most
// severe finding, so totals do not add the same rupees twice.
export function dedupe(open: FindingLite[]) {
  const groups = new Map<string, FindingLite[]>();
  for (const f of open) {
    const k = f.subject ? `${f.subject.type}:${f.subject.id}` : f.finding_id;
    groups.set(k, [...(groups.get(k) ?? []), f]);
  }
  const kept: FindingLite[] = [];
  let removed = 0;
  let merged = 0;
  for (const list of groups.values()) {
    if (list.length === 1) {
      kept.push(list[0]);
      continue;
    }
    const lead = [...list].sort(byPriority)[0];
    const amount = Math.max(...list.map((f) => Number(f.amount_impact) || 0));
    removed += sum(list) - amount;
    merged += list.length - 1;
    kept.push({ ...lead, amount_impact: amount });
  }
  return { kept, removed, merged };
}

// ---------------------------------------------------------------- Page summary

export interface BriefStat {
  label: string;
  value: ReactNode;
  tone?: "bad" | "good" | "warn" | "accent";
  hint?: string;
  active?: boolean;
  onClick?: () => void;
}

const briefTone = { bad: "text-fail", good: "text-pass", warn: "text-wait", accent: "text-brand" };

// Scrolls to a part of the page and lights it briefly, so a reader can see
// where each part of the summary comes from.
export function spotlight(id: string) {
  // A step that points into folded analysis opens it first, then lights it.
  if (revealFor(id)) {
    window.setTimeout(() => spotlight(id), 60);
    return;
  }
  const el = document.getElementById(id);
  if (!el) return;
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" });
  el.classList.remove("spotlight");
  void el.offsetWidth;
  el.classList.add("spotlight");
  window.setTimeout(() => el.classList.remove("spotlight"), 1800);
}

// The box at the top of every page: what the page says in one line, the
// figures that matter as switches, and a short guided walk through the page.
export function PageBrief({ lead, detail, stats, guide }: { lead: ReactNode; detail?: ReactNode; stats: BriefStat[]; guide?: { label: string; target: string }[] }) {
  const [step, setStep] = useState<number | null>(null);
  return (
    <section className="brief mb-6 overflow-hidden rounded-2xl border border-line bg-paper shadow-[0_1px_0_var(--color-line-soft)]" aria-label="Summary of this page">
      <div className="grid gap-x-8 gap-y-5 px-6 pt-6 pb-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <div className="min-w-0">
          <p className="display text-[27px] leading-[1.15] text-ink">{lead}</p>
          {detail && <p className="mt-2.5 text-[15px] leading-relaxed text-ink-2">{detail}</p>}
        </div>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
          {stats.map((s) => {
            const edge = s.tone === "bad" ? "before:bg-fail" : s.tone === "good" ? "before:bg-pass" : s.tone === "warn" ? "before:bg-highlight" : s.tone === "accent" ? "before:bg-brand" : "before:bg-line";
            const inner = (
              <>
                <span className={cx("amount block text-[28px] leading-8", s.tone ? briefTone[s.tone] : "text-ink")}>{s.value}</span>
                <span className="mt-1 block text-[14px] leading-snug font-medium text-ink-2">{s.label}</span>
              </>
            );
            const base = cx("relative rounded-xl border bg-paper py-3 pr-3 pl-4 text-left before:absolute before:inset-y-3 before:left-0 before:w-[3px] before:rounded-full", edge);
            return s.onClick ? (
              <button
                key={s.label}
                onClick={s.onClick}
                aria-pressed={s.active}
                title={s.hint}
                className={cx(
                  base,
                  "group transition-[border-color,box-shadow,transform] duration-150",
                  s.active ? "border-brand bg-brand-wash shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-brand)_18%,transparent)]" : "border-line-soft hover:-translate-y-0.5 hover:border-brand/50 hover:shadow-[0_8px_22px_rgba(12,58,43,0.10)] focus-visible:border-brand",
                )}
              >
                {inner}
                <span className={cx("absolute top-3 right-3 transition-opacity", s.active ? "text-brand opacity-100" : "text-ink-3 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100")} aria-hidden>
                  {s.active ? (
                    <Mark tone="good" size={15} draw />
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M6 3.5L10.5 8 6 12.5" />
                    </svg>
                  )}
                </span>
              </button>
            ) : (
              <div key={s.label} className={cx(base, "border-line-soft")} title={s.hint}>
                {inner}
              </div>
            );
          })}
        </div>
      </div>
      {guide && guide.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-2 border-t border-line-soft bg-wash px-6 py-3 text-[14px]">
          <span className="mr-2 font-semibold text-ink-2">Show me around</span>
          {guide.map((g, i) => (
            <button
              key={g.target}
              onClick={() => {
                setStep(i);
                spotlight(g.target);
              }}
              className={cx(
                "inline-flex items-center gap-2 rounded-full border py-1 pr-3 pl-1 transition-colors",
                step === i ? "border-brand bg-paper font-semibold text-ink" : "border-transparent text-ink-2 hover:border-line hover:bg-paper hover:text-ink",
              )}
            >
              <span className={cx("inline-flex h-5.5 w-5.5 items-center justify-center rounded-full text-[13px] font-bold", step === i ? "bg-brand text-on-brand" : "bg-line-soft text-ink-2")}>{i + 1}</span>
              {g.label}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- Ledger rows

export interface LedgerItem {
  key: string;
  // The status edge on the left of the row.
  rail: string;
  title: ReactNode;
  meta?: ReactNode;
  amount?: number;
  status?: ReactNode;
  group?: string;
  detail: ReactNode;
}

// Rows as a ruled ledger: a coloured edge for the status, the amount drawn
// as a bar against the largest in view, sticky group headings, and each row
// opening in place to show everything about it. Arrow keys move between rows.
export function LedgerRows({ items, format, empty, open: openKey, onToggle }: { items: LedgerItem[]; format?: (v: number) => string; empty?: ReactNode; open?: string | null; onToggle?: (key: string | null) => void }) {
  const [own, setOwn] = useState<string | null>(null);
  const open = openKey !== undefined ? openKey : own;
  const setOpen = (k: string | null) => (onToggle ? onToggle(k) : setOwn(k));
  const max = Math.max(1, ...items.map((i) => Math.abs(i.amount ?? 0)));
  const fmt = format ?? ((v: number) => `₹ ${money(v)}`);
  if (!items.length) return <>{empty ?? null}</>;

  const move = (e: RKeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const all = [...(e.currentTarget.closest("[data-ledger]")?.querySelectorAll<HTMLButtonElement>("[data-ledger-row]") ?? [])];
    const i = all.indexOf(e.currentTarget);
    all[Math.max(0, Math.min(all.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
  };

  let lastGroup: string | undefined;
  return (
    <div data-ledger className="relative">
      {items.map((it) => {
        const heading = it.group !== undefined && it.group !== lastGroup ? it.group : null;
        lastGroup = it.group;
        const isOpen = open === it.key;
        return (
          <div key={it.key}>
            {heading !== null && (
              <div className="sticky top-0 z-10 border-b border-line-soft bg-paper/95 px-5 pt-4 pb-2 text-[14px] font-bold text-ink-2 backdrop-blur-sm lg:top-0">{heading}</div>
            )}
            <div className={cx("relative border-b border-line-soft transition-colors", isOpen ? "bg-wash/70" : "")}>
              <span className="absolute inset-y-0 left-0 w-1" style={{ background: it.rail }} aria-hidden />
              <button
                data-ledger-row
                onClick={() => setOpen(isOpen ? null : it.key)}
                onKeyDown={move}
                aria-expanded={isOpen}
                className="group grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-5 gap-y-1 py-3 pr-4 pl-5 text-left transition-colors hover:bg-wash focus-visible:bg-wash focus-visible:outline-none sm:grid-cols-[minmax(0,1fr)_minmax(120px,200px)_auto_16px]"
              >
                <span className="min-w-0">
                  <span className="block truncate text-[14.5px] font-semibold text-ink">{it.title}</span>
                  {it.meta && <span className="block truncate text-[14px] text-ink-2">{it.meta}</span>}
                </span>
                <span className="hidden items-center gap-2 sm:flex">
                  {it.amount !== undefined && (
                    <>
                      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-line-soft">
                        <span className="block h-full rounded-full" style={{ width: `${(Math.abs(it.amount) / max) * 100}%`, background: it.rail, opacity: 0.85 }} />
                      </span>
                      <span className="num w-24 text-right text-[14px] font-semibold text-ink">{fmt(it.amount)}</span>
                    </>
                  )}
                </span>
                <span className="justify-self-end">{it.status}</span>
                <svg className={cx("hidden text-ink-3 transition-transform duration-200 sm:block", isOpen && "rotate-90")} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M6 3.5L10.5 8 6 12.5" />
                </svg>
              </button>
              {isOpen && <div className="view border-t border-line-soft px-5 py-4">{it.detail}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Every field of a record as a compact grid, for an opened ledger row.
export function FieldGrid({ fields }: { fields: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-x-6 gap-y-3 text-[14px]">
      {fields
        .filter(([, v]) => v !== undefined && v !== null && v !== "")
        .map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="text-[12.5px] font-medium text-ink-3">{k}</dt>
            <dd className="mt-0.5 break-words text-ink">{v}</dd>
          </div>
        ))}
    </dl>
  );
}

// ---------------------------------------------------------------- Email a report

interface EmailResult {
  sent: boolean;
  preview: boolean;
  message_id?: string;
  recipients?: string[];
  subject: string;
  text: string;
  reason?: string;
}

// A button that emails one report through send_report_email. It first says
// who will receive it and lets the sender add a note; nothing goes out until
// Send is pressed. The audience is fixed by the kind on the server.
export function EmailAction({
  kind,
  label,
  audience,
  what,
  args,
  disabledReason,
}: {
  kind: "findings_review" | "evidence_reminder" | "findings_memo";
  label: string;
  // Who receives it, in plain words, for the confirmation.
  audience: string;
  // What the email contains, in plain words.
  what: string;
  args?: Record<string, unknown>;
  disabledReason?: string;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [result, setResult] = useState<EmailResult | null>(null);
  const { busy, run } = useAction();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const send = () =>
    run("send", async () => {
      const r = await callTool<EmailResult>("send_report_email", { kind, note, ...(args ?? {}) });
      setResult(r);
      setNote("");
      if (r.sent) toast(`Email sent to ${r.recipients?.length ?? 0} ${(r.recipients?.length ?? 0) === 1 ? "recipient" : "recipients"}.`);
    });

  return (
    <span className="relative inline-flex">
      <span title={disabledReason}>
        <Button
          kind="ghost"
          disabled={!!disabledReason}
          onClick={() => {
            setResult(null);
            setOpen((o) => !o);
          }}
        >
          <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="2.5" y="4.5" width="15" height="11" rx="1.5" />
            <path d="M3 5.5l7 5.5 7-5.5" />
          </svg>
          {label}
        </Button>
      </span>
      {open && (
        <div role="dialog" aria-label={label} className="view absolute top-full right-0 z-40 mt-2 w-[min(420px,calc(100vw-2rem))] rounded-xl border border-line bg-paper p-5 text-left shadow-[0_20px_50px_rgba(6,21,15,0.25)]">
          {!result ? (
            <>
              <div className="text-sm font-semibold text-ink">{label}</div>
              <p className="mt-1 text-[14px] leading-relaxed text-ink-2">
                Sends {what} to <span className="font-medium text-ink">{audience}</span>, at the addresses set on the server. It states the snapshot hash and is recorded in the audit trail.
              </p>
              <textarea
                className="mt-3 h-auto min-h-16 w-full rounded-md border border-line bg-paper px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-3 focus:border-brand"
                placeholder="Add a note at the top of the email (optional)"
                maxLength={1000}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <div className="mt-3 flex justify-end gap-2">
                <Button kind="ghost" small onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button small busy={busy === "send"} onClick={send}>
                  Send
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className={cx("flex items-center gap-2 text-sm font-semibold", result.sent ? "text-pass" : "text-wait")}>
                <Mark tone={result.sent ? "good" : "warn"} size={15} />
                {result.sent ? `Sent to ${result.recipients?.length ?? 0} ${(result.recipients?.length ?? 0) === 1 ? "recipient" : "recipients"}` : "Preview only, nothing was sent"}
              </div>
              {result.reason && <p className="mt-1 text-xs text-ink-2">{result.reason}</p>}
              {result.message_id && <p className="mt-1 font-mono text-[12px] text-ink-3">Message {result.message_id}</p>}
              <div className="mt-3 rounded-md border border-line-soft bg-wash/60 p-3">
                <div className="text-[14px] font-medium text-ink">{result.subject}</div>
                <pre className="thin-scroll mt-2 max-h-56 overflow-auto font-sans text-xs leading-relaxed whitespace-pre-wrap text-ink-2">{result.text}</pre>
              </div>
              <div className="mt-3 flex justify-end">
                <Button kind="ghost" small onClick={() => setOpen(false)}>
                  Close
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </span>
  );
}

// ---------------------------------------------------------------- Simple and full views

// Simple view shows each page's summary, its main visual and its list; the
// other analysis folds into one bar per page that opens in place. Full view
// shows everything. The choice is kept per browser; folded groups reset on reload.
const DETAIL_KEY = "sanchay-detail";

interface DetailState {
  full: boolean;
  open: string[];
}

let detail: DetailState = {
  full: (() => {
    try {
      return localStorage.getItem(DETAIL_KEY) === "full";
    } catch {
      return false;
    }
  })(),
  open: [],
};
const detailSubs = new Set<() => void>();

function applyDetail() {
  const html = document.documentElement;
  html.dataset.detail = detail.full ? "full" : "simple";
  html.dataset.open = detail.open.join(" ");
  detailSubs.forEach((f) => f());
}
if (typeof document !== "undefined") applyDetail();

export function setFullDetail(full: boolean) {
  detail = { ...detail, full };
  try {
    localStorage.setItem(DETAIL_KEY, full ? "full" : "simple");
  } catch {
    /* the choice just lasts for this visit */
  }
  applyDetail();
}

export function openGroup(group: string, open?: boolean) {
  const has = detail.open.includes(group);
  const want = open ?? !has;
  if (want === has) return;
  detail = { ...detail, open: want ? [...detail.open, group] : detail.open.filter((g) => g !== group) };
  applyDetail();
}

export function useDetail(): DetailState {
  return useSyncExternalStore(
    (f) => {
      detailSubs.add(f);
      return () => detailSubs.delete(f);
    },
    () => detail,
  );
}

// The bar that stands in for a page's folded analysis in simple view.
export function MoreBar({ group, title, items }: { group: string; title: string; items: string }) {
  const d = useDetail();
  if (d.full) return null;
  const open = d.open.includes(group);
  return (
    <button
      onClick={() => openGroup(group)}
      aria-expanded={open}
      className={cx(
        "group mb-5 flex w-full items-center gap-4 rounded-xl border px-5 py-3.5 text-left transition-colors",
        open ? "border-line bg-paper" : "border-line bg-wash hover:border-brand/50 hover:bg-paper",
      )}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-wash text-brand">
        <svg className={cx("transition-transform duration-200", open && "rotate-180")} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M3.5 6l4.5 4.5L12.5 6" />
        </svg>
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-bold text-ink">{open ? `Hide ${title.toLowerCase()}` : title}</span>
        <span className="block text-[14px] text-ink-2">{items}</span>
      </span>
      <span className="hidden text-[14px] font-semibold text-brand sm:block">{open ? "Hide" : "Show"}</span>
    </button>
  );
}

// Opens the folded group an element sits in, so a guided step can reach it.
function revealFor(id: string): boolean {
  const el = document.getElementById(id);
  const group = el?.closest<HTMLElement>("[data-more]")?.dataset.more;
  if (!group || detail.full || detail.open.includes(group)) return false;
  openGroup(group, true);
  return true;
}
