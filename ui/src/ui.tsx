// Shared building blocks. Screens are tables, chips and counts; detail opens
// in a side panel so the list stays in view (PRD section 20.1).

import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, callTool } from "./api";

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

type Tone = "neutral" | "accent" | "good" | "warn" | "bad";

const tones: Record<Tone, string> = {
  neutral: "bg-slate-100 text-slate-600",
  accent: "bg-indigo-50 text-indigo-700",
  good: "bg-emerald-50 text-emerald-700",
  warn: "bg-amber-50 text-amber-700",
  bad: "bg-rose-50 text-rose-700",
};

export function Chip({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cx("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap", tones[tone])}>
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
    case "low":
    case "blocked":
      return "neutral";
    case "pass":
    case "ok":
    case "done":
    case "confirmed":
    case "received":
    case "verified":
    case "matched":
      return "good";
    case "related party":
      return "accent";
    default:
      return "neutral";
  }
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
    primary: "bg-indigo-600 text-white hover:bg-indigo-500 shadow-sm",
    ghost: "bg-white text-slate-700 border border-slate-200 hover:bg-slate-50",
    danger: "bg-white text-rose-700 border border-rose-200 hover:bg-rose-50",
  }[kind];
  return (
    <button
      onClick={onClick}
      disabled={disabled || busy}
      className={cx(
        "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium transition-all duration-150 active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none",
        small ? "px-3 py-1.5 text-xs" : "px-4 py-2 text-sm",
        styles,
      )}
    >
      {busy && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
      {children}
    </button>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]", className)}>{children}</div>;
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: Tone }) {
  return (
    <Card className="px-5 py-4">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={cx("mt-1 text-2xl font-semibold tabular-nums", tone === "bad" && "text-rose-600", tone === "warn" && "text-amber-600", tone === "good" && "text-emerald-600")}>
        {value}
      </div>
    </Card>
  );
}

export function Header({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="mb-5 flex items-end justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {hint && <p className="mt-0.5 text-sm text-slate-500">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

export function Pills<T extends string>({ options, value, onChange }: { options: { value: T; label: string; count?: number }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex flex-wrap gap-1 rounded-xl bg-slate-100 p-1">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            "rounded-lg px-3 py-1.5 text-sm font-medium transition-all duration-150",
            value === o.value ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800",
          )}
        >
          {o.label}
          {o.count !== undefined && <span className="ml-1.5 text-xs text-slate-400 tabular-nums">{o.count}</span>}
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

export function Table<T>({ columns, rows, onRow, rowKey, selected }: { columns: Column<T>[]; rows: T[]; onRow?: (row: T) => void; rowKey: (row: T, i: number) => string; selected?: string }) {
  return (
    <div className="thin-scroll overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
            {columns.map((c) => (
              <th key={c.key} className={cx("px-4 py-3 font-medium whitespace-nowrap", c.align === "right" && "text-right")} style={{ width: c.width }}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const key = rowKey(row, i);
            return (
              <tr
                key={key}
                onClick={onRow ? () => onRow(row) : undefined}
                className={cx("border-b border-slate-100 last:border-0 transition-colors", onRow && "cursor-pointer hover:bg-slate-50", selected === key && "bg-indigo-50/60")}
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
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="mb-3 h-10 w-10 rounded-full bg-slate-100" />
      <div className="text-sm font-medium text-slate-700">{title}</div>
      {hint && <div className="mt-1 max-w-md text-sm text-slate-500">{hint}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Loading() {
  return (
    <div className="flex items-center justify-center py-16">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-indigo-600" />
    </div>
  );
}

export function ErrorNote({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  const api = error instanceof ApiError ? error : null;
  const offline = api?.code === "ENGINE_UNAVAILABLE" || api?.code === "LEDGER_UNAVAILABLE";
  return (
    <Empty
      title={offline ? (api?.code === "ENGINE_UNAVAILABLE" ? "The audit engine is not running" : "The ledger is not running") : error.message}
      hint={offline ? "Start the service and retry." : api?.nextStep}
      action={onRetry && <Button kind="ghost" small onClick={onRetry}>Retry</Button>}
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
      <div className="scrim absolute inset-0 bg-slate-900/20 backdrop-blur-[1px]" onClick={onClose} />
      <aside className="drawer relative flex h-full w-full max-w-xl flex-col border-l border-slate-200 bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <div className="min-w-0 text-base font-semibold">{title}</div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700" aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        <div className="thin-scroll flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer && <div className="border-t border-slate-200 px-6 py-4">{footer}</div>}
      </aside>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">{label}</span>
      {children}
    </label>
  );
}

export const inputClass =
  "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none transition-shadow focus:border-indigo-400 focus:ring-4 focus:ring-indigo-100";

export function KeyValues({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(110px,auto)_1fr] gap-x-4 gap-y-2 text-sm">
      {items
        .filter(([, v]) => v !== undefined && v !== null && v !== "")
        .map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-slate-500">{k}</dt>
            <dd className="min-w-0 break-words text-slate-800">{v}</dd>
          </div>
        ))}
    </dl>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-6">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
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
    <div className="pointer-events-none fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
      {items.map((t) => (
        <div key={t.id} className={cx("view pointer-events-auto max-w-lg rounded-xl px-4 py-2.5 text-sm shadow-lg", t.tone === "bad" ? "bg-rose-600 text-white" : "bg-slate-900 text-white")}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
