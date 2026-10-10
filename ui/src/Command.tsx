// The command palette: Ctrl+K (or /) opens it anywhere. One box finds a page,
// an action or a finding by its words, so nobody has to learn where things live.

import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { callTool } from "./api";
import { cx } from "./ui";

export interface CommandItem {
  id: string;
  group: "Go to" | "Do" | "Findings";
  label: string;
  hint?: string;
  icon?: ReactNode;
  run: () => void;
}

interface FindingHit {
  finding_id: string;
  title: string;
  severity: string;
  category: string;
}

const sevDot: Record<string, string> = { High: "bg-fail", Medium: "bg-highlight", Low: "bg-ink-3" };

export function CommandPalette({
  onClose,
  items,
  findings,
  onFinding,
}: {
  onClose: () => void;
  items: CommandItem[];
  // When set, findings of the engagement are searched as well.
  findings: boolean;
  onFinding: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [hits, setHits] = useState<FindingHit[] | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  // Mounted fresh each time it opens, so the box starts empty. Findings are
  // read then, so one raised a minute ago is there.
  useEffect(() => {
    if (!findings) return;
    callTool<{ findings: FindingHit[] }>("get_findings", { limit: 500 })
      .then((r) => setHits(r.findings ?? []))
      .catch(() => setHits([]));
  }, [findings]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const match = (text: string) => words.every((w) => text.toLowerCase().includes(w));
    const base = items.filter((i) => match(`${i.group} ${i.label} ${i.hint ?? ""}`));
    const found: CommandItem[] =
      findings && words.length
        ? (hits ?? [])
            .filter((f) => match(`${f.title} ${f.finding_id} ${f.category}`))
            .slice(0, 8)
            .map((f) => ({
              id: `f:${f.finding_id}`,
              group: "Findings" as const,
              label: f.title,
              hint: `${f.severity} severity`,
              icon: <span className={cx("h-2.5 w-2.5 rounded-full", sevDot[f.severity] ?? "bg-ink-3")} />,
              run: () => onFinding(f.finding_id),
            }))
        : [];
    return [...base, ...found];
  }, [query, items, hits, findings, onFinding]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (i: number) => {
    const item = shown[i];
    if (!item) return;
    onClose();
    item.run();
  };

  let lastGroup = "";
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]" role="dialog" aria-modal="true" aria-label="Search and jump">
      <div className="scrim absolute inset-0 bg-[#06150f]/50 backdrop-blur-[3px]" onClick={onClose} />
      <div className="view relative w-full max-w-[620px] overflow-hidden rounded-2xl border border-line bg-paper shadow-[0_30px_80px_rgba(6,21,15,0.45)]">
        <div className="flex items-center gap-3 border-b border-line px-5">
          <svg className="shrink-0 text-brand" width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5L14 14" />
          </svg>
          <input
            ref={input}
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(shown.length - 1, a + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                choose(active);
              }
            }}
            placeholder={findings ? "Find a page, an action or a finding" : "Find a page or an action"}
            className="h-16 w-full bg-transparent text-[18px] text-ink outline-none placeholder:text-ink-3"
            aria-label="Search"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-list"
          />
          <kbd>Esc</kbd>
        </div>
        <ul ref={list} id="command-list" role="listbox" className="thin-scroll max-h-[min(60vh,440px)] overflow-y-auto p-2">
          {shown.length === 0 && <li className="px-4 py-8 text-center text-[15px] text-ink-2">Nothing matches "{query}". Try a page name, such as findings, or words from a finding's title.</li>}
          {shown.map((item, i) => {
            const heading = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            return (
              <li key={item.id} role="presentation">
                {heading && <div className="px-3 pt-3 pb-1.5 text-[12.5px] font-bold text-ink-3">{heading}</div>}
                <button
                  data-i={i}
                  role="option"
                  aria-selected={i === active}
                  onMouseMove={() => setActive(i)}
                  onClick={() => choose(i)}
                  className={cx("flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left", i === active ? "bg-brand-wash text-ink" : "text-ink")}
                >
                  <span className={cx("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", i === active ? "bg-brand text-on-brand" : "bg-wash text-ink-2")}>{item.icon}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-semibold">{item.label}</span>
                    {item.hint && <span className="block truncate text-[13px] text-ink-2">{item.hint}</span>}
                  </span>
                  {i === active && <kbd>Enter</kbd>}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="flex items-center gap-4 border-t border-line-soft bg-wash px-5 py-2.5 text-[13px] text-ink-2">
          <span className="inline-flex items-center gap-1.5">
            <kbd>↑</kbd>
            <kbd>↓</kbd> to move
          </span>
          <span className="inline-flex items-center gap-1.5">
            <kbd>Enter</kbd> to open
          </span>
          <span className="ml-auto inline-flex items-center gap-1.5">
            <kbd>Ctrl</kbd>
            <kbd>K</kbd> opens this anywhere
          </span>
        </div>
      </div>
    </div>
  );
}
