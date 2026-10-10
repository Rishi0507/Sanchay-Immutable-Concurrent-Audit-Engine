"""Field extraction from evidence files (PRD 14.2).

Text PDFs are read directly. Scans and images go through OCR (EV-1), with
Hindi and Marathi packs when installed (EV-6). Fields are extracted into a
fixed schema per document type by the local model when it is configured
(EV-2), validated against the schema, and otherwise by pattern rules (EV-3,
AI-3). Every field carries a confidence (EV-4).
"""

from __future__ import annotations

import datetime as dt
import io
import json
import os
import re
import shutil
from pathlib import Path

SCHEMA = {
    "invoice": ["invoice_no", "invoice_date", "customer_name", "customer_gstin", "supplier_gstin", "taxable_value",
                "cgst", "sgst", "igst", "gross", "vehicle_no", "ewb_no"],
    "eway_bill": ["ewb_no", "invoice_no", "invoice_date", "value", "supplier_gstin", "recipient_gstin", "vehicle_no",
                  "distance_km", "generated_at", "valid_until"],
    "lr_copy": ["lr_no", "date", "vehicle_no", "consignee", "invoice_no", "transporter"],
    "credit_note": ["credit_note_no", "date", "original_invoice_no", "customer_gstin", "taxable_value", "gross"],
    "sales_return": ["credit_note_no", "inward_date", "vehicle_no"],
    "other": [],
}
REQUIRED = {
    "invoice": ["invoice_no", "invoice_date", "customer_gstin", "taxable_value", "gross"],
    "eway_bill": ["ewb_no", "invoice_no", "value", "vehicle_no", "valid_until"],
    "lr_copy": ["lr_no", "date", "vehicle_no"],
    "credit_note": ["credit_note_no", "date", "original_invoice_no", "taxable_value"],
    "sales_return": ["credit_note_no", "inward_date"],
    "other": [],
}
MONEY = {"taxable_value", "cgst", "sgst", "igst", "gross", "value"}
DATES = {"invoice_date", "date", "inward_date"}
DATETIMES = {"generated_at", "valid_until"}

_D = r"(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}[- ][A-Za-z]{3}[- ]\d{2,4})"
_DT = _D + r"(?:[ T,]+(\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AaPp][Mm])?))?"
_AMT = r"(?:Rs\.?|INR|\u20b9)?\s*(-?[\d,]+(?:\.\d{1,2})?)"
_GSTIN = r"(\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z])"
_VEH = r"([A-Z]{2}\s?-?\d{1,2}\s?-?[A-Z]{0,3}\s?-?\d{4})"
_DOCNO = r"([A-Z0-9][A-Z0-9/\-]{2,30})"

PATTERNS = {
    "invoice_no": [r"(?<!Against )(?<!Original )(?<!Ref. )Invoice\s*(?:No\.?|Number|#)\s*[:\-]?\s*" + _DOCNO,
                   r"(?<!Way )(?<!Way)Bill\s*(?:No\.?|Number|#)\s*[:\-]?\s*" + _DOCNO,
                   r"\u092c\u0940\u091c\u0915\s*(?:\u0915\u094d\u0930\.?|\u0938\u0902\u0916\u094d\u092f\u093e)\s*[:\-]?\s*" + _DOCNO],
    "original_invoice_no": [r"(?:Original|Against|Ref\.?)\s*(?:Invoice|Bill)\s*(?:No\.?|Number)?\s*[:\-]?\s*" + _DOCNO],
    "credit_note_no": [r"Credit\s*Note\s*(?:No\.?|Number)\s*[:\-]?\s*" + _DOCNO],
    "ewb_no": [r"(?:E-?\s?Way\s*Bill|EWB)\s*(?:No\.?|Number)?\s*[:\-]?\s*(\d{4}\s?\d{4}\s?\d{4})"],
    "lr_no": [r"(?:L\.?R\.?|Lorry\s*Receipt|Consignment\s*Note|GR)\s*(?:No\.?|Number)\s*[:\-]?\s*" + _DOCNO],
    "invoice_date": [r"(?:Invoice|Bill|Document)\s*Date\s*[:\-]?\s*" + _D,
                     r"\u0926\u093f\u0928\u093e\u0902\u0915\s*[:\-]?\s*" + _D],
    "date": [r"(?:Credit\s*Note|L\.?R\.?|Lorry\s*Receipt|Booking)\s*Date\s*[:\-]?\s*" + _D,
             r"Date\s*[:\-]\s*" + _D],
    "inward_date": [r"(?:Inward|Received|Return|GRN)\s*Date\s*[:\-]?\s*" + _D],
    "generated_at": [r"(?:Generated\s*(?:Date|On|At)?|EWB\s*Date)\s*[:\-]?\s*" + _DT],
    "valid_until": [r"Valid\s*(?:Upto|Up\s*to|Until|Till)\s*[:\-]?\s*" + _DT],
    "customer_gstin": [r"(?:Buyer|Customer|Recipient|Bill\s*To|Party)\s*GSTIN\s*[:\-]?\s*" + _GSTIN],
    "recipient_gstin": [r"(?:Recipient|Buyer|To)\s*GSTIN\s*[:\-]?\s*" + _GSTIN],
    "supplier_gstin": [r"(?:Supplier|Seller|From|Our)\s*GSTIN\s*[:\-]?\s*" + _GSTIN],
    "customer_name": [r"(?:Buyer|Customer|Bill\s*To|Billed\s*To)\s*(?:Name)?\s*[:\-]\s*([^\n]{3,80})"],
    "consignee": [r"Consignee\s*(?:Name)?\s*[:\-]\s*([^\n]{3,80})"],
    "transporter": [r"Transporter\s*(?:Name)?\s*[:\-]\s*([^\n]{3,60})"],
    "taxable_value": [r"(?:Total\s*)?Taxable\s*(?:Value|Amount)\s*[:\-]?\s*" + _AMT],
    "cgst": [r"CGST(?:\s*@?\s*[\d.]+\s*%)?\s*(?:Amount)?\s*[:\-]?\s*" + _AMT],
    "sgst": [r"SGST(?:\s*@?\s*[\d.]+\s*%)?\s*(?:Amount)?\s*[:\-]?\s*" + _AMT],
    "igst": [r"IGST(?:\s*@?\s*[\d.]+\s*%)?\s*(?:Amount)?\s*[:\-]?\s*" + _AMT],
    "gross": [r"(?:Grand\s*Total|Invoice\s*Total|Total\s*Invoice\s*Value|Gross\s*Amount|Credit\s*Note\s*Total)\s*[:\-]?\s*" + _AMT],
    "value": [r"(?:Total\s*)?(?:Invoice\s*)?Value\s*(?:of\s*Goods)?\s*[:\-]?\s*" + _AMT],
    "vehicle_no": [r"(?:Vehicle|Truck|Lorry)\s*(?:No\.?|Number)?\s*[:\-]?\s*" + _VEH],
    "distance_km": [r"(?:Approx\.?\s*)?Distance\s*(?:\(\s*km\s*\))?\s*[:\-]?\s*(\d{1,5})"],
}
DOC_FIELD_ALIAS = {"eway_bill": {"recipient_gstin": "recipient_gstin"}}


def parse_date(s: str) -> str | None:
    s = s.strip()
    for fmt in ("%d-%m-%Y", "%d/%m/%Y", "%d.%m.%Y", "%Y-%m-%d", "%d-%b-%Y", "%d %b %Y", "%d-%m-%y", "%d/%m/%y"):
        try:
            return dt.datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def parse_datetime(date_s: str, time_s: str | None) -> str | None:
    day = parse_date(date_s)
    if not day:
        return None
    t = "23:59:59" if not time_s else time_s.strip()
    for fmt in ("%H:%M:%S", "%H:%M", "%I:%M %p", "%I:%M:%S %p", "%I:%M%p"):
        try:
            return f"{day}T{dt.datetime.strptime(t.upper(), fmt).strftime('%H:%M:%S')}"
        except ValueError:
            continue
    return f"{day}T23:59:59"


def parse_amount(s: str) -> int | None:
    s = s.replace(",", "").strip()
    try:
        whole, _, frac = s.partition(".")
        sign = -1 if whole.startswith("-") else 1
        whole = whole.lstrip("-") or "0"
        return sign * (int(whole) * 100 + int((frac + "00")[:2]))
    except ValueError:
        return None


def text_of(data: bytes) -> tuple[str, str, dict]:
    """Return (text, method, pdf metadata). Method is pdf_text, ocr or none."""
    meta: dict = {}
    if data[:4] == b"%PDF":
        try:
            from pypdf import PdfReader

            reader = PdfReader(io.BytesIO(data))
            info = reader.metadata or {}
            meta = {"producer": str(info.get("/Producer") or ""), "creator": str(info.get("/Creator") or ""),
                    "creation_date": _pdf_date(info.get("/CreationDate")), "mod_date": _pdf_date(info.get("/ModDate")),
                    "pages": len(reader.pages)}
            text = "\n".join((p.extract_text() or "") for p in reader.pages)
            if len(text.strip()) >= 20:
                return text, "pdf_text", meta
        except Exception as e:  # malformed PDF: fall through to OCR
            meta["error"] = str(e)[:200]
        img = render_first_page(data)
        if img is not None:
            t = ocr(img)
            return t, ("ocr" if t else "none"), meta
        return "", "none", meta
    try:
        from PIL import Image

        img = Image.open(io.BytesIO(data))
        t = ocr(img)
        return t, ("ocr" if t else "none"), meta
    except Exception:
        try:
            return data.decode("utf-8"), "plain_text", meta
        except UnicodeDecodeError:
            return "", "none", meta


def _pdf_date(v) -> str | None:
    if not v:
        return None
    s = str(v)
    m = re.match(r"D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?", s)
    if not m:
        return None
    y, mo, d_, hh, mm, ss = (m.group(i) or "00" for i in range(1, 7))
    return f"{y}-{mo}-{d_}T{hh}:{mm}:{ss}"


def render_first_page(data: bytes):
    try:
        import fitz
        from PIL import Image

        doc = fitz.open(stream=data, filetype="pdf")
        pix = doc[0].get_pixmap(dpi=150)
        return Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    except Exception:
        return None


def tesseract_cmd() -> str | None:
    cand = os.environ.get("TESSERACT_CMD") or shutil.which("tesseract")
    if not cand:
        for p in (r"C:\Program Files\Tesseract-OCR\tesseract.exe", "/usr/bin/tesseract", "/usr/local/bin/tesseract"):
            if Path(p).exists():
                cand = p
                break
    return cand


def ocr_languages() -> str:
    try:
        import pytesseract

        have = set(pytesseract.get_languages(config=""))
    except Exception:
        have = {"eng"}
    langs = [l for l in ("eng", "hin", "mar") if l in have]
    return "+".join(langs or ["eng"])


def ocr(img) -> str:
    cmd = tesseract_cmd()
    if not cmd:
        return ""
    try:
        import pytesseract

        pytesseract.pytesseract.tesseract_cmd = cmd
        return pytesseract.image_to_string(img, lang=ocr_languages())
    except Exception:
        return ""


def by_patterns(text: str, doc_type: str, base_conf: float) -> dict[str, dict]:
    fields: dict[str, dict] = {}
    wanted = SCHEMA.get(doc_type, [])
    norm = text.replace("\r", "")
    for f in wanted:
        keys = [f]
        if doc_type == "eway_bill" and f == "recipient_gstin":
            keys = ["recipient_gstin", "customer_gstin"]
        if doc_type == "credit_note" and f == "date":
            keys = ["date"]
        for key in keys:
            for pat in PATTERNS.get(key, []):
                m = re.search(pat, norm, flags=re.IGNORECASE)
                if not m:
                    continue
                raw = m.group(1)
                if f in MONEY:
                    val = parse_amount(raw)
                elif f in DATES:
                    val = parse_date(raw)
                elif f in DATETIMES:
                    val = parse_datetime(raw, m.group(2) if m.lastindex and m.lastindex >= 2 else None)
                elif f == "distance_km":
                    val = int(raw)
                elif f in ("vehicle_no",):
                    val = re.sub(r"[\s\-]", "", raw.upper())
                elif f == "ewb_no":
                    val = re.sub(r"\s", "", raw)
                else:
                    val = raw.strip().rstrip(".,;")
                if val is not None:
                    fields[f] = {"value": val, "confidence": base_conf, "source": "pattern"}
                    break
            if f in fields:
                break
    return fields


def by_model(text: str, doc_type: str, url: str, model: str) -> dict[str, dict] | None:
    """Local model extraction (EV-2). Output is validated; anything invalid returns None (AI-3)."""
    import httpx

    keys = SCHEMA.get(doc_type, [])
    if not keys:
        return None
    schema = {"type": "object", "properties": {k: {"type": ["string", "number", "null"]} for k in keys},
              "required": keys}
    prompt = (f"Extract these fields from the {doc_type.replace('_', ' ')} text below. Return JSON only with keys "
              f"{keys}. Amounts in rupees as numbers, dates as YYYY-MM-DD, date-times as YYYY-MM-DDTHH:MM:SS. "
              f"Use null when a field is absent.\n\n{text[:6000]}")
    try:
        r = httpx.post(f"{url.rstrip('/')}/api/generate", timeout=60,
                       json={"model": model, "prompt": prompt, "format": schema, "stream": False,
                             "options": {"temperature": 0}})
        r.raise_for_status()
        data = json.loads(r.json().get("response") or "{}")
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    out = {}
    for k in keys:
        v = data.get(k)
        if v in (None, ""):
            continue
        try:
            if k in MONEY:
                v = int(round(float(str(v).replace(",", "")) * 100))
            elif k in DATES:
                v = parse_date(str(v)) or (str(v)[:10] if re.match(r"\d{4}-\d{2}-\d{2}", str(v)) else None)
            elif k in DATETIMES:
                v = str(v) if re.match(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}", str(v)) else None
            elif k == "distance_km":
                v = int(float(v))
            elif k == "vehicle_no":
                v = re.sub(r"[\s\-]", "", str(v).upper())
            else:
                v = str(v).strip()
        except (TypeError, ValueError):
            v = None
        if v is not None:
            out[k] = {"value": v, "confidence": 0.85, "source": "model"}
    return out


def extract(data: bytes, doc_type: str, ollama_url: str | None = None, model: str = "llama3.2:3b") -> dict:
    text, method, meta = text_of(data)
    base = {"pdf_text": 0.95, "plain_text": 0.95, "ocr": 0.85, "none": 0.0}[method]
    fields = by_patterns(text, doc_type, base) if text else {}
    used_model = False
    if ollama_url and text:
        model_fields = by_model(text, doc_type, ollama_url, model)
        if model_fields:
            used_model = True
            for k, v in model_fields.items():
                if k not in fields:
                    fields[k] = v
                elif fields[k]["value"] == v["value"]:
                    fields[k]["confidence"] = min(0.99, fields[k]["confidence"] + 0.04)
                else:
                    fields[k]["confidence"] = min(fields[k]["confidence"], 0.6)
                    fields[k]["alternative"] = v["value"]
    required = REQUIRED.get(doc_type, [])
    low = [k for k in required if k not in fields or fields[k]["confidence"] < 0.8]
    return {"doc_type": doc_type, "method": method, "model_used": used_model, "fields": fields, "metadata": meta,
            "low_confidence": low, "text_hash": _text_hash(text), "chars": len(text)}


def _text_hash(text: str) -> str | None:
    import hashlib

    norm = re.sub(r"\s+", " ", text).strip().lower()
    return hashlib.sha256(norm.encode()).hexdigest() if len(norm) > 20 else None


def perceptual_hash(data: bytes) -> str | None:
    """Perceptual hash for raster evidence (scans and photos)."""
    try:
        import imagehash
        from PIL import Image

        if data[:4] == b"%PDF":
            return None
        return str(imagehash.phash(Image.open(io.BytesIO(data))))
    except Exception:
        return None
