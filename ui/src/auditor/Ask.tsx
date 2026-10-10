// The audit assistant: a small panel that stays over every auditor screen.
// It answers from the records of the engagement in view, names the record
// behind each statement, and opens that record when its source is clicked.

import { FormEvent, ReactNode, useEffect, useRef, useState } from "react";
import { ApiError, callTool } from "../api";
import { BrandMark, Chip } from "../ui";

interface Source {
  n: number;
  kind: string;
  title: string;
  text: string;
  tab: string;
  focus?: string | null;
}

interface Answer {
  answer: string;
  mode: "model" | "records" | "none";
  sources: Source[];
  checks: { figures: number; traced: number; withheld: number };
  note: string;
  tokens: number;
}

interface Turn {
  question: string;
  reply?: Answer;
  error?: string;
}

const kindLabel: Record<string, string> = { figures: "Figures", area: "Area", finding: "Finding", sample: "Sample", party: "Party", guide: "Guide" };

const starters = ["How many findings are High?", "Which are the largest findings?", "Were any documents forged?", "कितने उच्च निष्कर्ष हैं?"];

// The answer with each source number as a small button.
function Cited({ text, sources, onOpen }: { text: string; sources: Source[]; onOpen: (s: Source) => void }) {
  const parts: ReactNode[] = [];
  text.split(/(\[\d+(?:,\s*\d+)*\])/).forEach((piece, i) => {
    if (!/^\[\d/.test(piece)) {
      parts.push(piece);
      return;
    }
    for (const n of piece.slice(1, -1).split(",").map((x) => Number(x.trim()))) {
      const s = sources.find((x) => x.n === n);
      if (!s) continue;
      parts.push(
        <button key={`${i}-${n}`} onClick={() => onOpen(s)} title={s.title} className="mx-0.5 inline-flex h-4 min-w-4 -translate-y-px items-center justify-center rounded bg-brand-wash px-1 text-[10px] font-semibold text-brand transition-colors hover:bg-brand hover:text-on-brand">
          {n}
        </button>,
      );
    }
  });
  return <>{parts}</>;
}

function Reply({ reply, onOpen }: { reply: Answer; onOpen: (s: Source) => void }) {
  const { checks } = reply;
  return (
    <div className="space-y-2.5">
      <div className="space-y-2 text-sm leading-relaxed text-ink">
        {reply.answer.split("\n").map((line, i) => (
          <p key={i}>
            <Cited text={line} sources={reply.sources} onOpen={onOpen} />
          </p>
        ))}
      </div>
      {reply.sources.length > 0 && (
        <ul className="space-y-1">
          {reply.sources.map((s) => (
            <li key={s.n}>
              <button
                onClick={() => onOpen(s)}
                disabled={!s.tab}
                title={s.text}
                className="group flex w-full items-center gap-2 rounded-md border border-line-soft px-2 py-1.5 text-left text-xs transition-colors enabled:hover:border-brand/50 enabled:hover:bg-wash"
              >
                <span className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded bg-brand-wash px-1 text-[10px] font-semibold text-brand">{s.n}</span>
                <span className="shrink-0 text-ink-3">{kindLabel[s.kind] ?? s.kind}</span>
                <span className="min-w-0 flex-1 truncate text-ink-2 group-enabled:group-hover:text-ink">{s.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {reply.mode !== "none" && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
          <Chip tone={reply.mode === "model" ? "accent" : "neutral"}>{reply.mode === "model" ? "Worded by the model" : "Straight from the records"}</Chip>
          {checks.withheld > 0 ? (
            <span className="text-wait">{checks.withheld === 1 ? "1 sentence withheld: its figure" : `${checks.withheld} sentences withheld: their figures`} could not be traced</span>
          ) : checks.figures > 0 ? (
            <span className="text-pass">All {checks.figures} figures traced to the records</span>
          ) : null}
          {reply.tokens > 0 && <span>{reply.tokens.toLocaleString("en-IN")} tokens</span>}
        </div>
      )}
      {reply.note && <p className="text-xs text-ink-3">{reply.note}</p>}
    </div>
  );
}

export default function Ask({ engagementId, goTo }: { engagementId: string; goTo: (tab: string, focus?: string) => void }) {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  // A conversation belongs to one engagement.
  useEffect(() => setTurns([]), [engagementId]);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [turns, busy, open]);

  const ask = async (question: string) => {
    question = question.trim();
    if (!question || busy) return;
    const previous = turns[turns.length - 1]?.question;
    setDraft("");
    setBusy(true);
    setTurns((t) => [...t, { question }]);
    let turn: Turn;
    try {
      turn = { question, reply: await callTool<Answer>("ask_assistant", { question, previous_question: previous }) };
    } catch (e) {
      turn = { question, error: e instanceof ApiError ? e.message : "The assistant could not be reached." };
    }
    setTurns((t) => [...t.slice(0, -1), turn]);
    setBusy(false);
  };

  // A source opens on the screen behind, so the panel steps aside and keeps the conversation.
  const openSource = (s: Source) => {
    if (!s.tab) return;
    goTo(s.tab, s.focus ?? undefined);
    setOpen(false);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    ask(draft);
  };

  if (!open)
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed right-5 bottom-5 z-30 inline-flex h-11 items-center gap-2 rounded-full border border-line bg-paper pr-4 pl-2 text-sm font-medium text-ink shadow-[0_8px_28px_rgba(0,0,0,0.22)] transition-colors hover:border-brand"
        aria-label="Ask a question about this audit"
      >
        <BrandMark size={28} />
        Ask
        {turns.length > 0 && <span className="h-1.5 w-1.5 rounded-full bg-brand" />}
      </button>
    );

  return (
    <section role="dialog" aria-label="Audit assistant" className="view fixed inset-0 z-30 flex flex-col border-line bg-paper sm:inset-auto sm:right-5 sm:bottom-5 sm:h-[min(640px,calc(100vh-40px))] sm:w-[420px] sm:rounded-xl sm:border sm:shadow-[0_16px_48px_rgba(0,0,0,0.3)]">
      <header className="flex items-center gap-2.5 border-b border-line px-4 py-3">
        <BrandMark size={26} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-ink">Ask Sanchay</div>
          <div className="truncate text-xs text-ink-3">Answers only from this audit's records</div>
        </div>
        {turns.length > 0 && (
          <button onClick={() => setTurns([])} className="text-xs font-medium text-ink-3 transition-colors hover:text-ink">
            Clear
          </button>
        )}
        <button onClick={() => setOpen(false)} className="rounded-md p-1.5 text-ink-3 transition-colors hover:bg-wash hover:text-ink" aria-label="Close the assistant">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </header>

      <div className="thin-scroll flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {turns.length === 0 && (
          <div className="flex h-full flex-col justify-end gap-2">
            <p className="mb-1 text-sm text-ink-2">Ask in English, Hindi or Marathi.</p>
            {starters.map((q) => (
              <button key={q} onClick={() => ask(q)} className="rounded-md border border-line px-3 py-2 text-left text-sm text-ink transition-colors hover:border-brand hover:bg-wash">
                {q}
              </button>
            ))}
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className="space-y-2.5">
            <div className="ml-auto w-fit max-w-[85%] rounded-lg bg-brand-wash px-3 py-2 text-sm text-ink">{t.question}</div>
            {t.reply && <Reply reply={t.reply} onOpen={openSource} />}
            {t.error && <p className="text-sm text-fail">{t.error}</p>}
            {!t.reply && !t.error && (
              <div className="flex items-center gap-2 text-xs text-ink-3">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-line border-t-brand" />
                Reading the records
              </div>
            )}
          </div>
        ))}
        <div ref={end} />
      </div>

      <form onSubmit={submit} className="border-t border-line px-4 pt-3 pb-2.5">
        <div className="flex gap-2">
          <input
            ref={input}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={500}
            placeholder="Ask about findings, samples, documents"
            aria-label="Your question"
            className="h-9 min-w-0 flex-1 rounded-md border border-line bg-paper px-3 text-sm text-ink outline-none transition-colors placeholder:text-ink-3 hover:border-ink-3 focus:border-brand focus:ring-2 focus:ring-brand/15"
          />
          <button disabled={busy || !draft.trim()} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-brand text-on-brand transition-colors hover:bg-brand-deep disabled:pointer-events-none disabled:opacity-45" aria-label="Send">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" />
            </svg>
          </button>
        </div>
        <p className="mt-2 text-[11px] text-ink-3">Reads only. Each question is recorded in the audit trail.</p>
      </form>
    </section>
  );
}
