"""The audit assistant: what it finds, what it declines, and the check on every figure a model writes."""

from types import SimpleNamespace

import pytest

from audit_engine.assistant import service
from audit_engine.assistant.passages import Passage
from audit_engine.assistant.search import Index

PASSAGES = [
    Passage("figures:overview", "figures", "The audit at a glance",
            "Audit of Acme Pvt Ltd. 118 findings in total: 46 High, 5 Medium and 67 Low. Proposed adjustment Rs 24,58,372.64.",
            "overview", terms="how many findings total count high"),
    Passage("finding:fnd_1", "finding", "SPC/25-26/06879: amount on the copy differs from the system",
            "Severity High. Area: Suspect evidence (D-10). Amount Rs 50,000.00. Why: the invoice copy states Rs 2,40,600.80 "
            "and the system Rs 1,90,600.80.", "findings", "fnd_1"),
    Passage("sample:smp_1", "sample", "Sample SPC/25-26/05221",
            "Sample SPC/25-26/05221 on the Sales TOD sheet. Customer Vertex Industrial Supplies. Result: Pass. Documents read in Hindi.",
            "samples", "sales_tod:smp_1"),
    Passage("guide:D-04", "guide", "What circular trading is",
            "Circular trading (D-04): goods or money that return to the company through a cycle of counterparties.", "graph",
            terms="round tripping"),
    Passage("guide:D-06", "guide", "What cut-off means",
            "Cut-off (D-06): revenue recognised in one period when control of the goods passed in another.", "samples"),
]


def top(question: str, previous: str = "") -> str | None:
    found = Index(PASSAGES).search(question, previous)
    return found.hits[0][0].key if found.hits and found.coverage >= service.MIN_COVERAGE else None


def test_a_question_finds_the_record_that_answers_it():
    assert top("How many findings are High?") == "figures:overview"
    assert top("why was invoice 06879 flagged") == "finding:fnd_1"  # the last digits of a document number are enough
    assert top("what is round tripping?") == "guide:D-04"  # another name for the same thing
    assert top("tell me about Vertx Industrial") == "sample:smp_1"  # a misspelt name
    assert top("cutoff problems") == "guide:D-06"


def test_a_question_in_hindi_or_marathi_uses_the_same_records():
    assert top("कितने उच्च निष्कर्ष हैं?") == "figures:overview"
    assert top("एकूण किती निष्कर्ष आहेत?") == "figures:overview"
    assert top("चालान ०६८७९ में क्या त्रुटि है?") == "finding:fnd_1"  # Devanagari digits


def test_a_question_the_records_do_not_answer_is_declined():
    assert top("Who won the cricket world cup?") is None
    assert top("What is the weather in Pune today?") is None
    assert top("और?") is None


def test_a_follow_up_is_read_with_the_question_before_it():
    assert top("and which of those are forged?", "How many findings are High?") in ("finding:fnd_1", "figures:overview")
    assert top("what about them?", "invoice 06879") == "finding:fnd_1"


def test_a_figure_that_no_source_states_is_withheld():
    reply = ("There are 118 findings, of which 46 are High [1].\n"
             "That is 39 percent of all findings [1].\n"
             "The copy of SPC/25-26/06879 states Rs 2,40,600.80 [2].")
    answer, used, checks = service.checked(reply, PASSAGES)
    assert "39 percent" not in answer and "118 findings" in answer and "2,40,600.80" in answer
    assert checks == {"figures": 7, "traced": 6, "withheld": 1}
    assert [p.key for p in used] == ["figures:overview", "finding:fnd_1"]


def test_sources_are_renumbered_in_the_order_they_are_cited():
    answer, used, _ = service.checked("The amount is Rs 50,000.00 [2]. It is one of 118 findings [1, 2]. Nothing more [9].", PASSAGES)
    assert answer == "The amount is Rs 50,000.00 [1]. It is one of 118 findings [2, 1]. Nothing more."
    assert [p.key for p in used] == ["finding:fnd_1", "figures:overview"]
    # A source number after the full stop stays with its sentence, and goes when the sentence is withheld.
    answer, _, checks = service.checked("46 findings are High. [1] They add up to Rs 7,77,777.00. [1]", PASSAGES)
    assert answer == "46 findings are High. [1]" and checks["withheld"] == 1


def test_the_same_amount_written_another_way_is_traced():
    known = service.figures_of(PASSAGES)
    assert service.figures_in("The adjustment is Rs 2458372.64.", known) == (1, [])
    assert service.figures_in("The adjustment is about Rs 24.58 lakh.", known) == (1, [])
    assert service.figures_in("कुल ११८ निष्कर्ष हैं, जिनमें ४६ उच्च हैं।", known) == (2, [])
    assert service.figures_in("The adjustment is about Rs 31.2 lakh.", known) == (1, ["31.2"])
    # A list number and a company suffix do not end a sentence, so nothing is cut in half.
    assert service.sentences("1. Acme Pvt. Ltd. has 46 High findings. 2. None is confirmed.") == [
        "1. Acme Pvt. Ltd. has 46 High findings.", "2. None is confirmed."]


class Model:
    def __init__(self, reply: str | None, tokens: int = 900):
        self.reply, self.tokens, self.asked = reply, tokens, []

    def chat(self, messages, max_tokens=2200):
        self.asked.append(messages)
        return self.reply, self.tokens if self.reply else 0


@pytest.fixture
def ctx(monkeypatch):
    def make(model=None, allowance=10_000):
        engine = SimpleNamespace(views={}, spent={}, settings=SimpleNamespace(assistant_model=lambda: model, chat_daily_tokens=allowance))
        return SimpleNamespace(engine=engine, eid="eng_1")

    monkeypatch.setattr(service, "index_for", lambda c: (Index(PASSAGES), ("stamp",)))
    return make


def test_with_no_model_the_answer_is_the_record_itself(ctx):
    out = service.ask(ctx(), "How many findings are High?")
    assert out["mode"] == "records" and out["tokens"] == 0
    assert "46 High" in out["answer"] and out["sources"][0]["tab"] == "overview"
    assert out["checks"]["withheld"] == 0 and out["checks"]["figures"] == out["checks"]["traced"] > 0
    declined = service.ask(ctx(), "Who won the cricket world cup?")
    assert declined["mode"] == "none" and declined["sources"] == []


def test_the_model_only_words_what_the_sources_say(ctx):
    model = Model("46 of the 118 findings are High [1]. Together they are worth Rs 9,99,999.00 [1].")
    c = ctx(model)
    out = service.ask(c, "How many findings are High?")
    assert out["mode"] == "model" and out["answer"] == "46 of the 118 findings are High [1]."
    assert out["checks"] == {"figures": 3, "traced": 2, "withheld": 1} and out["tokens"] == 900
    # The model saw the sources and the question, and nothing else of the engagement.
    sent = model.asked[0][1]["content"]
    assert "[1] The audit at a glance" in sent and sent.rstrip().endswith("Question: How many findings are High?")
    # The same question again is answered from memory and costs nothing.
    again = service.ask(c, "how many findings are  HIGH?")
    assert again["repeated"] and again["tokens"] == 0 and again["tokens_today"] == 900 and len(model.asked) == 1


def test_wording_made_only_of_invented_figures_falls_back_to_the_records(ctx):
    out = service.ask(ctx(Model("There are 250 findings [1].")), "How many findings are High?")
    assert out["mode"] == "records" and "46 High" in out["answer"] and "withheld" in out["note"]
    silent = service.ask(ctx(Model(None)), "How many findings are High?")
    assert silent["mode"] == "records" and silent["tokens"] == 0


def test_the_daily_allowance_stops_the_model_and_not_the_answers(ctx):
    model = Model("The first source answers this [1].", tokens=600)
    c = ctx(model, allowance=1000)
    assert service.ask(c, "How many findings are High?")["mode"] == "model"
    assert service.ask(c, "what is circular trading")["mode"] == "model"  # 600 used, still under 1000
    third = service.ask(c, "why was invoice 06879 flagged")
    assert third["mode"] == "records" and "allowance" in third["note"] and len(model.asked) == 2
    assert service.ask(c, "Who won the cricket world cup?")["tokens"] == 0 and len(model.asked) == 2  # declined before any model call
