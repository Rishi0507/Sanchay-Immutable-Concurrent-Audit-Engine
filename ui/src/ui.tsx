// Shared building blocks. Screens are tables, short statuses and counts;
// detail opens in a side panel so the list stays in view (PRD section 20.1).

import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, callTool } from "./api";
import { NoteBand } from "./print";

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

export type Tone = "neutral" | "accent" | "good" | "warn" | "bad" | "rp";

const tagTones: Record<Tone, string> = {
  neutral: "bg-wash text-ink-2",
  accent: "bg-brand-wash text-brand",
  good: "bg-pass-wash text-pass",
  warn: "bg-wait-wash text-wait",
  bad: "bg-fail-wash text-fail",
  rp: "bg-rp-wash text-rp",
};

// A tag names a category: a severity, a sheet, a role.
export function Chip({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cx("inline-flex items-center rounded-full px-2 py-0.5 text-[12.5px] font-semibold whitespace-nowrap", tagTones[tone])}>
      {children}
    </span>
  );
}

export function toneFor(value?: string | null): Tone {
  switch ((value ?? "").toLowerCase()) {
    case "high":
    case "exception":
    case "rejected":
    case "failed":
    case "changed after testing":
      return "bad";
    case "medium":
    case "pending":
    case "pending evidence":
    case "needs_info":
    case "needs human review":
    case "ready":
    case "proposed":
      return "warn";
    case "pass":
    case "ok":
    case "done":
    case "confirmed":
    case "received":
    case "verified":
    case "matched":
      return "good";
    case "related party":
      return "rp";
    default:
      return "neutral";
  }
}

const statusText: Record<Tone, string> = {
  neutral: "text-ink-2",
  accent: "text-brand",
  good: "text-pass",
  warn: "text-wait",
  bad: "text-fail",
  rp: "text-rp",
};

// A status says how something stands, in the auditor's own pen: a tick for
// pass, a cross for an exception, a ring round something still open. The mark
// is read before the word, the way a tick mark is on a workpaper.
export function Status({ tone, children, draw }: { tone: Tone; children: ReactNode; draw?: boolean }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 text-[14px] font-semibold whitespace-nowrap", statusText[tone])}>
      <Mark tone={tone} size={16} draw={draw} />
      {children}
    </span>
  );
}

// The Sanchay emblem. On the dark theme it stands on a paper tile (logo-ground
// in index.css), because it is drawn in dark green.
export function BrandMark({ size = 28 }: { size?: number }) {
  return <img src="/logo-mark.png" alt="" width={size} height={size} className="logo-ground shrink-0 rounded-[22%]" />;
}

// Pen strokes, drawn freehand in a 16 by 16 box. With `draw` the pen moves
// once, when the mark first appears.
const strokes: Record<"good" | "bad" | "warn", string[]> = {
  good: ["M2.4 8.9c1.3 1 2.4 2.3 3.3 3.8C7.6 8.9 10 6 13.6 3.6"],
  bad: ["M3.8 3.7c2.7 2.7 5.5 5.7 8.4 8.8", "M12.4 3.5c-3 2.6-5.7 5.5-8.5 8.9"],
  warn: ["M8.6 3c2.8.1 4.6 2.2 4.5 5-.1 2.8-2.3 4.9-5 4.9C5.3 12.9 3 10.8 3 8 3 5.1 5.3 3 8.4 3.2"],
};

export function Mark({ tone, size = 14, draw }: { tone: Tone; size?: number; draw?: boolean }) {
  const key = tone === "good" ? "good" : tone === "bad" ? "bad" : tone === "warn" ? "warn" : null;
  if (!key)
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
        <circle cx="8" cy="8" r="2.2" fill="currentColor" />
      </svg>
    );
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={key === "warn" ? 1.7 : 2.1} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {strokes[key].map((d, i) => (
        <path key={i} d={d} pathLength={1} className={draw ? "ink-draw" : undefined} style={draw && i ? { animationDelay: "0.25s" } : undefined} />
      ))}
    </svg>
  );
}

export function Button({
  children,
  onClick,
  kind = "primary",
  disabled,
  busy,
  small,
}: {
  children: ReactNode;
  onClick?: () => void;
  kind?: "primary" | "ghost" | "danger";
  disabled?: boolean;
  busy?: boolean;
  small?: boolean;
}) {
  const styles = {
    primary: "bg-brand text-on-brand shadow-[inset_0_-2px_0_rgba(0,0,0,0.18)] hover:bg-brand-deep active:translate-y-px",
    ghost: "bg-paper text-ink border border-line hover:border-brand/50 hover:bg-brand-wash/50",
    danger: "bg-paper text-fail border border-fail/40 hover:bg-fail-wash",
  }[kind];
  return (
    <button
      onClick={onClick}
      disabled={disabled || busy}
      className={cx(
        "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg font-semibold transition-[background-color,border-color,transform] duration-150 disabled:opacity-45 disabled:pointer-events-none",
        small ? "h-8 px-3 text-[13px]" : "h-10 px-4 text-[15px]",
        styles,
      )}
    >
      {busy && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
      {children}
    </button>
  );
}

// A page of the file: white on the green desk, with a hairline edge.
export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("rounded-xl border border-line bg-paper shadow-[0_1px_0_var(--color-line-soft)]", className)}>{children}</div>;
}

// Every client page opens with its note band (print.tsx).
export function Header({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return <NoteBand title={title} summary={hint} action={action} />;
}

export function Pills<T extends string>({ options, value, onChange }: { options: { value: T; label: string; count?: number }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex flex-wrap rounded-lg border border-line bg-wash p-1">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={cx(
            "h-8 rounded-md px-3 text-[14px] font-semibold transition-colors duration-150",
            value === o.value ? "bg-paper text-brand shadow-[0_0_0_1px_var(--color-line),0_1px_2px_rgba(0,0,0,0.06)]" : "text-ink-2 hover:text-ink",
          )}
        >
          {o.label}
          {o.count !== undefined && <span className="ml-1.5 text-xs text-ink-3 tabular-nums">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

export interface Column<T> {
  key: string;
  label: string;
  align?: "left" | "right";
  render: (row: T) => ReactNode;
  width?: string;
}

export function Table<T>({
  columns,
  rows,
  onRow,
  rowKey,
  selected,
  marked,
}: {
  columns: Column<T>[];
  rows: T[];
  onRow?: (row: T) => void;
  rowKey: (row: T, i: number) => string;
  selected?: string;
  // Rows that need attention get the highlighter.
  marked?: (row: T) => boolean;
}) {
  return (
    <div className="thin-scroll overflow-x-auto">
      <table className="w-full text-[14px]">
        <thead>
          <tr className="border-b border-line bg-wash text-left text-[12.5px] text-ink-2">
            {columns.map((c) => (
              <th key={c.key} className={cx("px-4 py-2.5 font-semibold whitespace-nowrap", c.align === "right" && "text-right")} style={{ width: c.width }}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const key = rowKey(row, i);
            const isMarked = marked?.(row) ?? false;
            return (
              <tr
                key={key}
                onClick={onRow ? () => onRow(row) : undefined}
                className={cx(
                  "border-b border-line-soft last:border-0 transition-colors duration-100",
                  isMarked && "bg-mark",
                  onRow && (isMarked ? "cursor-pointer hover:bg-mark-hover" : "cursor-pointer hover:bg-wash"),
                  selected === key && "bg-brand-wash hover:bg-brand-wash",
                )}
              >
                {columns.map((c) => (
                  <td key={c.key} className={cx("px-4 py-3 align-middle", c.align === "right" && "text-right tabular-nums")}>
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function Empty({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="px-6 py-14 text-center">
      <svg className="mx-auto mb-3 text-line" width="44" height="44" viewBox="0 0 44 44" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
        <rect x="8" y="5" width="28" height="34" rx="3" />
        <path d="M14 14h16M14 20h16M14 26h10" />
      </svg>
      <div className="text-[16px] font-semibold text-ink">{title}</div>
      {hint && <div className="mx-auto mt-1 max-w-md text-[14px] text-ink-2">{hint}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Loading() {
  return (
    <div className="flex items-center justify-center py-14">
      <span className="h-6 w-6 animate-spin rounded-full border-[3px] border-line border-t-brand" />
    </div>
  );
}

export function ErrorNote({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  const api = error instanceof ApiError ? error : null;
  const offline = api?.code === "ENGINE_UNAVAILABLE" || api?.code === "LEDGER_UNAVAILABLE";
  return (
    <Empty
      title={offline ? (api?.code === "ENGINE_UNAVAILABLE" ? "The audit engine is not running" : "The ledger is not running") : error.message}
      hint={offline ? "Start the service, then retry." : api?.nextStep}
      action={
        onRetry && (
          <Button kind="ghost" small onClick={onRetry}>
            Retry
          </Button>
        )
      }
    />
  );
}

export function Drawer({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="scrim absolute inset-0 bg-[#06150f]/45 backdrop-blur-[2px]" onClick={onClose} />
      <aside className="drawer relative flex h-full w-full max-w-xl flex-col border-l border-line bg-paper shadow-[-16px_0_40px_rgba(0,0,0,0.28)]">
        <div className="flex items-center justify-between gap-4 border-b border-line bg-wash px-6 py-4">
          <div className="min-w-0 truncate text-[17px] font-bold">{title}</div>
          <button onClick={onClose} className="rounded-md p-1.5 text-ink-3 transition-colors hover:bg-wash hover:text-ink" aria-label="Close panel">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <div className="thin-scroll flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer && <div className="border-t border-line px-6 py-4">{footer}</div>}
      </aside>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-semibold text-ink-2">{label}</span>
      {children}
    </label>
  );
}

export const inputClass =
  "h-10 w-full rounded-lg border border-line bg-paper px-3 text-[15px] text-ink outline-none transition-colors placeholder:text-ink-3 hover:border-ink-3 focus:border-brand focus:ring-[3px] focus:ring-brand/15";

export function KeyValues({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(120px,auto)_1fr] gap-x-5 gap-y-2.5 text-[14px]">
      {items
        .filter(([, v]) => v !== undefined && v !== null && v !== "")
        .map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-ink-2 first-letter:uppercase">{k}</dt>
            <dd className="min-w-0 break-words text-ink">{v}</dd>
          </div>
        ))}
    </dl>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-7">
      <h3 className="mb-3 border-b border-line-soft pb-2 text-[14px] font-bold text-ink first-letter:uppercase">{title}</h3>
      {children}
    </section>
  );
}

// Loads a tool result and reloads when the dependencies change.
export function useTool<T = any>(name: string | null, args: Record<string, unknown> = {}, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState<boolean>(!!name);
  const seq = useRef(0);
  const argsKey = JSON.stringify(args);

  const reload = useCallback(async () => {
    if (!name) return;
    const mine = ++seq.current;
    setLoading(true);
    try {
      const result = await callTool<T>(name, JSON.parse(argsKey));
      if (mine === seq.current) {
        setData(result);
        setError(null);
      }
    } catch (e) {
      if (mine === seq.current) setError(e as Error);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, argsKey]);

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload, ...deps]);

  return { data, error, loading, reload };
}

// Runs an action with a busy flag and surfaces its error as a toast.
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      const api = e instanceof ApiError ? e : null;
      toast(api ? `${api.message}${api.nextStep ? " " + api.nextStep : ""}` : (e as Error).message, "bad");
    } finally {
      setBusy(null);
    }
  }, []);
  return { busy, run };
}

type ToastItem = { id: number; text: string; tone: Tone };
let pushToast: ((t: ToastItem) => void) | null = null;
let toastId = 0;

export function toast(text: string, tone: Tone = "good") {
  pushToast?.({ id: ++toastId, text, tone });
}

export function Toasts() {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => {
    pushToast = (t) => {
      setItems((prev) => [...prev, t]);
      setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== t.id)), 5200);
    };
    return () => {
      pushToast = null;
    };
  }, []);
  return (
    <div className="pointer-events-none fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className="view pointer-events-auto flex max-w-lg items-start gap-3 rounded-xl bg-spine px-4 py-3 text-[14px] font-medium text-spine-ink shadow-[0_18px_40px_rgba(6,21,15,0.35)]">
          <span className={cx("mt-0.5", t.tone === "bad" ? "text-[#ff8a70]" : "text-highlight")}>
            <Mark tone={t.tone === "bad" ? "bad" : "good"} size={17} draw />
          </span>
          {t.text}
        </div>
      ))}
    </div>
  );
}
