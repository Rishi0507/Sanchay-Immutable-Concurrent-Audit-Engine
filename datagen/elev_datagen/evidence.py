"""Evidence documents for requested samples (SD-7): genuine copies and planted forgeries.

Documents are rendered from the client's own records with reportlab. The PDF
metadata (producer, creation date) is set explicitly, so genuine copies carry
the document date and the client's software, and forged ones can carry an
editing tool or a creation date after the audit request.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import io
import math

from audit_engine.money import rupees
from audit_engine.snapshot import Snapshot, d, ts
from pypdf import PdfReader, PdfWriter
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas


def _fmt_d(iso: str | None) -> str:
    day = d(iso)
    return day.strftime("%d-%m-%Y") if day else ""


def _fmt_dt(iso: str | None) -> str:
    t = ts(iso)
    return t.strftime("%d-%m-%Y %H:%M:%S") if t else ""


def render_regional(lines: list[str], title: str, producer: str, created: dt.datetime, language: str) -> bytes:
    """The same document in Hindi or Marathi. PyMuPDF shapes Devanagari, which reportlab does not."""
    import html

    import pymupdf

    from audit_engine.evidence.regional import to_regional

    lines, title = to_regional(lines, language, title)
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    body = f"<h1>{html.escape(title)}</h1>" + "".join(f"<p>{html.escape(ln) or '&#160;'}</p>" for ln in lines)
    page.insert_htmlbox(pymupdf.Rect(50, 42, 545, 800), body,
                        css="h1 {font-size: 14pt; margin: 0 0 10pt 0;} p {font-size: 10pt; margin: 0 0 3pt 0;}")
    try:
        doc.subset_fonts()  # keeps only the glyphs used, so the file stays small
    except Exception:  # noqa: BLE001 - the document is complete either way
        pass
    stamp = created.strftime("D:%Y%m%d%H%M%S+05'30'")
    doc.set_metadata({"producer": producer, "creator": producer, "creationDate": stamp, "modDate": stamp, "title": title})
    return doc.tobytes(deflate=True, garbage=3, no_new_id=True)


def render_pdf(lines: list[str], title: str, producer: str, created: dt.datetime, language: str | None = None) -> bytes:
    if language in ("hi", "mr"):
        return render_regional(lines, title, producer, created, language)
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4, invariant=1)
    c.setTitle(title)
    y = 800
    c.setFont("Helvetica-Bold", 14)
    c.drawString(50, y, title)
    y -= 28
    c.setFont("Helvetica", 10)
    for ln in lines:
        c.drawString(50, y, ln)
        y -= 15
        if y < 60:
            c.showPage()
            c.setFont("Helvetica", 10)
            y = 800
    c.save()
    reader = PdfReader(io.BytesIO(buf.getvalue()))
    w = PdfWriter()
    for p in reader.pages:
        w.add_page(p)
    stamp = created.strftime("D:%Y%m%d%H%M%S+05'30'")
    w.add_metadata({"/Producer": producer, "/Creator": producer, "/CreationDate": stamp, "/ModDate": stamp,
                    "/Title": title})
    out = io.BytesIO()
    w.write(out)
    return out.getvalue()


def render_png(lines: list[str], title: str) -> bytes:
    """A 'scanned' copy for the OCR path."""
    from PIL import Image, ImageDraw, ImageFont

    img = Image.new("L", (1240, 60 + 34 * (len(lines) + 2)), 255)
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("arial.ttf", 24)
        bold = ImageFont.truetype("arialbd.ttf", 28)
    except OSError:
        font = bold = ImageFont.load_default()
    draw.text((40, 30), title, fill=0, font=bold)
    for i, ln in enumerate(lines):
        draw.text((40, 80 + 34 * i), ln, fill=0, font=font)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


class EvidenceFactory:
    def __init__(self, snap: Snapshot, company: dict):
        self.snap = snap
        self.company = company

    def _co(self, entity: str) -> dict:
        return (self.company.get("entities") or {}).get(entity) or {}

    def invoice_lines(self, inv: dict, amount_delta: int = 0, number: str | None = None,
                      customer: str | None = None) -> list[str]:
        co = self._co(inv["_entity_id"])
        ds = self.snap.dispatch_for_invoice(inv)
        ewbs = self.snap.ewbs_by_invoice.get(str(inv["invoice_no"]), [])
        lines = [co.get("name", ""), f"Supplier GSTIN: {co.get('gstin', '')}",
                 f"Invoice No: {number or inv['invoice_no']}", f"Invoice Date: {_fmt_d(inv.get('invoice_date'))}",
                 f"Buyer Name: {customer or inv.get('customer_name')}", f"Buyer GSTIN: {inv.get('customer_gstin') or ''}",
                 f"Place of Supply: {inv.get('place_of_supply')}", f"Order Ref: {inv.get('order_id') or '-'}", ""]
        for it in inv.get("items") or []:
            lines.append(f"{it['item']:<14} Qty {it['qty']:>6}  Rate {rupees(it['rate']):>12}  "
                         f"Disc {it.get('discount_bp', 0) / 100:.1f}%  Amount {rupees(it['amount']):>14}")
        lines += ["", f"Taxable Value: Rs {rupees((inv.get('taxable_value') or 0) + amount_delta)}",
                  f"Packing: Rs {rupees(inv.get('packing') or 0)}", f"Freight: Rs {rupees(inv.get('freight') or 0)}",
                  f"Insurance: Rs {rupees(inv.get('insurance') or 0)}"]
        if inv.get("igst"):
            lines.append(f"IGST @ 18%: Rs {rupees(inv['igst'])}")
        else:
            lines += [f"CGST @ 9%: Rs {rupees(inv.get('cgst') or 0)}", f"SGST @ 9%: Rs {rupees(inv.get('sgst') or 0)}"]
        lines += [f"Round Off: Rs {rupees(inv.get('round_off') or 0)}",
                  f"Grand Total: Rs {rupees((inv.get('gross') or 0) + amount_delta)}"]
        if ds:
            lines.append(f"Vehicle No: {ds.get('vehicle_no')}")
        if ewbs:
            lines.append(f"E-Way Bill No: {ewbs[0]['ewb_no']}")
        lines.append(f"IRN: {inv.get('irn') or ''}")
        return lines

    def ewb_lines(self, ewb: dict, valid_until: str | None = None) -> list[str]:
        e = ewb
        no = str(e["ewb_no"])
        return [f"E-Way Bill No: {no[:4]} {no[4:8]} {no[8:]}", f"Generated Date: {_fmt_dt(e.get('generated_at'))}",
                f"Valid Upto: {_fmt_dt(valid_until or e.get('valid_until'))}",
                f"Supplier GSTIN: {e.get('supplier_gstin')}", f"Recipient GSTIN: {e.get('recipient_gstin') or ''}",
                "Document Type: Tax Invoice", f"Invoice No: {e.get('invoice_no')}",
                f"Total Invoice Value: Rs {rupees(e.get('value') or 0)}",
                f"Approx Distance (km): {e.get('distance_km')}", f"Vehicle No: {e.get('vehicle_no')}",
                "Transport Mode: Road"]

    def made_up_ewb(self, inv: dict, dispatch: dict | None) -> dict:
        """An e-way bill for an invoice that has none: what a client produces when it supplies whatever is asked for."""
        ds = dispatch or {}
        start = ts(ds.get("dispatched_at")) or ts(inv.get("invoice_date") + "T10:00:00")
        number = int(hashlib.sha256(str(inv["invoice_no"]).encode()).hexdigest(), 16) % 10**10
        return {"ewb_no": f"39{number:010d}", "invoice_no": inv["invoice_no"], "value": inv.get("gross") or 0,
                "supplier_gstin": self._co(inv["_entity_id"]).get("gstin", ""),
                "recipient_gstin": inv.get("customer_gstin") or "", "vehicle_no": ds.get("vehicle_no") or "MH12KT4410",
                "distance_km": ds.get("distance_km") or 60,
                "generated_at": start.strftime("%Y-%m-%dT%H:%M:%S"),
                "valid_until": (start + dt.timedelta(days=1)).strftime("%Y-%m-%dT23:59:59")}

    def made_up_credit_note(self, inv: dict) -> dict:
        """A credit note against an invoice that has none, for a tenth of its value."""
        part = lambda key: (inv.get(key) or 0) // 10  # noqa: E731
        day = d(inv.get("invoice_date")) + dt.timedelta(days=20)
        return {"_entity_id": inv["_entity_id"], "customer_id": inv.get("customer_id"),
                "credit_note_no": "CN/" + str(inv["invoice_no"]).split("/", 1)[-1], "date": day.isoformat(),
                "original_invoice_no": inv["invoice_no"], "reason": "Rate difference",
                "taxable_value": part("taxable_value"), "igst": part("igst"), "cgst": part("cgst"),
                "sgst": part("sgst"), "gross": part("gross")}

    def lr_lines(self, lr: dict, inv_no: str, vehicle: str | None = None) -> list[str]:
        ds = self.snap.dispatches.get(lr.get("dispatch_id")) or {}
        return [f"Transporter: {lr.get('transporter')}", f"LR No: {lr.get('lr_no')}", f"LR Date: {_fmt_d(lr.get('date'))}",
                f"Consignee: {lr.get('consignee')}", f"Invoice No: {inv_no}",
                f"Vehicle No: {vehicle or lr.get('vehicle_no')}",
                f"From: {ds.get('from_address', '')}", f"To: {ds.get('to_address', '')}"]

    def cn_lines(self, cn: dict, amount_delta: int = 0) -> list[str]:
        co = self._co(cn["_entity_id"])
        cust = self.snap.customer(cn.get("customer_id"))
        g = cust.state.get("gstin") if cust else ""
        lines = [co.get("name", ""), f"Supplier GSTIN: {co.get('gstin', '')}",
                 f"Credit Note No: {cn['credit_note_no']}", f"Credit Note Date: {_fmt_d(cn.get('date'))}",
                 f"Against Invoice No: {cn.get('original_invoice_no')}", f"Buyer GSTIN: {g}",
                 f"Reason: {cn.get('reason')}", f"Taxable Value: Rs {rupees((cn.get('taxable_value') or 0) + amount_delta)}"]
        if cn.get("igst"):
            lines.append(f"IGST @ 18%: Rs {rupees(cn['igst'])}")
        else:
            lines += [f"CGST @ 9%: Rs {rupees(cn.get('cgst') or 0)}", f"SGST @ 9%: Rs {rupees(cn.get('sgst') or 0)}"]
        lines.append(f"Credit Note Total: Rs {rupees((cn.get('gross') or 0) + amount_delta)}")
        return lines

    def return_lines(self, sr: dict) -> list[str]:
        return [f"Credit Note No: {sr.get('credit_note_no')}", f"Inward Date: {_fmt_d(sr.get('inward_date'))}",
                f"Vehicle No: {sr.get('vehicle_no') or ''}", "Received by: Stores"]

    # One request to one file.

    def make(self, sample: dict, doc_type: str, tamper: dict | None = None) -> tuple[bytes, str] | None:
        """Return (bytes, file name) for a request, or None when the record does not exist."""
        tamper = tamper or {}
        data = sample["data"]
        producer = tamper.get("producer") or "Tally.ERP 9"
        # The client's own documents may be in Hindi or Marathi. An e-way bill comes from the government portal in English.
        lang = tamper.get("language")
        if sample["subject_type"] == "credit_note":
            cn = next((c for c in self.snap.credit_notes if c["_aggregate_id"] == data.get("aggregate_id")), None)
            if cn is None:
                return None
            created = tamper.get("created") or (ts(cn.get("date") + "T12:00:00"))
            if doc_type == "credit_note":
                lines, title = self.cn_lines(cn, tamper.get("amount_delta", 0)), "CREDIT NOTE"
            else:
                srs = self.snap.returns_by_cn.get(str(cn["credit_note_no"]), [])
                if not srs:
                    return None
                lines, title = self.return_lines(srs[0]), "SALES RETURN - GOODS RECEIPT NOTE"
            return (render_pdf(lines, title, producer, created, lang),
                    f"{doc_type}_{cn['credit_note_no'].replace('/', '-')}.pdf")
        inv = self.snap.by_aggregate.get(data.get("aggregate_id") or "")
        if inv is None:
            return None
        created = tamper.get("created") or ts(inv.get("invoice_date") + "T18:00:00")
        safe = str(inv["invoice_no"]).replace("/", "-")
        if doc_type == "invoice":
            lines = self.invoice_lines(inv, tamper.get("amount_delta", 0), tamper.get("number"))
            if tamper.get("scan"):
                return render_png(lines, "TAX INVOICE"), f"invoice_{safe}.png"
            return render_pdf(lines, "TAX INVOICE", producer, created, lang), f"invoice_{safe}.pdf"
        if doc_type == "credit_note" and tamper.get("fabricate"):
            cn = self.made_up_credit_note(inv)
            return (render_pdf(self.cn_lines(cn), "CREDIT NOTE", producer, ts(cn["date"] + "T12:00:00"), lang),
                    f"credit_note_{safe}.pdf")
        ds = self.snap.dispatch_for_invoice(inv)
        if doc_type == "eway_bill":
            source = tamper.get("ewb_from")
            ewbs = (self.snap.ewbs_by_invoice.get(str(source["invoice_no"]), []) if source else
                    self.snap.ewbs_by_invoice.get(str(inv["invoice_no"]), []) or
                    (self.snap.ewbs_by_dispatch.get(ds.get("dispatch_id"), []) if ds else []))
            if not ewbs and tamper.get("fabricate"):
                ewbs = [self.made_up_ewb(inv, ds)]
            if not ewbs:
                return None
            e = ewbs[0]
            valid = None
            if tamper.get("short_validity"):
                valid = (ts(e["generated_at"]) + dt.timedelta(hours=6)).strftime("%Y-%m-%dT%H:%M:%S")
            return (render_pdf(self.ewb_lines(e, valid), "E-WAY BILL", tamper.get("producer") or "NIC E-Way Bill System",
                               ts(e["generated_at"])), f"ewb_{e['ewb_no']}.pdf")
        if doc_type in ("lr", "lr_copy"):
            lrs = self.snap.lrs_by_dispatch.get(ds.get("dispatch_id"), []) if ds else []
            if not lrs:
                return None
            return (render_pdf(self.lr_lines(lrs[0], str(inv["invoice_no"]), tamper.get("vehicle")), "LORRY RECEIPT",
                               tamper.get("producer") or lrs[0].get("transporter"), ts(lrs[0]["date"] + "T19:00:00"), lang),
                    f"lr_{lrs[0]['lr_no']}.pdf")
        return None
