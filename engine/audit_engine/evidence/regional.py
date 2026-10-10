"""Evidence written in Hindi or Marathi (PRD 14.2, EV-6).

The pattern rules look for English labels. A lorry receipt or an invoice in
Devanagari says the same things with other words and often writes its digits
in Devanagari. This module rewrites such text into the form the rules expect:
digits become ASCII digits and each known label becomes its English
equivalent. Document numbers, GSTINs, names and amounts are left as written.

Text read back from a PDF in Devanagari is rarely exact. Conjunct letters come
back as stray symbols and vowel signs drift from their consonants, whichever
tool wrote the file. Labels are therefore compared by their consonants only,
and the value on the line (a date, a GSTIN, an amount) narrows which label it
can be. A label that cannot be placed is left alone: its field is then missing
and the sample goes to a person, which is the safe outcome (EV-4).
"""

from __future__ import annotations

import re

from rapidfuzz import fuzz

LANGUAGE_NAMES = {"en": "English", "hi": "Hindi", "mr": "Marathi", "hi/mr": "Hindi or Marathi"}

# (kind of value, English label the pattern rules know, Hindi wordings, Marathi wordings).
# The first wording of each language is the one used when a test document is written.
TERMS: list[tuple[str, str, list[str], list[str]]] = [
    ("docno", "Invoice No", ["बीजक संख्या", "चालान संख्या", "बीजक क्रमांक", "चालान क्रमांक", "बिल संख्या"],
     ["बीजक क्रमांक", "बिल क्रमांक", "देयक क्रमांक", "चलन क्रमांक"]),
    ("date", "Invoice Date", ["बीजक दिनांक", "चालान दिनांक", "बीजक की तारीख", "बिल दिनांक"],
     ["बीजक दिनांक", "बिल दिनांक", "देयक दिनांक"]),
    ("text", "Buyer Name", ["खरीदार का नाम", "क्रेता का नाम", "ग्राहक का नाम", "खरीदार", "क्रेता"],
     ["खरेदीदाराचे नाव", "ग्राहकाचे नाव", "खरेदीदार"]),
    ("gstin", "Buyer GSTIN", ["खरीदार जीएसटीआईएन", "क्रेता जीएसटीआईएन", "ग्राहक जीएसटीआईएन", "खरीदार GSTIN", "क्रेता GSTIN"],
     ["खरेदीदार जीएसटीआयएन", "ग्राहक जीएसटीआयएन", "खरेदीदार GSTIN"]),
    ("gstin", "Supplier GSTIN", ["आपूर्तिकर्ता जीएसटीआईएन", "विक्रेता जीएसटीआईएन", "आपूर्तिकर्ता GSTIN"],
     ["पुरवठादार जीएसटीआयएन", "विक्रेता जीएसटीआयएन", "पुरवठादार GSTIN"]),
    ("gstin", "Recipient GSTIN", ["प्राप्तकर्ता जीएसटीआईएन"], ["प्राप्तकर्ता जीएसटीआयएन"]),
    ("text", "Place of Supply", ["आपूर्ति का स्थान"], ["पुरवठ्याचे ठिकाण"]),
    ("docno", "Order Ref", ["आदेश संदर्भ", "ऑर्डर संदर्भ"], ["मागणी संदर्भ", "ऑर्डर संदर्भ"]),
    ("money", "Taxable Value", ["कर योग्य मूल्य", "करयोग्य मूल्य", "कर योग्य राशि"], ["करपात्र मूल्य", "करपात्र रक्कम"]),
    ("money", "Packing", ["पैकिंग शुल्क", "पैकिंग"], ["पॅकिंग शुल्क", "पॅकिंग"]),
    ("money", "Freight", ["माल भाड़ा", "भाड़ा"], ["वाहतूक खर्च", "भाडे"]),
    ("money", "Insurance", ["बीमा"], ["विमा"]),
    ("money", "Round Off", ["पूर्णांकन"], ["पूर्णांकन"]),
    ("money", "CGST", ["सीजीएसटी", "केंद्रीय जीएसटी"], ["सीजीएसटी", "केंद्रीय जीएसटी"]),
    ("money", "SGST", ["एसजीएसटी", "राज्य जीएसटी"], ["एसजीएसटी", "राज्य जीएसटी"]),
    ("money", "IGST", ["आईजीएसटी", "एकीकृत जीएसटी"], ["आयजीएसटी", "एकात्मिक जीएसटी"]),
    ("money", "Grand Total", ["कुल योग", "कुल राशि", "कुल बीजक मूल्य", "कुल चालान मूल्य"],
     ["एकूण रक्कम", "एकूण बीजक मूल्य"]),
    ("vehicle", "Vehicle No", ["वाहन संख्या", "वाहन क्रमांक", "गाड़ी संख्या"], ["वाहन क्रमांक", "गाडी क्रमांक"]),
    ("docno", "Against Invoice No", ["मूल बीजक संख्या", "मूल चालान संख्या"], ["मूळ बीजक क्रमांक"]),
    ("docno", "Credit Note No", ["क्रेडिट नोट संख्या", "जमा पत्र संख्या"], ["क्रेडिट नोट क्रमांक", "जमा चिठ्ठी क्रमांक"]),
    ("date", "Credit Note Date", ["क्रेडिट नोट दिनांक", "जमा पत्र दिनांक"], ["क्रेडिट नोट दिनांक", "जमा चिठ्ठी दिनांक"]),
    ("money", "Credit Note Total", ["क्रेडिट नोट कुल राशि", "जमा पत्र कुल राशि"], ["क्रेडिट नोट एकूण रक्कम"]),
    ("text", "Reason", ["कारण"], ["कारण"]),
    ("docno", "LR No", ["बिल्टी संख्या", "एलआर संख्या", "लॉरी रसीद संख्या"],
     ["बिल्टी क्रमांक", "एलआर क्रमांक", "लॉरी पावती क्रमांक"]),
    ("date", "LR Date", ["बिल्टी दिनांक", "एलआर दिनांक"], ["बिल्टी दिनांक", "एलआर दिनांक"]),
    ("text", "Transporter", ["परिवहनकर्ता", "ट्रांसपोर्टर"], ["वाहतूकदार", "ट्रान्सपोर्टर"]),
    ("text", "Consignee", ["प्रेषिती", "माल प्राप्तकर्ता"], ["माल घेणारा", "माल स्वीकारणारा"]),
    ("date", "Inward Date", ["आवक दिनांक", "माल वापसी दिनांक"], ["आवक दिनांक", "माल परत दिनांक"]),
    ("text", "Received by", ["द्वारा प्राप्त"], ["स्वीकारणारा"]),
    ("ewb", "E-Way Bill No", ["ई-वे बिल संख्या"], ["ई-वे बिल क्रमांक"]),
    ("date", "Generated Date", ["जारी करने की तिथि"], ["निर्मिती दिनांक"]),
    ("date", "Valid Upto", ["वैधता तिथि", "तक वैध"], ["वैधता दिनांक", "पर्यंत वैध"]),
    ("int", "Approx Distance (km)", ["अनुमानित दूरी (कि.मी.)"], ["अंदाजे अंतर (कि.मी.)"]),
]
# Document titles, as (Hindi, Marathi).
TITLES = {
    "TAX INVOICE": ("कर बीजक", "कर बीजक"), "E-WAY BILL": ("ई-वे बिल", "ई-वे बिल"),
    "LORRY RECEIPT": ("लॉरी रसीद", "लॉरी पावती"), "CREDIT NOTE": ("क्रेडिट नोट", "क्रेडिट नोट"),
    "SALES RETURN - GOODS RECEIPT NOTE": ("बिक्री वापसी - माल प्राप्ति नोट", "विक्री परत - माल आवक नोंद"),
}

DEVANAGARI_DIGITS = {0x0966 + i: str(i) for i in range(10)}
ASCII_TO_DEVANAGARI = {ord(str(i)): chr(0x0966 + i) for i in range(10)}
# Characters that PDF text extraction puts where a plain space or hyphen was written.
_PLAIN = {0x00A0: " ", 0x2009: " ", 0x202F: " ", 0x2010: "-", 0x2011: "-", 0x2012: "-", 0x2013: "-", 0x2212: "-"}
_LETTER = re.compile("[ऄ-हक़-ॡ]")  # consonants and independent vowels
_GSTIN = re.compile(r"\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]$")
_VEHICLE = re.compile(r"[A-Z]{2}\s?-?\d{1,2}\s?-?[A-Z]{1,3}\s?-?\d{4}$")
_DATE = re.compile(r"(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{4}-\d{2}-\d{2})([ T,]+\d{1,2}:\d{2}(:\d{2})?)?$")
_MONEY = re.compile(r"(Rs\.?|INR|₹)\s*-?[\d,]+(\.\d{1,2})?$|-?[\d,]*\d\.\d{2}$")
# A label must be this close to a known wording, and this much closer than to the next label.
ACCEPT, MARGIN = 0.6, 0.08


def clean(text: str) -> str:
    """Digits as ASCII, and plain spaces and hyphens. Safe for a document in any language."""
    return text.translate(DEVANAGARI_DIGITS).translate(_PLAIN)


def has_devanagari(text: str) -> bool:
    return bool(_LETTER.search(text))


def skeleton(label: str) -> str:
    """The consonants and independent vowels of a label, with ASCII letters. What survives a lossy reading."""
    return "".join(c for c in label.upper() if _LETTER.match(c) or "A" <= c <= "Z")


def value_kind(value: str) -> str:
    v = value.strip()
    # Nothing written, or a dash in place of a value, says nothing about the label.
    if not v.strip("-"):
        return "any"
    if _GSTIN.match(v):
        return "gstin"
    if _DATE.match(v):
        return "date"
    if _MONEY.match(v):
        return "money"
    if _VEHICLE.match(v):
        return "vehicle"
    if re.fullmatch(r"\d{4}\s?\d{4}\s?\d{4}", v):
        return "ewb"
    if re.fullmatch(r"\d{1,5}", v):
        return "int"
    if re.fullmatch(r"[A-Z0-9][A-Z0-9/\-]{2,30}", v) and re.search(r"\d", v):
        return "docno"
    return "text"


# Every GSTIN label ends in the same word. Whose GSTIN it is lies in what comes before.
_GSTIN_WORD = ("जएसटआईएन", "जएसटआयएन", "GSTIN")


def _owner(sk: str) -> str:
    for tail in _GSTIN_WORD:
        if sk.endswith(tail):
            return sk[:-len(tail)]
    return sk


_INDEX = [(kind, english, lang, _owner(skeleton(w)) if kind == "gstin" else skeleton(w))
          for kind, english, hi, mr in TERMS for lang, words in (("hi", hi), ("mr", mr)) for w in words]


def place(label: str, kind: str) -> tuple[str, str, float] | None:
    """The English label for a Devanagari one: (label, language, similarity), or None when it cannot be placed."""
    got = skeleton(label)
    if kind == "gstin":
        got = _owner(got)
    if len(got) < 2:
        return None
    best: dict[str, tuple[float, set[str]]] = {}
    for k, english, lang, want in _INDEX:
        # A short number can stand where text is expected, such as a state code.
        if kind not in ("any", k) and not (kind == "int" and k == "text"):
            continue
        score = fuzz.ratio(got, want) / 100
        top = best.get(english)
        if not top or score > top[0]:
            best[english] = (score, {lang})
        elif score == top[0]:
            top[1].add(lang)
    ranked = sorted(best.items(), key=lambda kv: -kv[1][0])
    if not ranked or ranked[0][1][0] < ACCEPT:
        return None
    if len(ranked) > 1 and ranked[0][1][0] - ranked[1][1][0] < MARGIN:
        return None
    english, (score, langs) = ranked[0]
    return english, ("hi/mr" if len(langs) > 1 else next(iter(langs))), score


def normalise(text: str) -> tuple[str, dict]:
    """Rewrite a document into the form the pattern rules expect.

    Returns the text and what was found: the language, how many labels were
    translated, how many Devanagari labels could not be placed, and the
    similarity of the weakest match.
    """
    text = clean(text)
    if not has_devanagari(text):
        return text, {"language": "en", "labels_translated": 0, "labels_unplaced": 0, "weakest_match": None}
    out, votes, translated, unplaced, weakest = [], {"hi": 0, "mr": 0}, 0, 0, 1.0
    for line in text.replace("\r", "").split("\n"):
        label, sep, value = line.partition(":")
        # A label that also carries its English wording is already readable by the rules.
        english_words = [w for w in re.findall(r"[A-Za-z]{3,}", label) if w.upper() != "GSTIN"]
        if not sep or not has_devanagari(label) or english_words:
            out.append(line)
            continue
        found = place(label, value_kind(value))
        if not found:
            unplaced += 1
            out.append(line)
            continue
        english, lang, score = found
        translated += 1
        weakest = min(weakest, score)
        for one in lang.split("/"):
            votes[one] += 1
        out.append(f"{english}:{value}")
    language = "hi" if votes["hi"] > votes["mr"] else "mr" if votes["mr"] > votes["hi"] else "hi/mr"
    return "\n".join(out), {"language": language, "labels_translated": translated, "labels_unplaced": unplaced,
                            "weakest_match": round(weakest, 2) if translated else None}


def to_regional(lines: list[str], language: str, title: str | None = None) -> tuple[list[str], str | None]:
    """Write English "Label: value" lines in Hindi or Marathi. Used to produce test documents.

    Marathi documents also carry their dates and amounts in Devanagari digits.
    Document numbers, GSTINs and vehicle numbers stay in Latin letters, as on
    real documents.
    """
    index = 2 if language == "hi" else 3
    words = {t[1]: t[index][0] for t in TERMS}
    out = []
    for line in lines:
        label, sep, value = line.partition(":")
        if sep and label.strip() in words:
            if language == "mr" and value_kind(value) in ("date", "money"):
                value = value.translate(ASCII_TO_DEVANAGARI)
            line = f"{words[label.strip()]}:{value}"
        out.append(line)
    return out, (TITLES.get(title or "", (title, title))[0 if language == "hi" else 1] if title else None)
