"""Finding the passages that answer a question, with no model and no index service.

Three signals are combined: the words of the question (BM25), an exact
identifier such as an invoice number, and the kind of question asked. A
question in Hindi or Marathi is first given its English audit words, so one
index serves all three languages. A question the records say nothing about
finds nothing, and the assistant then declines instead of guessing.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass

from rapidfuzz import fuzz, process

from ..evidence.regional import clean
from .passages import Passage

WORD = re.compile(r"[a-z0-9]+(?:[/_-][a-z0-9]+)*")
STOP = frozenset("""a an the of to in on at by for from with and or but is are was were be been being am do does did has have
had what which who whom whose when where why how many much this that these those it its there here any all some me my we
our us you your i they them their he she his her can could would should will shall may might please show tell give list
find get about into over under than then so if not no yes also just only very more most as such per each every other
audit sanchay say says said know let see look want need""".split())

# Audit words of a Hindi or Marathi question, in English. A word is matched inside the question, so its endings match too.
GLOSSARY = {
    "निष्कर्ष": "findings", "फाइंडिंग": "findings", "त्रुटि": "exception", "त्रुटी": "exception",
    "उच्च": "high", "हाई": "high", "गंभीर": "high", "मध्यम": "medium",
    "कितने": "how many", "कितनी": "how many", "कितना": "how much total", "किती": "how many", "कुल": "total", "एकूण": "total",
    "चालान": "invoice", "बीजक": "invoice", "इनवॉइस": "invoice", "इन्व्हॉइस": "invoice", "बिल": "invoice",
    "ग्राहक": "customer", "नमूना": "sample", "नमूने": "samples", "नमूनों": "samples", "नमुना": "sample", "नमुने": "samples",
    "सैंपल": "sample", "सॅम्पल": "sample", "संबंधित": "related party", "राशि": "amount", "रक्कम": "amount", "रकम": "amount",
    "सबूत": "evidence documents", "साक्ष्य": "evidence documents", "पुरावा": "evidence documents", "पुरावे": "evidence documents",
    "दस्तावेज": "documents", "दस्तावेज़": "documents", "दस्तऐवज": "documents", "कागदपत्र": "documents",
    "जोखिम": "high", "जोखीम": "high", "क्रेडिट नोट": "credit note", "सारांश": "glance total findings", "आढावा": "glance total findings",
    "कट-ऑफ": "cut-off", "कटऑफ": "cut-off", "सबसे बड़": "largest", "सर्वात मोठ": "largest", "हिंदी": "hindi", "हिन्दी": "hindi",
    "मराठी": "marathi", "जाली": "forged suspect evidence", "नकली": "forged suspect evidence", "फर्जी": "forged suspect evidence",
    "बनावट": "forged suspect evidence", "राजस्व": "revenue", "महसूल": "revenue", "बिक्री": "sales", "विक्री": "sales",
    "चक्रीय": "circular trading", "सर्कुलर": "circular trading", "रजिस्टर": "register", "नोंदवही": "register",
    "प्रगति": "progress steps", "प्रगती": "progress steps", "बाकी": "still progress steps", "लंबित": "awaited", "प्रलंबित": "awaited",
    "लेजर": "ledger", "खातेवही": "ledger", "समायोजन": "adjustment", "पुष्टि": "confirmed decision", "पुष्टी": "confirmed decision",
    "प्रबंधक": "manager", "व्यवस्थापक": "manager", "नियंत्रण": "control requests", "ट्रैप": "control requests", "ट्रॅप": "control requests",
    "छूट": "discount promotions", "सवलत": "discount promotions", "डिस्काउंट": "discount promotions", "क्या है": "what is",
    "काय आहे": "what is", "म्हणजे काय": "what is", "कैसे": "how are", "कसे": "how are", "सुरक्षा": "safeguards",
}
# Everyday words for what the records call something else.
SAME = {
    "fake": "forged suspect evidence", "forged": "suspect evidence", "tampered": "forged suspect evidence",
    "altered": "forged suspect", "doctored": "forged suspect evidence", "fraud": "suspect circular", "biggest": "largest",
    "top": "largest", "major": "largest", "highest": "largest", "roundtrip": "circular", "tripping": "circular",
    "risky": "high", "risk": "high", "serious": "high", "critical": "high", "severe": "high", "pending": "awaited await",
    "outstanding": "awaited", "waiting": "awaited", "summary": "glance total", "summarise": "glance total",
    "summarize": "glance total", "overview": "glance total", "trap": "control", "regional": "hindi marathi",
    "language": "hindi marathi", "undisclosed": "suggested disclosed", "hidden": "suggested", "immutable": "ledger hash",
    "seed": "sealed", "random": "sealed seed", "bill": "invoice", "failed": "exception", "fail": "exception",
    "failing": "exception", "money": "amount", "worth": "amount", "left": "still", "remaining": "still",
    "done": "complete", "finished": "complete", "approve": "confirm decision", "approved": "confirmed",
    "issue": "finding", "problem": "finding", "error": "finding exception", "wrong": "finding exception",
    "flagged": "finding", "raised": "finding", "caught": "finding", "checked": "tested",
}
FIGURES = re.compile(r"\b(how many|how much|count|number of|total|overall|summary|summar|overview|glance|status|progress|"
                     r"breakdown|by area|by severity|largest|biggest|top)\b")
MEANING = re.compile(r"^\s*(what is|what are|what does|what do|explain|define|meaning of|how does|how do|how are|how is|"
                     r"why does|why do|why is|why are|who can|who decides|can the)\b")
FOLLOW_UP = re.compile(r"^\s*(and|also|what about|how about)\b|\b(it|they|them|those|these|that one|the same)\b")


def stem(w: str) -> str:
    if len(w) > 4 and w.endswith("ies"):
        return w[:-3] + "y"
    if len(w) > 3 and w.endswith("s") and not w.endswith("ss"):
        return w[:-1]
    return w


def tokens(text: str) -> list[str]:
    """Words and identifiers. An identifier is kept whole, joined and in its parts, so 06879 finds SPC/25-26/06879."""
    out = []
    for w in WORD.findall(clean(text).lower()):
        parts = re.split(r"[/_-]", w)
        if len(parts) > 1:
            out += [w, "".join(parts)]
        out += [stem(p) for p in parts]
    return out


def in_english(question: str) -> str:
    """The question followed by the English audit words of its Hindi or Marathi ones."""
    added = [english for word, english in GLOSSARY.items() if word in question]
    return question + " " + " ".join(added) if added else question


def is_identifier(token: str) -> bool:
    """A document number or a record identifier, and not a year."""
    if re.fullmatch(r"(19|20)[0-9]{2}", token):
        return False
    return sum(c.isdigit() for c in token) >= 4


@dataclass
class Found:
    hits: list[tuple[Passage, float]]
    coverage: float  # how much of the question the best passage speaks to, 0 to 1


class Index:
    """BM25 over the passages of one engagement, held in memory."""

    K1, B = 1.5, 0.75
    REPEATS = 3  # a word counts this many times at most, so a long list does not outrank the passage that answers
    UNKNOWN = 2.0  # what a word found in no passage weighs when judging how much of the question was answered
    MOST = {"area": 2}  # passages of one kind among the hits, 4 unless named here: the areas read alike

    def __init__(self, passages: list[Passage]):
        self.passages = passages
        # A title and the other words for a passage say what it is about, so they count twice.
        self.docs = [Counter(tokens(f"{p.title} {p.terms} {p.title} {p.terms} {p.text} {p.key}")) for p in passages]
        self.lengths = [sum(d.values()) for d in self.docs]
        self.average = sum(self.lengths) / max(1, len(self.docs))
        self.df = Counter(t for d in self.docs for t in d)
        self.words = [t for t in self.df if t.isalpha() and len(t) >= 5]

    def idf(self, token: str) -> float:
        n, df = len(self.docs), self.df.get(token, 0)
        return math.log(1 + (n - df + 0.5) / (df + 0.5))

    def query(self, question: str) -> list[str]:
        """The words to search for: stop words dropped, everyday words widened, a misspelt word set right."""
        out = []
        for t in tokens(in_english(question)):
            if t in STOP or (len(t) < 2 and not t.isdigit()):
                continue
            if t not in self.df and t not in SAME and t.isalpha() and len(t) >= 5:
                near = process.extractOne(t, self.words, scorer=fuzz.ratio, score_cutoff=84)
                t = near[0] if near else t
            if t in self.df or t not in SAME:
                out.append(t)
            out += [stem(x) for x in SAME.get(t, "").split()]
        return list(dict.fromkeys(out))

    def search(self, question: str, previous: str = "", k: int = 5) -> Found:
        words = self.query(question)
        if previous and (len(words) < 3 or FOLLOW_UP.search(question.lower())):
            words = list(dict.fromkeys(self.query(previous) + words))
        if not words:
            return Found([], 0.0)
        asked = in_english(question).lower()
        boost = {"figures": 1.6 if FIGURES.search(asked) else 1.0, "guide": 1.6 if MEANING.search(asked) else 1.0}
        scored = []
        for i, doc in enumerate(self.docs):
            score = 0.0
            for t in words:
                tf = min(doc.get(t, 0), self.REPEATS)
                if not tf:
                    continue
                norm = tf + self.K1 * (1 - self.B + self.B * self.lengths[i] / self.average)
                score += self.idf(t) * tf * (self.K1 + 1) / norm
                if is_identifier(t):
                    score += 8.0  # the record that was asked for by its number comes first
            if score:
                scored.append((score * boost.get(self.passages[i].kind, 1.0), i))
        if not scored:
            return Found([], 0.0)
        scored.sort(key=lambda x: (-x[0], x[1]))
        best = self.docs[scored[0][1]]
        weight = {t: self.idf(t) if t in self.df else self.UNKNOWN for t in words}
        coverage = sum(w for t, w in weight.items() if t in best) / sum(weight.values())
        hits, kinds = [], Counter()
        for score, i in scored:
            p = self.passages[i]
            if score < 0.3 * scored[0][0] or len(hits) == k:
                break
            if kinds[p.kind] < self.MOST.get(p.kind, 4):
                kinds[p.kind] += 1
                hits.append((p, round(score, 3)))
        return Found(hits, round(coverage, 3))
