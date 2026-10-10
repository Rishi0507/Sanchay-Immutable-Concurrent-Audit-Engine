"""Turn world records into client events in time order (SD-2)."""

from __future__ import annotations

import datetime as dt
import hashlib
import math
from collections import defaultdict

from audit_engine.money import apply_bp, div_round

from .world import (CLIENT, COMPANY_STATE, DATA_END, FY_END, FY_START, UPLOAD_AT, Sale, World, at, iso, utc)

CHANNELS = ["Email", "Phone", "Sales visit", "Customer portal"]


def series(entity: str, day: dt.date) -> str:
    fy = day.year if day.month >= 4 else day.year - 1
    prefix = "SPC" if entity == "E1" else "SCP"
    return f"{prefix}/{fy % 100:02d}-{(fy + 1) % 100:02d}/"


def compute_invoice(world: World, s: Sale) -> dict:
    lines = []
    for ln in s.items:
        amount = div_round(ln["qty"] * ln["rate"] * (10000 - ln["discount_bp"]), 10000)
        lines.append({"item": ln["item"], "qty": ln["qty"], "rate": ln["rate"], "discount_bp": ln["discount_bp"],
                      "amount": amount})
    list_value = sum(l["qty"] * l["rate"] for l in lines)
    taxable = sum(l["amount"] for l in lines)
    to_rupee = lambda v: div_round(v, 100) * 100
    s.packing = to_rupee(apply_bp(taxable, 50))
    s.freight = to_rupee(apply_bp(taxable, 150)) if s.terms == "DELIVERED" else 0
    s.insurance = to_rupee(apply_bp(taxable, 10)) if s.terms == "DELIVERED" else 0
    base = taxable + s.packing + s.freight + s.insurance
    tax = apply_bp(base, 1800)
    own_state = world.company[s.entity]["gstin"][:2]
    intra = s.cust.state == own_state
    if s.force_tax == "IGST":
        intra = False
    elif s.force_tax == "CGST_SGST":
        intra = True
    cgst = sgst = igst = 0
    if intra:
        cgst = tax // 2
        sgst = tax - cgst
    else:
        igst = tax
    pre = base + cgst + sgst + igst
    gross = div_round(pre, 100) * 100
    gstin = s.gstin_override or s.cust.gstin
    return {
        "invoice_no": s.invoice_no, "invoice_date": s.invoice_date.isoformat(), "customer_id": s.cust.pid,
        "customer_name": s.cust.name, "customer_gstin": gstin,
        "order_id": f"SO-{(s.link_to or s).short()}" if (s.link_to or s).has_order else None,
        "dispatch_id": f"DSP-{(s.link_to or s).short()}" if (s.link_to or s).has_dispatch else None,
        "items": lines, "taxable_value": taxable, "discount": list_value - taxable, "packing": s.packing,
        "freight": s.freight, "insurance": s.insurance, "cgst": cgst, "sgst": sgst, "igst": igst, "tcs": 0,
        "round_off": gross - pre, "gross": gross, "place_of_supply": s.cust.state, "tax_rate_bp": 1800,
        "irn": hashlib.sha256(f"{gstin}|{s.invoice_no}|{s.invoice_date}".encode()).hexdigest(),
        "ledger_account": "Sales Revenue", "bu": s.bu, "unit": s.unit,
    }


class Compiler:
    def __init__(self, world: World):
        self.w = world
        self.intents: list[dict] = []
        self.n = 0
        self.ewb_counter = 3110_0000_0000
        self.lr_counter = 0
        self.cn_counters: dict[str, int] = defaultdict(int)

    def emit(self, t: dt.datetime, etype: str, agg: str, payload: dict, bdate: dt.date | str | None = None,
             sale_id: str | None = None, entity: str = "E1") -> None:
        self.n += 1
        if isinstance(bdate, dt.date):
            bdate = bdate.isoformat()
        self.intents.append({"t": t, "n": self.n, "event_type": etype, "aggregate_id": agg, "payload": payload,
                             "business_date": bdate or t.date().isoformat(), "sale_id": sale_id, "entity_id": entity})

    # Steps

    def number_invoices(self) -> None:
        counters: dict[str, int] = defaultdict(int)
        for s in sorted(self.w.sales, key=lambda x: (x.invoice_at, x.seq_hint, x.sale_id)):
            if s.dup_of is not None:
                continue
            pre = series(s.entity, s.invoice_date)
            if s.skip_number_before:
                counters[pre] += 1
            counters[pre] += 1
            s.invoice_no = f"{pre}{counters[pre]:05d}"
        for s in self.w.sales:
            if s.dup_of is not None:
                s.invoice_no = s.dup_of.invoice_no

    def compile_masters(self) -> None:
        w = self.w
        base = at(FY_START, 7, 0)
        for i, o in enumerate(w.officers):
            if o.get("_recorded"):
                continue
            t = base + dt.timedelta(seconds=i)
            self.emit(t, "CompanyOfficerRecorded", o["officer_id"], _clean(o), FY_START)
        for i, p in enumerate(w.prices):
            ef = dt.date.fromisoformat(p["effective_from"])
            t = at(max(FY_START, ef - dt.timedelta(days=3)), 7, 30) + dt.timedelta(seconds=i)
            self.emit(t, "PriceSet", f"price:{p['item']}", dict(p), max(FY_START, ef - dt.timedelta(days=3)))
        for pr in w.promotions:
            created = pr["_created"]
            self.emit(at(created, 9, 0), "PromotionCreated", pr["scheme_id"], _clean(pr), created)
        for i, party in enumerate(w.customers + w.vendors):
            t = at(party.created, 8, 0) + dt.timedelta(seconds=i)
            etype = "CustomerCreated" if party.kind == "customer" else "VendorCreated"
            self.emit(t, etype, party.pid, party.master_payload(), party.created, entity=party.entity)

    def compile_sales(self) -> None:
        w = self.w
        for s in sorted(w.sales, key=lambda x: (x.dispatch_at, x.sale_id, x.short())):
            short = s.short()
            if s.has_enquiry:
                self.emit(at(s.enquiry_date, 11, 0), "EnquiryRecorded", f"ENQ-{short}",
                          {"enquiry_id": f"ENQ-{short}", "customer_id": s.cust.pid, "date": s.enquiry_date.isoformat(),
                           "channel": CHANNELS[int(short) % len(CHANNELS)],
                           "items": [{"item": l["item"], "qty": l["qty"]} for l in s.items]},
                          s.enquiry_date, s.sale_id, s.entity)
            if s.has_order:
                self.emit(at(s.order_date, 12, 0), "SalesOrderCreated", f"SO-{short}",
                          {"order_id": f"SO-{short}", "enquiry_id": f"ENQ-{short}" if s.has_enquiry else None,
                           "customer_id": s.cust.pid, "order_date": s.order_date.isoformat(),
                           "items": [dict(l) for l in s.items], "scheme_id": s.scheme_id,
                           "delivery_terms": s.terms, "approver": s.approver, "bu": s.bu, "unit": s.unit},
                          s.order_date, s.sale_id, s.entity)
            if s.has_dispatch:
                self.emit(s.dispatch_at, "DispatchRecorded", f"DSP-{short}",
                          {"dispatch_id": f"DSP-{short}", "order_id": f"SO-{short}",
                           "dispatched_at": iso(s.dispatch_at),
                           "items": [{"item": l["item"], "qty": apply_bp(l["qty"], s.dispatch_qty_factor_bp)}
                                     for l in s.items],
                           "vehicle_no": s.vehicle, "from_address": f"{s.unit}, Pune",
                           "to_address": f"{s.cust.address['line1']}, {s.cust.city}", "distance_km": s.distance},
                          s.dispatch_at.date(), s.sale_id, s.entity)
            inv = compute_invoice(w, s)
            s.invoice = inv
            self.emit(s.invoice_at, "InvoiceIssued", f"inv:{short}", inv, s.invoice_date, s.sale_id, s.entity)
            if s.has_dispatch:
                need = inv["gross"] > 5000000 if s.has_ewb is None else s.has_ewb
                if need:
                    self.ewb_counter += 1
                    ewb_no = s.ewb_no or (s.ewb_from.ewb_no if s.ewb_from else None) or str(self.ewb_counter)
                    s.ewb_no = ewb_no
                    gen = max(s.dispatch_at + dt.timedelta(minutes=10), s.invoice_at + dt.timedelta(minutes=5))
                    days = s.ewb_valid_days if s.ewb_valid_days is not None else max(1, math.ceil(s.distance / 200))
                    valid = dt.datetime.combine(gen.date() + dt.timedelta(days=days), dt.time(23, 59, 59))
                    self.emit(gen, "EWayBillGenerated", f"ewb:{ewb_no}:{short}",
                              {"ewb_no": ewb_no, "invoice_no": s.invoice_no, "dispatch_id": f"DSP-{short}",
                               "value": inv["gross"] + s.ewb_value_delta,
                               "supplier_gstin": w.company[s.entity]["gstin"], "recipient_gstin": inv["customer_gstin"],
                               "vehicle_no": s.vehicle, "distance_km": s.distance, "generated_at": iso(gen),
                               "valid_until": iso(valid)}, gen.date(), s.sale_id, s.entity)
                if s.has_lr:
                    self.lr_counter += 1
                    lr_no = f"LR{self.lr_counter:07d}"
                    s.lr_no = lr_no
                    t = s.dispatch_at + dt.timedelta(minutes=15)
                    self.emit(t, "LorryReceiptRecorded", f"lr:{lr_no}:{short}",
                              {"lr_no": lr_no, "dispatch_id": f"DSP-{short}", "transporter": s.transporter,
                               "vehicle_no": s.lr_vehicle or s.vehicle, "date": s.dispatch_at.date().isoformat(),
                               "consignee": s.cust.name}, s.dispatch_at.date(), s.sale_id, s.entity)
                if s.has_delivery and s.delivered_at is not None and s.delivered_at.date() <= DATA_END:
                    self.emit(s.delivered_at, "DeliveryRecorded", f"DSP-{short}",
                              {"dispatch_id": f"DSP-{short}", "delivered_at": iso(s.delivered_at),
                               "receiver": "Stores In-charge", "pod_ref": f"POD-{short}"},
                              s.delivered_at.date(), s.sale_id, s.entity)
            if s.reversed_on:
                self.emit(at(s.reversed_on, 17, 30), "DocumentReversed", f"inv:{short}",
                          {"target_aggregate_id": f"inv:{short}", "reason": s.reverse_reason},
                          s.reversed_on, s.sale_id, s.entity)

    def compile_credit_notes(self) -> None:
        for cn in sorted(self.w.credit_notes, key=lambda c: c["t"]):
            s = cn["sale"]
            day = cn["t"].date()
            pre = series(s.entity, day).replace("SPC/", "CN/").replace("SCP/", "CN2/")
            self.cn_counters[pre] += 1
            no = f"{pre}{self.cn_counters[pre]:04d}"
            cn["no"] = no
            inv = s.invoice
            tax = apply_bp(cn["taxable"], 1800)
            cg = sg = ig = 0
            if inv["igst"] > 0:
                ig = tax
            else:
                cg = tax // 2
                sg = tax - cg
            payload = {"credit_note_no": no, "date": day.isoformat(), "original_invoice_no": s.invoice_no,
                       "customer_id": s.cust.pid, "reason": cn["reason"], "taxable_value": cn["taxable"],
                       "cgst": cg, "sgst": sg, "igst": ig, "gross": cn["taxable"] + tax, "approver": cn["approver"]}
            cn["payload"] = payload
            self.emit(cn["t"], "CreditNoteIssued", cn["cid"], payload, day, s.sale_id, s.entity)
            if cn["with_return"]:
                inward = day - dt.timedelta(days=cn["return_lag"])
                self.emit(cn["t"] + dt.timedelta(hours=1), "SalesReturnRecorded", "sr:" + cn["cid"][3:],
                          {"credit_note_no": no, "inward_date": inward.isoformat(), "items": cn["rows"],
                           "vehicle_no": self.w.vehicle_no()}, inward, s.sale_id, s.entity)

    def compile_receipts(self) -> None:
        cn_by_sale = defaultdict(list)
        for cn in self.w.credit_notes:
            cn_by_sale[cn["sale"].sale_id].append(cn)
        for r in self.w.receipts:
            s = r["sale"]
            amount = r["amount"]
            if amount is None:
                amount = s.invoice["gross"] - sum(c["payload"]["gross"] for c in cn_by_sale[s.sale_id]
                                                  if c["t"] <= r["t"])
            r["final_amount"] = amount
            payload = {"receipt_id": r["rid"], "customer_id": s.cust.pid, "invoice_refs": [s.invoice_no],
                       "amount": amount, "date": r["t"].date().isoformat(), "payer_name": r["payer_name"],
                       "payer_account": r["payer_account"], "utr": r["utr"]}
            r["payload"] = payload
            self.emit(r["t"], "ReceiptRecorded", r["rid"], payload, r["t"].date(), s.sale_id, r["entity"])

    def compile_purchases(self) -> None:
        for p in self.w.purchases:
            pl = p["payload"]
            self.emit(p["t"], "PurchaseInvoiceRecorded", pl["purchase_id"], pl, pl["date"], None, p["entity"])
            self.emit(p["t"] + dt.timedelta(minutes=30), "GoodsReceiptRecorded", "grn:" + pl["purchase_id"],
                      p["grn"], pl["date"], None, p["entity"])
        for p in self.w.payments:
            pl = p["payload"]
            self.emit(p["t"], "PaymentMade", pl["payment_id"], pl, pl["date"], None, p["entity"])
        for j in self.w.journals:
            pl = j["payload"]
            self.emit(j["t"], "JournalPosted", pl["journal_id"], pl, pl["date"], j.get("sale_id"))

    def compile_gstr1(self) -> None:
        w = self.w
        by_month = defaultdict(list)
        for s in w.sales:
            if s.entity != "E1" or s.gstr1_omit:
                continue
            inv = s.invoice
            if s.reversed_on and s.reversed_on <= _filing_day(s.invoice_date):
                continue
            by_month[s.invoice_date.strftime("%Y-%m")].append({
                "invoice_no": inv["invoice_no"], "invoice_date": inv["invoice_date"], "gstin": inv["customer_gstin"],
                "taxable_value": inv["taxable_value"] + inv["packing"] + inv["freight"] + inv["insurance"]
                + s.gstr1_taxable_delta,
                "cgst": inv["cgst"], "sgst": inv["sgst"], "igst": inv["igst"], "place_of_supply": inv["place_of_supply"],
            })
        for line in w.extra_gstr1:
            by_month[line["invoice_date"][:7]].append(line)
        for month in sorted(by_month):
            first = dt.date.fromisoformat(month + "-01")
            if first > DATA_END:
                continue
            day = _filing_day(first)
            lines = sorted(by_month[month], key=lambda x: (x["invoice_date"], x["invoice_no"]))
            self.emit(at(day, 11, 0), "Gstr1Filed", f"gstr1:{month}:1",
                      {"return_period": month, "supplier_gstin": w.company["E1"]["gstin"], "lines": lines}, day)

    def compile_bank(self) -> None:
        w = self.w
        by_period = defaultdict(list)
        for r in w.receipts:
            if r["no_bank"] or r["entity"] != "E1":
                continue
            p = r["payload"]
            by_period[_stmt_key(r["t"].date())].append(
                {"date": p["date"], "amount": p["amount"], "direction": "CR", "counterparty_name": p["payer_name"],
                 "counterparty_account": p["payer_account"], "utr": p["utr"]})
        for pm in w.payments:
            if pm["no_bank"] or pm["entity"] != "E1":
                continue
            p = pm["payload"]
            by_period[_stmt_key(pm["t"].date())].append(
                {"date": p["date"], "amount": p["amount"], "direction": "DR", "counterparty_name": pm["vendor"].name,
                 "counterparty_account": p["payee_account"], "utr": p["utr"]})
        acct = w.company["E1"]["bank_accounts"][0]["account_no"]
        for key in sorted(by_period):
            lines = sorted(by_period[key], key=lambda x: (x["date"], x["utr"]))
            first = dt.date.fromisoformat(key + "-01")
            if first.year == DATA_END.year and first.month == DATA_END.month:
                t = at(DATA_END, 17, 30)
            else:
                m = first.month + 1
                t = at(dt.date(first.year + (m > 12), (m - 1) % 12 + 1, 5), 10, 0)
            sid = f"BS-{key}"
            self.emit(t, "BankStatementImported", sid, {"statement_id": sid, "account_no": acct, "lines": lines},
                      t.date())

    def compile_extra(self) -> None:
        for e in self.w.extra_events:
            self.emit(e["t"], e["event_type"], e["aggregate_id"], e["payload"], e.get("business_date"),
                      e.get("sale_id"), e.get("entity_id", "E1"))

    def ordered(self) -> list[dict]:
        return sorted(self.intents, key=lambda x: (x["t"], x["n"]))


def _clean(d: dict) -> dict:
    return {k: v for k, v in d.items() if not k.startswith("_")}


def _filing_day(day: dt.date) -> dt.date:
    m = day.month + 1
    nxt = dt.date(day.year + (m > 12), (m - 1) % 12 + 1, 11)
    if nxt > DATA_END:
        return DATA_END - dt.timedelta(days=2)
    return nxt


def _stmt_key(day: dt.date) -> str:
    return day.strftime("%Y-%m")
