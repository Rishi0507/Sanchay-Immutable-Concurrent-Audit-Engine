"""Answering a question about an engagement from its own records.

The passages are found by search. A model, when one is configured, only words
the answer: it is given those passages and nothing else, and its reply is then
checked sentence by sentence. A sentence that states a figure the passages do
not contain is withheld. With no model, or once the day's token allowance is
spent, the answer is the passages themselves, so the assistant never depends
on a model and never spends without a limit.
"""

from __future__ import annotations

import datetime as dt
import re

from ..evidence.regional import clean, has_devanagari
from ..repo import evidence_results, finding_decisions, findings, sample_tests
from .passages import Passage, build, clip
from .search import Index

SYSTEM = """You are the assistant inside Sanchay, a system that runs a statutory revenue audit. You answer the audit \
team's questions from the numbered sources given with each question, and from nothing else.
Rules:
1. Use only what the sources say. If they do not answer the question, say that the audit records do not show it.
2. After every statement give its source number in square brackets, for example [2].
3. Copy every amount, count, date, name and document number exactly as the source writes it. Do not add up, round, \
convert or work out any figure of your own.
4. Write your sentences in the language of the question: English, Hindi or Marathi. Translate what a source says; \
only names, document numbers and figures stay as the source writes them, in Latin digits.
5. Answer every part of the question, and be short: at most four sentences or bullet lines of plain text, with no \
headings and no bold."""

NOT_FOUND = "The records of this audit do not answer that. Ask about its findings, samples, documents, related parties or safeguards."
MIN_COVERAGE = 0.34  # below this the best passage speaks to too little of the question
PASSAGE_CHARS = 600
NUMBER = re.compile(r"\d[\d,]*(?:\.\d+)?")
CITE = re.compile(r"\s*\[(\d+(?:\s*,\s*\d+)*)\]")
SCALES = {"thousand": 1e3, "हजार": 1e3, "हज़ार": 1e3, "lakh": 1e5, "lakhs": 1e5, "लाख": 1e5, "crore": 1e7, "crores": 1e7,
          "करोड़": 1e7, "करोड": 1e7, "कोटी": 1e7}
ABBREVIATIONS = ("pvt.", "ltd.", "rs.", "no.", "co.", "m/s.", "mr.", "ms.", "dr.", "inc.", "vs.", "st.")


def canonical(number: str) -> str:
    """One spelling for a figure: 24,58,372.60 and 2458372.6 are the same."""
    n = number.replace(",", "")
    if "." in n:
        n = n.rstrip("0").rstrip(".")
    return n.lstrip("0") or "0"


def figures_of(passages: list[Passage]) -> set[str]:
    return {canonical(m) for p in passages for m in NUMBER.findall(clean(f"{p.title} {p.text}"))}


def figures_in(sentence: str, known: set[str]) -> tuple[int, list[str]]:
    """How many figures a sentence states, and those that no source states.

    A single digit is a list number or a small count and is not checked.
    """
    text = clean(CITE.sub("", sentence))
    stated, out = 0, []
    for m in NUMBER.finditer(text):
        c = canonical(m.group())
        if len(c) == 1:
            continue
        stated += 1
        if c in known:
            continue
        # "Rs 24.58 lakh" is traced when a source states an amount that rounds to it.
        after = text[m.end():].split()
        scale = SCALES.get(after[0].strip(".,;:)").lower()) if after else None
        if scale:
            places = len(c.split(".")[1]) if "." in c else 0
            if any(abs(float(k) - float(c) * scale) <= scale / 10 ** places for k in known):
                continue
        out.append(m.group())
    return stated, out


def sentences(line: str) -> list[str]:
    out, piece = [], ""
    for part in re.split(r"(?<=[.!?।])\s+", line.strip()):
        # A source number written after the full stop belongs to the sentence before it.
        late = re.match(r"(?:\[[\d,\s]+\]\s*)+", part) if out and not piece else None
        if late:
            out[-1] += " " + late.group().strip()
            part = part[late.end():]
            if not part.strip(" ."):
                continue
        piece = f"{piece} {part}".strip()
        # "Pvt." and a list number such as "2." do not end a sentence.
        if piece.lower().endswith(ABBREVIATIONS) or re.search(r"(^|\s)\d+\.$", piece):
            continue
        out.append(piece)
        piece = ""
    return out + ([piece] if piece else [])


def checked(reply: str, passages: list[Passage]) -> tuple[str, list[Passage], dict]:
    """The reply with every untraced sentence withheld, the sources it cites in order, and what the check found."""
    known = figures_of(passages)
    order: list[int] = []
    counted = traced = withheld = 0

    def renumber(m: re.Match) -> str:
        """Source numbers in the order the answer first cites them. A number that names no source is dropped."""
        ns = [int(x) for x in re.split(r"\s*,\s*", m.group(1)) if 1 <= int(x) <= len(passages)]
        order.extend(n for n in dict.fromkeys(ns) if n not in order)
        return " [" + ", ".join(str(order.index(n) + 1) for n in ns) + "]" if ns else ""

    lines = []
    for line in reply.splitlines():
        kept = []
        for s in sentences(line):
            stated, bad = figures_in(s, known)
            counted += stated
            traced += stated - len(bad)
            if bad:
                withheld += 1
                continue
            kept.append(CITE.sub(renumber, s).strip())
        if kept:
            lines.append(" ".join(kept))
    return "\n".join(lines), [passages[n - 1] for n in order], {"figures": counted, "traced": traced, "withheld": withheld}


def from_records(hits: list[tuple[Passage, float]]) -> tuple[str, list[Passage]]:
    """The answer with no model: the passage that matches best, and the best of another kind when it is close.

    A figure and the finding behind it, or a rule and the count under it, read
    well together. Two passages of one kind mostly repeat each other, so the
    second is listed as a source and not quoted.
    """
    best, floor = hits[0][0], 0.6 * hits[0][1]
    near = [p for p, score in hits[1:] if score >= floor]
    second = next((p for p in near if p.kind != best.kind), None)
    quoted = [best] + ([second] if second else [])
    answer = "\n".join(f"{clip(p.text, 520 if i == 1 else 300)} [{i}]" for i, p in enumerate(quoted, 1))
    return answer, quoted + [p for p in near if p not in quoted][:3 - len(quoted)]


def stamp(ctx) -> tuple:
    """Changes whenever a step, a finding, a decision or a test result is added, and so when the passages go stale."""
    repo = ctx.engine.repo
    return (len(repo.steps_done(ctx.eid)),) + tuple(
        repo.count(t, engagement_id=ctx.eid) for t in (findings, finding_decisions, evidence_results, sample_tests))


def index_for(ctx) -> tuple[Index, tuple]:
    views, now = ctx.engine.views, stamp(ctx)
    held = views.get(("assistant", ctx.eid))
    if not held or held[0] != now:
        held = (now, Index(build(ctx)))
        views[("assistant", ctx.eid)] = held
        views.pop(("answers", ctx.eid), None)
    return held[1], now


def source(n: int, p: Passage) -> dict:
    return {"n": n, "kind": p.kind, "title": p.title, "text": clip(p.text, 420), "tab": p.tab, "focus": p.focus}


def ask(ctx, question: str, previous: str | None = None) -> dict:
    """Answer one question. It reads the engagement and writes nothing."""
    engine, settings = ctx.engine, ctx.engine.settings
    index, now = index_for(ctx)
    today = dt.date.today().isoformat()
    kept = engine.views.setdefault(("answers", ctx.eid), (now, {}))[1]
    key = (" ".join(question.lower().split()), " ".join((previous or "").lower().split()))
    if key in kept:
        return kept[key] | {"tokens": 0, "tokens_today": engine.spent.get(today, 0), "repeated": True}

    language = "hi/mr" if has_devanagari(question) else "en"
    out = {"engagement_id": ctx.eid, "question": question, "language": language, "mode": "none", "answer": NOT_FOUND,
           "sources": [], "checks": {"figures": 0, "traced": 0, "withheld": 0}, "note": "", "tokens": 0,
           "searched": len(index.passages), "repeated": False}
    found = index.search(question, previous or "")
    model = settings.assistant_model()
    if found.hits and found.coverage >= MIN_COVERAGE:
        passages = [p for p, _ in found.hits]
        answer, used = "", []
        if model and engine.spent.get(today, 0) >= settings.chat_daily_tokens:
            out["note"] = "Today's model allowance is used up, so this answer is taken straight from the records."
        elif model:
            listed = "\n\n".join(f"[{i}] {p.title}\n{clip(p.text, PASSAGE_CHARS)}" for i, p in enumerate(passages, 1))
            earlier = f"Earlier question: {previous}\n" if previous else ""
            reply, out["tokens"] = model.chat([{"role": "system", "content": SYSTEM}, {
                "role": "user", "content": f"Sources:\n{listed}\n\n{earlier}Question: {question}"}])
            engine.spent[today] = engine.spent.get(today, 0) + out["tokens"]
            if reply:
                answer, used, out["checks"] = checked(reply, passages)
            if answer:
                out["mode"] = "model"
                used = used or passages[:3]
            else:
                out["note"] = ("The model's wording was withheld because it stated figures that are not in the records."
                               if reply else "The model did not answer, so this is taken straight from the records.")
        if not answer:
            answer, used = from_records(found.hits)
            out["mode"] = "records"
            out["checks"] = checked(answer, used)[2]
            if language != "en" and not out["note"]:
                out["note"] = "Answered in English. An answer in Hindi or Marathi needs the model."
        out["answer"], out["sources"] = answer, [source(i, p) for i, p in enumerate(used, 1)]
    out["tokens_today"] = engine.spent.get(today, 0)
    # An answer that fell back because the model failed is not kept, so the next try can reach the model.
    if len(kept) < 300 and (out["mode"] != "records" or not model):
        kept[key] = out
    return out
