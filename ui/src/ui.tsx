// Shared building blocks. Screens are tables, short statuses and counts;
// detail opens in a side panel so the list stays in view (PRD section 20.1).

import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, callTool } from "./api";

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
    <span title={title} className={cx("inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap", tagTones[tone])}>
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

// A status says how something stands: a tick for pass, a cross for an
// exception, a ring for something still open. The mark is read before the
// word, the way a tick mark is on a workpaper.
export function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 text-[13px] font-medium whitespace-nowrap", statusText[tone])}>
      <Mark tone={tone} />
      {children}
    </span>
  );
}

export function Mark({ tone, size = 14 }: { tone: Tone; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (tone === "good")
    return (
      <svg {...common}>
        <path d="M3 8.5l3.2 3.2L13 4.8" />
      </svg>
    );
  if (tone === "bad")
    return (
      <svg {...common}>
        <path d="M4 4l8 8M12 4l-8 8" />
      </svg>
    );
  if (tone === "warn")
    return (
      <svg {...common} strokeWidth={1.8}>
        <circle cx="8" cy="8" r="5" />
      </svg>
    );
  return (
    <svg {...common}>
      <circle cx="8" cy="8" r="2" fill="currentColor" stroke="none" />
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
    primary: "bg-brand text-on-brand hover:bg-brand-deep",
    ghost: "bg-paper text-ink border border-line hover:bg-wash",
    danger: "bg-paper text-fail border border-line hover:bg-fail-wash",
  }[kind];
  return (
    <button
      onClick={onClick}
      disabled={disabled || busy}
      className={cx(
        "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-colors duration-150 disabled:opacity-45 disabled:pointer-events-none",
        small ? "h-7 px-2.5 text-xs" : "h-9 px-3.5 text-sm",
        styles,
      )}
    >
      {busy && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
      {children}
    </button>
  );
}

// A bordered surface. No shadow: the hairline is enough on a white page.
export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("rounded-lg border border-line bg-paper", className)}>{children}</div>;
}

export function Header({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <h1 className="serif text-[28px] leading-8 font-[450] tracking-[-0.015em]">{title}</h1>
        {hint && <p className="mt-1 text-sm text-ink-2">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

export function Pills<T extends string>({ options, value, onChange }: { options: { value: T; label: string; count?: number }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex flex-wrap rounded-md border border-line bg-wash p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={cx(
            "h-8 rounded-[5px] px-3 text-sm font-medium transition-colors duration-150",
            value === o.value ? "bg-paper text-ink shadow-[0_0_0_1px_var(--color-line)]" : "text-ink-2 hover:text-ink",
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
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-line text-left text-xs text-ink-2">
            {columns.map((c) => (
              <th key={c.key} className={cx("px-4 py-2.5 font-medium whitespace-nowrap", c.align === "right" && "text-right")} style={{ width: c.width }}>
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
                  <td key={c.key} className={cx("px-4 py-2.5 align-middle", c.align === "right" && "text-right tabular-nums")}>
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
      <div className="text-sm font-medium text-ink">{title}</div>
      {hint && <div className="mx-auto mt-1 max-w-md text-sm text-ink-2">{hint}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Loading() {
  return (
    <div className="flex items-center justify-center py-14">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-line border-t-brand" />
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
      <div className="scrim absolute inset-0 bg-black/45" onClick={onClose} />
      <aside className="drawer relative flex h-full w-full max-w-xl flex-col border-l border-line bg-paper shadow-[-16px_0_40px_rgba(0,0,0,0.28)]">
        <div className="flex items-center justify-between gap-4 border-b border-line px-6 py-4">
          <div className="min-w-0 truncate text-base font-semibold">{title}</div>
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
      <span className="mb-1.5 block text-xs font-medium text-ink-2">{label}</span>
      {children}
    </label>
  );
}

export const inputClass =
  "h-9 w-full rounded-md border border-line bg-paper px-3 text-sm text-ink outline-none transition-colors placeholder:text-ink-3 hover:border-ink-3 focus:border-brand focus:ring-2 focus:ring-brand/15";

export function KeyValues({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(120px,auto)_1fr] gap-x-5 gap-y-2 text-[13px]">
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
      <h3 className="mb-2.5 border-b border-line-soft pb-1.5 text-[13px] font-semibold text-ink first-letter:uppercase">{title}</h3>
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
        <div key={t.id} className="view pointer-events-auto flex max-w-lg items-start gap-2.5 rounded-md border border-line bg-wash px-3.5 py-2.5 text-sm text-ink shadow-xl">
          <span className={cx("mt-0.5", t.tone === "bad" ? "text-fail" : "text-pass")}>
            <Mark tone={t.tone === "bad" ? "bad" : "good"} />
          </span>
          {t.text}
        </div>
      ))}
    </div>
  );
}
